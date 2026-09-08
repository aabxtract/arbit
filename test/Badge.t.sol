// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TestERC20} from "v4-core/src/test/TestERC20.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";
import {ArbitHook} from "../src/ArbitHook.sol";
import {ArbitBadge} from "../src/ArbitBadge.sol";

/// @notice Badge passes: reputation-mirrored claims + holder fee halving.
contract BadgeTest is Test {
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    IPoolManager manager;
    ArbitRegistry registry;
    ArbitHook hook;
    ArbitBadge badge;
    TestERC20 arbt;
    TestERC20 other;
    PoolKey key;
    PoolSwapTest router;

    event FeeCollected(address swapper, uint256 feeBps, ArbitRegistry.ParticipantType pType);
    event BadgeMinted(address indexed to, uint256 indexed tokenId, ArbitBadge.Tier tier);

    function setUp() public {
        vm.warp(1_800_000_000);
        arbt = new TestERC20(1e30);
        other = new TestERC20(1e30);
        manager = new PoolManager(address(this));
        registry = new ArbitRegistry(address(arbt), address(0), address(this));

        (address hookAddress, bytes32 salt) = HookMiner.find(
            address(this),
            uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG),
            type(ArbitHook).creationCode,
            abi.encode(address(manager), address(registry), address(arbt), address(this), block.chainid)
        );
        hook = new ArbitHook{salt: salt}(
            manager, address(registry), address(arbt), address(this), block.chainid
        );
        require(address(hook) == hookAddress, "hook address mismatch");
        registry.setHook(address(hook));

        badge = new ArbitBadge(address(this));
        badge.setMinter(address(hook));
        hook.setBadge(address(badge));
        arbt.transfer(address(hook), 1_000_000e18);

        (Currency c0, Currency c1) = address(arbt) < address(other)
            ? (Currency.wrap(address(arbt)), Currency.wrap(address(other)))
            : (Currency.wrap(address(other)), Currency.wrap(address(arbt)));
        key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(key, SQRT_PRICE_1_1);
        registry.allowPool(key.toId());

        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        router = new PoolSwapTest(manager);
        arbt.approve(address(lp), type(uint256).max);
        other.approve(address(lp), type(uint256).max);
        arbt.approve(address(router), type(uint256).max);
        other.approve(address(router), type(uint256).max);
        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: 1e24,
                salt: bytes32(0)
            }),
            ""
        );
    }

    function _register(address who) internal {
        arbt.transfer(who, 100e18);
        vm.startPrank(who);
        arbt.approve(address(registry), 100e18);
        registry.register(100e18);
        vm.stopPrank();
    }

    function _boost(address who, uint256 times) internal {
        vm.startPrank(address(hook));
        for (uint256 i; i < times; i++) registry.reward(who);
        vm.stopPrank();
    }

    function _swapAs(address trader, uint256 amountIn) internal {
        router.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(trader)
        );
    }

    function test_ClaimTiers() public {
        address agent = makeAddr("agent");
        _register(agent);

        // 500 rep: Bronze + Silver pass, Gold reverts
        vm.startPrank(agent);
        hook.claimBadge(ArbitBadge.Tier.Bronze);
        hook.claimBadge(ArbitBadge.Tier.Silver);
        vm.expectRevert("Need 800 rep");
        hook.claimBadge(ArbitBadge.Tier.Gold);
        vm.stopPrank();
        assertEq(badge.balanceOf(agent), 2);

        _boost(agent, 60); // → 800
        vm.prank(agent);
        hook.claimBadge(ArbitBadge.Tier.Gold);
        assertEq(badge.balanceOf(agent), 3);
        assertEq(uint8(badge.tierOf(3)), uint8(ArbitBadge.Tier.Gold));
    }

    function test_DoubleClaimReverts() public {
        address agent = makeAddr("agent2");
        _register(agent);
        vm.startPrank(agent);
        hook.claimBadge(ArbitBadge.Tier.Bronze);
        vm.expectRevert("Already claimed");
        hook.claimBadge(ArbitBadge.Tier.Bronze);
        vm.stopPrank();
    }

    function test_UnregisteredCannotClaim() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert("Not a registered agent");
        hook.claimBadge(ArbitBadge.Tier.Bronze);
    }

    function test_WiringAuth() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        badge.setMinter(address(1));
        vm.expectRevert("Minter already set");
        badge.setMinter(address(1));

        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        hook.setBadge(address(1));
        vm.expectRevert("Badge already set");
        hook.setBadge(address(1));
    }

    function test_HolderDiscount() public {
        address agent = makeAddr("agent-disc");
        _register(agent);
        _boost(agent, 60); // HIGH → 5 bps unbadged

        vm.expectEmit(false, false, false, true, address(hook));
        emit FeeCollected(agent, 5, ArbitRegistry.ParticipantType.AGENT_HIGH);
        _swapAs(agent, 10e18);

        vm.prank(agent);
        hook.claimBadge(ArbitBadge.Tier.Gold);

        // Badged HIGH agent pays 2 bps (5/2)
        vm.expectEmit(false, false, false, true, address(hook));
        emit FeeCollected(agent, 2, ArbitRegistry.ParticipantType.AGENT_HIGH);
        _swapAs(agent, 10e18);
    }

    function test_BadgeTransferKeepsPerk() public {
        // Perk is holder-based: buying a pass secondhand still works
        address agent = makeAddr("agent-t");
        _register(agent);
        vm.prank(agent);
        hook.claimBadge(ArbitBadge.Tier.Bronze);

        address buyer = makeAddr("buyer");
        vm.prank(agent);
        badge.transferFrom(agent, buyer, 1);

        vm.expectEmit(false, false, false, true, address(hook));
        emit FeeCollected(buyer, 15, ArbitRegistry.ParticipantType.HUMAN);
        _swapAs(buyer, 10e18);
    }
}
