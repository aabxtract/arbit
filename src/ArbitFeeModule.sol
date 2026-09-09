// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {ArbitRegistry} from "./ArbitRegistry.sol";

/// @title ArbitFeeModule
/// @notice View-only dynamic-fee module for RobinhoodNativeFeeHookV1: maps the
/// registry's participant tiers to a capped LP-fee override. Called by the
/// kernel via STATICCALL — this contract must NEVER write state (the kernel
/// reverts nonzero custom deltas and ignores state effects).
/// @dev Bot patterns are keeper-poked (see ArbitRegistry.poke): the module
/// reads last-written data with one tx of lag. Unpoked traders price as the
/// registry already classifies them (fresh pattern = HUMAN).
/// Selectors intentionally match IRobinhoodNativeFeeModuleV1
/// (beforeSwap(address,PoolKey,SwapParams,bytes),
/// afterSwap(address,PoolKey,SwapParams,BalanceDelta,bytes)).
contract ArbitFeeModule {
    ArbitRegistry public immutable registry;
    /// @notice Informational: the kernel authorized to staticcall this module.
    address public immutable kernel;
    /// @notice Module-side cap (bps). The kernel ALSO enforces
    /// maxModuleLpFeePips on its side — defense in depth, both must allow BOT.
    uint256 public constant MAX_MODULE_FEE_BPS = 100;

    constructor(address _registry, address _kernel) {
        require(_registry != address(0) && _kernel != address(0), "Zero address");
        registry = ArbitRegistry(_registry);
        kernel = _kernel;
    }

    function beforeSwap(
        address sender,
        PoolKey calldata,
        SwapParams calldata,
        bytes calldata hookData
    ) external view returns (bytes4, BeforeSwapDelta, uint24) {
        address trader = hookData.length == 32 ? abi.decode(hookData, (address)) : sender;
        (uint256 feeBps,) = registry.previewFee(trader, tx.gasprice);
        if (feeBps > MAX_MODULE_FEE_BPS) feeBps = MAX_MODULE_FEE_BPS;

        // bps → v4 fee units + override flag (Hooks.sol:261-263 pattern)
        uint24 fee = uint24(feeBps * 100) | LPFeeLibrary.OVERRIDE_FEE_FLAG;
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee);
    }

    function afterSwap(
        address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata
    ) external view returns (bytes4, int128) {
        // Zero custom deltas — the kernel rejects anything else.
        return (this.afterSwap.selector, 0);
    }
}
