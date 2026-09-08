// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {TestERC20} from "v4-core/src/test/TestERC20.sol";

/// @notice Anvil-only prerequisites for DeployArbit dry-runs.
/// Deploys a mock ARBT token + PoolManager, logs both addresses.
/// Usage (PowerShell):
///   anvil                                    # terminal 1
///   forge script script/SetupAnvil.s.sol --broadcast --rpc-url http://127.0.0.1:8545
///   $env:ARBT_TOKEN_ADDRESS="<logged>"; $env:POOL_MANAGER_ADDRESS="<logged>"
///   forge script script/DeployArbit.s.sol --broadcast --rpc-url http://127.0.0.1:8545
contract SetupAnvil is Script {
    function run() external {
        vm.startBroadcast();
        TestERC20 arbt = new TestERC20(1e30);
        PoolManager manager = new PoolManager(msg.sender);
        vm.stopBroadcast();

        console2.log("ARBT_TOKEN_ADDRESS=%s", address(arbt));
        console2.log("POOL_MANAGER_ADDRESS=%s", address(manager));
    }
}
