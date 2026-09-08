# Arbit — Programmable Hookathon Build Guide
**Deadline: September 10, 2026 | Prize: $10,000 | Today: Sep 3 — 7 days left**

> **Status (Sep 3): Contracts implemented — `forge test` green (28 tests: unit + 256-run fuzz + 2 invariants).** Source in `/src`, tests in `/test`, deploy script in `/script`. This guide is the spec; the repo is the implementation.

---

## What We're Building

Arbit is a Uniswap v4 hook that acts as an onchain policy enforcement layer for AI trading agents. Each agent deploys its own **`ArbitAgentExecutor`** contract — that address is the agent's onchain identity. The executor registers a strategy manifest, stakes Arbit token as collateral, and the hook enforces the declared rules on every swap — blocking violations and slashing stakes automatically.

**Why a per-agent executor?** In Uniswap v4, the `sender` a hook sees on `beforeSwap`/`afterSwap` is whatever contract called `PoolManager.swap` — normally the shared UniversalRouter. A shared router means every agent looks like the same address. Since the PoolManager lock requires `settle`/`take` inside the same transaction, an EOA can never be `sender` — so the executor contract is not optional, it is the only way to give each agent an enforceable identity. It also carries the try/catch that makes "block the swap + commit the slash" atomic (see Attack Vector 8).

**Demo story:** A well-behaved agent swaps within its manifest and earns reputation. A misbehaving agent attempts an oversized swap: the swap still executes, but the hook instantly slashes 10% of its stake to the treasury and suspends the agent — atomically, in one transaction. The misbehaving agent's next swap hard-blocks with "agent suspended". No human intervention. (Why the violating swap isn't reverted: see Attack Vector 8 — an EVM revert rolls back everything, including the slash.)

---

## Tech Stack

| Layer | Tool |
|---|---|
| Smart contracts | Solidity ^0.8.26 (solc 0.8.26 pinned by Programmable CLI) |
| Libraries | OpenZeppelin Contracts **v5.x** (`Ownable(msg.sender)` style, `utils/ReentrancyGuard.sol` path) |
| Hook framework | Uniswap v4 `IHooks` implemented directly (`BaseHook` was removed upstream in v4 1.0.x) |
| Agent identity | Per-agent `ArbitAgentExecutor` contract |
| Deploy | `programmable-launch` CLI |
| Chain | Robinhood Chain Mainnet — Chain ID 4663 (~$3 gas, confirmed preferred by devrel) |
| Demo agents | Node.js + ethers.js v6 |
| Website | Next.js + Tailwind |
| Token | Launched via Programmable.market UI |

---

## Security Guardrails

**Read this before writing a single line of contract code.** Real exploits have cost millions due to missing modifiers and reentrancy bugs in v4 hooks. Arbit has a slash mechanism that moves tokens — one security mistake means funds are at risk.

---

### Attack Vector 1 — Missing Access Control (Critical — $11M exploit)

In May 2025, Cork Protocol lost ~$11M after an attacker called an unauthenticated swap callback (`uniswapV4SwapCallback`) directly with crafted data — the callback had no check on who was calling. The lesson generalizes: **any entry point that moves funds or mutates state must verify who is allowed to call it.**

```solidity
// WRONG — attacker can call this directly
function beforeSwap(...) external override returns (...) { ... }

// CORRECT — only PoolManager can invoke this
function beforeSwap(...) external override onlyPoolManager returns (...) { ... }
function afterSwap(...) external override onlyPoolManager returns (...) { ... }
```

**Arbit rule:** `onlyPoolManager` on BOTH `beforeSwap` AND `afterSwap`. No exceptions. The slash logic in `beforeSwap` is especially critical — without this modifier an attacker can slash any agent's stake directly.

**Note:** `BaseHook` (v4-periphery) already applies `onlyPoolManager` to every callback. Keep the explicit modifier anyway — it costs nothing and documents the invariant.

---

### Attack Vector 2 — Reentrancy Through Hook Callbacks (High)

`afterSwap` calls `registry.updateAfterSwap()` which is an external call. If the registry ever touches a token contract, reentrancy is possible. Apply OpenZeppelin's `ReentrancyGuard` and always follow Checks-Effects-Interactions:

```solidity
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ArbitHook is BaseHook, ReentrancyGuard {

    function afterSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external override onlyPoolManager nonReentrant returns (bytes4, int128) {
        ArbitRegistry.Manifest memory m = registry.getManifest(sender);
        if (m.status == ArbitRegistry.AgentStatus.Active) {
            registry.updateAfterSwap(sender); // external call goes LAST
        }
        return (BaseHook.afterSwap.selector, 0);
    }
}
```

**In `ArbitRegistry.sol`:** every function that moves tokens (`register`, `slash`, `unregister`) does ALL state updates BEFORE any token transfer. See the reference implementation below.

---

### Attack Vector 3 — Cross-Pool State Contamination (High)

Arbit's registry is shared across any pool that uses the hook. An attacker could create a malicious pool using the same hook, manipulate reputation scores or stakes, and affect legitimate pools. Fix: scope state by `PoolId` AND maintain an allowlist of approved pools. **Use `key.toId()` from v4-core — never hand-roll the hash.**

