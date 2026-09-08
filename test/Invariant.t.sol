// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./Base.t.sol";

/// @notice Backing + bounds invariants for the fee/buyback system.
contract InvariantTest is Base {
    function test_PoolsNeverNegativeAndRewardsBacked() public {
        address human = makeAddr("human");
        address agent = makeAddr("agent");
        _registerAgent(agent);

        for (uint256 i; i < 5; i++) {
            _swapAs(human, true, (i + 1) * 1e18);
            vm.roll(block.number + 1);
            _swapAs(agent, true, (i + 1) * 1e18);
            vm.roll(block.number + 1);
        }

        assertGe(hook.buybackPool(), 0);
        assertGe(hook.victimPool(), 0);

        // Rewards are always payable: total queued agent rewards + victim
        // earmark never exceed the hook's real ARBT balance.
        uint256 queued = hook.pendingRewards(agent);
        uint256 held = arbt.balanceOf(address(hook));
        assertLe(queued + hook.victimPool(), held + 1e6); // dust tolerance
    }

    function test_FeeNeverExceedsMaxOnPreview(address who, uint256 gasPrice) public view {
        vm.assume(who != address(0));
        (uint256 fee,) = registry.previewFee(who, gasPrice);
        assertLe(fee, registry.MAX_FEE_BPS());
    }
}
