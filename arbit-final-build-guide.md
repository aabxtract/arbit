# Arbit — Final Build Guide
**Programmable Hookathon | Deadline: Sep 10, 2026 | Prize: $10,000**

> **Status (Sep 7): `forge build` clean, `forge test` 28 pass + 2 fork opt-in (`RUN_FORK_TESTS=1`). LIVE ON ROBINHOOD TESTNET (46630, verified on explorer): mock-ARBT `0xd2cA…1533`, PM `0x38d1…CD8E`, registry `0x07f0…5eCa9b`, hook `0xb099…0A40C0`, all 3 fee flows + native pool confirmed onchain (buyback 47800300000000000, victim 60000000000000000). 4.1 hard-block self-check: every statically-checkable code PASS. Feed: 2 finalized V4 launches (RHCR custom 4.0 + own V4 token). Graph is launch-shaped: token + registry + hook + `ArbitInitializer`. BLOCKING on owner: mainnet API-key flow (key obtained), brand assets, funding decisions, public repo. Server-only remainder: preflight findings, kernel-vs-module confirmation, turnaround time.**

---

## What We're Building

Arbit is a Uniswap v4 hook where every swap directly moves assets based on who you are. The hook IS the asset engine — it collects fees, splits them by participant type, and automatically buys back Arbit token when conditions are met. Every interaction makes the token stronger.

**Three participant flows:**

| Participant | Fee | What happens to assets |
|---|---|---|
| Human trader | 0.30% | 80% → LPs, 20% → buyback pool |
| Registered agent (high rep) | 0.05% | Portion returned as Arbit token reward |
| Unregistered bot | 1.00% | 60% → victim compensation, 40% → buyback + burn |

**Buyback Guard:** Auto-buyback only fires when fee pool ≥ `MIN_BUYBACK_AMOUNT` (ARBT units the hook actually holds — retune per deployment) AND `BUYBACK_COOLDOWN` has elapsed. Prevents spam triggering and flash loan manipulation. TWAP pricing is explicitly post-hackathon — MVP has no oracle dependency by design.

**The demo story:**
> Human trader swaps → 20% of fee flows to buyback pool → Unregistered bot swaps → 1% tax collected → threshold hit + cooldown elapsed → hook executes buyback automatically → Arbit token supply decreases → token appreciates

---

## Development Flow

```
Phase 1 — Robinhood Chain Testnet (chain ID 46630)
  → Write + test all contracts
  → Deploy via Foundry to Robinhood Testnet (faucet: faucet.testnet.chain.robinhood.com)
  → Verify all three fee flows work correctly
  → Verify Buyback Guard fires only when conditions met
  → Verify buyback doesn't fire during flash loan attack

Phase 2 — Robinhood Chain Mainnet (Programmable.market)
  → Pack via programmable-launch CLI
  → Validate remotely
  → Submit + sign
  → Verify on robinhoodchain.blockscout.com
```

---

## Tech Stack

