// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

// Integration tests for direct mode against MetaMask's Delegation Framework v1.3.0, UNMODIFIED
// (git submodule lib/delegation-framework pinned at tag v1.3.0, commit bfbdf97). Runs in Foundry's local EVM only.
//
// The principal is a Hybrid DeleGator smart account. The agent is an EOA that redeems the delegation itself.
// MockGhost stands in for a GenLayer ghost contract: on chain, GenLayer executes the IC's finalized external
// message through the ghost, so the gate sees msg.sender == the case contract.

import { ExecutionLib } from "@erc7579/lib/ExecutionLib.sol";
import { BaseTest } from "@df/test/utils/BaseTest.t.sol";
import { Implementation, SignatureType } from "@df/test/utils/Types.t.sol";
import { Execution, Caveat, Delegation, ModeCode } from "@df/src/utils/Types.sol";
import { ExactExecutionEnforcer } from "@df/src/enforcers/ExactExecutionEnforcer.sol";
import { LimitedCallsEnforcer } from "@df/src/enforcers/LimitedCallsEnforcer.sol";
import { RedeemerEnforcer } from "@df/src/enforcers/RedeemerEnforcer.sol";
import { TimestampEnforcer } from "@df/src/enforcers/TimestampEnforcer.sol";

import { VerdictGateDirectEnforcer } from "../src/VerdictGateDirectEnforcer.sol";
import { MockGhost, NotAGhost } from "./MockGhost.sol";

