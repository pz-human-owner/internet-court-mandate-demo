// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { VerdictGateDirectEnforcer } from "../src/VerdictGateDirectEnforcer.sol";

/// @dev Deploys VerdictGateDirectEnforcer for direct mode on GenLayer Chain (chain id 4221).
///      The ghost code hash is the runtime code hash shared by GenLayer Intelligent Contract
///      ghost proxies on Bradbury (checked 19–20 Nov 2026 on the two live MandateVerdict cases).
///      Does not deploy MetaMask's Delegation Framework: those official v1.3.0 addresses already
///      have code on 4221 (same CREATE2 addresses as Sepolia).
///
///      Local / dry-run only unless the caller passes --broadcast to forge script.
///      The live proof runner (scripts/direct-proof.mjs) deploys the gate itself and never
///      prints a private key.
bytes32 constant BRADBURY_GHOST_CODE_HASH =
    0x14dd04172073540826b9ab253bf6b416ba8123fd01c9c36c6e06c5179babdd73;

contract DeployGate is Script {
    function run() external {
        uint256 pk = vm.envUint("DIRECT_PROOF_KEY");
        vm.startBroadcast(pk);
        VerdictGateDirectEnforcer gate = new VerdictGateDirectEnforcer(BRADBURY_GHOST_CODE_HASH);
        vm.stopBroadcast();
        console2.log("VerdictGateDirectEnforcer", address(gate));
        console2.logBytes32(gate.ghostCodeHash());
    }
}
