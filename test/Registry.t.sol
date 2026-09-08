// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TestERC20} from "v4-core/src/test/TestERC20.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";

contract RegistryTest is Test {
    TestERC20 arbt;
    ArbitRegistry registry;
    address hookAddr;

    function setUp() public {
        arbt = new TestERC20(1e30);
        registry = new ArbitRegistry(address(arbt), address(0), address(this));
        hookAddr = makeAddr("hook");
        registry.setHook(hookAddr);
    }

    function test_RegisterEffectsFirstAndHoldsStake() public {
        arbt.approve(address(registry), 100e18);
        registry.register(100e18);

        ArbitRegistry.Agent memory a = registry.getAgent(address(this));
        assertEq(a.stakedAmount, 100e18);
        assertEq(a.reputationScore, 500);
        assertTrue(a.active);
        assertEq(arbt.balanceOf(address(registry)), 100e18);
    }

    function test_RegisterRejections() public {
        arbt.approve(address(registry), type(uint256).max);
        vm.expectRevert("Below minimum stake");
        registry.register(99e18);

        registry.register(100e18);
        vm.expectRevert("Already registered");
        registry.register(100e18);
    }

    function test_PreviewFeeTiers() public {
        address human = makeAddr("human");
        (uint256 fee,) = registry.previewFee(human, 1 gwei);
        assertEq(fee, registry.FEE_HUMAN());

        address agent = makeAddr("agent");
        arbt.transfer(agent, 100e18);
        vm.startPrank(agent);
        arbt.approve(address(registry), 100e18);
        registry.register(100e18);
        vm.stopPrank();

        // Starts at 500 → MED
        (uint256 medFee,) = registry.previewFee(agent, 1 gwei);
        assertEq(medFee, registry.FEE_AGENT_MED());

        // Boost to 800+ → HIGH
        vm.startPrank(hookAddr);
        for (uint256 i; i < 60; i++) registry.reward(agent);
        vm.stopPrank();
        (uint256 highFee,) = registry.previewFee(agent, 1 gwei);
        assertEq(highFee, registry.FEE_AGENT_HIGH());

        // Slash below 500 → LOW
        vm.startPrank(hookAddr);
        for (uint256 i; i < 7; i++) registry.slash(agent);
        vm.stopPrank();
        (uint256 lowFee,) = registry.previewFee(agent, 1 gwei);
        assertEq(lowFee, registry.FEE_AGENT_LOW());
    }

    function test_ClassifyBotHighFrequency() public {
        address bot = makeAddr("bot");
        vm.startPrank(hookAddr);
        // First three: HUMAN (pattern builds)
        for (uint256 i; i < 3; i++) {
            (uint256 fee,) = registry.classify(bot, 1 gwei);
            assertEq(fee, registry.FEE_HUMAN());
            vm.roll(block.number + 1);
        }
        // Fourth inside window: BOT
        (uint256 botFee, ArbitRegistry.ParticipantType pType) = registry.classify(bot, 1 gwei);
        assertEq(botFee, registry.FEE_BOT());
        assertEq(uint8(pType), uint8(ArbitRegistry.ParticipantType.BOT));
        vm.stopPrank();
    }

    function test_ClassifyGasSpike() public {
        address bot = makeAddr("bot2");
        vm.startPrank(hookAddr);
        registry.classify(bot, 1 gwei); // sets avg
        vm.roll(block.number + 1);
        registry.classify(bot, 1 gwei);
        vm.roll(block.number + 1);
        registry.classify(bot, 1 gwei);
        vm.roll(block.number + 1);
        // High-freq window still holds → BOT regardless of gas
        (uint256 fee,) = registry.classify(bot, 10 gwei);
        assertEq(fee, registry.FEE_BOT());
        vm.stopPrank();
    }

    function test_RewardCapsAndSlashDeactivates() public {
        address agent = makeAddr("agent2");
        arbt.transfer(agent, 100e18);
        vm.startPrank(agent);
        arbt.approve(address(registry), 100e18);
        registry.register(100e18);
        vm.stopPrank();

        vm.startPrank(hookAddr);
        for (uint256 i; i < 200; i++) registry.reward(agent);
        ArbitRegistry.Agent memory a = registry.getAgent(agent);
        assertEq(a.reputationScore, registry.MAX_REPUTATION());

        for (uint256 i; i < 25; i++) registry.slash(agent);
        a = registry.getAgent(agent);
        assertEq(a.reputationScore, 0);
        assertFalse(a.active);
        vm.stopPrank();
    }

    function test_SetHookOnceAndOnlyOwner() public {
        vm.expectRevert("Hook already set");
        registry.setHook(makeAddr("other"));

        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        registry.allowPool(PoolId.wrap(bytes32(uint256(1))));
    }

    function test_PreviewFeeNeverExceedsMax(uint256 gasPrice, address who) public view {
        vm.assume(who != address(0));
        (uint256 fee,) = registry.previewFee(who, gasPrice);
        assertLe(fee, registry.MAX_FEE_BPS());
    }
}
