// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TestERC20} from "v4-core/src/test/TestERC20.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";
import {ArbitHook} from "../src/ArbitHook.sol";

/// @notice Debug harness: replays the failing testnet swap on a testnet fork.
/// forge test --match-test test_DebugTestnetSwap -vvvv
contract TestnetDebugTest is Test {
    IPoolManager constant MANAGER = IPoolManager(0x38d13B77728c357652313AA0a6fc97229F44CD8E);
    ArbitRegistry constant REGISTRY = ArbitRegistry(0x07f0118fe19c003D7AE90C7D43b4d1D3985eCa9b);
    ArbitHook constant HOOK = ArbitHook(0xb099980588E1458D678E5bdfe048A37f910A40C0);
    TestERC20 constant ARBT = TestERC20(0xd2cAA129a525D65684C112b074425E8d85a71533);
    TestERC20 constant PAIR = TestERC20(0xaFba1911E461470F9ffc50dBB3177c6bC5e0715e);

    function test_DebugTestnetSwap() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true, "set RUN_FORK_TESTS=1 to run network fork tests");
            return;
        }
        vm.createSelectFork("https://rpc.testnet.chain.robinhood.com");
        (Currency c0, Currency c1) = address(ARBT) < address(PAIR)
            ? (Currency.wrap(address(ARBT)), Currency.wrap(address(PAIR)))
            : (Currency.wrap(address(PAIR)), Currency.wrap(address(ARBT)));
        PoolKey memory k = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(HOOK))
        });
        console2.log("allowed:", REGISTRY.allowedPools(k.toId()));
        (uint256 fee,) = REGISTRY.previewFee(address(1), 1 gwei);
        console2.log("preview fee:", fee);

        PoolSwapTest router = new PoolSwapTest(MANAGER);
        ARBT.approve(address(router), type(uint256).max);
        PAIR.approve(address(router), type(uint256).max);
        router.swap(
            k,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(10e18),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(address(1))
        );
        console2.log("buyback:", HOOK.buybackPool());
    }
}
