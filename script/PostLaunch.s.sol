// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";
import {ArbitDistributor} from "../src/ArbitDistributor.sol";

/// @notice Post-finalize wiring (all cheap owner txs, any gas window).
/// Env: POOL_MANAGER_ADDRESS, ARBT_TOKEN_ADDRESS, HOOK_ADDRESS (kernel),
/// DISTRIBUTOR_ADDRESS, FEE (default 0), TICK_SPACING (default 60).
/// Steps: 1. deploy registry (token, no initializer, owner=sender)
///        2. distributor.setVault(kernel.feeVault())
///        3. distributor.setBuyKey(official pool key)
///        4. registry.setKeeper(keeper, true)
/// Run with the SAME wallet that owns registry/distributor.
contract PostLaunch is Script {
    using PoolIdLibrary for PoolKey;

    function run() external {
        IPoolManager manager = IPoolManager(vm.envAddress("POOL_MANAGER_ADDRESS"));
        address arbt = vm.envAddress("ARBT_TOKEN_ADDRESS");
        address kernel = vm.envAddress("HOOK_ADDRESS");
        ArbitDistributor dist = ArbitDistributor(payable(vm.envAddress("DISTRIBUTOR_ADDRESS")));
        uint24 fee = uint24(vm.envOr("FEE", uint256(0)));
        int24 tickSpacing = int24(int256(vm.envOr("TICK_SPACING", uint256(60))));

        vm.startBroadcast();

        // 1. Registry (standalone: no initializer on the kernel path)
        ArbitRegistry registry = new ArbitRegistry(arbt, address(0), msg.sender);
        console2.log("Registry:", address(registry));

        // 2. Vault binding — read the kernel's deterministic child, no guessing
        (bool ok, bytes memory ret) =
            kernel.call(abi.encodeWithSignature("feeVault()"));
        require(ok && ret.length == 32, "feeVault read failed");
        address vault = abi.decode(ret, (address));
        dist.setVault(vault);
        console2.log("Vault bound:", vault);

        // 3. Official pool key (native/ARBT) + buy-key wiring
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(arbt),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(kernel)
        });
        PoolId poolId = key.toId();
        dist.setBuyKey(key);
        console2.log("Buy pool:");
        console2.logBytes32(PoolId.unwrap(poolId));

        // 4. Keeper (reward/slash/poke path without hook callbacks)
        address keeper = msg.sender;
        registry.setKeeper(keeper, true);
        console2.log("Keeper:", keeper);

        // Sanity reads (revert loudly if anything is off)
        require(address(dist.vault()) == vault, "vault mismatch");
        require(registry.keepers(keeper), "keeper mismatch");

        vm.stopBroadcast();
        console2.log("Post-launch wiring complete. Next: verify on Blockscout.");
    }
}
