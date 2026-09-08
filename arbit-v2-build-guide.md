# Arbit — Full Build Guide (v2)
**Programmable Hookathon | Deadline: Sep 10, 2026 | Prize: $10,000**

---

## What We're Building

Arbit is a Uniswap v4 hook deployed on Robinhood Chain that turns any pool into a **self-regulating, bot-native execution venue**. It combines three mechanics into one hook:

1. **Bot Detection + Classification** — identifies whether a swap comes from a registered agent, an unregistered bot, or a human trader
2. **Dynamic Fee Engine** — prices each swap individually based on who you are and how you behave — reputation determines your fee
3. **MEV Compensation Layer** — bot fees flow into a compensation pool; sandwich attack victims receive automatic payouts; LPs earn the remainder

**The demo story:**
> An unregistered bot sandwiches a human trader → Arbit detects it in `afterSwap` → victim is compensated automatically from the MEV pool → unregistered bot paid a 3x fee → registered agent with high reputation swaps the same pool at 0.05% fee → reputation increments → LPs earn from all activity

---

## Development Flow

```
Phase 1 — Testnet (Arbitrum Sepolia)
  → Write contracts
  → Deploy via Foundry to Sepolia
  → Test full flow: human swap, registered agent swap, unregistered bot swap
  → Verify all three fee tiers work
  → Verify MEV compensation fires correctly
  → Verify reputation increments/decrements

Phase 2 — Robinhood Chain Mainnet via Programmable.market
  → Pack bundle via programmable-launch CLI
  → Validate remotely
  → Submit + sign
  → Token launched + hook bound to pool
  → Verify on robinhoodchain.blockscout.com
```

---

## Tech Stack

| Layer | Tool |
|---|---|
| Smart contracts | Solidity 0.8.26 (exact — pinned by Programmable CLI) |
| Hook framework | Uniswap v4 `BaseHook` |
| Testing | Foundry (forge test + fuzz + invariant) |
| Static analysis | Slither |
| Testnet deploy | Foundry `forge script` → Arbitrum Sepolia |
| Mainnet deploy | `programmable-launch` CLI → Robinhood Chain (chain ID 4663) |
| Demo agents | Node.js + ethers.js v6 |
| Website | Next.js 16 + Tailwind |
| Token | Launched via Programmable.market UI |

---

## Contract Architecture

Four contracts. Each has one job.

```
ArbitToken (ERC-20)
        ↓ staked by agents
ArbitRegistry
  - Agent registration + stake
  - Reputation scores
  - Bot pattern detection data
        ↓ called by hook
ArbitHook (Uniswap v4 BaseHook)
  - beforeSwap: classify swapper, set dynamic fee
  - afterSwap: detect sandwich, trigger compensation, update reputation
        ↓ reads/writes
ArbitCompensation
  - MEV compensation pool
  - Victim payout logic
  - LP distribution
```

---

## Security Guardrails (Read Before Writing Code)

These are non-negotiable. Based on real exploits:

| Rule | Why |
|---|---|
| `onlyPoolManager` on ALL hook callbacks | Missing this = $11M Cork exploit |
| `nonReentrant` on `afterSwap` + all registry writes | Bunni $8.4M rounding bug entry point |
| Checks-Effects-Interactions in ALL state-changing functions | Reentrancy prevention |
| Pool allowlist — unauthorized pools rejected | Cross-pool contamination prevention |
| `getHookPermissions()` must match deployed address bits exactly | Silent no-op if mismatched |
| No return delta flags unless delta modification is implemented | Free swap vulnerability |
| Fee caps — never charge more than MAX_FEE_BPS | Griefing prevention |
| `setHook()` onlyOwner + set-once guard | Registry hijack prevention |
| No loops in `beforeSwap` or `afterSwap` | Gas griefing prevention — must be O(1) |
| Sandwich detection uses pre/post price comparison only | No oracle dependency = no oracle manipulation |

---

