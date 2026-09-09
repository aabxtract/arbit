// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TestERC20} from "v4-core/src/test/TestERC20.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";
import {ArbitFeeModule} from "../src/ArbitFeeModule.sol";

/// @notice Offline unit tests: the view-only module maps registry tiers to
/// capped fee overrides with zero deltas. Never touches a PoolManager.
contract ModuleTest is Test {
    ArbitRegistry registry;
    ArbitFeeModule module;
    TestERC20 arbt;

    function setUp() public {
        arbt = new TestERC20(1e30);
        registry = new ArbitRegistry(address(arbt), address(0), address(this));
        module = new ArbitFeeModule(address(registry));
    }

    function _key() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(arbt)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
    }

    function _params() internal pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(10e18),
            sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
        });
    }

    function test_HumanOverride() public {
        (, , uint24 fee) =
            module.beforeSwap(address(this), _key(), _params(), abi.encode(makeAddr("human")));
        assertEq(fee, uint24(3000) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function test_AgentMedOverride() public {
        address agent = makeAddr("agent");
        arbt.transfer(agent, 100e18);
        vm.startPrank(agent);
        arbt.approve(address(registry), 100e18);
        registry.register(100e18); // 500 rep → MED → 15 bps
        vm.stopPrank();
        (, , uint24 fee) = module.beforeSwap(address(this), _key(), _params(), abi.encode(agent));
        assertEq(fee, uint24(1500) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function test_BotOverrideAfterPokes() public {
        address bot = makeAddr("bot");
        registry.poke(bot, 1 gwei);
        vm.roll(block.number + 1);
        registry.poke(bot, 1 gwei);
        vm.roll(block.number + 1);
        registry.poke(bot, 1 gwei);
        vm.roll(block.number + 1);
        (, , uint24 fee) = module.beforeSwap(address(this), _key(), _params(), abi.encode(bot));
        assertEq(fee, uint24(10000) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function test_AfterSwapZeroDelta() public view {
        (bytes4 sel, int128 delta) = module.afterSwap(
            address(this), _key(), _params(), BalanceDeltaLibrary.ZERO_DELTA, ""
        );
        assertEq(sel, module.afterSwap.selector);
        assertEq(delta, 0);
    }

    function test_SenderFallbackIdentity() public {
        // Empty hookData → sender is the trader (executor-style direct callers)
        (,, uint24 fee) = module.beforeSwap(makeAddr("router"), _key(), _params(), "");
        assertEq(fee, uint24(3000) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}
