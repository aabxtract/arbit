// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TestERC20} from "v4-core/src/test/TestERC20.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";
import {ArbitFeeModule} from "../src/ArbitFeeModule.sol";
import {RobinhoodNativeFeeHookV1} from "./vendor/robinhood-fee-v1/RobinhoodNativeFeeHookV1.sol";

/// @notice Minimal unlock router speaking ONLY stable PM interfaces
/// (unlock/modifyLiquidity/swap/settle/take/sync). Periphery test routers
/// drift across v4-core versions; this does not.
contract ForkHelper is IUnlockCallback {
    IPoolManager public immutable manager;

    constructor(IPoolManager _manager) {
        manager = _manager;
    }

    enum Op {
        AddLiquidity,
        Swap
    }

    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int128 delta)
        external
        payable
    {
        manager.unlock(abi.encode(Op.AddLiquidity, key, tickLower, tickUpper, delta));
    }

    function swapExactIn(PoolKey calldata key, uint256 amountIn, bytes memory hookData)
        external
        payable
    {
        manager.unlock(abi.encode(Op.Swap, key, amountIn, hookData));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager));
        (Op op, PoolKey memory key) = abi.decode(data, (Op, PoolKey));
        if (op == Op.AddLiquidity) {
            (,, int24 tickLower, int24 tickUpper, int128 delta) =
                abi.decode(data, (Op, PoolKey, int24, int24, int128));
            (BalanceDelta d,) = manager.modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: tickLower,
                    tickUpper: tickUpper,
                    liquidityDelta: delta,
                    salt: bytes32(0)
                }),
                ""
            );
            _settle(key, d);
        } else {
            (, , uint256 amountIn, bytes memory hookData) =
                abi.decode(data, (Op, PoolKey, uint256, bytes));
            BalanceDelta d = manager.swap(
                key,
                SwapParams({
                    zeroForOne: true,
                    amountSpecified: -int256(amountIn),
                    sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                }),
                hookData
            );
            _settle(key, d);
        }
        return "";
    }

    function _settle(PoolKey memory key, BalanceDelta delta) private {
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        if (d0 < 0) manager.settle{value: uint128(uint256(-int256(d0)))}();
        else if (d0 > 0) manager.take(key.currency0, address(this), uint128(uint256(int256(d0))));
        if (d1 < 0) {
            manager.sync(key.currency1);
            IERC20(Currency.unwrap(key.currency1)).transfer(
                address(manager), uint128(uint256(-int256(d1)))
            );
            manager.settle();
        } else if (d1 > 0) {
            manager.take(key.currency1, address(this), uint128(uint256(int256(d1))));
        }
    }

    receive() external payable {}
}

/// @notice Interop proof: the EXACT reviewed kernel (vendored verbatim) with
/// OUR view-only fee module, on a mainnet fork against the canonical
/// PoolManager. A poked bot must pay ~1% LP fee vs human ~0.3% — the spread
/// lands with LPs through the kernel's accounting.
/// Run: RUN_FORK_TESTS=1 forge test --match-contract KernelTest -vvv
/// (kernel sources pinned to CLI 4.1.0 example tree; see test/vendor/README)
contract KernelTest is Test {
    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    function test_KernelModuleFeeSpread() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true, "set RUN_FORK_TESTS=1 to run network fork tests");
            return;
        }
        vm.createSelectFork(
            vm.envOr("ROBINHOOD_MAINNET_RPC", string("https://rpc.mainnet.chain.robinhood.com"))
        );
        vm.deal(address(this), 100 ether);

        TestERC20 token = new TestERC20(1e30);
        ArbitRegistry registry = new ArbitRegistry(address(token), address(0), address(this));
        ArbitFeeModule module = new ArbitFeeModule(address(registry), address(0xbeef));

        RobinhoodNativeFeeHookV1.PoolConfig memory cfg = RobinhoodNativeFeeHookV1.PoolConfig({
            token: address(token),
            lpFee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            initialSqrtPriceX96: SQRT_PRICE_1_1,
            initializer: address(this),
            creatorFeeRecipient: address(this),
            creatorBuyFeeBps: 30,
            creatorSellFeeBps: 30,
            module: address(module),
            maxModuleLpFeePips: 10000
        });
        (address hookAddress, bytes32 salt) = HookMiner.find(
            address(this),
            uint160(
                Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                    | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            ),
            type(RobinhoodNativeFeeHookV1).creationCode,
            abi.encode(address(MANAGER), cfg)
        );
        RobinhoodNativeFeeHookV1 kernel =
            new RobinhoodNativeFeeHookV1{salt: salt}(MANAGER, cfg);
        require(address(kernel) == hookAddress, "kernel address mismatch");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(kernel))
        });
        MANAGER.initialize(key, SQRT_PRICE_1_1);

        ForkHelper router = new ForkHelper(MANAGER);
        token.approve(address(router), type(uint256).max);
        // Full-range L wei needs ~L wei of ETH at 1:1 (units, not ether!)
        vm.deal(address(this), 200 ether);
        TestERC20(token).transfer(address(router), 55 ether);
        router.addLiquidity{value: 55 ether}(
            key, TickMath.minUsableTick(60), TickMath.maxUsableTick(60), 5e19
        );

        // Human: 30 bps module fee (+ platform/creator kernel fees on top)
        address human = makeAddr("kernel-human");
        uint256 humanOut = _buy(router, key, human, 0.05 ether);

        // Bot: poked 3x → 100 bps module fee
        address bot = makeAddr("kernel-bot");
        registry.poke(bot, 1 gwei);
        vm.roll(block.number + 1);
        registry.poke(bot, 1 gwei);
        vm.roll(block.number + 1);
        registry.poke(bot, 1 gwei);
        vm.roll(block.number + 1);
        uint256 botOut = _buy(router, key, bot, 0.05 ether);

        // Same input, same pool: bot must receive meaningfully less.
        // Fee-implied gap ≈ (1.00% − 0.30%) × 0.05 ETH ≈ 0.00035 ETH, plus
        // one-sided price impact (bot swaps second into a moved price).
        // Bounds keep both effects honest without overfitting either.
        uint256 gap = humanOut - botOut;
        assertLt(botOut, humanOut, "bot not surcharged through kernel");
        assertGe(gap, 0.0003 ether, "fee spread too small");
        assertLe(gap, 0.0009 ether, "fee spread too large");
    }

    function _buy(ForkHelper router, PoolKey memory key, address trader, uint256 amountIn)
        internal
        returns (uint256)
    {
        // Swap output lands on the helper (it settles/takes for itself)
        TestERC20 out = TestERC20(Currency.unwrap(key.currency1));
        uint256 before = out.balanceOf(address(router));
        router.swapExactIn{value: amountIn}(key, amountIn, abi.encode(trader));
        return out.balanceOf(address(router)) - before;
    }
}
