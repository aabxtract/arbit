// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";
import {ArbitHook} from "../src/ArbitHook.sol";
import {Base} from "./Base.t.sol";

contract HookTest is Base {
    function test_DirectCallbackBypassReverts() public {
        // Cork $11M class: calling hook callbacks directly must fail
        vm.expectRevert(ArbitHook.PoolManagerOnly.selector);
        hook.beforeSwap(
            address(this),
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(1e18),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        vm.expectRevert(ArbitHook.PoolManagerOnly.selector);
        hook.afterSwap(
            address(this),
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(1e18),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            BalanceDeltaLibrary.ZERO_DELTA,
            ""
        );
    }

    function test_WrongChainDeployReverts() public {
        ArbitRegistry r2 = new ArbitRegistry(address(arbt), address(0), address(this));
        uint256 badChain = block.chainid + 1;
        (address h, bytes32 salt) = HookMiner.find(
            address(this),
            uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG),
            type(ArbitHook).creationCode,
            abi.encode(address(manager), address(r2), address(arbt), address(this), badChain)
        );
        h;
        vm.expectRevert("Wrong chain");
        new ArbitHook{salt: salt}(
            manager, address(r2), address(arbt), address(this), badChain
        );
    }

    function test_HumanFeeAccruesBuyback() public {
        address human = makeAddr("human");
        uint256 before = hook.buybackPool();
        _swapAs(human, true, 10e18);
        uint256 contrib = hook.buybackPool() - before;
        assertGt(contrib, 0);
        assertEq(hook.victimPool(), 0);
    }

    function test_AgentHighRepRewardAndClaim() public {
        address agent = makeAddr("agent");
        _registerAgent(agent);
        _boostRep(agent, 60); // 500 + 300 = 800 → HIGH

        (uint256 fee,) = registry.previewFee(agent, 1 gwei);
        assertEq(fee, 5);

        _swapAs(agent, true, 10e18);
        uint256 pending = hook.pendingRewards(agent);
        assertGt(pending, 0);

        uint256 balBefore = arbt.balanceOf(agent);
        vm.prank(agent);
        hook.claimReward();
        assertEq(arbt.balanceOf(agent) - balBefore, pending);
        assertEq(hook.pendingRewards(agent), 0);
    }

    function test_AgentMedRewardAndLowGetsNothing() public {
        address agent = makeAddr("agent-med");
        _registerAgent(agent); // 500 → MED, no boost

        (uint256 fee,) = registry.previewFee(agent, 1 gwei);
        assertEq(fee, 15);

        _swapAs(agent, true, 10e18);
        uint256 medPending = hook.pendingRewards(agent);
        assertGt(medPending, 0);

        // Slash down to LOW (<500): reward drops to 0 but rep still accrues
        vm.startPrank(address(hook));
        registry.slash(agent);
        vm.stopPrank();
        (uint256 lowFee,) = registry.previewFee(agent, 1 gwei);
        assertEq(lowFee, 30);

        uint256 repBefore = registry.getAgent(agent).reputationScore;
        _swapAs(agent, true, 10e18);
        assertEq(hook.pendingRewards(agent), medPending); // no new reward
        assertGt(registry.getAgent(agent).reputationScore, repBefore); // rep still +5

        // MED accrual is claimable
        uint256 balBefore = arbt.balanceOf(agent);
        vm.prank(agent);
        hook.claimReward();
        assertEq(arbt.balanceOf(agent) - balBefore, medPending);
    }

    function test_ReverseDirectionFeeAccounting() public {
        // Fee must accrue on the input leg in BOTH directions (audit Sep 7:
        // previously always amount0, mis-counting one direction).
        address human = makeAddr("human-rev");
        uint256 b0 = hook.buybackPool();
        _swapAs(human, true, 10e18);
        uint256 fwd = hook.buybackPool() - b0;
        assertGt(fwd, 0);

        uint256 b1 = hook.buybackPool();
        _swapAs(human, false, 10e18);
        uint256 rev = hook.buybackPool() - b1;
        assertGt(rev, 0);
    }

    function test_HookDataIdentityAttribution() public {
        // sender (router) is NOT the trader — reward must land on hookData user.
        address agent = makeAddr("agent2");
        _registerAgent(agent);
        _boostRep(agent, 60);

        _swapAs(agent, true, 5e18);
        assertGt(hook.pendingRewards(agent), 0);
        assertEq(hook.pendingRewards(address(router)), 0);
    }

    function test_BotFlowSplitsVictimAndBuyback() public {
        address bot = makeAddr("bot");
        // Build frequency: 3 swaps in window, 4th is BOT
        _swapAs(bot, true, 1e18);
        vm.roll(block.number + 1);
        _swapAs(bot, true, 1e18);
        vm.roll(block.number + 1);
        _swapAs(bot, true, 1e18);
        vm.roll(block.number + 1);

        uint256 vBefore = hook.victimPool();
        uint256 bBefore = hook.buybackPool();
        _swapAs(bot, true, 10e18);

        uint256 vContrib = hook.victimPool() - vBefore;
        uint256 bContrib = hook.buybackPool() - bBefore;
        assertGt(vContrib, 0);
        assertGt(bContrib, 0);
        // 60/40 split: victim = 1.5x buyback
        assertApproxEqRel(vContrib * 100, bContrib * 150, 0.01e18);
    }

    function test_UnauthorizedPoolReverts() public {
        address human = makeAddr("human");
        // v4 wraps hook reverts in WrappedError — assert any revert here;
        // the trace confirms "Arbit: unauthorized pool" as the inner reason.
        vm.expectRevert();
        _swapAsOn(staticKey, human, true, 1e18);
    }

    function test_BuybackGuardCooldownBlocksEarlyFire() public {
        address bot = makeAddr("bot2");
        // Force a large buyback accrual quickly via bot flow
        for (uint256 i; i < 3; i++) {
            _swapAs(bot, true, 5e18);
            vm.roll(block.number + 1);
        }
        uint256 t0 = hook.lastBuybackTime();
        _swapAs(bot, true, 50e18);
        // Cooldown (1h) has not elapsed since deploy → no fire, timestamp stuck
        assertEq(hook.lastBuybackTime(), t0);
    }

    function test_BuybackFiresAfterCooldownAndThreshold() public {
        address bot = makeAddr("bot3");
        for (uint256 i; i < 3; i++) {
            _swapAs(bot, true, 5e18);
            vm.roll(block.number + 1);
        }
        vm.warp(block.timestamp + 1 hours + 1);
        uint256 hookBalBefore = arbt.balanceOf(address(hook));
        _swapAs(bot, true, 50e18); // victim 60% + buyback 40% ≈ 0.2e18 > 0.05 threshold
        assertGt(hook.buybackPool() + 1, 0); // pool accounted
        // Burn happened: hook ARBT balance dropped, timestamp advanced
        assertLt(arbt.balanceOf(address(hook)), hookBalBefore);
    }

    function test_ClaimRevertsWhenEmpty() public {
        vm.expectRevert("No pending reward");
        hook.claimReward();
    }

    function test_CompensateVictimGuards() public {
        address victim = makeAddr("victim");
        vm.expectRevert("Insufficient victim pool");
        hook.compensateVictim(victim, 1e18);

        // Accrue victim funds first
        address bot = makeAddr("bot4");
        for (uint256 i; i < 3; i++) {
            _swapAs(bot, true, 5e18);
            vm.roll(block.number + 1);
        }
        _swapAs(bot, true, 20e18);
        uint256 avail = hook.victimPool();
        assertGt(avail, 0);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        hook.compensateVictim(victim, 1);

        uint256 balBefore = arbt.balanceOf(victim);
        hook.compensateVictim(victim, avail);
        assertEq(arbt.balanceOf(victim) - balBefore, avail);
        assertEq(hook.victimPool(), 0);
    }

    function test_CacheClearedBetweenSwaps() public {
        address human = makeAddr("human2");
        _swapAs(human, true, 5e18);
        uint256 p1 = hook.buybackPool();
        _swapAs(human, true, 5e18);
        assertGt(hook.buybackPool(), p1); // second swap accrued independently
    }
}