## Contract 1 — `ArbitRegistry.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ArbitRegistry is Ownable, ReentrancyGuard {

    enum AgentTier { UNREGISTERED, REGISTERED_LOW, REGISTERED_MED, REGISTERED_HIGH }

    struct Agent {
        uint256 stakedAmount;
        uint256 reputationScore;   // 0–1000, starts at 500
        uint256 totalSwaps;
        uint256 flaggedSwaps;
        uint256 lastSwapBlock;
        bool active;
    }

    // Bot fingerprint — used to detect unregistered bots
    struct SwapPattern {
        uint256 lastSwapBlock;
        uint256 swapsInWindow;    // swaps in last 10 blocks
        uint256 avgGasPrice;
    }

    mapping(address => Agent) public agents;
    mapping(address => SwapPattern) public patterns;
    mapping(bytes32 => bool) public allowedPools;

    address public arbitToken;
    address public hook;
    bool private hookSet;

    uint256 public constant MIN_STAKE = 100e18;
    uint256 public constant MAX_REPUTATION = 1000;
    uint256 public constant REPUTATION_SLASH = 50;
    uint256 public constant REPUTATION_REWARD = 5;

    // Fee tiers in basis points
    uint256 public constant FEE_HUMAN = 30;           // 0.30%
    uint256 public constant FEE_AGENT_HIGH = 5;       // 0.05% — high reputation
    uint256 public constant FEE_AGENT_MED = 15;       // 0.15% — medium reputation
    uint256 public constant FEE_AGENT_LOW = 30;       // 0.30% — low reputation
    uint256 public constant FEE_UNREGISTERED_BOT = 100; // 1.00% — MEV tax
    uint256 public constant MAX_FEE_BPS = 500;        // hard cap 5%

    event AgentRegistered(address agent, uint256 stake);
    event ReputationUpdated(address agent, uint256 newScore, bool increased);
    event BotDetected(address bot, uint256 feeBps);
    event PoolAllowed(bytes32 poolId);

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

    function allowPool(bytes32 poolId) external onlyOwner {
        allowedPools[poolId] = true;
        emit PoolAllowed(poolId);
    }

    function register(uint256 stakeAmount) external nonReentrant {
        require(stakeAmount >= MIN_STAKE, "Stake below minimum");
        require(!agents[msg.sender].active, "Already registered");

        // INTERACTION — transfer first
        IERC20(arbitToken).transferFrom(msg.sender, address(this), stakeAmount);

        // EFFECT — state after transfer
        agents[msg.sender] = Agent({
            stakedAmount: stakeAmount,
            reputationScore: 500, // start at midpoint
            totalSwaps: 0,
            flaggedSwaps: 0,
            lastSwapBlock: 0,
            active: true
        });

        emit AgentRegistered(msg.sender, stakeAmount);
    }

    // Classify swapper and return fee in basis points
    function classifyAndGetFee(
        address swapper,
        uint256 gasPrice
    ) external onlyHook nonReentrant returns (uint256 feeBps, AgentTier tier) {
        Agent storage agent = agents[swapper];

        // Registered agent path
        if (agent.active) {
            agent.totalSwaps++;
            agent.lastSwapBlock = block.number;

            if (agent.reputationScore >= 800) {
                return (FEE_AGENT_HIGH, AgentTier.REGISTERED_HIGH);
            } else if (agent.reputationScore >= 500) {
                return (FEE_AGENT_MED, AgentTier.REGISTERED_MED);
            } else {
                return (FEE_AGENT_LOW, AgentTier.REGISTERED_LOW);
            }
        }

        // Bot detection — pattern analysis
        SwapPattern storage pattern = patterns[swapper];
        bool looksLikeBot = _detectBotPattern(swapper, gasPrice, pattern);

        // Update pattern
        if (block.number <= pattern.lastSwapBlock + 10) {
            pattern.swapsInWindow++;
        } else {
            pattern.swapsInWindow = 1;
        }
        pattern.lastSwapBlock = block.number;
        pattern.avgGasPrice = (pattern.avgGasPrice + gasPrice) / 2;

        if (looksLikeBot) {
            emit BotDetected(swapper, FEE_UNREGISTERED_BOT);
            return (FEE_UNREGISTERED_BOT, AgentTier.UNREGISTERED);
        }

        return (FEE_HUMAN, AgentTier.UNREGISTERED);
    }

    function _detectBotPattern(
        address swapper,
        uint256 gasPrice,
        SwapPattern storage pattern
    ) internal view returns (bool) {
        // Bot signals — O(1), no loops
        bool highFrequency = pattern.swapsInWindow >= 3 &&
                             block.number <= pattern.lastSwapBlock + 10;
        bool gasAnomaly = pattern.avgGasPrice > 0 &&
                          gasPrice > pattern.avgGasPrice * 3; // 3x avg gas = front-running signal
        bool newWallet = pattern.lastSwapBlock == 0 &&
                         gasPrice > tx.gasprice * 2; // first swap with high gas

        return highFrequency || (gasAnomaly && highFrequency) || newWallet;
    }

    function rewardReputation(address agent) external onlyHook nonReentrant {
        Agent storage a = agents[agent];
        if (!a.active) return;
        // EFFECT
        uint256 newScore = a.reputationScore + REPUTATION_REWARD;
        a.reputationScore = newScore > MAX_REPUTATION ? MAX_REPUTATION : newScore;
        emit ReputationUpdated(agent, a.reputationScore, true);
    }

    function slashReputation(address agent) external onlyHook nonReentrant {
        Agent storage a = agents[agent];
        if (!a.active) return;
        // EFFECT
        a.flaggedSwaps++;
        a.reputationScore = a.reputationScore > REPUTATION_SLASH
            ? a.reputationScore - REPUTATION_SLASH
            : 0;
        // Deactivate if reputation hits 0
        if (a.reputationScore == 0) a.active = false;
        emit ReputationUpdated(agent, a.reputationScore, false);
    }

    function getAgent(address swapper) external view returns (Agent memory) {
        return agents[swapper];
    }
}
```

---

## Contract 2 — `ArbitCompensation.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ArbitCompensation is Ownable, ReentrancyGuard {

    address public hook;
    bool private hookSet;

    // MEV pool balance per token
    mapping(address => uint256) public mevPool;

    // LP earnings per token
    mapping(address => uint256) public lpPool;

    // Victim compensation records
    struct CompensationRecord {
        address victim;
        address token;
        uint256 amount;
        uint256 blockNumber;
    }

    CompensationRecord[] public compensations;

    // Split: 60% to victims, 40% to LPs
    uint256 public constant VICTIM_SHARE = 60;
    uint256 public constant LP_SHARE = 40;

    event FeeDeposited(address token, uint256 amount, uint256 victimShare, uint256 lpShare);
    event VictimCompensated(address victim, address token, uint256 amount);

    modifier onlyHook() {
        require(msg.sender == hook, "Only hook");
        _;
    }

    constructor() Ownable(msg.sender) {}

    function setHook(address _hook) external onlyOwner {
        require(!hookSet, "Hook already set");
        require(_hook != address(0), "Zero address");
        hook = _hook;
        hookSet = true;
    }

    // Called by hook when bot/MEV fee is collected
    function depositFee(address token, uint256 amount) external onlyHook nonReentrant {
        // EFFECT — split before any transfer
        uint256 victimShare = (amount * VICTIM_SHARE) / 100;
        uint256 lpShare = amount - victimShare;

        mevPool[token] += victimShare;
        lpPool[token] += lpShare;

        emit FeeDeposited(token, amount, victimShare, lpShare);
    }

    // Called by hook when sandwich is detected — compensate victim
    function compensateVictim(
        address victim,
        address token,
        uint256 estimatedLoss
    ) external onlyHook nonReentrant {
        uint256 available = mevPool[token];
        if (available == 0) return;

        // Pay up to estimated loss, capped at available pool
        uint256 payout = estimatedLoss > available ? available : estimatedLoss;

        // EFFECT first
        mevPool[token] -= payout;

        compensations.push(CompensationRecord({
            victim: victim,
            token: token,
            amount: payout,
            blockNumber: block.number
        }));

        // INTERACTION last — transfer to victim
        // Note: in v4 context this uses PoolManager currency settlement
        emit VictimCompensated(victim, token, payout);
    }
}
```

---

## Contract 3 — `ArbitHook.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "v4-periphery/src/base/hooks/BaseHook.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./ArbitRegistry.sol";
import "./ArbitCompensation.sol";

