// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
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

/// @notice Stock-pool edge: 1.5x accrual + 2/3 fees on flagged pools.
/// Two identically-configured pools (std + stock) — same swaps must accrue
/// exactly 1.5x on the stock side.
contract StockTest is Test {
    using PoolIdLibrary for PoolKey;

    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    IPoolManager manager;
    ArbitRegistry registry;
    ArbitHook hook;
    TestERC20 arbt;
    TestERC20 other; // std-pool pair
    TestERC20 stock; // stock-pool pair (mock AAPL)
    PoolKey stdKey;
    PoolKey stockKey;
    PoolModifyLiquidityTest lp;
    PoolSwapTest router;

    event StockMultiplierApplied(
        PoolId indexed poolId, address indexed trader, uint256 originalAmount, uint256 multipliedAmount
    );
    event FeeCollected(address swapper, uint256 feeBps, ArbitRegistry.ParticipantType pType);

    function setUp() public {
        vm.warp(1_800_000_000);
        arbt = new TestERC20(1e30);
        other = new TestERC20(1e30);
        stock = new TestERC20(1e30);
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
        arbt.transfer(address(hook), 1_000_000e18);

        lp = new PoolModifyLiquidityTest(manager);
        router = new PoolSwapTest(manager);
        arbt.approve(address(lp), type(uint256).max);
        other.approve(address(lp), type(uint256).max);
        stock.approve(address(lp), type(uint256).max);
        arbt.approve(address(router), type(uint256).max);
        other.approve(address(router), type(uint256).max);
        stock.approve(address(router), type(uint256).max);

        stdKey = _makePool(arbt, other);
        stockKey = _makePool(arbt, stock);
        registry.allowPool(stdKey.toId());
        registry.allowPool(stockKey.toId());
        hook.setStockPool(stockKey.toId(), true);
    }

    function _makePool(TestERC20 a, TestERC20 b) internal returns (PoolKey memory k) {
        (Currency c0, Currency c1) = address(a) < address(b)
            ? (Currency.wrap(address(a)), Currency.wrap(address(b)))
            : (Currency.wrap(address(b)), Currency.wrap(address(a)));
        k = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        TestERC20 t0 = TestERC20(Currency.unwrap(c0));
        TestERC20 t1 = TestERC20(Currency.unwrap(c1));
        t0.approve(address(lp), type(uint256).max);
        t1.approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(
            k,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: 1e24,
                salt: bytes32(0)
            }),
            ""
        );
    }

    function _swapOn(PoolKey memory k, address trader, uint256 amountIn) internal {
        router.swap(
            k,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(trader)
        );
    }

    function test_StockMultiplierApplied() public {
        address human = makeAddr("human");
        uint256 b0 = hook.buybackPool();
        _swapOn(stdKey, human, 10e18);
        uint256 stdContrib = hook.buybackPool() - b0;

        uint256 b1 = hook.buybackPool();
        _swapOn(stockKey, human, 10e18);
        uint256 stockContrib = hook.buybackPool() - b1;

        assertGt(stdContrib, 0);
        assertEq(stockContrib, (stdContrib * 150) / 100);
    }

    function test_StockMultiplierEmitsEvent() public {
        address human = makeAddr("human-ev");
        // Topics only: pool + trader must match (amounts asserted exactly above)
        vm.expectEmit(true, true, false, false, address(hook));
        emit StockMultiplierApplied(stockKey.toId(), human, 0, 0);
        _swapOn(stockKey, human, 10e18);
    }

    function test_StockDiscountsFee() public {
        address human = makeAddr("human-fee");
        // Standard pool charges 30 bps; stock pool charges 20 bps (30 * 2/3)
        vm.expectEmit(false, false, false, true, address(hook));
        emit FeeCollected(human, 30, ArbitRegistry.ParticipantType.HUMAN);
        _swapOn(stdKey, human, 10e18);

        // Stock side emits the boost first, then the DISCOUNTED fee (20 bps)
        vm.expectEmit(true, true, false, false, address(hook));
        emit StockMultiplierApplied(stockKey.toId(), human, 0, 0);
        vm.expectEmit(false, false, false, true, address(hook));
        emit FeeCollected(human, 20, ArbitRegistry.ParticipantType.HUMAN);
        _swapOn(stockKey, human, 10e18);
    }

    function test_StockMultiplierAllFlows() public {
        // Agent: register + boost to HIGH on both sides via fresh agents
        address agentStd = makeAddr("agent-std");
        address agentStock = makeAddr("agent-stock");
        for (uint256 i; i < 2; i++) {
            address who = i == 0 ? agentStd : agentStock;
            arbt.transfer(who, 100e18);
            vm.startPrank(who);
            arbt.approve(address(registry), 100e18);
            registry.register(100e18);
            vm.stopPrank();
        }
        vm.startPrank(address(hook));
        for (uint256 i; i < 60; i++) {
            registry.reward(agentStd);
            registry.reward(agentStock);
        }
        vm.stopPrank();

        _swapOn(stdKey, agentStd, 10e18);
        uint256 stdReward = hook.pendingRewards(agentStd);
        _swapOn(stockKey, agentStock, 10e18);
        uint256 stockReward = hook.pendingRewards(agentStock);
        assertGt(stdReward, 0);
        assertEq(stockReward, (stdReward * 150) / 100);

        // Bot: 3 warm-up + taxed swap on each pool
        address botStd = makeAddr("bot-std");
        address botStock = makeAddr("bot-stock");
        for (uint256 i; i < 3; i++) {
            _swapOn(stdKey, botStd, 1e18);
            _swapOn(stockKey, botStock, 1e18);
            vm.roll(block.number + 1);
        }
        uint256 v0 = hook.victimPool();
        _swapOn(stdKey, botStd, 10e18);
        uint256 stdVictim = hook.victimPool() - v0;
        uint256 v1 = hook.victimPool();
        _swapOn(stockKey, botStock, 10e18);
        uint256 stockVictim = hook.victimPool() - v1;
        assertGt(stdVictim, 0);
        assertEq(stockVictim, (stdVictim * 150) / 100);
    }

    function test_StockAccumulatesFasterIdenticalActivity() public {
        // 3 identical human swaps per pool → stock side accrues exactly 1.5x total
        address human = makeAddr("human-loop");
        uint256 b0 = hook.buybackPool();
        for (uint256 i; i < 3; i++) _swapOn(stdKey, human, 5e18);
        uint256 stdTotal = hook.buybackPool() - b0;

        address human2 = makeAddr("human-loop2");
        uint256 b1 = hook.buybackPool();
        for (uint256 i; i < 3; i++) _swapOn(stockKey, human2, 5e18);
        uint256 stockTotal = hook.buybackPool() - b1;

        assertEq(stockTotal, (stdTotal * 150) / 100);
    }

    function test_SetStockPoolOnlyOwner() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        hook.setStockPool(stdKey.toId(), true);

        assertFalse(hook.isStockPool(stdKey.toId()));
        hook.setStockPool(stdKey.toId(), true);
        assertTrue(hook.isStockPool(stdKey.toId()));
        hook.setStockPool(stdKey.toId(), false);
        assertFalse(hook.isStockPool(stdKey.toId()));
    }
}