```solidity
import {PoolId} from "v4-core/src/types/PoolId.sol";

// In ArbitRegistry.sol
mapping(PoolId => bool) public allowedPools;

function allowPool(PoolId poolId) external onlyOwner {
    allowedPools[poolId] = true;
}

// In ArbitHook.sol — validate pool on every callback
PoolId poolId = key.toId();
require(registry.allowedPools(poolId), "Arbit: unauthorized pool");
```

**Deploy step that is easy to miss:** after the pool is created, the owner MUST call `allowPool(poolId)` with the pool's ID — compute it with `key.toId()` offchain via a tiny script or foundry cast. Until then every swap through the hook reverts "Arbit: unauthorized pool". This step is in the Build Order and Submission Checklist — don't skip it.

---

### Attack Vector 4 — Permission Encoding Mismatches (Medium-High)

V4 hook permissions are encoded in the hook's deployment address bits. A mismatch between declared permissions and implemented functions causes silent skipping or DoS. Always use `BaseHook` and override `getHookPermissions()` explicitly:

```solidity
function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
    return Hooks.Permissions({
        beforeInitialize: false,
        afterInitialize: false,
        beforeAddLiquidity: false,
        afterAddLiquidity: false,
        beforeRemoveLiquidity: false,
        afterRemoveLiquidity: false,
        beforeSwap: true,   // ← must be true, we implement it
        afterSwap: true,    // ← must be true, we implement it
        beforeDonate: false,
        afterDonate: false,
        beforeSwapReturnDelta: false,  // ← false — we don't modify deltas
        afterSwapReturnDelta: false,   // ← false — we don't modify deltas
        afterAddLiquidityReturnDelta: false,
        afterRemoveLiquidityReturnDelta: false
    });
}
```

**Never set a return delta flag to true unless you implement delta modification** — it creates free swap vulnerabilities.

---

### Attack Vector 5 — Slash Logic Bounds (Critical for Arbit)

The slash mechanism is Arbit's most dangerous function. Three rules:

**Validate the violation type** — never let an unvalidated enum pick a slash amount:
```solidity
require(violationType == 1 || violationType == 2, "Arbit: bad violationType");
```

**Integer underflow:** Solidity 0.8.x has built-in overflow protection but be explicit:
```solidity
uint256 slashAmount = violationType == 1 ? maxSlash : maxSlash / 2;
m.stakedAmount -= slashAmount; // slashAmount <= stakedAmount by construction — cannot underflow
```

**Slash cap — never slash more than max % per violation:**
```solidity
uint256 public constant MAX_SLASH_PERCENT = 10; // max 10% per violation

uint256 maxSlash = (m.stakedAmount * MAX_SLASH_PERCENT) / 100;
uint256 slashAmount = violationType == 1 ? maxSlash : maxSlash / 2; // 10% / 5%
```

---

### Attack Vector 6 — Gas Griefing (Medium)

Arbit's `beforeSwap` runs on EVERY swap. Keep it O(1) — no loops, no unbounded operations. The current implementation reads one mapping and does arithmetic — that's correct. Never add iteration in hook callbacks.

---

### Attack Vector 7 — Registry Authorization (Critical)

`ArbitRegistry.setHook()` must never be callable by anyone after deployment. Lock it down with `Ownable` immediately:

```solidity
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract ArbitRegistry is Ownable, ReentrancyGuard {

    bool private hookSet;

    function setHook(address _hook) external onlyOwner {
        require(!hookSet, "Hook already set"); // set once, never change
        hook = _hook;
        hookSet = true;
    }
}
```

---

### Attack Vector 8 — Slash Rolled Back by the Swap Revert (Critical, Arbit-specific)

