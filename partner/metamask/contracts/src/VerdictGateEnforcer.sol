// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// @title VerdictGateEnforcer
/// @notice Caveat enforcer for MetaMask's Delegation Framework (ERC-7710). A delegation that carries
///         this caveat can be redeemed only after the carrier named in its terms has recorded, on this
///         chain, that the GenLayer case named in its terms resolved TRUE.
/// @dev NOT trustless and NOT an oracle. This chain cannot read GenLayer. The carrier is trusted to post
///      only a finalized TRUE verdict; this contract checks only that the carrier the delegator signed
///      for did post TRUE for exactly this case. What the carrier cannot do: post for another carrier,
///      change the amount, the recipient or any other caveat, or un-post. Deny is the default: there is
///      no way to post FALSE, so a case that never gets a TRUE from its carrier is never payable.
///
///      Terms: abi.encode(bytes32 caseKey, address carrier), exactly 64 bytes.
///      caseKey = keccak256(abi.encodePacked("internet-court-mandate-verdict", genlayerChainId, caseContract)),
///      the same value the off-chain code uses as the delegation salt.
///
///      Standalone on purpose (no imports): the four hooks match ICaveatEnforcer of Delegation Framework
///      v1.3.0, where ModeCode is a bytes32 user-defined value type, so the selectors are identical.
contract VerdictGateEnforcer {
    string public constant CASE_LABEL = "internet-court-mandate-verdict";

    /// @notice carrier => caseKey => TRUE recorded. Write-once; never cleared.
    mapping(address => mapping(bytes32 => bool)) public verdictTrue;

    event VerdictTrue(address indexed carrier, bytes32 indexed caseKey, uint256 genlayerChainId, address caseContract);

    /// @notice The case key (delegation salt) for a GenLayer MandateVerdict contract.
    function caseKey(uint256 genlayerChainId, address caseContract) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(CASE_LABEL, genlayerChainId, caseContract));
    }

    /// @notice Record, as msg.sender, that this GenLayer case resolved TRUE. Only delegations whose
    ///         terms name msg.sender as the carrier are affected.
    function postVerdictTrue(uint256 genlayerChainId, address caseContract) external returns (bytes32 key) {
        key = caseKey(genlayerChainId, caseContract);
        require(!verdictTrue[msg.sender][key], "VerdictGateEnforcer:already-posted");
        verdictTrue[msg.sender][key] = true;
        emit VerdictTrue(msg.sender, key, genlayerChainId, caseContract);
    }

    /// @notice Decode caveat terms.
    function getTermsInfo(bytes calldata terms) public pure returns (bytes32 key, address carrier) {
        require(terms.length == 64, "VerdictGateEnforcer:invalid-terms-length");
        (key, carrier) = abi.decode(terms, (bytes32, address));
    }

    /// @notice The gate. Called by the DelegationManager before the delegated execution runs.
    function beforeHook(bytes calldata terms, bytes calldata, bytes32, bytes calldata, bytes32, address, address)
        external
        view
    {
        (bytes32 key, address carrier) = getTermsInfo(terms);
        require(verdictTrue[carrier][key], "VerdictGateEnforcer:verdict-not-true");
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