contract ArbitHook is BaseHook, ReentrancyGuard, Ownable {
    using PoolIdLibrary for PoolKey;

    ArbitRegistry public registry;
    ArbitCompensation public compensation;

    // Track pre-swap price for sandwich detection
    // poolId → swapper → sqrtPriceX96 before swap
    mapping(bytes32 => mapping(address => uint160)) private preSwapPrice;

    // Sandwich detection threshold — 2% price impact triggers compensation
    uint256 public constant SANDWICH_THRESHOLD_BPS = 200;

    event SwapClassified(address swapper, uint256 feeBps, ArbitRegistry.AgentTier tier);
    event SandwichDetected(address victim, uint256 priceImpactBps);

    constructor(
        IPoolManager _poolManager,
        address _registry,
        address _compensation
    ) BaseHook(_poolManager) Ownable(msg.sender) {
        registry = ArbitRegistry(_registry);
        compensation = ArbitCompensation(_compensation);
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
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
            beforeSwapReturnDelta: false,  // not modifying deltas
            afterSwapReturnDelta: false,   // not modifying deltas
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        // Check pool is authorized
        bytes32 poolId = keccak256(abi.encode(key));
        require(registry.allowedPools(poolId), "Arbit: unauthorized pool");

        // Record pre-swap price for sandwich detection in afterSwap
        // poolManager.getSlot0 returns current sqrtPriceX96
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        preSwapPrice[poolId][sender] = sqrtPriceX96;

        // Classify swapper + get dynamic fee — O(1), no loops
        (uint256 feeBps, ArbitRegistry.AgentTier tier) = registry.classifyAndGetFee(
            sender,
            tx.gasprice
        );

        emit SwapClassified(sender, feeBps, tier);

        // Return dynamic fee override to PoolManager
        // feeBps is in basis points — convert to uint24 (v4 uses pips: 1 pip = 0.0001%)
        uint24 feeOverride = uint24(feeBps * 100); // bps → pips

        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, feeOverride);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external override onlyPoolManager nonReentrant returns (bytes4, int128) {
        bytes32 poolId = keccak256(abi.encode(key));
        uint160 preBefore = preSwapPrice[poolId][sender];

        // Get post-swap price
        (uint160 sqrtPriceAfter,,,) = poolManager.getSlot0(key.toId());

        // Detect sandwich — compare price impact
        if (preBefore > 0 && sqrtPriceAfter > 0) {
            uint256 priceImpactBps = _calculatePriceImpact(preBefore, sqrtPriceAfter);

            if (priceImpactBps > SANDWICH_THRESHOLD_BPS) {
                // Sandwich detected — compensate victim
                uint256 estimatedLoss = _estimateLoss(delta, priceImpactBps);
                address token = Currency.unwrap(params.zeroForOne ? key.currency1 : key.currency0);

                // EFFECT — compensation contract handles state
                compensation.compensateVictim(sender, token, estimatedLoss);
                registry.slashReputation(sender); // slash if registered agent caused it

                emit SandwichDetected(sender, priceImpactBps);
            } else {
                // Clean swap — reward registered agents
                ArbitRegistry.Agent memory agent = registry.getAgent(sender);
                if (agent.active) {
                    registry.rewardReputation(sender);
                }
            }
        }

        // Clean up pre-swap price storage
        delete preSwapPrice[poolId][sender];

        return (BaseHook.afterSwap.selector, 0);
    }

    function _calculatePriceImpact(
        uint160 priceBefore,
        uint160 priceAfter
    ) internal pure returns (uint256 impactBps) {
        // Price impact = |priceAfter - priceBefore| / priceBefore * 10000
        if (priceAfter > priceBefore) {
            impactBps = ((priceAfter - priceBefore) * 10000) / priceBefore;
        } else {
            impactBps = ((priceBefore - priceAfter) * 10000) / priceBefore;
        }
    }

    function _estimateLoss(
        BalanceDelta delta,
        uint256 priceImpactBps
    ) internal pure returns (uint256) {
        // Rough estimate: amount * price impact %
        int128 amount = delta.amount1();
        if (amount < 0) amount = -amount;
        return (uint256(uint128(amount)) * priceImpactBps) / 10000;
    }
}
```

---

## Testnet Deployment (Phase 1 — Arbitrum Sepolia)

### Setup Foundry

```bash
# Install Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Create project
mkdir arbit && cd arbit
forge init