The instinctive design is: detect violation in `beforeSwap` → slash → `revert` to block the swap. **This silently deletes the slash, even if the caller catches the revert.** EVM revert semantics are subtree-wide: when a frame reverts, ALL state changes made in that frame and its completed sub-calls roll back. Catching the revert in an outer frame (e.g. the executor's try/catch) keeps the transaction alive but does NOT resurrect the sub-call's writes — they were journaled inside the reverting frame. Verified empirically: the slash call succeeds in the trace, the revert is caught, the tx succeeds, and the manifest is unchanged.

```solidity
// WRONG — the slash and the revert share a call subtree
function beforeSwap(...) external onlyPoolManager returns (...) {
    registry.slash(sender, 1);   // succeeds…
    revert("Arbit: swap size violation"); // …and is rolled back WITH the revert
}
```

**The fix — penalty lane:** slash WITHOUT reverting, and let the violating swap execute:

```solidity
// RIGHT — the slash commits because nothing in this frame reverts afterward
if (swapSize > m.maxSwapSize) {
    registry.slash(sender, 1);   // persists: swap continues, tx succeeds
    emit SwapPenalized(sender, 1);
}
```

The hard block comes from **suspension**: once stake drops below `MIN_STAKE`, the agent's status flips to `Suspended` and every later swap reverts. Reverting is only safe where NO state has been touched in the frame — the allowlist check and the suspended check revert before anything is written, so those blocks are free. Consequences:

- The penalty lane works identically through bare routers and the executor — no try/catch required for enforcement. The executor's catch remains for graceful UX (contain suspended/allowlist reverts, recover pulled input tokens via `rescue()`).
- If the swap itself fails AFTER the penalty slash (e.g. insufficient liquidity), the penalty rolls back with it — acceptable: a swap that didn't execute is nothing to punish.
- A violating swap must never both slash AND revert in the same frame. Ever.

---

### Agent Status: Suspended ≠ Unregistered

A naive `bool active` conflates two different cases with opposite behavior:

- **Never registered** (`AgentStatus.None`) — let them swap. Humans and unrelated contracts must be able to use the pool.
- **Suspended** (slashed below `MIN_STAKE`) — hard block. Otherwise a slashed agent is treated as "unregistered" and trades unlimited again.

Use an enum and handle all three states explicitly in `beforeSwap`.

---

### Security Checklist (run before deploy)

| # | Check | Severity |
|---|---|---|
| 1 | `onlyPoolManager` on ALL hook callbacks (`beforeSwap`, `afterSwap`) | Critical |
| 2 | `nonReentrant` on registry `register()`, `slash()`, `unregister()`, `updateAfterSwap()` | High |
| 3 | CEI everywhere: all state before token transfers in `register()`, `slash()`, `unregister()` | High |
| 4 | Pool allowlist typed `PoolId`, checked in `beforeSwap` via `key.toId()` | High |
| 5 | `getHookPermissions()` matches implemented functions exactly | Medium |
| 6 | No return delta flags set (Arbit doesn't modify deltas) | Critical |
| 7 | Slash capped at `MAX_SLASH_PERCENT`; `violationType` validated (1 or 2 only) | Critical |
| 8 | `setHook()` protected by `onlyOwner` + set-once guard | Critical |
| 9 | Penalty lane: violations slashed WITHOUT reverting (revert = rollback); reverts only where no state was touched (allowlist, suspended) | Critical |
| 10 | Suspended agents hard-blocked; never-registered addresses allowed through | High |
| 11 | Stake exit exists: `unregister()` returns remaining stake, zeroes state (no orphaned stake) | High |
| 12 | No loops in `beforeSwap` or `afterSwap` | Medium |
| 13 | Contract verified on robinhoodchain.blockscout.com post-deploy | High |

---

### Foundry Test Commands (run all before submitting)

```bash
# Install Foundry — on Windows use WSL
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Run unit tests
forge test -vvv

# Fuzz test the slash logic
forge test --match-test testSlashFuzz -vvv

# Invariant test — stake never goes negative, suspended agents can't trade
forge test --match-test invariant_stakeNeverNegative -vvv
forge test --match-test invariant_suspendedCannotSwap -vvv

# Static analysis (Linux/WSL)
pip install slither-analyzer --break-system-packages
slither . --solc-remaps "@openzeppelin=lib/openzeppelin-contracts v4-core=lib/v4-core v4-periphery=lib/v4-periphery"
```

Must-have test cases:
- compliant swap passes, reputation increments, `lastSwapTime` updates
- oversized swap → swap still executes, stake slashed to treasury, agent suspended (penalty lane — identical via executor AND bare router)
- suspended agent's next swap reverts "Arbit: agent suspended" (executor: caught + `SwapBlocked`; bare router: tx reverts)
- never-registered address swaps freely
- frequency violation slashes 5%; first swap ever is exempt
- `unregister()` returns remaining stake; re-register afterwards works cleanly
- unallowed pool reverts with NO slash; `allowPool` fixes it
- non-owner cannot `setHook`/`allowPool`; hook cannot be reset
- invariant: stake conservation (staked + treasury == deposited − withdrawn)

---

## Contract Architecture

Four contracts. Keep them separate and lean.

### 1. `ArbitRegistry.sol`
Stores agent manifests, stakes, reputation scores, and the pool allowlist. Holds staked tokens; slashed tokens go to the treasury.

> The shipped implementation uses custom errors (`StakeBelowMinimum`, `OnlyHook`, …) instead of `require` strings — same semantics, cheaper gas.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

contract ArbitRegistry is Ownable, ReentrancyGuard {
    enum AgentStatus { None, Active, Suspended }

    struct Manifest {
        uint256 maxSwapSize;      // in units of the swap's input currency (see Known Limitations)
        uint256 frequencyCap;     // min seconds between swaps
        uint256 stakedAmount;     // Arbit tokens staked
        uint256 reputationScore;  // starts at 100
        uint256 lastSwapTime;
        AgentStatus status;
    }

    mapping(address => Manifest) public manifests;
    mapping(PoolId => bool) public allowedPools;

    IERC20 public immutable arbitToken;
    address public immutable treasury;
    address public hook;
    bool private hookSet;

    uint256 public constant MIN_STAKE = 100e18;       // 100 ARBT minimum
    uint256 public constant MAX_SLASH_PERCENT = 10;   // max 10% slash per violation
    uint256 public constant MAX_FREQUENCY_CAP = 7 days;

    event AgentRegistered(address indexed agent, uint256 stake);
    event AgentUnregistered(address indexed agent, uint256 amount);
    event AgentSlashed(address indexed agent, uint256 amount, uint8 violationType);
    event AgentSuspended(address indexed agent);
    event ReputationUpdated(address indexed agent, uint256 newScore);
    event PoolAllowed(PoolId indexed poolId);

    modifier onlyHook() {
        require(msg.sender == hook, "Arbit: only hook");
        _;
    }

    constructor(address _arbitToken, address _treasury) Ownable(msg.sender) {
        require(_arbitToken != address(0) && _treasury != address(0), "Zero address");
        arbitToken = IERC20(_arbitToken);
        treasury = _treasury;
    }

    // Set once — owner only, can never be changed after
    function setHook(address _hook) external onlyOwner {
        require(!hookSet, "Arbit: hook already set");
        require(_hook != address(0), "Zero address");
        hook = _hook;
        hookSet = true;
    }

    // Owner approves which pools can use this registry
    function allowPool(PoolId poolId) external onlyOwner {
        allowedPools[poolId] = true;
        emit PoolAllowed(poolId);
    }

    // Called BY the agent's executor — the executor address is the agent identity
    function register(uint256 maxSwapSize, uint256 frequencyCap, uint256 stakeAmount) external nonReentrant {
        require(stakeAmount >= MIN_STAKE, "Arbit: stake below minimum");
        require(maxSwapSize > 0, "Arbit: maxSwapSize must be > 0");
        require(frequencyCap <= MAX_FREQUENCY_CAP, "Arbit: frequencyCap too high");
        require(manifests[msg.sender].status == AgentStatus.None, "Arbit: already registered");

        // EFFECTS first (CEI) — token is a fixed-supply standard ERC20 with no transfer hooks
        manifests[msg.sender] = Manifest({
            maxSwapSize: maxSwapSize,
            frequencyCap: frequencyCap,
            stakedAmount: stakeAmount,
            reputationScore: 100,
            lastSwapTime: 0,
            status: AgentStatus.Active
        });

        // INTERACTIONS last
        arbitToken.transferFrom(msg.sender, address(this), stakeAmount);

        emit AgentRegistered(msg.sender, stakeAmount);
    }

    /// Exit path — works for Active and Suspended agents. No orphaned stake, ever.
    function unregister() external nonReentrant {
        Manifest storage m = manifests[msg.sender];
        uint256 remaining = m.stakedAmount;
        require(remaining > 0, "Arbit: nothing staked");

        // EFFECTS
        m.stakedAmount = 0;
        m.status = AgentStatus.None;

        // INTERACTIONS
        arbitToken.transfer(msg.sender, remaining);

        emit AgentUnregistered(msg.sender, remaining);
    }

    function slash(address agent, uint8 violationType) external onlyHook nonReentrant {
        require(violationType == 1 || violationType == 2, "Arbit: bad violationType");
        Manifest storage m = manifests[agent];
        require(m.status == AgentStatus.Active, "Arbit: agent not active");

        // EFFECTS — all state before any interaction
        uint256 maxSlash = (m.stakedAmount * MAX_SLASH_PERCENT) / 100;
        uint256 slashAmount = violationType == 1 ? maxSlash : maxSlash / 2;
        m.stakedAmount -= slashAmount;
        m.reputationScore = m.reputationScore > 10 ? m.reputationScore - 10 : 0;
        if (m.stakedAmount < MIN_STAKE) {
            m.status = AgentStatus.Suspended;
            emit AgentSuspended(agent);
        }

        // INTERACTIONS — slashed stake goes to the treasury, not a black hole
        arbitToken.transfer(treasury, slashAmount);

        emit AgentSlashed(agent, slashAmount, violationType);
    }

    function updateAfterSwap(address agent) external onlyHook nonReentrant {
        Manifest storage m = manifests[agent];
        require(m.status == AgentStatus.Active, "Arbit: agent not active");
        m.lastSwapTime = block.timestamp;
        if (m.reputationScore < 100) m.reputationScore += 1;
        emit ReputationUpdated(agent, m.reputationScore);
    }

    function getManifest(address agent) external view returns (Manifest memory) {
        return manifests[agent];
    }
}
```

### 2. `ArbitHook.sol`
The Uniswap v4 hook. Read-heavy `beforeSwap`, O(1) checks, penalty lane on violations. Implements `IHooks` directly — `BaseHook` was removed upstream in v4 1.0.x — and validates its own permission bits in the constructor. The 8 unused callbacks are explicit stubs that revert (their permission bits are off, so PoolManager never calls them).

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ArbitRegistry} from "./ArbitRegistry.sol";

contract ArbitHook is IHooks, ReentrancyGuard {
    IPoolManager public immutable poolManager;
    ArbitRegistry public immutable registry;

    event SwapAllowed(address indexed executor, uint256 reputationScore);
    event SwapPenalized(address indexed executor, uint8 violationType);

    error PoolManagerOnly();
    error Unimplemented();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert PoolManagerOnly();
        _;
    }

    constructor(IPoolManager _poolManager, ArbitRegistry _registry) {
        poolManager = _poolManager;
        registry = _registry;
        // Fails fast if the CREATE2 address does not carry exactly our permission bits
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
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
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata
    ) external override onlyPoolManager nonReentrant returns (bytes4, BeforeSwapDelta, uint24) {
        // 1. Pool allowlist — prevents cross-pool contamination (Attack Vector 3).
        //    Safe to revert: nothing has been written in this frame yet.
        PoolId poolId = key.toId();
        require(registry.allowedPools(poolId), "Arbit: unauthorized pool");

        // 2. `sender` is the contract that called PoolManager.swap — in our
        //    architecture that is always the agent's own ArbitAgentExecutor.
        ArbitRegistry.Manifest memory m = registry.getManifest(sender);

        if (m.status == ArbitRegistry.AgentStatus.None) {
            // Never registered — humans and unrelated contracts swap freely
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        if (m.status == ArbitRegistry.AgentStatus.Suspended) {
            // Slashed below MIN_STAKE earlier — hard block. Safe to revert:
            // no state touched yet.
            revert("Arbit: agent suspended");
        }

        // 3. Swap size check — O(1), no loops
        uint256 swapSize = params.amountSpecified < 0
            ? uint256(-params.amountSpecified)
            : uint256(params.amountSpecified);

        // 4. PENALTY LANE (Attack Vector 8): a violating swap is slashed but
        //    still executes — reverting here would roll the slash back with it.
        //    The hard block comes from suspension on the next attempt.
        if (swapSize > m.maxSwapSize) {
            registry.slash(sender, 1); // violationType 1 = size violation
            emit SwapPenalized(sender, 1);
        } else if (m.lastSwapTime != 0 && block.timestamp - m.lastSwapTime < m.frequencyCap) {
            // first swap is always exempt (lastSwapTime == 0)
            registry.slash(sender, 2); // violationType 2 = frequency violation
            emit SwapPenalized(sender, 2);
        }

        emit SwapAllowed(sender, m.reputationScore);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(
        address sender,
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external override onlyPoolManager nonReentrant returns (bytes4, int128) {
        ArbitRegistry.Manifest memory m = registry.getManifest(sender);
        if (m.status == ArbitRegistry.AgentStatus.Active) {
            registry.updateAfterSwap(sender); // reputation +1, lastSwapTime set
        }
        return (IHooks.afterSwap.selector, 0);
    }

    // ---- Unused callbacks: permission bits are off, PoolManager never calls
    // these. They revert loudly in case the address bits are ever wrong. ----

    function beforeInitialize(address, PoolKey calldata, uint160) external override onlyPoolManager returns (bytes4) {
        revert Unimplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24)
        external override onlyPoolManager returns (bytes4)
    {
        revert Unimplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external override onlyPoolManager returns (bytes4)
    {
        revert Unimplemented();
    }

    function afterAddLiquidity(
        address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata
    ) external override onlyPoolManager returns (bytes4, BalanceDelta) {
        revert Unimplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external override onlyPoolManager returns (bytes4)
    {
        revert Unimplemented();
    }

    function afterRemoveLiquidity(
        address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata
    ) external override onlyPoolManager returns (bytes4, BalanceDelta) {
        revert Unimplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external override onlyPoolManager returns (bytes4)
    {
        revert Unimplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external override onlyPoolManager returns (bytes4)
    {
        revert Unimplemented();
    }
}
```

> The `SwapParams` struct lives in `v4-core/src/types/PoolOperation.sol` in v4-core 1.0.x (it is no longer `IPoolManager.SwapParams`), and `PoolManager`'s constructor takes `(address initialOwner)`. `IUnlockCallback` moved to `v4-core/src/interfaces/callback/IUnlockCallback.sol`.

### 3. `ArbitAgentExecutor.sol`
One per agent. Its address IS the agent's onchain identity — it is the `sender` the hook sees. Enforcement itself works through bare routers too (penalty lane), but the executor's try/catch keeps blocked-swap transactions graceful (suspension/allowlist reverts are contained, pulled input tokens recoverable via `rescue()`).

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ArbitRegistry} from "./ArbitRegistry.sol";

contract ArbitAgentExecutor is IUnlockCallback {
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

    function register(uint256 maxSwapSize, uint256 frequencyCap, uint256 stakeAmount) external onlyAgent {
        IERC20(registry.arbitToken()).transferFrom(agent, address(this), stakeAmount);
        IERC20(registry.arbitToken()).approve(address(registry), stakeAmount);
        registry.register(maxSwapSize, frequencyCap, stakeAmount);
    }

    /// Exit path — returns remaining stake from the registry to this executor.
    function unregister() external onlyAgent {
        registry.unregister();
    }

    // ---- Swaps (MVP: ERC20 x ERC20 pools only — see Known Limitations) ----

    function swapExactInputSingle(
        PoolKey calldata key,
        bool zeroForOne,
        uint256 amountIn,
        bytes calldata hookData
    ) external onlyAgent {
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        // Executor pulls input tokens from the agent up front (approve first).
        // If the swap gets blocked, the tokens stay here — recover with rescue().
        IERC20(Currency.unwrap(input)).transferFrom(agent, address(this), amountIn);
        manager.unlock(abi.encodeCall(this._doSwap, (key, zeroForOne, amountIn, hookData)));
    }

    // Called by PoolManager after unlock() — self-dispatches into _doSwap.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert Unauthorized();
        (bool success, bytes memory returnData) = address(this).call(data);
        if (!success) {
            assembly { revert(add(returnData, 32), mload(returnData)) }
        }
        return returnData;
    }

    function _doSwap(
        PoolKey calldata key,
        bool zeroForOne,
        uint256 amountIn,
        bytes calldata hookData
    ) external {
        if (msg.sender != address(this)) revert Unauthorized();

        try manager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn), // exact input
                // "no limit": widest valid price band for this direction
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            hookData
        ) returns (BalanceDelta delta) {
            _settle(key, delta);
            emit SwapExecuted(address(this), amountIn);
        } catch (bytes memory revertData) {
            // The hook blocked the swap (suspended / unauthorized pool / unexpected
            // failure). Violation penalties are NOT reverted by the hook (penalty
            // lane), so catching here never hides a slash — it just keeps the
            // transaction graceful and the pulled input tokens recoverable.
            emit SwapBlocked(address(this), revertData);
        }
    }

    function _settle(PoolKey calldata key, BalanceDelta delta) private {
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        if (d0 < 0) _pay(key.currency0, uint128(uint256(-int256(d0))));
        else if (d0 > 0) manager.take(key.currency0, address(this), uint128(uint256(int256(d0))));
        if (d1 < 0) _pay(key.currency1, uint128(uint256(-int256(d1))));
        else if (d1 > 0) manager.take(key.currency1, address(this), uint128(uint256(int256(d1))));
    }

    function _pay(Currency currency, uint128 amount) private {
        if (currency.isAddressZero()) {
            manager.settle{value: amount}();
        } else {
            manager.sync(currency);
            IERC20(Currency.unwrap(currency)).transfer(address(manager), amount);
            manager.settle();
        }
    }

    // ---- Recovery ----

    function rescue(Currency currency, uint256 amount) external onlyAgent {
        if (currency.isAddressZero()) {
            (bool ok, ) = agent.call{value: amount}("");
            require(ok, "Arbit: ETH transfer failed");
        } else {
            IERC20(Currency.unwrap(currency)).transfer(agent, amount);
        }
    }
}
```

### 4. Arbit Token
Launch via Programmable.market UI — standard ERC-20, fixed supply. Name: **Arbit**, ticker: **ARBT**. No mint/tax/pause controls (Programmable will reject those). Once launched, copy the token address into the registry constructor along with a treasury address (any owner-controlled EOA or multisig).

---

## Pre-Commit Guard

Add this to your repo before any private key or wallet operations:

```bash
#!/bin/sh
# .git/hooks/pre-commit
if git diff --cached | grep -E '0x[0-9a-fA-F]{64}'; then
  echo "ERROR: Possible private key detected in staged diff. Aborting commit."
  exit 1
