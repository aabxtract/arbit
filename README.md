# Arbit — participant-priced Uniswap v4 hook on Robinhood Chain

Arbit is a Uniswap v4 hook where every swap is priced by **who is trading**.
Humans pay a standard fee, registered AI agents with good reputation pay less
and earn token rewards, and unregistered bots pay a surcharge that funds
victim compensation. A share of every fee feeds an onchain buyback pool that
market-buys and burns ARBT under a threshold + cooldown guard — so trading
volume reduces supply. Tokenized-stock pools earn boosted accruals at
discounted fees. Live on Robinhood testnet; launching on mainnet (4663) via
Programmable Custom Launch V4.

- Hookathon deadline: **Sep 10, 2026** · full spec: `arbit-final-build-guide.md`
- Website: `website/` (Next.js) · demo scripts: `demo/` · pack workspace: `pack/`

## Contracts (`src/`)

| Contract | Role |
|---|---|
| `ArbitToken.sol` | Fixed 1B ARBT, no mint/tax/pause/upgrade. Pack graph `token` target |
| `ArbitRegistry.sol` | Agent stake + reputation (0–1000), bot-pattern data, pool allowlist, keeper role |
| `ArbitHook.sol` | Dynamic-fee hook: classify once, split fees, Buyback Guard, stock-pool 1.5× subsidy, badge-holder halving |
| `ArbitFeeModule.sol` | View-only fee module for the exact kernel hook (module path): registry tiers → capped override, zero deltas |
| `ArbitDistributor.sol` | Creator-fee sidecar: claims vault revenue, Guard-gated market-buy + burn (80%), victim reserve (20%) |
| `ArbitInitializer.sol` | One-shot launch: funds hook, wires registry, inits pool, seeds locked LP, atomic first buy |
| `ArbitBadge.sol` | Achievement passes (Bronze/Silver/Gold) mirroring reputation; holders pay half fees |
| `ArbitAgentExecutor.sol` | Optional per-agent swap identity (off-graph tooling) |

Fee schedule: human 30bps (80% LP / 20% buyback), agent high 5 / med 15 / low 30bps
(up to 50% back as ARBT), bot 100bps (60% victim / 40% buyback+burn).
Stock pools: ⅔ fees, 1.5× accrual subsidy. Buyback Guard: threshold + 1h cooldown.

## Test report

```
forge build          # clean, solc 0.8.26
forge test           # 50 pass + 4 fork opt-in (~3s offline)
RUN_FORK_TESTS=1 forge test --match-contract 'KernelTest|MoneyLoopTest|ForkMainnetTest|TestnetDebugTest'
```

Coverage: fee flows (human/agent/bot, both swap directions), hookData identity,
single-classify cache, Guard block + fire, victim/reward claims + guards,
stock multiplier exact ratios, badge tiers + holder discount, registry
classification/reputation/slash, initializer atomic launch + locked LP,
kernel+module fee spread on mainnet fork, full money loop (swap → creator
fees → claim → buy → burn → victim payout) on mainnet fork.

## Audit report (summary — full table in `arbit-final-build-guide.md`)

- **Slither (102 detectors, `lib/` filtered): 0 high/medium.** Fixed from runs:
  SafeERC20 everywhere, constructor zero-checks, `HookSet` event, immutables,
  CEI flag-first in initializer (killed a reentrancy-eth), immutable launch
  wallet (killed arbitrary-from), chain-id deploy guards.
- **Accepted lows (documented):** L2 `tx.gasprice` signal weakness + 3-swap
  warm-up (one-shot bots escape — fund, not perfection, is the protection);
  fee-unit/ARBT denomination approximation (TWAP is post-hackathon); manual
  owner victim payouts; keeper-gated buybacks (TWAP later); stock-subsidy
  drain rate; previewFee pre-discount display; hook-held-balance trust.
- **Out of scope (stated):** fee-level economics, TWAP, offchain scripts,
  no external audit before deadline.

## Deployments

### Robinhood testnet 46630 (live, verified)

| Contract | Address |
|---|---|
| Mock ARBT | `0xd2cAA129a525D65684C112b074425E8d85a71533` |
| PoolManager (fresh) | `0x38d13B77728c357652313AA0a6fc97229F44CD8E` |
| Registry | `0x07f0118fe19c003D7AE90C7D43b4d1D3985eCa9b` |
| Hook | `0xb099980588E1458D678E5bdfe048A37f910A40C0` |

Explorer: `https://explorer.testnet.chain.robinhood.com` · faucet:
`faucet.testnet.chain.robinhood.com`. All three fee flows + native pool
confirmed onchain (buyback `47800300000000000`, victim `60000000000000000`).
Testnet build predates stock/badge features — redeploy for new-feature demos:
`forge script script/TestnetFlow.s.sol` (see guide).

### Local dry-run

```bash
anvil                                              # terminal 1
forge script script/SetupAnvil.s.sol --broadcast --rpc-url http://127.0.0.1:8545 --unlocked --sender <anvil-acct>
# set ARBT_TOKEN_ADDRESS + POOL_MANAGER_ADDRESS, then:
forge script script/DeployArbit.s.sol --broadcast --rpc-url http://127.0.0.1:8545 --unlocked --sender <anvil-acct>
```

### Mainnet via Programmable (chain 4663)

Canonical PoolManager: `0x8366a39CC670B4001A1121B8F6A443A643e40951`.
CLI 4.1.0 required (checksum-verified install, see guide). Order is fixed —
**inspect before launch, always**:

```bash
npm run build --prefix pack        # vendor + exact solc + config (needs env, see pack/build.mjs --help)
programmable-launch pack --config pack/programmable-launch.config.json --output pack/launch.json
programmable-launch validate pack/launch.json --config pack/programmable-launch.config.json --remote  # preflight: free, persists nothing
programmable-launch submit pack/launch.json --config pack/programmable-launch.config.json            # durable request
programmable-launch status LAUNCH_ID --api-version 4 --chain-id 4663 --watch --until authorized
# STOP — controller reviews + signs the exact wallet tx separately, then:
programmable-launch status LAUNCH_ID --api-version 4 --chain-id 4663 --watch --until finalized
```

Our preflight position: zero-module graph returns `needs_evidence` with zero
hard blocks (initial-buy proof + custody/admin disclosures); the fee-module
variant trips a server 500 (filed as platform feedback — module review lane).
Graph: token + kernel (exact kit) + registry + distributor + initializer
(+fee-module code-ready, parked). First buy ≥ server quote (~$1), gas watch
at ≤0.20 gwei, wallet signs with ~$5 total budget (see guide Budget section).

## Key design decisions (why)

- **Hook does no settlement math**: zero return deltas, so pool accounting
  bugs are impossible by construction; all value moves are plain ERC-20/SafeERC20.
- **Classify once, cache, clear**: beforeSwap classifies, afterSwap reuses —
  double-classification would skew bot counts and split a different fee.
- **`sender` ≠ user**: shared routers collapse all EOAs to one address, so
  identity travels via 32-byte hookData (or per-agent executors).
- **In-launch wiring via initializer**: the owner EOA cannot act inside the
  atomic launch tx, so `setHook`/`allowPool` are initializer-or-owner.
- **Locked seed LP, no withdraw path**: mirrors the reviewed seed recipe and
  removes a whole custody surface.
- **Backing caps everywhere**: rewards/victim/burns never promise more than
  the hook's real balance; shortfalls revert, never print.