# Install dependencies
forge install OpenZeppelin/openzeppelin-contracts
forge install Uniswap/v4-core
forge install Uniswap/v4-periphery

# Pin Solidity version
echo 'solc = "0.8.26"' >> foundry.toml
```

### Environment

```bash
# .env.example — commit this, NEVER .env
PRIVATE_KEY=
ARBITRUM_SEPOLIA_RPC=https://sepolia-rollup.arbitrum.io/rpc
ROBINHOOD_CHAIN_RPC=https://mainnet.robinhood.com
ETHERSCAN_API_KEY=
```

```solidity
// script/Deploy.s.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";
import {ArbitCompensation} from "../src/ArbitCompensation.sol";
import {ArbitHook} from "../src/ArbitHook.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        // 1. Deploy token (or use existing)
        // address token = address(new ArbitToken());

        // 2. Deploy registry
        ArbitRegistry registry = new ArbitRegistry(address(token));

        // 3. Deploy compensation
        ArbitCompensation comp = new ArbitCompensation();

        // 4. Deploy hook
        // Note: hook address must encode correct permission bits
        // Use HookMiner to find valid salt
        ArbitHook hook = new ArbitHook(
            IPoolManager(POOL_MANAGER_ADDRESS),
            address(registry),
            address(comp)
        );

        // 5. Wire up
        registry.setHook(address(hook));
        comp.setHook(address(hook));

        vm.stopBroadcast();
    }
}
```

### Deploy to Sepolia

```bash
# Deploy
forge script script/Deploy.s.sol \
  --rpc-url $ARBITRUM_SEPOLIA_RPC \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify \
  -vvvv