fi
```

```bash
chmod +x .git/hooks/pre-commit
```

---

## Environment Setup

```bash
# Never use fallback patterns — throw explicitly if missing
if (!process.env.PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY env var is required but not set");
}
```

```env
# .env (never commit this)
PRIVATE_KEY=your_deployer_wallet_private_key
RPC_URL=https://mainnet.robinhood.com   # Robinhood Chain mainnet RPC (chain ID 4663)
ARBT_TOKEN_ADDRESS=
REGISTRY_ADDRESS=
HOOK_ADDRESS=
POOL_MANAGER_ADDRESS=
TREASURY_ADDRESS=
POOL_KEY_JSON={"currency0":"0x...","currency1":"0x...","fee":500,"tickSpacing":10,"hooks":"0x..."}
EXECUTOR_ADDRESS=                       # per agent; set when reusing a deployed executor
EXECUTOR_BYTECODE=                      # from forge build artifacts — used by the demo scripts
```

---

## Programmable CLI Deployment Flow

**Network context:** Robinhood Chain (chain ID 4663) is an Ethereum L2 built with Arbitrum technology. It launched publicly July 1, 2026 and already has a thriving hook ecosystem (Hookr.fun, HookForge). Programmable.market is the *custom code* path — unlike Hookr.fun's no-code blocks, you write your own Solidity and deploy via CLI. Devrel confirmed Robinhood Chain deployment is preferred for this hackathon.

**Add Robinhood Chain to your wallet:**
- Network name: Robinhood Chain
- Chain ID: 4663
- RPC: https://mainnet.robinhood.com
- Block explorer: robinhoodchain.blockscout.com

**Deployment order (dependencies matter):**

1. Launch ARBT on Programmable.market → copy token address
2. `programmatic-launch submit` bundle (registry + hook + executor) → copy hook + registry addresses
3. `registry.setHook(hookAddress)` — owner, set-once
4. Create the pool through Programmable (token + hook)
5. Compute the pool's `PoolId` (via `key.toId()`) and call `registry.allowPool(poolId)` — **until this step every swap reverts "Arbit: unauthorized pool"**
6. Deploy one `ArbitAgentExecutor` per demo agent; register via executor
7. Verify everything on robinhoodchain.blockscout.com

**Hook address mining:** v4 encodes hook permissions in the deployment address's low bits. If the address doesn't carry the `beforeSwap` + `afterSwap` bits, the PoolManager **silently skips your hook** — the demo will look like it works while enforcing nothing. `programmable-launch submit` mines the CREATE2 salt for you; if you deploy manually with `forge create`, mine an address with the correct permission bits first.

```bash
# Install
npm install -g programmable-launch

