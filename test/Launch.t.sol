// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {StateView} from "v4-periphery/src/lens/StateView.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";
import {ArbitHook} from "../src/ArbitHook.sol";
import {ArbitToken} from "../src/ArbitToken.sol";
import {ArbitInitializer} from "../src/ArbitInitializer.sol";

/// @notice End-to-end 4.1-style launch on anvil: token + registry + hook +
/// initializer graph, atomic first buy, locked LP, live hook on a NATIVE pool.
contract LaunchTest is Test {
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    IPoolManager manager;
    ArbitToken arbt;
    ArbitRegistry registry;
    ArbitHook hook;
    ArbitInitializer initializer;
    PoolKey key;
    PoolSwapTest router;

    address wallet = address(this);

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.deal(wallet, 100 ether);
        manager = new PoolManager(address(this));
        arbt = new ArbitToken(wallet);
        initializer = new ArbitInitializer(manager, wallet, block.chainid); // wallet plays graphFactory
        registry = new ArbitRegistry(address(arbt), address(initializer), wallet);

        (address hookAddress, bytes32 salt) = HookMiner.find(
            address(this),
            uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG),
            type(ArbitHook).creationCode,
            abi.encode(address(manager), address(registry), address(arbt), wallet, block.chainid)
        );
        hook = new ArbitHook{salt: salt}(
            manager, address(registry), address(arbt), wallet, block.chainid
        );
        require(address(hook) == hookAddress, "hook address mismatch");

        router = new PoolSwapTest(manager);
        arbt.approve(address(router), type(uint256).max);
    }

    function test_FullLaunchFlow() public {
        // Wallet approves the initializer for the ARBT legs pre-launch
        arbt.approve(address(initializer), type(uint256).max);

        uint256 hookFund = 100_000e18;
        uint256 buyValue = 1 ether;

        vm.expectEmit(false, true, false, false, address(initializer));
        emit ArbitInitializer.LaunchInitialized(PoolId.wrap(bytes32(0)), wallet, hookFund, 0);
        initializer.initialize{value: buyValue + 5 ether}(
            ArbitInitializer.LaunchArgs({
                registry: registry,
                hook: address(hook),
                token: address(arbt),
                wallet: wallet,
                hookFund: hookFund,
                seedAmount: 2_000_000e18,
                buyAmount: buyValue,
                fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
                tickSpacing: 60,
                sqrtPrice: SQRT_PRICE_1_1,
                tickLower: -600,
                tickUpper: 600,
                liquidityDelta: 1e20, // needs ~3 ETH + ~3e18 ARBT at 1:1
                minTokensOut: 1
            })
        );
        // (poolId/token/buyOut not asserted on the event — wiring below is the proof)

        // Registry wired in-launch (owner EOA could NOT have done this atomically)
        assertEq(registry.hook(), address(hook));

        // Pool live on the manager with our hook + dynamic fee
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(arbt)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        assertTrue(registry.allowedPools(key.toId()));
        PoolKey memory km = key; // storage → memory for toId()
        (uint160 price,,,) = new StateView(manager).getSlot0(km.toId());
        // First buy moved the price down from the 1:1 start — pool is live
        assertGt(price, 0);
        assertLt(price, SQRT_PRICE_1_1);

        // Hook funded, wallet bought ARBT atomically
        assertGe(arbt.balanceOf(address(hook)), hookFund);
        assertGt(arbt.balanceOf(wallet), 0);

        // Hook is live on the native pool: human swap accrues buyback
        address human = makeAddr("launch-human");
        uint256 before = hook.buybackPool();
        router.swap{value: 0.5 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(0.5 ether),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(human)
        );
        assertGt(hook.buybackPool(), before);
    }

    function test_InitializeOnceAndAuth() public {
        arbt.approve(address(initializer), type(uint256).max);
        ArbitInitializer.LaunchArgs memory a = ArbitInitializer.LaunchArgs({
            registry: registry,
            hook: address(hook),
            token: address(arbt),
            wallet: wallet,
            hookFund: 1000e18,
            seedAmount: 10000e18,
            buyAmount: 0.1 ether,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            sqrtPrice: SQRT_PRICE_1_1,
            tickLower: -600,
            tickUpper: 600,
            liquidityDelta: 1e19, // needs ~0.3 ETH at 1:1
            minTokensOut: 1
        });
        initializer.initialize{value: 0.5 ether}(a);
        vm.expectRevert(ArbitInitializer.AlreadyInitialized.selector);
        initializer.initialize{value: 0.5 ether}(a);

        // Auth gate on a fresh instance (funded stranger, exact revert)
        ArbitInitializer init2 = new ArbitInitializer(manager, wallet, block.chainid);
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(ArbitInitializer.Unauthorized.selector);
        init2.initialize{value: 0.5 ether}(a);
    }

    receive() external payable {}
}
