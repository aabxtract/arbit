// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUnlockCallback} from "../lib/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPoolManager} from "../lib/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "../lib/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "../lib/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "../lib/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "../lib/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "../lib/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "../lib/v4-core/src/libraries/TickMath.sol";
import {IHooks} from "../lib/v4-core/src/interfaces/IHooks.sol";
import {ArbitRegistry} from "./ArbitRegistry.sol";

/// @title ArbitInitializer
/// @notice One-shot launch initializer (graph target). Atomically: funds the
/// hook, wires registry (setHook + allowPool — the owner EOA cannot act
/// in-launch), initializes the ARBT/ETH pool, seeds a PERMANENTLY LOCKED
/// token-side position (no withdraw path — like the native20 seed recipe),
/// and executes the atomic first buy to the launch wallet.
/// @dev Leftover seed ARBT (position sizing dust) is swept into the hook's
/// buyback pot — nothing sits idle. ETH input that isn't the buy reverts
/// (exact value accounting, no partial fills).
contract ArbitInitializer is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    IPoolManager public immutable manager;
    address public immutable graphFactory;
    address public immutable wallet; // sole ARBT source + ETH-dust + buy recipient
    uint256 public immutable chainId;
    bool public initialized;

    event LaunchInitialized(
        PoolId indexed poolId, address indexed wallet, uint256 hookFund, uint256 buyOut
    );

    error Unauthorized();
    error AlreadyInitialized();
    error BadValue();
    error InsufficientBuyOutput();

    modifier onlyGraphFactory() {
        if (msg.sender != graphFactory) revert Unauthorized();
        _;
    }

    constructor(IPoolManager _manager, address _graphFactory, address _wallet, uint256 _chainId) {
        require(
            address(_manager) != address(0) && _graphFactory != address(0) && _wallet != address(0),
            "Zero"
        );
        require(block.chainid == _chainId, "Wrong chain");
        manager = _manager;
        graphFactory = _graphFactory;
        wallet = _wallet;
        chainId = _chainId;
    }

    struct LaunchArgs {
        ArbitRegistry registry;
        address hook;
        address token;
        uint256 hookFund; // ARBT pulled from wallet into the hook (rewards/victim/burn backing)
        uint256 seedAmount; // ARBT pulled from wallet for the seed position (+dust→hook)
        uint256 buyAmount; // exact first-buy ETH input, ≤ msg.value (rest funds LP dust→wallet)
        uint24 fee; // must be LPFeeLibrary.DYNAMIC_FEE_FLAG for the hook to price
        int24 tickSpacing;
        uint160 sqrtPrice; // start price (inside the seed range)
        int24 tickLower;
        int24 tickUpper;
        int128 liquidityDelta; // seed position size (ARBT + ETH pulled as needed)
        uint256 minTokensOut; // first-buy slippage guard, to wallet
    }

    /// @notice Executes the full launch. `msg.value` covers the seed ETH leg
    /// plus EXACTLY `buyAmount` for the first buy — anything else reverts.
    /// Wallet must approve ARBT first.
    function initialize(LaunchArgs calldata a) external payable onlyGraphFactory {
        if (initialized) revert AlreadyInitialized();
        if (a.buyAmount == 0 || msg.value < a.buyAmount) revert BadValue();

        // EFFECT FIRST: reentrancy guard before any external call (Slither
        // reentrancy-eth — a malicious wallet receiving the ETH sweep could
        // otherwise reenter; a later revert rolls the flag back atomically).
        initialized = true;

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)), // native ETH
            currency1: Currency.wrap(a.token),
            fee: a.fee,
            tickSpacing: a.tickSpacing,
            hooks: IHooks(a.hook)
        });
        PoolId poolId = key.toId();

        // 1. Pull ARBT (hook fund + seed) — wallet approved pre-launch.
        // Source is the immutable launch wallet: no arbitrary-from.
        IERC20(a.token).safeTransferFrom(wallet, address(this), a.hookFund + a.seedAmount);
        IERC20(a.token).safeTransfer(a.hook, a.hookFund);

        // 2. Wire registry in-launch (owner EOA cannot do this atomically)
        a.registry.setHook(a.hook);
        a.registry.allowPool(poolId);

        // 3. Initialize pool + seed locked position (owned by this contract forever)
        manager.initialize(key, a.sqrtPrice);
        manager.unlock(
            abi.encodeCall(this._addLiquidity, (key, a.tickLower, a.tickUpper, a.liquidityDelta))
        );

        // 4. Sweep leftovers: ARBT dust → hook buyback pot, ETH dust → wallet.
        // (msg.value's buyAmount is excluded from the ETH sweep.)
        uint256 dust = IERC20(a.token).balanceOf(address(this));
        if (dust > 0) IERC20(a.token).safeTransfer(a.hook, dust);
        uint256 ethDust = address(this).balance - a.buyAmount;
        if (ethDust > 0) {
            (bool ok,) = wallet.call{value: ethDust}("");
            require(ok, "ETH sweep failed");
        }

        // 5. Atomic first buy: exact buyAmount ETH in → ARBT out to wallet
        uint256 bought = abi.decode(
            manager.unlock(abi.encodeCall(this._buy, (key, a.buyAmount, wallet))),
            (uint256)
        );
        if (bought < a.minTokensOut) revert InsufficientBuyOutput();

        emit LaunchInitialized(poolId, wallet, a.hookFund, bought);
    }

    function _addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int128 delta)
        external
        returns (bytes memory)
    {
        if (msg.sender != address(this)) revert Unauthorized();
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
        return "";
    }

    function _buy(PoolKey calldata key, uint256 amountIn, address to)
        external
        returns (bytes memory)
    {
        if (msg.sender != address(this)) revert Unauthorized();
        BalanceDelta d = manager.swap(
            key,
            SwapParams({
                zeroForOne: true, // ETH in → ARBT out
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        // Settle ONLY the ETH input leg here; take the ARBT output straight to
        // the wallet (a full _settle would take it to self first — double-take bug).
        int128 d0 = d.amount0();
        if (d0 < 0) manager.settle{value: uint128(uint256(-int256(d0)))}();
        else revert InsufficientBuyOutput();
        int128 out = d.amount1();
        if (out <= 0) revert InsufficientBuyOutput();
        uint256 outAbs = uint256(int256(out));
        manager.take(key.currency1, to, outAbs);
        return abi.encode(outAbs);
    }

    function _settle(PoolKey calldata key, BalanceDelta delta) private {
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        if (d0 < 0) manager.settle{value: uint128(uint256(-int256(d0)))}();
        else if (d0 > 0) manager.take(key.currency0, address(this), uint128(uint256(int256(d0))));
        if (d1 < 0) {
            manager.sync(key.currency1);
            IERC20(Currency.unwrap(key.currency1)).safeTransfer(
                address(manager), uint128(uint256(-int256(d1)))
            );
            manager.settle();
        } else if (d1 > 0) {
            manager.take(key.currency1, address(this), uint128(uint256(int256(d1))));
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert Unauthorized();
        (bool ok, bytes memory ret) = address(this).call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    // Convexity: receive ETH (first-buy value + refunds)
    receive() external payable {}
}
