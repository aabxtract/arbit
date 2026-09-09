// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./Base.t.sol";
import {DistributorTest} from "./Distributor.t.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";

// These tests reproduce defects in the current code; passing confirms the defect.
contract ReviewHookFindings is Base {
    function test_Review_UntrustedPokeCanBreakVictimPricing() public {
        address victim = makeAddr("victim");
        vm.prank(makeAddr("attacker"));
        registry.poke(victim, type(uint256).max);
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x11));
        registry.previewFee(victim, 1 gwei);
    }

    function test_Review_UnrelatedPayerCanImpersonateAgent() public {
        address victim = makeAddr("victim-agent");
        _registerAgent(victim);
        // Base's router pulls tokens from this test contract, not from victim.
        _swapAs(victim, true, 1 ether);
        ArbitRegistry.Agent memory a = registry.getAgent(victim);
        assertEq(a.reputationScore, 505);
        assertGt(hook.pendingRewards(victim), 0);
    }

    function test_Review_MultipleAgentsOvercommitBacking() public {
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        _registerAgent(alice);
        _registerAgent(bob);
        deal(address(arbt), address(hook), 0.001 ether);
        _swapAs(alice, true, 10 ether);
        _swapAs(bob, true, 10 ether);
        assertGt(hook.pendingRewards(alice) + hook.pendingRewards(bob), arbt.balanceOf(address(hook)));
        vm.prank(alice);
        hook.claimReward();
        vm.prank(bob);
        vm.expectRevert();
        hook.claimReward();
    }

    function test_Review_BurnConsumesPromisedRewards() public {
        address alice = makeAddr("alice");
        _registerAgent(alice);
        deal(address(arbt), address(hook), 0.01 ether);
        _swapAs(alice, true, 10 ether);
        assertGt(hook.pendingRewards(alice), 0);
        vm.warp(block.timestamp + 1 hours + 1);
        _swapAs(makeAddr("human"), true, 100 ether);
        assertEq(arbt.balanceOf(address(hook)), 0);
        vm.prank(alice);
        vm.expectRevert();
        hook.claimReward();
    }
}

contract ReviewDistributorFindings is DistributorTest {
    function test_Review_SecondBuybackSpendsVictimReserve() public {
        vm.deal(address(vault), 0.02 ether);
        vm.warp(block.timestamp + 1 hours + 1);
        dist.executeBuyback(1);
        vm.deal(address(vault), 0.02 ether);
        vm.warp(block.timestamp + 1 hours + 1);
        dist.executeBuyback(1);
        assertEq(dist.victimPool(), 0.0088 ether);
        assertEq(address(dist).balance, 0.0048 ether);
        vm.expectRevert("Insufficient balance");
        dist.compensateVictim(makeAddr("victim"), dist.victimPool());
    }
}