| Layer | Tool |
|---|---|
| Smart contracts | Solidity 0.8.26 (pinned by Programmable CLI) |
| Hook framework | Uniswap v4 `IHooks` implemented directly (pinned `v4-periphery` has no `BaseHook` — `src/base/` contains routers only; `src/hooks/` contains `permissionedPools/` only) |
| Token standard | ERC-20 (`src/ArbitToken.sol` — fixed 1B supply, packed as the graph's `token` target; NOT a separate UI launch) |
| Testing | Foundry (forge test + fuzz + invariant) |
| Static analysis | Slither |
| Testnet | Robinhood Chain Testnet (chain ID 46630, RPC `https://rpc.testnet.chain.robinhood.com`, explorer `explorer.testnet.chain.robinhood.com`) |
| Mainnet deploy | `programmable-launch` CLI → Robinhood Chain (chain ID 4663) |
| Website | Next.js 16 + Tailwind |

---

## Security Guardrails (Non-Negotiable)

Based on real exploits — read before writing code:

| Rule | Why |
|---|---|
| `onlyPoolManager` on ALL hook callbacks | Missing this = Cork Protocol $11M exploit |
| `nonReentrant` on hook + ALL state-changing registry functions | PoolManager lock does NOT protect hook state (ToB 2026) |
| Checks-Effects-Interactions everywhere | Reentrancy prevention — state before transfers |
| Pool allowlist — `PoolId` via `key.toId()`, single source in registry | Cross-pool contamination; anyone can init a pool with your hook |
| Constructor `Hooks.validateHookPermissions()` | Silent no-op / DoS if address bits mismatch declared permissions |
| No return delta flags unless implementing delta modification | Free swap / NoOp-swap vulnerability |
| Dynamic-fee pool (`key.fee == DYNAMIC_FEE_FLAG`) + `fee \| OVERRIDE_FEE_FLAG` | Without both, `beforeSwap` fee return is silently ignored (`Hooks.sol:263`) |
| Fee caps — MAX_FEE_BPS hard limit, validated after mask | Griefing prevention |
| `setHook()` onlyOwner + set-once guard | Registry hijack prevention |
| No loops in `beforeSwap` or `afterSwap` | Must be O(1) — gas griefing prevention (<50k / <30k targets) |
| Classify ONCE in `beforeSwap`, cache, clear in `afterSwap` | Double-classify skews bot counts + splits a different fee than charged |
| Trader identity = `hookData`-decoded user, fallback `sender` | `sender` is the router/unlocker (`Hooks.sol:256`), NOT the EOA — shared routers collapse all users to one address |
| Buyback Guard — cooldown + minimum threshold AND hook token balance | Flash loan + spam prevention; accounting must be backed by real balances |
| Separate buckets (buyback vs victim vs LP) + labeled ownership | Mixed-bucket leaks pass settlement but lose funds (ToB delta-correctness) |
| Standard ERC-20 only (no fee-on-transfer / rebase / callback tokens) | Observed-balance mismatch breaks fee math; block exotic tokens explicitly |
| No `tx.origin`, no `transfer()` for ETH, respect slippage | Phishing / gas / MEV vectors (Uniswap AI security skill) |
| Buyback uses TWAP — POST-HACKATHON (not in MVP) | MVP Guard (cooldown + threshold) only; do NOT claim TWAP until implemented |

---

## Contract Architecture

Three contracts. Clean separation of concerns.

```
ArbitToken (ERC-20)
  - Fixed 1B supply, no mint/tax/pause (`src/ArbitToken.sol`)
  - Deployed BY the Router as the graph's token target — never a separate launch
  - Hook holds tokens for rewards + victim payouts + burn

ArbitRegistry
  - Agent registration + stake
  - Reputation scores (0–1000)
  - Participant classification

ArbitHook (Uniswap v4 IHooks, no BaseHook in pinned periphery)
  - beforeSwap: classify participant, set dynamic fee
  - afterSwap: split fee, accumulate buyback pool
  - executeBuyback: fires when Guard conditions met
  - All asset flows happen here

ArbitInitializer (graph target, one-shot)
  - Atomic: funds hook → setHook + allowPool (owner EOA can't act in-launch)
    → init pool → seed PERMANENTLY LOCKED position → first buy to wallet
  - Leftover ARBT dust → hook buyback pot; ETH dust → wallet; exact accounting
```

---

## Contract 1 — `ArbitRegistry.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

contract ArbitRegistry is Ownable, ReentrancyGuard {

    enum ParticipantType { HUMAN, AGENT_HIGH, AGENT_MED, AGENT_LOW, BOT }

    struct Agent {
        uint256 stakedAmount;
        uint256 reputationScore; // 0–1000, starts 500
        bool active;
    }

    struct BotPattern {
        uint256 lastSwapBlock;
        uint256 swapsInWindow;
        uint256 avgGasPrice;
    }

    mapping(address => Agent) public agents;
    mapping(address => BotPattern) public botPatterns;
    mapping(PoolId => bool) public allowedPools;

    address public arbitToken;
    address public hook;
    bool private hookSet;

    uint256 public constant MIN_STAKE = 100e18;
    uint256 public constant MAX_REPUTATION = 1000;

    // Fee tiers in basis points
    uint256 public constant FEE_HUMAN = 30;        // 0.30%
    uint256 public constant FEE_AGENT_HIGH = 5;    // 0.05%
    uint256 public constant FEE_AGENT_MED = 15;    // 0.15%
    uint256 public constant FEE_AGENT_LOW = 30;    // 0.30%
    uint256 public constant FEE_BOT = 100;         // 1.00%
    uint256 public constant MAX_FEE_BPS = 500;     // hard cap 5%

    event AgentRegistered(address agent, uint256 stake);
    event ReputationUpdated(address agent, uint256 score, bool increased);
    event PoolAllowed(PoolId indexed poolId);

    modifier onlyHook() {
        require(msg.sender == hook, "Only hook");
        _;
    }

    constructor(address _arbitToken) Ownable(msg.sender) {
        arbitToken = _arbitToken;
    }

    function setHook(address _hook) external onlyOwner {
        require(!hookSet, "Hook already set");
        require(_hook != address(0), "Zero address");
        hook = _hook;
        hookSet = true;
    }

    function allowPool(PoolId poolId) external onlyOwner {
        allowedPools[poolId] = true;
        emit PoolAllowed(poolId);
    }

    function register(uint256 stakeAmount) external nonReentrant {
        require(stakeAmount >= MIN_STAKE, "Below minimum stake");
        require(!agents[msg.sender].active, "Already registered");

        // EFFECT first (CEI) — state before any external interaction.
        agents[msg.sender] = Agent({
            stakedAmount: stakeAmount,
            reputationScore: 500,
            active: true
        });

        // INTERACTION last. NOTE: standard ERC-20 only — fee-on-transfer /
        // rebase / callback tokens are unsupported and will break accounting.
        IERC20(arbitToken).transferFrom(msg.sender, address(this), stakeAmount);

        emit AgentRegistered(msg.sender, stakeAmount);
    }

    // View-only fee preview — safe to call anywhere, changes nothing.
    function previewFee(
        address swapper,
        uint256 gasPrice
    ) external view returns (uint256 feeBps, ParticipantType pType) {
        Agent storage agent = agents[swapper];

        if (agent.active) {
            if (agent.reputationScore >= 800) return (FEE_AGENT_HIGH, ParticipantType.AGENT_HIGH);
            if (agent.reputationScore >= 500) return (FEE_AGENT_MED, ParticipantType.AGENT_MED);
            return (FEE_AGENT_LOW, ParticipantType.AGENT_LOW);
        }

        BotPattern storage pattern = botPatterns[swapper];
        if (_isBot(gasPrice, pattern)) return (FEE_BOT, ParticipantType.BOT);
        return (FEE_HUMAN, ParticipantType.HUMAN);
    }

    // Called by hook ONCE per swap (in beforeSwap) — classifies + records pattern.
    // The hook caches the result and reuses it in afterSwap. NEVER call classify
    // twice per swap: double-counting skews frequency detection and can split a
    // different fee than the one charged.
    function classify(
        address swapper,
        uint256 gasPrice
    ) external onlyHook returns (uint256 feeBps, ParticipantType pType) {
        Agent storage agent = agents[swapper];

        // Registered agent path
        if (agent.active) {
            if (agent.reputationScore >= 800) return (FEE_AGENT_HIGH, ParticipantType.AGENT_HIGH);
            if (agent.reputationScore >= 500) return (FEE_AGENT_MED, ParticipantType.AGENT_MED);
            return (FEE_AGENT_LOW, ParticipantType.AGENT_LOW);
        }

        // Bot detection — pattern analysis O(1)
        BotPattern storage pattern = botPatterns[swapper];
        bool isBot = _isBot(gasPrice, pattern);

        // Update pattern
        if (block.number <= pattern.lastSwapBlock + 10) {
            pattern.swapsInWindow++;
        } else {
            pattern.swapsInWindow = 1;
        }
        pattern.lastSwapBlock = block.number;
        pattern.avgGasPrice = pattern.avgGasPrice == 0
            ? gasPrice
            : (pattern.avgGasPrice + gasPrice) / 2;

        if (isBot) return (FEE_BOT, ParticipantType.BOT);
        return (FEE_HUMAN, ParticipantType.HUMAN);
    }

    function _isBot(
        uint256 gasPrice,
        BotPattern storage pattern
    ) internal view returns (bool) {
        bool highFreq = pattern.swapsInWindow >= 3 &&
                        block.number <= pattern.lastSwapBlock + 10;
        bool gasSpike = pattern.avgGasPrice > 0 &&
                        gasPrice > pattern.avgGasPrice * 3;
        return highFreq || gasSpike;
    }

    function reward(address agent) external onlyHook nonReentrant {
        Agent storage a = agents[agent];
        if (!a.active) return;
        // EFFECT
        uint256 newScore = a.reputationScore + 5;
        a.reputationScore = newScore > MAX_REPUTATION ? MAX_REPUTATION : newScore;
        emit ReputationUpdated(agent, a.reputationScore, true);
    }

    function slash(address agent) external onlyHook nonReentrant {
        Agent storage a = agents[agent];
        if (!a.active) return;
        // EFFECT
        a.reputationScore = a.reputationScore > 50 ? a.reputationScore - 50 : 0;
        if (a.reputationScore == 0) a.active = false;
        emit ReputationUpdated(agent, a.reputationScore, false);
    }

    function getAgent(address swapper) external view returns (Agent memory) {
        return agents[swapper];
    }
}
```

---

## Contract 2 — `ArbitHook.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import "./ArbitRegistry.sol";

// Implements IHooks directly — pinned v4-periphery has no BaseHook.
// Pool MUST be created with fee = LPFeeLibrary.DYNAMIC_FEE_FLAG or the
// beforeSwap fee return is silently ignored (Hooks.sol:263).
contract ArbitHook is IHooks, ReentrancyGuard, Ownable {
    using PoolIdLibrary for PoolKey;
    using LPFeeLibrary for uint24;

    ArbitRegistry public registry;
    address public arbitToken;

    // ── Buyback Guard ────────────────────────────────────────────────────────
    // Prevents spam triggering and flash loan manipulation
    // Flash loans repay in same tx — cooldown makes them useless here
    uint256 public lastBuybackTime;
    uint256 public buybackPool;                          // accumulated fees for buyback
    uint256 public victimPool;                           // accumulated fees for victim compensation
    uint256 public constant BUYBACK_COOLDOWN = 1 hours; // min time between buybacks
    uint256 public constant MIN_BUYBACK_AMOUNT = 0.05e18; // ARBT units held by hook — retune per deployment
    // ─────────────────────────────────────────────────────────────────────────

    // Fee split constants
    uint256 public constant LP_SHARE = 80;       // 80% of human fee to LPs
    uint256 public constant BUYBACK_SHARE = 20;  // 20% of human fee to buyback
    uint256 public constant VICTIM_SHARE = 60;   // 60% of bot tax to victims
    uint256 public constant BOT_BUYBACK = 40;    // 40% of bot tax to buyback+burn

    // Pending rewards for agents — claimed separately
    mapping(address => uint256) public pendingRewards;

    // Single-classify cache: beforeSwap result reused by afterSwap, then cleared.
    // Keyed by pool + router-caller. Cleared every afterSwap (ToB: isolate callback state).
    mapping(bytes32 => uint256) private pendingFeeBps;
    mapping(bytes32 => ArbitRegistry.ParticipantType) private pendingType;
    mapping(bytes32 => address) private pendingTrader;

    error PoolManagerOnly();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert PoolManagerOnly();
        _;
    }

    event FeeCollected(address swapper, uint256 feeBps, ArbitRegistry.ParticipantType pType);
    event BuybackExecuted(uint256 amount, uint256 timestamp);
    event AgentRewarded(address agent, uint256 amount);
    event VictimCompensated(address victim, uint256 amount);

    IPoolManager public immutable poolManager;

    constructor(
        IPoolManager _poolManager,
        address _registry,
        address _arbitToken
    ) Ownable(msg.sender) {
        poolManager = _poolManager;
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
            afterSwapReturnDelta: false,  // not modifying swap amounts
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ── Trader identity ──────────────────────────────────────────────────────
    // `sender` is whoever called PoolManager.swap — normally the shared router /
    // unlocker contract (Hooks.sol:256), NOT the EOA. Routers MUST pass the real
    // user as 32-byte hookData; bare EOAs / executors pass empty hookData and fall
    // back to `sender`. NEVER use tx.origin (phishing vector).
    function _trader(address sender, bytes calldata hookData) internal pure returns (address) {
        if (hookData.length == 32) return abi.decode(hookData, (address));
        return sender;
    }

    function _pendingSlot(PoolKey calldata key, address sender) internal pure returns (bytes32) {
        return keccak256(abi.encode(key.toId(), sender));
    }

    // ── beforeSwap ───────────────────────────────────────────────────────────
    // Classifies ONCE + returns dynamic fee override to PoolManager.
    // O(1) — no loops, no external calls beyond registry.classify.
    // Pool must be a dynamic-fee pool or this return is ignored.
    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata,
        bytes calldata hookData
    ) external override onlyPoolManager nonReentrant returns (bytes4, BeforeSwapDelta, uint24) {
        // Verify pool is authorized — single source is the registry (PoolId typed).
        // Prevents cross-pool contamination: anyone can init a pool with our hook.
        PoolId poolId = key.toId();
        require(registry.allowedPools(poolId), "Arbit: unauthorized pool");

        address trader = _trader(sender, hookData);

        // Single classify per swap — result cached for afterSwap.
        (uint256 feeBps, ArbitRegistry.ParticipantType pType) =
            registry.classify(trader, tx.gasprice);
        require(feeBps <= registry.MAX_FEE_BPS(), "Arbit: fee exceeds cap");

        bytes32 slot = _pendingSlot(key, sender);
        pendingFeeBps[slot] = feeBps;
        pendingType[slot] = pType;
        pendingTrader[slot] = trader;

        // bps → v4 fee units (hundredths of a bip) + override flag.
        // 30 bps = 3000 units. Flag REQUIRED or PoolManager ignores the return.
        uint24 feeOverride = uint24(feeBps * 100) | LPFeeLibrary.OVERRIDE_FEE_FLAG;

        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, feeOverride);
    }

    // ── afterSwap ────────────────────────────────────────────────────────────
    // Reuses the beforeSwap classification (no second classify — see above).
    // Accounting is virtual until funded: the hook's ARBT balance backs rewards,
    // victim payouts, and burns. Owner MUST pre-fund the hook or claims revert.
    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external override onlyPoolManager nonReentrant returns (bytes4, int128) {
        bytes32 slot = _pendingSlot(key, sender);
        uint256 feeBps = pendingFeeBps[slot];
        ArbitRegistry.ParticipantType pType = pendingType[slot];
        address trader = pendingTrader[slot];

        // EFFECT — clear callback state first (isolate callback state per ToB).
        delete pendingFeeBps[slot];
        delete pendingType[slot];
        delete pendingTrader[slot];

        if (trader == address(0)) return (IHooks.afterSwap.selector, 0);

        // Calculate fee amount from delta
        uint256 feeAmount = _extractFeeAmount(delta, feeBps);
        if (feeAmount == 0) return (IHooks.afterSwap.selector, 0);

        // ── Asset flows based on participant type ─────────────────────────────
        if (pType == ArbitRegistry.ParticipantType.HUMAN) {
            // 80% to LPs (handled by PoolManager), 20% to buyback pool
            uint256 buybackContrib = (feeAmount * BUYBACK_SHARE) / 100;

            // EFFECT — update state before any external interaction
            buybackPool += buybackContrib;

        } else if (
            pType == ArbitRegistry.ParticipantType.AGENT_HIGH ||
            pType == ArbitRegistry.ParticipantType.AGENT_MED ||
            pType == ArbitRegistry.ParticipantType.AGENT_LOW
        ) {
            // Agent reward — portion of fee returned as Arbit tokens
            uint256 rewardAmount = _calculateAgentReward(feeAmount, pType);

            // EFFECT — queue reward for agent (claimed separately — avoid reentrancy)
            // Backed by the hook's real ARBT balance. Cap accrual to balance so
            // pendingRewards can never promise what claimReward cannot pay.
            uint256 hookBal = IERC20(arbitToken).balanceOf(address(this));
            uint256 maxNew = hookBal > victimPool ? hookBal - victimPool : 0;
            if (pendingRewards[trader] + rewardAmount > maxNew) {
                rewardAmount = maxNew > pendingRewards[trader] ? maxNew - pendingRewards[trader] : 0;
            }
            pendingRewards[trader] += rewardAmount;
            registry.reward(trader);

            emit AgentRewarded(trader, rewardAmount);

        } else {
            // Bot — 60% victim pool, 40% buyback + burn
            uint256 victimContrib = (feeAmount * VICTIM_SHARE) / 100;
            uint256 buybackContrib = feeAmount - victimContrib;

            // EFFECT — update state before any external interaction
            victimPool += victimContrib;
            buybackPool += buybackContrib;
        }

        // ── Buyback Guard ─────────────────────────────────────────────────────
        // Only fires when BOTH conditions met AND the hook actually holds ARBT
        // to burn — prevents flash loan + spam attacks + empty-burn events.
        // Flash loans must repay in same tx — cooldown makes them economically useless.
        // NOTE: threshold is denominated in ARBT units of the hook balance, NOT
        // ether — set MIN_BUYBACK_AMOUNT per deployment after funding the hook.
        if (
            buybackPool >= MIN_BUYBACK_AMOUNT &&
            block.timestamp >= lastBuybackTime + BUYBACK_COOLDOWN
        ) {
            _executeBuyback();
        }

        emit FeeCollected(trader, feeBps, pType);
        return (IHooks.afterSwap.selector, 0);
    }

    // ── Buyback execution ────────────────────────────────────────────────────
    // Burns ARBT the hook actually holds (transfer to dead address), capped by
    // balance. CEI strictly followed. No PoolManager swap in MVP — no oracle /
    // TWAP dependency by design (TWAP is post-hackathon).
    function _executeBuyback() internal {
        uint256 held = IERC20(arbitToken).balanceOf(address(this));
        uint256 amount = buybackPool > held ? held : buybackPool;
        if (amount == 0) return;

        // EFFECT — zero out pool before any external call
        buybackPool = amount == buybackPool ? 0 : buybackPool - amount;
        lastBuybackTime = block.timestamp;

        // INTERACTION — burn by sending to dead address
        IERC20(arbitToken).transfer(address(0xdead), amount);

        emit BuybackExecuted(amount, block.timestamp);
    }

    // ── Agent reward claim ───────────────────────────────────────────────────
    // Agents pull their rewards — push pattern avoided (reentrancy risk)
    function claimReward() external nonReentrant {
        uint256 reward = pendingRewards[msg.sender];
        require(reward > 0, "No pending reward");

        // EFFECT — zero before transfer
        pendingRewards[msg.sender] = 0;

        // INTERACTION — transfer Arbit token to agent
        IERC20(arbitToken).transfer(msg.sender, reward);
    }

    // ── Victim compensation ───────────────────────────────────────────────────
    // Owner can trigger victim payouts from the victim pool
    function compensateVictim(address victim, uint256 amount) external onlyOwner nonReentrant {
        require(amount <= victimPool, "Insufficient victim pool");
        require(victim != address(0), "Zero address");

        // EFFECT — deduct before transfer
        victimPool -= amount;

        // INTERACTION — transfer to victim
        IERC20(arbitToken).transfer(victim, amount);

        emit VictimCompensated(victim, amount);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function _extractFeeAmount(
        BalanceDelta delta,
        uint256 feeBps
    ) internal pure returns (uint256) {
        int128 amount = delta.amount0();
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

    // Pool allowlist lives ONLY in the registry — no duplicate mapping here.
    // (Earlier drafts had a second allowedPools map on the hook: dead code, removed.)

    // View pool state
    function getPoolState() external view returns (
        uint256 _buybackPool,
        uint256 _victimPool,
        uint256 _lastBuybackTime,
        uint256 _nextBuybackEligible
    ) {
        return (
            buybackPool,
            victimPool,
            lastBuybackTime,
            lastBuybackTime + BUYBACK_COOLDOWN
        );
    }
}
```

---

## Foundry Test Suite

Real tests live in `test/` (21 green as of Sep 6) — the outline below maps 1:1:

```solidity
// test/Registry.t.sol — register (effects-first), previewFee tiers
// (human/med/high/low), classify bot (high-freq + gas-spike), reward cap
// 1000, slash floor 0 + deactivate, setHook-once, fuzz fee ≤ MAX_FEE_BPS
// test/Hook.t.sol — human 20%→buyback, agent-HIGH reward + claimReward,
// hookData identity attribution, bot 60/40 split, unauthorized-pool revert,
// Guard cooldown-block + post-cooldown burn, claim/compensate guards,
// cache-cleared-between-swaps
// test/Executor.t.sol — executor registers itself, swaps as agent identity
// test/Invariant.t.sol — pools never negative, queued rewards + victim
// earmark ≤ hook ARBT balance, fuzz previewFee cap
```

```bash
forge test -vvv                                   # all 21
forge test --match-test testFeeNeverExceedsMax -vvv # fee-cap fuzz
forge test --match-test invariant_ -vvv            # backing invariants
```

---

## Testnet Deployment (Phase 1 — Robinhood Chain Testnet)

```bash
# Setup (repo already has foundry.toml + lib/ — no forge init needed)
# Faucet for testnet ETH: faucet.testnet.chain.robinhood.com

# .env — NEVER commit
# PRIVATE_KEY=<testnet key, testnet funds only>
# ROBINHOOD_TESTNET_RPC=https://rpc.testnet.chain.robinhood.com
# POOL_MANAGER_ADDRESS=<v4 PoolManager on Robinhood Testnet>
# ARBT_TOKEN_ADDRESS=<mock ARBT deployed to testnet first>

# Never fallback — throw explicitly in scripts
# uint256 deployerKey = vm.envUint("PRIVATE_KEY");

# Deploy registry + mined hook (see script/DeployArbit.s.sol — verified on anvil Sep 6)
forge script script/DeployArbit.s.sol \
  --rpc-url $ROBINHOOD_TESTNET_RPC \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify --verifier blockscout \
  --verifier-url https://explorer.testnet.chain.robinhood.com/api \
  -vvvv

# Then: fund hook with ARBT, create dynamic-fee pool (fee 0x800000),
# registry.allowPool(key.toId()), run all three fee flows + buyback scenarios.
# No canonical v4 deployment exists on 46630 (checked Uniswap/contracts Sep 7),
# so deploy a fresh PoolManager on testnet first for functional testing —
# script/SetupAnvil.s.sol does exactly this (TestERC20 + PoolManager), then
# DeployArbit.s.sol as usual. PoolManager logic is identical; only addresses differ.
# Verify each step on explorer.testnet.chain.robinhood.com, then run the demo
# scripts against testnet RPC before touching mainnet.

# Run full test suite
forge test -vvv

# Fuzz tests
forge test --match-test testFeeNeverExceedsMax -vvv

# Invariant tests
forge test --match-test invariant_ -vvv

# Static analysis — via WSL (Slither needs Linux; see Audit notes). 0 high/medium as of Sep 7.
```

---

## Audit notes (self-audit Sep 7 — external audit infeasible before Sep 10 deadline)

Slither (WSL, 102 detectors, `lib/` filtered): 0 high/medium. Fixed from the run: SafeERC20
everywhere (12 unchecked-transfer/unused-return), constructor zero-checks, `HookSet` event,
immutable token/registry refs. Remaining lows triaged benign and documented here:

| # | Finding | Disposition |
|---|---|---|
| 1 | Fee measured on `amount0` regardless of direction | FIXED — `_extractFeeAmount` now takes `params.zeroForOne` (`src/ArbitHook.sol`); covered by `test_ReverseDirectionFeeAccounting` |
| 2 | `reentrancy-benign`: pending-cache writes after `registry.classify` external call | Accepted — registry is our own `onlyHook`-gated contract; hook is `nonReentrant`; CEI holds for untrusted calls |
| 3 | `timestamp` (buyback cooldown) | Accepted — cooldown gating, not randomness; 1h manipulability is economically irrelevant |
| 4 | `tx.gasprice` bot signal | WEAK ON L2 — Robinhood L2 gas price is near-constant, so the gas-spike arm rarely fires; high-frequency arm is the real detector. First 3 swaps in a window are always HUMAN (pattern warm-up) — one-shot sandwich bots are NOT caught. Documented limitation, not fixable without oracles |
| 5 | `buybackPool`/`victimPool` accrue in pool-input-token units but burn/payouts are ARBT 1:1 | Accepted demo simplification — directionally correct (fees → supply reduction), numerically approximate. A production fix needs a price oracle (TWAP — post-hackathon) |
| 6 | `compensateVictim` is `onlyOwner`, manual, arbitrary recipient | Accepted trust assumption for hackathon — owner can drain victimPool to anyone. Production: victim proofs (e.g. sandwich-attribution claims). Disclose to judges |
| 7 | Heavy `claimReward` payouts can starve later `compensateVictim` (balance < victimPool reverts, no loss) | Accepted — payouts never over-spend (revert, not loss); operational rule: compensate victims before large reward epochs |
| 8 | Executor `address(this).call` + assembly, `rescue` ETH `call` | Accepted — plain call (not delegatecall), `onlyAgent`-gated; executor is NOT part of the launch graph |
| 9 | Naming/event-indexing infos | Accepted — cosmetic |
| 10 | Admission `CROSS_CHAIN_REPLAY` | FIXED — immutable `chainId` + deploy-time `block.chainid` check on hook + initializer (mirrors kernel); canonical-PM runtime binding at pack is the real protection (`test_WrongChainDeployReverts`) |
| 11 | Admission `POOL_MANAGER_AUTHENTICATION_MISSING` | VERIFIED — `onlyPoolManager` on all 10 callbacks incl. 8 stubs (`test_DirectCallbackBypassReverts`, Cork class) |
| 12 | Admission `UNBALANCED_SETTLEMENT` | VERIFIED by construction — hook returns zero deltas and never settles/takes; initializer settles every leg it opens (launch-sim asserts balances) |

NOT covered by this audit (state explicitly): economic soundness of fee levels, oracle/TWAP design (doesn't
exist yet), the Programmable graph/pack layer, offchain demo scripts, upgrade story (none — immutable by design).
If judges ask: "self-audited + Slither-clean of high/medium; no external audit before deadline" — maturity, not weakness.

---

## Mainnet Deploy (Phase 2 — Programmable Custom Launch V4, verified Sep 7)

All commands below were verified against the live platform (CLI 4.1.0, checksum-matched to the
discovery manifest; capabilities + launch-coverage read live). The old draft's `pack ./src` /
`validate --remote --network robinhood` / `submit --network robinhood` commands DO NOT EXIST — do not use them.

**Step 0 — confirm the lane is open (no key needed, re-check on deploy day):**
```bash
curl --fail --silent https://api.programmable.market/v4/chains/4663/capabilities | head -c 400
curl --fail --silent https://api.programmable.market/v4/chains/4663/launch-coverage | head -c 400
curl --fail --silent https://api.programmable.market/v4/chains/4663/initial-buy-quote
```
Require: readiness `ready`, coverage `requestAuthorized` path available, profile `4.1.0`.
(Sep 7: readiness `ready`, `publicAuthorization/publicWrites/releaseReady: true`.)

**Step 1 — install the pinned CLI (checksum-verified, never an npm package of the same name):**
```bash
curl --fail --location --output /tmp/plc.tgz \
  https://github.com/programmablehq/PROGRAMMABLE/releases/download/programmable-launch-v4.1.0/programmable-launch-4.1.0.tgz
curl --fail --location --output /tmp/plc.tgz.sha256 \
  https://github.com/programmablehq/PROGRAMMABLE/releases/download/programmable-launch-v4.1.0/programmable-launch-4.1.0.tgz.sha256
(cd /tmp && sha256sum -c plc.tgz.sha256)   # must print OK — expected 9d7d26a7…
npm install --global /tmp/plc.tgz
programmable-launch --version              # must print 4.1.0
```

**Step 2 — API key (you do this, never the agent):**
Create at programmable.market/developers/api-keys with `custom-launch:create` + chain `4663` grant.
Export `PROGRAMMABLE_API_KEY` (env or OS secret store — the CLI has no `--api-key` flag).

**Step 3 — token + metadata (code: `src/ArbitToken.sol`, fixed 1B ARBT, no mint/tax/pause):**
The token is NOT launched separately via UI — it is the `componentKind: "token"` target inside the
packed graph, with name/symbol/description/image/links in `projectMetadata`. Before packing you must have,
and never invent: token name + symbol, ≥20-byte description, real PNG (or single-frame GIF) + its public
HTTPS/IPFS URI, website URL, X profile URL. Repo must be public on GitHub at an exact commit
(`source.publicOrigin.url` + 40-hex `revision`).

**Step 4 — pack config (`programmable-launch.config.json`, schema `programmable.launch-pack-config.v4`):**
Targets (3–16): `arbit-token` (token), `arbit-registry` (other, ctor = token locator), `arbit-hook`
(hook, ctor = PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951` + registry locator + token locator,
`declaredHookPermissions: ["beforeSwap","afterSwap"]`, salt = `deterministic-hook-permission-grind-v1` —
pack grinds the CREATE2 salt itself, no HookMiner needed). Pool: token+hook IDs, `fee: 8388608`
(dynamic — structurally supported), `tickSpacing`, native-ETH quote. Plus `fundingPlan` (fund-and-launch:
`initialLiquidityWei` + `initialBuyWei` ≥ server quote ≈$1 + `maxLaunchValueWei` + `maxGasCostWei`),
`liquidityModel` (`external-concentrated-liquidity` = we seed our own position — pool init alone is NOT
liquid), `behaviorScenarioInputs` (our seed/swap/claim demo steps), `agentAttestation`.

