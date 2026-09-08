// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";
import {ArbitHook} from "../src/ArbitHook.sol";

/// @notice Deploys ArbitRegistry + CREATE2-mined ArbitHook and wires setHook.
/// Run with env: ARBT_TOKEN_ADDRESS, POOL_MANAGER_ADDRESS
/// Pool MUST be created with fee = LPFeeLibrary.DYNAMIC_FEE_FLAG or the
/// beforeSwap fee return is silently ignored. After pool creation call
/// registry.allowPool(key.toId()) — until then every swap reverts
/// "Arbit: unauthorized pool". Fund the hook with ARBT so rewards / victim
/// payouts / burns are backed. Verify both contracts on blockscout.
contract DeployArbit is Script {
    function run() external {
        address arbt = vm.envAddress("ARBT_TOKEN_ADDRESS");
        address poolManager = vm.envAddress("POOL_MANAGER_ADDRESS");
        if (arbt == address(0) || poolManager == address(0)) {
            revert("set ARBT_TOKEN_ADDRESS, POOL_MANAGER_ADDRESS");
        }

        vm.startBroadcast();

        // Standalone/testnet deployment: no initializer (pass zero) — direct
        // owner wiring below. Mainnet graph passes the initializer target.
        ArbitRegistry registry = new ArbitRegistry(arbt, address(0), msg.sender);

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        // `new ArbitHook{salt:}` inside a forge script is routed through the
        // canonical keyless Create2Deployer — THAT contract (not the script,
        // not the sender EOA) is the CREATE2 deployer, so mine against it.
        // Mining against address(this)/msg.sender yields an address whose
        // permission bits don't match, and the constructor's
        // validateHookPermissions reverts (caught by anvil dry-run 2026-09-06).
        // `programmable-launch submit` re-mines for its own deployer on mainnet.
        address create2Deployer = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        (address hookAddress, bytes32 salt) = HookMiner.find(
            create2Deployer,
            flags,
            type(ArbitHook).creationCode,
            abi.encode(poolManager, address(registry), arbt, msg.sender, block.chainid)
        );
        ArbitHook hook = new ArbitHook{salt: salt}(
            IPoolManager(poolManager), address(registry), arbt, msg.sender, block.chainid
        );
        require(address(hook) == hookAddress, "hook address mismatch");

        registry.setHook(address(hook));

        vm.stopBroadcast();

        console2.log("Registry:", address(registry));
        console2.log("Hook:", address(hook));
        console2.log("Next: create pool, then registry.allowPool(key.toId()), then verify on blockscout");
    }
}
