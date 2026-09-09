// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./Base.t.sol";
import {DistributorTest} from "./Distributor.t.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";

// Regression tests for the Sep 8 external review findings. Each test pins
// the FIXED behavior (an earlier revision of this file asserted the defects).
contract ReviewHookFindings is Base {
    function test_Review_PokeCannotBrickPricing() public {
        address victim = makeAddr("victim");
        vm.prank(makeAddr("attacker"));
        registry.poke(victim, type(uint256).max);
        // Must NOT revert (was: arithmetic panic bricks previewFee/classify)
        (uint256 fee,) = registry.previewFee(victim, 1 gwei);
        assertLe(fee, registry.MAX_FEE_BPS());
    }

    function test_Review_HookDataAttributionIsByDesign() public {
        // HookData identity is the documented v4 router pattern: rewards accrue
        // to the attributed trader while settlement pulls from the caller.
        // No funds are at risk (reward() no-ops for inactive agents).
        address victim = makeAddr("victim-agent");
        _registerAgent(victim);
        // Base's router pulls tokens from this test contract, not from victim.
        _swapAs(victim, true, 1 ether);
        ArbitRegistry.Agent memory a = registry.getAgent(victim);
        assertEq(a.reputationScore, 505);
        assertGt(hook.pendingRewards(victim), 0);
    }

    function test_Review_MultiAgentBackingHolds() public {
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        _registerAgent(alice);
        _registerAgent(bob);
        // Backing covers Alice in full plus part of Bob (was: both overpromised)
        deal(address(arbt), address(hook), 0.005 ether);
        _swapAs(alice, true, 10 ether);
        _swapAs(bob, true, 10 ether);
        // Global commitment can never exceed backing (was: per-trader caps summed past it)
        assertLe(
            hook.pendingRewards(alice) + hook.pendingRewards(bob),
            arbt.balanceOf(address(hook))
        );
        assertGt(hook.pendingRewards(alice), 0);
        assertGt(hook.pendingRewards(bob), 0);
        // Both claims pay in full (was: second claim reverted after first drained)
        uint256 aliceExpected = hook.pendingRewards(alice);
        uint256 aliceBal = arbt.balanceOf(alice);
        vm.prank(alice);
        hook.claimReward();
        assertEq(arbt.balanceOf(alice) - aliceBal, aliceExpected);
        uint256 bobExpected = hook.pendingRewards(bob);
        uint256 bobBal = arbt.balanceOf(bob);
        vm.prank(bob);
        hook.claimReward();
        assertEq(arbt.balanceOf(bob) - bobBal, bobExpected);
    }

    function test_Review_BurnPreservesPromises() public {
        address alice = makeAddr("alice");
        _registerAgent(alice);
        deal(address(arbt), address(hook), 0.01 ether);
        _swapAs(alice, true, 10 ether);
        uint256 promised = hook.pendingRewards(alice);
        assertGt(promised, 0);
        vm.warp(block.timestamp + 1 hours + 1);
        _swapAs(makeAddr("human"), true, 100 ether);
        // Promised funds survive the burn (was: burn consumed backing, claim reverted)
        assertGe(arbt.balanceOf(address(hook)), promised);
        uint256 balBefore = arbt.balanceOf(alice);
        vm.prank(alice);
        hook.claimReward();
        assertEq(arbt.balanceOf(alice) - balBefore, promised);
    }
}

contract ReviewDistributorFindings is DistributorTest {
    function test_Review_VictimReserveStaysSolvent() public {
        vm.deal(address(vault), 0.02 ether);
        vm.warp(block.timestamp + 1 hours + 1);
        dist.executeBuyback(1);
        vm.deal(address(vault), 0.02 ether);
        vm.warp(block.timestamp + 1 hours + 1);
        dist.executeBuyback(1);
        // Reserve accounting tracks retained ETH exactly (was: overstated past holdings)
        assertEq(dist.victimPool(), 0.008 ether);
        assertEq(address(dist).balance, dist.victimPool());
        // Full victim payout now succeeds (was: "Insufficient balance" revert)
        address victim = makeAddr("victim");
        dist.compensateVictim(victim, dist.victimPool());
        assertEq(victim.balance, 0.008 ether);
        assertEq(dist.victimPool(), 0);
    }
}