**Step 5 — the state machine (CLI never signs or broadcasts):**
```bash
programmable-launch pack --config programmable-launch.config.json --output launch.json
programmable-launch validate launch.json --config programmable-launch.config.json --remote
# ^ quota-free preflight. MUST be clean before submit. With our custom hook expect
# ROBINHOOD_* findings (see coverage verdict below) — resolve with devrel FIRST.
programmable-launch submit launch.json --config programmable-launch.config.json
programmable-launch status LAUNCH_ID --api-version 4 --chain-id 4663 --watch --until authorized
# ^ STOP. Controller reviews the exact walletTransaction and signs in a separate wallet flow.
programmable-launch status LAUNCH_ID --api-version 4 --chain-id 4663 --watch --until finalized
```

**Step 6 — post-finality wiring (same tx or immediately after, order matters):**
The Router deploys token + registry + hook + pool atomically. Then, as owner: `registry.setHook(hook)`,
fund the hook with ARBT (rewards/victim/burns revert when unfunded), `registry.allowPool(key.toId())`,
seed the LP position per the funding plan. Verify on robinhoodchain.blockscout.com (provider verification
starts only after `finalized` and is independent of finality).

**⚠️ Coverage verdict (live `/v4/chains/4663/launch-coverage`, Sep 7) — read before packing:**
The only activated proof adapter is `seedV1`: exact-reviewed native20 kernel + seed token + seed
initializer, `lpFeePips: 0`, `tickSpacing: 60`. Our graph (arbitrary token, custom dynamic-fee hook,
custom victim/buyback settlement, tickSpacing 10) is OUTSIDE it → preflight may return
`ROBINHOOD_NATIVE_FEE_KERNEL_EVIDENCE_REQUIRED` (exact 20 bps native kernel to
`0xD88539d3c4C460136a733A3Fd60cf6BF269079da`), `ROBINHOOD_ATOMIC_INITIAL_BUY_EVIDENCE_REQUIRED`,
and custom-settlement findings.
**BUT — precedent found Sep 7 (changes the calculus): "Robinhood Clean Room" (RHCR), finalized
Sep 3 on mainnet under profile 4.0.0, is a CUSTOM bonding-curve hook (hook `0xa3b48907…`, token
`0x15fca4…`, vault `0x0cddef91…`, all `exact_match`): custom pricing via return deltas, 5% native fee
decaying to zero over 24h, virtual reserves, custom settlement vault — strictly WILDER than our design
(no return deltas, no custom curve, standard accounting). And the docs (custom-launch.md, read Sep 7)
confirm the principle: the custom lane accepts project-owned token + hook and all 14 permission bits,
"does not substitute a Programmable-owned hook"; only 7 objective hard-blocks exist (CALLCODE,
SELFDESTRUCT, missing/invalid callback auth, noncanonical PoolManager, missing callback impl) — our
hook passes all 7, everything else is evidence duties, not blocks.
REMAINING BINDING CONSTRAINT (4.1 only): "4.1 admission requires the exact native fee kernel for the
stamped PoolKey" (20bps to `0xD885…079da`). The docs-blessed composition point is the kernel's
view-only module slot (capped fee override, zero custom deltas — sized exactly for our fee tiers, with
bot-pattern writes moved to off-swap pokes). So the single open question is kernel-vs-module-vs-custom
under 4.1 — see devrel draft below. "Shard" was NOT found in the V4 finalized feed (only RHCR) or
explore — link it if you meant a specific project and I'll tear it down the same way.

