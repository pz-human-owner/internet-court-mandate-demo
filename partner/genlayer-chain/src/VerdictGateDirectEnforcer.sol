// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// @title VerdictGateDirectEnforcer
/// @notice Caveat enforcer for MetaMask's Delegation Framework v1.3.0 (ERC-7710), deployed on GenLayer Chain
///         (the EVM layer of GenLayer Testnet Bradbury, chain id 4221). A delegation carrying this caveat can be
///         redeemed only after the GenLayer Intelligent Contract named in its terms has itself recorded TRUE here.
/// @dev Direct mode, no carrier and no relayer key. A GenLayer Intelligent Contract (IC) reaches EVM contracts
///      through "external messages" that GenLayer executes only after the IC's transaction is FINALIZED (after the
///      appeal window), from the IC's ghost contract, which has the same address as the IC. So inside
///      postVerdictTrue(), msg.sender IS the case contract, and each case can only ever write its own slot.
///
///      Who can post: only GenLayer ghost contracts. Every ghost is the same small beacon proxy, so they share one
///      runtime code hash (read-only check on Bradbury, 19 Nov 2026: 0x14dd0417...dd73 for three unrelated ICs).
///      The hash is fixed at deployment. An EOA or any other contract reverts with `only-genlayer-contract`.
///      Another IC can post, but only for itself, and no delegation names it.
///
///      Deny is the default: there is no way to post FALSE. A case that resolves FALSE or UNDETERMINED never
///      posts, so its delegation is never redeemable; the principal's own disableDelegation() and the delegation's
///      expiry still apply.
///
///      Terms: abi.encode(address caseContract), exactly 32 bytes.
///      Standalone on purpose (no imports): the four hooks match ICaveatEnforcer of Delegation Framework v1.3.0,
///      where ModeCode is a bytes32 user-defined value type, so the selectors are identical.
contract VerdictGateDirectEnforcer {
    /// @notice Runtime code hash shared by GenLayer ghost contracts on this chain.
    bytes32 public immutable ghostCodeHash;

    /// @notice case contract (IC / ghost address) => its finalized verdict was TRUE. Write-once.
    mapping(address => bool) public verdictTrue;

    event VerdictTrue(address indexed caseContract);

    constructor(bytes32 ghostCodeHash_) {
        require(ghostCodeHash_ != bytes32(0) && ghostCodeHash_ != keccak256(""), "VerdictGateDirect:bad-codehash");
        ghostCodeHash = ghostCodeHash_;
    }

    /// @notice Called by a GenLayer Intelligent Contract (through its ghost) when its verdict resolved TRUE.
    ///         Idempotent: a repeated message from the same case changes nothing and does not revert.
    function postVerdictTrue() external {
        require(msg.sender.codehash == ghostCodeHash, "VerdictGateDirect:only-genlayer-contract");
        if (verdictTrue[msg.sender]) return;
        verdictTrue[msg.sender] = true;
        emit VerdictTrue(msg.sender);
    }

    /// @notice Decode caveat terms.
    function getTermsInfo(bytes calldata terms) public pure returns (address caseContract) {
        require(terms.length == 32, "VerdictGateDirect:invalid-terms-length");
        uint256 word = abi.decode(terms, (uint256));
        require(word >> 160 == 0, "VerdictGateDirect:invalid-address");
        caseContract = address(uint160(word));
    }

    /// @notice The gate. Called by the DelegationManager before the delegated execution runs.
    function beforeHook(bytes calldata terms, bytes calldata, bytes32, bytes calldata, bytes32, address, address)
        external
        view
    {
        require(verdictTrue[getTermsInfo(terms)], "VerdictGateDirect:verdict-not-true");
    }

    function beforeAllHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address)
        external
        pure
    {}

    function afterHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address)
        external
        pure
    {}

    function afterAllHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address)
        external
        pure
    {}
}