# Pack your bundle — Programmable uses exact solc 0.8.26
programmable-launch pack ./contracts

# Validate remotely (catches the 7 hard-block rules)
# Targets Robinhood Chain by default once Programmable enables it
programmable-launch validate --remote --network robinhood

# Submit to Robinhood Chain
programmable-launch submit --network robinhood

# Watch until authorized
programmable-launch status --watch --until authorized

# Your wallet signs the final transaction
# Hook + token + pool are now live on Robinhood Chain (chain ID 4663)
# Verify contract on robinhoodchain.blockscout.com immediately after deploy
```

**Important:** Verify your contract on robinhoodchain.blockscout.com right after deploy. An unverified contract means judges can't read your code — verify before you announce.

**The 7 things Programmable hard-blocks — avoid all of these:**
1. Proxy / delegatecall patterns (the executor's `address(this).call` self-dispatch is a plain external call, not a delegatecall — but validate early to be sure)
2. Mint controls post-launch
3. Tax mechanisms
4. Pause controls
5. Liquidity removal by owner
6. Return delta surfaces without evidence (this is why there is no fee rebate feature — see Known Limitations)
7. Non-standard approval flows (the executor uses standard `approve`/`transferFrom` throughout)

---

## Demo Agent Scripts

Two Node.js scripts, ethers.js v6. Both perform real onchain steps: deploy executor → approve → register → swap. Get `EXECUTOR_BYTECODE` from `forge build` artifacts (`out/ArbitAgentExecutor.sol/ArbitAgentExecutor.json` → `bytecode.object`).

### Good Agent (`good-agent.js`)
```javascript
import { ethers } from "ethers";
import { readFileSync } from "fs";

