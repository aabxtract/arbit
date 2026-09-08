// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
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
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";
import {ArbitHook} from "../src/ArbitHook.sol";
import {ArbitToken} from "../src/ArbitToken.sol";

/// @notice Compatibility proof: our hook against the CANONICAL mainnet
/// PoolManager (0x8366…) via fork. No key, no funds, read-only + local txs.
/// Run: fork test --match-test ForkMainnet -vvv
/// (needs ROBINHOOD_MAINNET_RPC or default public endpoint)
contract ForkMainnetTest is Test {
    // Canonical v4 deployment on Robinhood mainnet (from capabilities evidence)
    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    function test_ForkCanonicalPoolManager() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true, "set RUN_FORK_TESTS=1 to run network fork tests");
            return;
        }
        vm.createSelectFork(
            vm.envOr(
                "ROBINHOOD_MAINNET_RPC", string("https://rpc.mainnet.chain.robinhood.com")
            )
        );

        // Sanity: canonical PM really is a contract speaking v4 (owner() exists)
        assertGt(address(MANAGER).code.length, 0, "no code at canonical PM");
        (bool ok,) = address(MANAGER).staticcall(abi.encodeWithSignature("owner()"));
        assertTrue(ok, "canonical PM unreachable");

        // Deploy our graph fresh on the fork
        ArbitToken arbt = new ArbitToken(address(this));
        TestERC20 other = new TestERC20(1e30);
        ArbitRegistry registry = new ArbitRegistry(address(arbt), address(0), address(this));

        (address hookAddress, bytes32 salt) = HookMiner.find(
            address(this),
            uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG),
            type(ArbitHook).creationCode,
            abi.encode(address(MANAGER), address(registry), address(arbt), address(this), block.chainid)
        );
        ArbitHook hook = new ArbitHook{salt: salt}(
            MANAGER, address(registry), address(arbt), address(this), block.chainid
        );
        require(address(hook) == hookAddress, "hook address mismatch");
        registry.setHook(address(hook));
        arbt.transfer(address(hook), 1_000_000e18);

        // Sort into a dynamic-fee pool on the CANONICAL manager
        (Currency c0, Currency c1, IERC20 t0, IERC20 t1) = address(arbt) < address(other)
            ? (
                Currency.wrap(address(arbt)),
                Currency.wrap(address(other)),
                IERC20(address(arbt)),
                IERC20(address(other))
            )
            : (
                Currency.wrap(address(other)),
                Currency.wrap(address(arbt)),
                IERC20(address(other)),
                IERC20(address(arbt))
            );
        // NOTE: TestERC20 vs ArbitToken return types differ; normalize via Currency unwrap below.
        PoolKey memory key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        MANAGER.initialize(key, SQRT_PRICE_1_1);
        registry.allowPool(key.toId());

        // Seed liquidity
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(MANAGER);
        t0.approve(address(lp), type(uint256).max);
        t1.approve(address(lp), type(uint256).max);
        // Fund this contract with t1 side if needed (t1 may be `other`, already held)
        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: 1e22,
                salt: bytes32(0)
            }),
            ""
        );

        // Swap as a fresh human via hookData identity on the canonical PM
        PoolSwapTest router = new PoolSwapTest(MANAGER);
        t0.approve(address(router), type(uint256).max);
        t1.approve(address(router), type(uint256).max);
        address human = makeAddr("fork-human");
        router.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(1e18),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(human)
        );

        // The hook priced + accounted the swap on the canonical deployment
        assertGt(hook.buybackPool(), 0, "no buyback accrual on canonical PM");
        (uint256 fee,) = registry.previewFee(human, 1 gwei);
        assertEq(fee, 30, "human tier mispriced on canonical PM");
    }
}