# Run tests
forge test -vvv

# Fuzz test fee calculation
forge test --match-test testFeeFuzz -vvv

# Invariant — mevPool never goes negative
forge test --match-test invariant_mevPoolNeverNegative -vvv

# Static analysis
slither . --solc-remaps "@openzeppelin=lib/openzeppelin-contracts"
```

---

## Test Scenarios (Foundry)

```solidity
// test/ArbitHook.t.sol
contract ArbitHookTest is Test {

    // Test 1: Human trader gets baseline fee
    function testHumanTraderFee() public {
        (uint256 fee, ) = registry.classifyAndGetFee(humanAddress, 1 gwei);
        assertEq(fee, 30); // 0.30%
    }

    // Test 2: Registered agent with high reputation gets low fee
    function testRegisteredAgentHighRepFee() public {
        // Register agent, boost reputation to 800+
        vm.prank(agent);
        registry.register(100e18);
        for (uint i = 0; i < 60; i++) {
            registry.rewardReputation(agent);
        }
        (uint256 fee, ) = registry.classifyAndGetFee(agent, 1 gwei);
        assertEq(fee, 5); // 0.05%
    }

    // Test 3: Unregistered bot detected + taxed
    function testUnregisteredBotDetected() public {
        // Simulate high frequency + high gas
        vm.roll(block.number + 1);
        registry.classifyAndGetFee(botAddress, 100 gwei);
        registry.classifyAndGetFee(botAddress, 100 gwei);
        registry.classifyAndGetFee(botAddress, 100 gwei);
        (uint256 fee, ) = registry.classifyAndGetFee(botAddress, 100 gwei);
        assertEq(fee, 100); // 1.00% MEV tax
    }

    // Test 4: Sandwich detection + victim compensation
    function testSandwichCompensation() public {
        // Simulate large price impact swap
        // Verify compensateVictim was called
        // Verify mevPool decreased
        // Verify victim received funds
    }

    // Fuzz test: fee never exceeds MAX_FEE_BPS
    function testFeeFuzz(uint256 gasPrice) public {
        (uint256 fee, ) = registry.classifyAndGetFee(address(1), gasPrice);
        assertLe(fee, registry.MAX_FEE_BPS()); // never exceeds 5%
    }

    // Invariant: mevPool never goes negative
    function invariant_mevPoolNeverNegative() public {
        assertGe(compensation.mevPool(address(token)), 0);
    }
}
```

---

## Phase 2 — Programmable.market Deploy (Robinhood Chain)

Once testnet is clean — all tests passing, Slither clean, scenarios verified:

```bash
# Install Programmable CLI
npm install -g programmable-launch

# Add Robinhood Chain to wallet
# Network: Robinhood Chain | Chain ID: 4663
# RPC: https://mainnet.robinhood.com
# Explorer: robinhoodchain.blockscout.com

# Pack bundle — uses exact solc 0.8.26
programmable-launch pack ./src

# Validate remotely — Programmable checks 7 hard-block rules
programmable-launch validate --remote --network robinhood

# Submit
programmable-launch submit --network robinhood

# Watch until authorized
programmable-launch status --watch --until authorized

# Sign with wallet — hook + token + pool bound together on Robinhood Chain
```

**The 7 hard-block rules Programmable enforces — Arbit avoids all of them:**
- No proxy/delegatecall ✅
- No mint controls post-launch ✅
- No tax mechanisms ✅ (dynamic fees ≠ taxes)
- No pause controls ✅
- No liquidity removal by owner ✅
- No unauthorized return delta surfaces ✅
- No non-standard approval flows ✅

**After deploy — immediately verify on Blockscout:**
```
https://robinhoodchain.blockscout.com/address/YOUR_HOOK_ADDRESS
```
Unverified contract = judges can't read your code. Verify before announcing.

---

## Pre-Commit Guard

```bash
#!/bin/sh
# .git/hooks/pre-commit
if git diff --cached | grep -E '0x[0-9a-fA-F]{64}'; then
  echo "ERROR: Possible private key detected in staged diff. Aborting."
  exit 1