if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY env var is required but not set");
const { ARBT_ADDRESS, REGISTRY_ADDRESS, POOL_MANAGER_ADDRESS, POOL_KEY_JSON, RPC_URL } = process.env;
for (const v of [ARBT_ADDRESS, REGISTRY_ADDRESS, POOL_MANAGER_ADDRESS, POOL_KEY_JSON, RPC_URL]) {
  if (!v) throw new Error("Missing required env var");
}

const provider = new ethers.JsonRpcProvider(RPC_URL); // Robinhood Chain, chain ID 4663
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const TOKEN_ABI    = ["function approve(address,uint256) returns (bool)"];
const REGISTRY_ABI = ["function getManifest(address) view returns (tuple(uint256 maxSwapSize,uint256 frequencyCap,uint256 stakedAmount,uint256 reputationScore,uint256 lastSwapTime,uint8 status))"];
const EXECUTOR_ABI = [
  "constructor(address manager, address registry)",
  "function register(uint256 maxSwapSize, uint256 frequencyCap, uint256 stakeAmount)",
  "function swapExactInputSingle(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, bool zeroForOne, uint256 amountIn, bytes hookData)",
];

const token = new ethers.Contract(ARBT_ADDRESS, TOKEN_ABI, wallet);
const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, wallet);
const poolKey = JSON.parse(POOL_KEY_JSON);

