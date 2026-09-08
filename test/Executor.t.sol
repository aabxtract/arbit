// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";
import {Base} from "./Base.t.sol";

contract ExecutorTest is Base {
    function test_ExecutorRegistersAndSwapsAsAgent() public {
        // executor.agent() is this test contract (deployer) — fund + approve
        arbt.approve(address(executor), 100e18);
        executor.register(100e18);

        (uint256 fee,) = registry.previewFee(address(executor), 1 gwei);
        assertEq(fee, 15); // starts at 500 → MED

        bool zeroForOne = true;
        // Swap 5 ARBT-equivalent through the executor identity
        uint256 amountIn = 5e18;
        // Approve executor to pull input
        arbt.approve(address(executor), amountIn);
        other.approve(address(executor), amountIn);
        executor.swapExactInputSingle(key, zeroForOne, amountIn, "");

        // Executor earned agent treatment (MED → 25% of fee queued)
        assertGt(hook.pendingRewards(address(executor)), 0);
    }
}