**V4 admission hard-blocks relevant to us (from the live admission descriptors):**
- No `CALLCODE`/delegatecall, no `SELFDESTRUCT` ✅ (executor's `address(this).call` is a plain call, and the
  executor is NOT part of the launch graph anyway)
- Every enabled callback implemented + `onlyPoolManager`-gated, PoolManager must be exactly
  `0x8366a39CC670B4001A1121B8F6A443A643e40951` ✅ (`src/ArbitHook.sol` — already the case)
- No proxy/upgrade, no mint/tax/pause surfaces on token ✅ (`src/ArbitToken.sol`)
- Return-delta flags stay false ✅ — note: this also means our fee-split accounting is internal only;
  platform states "generic fee claiming and buyback management for arbitrary hooks are not live,"
  which matches our self-contained design (no platform buyback dependency claimed)

**Deploy-script lesson (anvil dry-run Sep 6):** `new ArbitHook{salt:}` inside a forge script is routed through the canonical keyless Create2Deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` — mine the salt against THAT address, not the script/sender, or `validateHookPermissions` reverts. Local dry-run path: `script/SetupAnvil.s.sol` (mock ARBT + PoolManager) → `script/DeployArbit.s.sol` with `--unlocked --sender <anvil-acct>` (anvil accounts are unlocked; `--private-key` is not needed locally — and NEVER put a real key on a command line).

**Pool creation requirement:** the pool MUST be created with `fee = LPFeeLibrary.DYNAMIC_FEE_FLAG (0x800000)`. Static-fee pools silently ignore the `beforeSwap` fee return (`Hooks.sol:263`) — the demo will look live while charging the wrong fee. Fund the hook with ARBT at deploy so rewards / victim payouts / burns are backed by a real balance.

**Guardrail sources:** Uniswap v4 Security Framework (docs/protocols/v4/security), Trail of Bits "Building secure Uniswap v4 hooks" (Jul 2026 — 7 failure patterns), Uniswap AI `v4-security-foundations` skill (router-allowlist, gas budgets, absolute prohibitions), Beosin/Zealynx hook reviews (pool-binding, delta-conservation ≠ correctness, dust/`clear()`, nested-callback fuzzing).

---

## Pre-Commit Guard

```bash
#!/bin/sh
# .git/hooks/pre-commit — blocks key names/tokens/standalone 64-hex keys,
# allows 0x-hashes + bytecode runs in broadcast receipts (fixed Sep 7:
# naive 0x{64} pattern blocked every broadcast commit)
if git diff --cached | grep -Ei 'pm_live_[A-Za-z0-9_-]+|PRIVATE_KEY\s*=\s*(0x)?[0-9a-fA-F]{64}|[^0-9a-fA-Fx][0-9a-fA-F]{64}([^0-9a-fA-F]|$)'; then
  echo "ERROR: Possible secret in staged diff. Aborting."
  exit 1