const MAX_SWAP_SIZE = ethers.parseEther("50"); // manifest cap
const FREQUENCY_CAP = 60n;                     // 60s between swaps
const STAKE = ethers.parseEther("100");        // MIN_STAKE

// 1. Deploy the per-agent executor — its address IS the agent identity
const artifact = JSON.parse(readFileSync("out/ArbitAgentExecutor.sol/ArbitAgentExecutor.json", "utf8"));
const factory = new ethers.ContractFactory(EXECUTOR_ABI, artifact.bytecode.object, wallet);
const executor = await factory.deploy(POOL_MANAGER_ADDRESS, REGISTRY_ADDRESS);
await executor.waitForDeployment();
const executorAddress = await executor.getAddress();
console.log("Executor deployed (agent identity):", executorAddress);

// 2. Approve ARBT to the executor, register through it
await (await token.approve(executorAddress, STAKE)).wait();
await (await executor.register(MAX_SWAP_SIZE, FREQUENCY_CAP, STAKE)).wait();
console.log("Registered: maxSwapSize 50, frequencyCap 60s, stake 100 ARBT");

// 3. Compliant swap: 10 ARBT in — well under the 50 cap. Executor pulls input tokens.
const SWAP_SIZE = ethers.parseEther("10");
await (await token.approve(executorAddress, SWAP_SIZE)).wait();
const swapTx = await executor.swapExactInputSingle(poolKey, true, SWAP_SIZE, "0x");
const receipt = await swapTx.wait();
console.log("Swap allowed. tx:", receipt.hash);

// 4. Reputation should have incremented and lastSwapTime be set
const m = await registry.getManifest(executorAddress);
console.log(`Stake: ${ethers.formatEther(m.stakedAmount)} ARBT | Reputation: ${m.reputationScore}`);
```

### Bad Agent (`bad-agent.js`)
```javascript
import { ethers } from "ethers";
// Run the registration flow from good-agent.js first with a fresh wallet/executor,
// then set EXECUTOR_ADDRESS to that executor.

if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY env var is required but not set");
const { ARBT_ADDRESS, REGISTRY_ADDRESS, POOL_KEY_JSON, RPC_URL, EXECUTOR_ADDRESS } = process.env;
for (const v of [ARBT_ADDRESS, REGISTRY_ADDRESS, POOL_KEY_JSON, RPC_URL, EXECUTOR_ADDRESS]) {
  if (!v) throw new Error("Missing required env var");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const REGISTRY_ABI = [
  "function getManifest(address) view returns (tuple(uint256 maxSwapSize,uint256 frequencyCap,uint256 stakedAmount,uint256 reputationScore,uint256 lastSwapTime,uint8 status))",
  "event AgentSlashed(address indexed agent, uint256 amount, uint8 violationType)",
];
const EXECUTOR_ABI = [
  "function swapExactInputSingle(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, bool zeroForOne, uint256 amountIn, bytes hookData)",
  "event SwapBlocked(address indexed executor, bytes revertData)",
];
const TOKEN_ABI = ["function approve(address,uint256) returns (bool)"];

const token = new ethers.Contract(ARBT_ADDRESS, TOKEN_ABI, wallet);
const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, wallet);
const executor = new ethers.Contract(EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);
const poolKey = JSON.parse(POOL_KEY_JSON);

