// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ArbitRegistry} from "./ArbitRegistry.sol";

/// @title ArbitAgentExecutor
/// @notice Optional per-agent identity: its address is the `sender` the hook
/// sees, earning the agent fee tier. Routers can alternatively pass the user
/// as 32-byte hookData (see ArbitHook._trader). MVP: ERC20 x ERC20 pools only.
contract ArbitAgentExecutor is IUnlockCallback {
    using SafeERC20 for IERC20;
    IPoolManager public immutable manager;
    ArbitRegistry public immutable registry;
    address public immutable agent; // controlling EOA

    event SwapBlocked(address indexed executor, bytes revertData);
    event SwapExecuted(address indexed executor, uint256 amountIn);

    error Unauthorized();

    modifier onlyAgent() {
        if (msg.sender != agent) revert Unauthorized();
        _;
    }

    constructor(IPoolManager _manager, ArbitRegistry _registry) {
        manager = _manager;
        registry = _registry;
        agent = msg.sender;
    }

    // ---- Registration: the executor registers ITSELF as the agent identity ----

    function register(uint256 stakeAmount) external onlyAgent {
        IERC20(registry.arbitToken()).safeTransferFrom(agent, address(this), stakeAmount);
        IERC20(registry.arbitToken()).forceApprove(address(registry), stakeAmount);
        registry.register(stakeAmount);
    }

    // ---- Swaps ----

    function swapExactInputSingle(
        PoolKey calldata key,
        bool zeroForOne,
        uint256 amountIn,
        bytes calldata hookData
    ) external onlyAgent {
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        // Executor pulls input tokens from the agent up front (approve first).
        // If the swap gets blocked, the tokens stay here — recover with rescue().
        IERC20(Currency.unwrap(input)).safeTransferFrom(agent, address(this), amountIn);
        manager.unlock(abi.encodeCall(this._doSwap, (key, zeroForOne, amountIn, hookData)));
    }

    /// @notice Called by PoolManager after unlock() — self-dispatches so _doSwap can
    /// catch the hook's revert without unwinding the whole transaction.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert Unauthorized();
        (bool success, bytes memory returnData) = address(this).call(data);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(returnData, 32), mload(returnData))
            }
        }
        return returnData;
    }

    function _doSwap(PoolKey calldata key, bool zeroForOne, uint256 amountIn, bytes calldata hookData) external {
        if (msg.sender != address(this)) revert Unauthorized();

        try manager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn), // exact input
                // "no limit": widest valid band for this direction
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            hookData
        ) returns (BalanceDelta delta) {
            _settle(key, delta);
            emit SwapExecuted(address(this), amountIn);
        } catch (bytes memory revertData) {
            // Hook blocked the swap (e.g. unauthorized pool). Catching keeps the
            // top-level frame alive and pulled input tokens recoverable via rescue().
            emit SwapBlocked(address(this), revertData);
        }
    }

    function _settle(PoolKey calldata key, BalanceDelta delta) private {
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        if (d0 < 0) _pay(key.currency0, uint128(uint256(-int256(d0))));
        else if (d0 > 0) manager.take(key.currency0, address(this), uint256(int256(d0)));
        if (d1 < 0) _pay(key.currency1, uint128(uint256(-int256(d1))));
        else if (d1 > 0) manager.take(key.currency1, address(this), uint256(int256(d1)));
    }

    function _pay(Currency currency, uint128 amount) private {
        if (currency.isAddressZero()) {
            manager.settle{value: amount}();
        } else {
            manager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransfer(address(manager), amount);
            manager.settle();
        }
    }

    // ---- Recovery ----

    function rescue(Currency currency, uint256 amount) external onlyAgent {
        if (currency.isAddressZero()) {
            (bool ok, ) = agent.call{value: amount}("");
            require(ok, "Arbit: ETH transfer failed");
        } else {
            IERC20(Currency.unwrap(currency)).safeTransfer(agent, amount);
        }
    }
}