fi
```
```bash
chmod +x .git/hooks/pre-commit
```

---

## Build Order (4 Days)

| Day | Task |
|---|---|
| 1 | `ArbitRegistry.sol` + full test suite for classification + reputation |
| 2 | `ArbitHook.sol` — beforeSwap fee override + afterSwap fee splitting + Buyback Guard |
| 3 | Full integration tests — all 3 participant flows + buyback scenarios + Slither + Sepolia deploy |
| 4 | Programmable CLI → Robinhood Chain mainnet + Blockscout verify + website + X posts + submission form |

---

## Website (Next.js 16)

Single page. Three sections:

**Hero:** "Every trade makes Arbit stronger." Live stats above fold: total buybacks executed, total fees collected, current buyback pool balance, next buyback eligible time. The live data IS the hero — not an illustration.

**How it works:** Three participant lanes side by side — Human (protected, 20% to buyback), Agent (rewarded for good behavior), Bot (taxed, funds the system). Visual flow showing where assets go after each swap type.

**Register as agent:** Connect wallet → stake Arbit → start earning reduced fees + token rewards. Direct call to `ArbitRegistry.register()`.

**Design:** Near-black background (`#070B0E`), electric amber accent (`#F59E0B`) — amber signals value and yield, different from the typical DeFi green or blue. Space Grotesk for headings, JetBrains Mono for all live onchain data. No gradient cards. Data-dense, terminal-clean.

---

## Submission Checklist

- [ ] All Foundry tests passing (`forge test -vvv`)
- [ ] Slither clean — no high/medium findings
- [ ] Deployed + verified on Robinhood Chain Testnet (46630) first — all 3 flows + Guard scenarios green on testnet
- [ ] All 3 participant flows demonstrated on testnet
- [ ] Buyback Guard tested — cooldown + minimum threshold verified
- [ ] Flash loan test passing — Guard holds
- [ ] Hook live on Programmable.market → Robinhood Chain (chain ID 4663)
- [ ] Contract verified on robinhoodchain.blockscout.com
- [ ] Arbit token deployed as the graph's token target with hook + pool atomically (single Router launch, not a separate token launch)
- [ ] Website live with live pool state (buyback pool, next eligible time)
- [ ] Agent registration working on website
- [ ] X account active — 3+ posts before submission
- [ ] Demo video showing all 3 participant flows + buyback firing
- [ ] Submission form at forms.gle/PNbKvDn63sMqqc857 completed before Sep 10
- [ ] Pre-commit guard active — no keys in repo
- [ ] `.env.example` committed — real `.env` never committed