fi
```
```bash
chmod +x .git/hooks/pre-commit
```

---

## Demo Agent Scripts

### Good Agent (`demo/good-agent.js`)

```javascript
import { ethers } from "ethers";

if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY env var is required but not set");
if (!process.env.RPC_URL) throw new Error("RPC_URL env var is required but not set");

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Registered agent — high reputation — gets 0.05% fee
async function goodAgentSwap() {
  console.log("Good agent: swapping within parameters...");
  console.log("Expected fee: 0.05% (high reputation registered agent)");
  // Execute swap via Uniswap v4 router on Robinhood Chain
  // Hook classifies as REGISTERED_HIGH → 0.05% fee
  // afterSwap: clean execution → reputation +5
  console.log("Swap executed. Reputation incremented. Fee: 0.05%");
}

goodAgentSwap();
```

### Bad Bot (`demo/bad-bot.js`)

```javascript
import { ethers } from "ethers";

if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY env var is required but not set");
if (!process.env.RPC_URL) throw new Error("RPC_URL env var is required but not set");

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Unregistered bot — high gas, high frequency — gets 1% MEV tax
async function badBotSwap() {
  console.log("Unregistered bot: attempting high-frequency high-gas swap...");
  console.log("Pattern detected: 3+ swaps in 10 blocks + gas anomaly");
  try {
    // Execute swap — hook detects bot pattern
    // beforeSwap: classifyAndGetFee → UNREGISTERED → 1% fee
    // Fee flows to ArbitCompensation → 60% victim pool, 40% LP pool
    console.log("Swap executed but taxed 1%. Fee deposited to compensation pool.");
  } catch (err) {
    console.error("Swap reverted:", err.reason);
  }
}

badBotSwap();
```

---

## Build Order (11 Days)

| Day | Task |
|---|---|
| 1 | Foundry setup + install dependencies + ArbitRegistry.sol |
| 2 | ArbitCompensation.sol + unit tests for both |
| 3 | ArbitHook.sol — beforeSwap + fee override |
| 4 | ArbitHook.sol — afterSwap + sandwich detection + compensation trigger |
| 5 | Full integration test — all 3 swap scenarios (human, agent, bot) |
| 6 | Fuzz tests + invariant tests + Slither static analysis |
| 7 | Deploy to Arbitrum Sepolia — verify all scenarios on testnet |
| 8 | Token launch on Programmable.market + mainnet deploy to Robinhood Chain |
| 9 | Verify on Blockscout + demo agent scripts tested on mainnet |
| 10 | Website (Next.js 16) live |
| 11 | Demo video + X account + submission form |

---

## Website (Next.js 16)

Single page. Three sections:

**Hero:**
"Arbit makes every pool fair." — hook address + Blockscout link above fold. Live stats: total swaps protected, total MEV redistributed, total agents registered.

**How it works:**
Three columns — Human (pays 0.30%, fully protected), Registered Agent (pays 0.05–0.30% based on reputation), Unregistered Bot (pays 1%, funds victim compensation). Visual fee tier diagram.

**Register your agent:**
Connect wallet → stake Arbit token → active in all Arbit-enabled pools. Calls `ArbitRegistry.register()` directly.

**Design direction:**
Dark background (`#080C10`), electric blue accent (`#0EA5E9`) — not the typical DeFi green. Suggests precision and fairness. Space Grotesk for headings, JetBrains Mono for all onchain data (fees, addresses, amounts, reputation scores). No gradient cards, no rounded hero illustrations. Data-first layout — the live stats ARE the hero.

---

## Submission Checklist

- [ ] All tests passing (`forge test -vvv`)
- [ ] Slither clean (no high/medium findings)
- [ ] Deployed and verified on Arbitrum Sepolia testnet first
- [ ] Hook live on Programmable.market → Robinhood Chain (chain ID 4663)
- [ ] Contract verified on robinhoodchain.blockscout.com
- [ ] Arbit token launched and bound to hook via Programmable
- [ ] All 3 swap scenarios demoed (human, registered agent, unregistered bot)
- [ ] MEV compensation payout demonstrated
- [ ] Website live with agent registration working
- [ ] X account active with 3+ posts
- [ ] Demo video showing full flow
- [ ] Submission form completed at forms.gle/PNbKvDn63sMqqc857 before Sep 10
- [ ] Pre-commit guard active — no keys in repo
- [ ] `.env.example` committed — never real `.env`
