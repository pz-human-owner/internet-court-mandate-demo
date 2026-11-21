// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// @dev Test stand-in for a GenLayer ghost contract. On chain, the ghost executes the IC's finalized external
///      message via handleOp(), so the gate sees msg.sender == the IC address. Every MockGhost has the same
///      runtime code, like real ghosts (which share one beacon-proxy code hash).
contract MockGhost {
    function deliver(address target, bytes calldata data) external {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

/// @dev A different contract (different code hash) that tries to post.
contract NotAGhost {
    function deliver(address target, bytes calldata data) external {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
