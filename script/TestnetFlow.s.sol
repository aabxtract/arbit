// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TestERC20} from "v4-core/src/test/TestERC20.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";
import {ArbitHook} from "../src/ArbitHook.sol";

/// @notice Full functional flow on Robinhood testnet (46630) against the
/// contracts deployed by SetupAnvil + DeployArbit. Mock ARBT (TestERC20) is
/// intentional on testnet — mainnet graph uses the real ArbitToken.
/// Env: POOL_MANAGER_ADDRESS, ARBT_TOKEN_ADDRESS, REGISTRY_ADDRESS, HOOK_ADDRESS.
/// ERC20 pool gets the full 3-flow treatment; native pool gets init + tiny LP + 1 swap.
contract TestnetFlow is Script {
    using PoolIdLibrary for PoolKey;

    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    function run() external {
        IPoolManager manager = IPoolManager(vm.envAddress("POOL_MANAGER_ADDRESS"));
        address arbtAddr = vm.envAddress("ARBT_TOKEN_ADDRESS");
        ArbitRegistry registry = ArbitRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        ArbitHook hook = ArbitHook(vm.envAddress("HOOK_ADDRESS"));
        // Broadcast sender passed explicitly via env (see guide)
        address wallet = vm.envAddress("WALLET_ADDRESS");

        vm.startBroadcast();

        // 0. Pair token for the ERC20 pool
        TestERC20 pair = new TestERC20(1e30);
        console2.log("Pair:", address(pair));

        // Sort ARBT/pair
        (Currency c0, Currency c1) = arbtAddr < address(pair)
            ? (Currency.wrap(arbtAddr), Currency.wrap(address(pair)))
            : (Currency.wrap(address(pair)), Currency.wrap(arbtAddr));

        PoolKey memory erc20Key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(erc20Key, SQRT_PRICE_1_1);
        registry.allowPool(erc20Key.toId());
        console2.log("ERC20 pool allowlisted");

        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        PoolSwapTest router = new PoolSwapTest(manager);

        TestERC20(arbtAddr).approve(address(lp), type(uint256).max);
        pair.approve(address(lp), type(uint256).max);
        TestERC20(arbtAddr).approve(address(router), type(uint256).max);
        pair.approve(address(router), type(uint256).max);

        lp.modifyLiquidity(
            erc20Key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: 1e22,
                salt: bytes32(0)
            }),
            ""
        );
        console2.log("ERC20 LP seeded");

        // 1. Fund the hook (reward/victim/burn backing)
        TestERC20(arbtAddr).transfer(address(hook), 100_000e18);
        console2.log("Hook funded");

        // 2. Human flow (fresh address via hookData identity)
        address human = 0x0000000000000000000000000000000000000001;
        _swap(router, erc20Key, human, true, 10e18);
        console2.log("Human buybackPool:", hook.buybackPool());

        // 3. Agent flow — the wallet registers ITSELF (EOAs register directly)
        TestERC20(arbtAddr).approve(address(registry), 100e18);
        registry.register(100e18); // starts at 500 rep → MED tier
        _swap(router, erc20Key, wallet, true, 10e18);
        console2.log("Agent pendingRewards:", hook.pendingRewards(wallet));

        // 4. Bot flow (4 rapid swaps → 4th taxed; blocks advance per tx)
        address bot = 0x0000000000000000000000000000000000000002;
        _swap(router, erc20Key, bot, true, 1e18);
        _swap(router, erc20Key, bot, true, 1e18);
        _swap(router, erc20Key, bot, true, 1e18);
        _swap(router, erc20Key, bot, true, 10e18);
        console2.log("Bot victimPool:", hook.victimPool());
        console2.log("Bot buybackPool:", hook.buybackPool());

        // 5. Native pool: init + allow + tiny LP + 1 swap
        PoolKey memory ethKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(arbtAddr),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(ethKey, SQRT_PRICE_1_1);
        registry.allowPool(ethKey.toId());
        lp.modifyLiquidity{value: 0.002 ether}(
            ethKey,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: 1e15, // ~0.001 ETH + ~1e15 ARBT at 1:1 (testnet budget)
                salt: bytes32(0)
            }),
            ""
        );
        console2.log("Native LP seeded");
        router.swap{value: 0.0005 ether}(
            ethKey,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(0.0005 ether),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(human)
        );
        console2.log("Native swap done. buybackPool:", hook.buybackPool());

        (uint256 bb, uint256 vp,,) = hook.getPoolState();
        console2.log("FINAL buybackPool:", bb);
        console2.log("FINAL victimPool:", vp);

        vm.stopBroadcast();
    }

    function _swap(
        PoolSwapTest router,
        PoolKey memory k,
        address trader,
        bool zeroForOne,
        uint256 amountIn
    ) internal {
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
    }
}
