// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import "./ArbitRegistry.sol";
import "./ArbitBadge.sol";

/// @title ArbitHook
/// @notice Uniswap v4 dynamic-fee hook: every swap is priced by participant
/// type, fees accrue to buyback/victim buckets, and buyback fires under a
/// cooldown + threshold guard. Spec: arbit-final-build-guide.md.
/// @dev Implements IHooks directly — pinned v4-periphery has no BaseHook.
/// Pool MUST be created with fee = LPFeeLibrary.DYNAMIC_FEE_FLAG or the
/// beforeSwap fee return is silently ignored (Hooks.sol:263).
/// Accounting is backed by the hook's real ARBT balance: owner MUST pre-fund
/// the hook or rewards / victim payouts / burns revert. Standard ERC-20 only.
contract ArbitHook is IHooks, ReentrancyGuard, Ownable {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    ArbitRegistry public immutable registry;
    address public immutable arbitToken;
    IPoolManager public immutable poolManager;
    /// @notice Badge passes (holder perk). Set post-launch by owner — claims
    /// are pull-based so no in-launch wiring is needed (unlike setHook).
    ArbitBadge public badge;
    bool private badgeSet;
    /// @notice Chain this deployment is bound to (pack: 4663). Mirrors the
    /// kernel's deployment-chain check; pack also binds the canonical
    /// PoolManager runtime hash, which is the real cross-chain protection.
    uint256 public immutable chainId;

    // ── Buyback Guard ──────────────────────────────────────────────
    // Prevents spam triggering and flash loan manipulation.
    // Flash loans repay in same tx — cooldown makes them useless here.
    // TWAP pricing is explicitly post-hackathon: no oracle dependency in MVP.
    uint256 public lastBuybackTime;
    uint256 public buybackPool; // accumulated fee units for buyback
    uint256 public victimPool; // accumulated fee units for victim compensation
    uint256 public constant BUYBACK_COOLDOWN = 1 hours; // min time between buybacks
    uint256 public constant MIN_BUYBACK_AMOUNT = 0.05e18; // ARBT units — retune per deployment

    // Fee split constants
    uint256 public constant LP_SHARE = 80; // 80% of human fee to LPs
    uint256 public constant BUYBACK_SHARE = 20; // 20% of human fee to buyback
    uint256 public constant VICTIM_SHARE = 60; // 60% of bot tax to victims
    uint256 public constant BOT_BUYBACK = 40; // 40% of bot tax to buyback+burn

    // ── Stock-pool edge ──────────────────────────────────────────────
    // Tokenized-stock pools (AAPL/USDG, TSLA/USDG…) accrue buyback 1.5x and
    // charge 2/3 fees: more burn pressure where stock trading is active,
    // lower tolls to attract that flow. Keyed by PoolId (same as allowlist).
    // NOTE: the multiplier accelerates the SHARED backing schedule — it does
    // not create funds. Stock flow drains the hook's ARBT balance faster.
    mapping(PoolId => bool) public isStockPool;
    uint256 public constant STOCK_MULTIPLIER = 150; // 1.5x = 150/100
    uint256 public constant STOCK_FEE_NUM = 2; // stock fee = base * 2/3
    uint256 public constant STOCK_FEE_DEN = 3; // (30→20, 15→10, 5→3, 100→66)

    // Pending rewards for agents — claimed separately (pull pattern)
    mapping(address => uint256) public pendingRewards;

    // Single-classify cache: beforeSwap result reused by afterSwap, then cleared.
    // Both base and charged fees are cached: charged (discounted) is what the
    // trader paid (override, events); base is what stock accruals use (subsidy).
    mapping(bytes32 => uint256) private pendingFeeBps;
    mapping(bytes32 => uint256) private pendingBaseFeeBps;
    mapping(bytes32 => ArbitRegistry.ParticipantType) private pendingType;
    mapping(bytes32 => address) private pendingTrader;

    event FeeCollected(address swapper, uint256 feeBps, ArbitRegistry.ParticipantType pType);
    event BuybackExecuted(uint256 amount, uint256 timestamp);
    event AgentRewarded(address agent, uint256 amount);
    event VictimCompensated(address victim, uint256 amount);
    event StockPoolSet(PoolId indexed poolId, bool isStock);
    event StockMultiplierApplied(
        PoolId indexed poolId, address indexed trader, uint256 originalAmount, uint256 multipliedAmount
    );

    error PoolManagerOnly();
    error Unimplemented();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert PoolManagerOnly();
        _;
    }

    constructor(
        IPoolManager _poolManager,
        address _registry,
        address _arbitToken,
        address _owner,
        uint256 _chainId
    ) Ownable(_owner) {
        require(
            address(_poolManager) != address(0) && _registry != address(0)
                && _arbitToken != address(0) && _owner != address(0),
            "Zero address"
        );
        require(block.chainid == _chainId, "Wrong chain");
        poolManager = _poolManager;
        chainId = _chainId;
        registry = ArbitRegistry(_registry);
        arbitToken = _arbitToken;
        lastBuybackTime = block.timestamp;
        // Fails fast if the CREATE2 address does not carry exactly our permission bits
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false, // not modifying swap amounts
            afterSwapReturnDelta: false, // not modifying swap amounts
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @notice Point the hook at the badge contract. Owner only, set once.
    function setBadge(address _badge) external onlyOwner {
        require(!badgeSet, "Badge already set");
        require(_badge != address(0), "Zero address");
        badge = ArbitBadge(_badge);
        badgeSet = true;
    }

    /// @notice Claim the badge tier your reputation earned. Pull-based:
    /// no per-swap writes, qualification reads existing registry state.
    function claimBadge(ArbitBadge.Tier tier) external nonReentrant {
        require(address(badge) != address(0), "Badge not set");
        ArbitRegistry.Agent memory a = registry.getAgent(msg.sender);
        require(a.active, "Not a registered agent");
        if (tier == ArbitBadge.Tier.Silver) require(a.reputationScore >= 500, "Need 500 rep");
        if (tier == ArbitBadge.Tier.Gold) require(a.reputationScore >= 800, "Need 800 rep");
        // Bronze: registration alone suffices
        badge.mint(msg.sender, tier);
    }

    /// @notice Mark/unmark a pool as a stock pool. Owner only. The multiplier
    /// itself is an immutable constant (no mutable fee controls).
    function setStockPool(PoolId poolId, bool isStock) external onlyOwner {
        isStockPool[poolId] = isStock;
        emit StockPoolSet(poolId, isStock);
    }

    /// @notice Resolve the effective trader.
    /// @dev `sender` is whoever called PoolManager.swap — normally the shared
    /// router/unlocker (Hooks.sol:256), NOT the EOA. Routers MUST pass the real
    /// user as 32-byte hookData; bare EOAs / executors pass empty hookData and
    /// fall back to `sender`. NEVER use tx.origin (phishing vector).
    function _trader(address sender, bytes calldata hookData)
        internal
        pure
        returns (address)
    {
        if (hookData.length == 32) return abi.decode(hookData, (address));
        return sender;
    }

    function _pendingSlot(PoolKey calldata key, address sender)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(key.toId(), sender));
    }

    /// @notice Classify ONCE + return dynamic fee override. O(1), no loops.
    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata,
        bytes calldata hookData
    )
        external
        override
        onlyPoolManager
        nonReentrant
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        // Single allowlist source is the registry (PoolId typed).
        PoolId poolId = key.toId();
        require(registry.allowedPools(poolId), "Arbit: unauthorized pool");

        address trader = _trader(sender, hookData);

        // Single classify per swap — cached for afterSwap.
        (uint256 baseFeeBps, ArbitRegistry.ParticipantType pType) =
            registry.classify(trader, tx.gasprice);
        // Stock-pool discount: lower tolls to attract stock flow (30→20, 15→10, 5→3, 100→66).
        // Accruals still use the BASE fee (1.5x subsidy — see afterSwap), so the
        // cached charged fee exists only for the override + event honesty.
        uint256 feeBps = isStockPool[poolId]
            ? (baseFeeBps * STOCK_FEE_NUM) / STOCK_FEE_DEN
            : baseFeeBps;
        // Badge-holder perk: one extra halving (HIGH 5→2, HUMAN 30→15).
        // One read-only balanceOf — O(1), no state touched.
        if (address(badge) != address(0) && badge.balanceOf(trader) > 0) feeBps /= 2;
        require(feeBps <= registry.MAX_FEE_BPS(), "Arbit: fee exceeds cap");

        bytes32 slot = _pendingSlot(key, sender);
        pendingFeeBps[slot] = feeBps;
        pendingBaseFeeBps[slot] = baseFeeBps;
        pendingType[slot] = pType;
        pendingTrader[slot] = trader;

        // bps → v4 fee units (hundredths of a bip) + override flag.
        // Flag REQUIRED or PoolManager ignores the return (Hooks.sol:261-263).
        uint24 feeOverride = uint24(feeBps * 100) | LPFeeLibrary.OVERRIDE_FEE_FLAG;

        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, feeOverride);
    }

    /// @notice Reuse the beforeSwap classification — never re-classify here.
    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external override onlyPoolManager nonReentrant returns (bytes4, int128) {
        bytes32 slot = _pendingSlot(key, sender);
        uint256 feeBps = pendingFeeBps[slot]; // charged (discounted on stock pools)
        uint256 baseFeeBps = pendingBaseFeeBps[slot]; // pre-discount base
        ArbitRegistry.ParticipantType pType = pendingType[slot];
        address trader = pendingTrader[slot];

        // EFFECT — clear callback state first (isolate callback state).
        delete pendingFeeBps[slot];
        delete pendingBaseFeeBps[slot];
        delete pendingType[slot];
        delete pendingTrader[slot];

        if (trader == address(0)) return (IHooks.afterSwap.selector, 0);

        // Accruals use the BASE fee: on stock pools this is a 1.5x subsidy
        // (discounted collection, boosted accrual) drawn from shared backing.
        // Fee is measured on the INPUT leg: token0 when zeroForOne, else token1.
        // (Audit Sep 7: previously always amount0 — under/over-counted one direction.)
        uint256 feeAmount = _extractFeeAmount(delta, baseFeeBps, params.zeroForOne);
        if (feeAmount == 0) return (IHooks.afterSwap.selector, 0);

        // ── Asset flows based on participant type ──
        if (pType == ArbitRegistry.ParticipantType.HUMAN) {
            // 80% to LPs (handled by PoolManager), 20% to buyback pool
            uint256 buybackContrib = (feeAmount * BUYBACK_SHARE) / 100;
            buybackContrib = _applyStockBoost(key, trader, buybackContrib);

            // EFFECT — update state before any external interaction
            buybackPool += buybackContrib;
        } else if (
            pType == ArbitRegistry.ParticipantType.AGENT_HIGH
                || pType == ArbitRegistry.ParticipantType.AGENT_MED
                || pType == ArbitRegistry.ParticipantType.AGENT_LOW
        ) {
            // Agent reward — portion of fee returned as Arbit tokens
            uint256 rewardAmount = _calculateAgentReward(feeAmount, pType);
            // Stock edge applies BEFORE the backing cap (cap still protects solvency)
            rewardAmount = _applyStockBoost(key, trader, rewardAmount);

            // EFFECT — queue reward, capped by the hook's real ARBT balance
            // (minus victim earmark) so pendingRewards never promises what
            // claimReward cannot pay.
            uint256 hookBal = IERC20(arbitToken).balanceOf(address(this));
            uint256 maxNew = hookBal > victimPool ? hookBal - victimPool : 0;
            if (pendingRewards[trader] + rewardAmount > maxNew) {
                rewardAmount =
                    maxNew > pendingRewards[trader] ? maxNew - pendingRewards[trader] : 0;
            }
            pendingRewards[trader] += rewardAmount;
            registry.reward(trader);

            emit AgentRewarded(trader, rewardAmount);
        } else {
            // Bot — 60% victim pool, 40% buyback + burn
            uint256 victimContrib = (feeAmount * VICTIM_SHARE) / 100;
            uint256 buybackContrib = feeAmount - victimContrib;
            victimContrib = _applyStockBoost(key, trader, victimContrib);
            buybackContrib = _applyStockBoost(key, trader, buybackContrib);

            // EFFECT — update state before any external interaction
            victimPool += victimContrib;
            buybackPool += buybackContrib;
        }

        // ── Buyback Guard ───────────────────────────────────────────
        // Fires only when threshold + cooldown hold AND the hook holds ARBT.
        if (
            buybackPool >= MIN_BUYBACK_AMOUNT
                && block.timestamp >= lastBuybackTime + BUYBACK_COOLDOWN
        ) {
            _executeBuyback();
        }

        emit FeeCollected(trader, feeBps, pType);
        return (IHooks.afterSwap.selector, 0);
    }

    /// @notice Burn ARBT the hook actually holds, capped by balance. No
    /// PoolManager swap in MVP — no oracle/TWAP dependency by design.
    function _executeBuyback() internal {
        uint256 held = IERC20(arbitToken).balanceOf(address(this));
        uint256 amount = buybackPool > held ? held : buybackPool;
        if (amount == 0) return;

        // EFFECT — update before any external call
        buybackPool = amount == buybackPool ? 0 : buybackPool - amount;
        lastBuybackTime = block.timestamp;

        // INTERACTION — burn to dead address
        IERC20(arbitToken).safeTransfer(address(0xdead), amount);

        emit BuybackExecuted(amount, block.timestamp);
    }

    /// @notice Agents pull rewards — push pattern avoided (reentrancy risk).
    function claimReward() external nonReentrant {
        uint256 reward = pendingRewards[msg.sender];
        require(reward > 0, "No pending reward");

        // EFFECT — zero before transfer
        pendingRewards[msg.sender] = 0;

        // INTERACTION
        IERC20(arbitToken).safeTransfer(msg.sender, reward);
    }

    /// @notice Owner-triggered victim payouts from the victim pool.
    function compensateVictim(address victim, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        require(amount <= victimPool, "Insufficient victim pool");
        require(victim != address(0), "Zero address");

        // EFFECT — deduct before transfer
        victimPool -= amount;

        // INTERACTION
        IERC20(arbitToken).safeTransfer(victim, amount);

        emit VictimCompensated(victim, amount);
    }

    /// @notice 1.5x accrual boost on stock pools. Pure math, no state reads
    /// beyond the flag — O(1). Boosting changes the burn SCHEDULE, not the
    /// backing: burns/claims stay capped by the real ARBT balance.
    function _applyStockBoost(PoolKey calldata key, address trader, uint256 amount)
        internal
        returns (uint256)
    {
        PoolId poolId = key.toId();
        if (!isStockPool[poolId] || amount == 0) return amount;
        uint256 boosted = (amount * STOCK_MULTIPLIER) / 100;
        emit StockMultiplierApplied(poolId, trader, amount, boosted);
        return boosted;
    }

    // ── Helpers ──
    function _extractFeeAmount(BalanceDelta delta, uint256 feeBps, bool zeroForOne)
        internal
        pure
        returns (uint256)
    {
        int128 amount = zeroForOne ? delta.amount0() : delta.amount1();
        if (amount < 0) amount = -amount;
        return (uint256(uint128(amount)) * feeBps) / 10000;
    }

    function _calculateAgentReward(
        uint256 feeAmount,
        ArbitRegistry.ParticipantType pType
    ) internal pure returns (uint256) {
        // High rep agents get more of their fee back as tokens
        if (pType == ArbitRegistry.ParticipantType.AGENT_HIGH) return feeAmount / 2; // 50% back
        if (pType == ArbitRegistry.ParticipantType.AGENT_MED) return feeAmount / 4; // 25% back
        return 0; // low rep agents get nothing back
    }

    // View pool state
    function getPoolState()
        external
        view
        returns (
            uint256 _buybackPool,
            uint256 _victimPool,
            uint256 _lastBuybackTime,
            uint256 _nextBuybackEligible
        )
    {
        return (buybackPool, victimPool, lastBuybackTime, lastBuybackTime + BUYBACK_COOLDOWN);
    }

    // ---- Unused callbacks: permission bits are off, PoolManager never calls
    // these. They revert loudly in case the address bits are ever wrong. ----

    function beforeInitialize(address, PoolKey calldata, uint160)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        revert Unimplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        revert Unimplemented();
    }

    function beforeAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4) {
        revert Unimplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, BalanceDelta) {
        revert Unimplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4) {
        revert Unimplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, BalanceDelta) {
        revert Unimplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        revert Unimplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        revert Unimplemented();
    }
}