contract DirectModeTest is BaseTest {
    constructor() {
        IMPLEMENTATION = Implementation.Hybrid;
        SIGNATURE_TYPE = SignatureType.RawP256;
    }

    VerdictGateDirectEnforcer internal gate;
    ExactExecutionEnforcer internal exactExecution;
    LimitedCallsEnforcer internal limitedCalls;
    RedeemerEnforcer internal redeemer;
    TimestampEnforcer internal timestamp;

    MockGhost internal caseTrue; // the IC whose verdict resolves TRUE
    MockGhost internal caseFalse; // the IC whose verdict resolves FALSE (it never posts)
    MockGhost internal otherCase; // an unrelated IC

    address payable internal agent;
    address internal stranger;
    uint256 internal constant FEE = 0.001 ether;
    uint128 internal expiresAt;

    function setUp() public override {
        super.setUp();
        caseTrue = new MockGhost();
        caseFalse = new MockGhost();
        otherCase = new MockGhost();
        gate = new VerdictGateDirectEnforcer(address(caseTrue).codehash);
        exactExecution = new ExactExecutionEnforcer();
        limitedCalls = new LimitedCallsEnforcer();
        redeemer = new RedeemerEnforcer();
        timestamp = new TimestampEnforcer();

        agent = payable(makeAddr("agent"));
        stranger = makeAddr("stranger");
        vm.deal(address(users.alice.deleGator), 1 ether); // the principal's smart account holds the fee
        vm.warp(1_800_000_000);
        expiresAt = uint128(block.timestamp + 1 hours);
    }

    // ---------------------------------------------------------------- helpers

    function _delegationFor(address caseContract) internal view returns (Delegation memory d) {
        Caveat[] memory caveats = new Caveat[](5);
        caveats[0] = Caveat({ enforcer: address(gate), terms: abi.encode(caseContract), args: hex"" });
        caveats[1] = Caveat({
            enforcer: address(exactExecution), terms: ExecutionLib.encodeSingle(agent, FEE, hex""), args: hex""
        });
        caveats[2] = Caveat({ enforcer: address(redeemer), terms: abi.encodePacked(agent), args: hex"" });
        caveats[3] = Caveat({ enforcer: address(limitedCalls), terms: abi.encode(uint256(1)), args: hex"" });
        caveats[4] =
            Caveat({ enforcer: address(timestamp), terms: abi.encodePacked(uint128(0), expiresAt), args: hex"" });
        d = Delegation({
            delegate: agent,
            delegator: address(users.alice.deleGator),
            authority: delegationManager.ROOT_AUTHORITY(),
            caveats: caveats,
            salt: uint256(uint160(caseContract)),
            signature: hex""
        });
        d = signDelegation(users.alice, d);
    }

    function _redeem(Delegation memory d) internal {
        Delegation[] memory chain = new Delegation[](1);
        chain[0] = d;
        bytes[] memory contexts = new bytes[](1);
        contexts[0] = abi.encode(chain);
        ModeCode[] memory modes = new ModeCode[](1);
        modes[0] = singleDefaultMode;
        bytes[] memory calls = new bytes[](1);
        calls[0] = ExecutionLib.encodeSingle(agent, FEE, hex"");
        vm.prank(agent);
        delegationManager.redeemDelegations(contexts, modes, calls);
    }

    function _post(MockGhost ghost) internal {
        ghost.deliver(address(gate), abi.encodeCall(VerdictGateDirectEnforcer.postVerdictTrue, ()));
    }

    // ------------------------------------------------------------------ tests

    /// The agent tries to get paid before the court has said anything.
    function test_earlyRedeemReverts() public {
        Delegation memory d = _delegationFor(address(caseTrue));
        vm.expectRevert("VerdictGateDirect:verdict-not-true");
        _redeem(d);
        assertEq(agent.balance, 0);
    }

    /// The TRUE case's finalized message lands; the agent is paid exactly once.
    function test_truePaysOnce() public {
        Delegation memory d = _delegationFor(address(caseTrue));
        vm.expectEmit(true, false, false, true, address(gate));
        emit VerdictGateDirectEnforcer.VerdictTrue(address(caseTrue));
        _post(caseTrue);
        assertTrue(gate.verdictTrue(address(caseTrue)));

        _redeem(d);
        assertEq(agent.balance, FEE);

        vm.expectRevert("LimitedCallsEnforcer:limit-exceeded");
        _redeem(d);
        assertEq(agent.balance, FEE);
    }

    /// A FALSE case never posts (MandateVerdictDirect emits nothing on FALSE), so its delegation stays locked,
    /// even after a different case resolved TRUE.
    function test_falseRedeemReverts() public {
        Delegation memory dFalse = _delegationFor(address(caseFalse));
        _post(caseTrue);
        vm.expectRevert("VerdictGateDirect:verdict-not-true");
        _redeem(dFalse);
        assertEq(agent.balance, 0);
        assertFalse(gate.verdictTrue(address(caseFalse)));
    }

    /// An EOA cannot post at all.
    function test_strangerEoaPostReverts() public {
        vm.prank(stranger);
        vm.expectRevert("VerdictGateDirect:only-genlayer-contract");
        gate.postVerdictTrue();
    }

    /// A contract that is not a GenLayer ghost cannot post.
    function test_strangerContractPostReverts() public {
        NotAGhost notGhost = new NotAGhost();
        vm.expectRevert("VerdictGateDirect:only-genlayer-contract");
        notGhost.deliver(address(gate), abi.encodeCall(VerdictGateDirectEnforcer.postVerdictTrue, ()));
    }

    /// Another Intelligent Contract can post, but only for itself: the TRUE-case delegation stays locked.
    function test_otherCaseCannotOpenThisCase() public {
        Delegation memory d = _delegationFor(address(caseTrue));
        _post(otherCase);
        assertTrue(gate.verdictTrue(address(otherCase)));
        vm.expectRevert("VerdictGateDirect:verdict-not-true");
        _redeem(d);
    }

    /// A duplicate message (e.g. a replay) is idempotent: no revert, no second event, no second payment.
    function test_duplicatePostIsIdempotent() public {
        _post(caseTrue);
        vm.recordLogs();
        _post(caseTrue);
        assertEq(vm.getRecordedLogs().length, 0);
        assertTrue(gate.verdictTrue(address(caseTrue)));
    }

    /// Payment after expiry is refused even with TRUE posted (MetaMask's stock TimestampEnforcer).
    function test_expiredRedeemReverts() public {
        Delegation memory d = _delegationFor(address(caseTrue));
        _post(caseTrue);
        vm.warp(uint256(expiresAt) + 1);
        vm.expectRevert("TimestampEnforcer:expired-delegation");
        _redeem(d);
    }

    /// The principal can always switch the delegation off, verdict or not.
    function test_principalCanDisable() public {
        Delegation memory d = _delegationFor(address(caseTrue));
        _post(caseTrue);
        vm.prank(address(users.alice.deleGator));
        delegationManager.disableDelegation(d);
        vm.expectRevert(); // CannotUseADisabledDelegation()
        _redeem(d);
    }

    function test_termsDecoding() public {
        assertEq(gate.getTermsInfo(abi.encode(address(caseTrue))), address(caseTrue));
        vm.expectRevert("VerdictGateDirect:invalid-terms-length");
        gate.getTermsInfo(abi.encodePacked(address(caseTrue)));
        vm.expectRevert("VerdictGateDirect:invalid-address");
        gate.getTermsInfo(abi.encode(type(uint256).max));
    }

    function test_constructorRejectsEmptyCodeHash() public {
        vm.expectRevert("VerdictGateDirect:bad-codehash");
        new VerdictGateDirectEnforcer(bytes32(0));
        vm.expectRevert("VerdictGateDirect:bad-codehash");
        new VerdictGateDirectEnforcer(keccak256(""));
    }
}