// Swap OVER manifest limit — 999 vs a 50 cap. PENALTY LANE: the violating
// swap still executes, and the slash + suspension commit in the SAME
// successful transaction (AgentSlashed/SwapPenalized land in the receipt).
const SWAP_SIZE = ethers.parseEther("999");
await (await token.approve(EXECUTOR_ADDRESS, SWAP_SIZE)).wait();
const tx = await executor.swapExactInputSingle(poolKey, true, SWAP_SIZE, "0x");
const receipt = await tx.wait();
console.log("Violating swap executed + penalized atomically:", receipt.hash);

const penalizedTopic = hook.interface.getEvent("SwapPenalized").topicHash;
const slashedTopic = registry.interface.getEvent("AgentSlashed").topicHash;
for (const log of receipt.logs) {
  if (log.topics[0] === penalizedTopic) console.log("Manifest violated — penalized");
  if (log.topics[0] === slashedTopic) console.log("Stake slashed to treasury");
}

// Status 2 = Suspended, stake should show the 10% cut
const m = await registry.getManifest(EXECUTOR_ADDRESS);
console.log(`Status: ${m.status} | Stake: ${ethers.formatEther(m.stakedAmount)} ARBT`);

// The NEXT attempt hard-blocks: the hook reverts "Arbit: agent suspended",
// the executor catches it and emits SwapBlocked — tx succeeds, no swap happened.
```

---

## Build Order (Sep 3–10 — 7 days)

| Date | Task |
|---|---|
| Sep 3–4 | `ArbitRegistry.sol` + `ArbitAgentExecutor.sol` + unit tests |
| Sep 5 | `ArbitHook.sol` + integration tests (fuzz + invariant) |
| Sep 6 | Launch ARBT on Programmable.market → deploy bundle → `setHook` → verify on blockscout → create pool → `allowPool(poolId)` |
| Sep 7 | Demo agent scripts end-to-end on mainnet (good + bad agent full flow) |
| Sep 8 | Website (Next.js template + registration widget calling `executor.register()`) |
| Sep 9 | Record demo video, X posts, **submit the form — do not wait for the deadline** |
| Sep 10 | Deadline. Buffer only — everything should already be submitted. |

---

## Website (Next.js)

Single page. Three sections:

1. **Hero** — "Arbit enforces what AI agents promise." Hook address + live pool link above the fold
2. **How it works** — Deploy executor → Register manifest + stake ARBT → Hook enforces → Reputation builds (or you get slashed and suspended). Four steps, no fluff
3. **Register your agent** — Connect wallet, approve ARBT, deploy executor, input manifest params, stake. Calls `executor.register()` directly (the executor registers itself as the agent identity). A tiny executor factory contract is a stretch goal — the demo deploys executors via script

Design direction: dark background, monospace font for all onchain data (addresses, scores, amounts), single amber/orange accent — feels like a terminal meets a trading dashboard. No gradients, no cards, no hero illustrations.

---

## Known Limitations (be upfront with judges — this reads as maturity, not weakness)

1. **Enforcement is opt-in.** The hook binds whatever address calls `PoolManager.swap`. A registered agent that routes around its executor is treated as unregistered — unbound, but also unslashable. This matches a broker-compliance model (the agent's registered identity follows its own declared rules); adversarial enforcement against identities that can route around enforcement is a post-hackathon problem.
2. **`maxSwapSize` is denominated in the swap's input currency.** A 10 WETH swap and a 10 ARBT swap hit the same numeric cap. Register conservatively; per-currency caps are post-hackathon.
3. **Executor MVP handles ERC20×ERC20 pools only.** Native-ETH pools need a payable variant of the executor.
4. **No slippage rule in the MVP manifest.** Enforcing slippage needs pre-quotes and/or return deltas — and Programmable hard-blocks return delta surfaces (rule 6). Dropped deliberately rather than shipped unenforceable.
5. **No fee rebate.** The original pitch promised one; it requires `afterSwapReturnDelta`, which is disabled and hard-blocked. Well-behaved agents earn reputation instead.
6. **A blocked swap's input tokens sit in the executor** until the next compliant swap or `rescue()`. Cosmetic, recoverable.
7. **A penalty that never lands:** if the swap itself fails after the penalty slash (e.g. insufficient liquidity), the penalty rolls back with it — a swap that never executed is nothing to punish.

---

## Submission Checklist

- [ ] Hook live on Programmable.market deployed to Robinhood Chain (chain ID 4663)
- [ ] Contract verified on robinhoodchain.blockscout.com
- [ ] Arbit token launched and bound to hook (`setHook` called, can't be reset)
- [ ] Pool created AND `allowPool(poolId)` executed
- [ ] Per-agent executors deployed for both demo agents
- [ ] Website live with working agent registration (approve → deploy executor → register)
- [ ] X account active with at least 3 posts
- [ ] Demo video showing good agent (swap + reputation) AND bad agent (blocked swap + slash + suspension + hard-block on retry)
- [ ] Form submitted at forms.gle/PNbKvDn63sMqqc857 before Sep 10
