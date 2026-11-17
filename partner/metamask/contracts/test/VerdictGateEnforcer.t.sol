// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {VerdictGateEnforcer} from "../src/VerdictGateEnforcer.sol";

/// Minimal cheatcode interface (no forge-std dependency, so nothing is vendored).
interface Vm {
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool) external;
}

contract VerdictGateEnforcerTest {
    event VerdictTrue(address indexed carrier, bytes32 indexed caseKey, uint256 genlayerChainId, address caseContract);

    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    VerdictGateEnforcer gate;
    address constant CARRIER = address(0xC1E2);
    address constant OTHER = address(0xBAD);
    address constant CASE = 0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B;
    uint256 constant BRADBURY = 4221;
    // Same value as caseSalt(SAMPLE_CASE) in src/verdict-payment.mjs (asserted in test_caseKeyMatchesOffChainSalt).
    bytes32 constant SAMPLE_SALT = keccak256(abi.encodePacked("internet-court-mandate-verdict", uint256(4221), CASE));

    function setUp() public {
        gate = new VerdictGateEnforcer();
    }

    function _terms(bytes32 key, address carrier) internal pure returns (bytes memory) {
        return abi.encode(key, carrier);
    }

    function _before(bytes memory terms) internal view {
        gate.beforeHook(terms, "", bytes32(0), "", bytes32(uint256(1)), address(0xD), address(0xE));
    }

    function test_caseKeyMatchesOffChainSalt() public view {
        require(gate.caseKey(BRADBURY, CASE) == SAMPLE_SALT, "caseKey");
    }

    function test_blockedBeforeVerdict() public {
        vm.expectRevert(bytes("VerdictGateEnforcer:verdict-not-true"));
        this.callBefore(_terms(SAMPLE_SALT, CARRIER));
    }

    function test_passesAfterCarrierPostsTrue() public {
        vm.prank(CARRIER);
        bytes32 key = gate.postVerdictTrue(BRADBURY, CASE);
        require(key == SAMPLE_SALT, "key");
        require(gate.verdictTrue(CARRIER, SAMPLE_SALT), "recorded");
        _before(_terms(SAMPLE_SALT, CARRIER));
    }

    function test_postEmitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit VerdictTrue(CARRIER, SAMPLE_SALT, BRADBURY, CASE);
        vm.prank(CARRIER);
        gate.postVerdictTrue(BRADBURY, CASE);
    }

    function test_otherPosterDoesNotOpenGate() public {
        vm.prank(OTHER);
        gate.postVerdictTrue(BRADBURY, CASE);
        vm.expectRevert(bytes("VerdictGateEnforcer:verdict-not-true"));
        this.callBefore(_terms(SAMPLE_SALT, CARRIER));
    }

    function test_wrongCaseStaysBlocked() public {
        vm.prank(CARRIER);
        gate.postVerdictTrue(BRADBURY, address(0x1234));
        vm.expectRevert(bytes("VerdictGateEnforcer:verdict-not-true"));
        this.callBefore(_terms(SAMPLE_SALT, CARRIER));
    }

    function test_wrongChainIdStaysBlocked() public {
        vm.prank(CARRIER);
        gate.postVerdictTrue(61999, CASE);
        vm.expectRevert(bytes("VerdictGateEnforcer:verdict-not-true"));
        this.callBefore(_terms(SAMPLE_SALT, CARRIER));
    }

    function test_postIsWriteOnce() public {
        vm.prank(CARRIER);
        gate.postVerdictTrue(BRADBURY, CASE);
        vm.prank(CARRIER);
        vm.expectRevert(bytes("VerdictGateEnforcer:already-posted"));
        gate.postVerdictTrue(BRADBURY, CASE);
        require(gate.verdictTrue(CARRIER, SAMPLE_SALT), "still recorded");
    }

    function test_rejectsShortTerms() public {
        vm.expectRevert(bytes("VerdictGateEnforcer:invalid-terms-length"));
        this.callBefore(abi.encodePacked(SAMPLE_SALT));
    }

    function test_rejectsLongTerms() public {
        vm.expectRevert(bytes("VerdictGateEnforcer:invalid-terms-length"));
        this.callBefore(abi.encodePacked(SAMPLE_SALT, bytes32(uint256(uint160(CARRIER))), bytes1(0x00)));
    }

    function test_rejectsDirtyAddressWord() public {
        bytes memory dirty = abi.encodePacked(SAMPLE_SALT, bytes32(uint256(uint160(CARRIER)) | (uint256(1) << 200)));
        vm.prank(CARRIER);
        gate.postVerdictTrue(BRADBURY, CASE);
        vm.expectRevert(bytes(""));
        this.callBefore(dirty);
    }

    function test_getTermsInfoRoundTrip() public view {
        (bytes32 k, address c) = gate.getTermsInfo(_terms(SAMPLE_SALT, CARRIER));
        require(k == SAMPLE_SALT && c == CARRIER, "terms");
    }

    function test_otherHooksAreNoOps() public view {
        bytes memory t = _terms(SAMPLE_SALT, CARRIER);
        gate.beforeAllHook(t, "", bytes32(0), "", bytes32(0), address(0), address(0));
        gate.afterHook(t, "", bytes32(0), "", bytes32(0), address(0), address(0));
        gate.afterAllHook(t, "", bytes32(0), "", bytes32(0), address(0), address(0));
    }

    function callBefore(bytes memory terms) external view {
        _before(terms);
    }
}
