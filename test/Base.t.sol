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
import {ArbitAgentExecutor} from "../src/ArbitAgentExecutor.sol";

/// @notice Shared harness for the fee-tier + buyback system.
/// Swaps go through PoolSwapTest (the "router"); the effective trader is
/// passed as 32-byte hookData per ArbitHook._trader.
abstract contract Base is Test {
    IPoolManager manager;
    ArbitRegistry registry;
    ArbitHook hook;
    TestERC20 arbt;
    TestERC20 other;
    PoolKey key; // allowed dynamic-fee pool
    PoolKey staticKey; // static-fee pool (override ignored) — NOT allowed
    PoolModifyLiquidityTest lp;
    PoolSwapTest router;
    ArbitAgentExecutor executor; // agent identity for executor tests

    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        arbt = new TestERC20(1e30);
        other = new TestERC20(1e30);
        manager = new PoolManager(address(this));
        registry = new ArbitRegistry(address(arbt), address(0), address(this));

        // Mine the hook address with exactly the beforeSwap|afterSwap bits
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

        // Fund the hook so rewards / victim payouts / burns are backed
        arbt.transfer(address(hook), 1_000_000e18);

        lp = new PoolModifyLiquidityTest(manager);
        router = new PoolSwapTest(manager);

        (Currency c0, Currency c1, TestERC20 t0, TestERC20 t1) = _sort(arbt, other);
        key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 10,
            hooks: IHooks(address(hook))
        });
        manager.initialize(key, SQRT_PRICE_1_1);
        registry.allowPool(key.toId());
        _seedLiquidity(key, t0, t1);

        // Same hook, static fee, NOT allowlisted
        staticKey = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(staticKey, SQRT_PRICE_1_1);

        executor = new ArbitAgentExecutor(manager, registry);
        arbt.approve(address(executor), type(uint256).max);
        other.approve(address(executor), type(uint256).max);

        arbt.approve(address(router), type(uint256).max);
        other.approve(address(router), type(uint256).max);
    }

    function _sort(TestERC20 a, TestERC20 b)
        internal
        pure
        returns (Currency c0, Currency c1, TestERC20 t0, TestERC20 t1)
    {
        if (address(a) < address(b)) {
            return (Currency.wrap(address(a)), Currency.wrap(address(b)), a, b);
        }
        return (Currency.wrap(address(b)), Currency.wrap(address(a)), b, a);
    }

    function _seedLiquidity(PoolKey memory k, TestERC20 t0, TestERC20 t1) internal {
        t0.approve(address(lp), type(uint256).max);
        t1.approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(
            k,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(k.tickSpacing),
                tickUpper: TickMath.maxUsableTick(k.tickSpacing),
                liquidityDelta: 1e24,
                salt: bytes32(0)
            }),
            ""
        );
    }

    /// @dev Swap `amountIn` of input token as `trader` (via hookData identity).
    function _swapAs(address trader, bool zeroForOne, uint256 amountIn) internal returns (uint256) {
        return _swapAsOn(key, trader, zeroForOne, amountIn);
    }

    function _swapAsOn(PoolKey memory k, address trader, bool zeroForOne, uint256 amountIn)
        internal
        returns (uint256)
    {
        router.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(trader)
        );
        return amountIn;
    }

    /// @dev Register `who` as an agent with MIN_STAKE (funded from test supply).
    function _registerAgent(address who) internal {
        arbt.transfer(who, 100e18);
        vm.startPrank(who);
        arbt.approve(address(registry), 100e18);
        registry.register(100e18);
        vm.stopPrank();
    }

    /// @dev Boost `who` to high-rep (>=800) via hook-pranked rewards.
    function _boostRep(address who, uint256 times) internal {
        vm.startPrank(address(hook));
        for (uint256 i; i < times; i++) {
            registry.reward(who);
        }
        vm.stopPrank();
    }
}
