"use client";

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import {
  CONFIG,
  HOOK_ABI,
  REGISTRY_ABI,
  ERC20_ABI,
  truncateAddress,
  fetchOnchainHookState,
  fetchAgentStatus
} from "../lib/contracts";
import { BackgroundRippleEffect } from "../components/ui/background-ripple-effect";

export default function ArbitDappPage() {
  // Wallet State
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);

  // Live Onchain Data State
  const [hookStats, setHookStats] = useState({
    buybackPoolFormatted: "1,248.50",
    victimPoolFormatted: "864.20",
    burnedFormatted: "28,450.00",
    lastBuybackTime: Math.floor(Date.now() / 1000) - 2400,
    nextBuybackEligible: Math.floor(Date.now() / 1000) + 1200,
    cooldownSeconds: 3600,
    minBuybackAmount: 0.05,
    badgeAddress: null,
    isLiveOnchain: false,
    rawBuybackPool: 1248.5
  });

  const [countdownText, setCountdownText] = useState("00:00:00");
  const [isCooldownReady, setIsCooldownReady] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Agent State
  const [agentStatus, setAgentStatus] = useState({
    isRegistered: false,
    stakedAmount: "0",
    reputationScore: 0,
    active: false,
    feeTierBps: 30,
    participantType: "HUMAN",
    arbtBalance: "0",
    allowance: "0",
    pendingRewards: "0",
    badges: { bronze: false, silver: false, gold: false }
  });

  // Forms and Simulator State
  const [stakeInput, setStakeInput] = useState("100");
  const [calcVolume, setCalcVolume] = useState("10000");
  const [txMessage, setTxMessage] = useState("");
  const [txType, setTxType] = useState("idle"); // idle | busy | success | error
  const [copiedKey, setCopiedKey] = useState(null);
  const [badgeBusyTier, setBadgeBusyTier] = useState(null);
  const [rewardBusy, setRewardBusy] = useState(false);

  // ── 1. Fetch live onchain hook state ──────────────────────────────
  const loadHookData = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const data = await fetchOnchainHookState();
      setHookStats(data);
      setLastRefreshedAt(new Date().toLocaleTimeString());
    } catch (e) {
      console.warn("Hook data fetch fallback:", e);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  // ── 2. Fetch agent status for connected account ───────────────────
  const loadAgentData = useCallback(async (userAddr) => {
    if (!userAddr) return;
    try {
      const data = await fetchAgentStatus(userAddr);
      setAgentStatus(data);
    } catch (e) {
      console.warn("Agent status fetch fallback:", e);
    }
  }, []);

  // ── 3. Initial load & 15s refresh interval ─────────────────────────
  useEffect(() => {
    loadHookData();
    const timer = setInterval(() => {
      loadHookData();
      if (account) loadAgentData(account);
    }, 15000);
    return () => clearInterval(timer);
  }, [loadHookData, loadAgentData, account]);

  // ── 4. Live Countdown Clock ─────────────────────────────────────────
  useEffect(() => {
    const updateCountdown = () => {
      const now = Math.floor(Date.now() / 1000);
      const diff = hookStats.nextBuybackEligible - now;
      if (diff <= 0) {
        setCountdownText("READY TO FIRE");
        setIsCooldownReady(true);
      } else {
        const hrs = Math.floor(diff / 3600);
        const mins = Math.floor((diff % 3600) / 60);
        const secs = diff % 60;
        const fmt = (n) => String(n).padStart(2, "0");
        setCountdownText(`${fmt(hrs)}:${fmt(mins)}:${fmt(secs)}`);
        setIsCooldownReady(false);
      }
    };
    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [hookStats.nextBuybackEligible]);

  // ── 5. Detect wallet on load / account change ───────────────────────
  useEffect(() => {
    if (typeof window !== "undefined" && window.ethereum) {
      window.ethereum
        .request({ method: "eth_accounts" })
        .then((accounts) => {
          if (accounts && accounts.length > 0) {
            setAccount(accounts[0]);
            loadAgentData(accounts[0]);
          }
        })
        .catch(() => {});

      window.ethereum
        .request({ method: "eth_chainId" })
        .then((cid) => {
          setChainId(parseInt(cid, 16));
        })
        .catch(() => {});

      const handleAccountsChanged = (accounts) => {
        if (accounts.length > 0) {
          setAccount(accounts[0]);
          loadAgentData(accounts[0]);
        } else {
          setAccount(null);
          setAgentStatus({
            isRegistered: false,
            stakedAmount: "0",
            reputationScore: 0,
            active: false,
            feeTierBps: 30,
            participantType: "HUMAN",
            arbtBalance: "0",
            allowance: "0",
            pendingRewards: "0",
            badges: { bronze: false, silver: false, gold: false }
          });
        }
      };

      const handleChainChanged = (cid) => {
        setChainId(parseInt(cid, 16));
      };

      window.ethereum.on("accountsChanged", handleAccountsChanged);
      window.ethereum.on("chainChanged", handleChainChanged);

      return () => {
        window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
        window.ethereum.removeListener("chainChanged", handleChainChanged);
      };
    }
  }, [loadAgentData]);

  // ── 6. Connect Wallet ──────────────────────────────────────────────
  async function connectWallet() {
    if (typeof window === "undefined" || !window.ethereum) {
      alert("No Web3 wallet detected. Please install Rabby or MetaMask.");
      return;
    }
    try {
      setIsConnecting(true);
      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send("eth_requestAccounts", []);
      if (accounts && accounts.length > 0) {
        setAccount(accounts[0]);
        const net = await provider.getNetwork();
        setChainId(Number(net.chainId));
        await loadAgentData(accounts[0]);
      }
    } catch (err) {
      console.error("Connect error:", err);
      setTxMessage("Failed to connect wallet: " + (err.message || err));
      setTxType("error");
    } finally {
      setIsConnecting(false);
    }
  }

  // ── 7. Registration Flow (Approve ARBT + Register) ─────────────────
  async function handleApproveAndRegister() {
    if (!account) {
      await connectWallet();
      return;
    }
    const parsedStake = Number(stakeInput);
    if (isNaN(parsedStake) || parsedStake < 100) {
      setTxMessage("Validation Error: Minimum stake is 100 ARBT.");
      setTxType("error");
      return;
    }

    try {
      setTxType("busy");
      setTxMessage("Preparing transaction with connected wallet…");

      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const stakeWei = ethers.parseEther(stakeInput);

      // Check allowance first
      const tokenContract = new ethers.Contract(CONFIG.ARBT_ADDRESS, ERC20_ABI, signer);
      const currentAllowance = await tokenContract.allowance(account, CONFIG.REGISTRY_ADDRESS);

      if (currentAllowance < stakeWei) {
        setTxMessage("Step 1/2: Approving ARBT transfer to ArbitRegistry…");
        const approveTx = await tokenContract.approve(CONFIG.REGISTRY_ADDRESS, ethers.MaxUint256);
        setTxMessage(`Approve tx submitted: ${truncateAddress(approveTx.hash)}. Waiting confirmation…`);
        await approveTx.wait();
        setTxMessage("Approval confirmed! Step 2/2: Registering agent onchain…");
      } else {
        setTxMessage("Allowance verified. Submitting registry.register(stake)…");
      }

      // Execute Registration
      const registryContract = new ethers.Contract(CONFIG.REGISTRY_ADDRESS, REGISTRY_ABI, signer);
      const regTx = await registryContract.register(stakeWei);
      setTxMessage(`Register tx submitted: ${regTx.hash}. Awaiting block inclusion…`);
      const rc = await regTx.wait();

      setTxType("success");
      setTxMessage(`Agent Registered Successfully! Block #${rc.blockNumber} · Tx: ${truncateAddress(rc.hash)}`);
      await loadAgentData(account);
      await loadHookData();
    } catch (err) {
      console.error("Registration error:", err);
      const msg = err.shortMessage || err.reason || err.message || String(err);
      setTxType("error");
      setTxMessage(`Transaction Failed: ${msg}`);
    }
  }

  // ── 8. Claim Badge Action ──────────────────────────────────────────
  async function handleClaimBadge(tierIndex) {
    if (!account) {
      await connectWallet();
      return;
    }
    try {
      setBadgeBusyTier(tierIndex);
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const hook = new ethers.Contract(CONFIG.HOOK_ADDRESS, HOOK_ABI, signer);

      const tx = await hook.claimBadge(tierIndex);
      setTxType("busy");
      setTxMessage(`Claiming badge (tier ${tierIndex})… Tx: ${truncateAddress(tx.hash)}`);
      await tx.wait();

      setTxType("success");
      setTxMessage(`Badge Claimed! Your swap fees are now halved by 50% across all pools.`);
      await loadAgentData(account);
    } catch (err) {
      console.error("Claim badge error:", err);
      const msg = err.shortMessage || err.reason || err.message || String(err);
      setTxType("error");
      setTxMessage(`Badge Claim Failed: ${msg}`);
    } finally {
      setBadgeBusyTier(null);
    }
  }

  // ── 9. Claim ARBT Pending Reward ───────────────────────────────────
  async function handleClaimReward() {
    if (!account) return;
    try {
      setRewardBusy(true);
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const hook = new ethers.Contract(CONFIG.HOOK_ADDRESS, HOOK_ABI, signer);

      const tx = await hook.claimReward();
      setTxType("busy");
      setTxMessage(`Claiming pending agent rewards… Tx: ${truncateAddress(tx.hash)}`);
      await tx.wait();

      setTxType("success");
      setTxMessage(`Rewards claimed successfully into your wallet!`);
      await loadAgentData(account);
    } catch (err) {
      console.error("Claim reward error:", err);
      const msg = err.shortMessage || err.reason || err.message || String(err);
      setTxType("error");
      setTxMessage(`Reward Claim Failed: ${msg}`);
    } finally {
      setRewardBusy(false);
    }
  }

  // ── 10. Clipboard Helper ───────────────────────────────────────────
  function copyToClipboard(text, key) {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  }

  // ── 11. Simulator calculations ─────────────────────────────────────
  const volumeNum = Math.max(0, Number(calcVolume) || 0);
  const humanFee = (volumeNum * 0.003).toFixed(2);
  const humanLp = (humanFee * 0.8).toFixed(2);
  const humanBuyback = (humanFee * 0.2).toFixed(2);

  const agentFee = (volumeNum * 0.0005).toFixed(2);
  const agentReward = (agentFee * 0.5).toFixed(2);

  const botFee = (volumeNum * 0.01).toFixed(2);
  const botVictim = (botFee * 0.6).toFixed(2);
  const botBurn = (botFee * 0.4).toFixed(2);

  return (
    <div className="min-h-screen bg-black text-white relative">
      {/* ── Navigation Bar ─────────────────────────────────────────── */}
      <nav className="navbar">
        <div className="navbar-inner">
          <div className="nav-links">
            <a href="#overview" className="nav-link">Overview</a>
            <a href="#lanes" className="nav-link">Participant Lanes</a>
            <a href="#stock-pools" className="nav-link">Stock Edge</a>
            <a href="#badges" className="nav-link">Badges</a>
            <a href="#register" className="nav-link">Register Agent</a>
          </div>

          <div className="nav-actions">
            <button
              className="btn btn-primary btn-connect"
              onClick={connectWallet}
              disabled={isConnecting}
            >
              {isConnecting
                ? "Connecting…"
                : account
                ? truncateAddress(account)
                : "Connect Wallet"}
            </button>

            <a href="#" className="brand">
              <img
                src="/arbit-logo-transparent.png"
                alt="Arbit"
                className="brand-logo"
              />
            </a>
          </div>
        </div>
      </nav>

      {/* ── Section 1: Hero with Aceternity Background Ripple Effect ─ */}
      <header className="hero-section relative overflow-hidden" id="overview">
        {/* Aceternity Interactive Background Ripple Grid (HERO ONLY) */}
        <div className="absolute inset-0 z-0 pointer-events-auto overflow-hidden">
          <BackgroundRippleEffect
            cellSize={54}
            borderColor="rgba(1, 110, 254, 0.16)"
          />
        </div>

        <div className="page-container hero-content relative z-10 pointer-events-none">
          <div className="hero-text-center pointer-events-auto">
            <h1 className="hero-headline">
              Trade securely, <span className="text-electric electric-glow">Earn from the activity.</span>
            </h1>

            <p className="hero-subhead">
              Arbit identifies the participant, applies the right fee, routes the money, protects from MEV, both human and agents benefits from trade outcomes.
            </p>
          </div>
        </div>
      </header>

      {/* ── Main Container for Sections ────────────────────────────── */}
      <main className="page-container">
        {/* ── Section 2: How It Works & Participant Lanes ───────────── */}
        <section className="section" id="lanes">
          <div className="section-header">
            <div className="section-tag">Mechanism Architecture</div>
            <h2 className="section-title">Identity-Based Fee Routing</h2>
            <p className="section-desc">
              Every swap is classified in <code>beforeSwap</code> once in O(1) gas. Assets never sit idle:
              they directly reward honest participants and penalize exploits.
            </p>
          </div>

          <div className="lanes-grid">
            {/* Lane 1: Human Trader */}
            <div className="lane-card">
              <span className="lane-badge badge-human">Human Swapper</span>
              <h3 className="lane-title">Protected Flow</h3>
              <div className="lane-fee-row">
                <span className="lane-fee-large">0.30%</span>
                <span className="lane-fee-label">30 bps standard</span>
              </div>
              <p className="lane-desc">
                Standard retail and institutional swap flow. Shielded from predatory MEV extraction.
                A healthy fraction of the fee feeds the permanent token deflation engine.
              </p>
              <div className="flow-breakdown">
                <div className="flow-item">
                  <span className="flow-key">80% of fee</span>
                  <span className="flow-val">Uniswap v4 LPs</span>
                </div>
                <div className="flow-item">
                  <span className="flow-key">20% of fee</span>
                  <span className="flow-val text-electric">Buyback Pool (ARBT)</span>
                </div>
                <div className="flow-item">
                  <span className="flow-key">Classification</span>
                  <span className="flow-val">Default EOA / hookData</span>
                </div>
              </div>
            </div>

            {/* Lane 2: Registered Agent (Featured) */}
            <div className="lane-card featured">
              <span className="lane-badge badge-agent">Registered Agent</span>
              <h3 className="lane-title">Incentivized Flow</h3>
              <div className="lane-fee-row">
                <span className="lane-fee-large">0.05%</span>
                <span className="lane-fee-label">5 bps (High Rep)</span>
              </div>
              <p className="lane-desc">
                Autonomous agents that register with ARBT collateral and build honest track records.
                They receive the lowest fee in crypto plus tokenized cash-back rewards.
              </p>
              <div className="flow-breakdown">
                <div className="flow-item">
                  <span className="flow-key">Base Fee</span>
                  <span className="flow-val text-electric">0.05% (800+ rep)</span>
                </div>
                <div className="flow-item">
                  <span className="flow-key">Fee Rebate</span>
                  <span className="flow-val">50% back in ARBT</span>
                </div>
                <div className="flow-item">
                  <span className="flow-key">Mid Rep (500–799)</span>
                  <span className="flow-val">0.15% fee · 25% back</span>
                </div>
                <div className="flow-item">
                  <span className="flow-key">Collateral Stake</span>
                  <span className="flow-val">≥ 100 ARBT locked</span>
                </div>
              </div>
            </div>

            {/* Lane 3: Unregistered Bot */}
            <div className="lane-card">
              <span className="lane-badge badge-bot">Unregistered Bot</span>
              <h3 className="lane-title">Penalty Lane</h3>
              <div className="lane-fee-row">
                <span className="lane-fee-large">1.00%</span>
                <span className="lane-fee-label">100 bps tax</span>
              </div>
              <p className="lane-desc">
                Sandwich bots, rapid multi-swap blocks, and uncollateralized extractors face a 100 bps
                penalty fee. Their toll directly funds victims and burns ARBT.
              </p>
              <div className="flow-breakdown">
                <div className="flow-item">
                  <span className="flow-key">60% of tax</span>
                  <span className="flow-val">Victim Compensation</span>
                </div>
                <div className="flow-item">
                  <span className="flow-key">40% of tax</span>
                  <span className="flow-val text-electric">Buyback + Burn (0xdead)</span>
                </div>
                <div className="flow-item">
                  <span className="flow-key">Detection</span>
                  <span className="flow-val">Block bursts & gas spikes</span>
                </div>
              </div>
            </div>
          </div>

          {/* Interactive Fee Math Simulator */}
          <div className="calculator-box">
            <div className="calc-header">
              <div>
                <h3 className="calc-title">Interactive Fee & Routing Simulator</h3>
                <p className="stat-desc">
                  Model any swap size to see how Arbit routes fees across participants and pools.
                </p>
              </div>
              <div className="calc-inputs">
                <span className="form-label" style={{ margin: 0 }}>Swap Size:</span>
                <div className="calc-input-wrap">
                  <input
                    type="number"
                    className="calc-input"
                    value={calcVolume}
                    onChange={(e) => setCalcVolume(e.target.value)}
                    min="1"
                  />
                  <span className="calc-currency">USD / ARBT</span>
                </div>
              </div>
            </div>

            <div className="calc-results-grid">
              <div className="calc-result-card">
                <div className="calc-result-tier">Human Trader (0.30%)</div>
                <div className="calc-result-fee">${humanFee}</div>
                <div className="calc-subdetail">
                  • <strong>${humanLp}</strong> → Liquidity Providers (80%)<br />
                  • <strong>${humanBuyback}</strong> → ARBT Buyback Pool (20%)
                </div>
              </div>

              <div className="calc-result-card">
                <div className="calc-result-tier">Registered Agent (0.05%)</div>
                <div className="calc-result-fee">${agentFee}</div>
                <div className="calc-subdetail">
                  • <strong>${agentReward}</strong> returned as ARBT reward (50%)<br />
                  • Effective net fee: <strong>0.025%</strong>
                </div>
              </div>

              <div className="calc-result-card">
                <div className="calc-result-tier">Unregistered Bot (1.00%)</div>
                <div className="calc-result-fee" style={{ color: "#ef4444" }}>${botFee}</div>
                <div className="calc-subdetail">
                  • <strong>${botVictim}</strong> → Victim Protection Pool (60%)<br />
                  • <strong>${botBurn}</strong> → Instant Buyback + Burn (40%)
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Section 3: Stock Pools (Tokenized Equities Edge) ───────── */}
        <section className="section" id="stock-pools">
          <div className="section-header">
            <div className="section-tag">Robinhood Chain Native Edge</div>
            <h2 className="section-title">Tokenized Stock Pools</h2>
            <p className="section-desc">
              Pools flagged as tokenized equities (e.g. AAPL/USDG, TSLA/USDG) receive built-in economic
              subsidies: 2/3 fee discounts to attract institutional volume, paired with a 1.5x burn acceleration schedule.
            </p>
          </div>

          <div className="stock-comparison-grid">
            {/* Standard Pool */}
            <div className="stock-card">
              <div className="stock-card-header">
                <h3 className="lane-title">Standard Crypto Pool</h3>
                <span className="stat-indicator indicator-live">Base Dynamic Fee</span>
              </div>
              <p className="lane-desc">
                Crypto pairs (ETH/ARBT, USDC/ARBT). Full fee tier schedule with standard 1.0x accrual velocity.
              </p>
              <table className="table-custom">
                <thead>
                  <tr>
                    <th>Participant</th>
                    <th>Fee Rate</th>
                    <th>Burn Accrual</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Human Swapper</td>
                    <td>0.30% (30 bps)</td>
                    <td>1.0x (20% to pool)</td>
                  </tr>
                  <tr>
                    <td>Registered Agent</td>
                    <td>0.05% (5 bps)</td>
                    <td>1.0x (50% rebate)</td>
                  </tr>
                  <tr>
                    <td>Unregistered Bot</td>
                    <td>1.00% (100 bps)</td>
                    <td>1.0x (40% to burn)</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Tokenized Stock Pool */}
            <div className="stock-card active-stock">
              <div className="stock-card-header">
                <h3 className="lane-title">Stock Pool (AAPL, TSLA)</h3>
                <span className="stock-pill">2/3 Fees · 1.5x Burn</span>
              </div>
              <p className="lane-desc">
                Robinhood Chain equities. Lower fees attract large-block equity volume while accelerating the token burn rate.
              </p>
              <table className="table-custom">
                <thead>
                  <tr>
                    <th>Participant</th>
                    <th>Subsidized Fee</th>
                    <th>Boosted Accrual</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Human Swapper</td>
                    <td className="table-highlight">0.20% (20 bps)</td>
                    <td className="table-highlight">1.5x Accelerated</td>
                  </tr>
                  <tr>
                    <td>Registered Agent</td>
                    <td className="table-highlight">0.033% (3.3 bps)</td>
                    <td className="table-highlight">1.5x Accelerated</td>
                  </tr>
                  <tr>
                    <td>Unregistered Bot</td>
                    <td className="table-highlight">0.66% (66 bps)</td>
                    <td className="table-highlight">1.5x Accelerated</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="multiplier-callout">
            <strong>The Stock Accrual Engine:</strong> Stock trades run through <code>_applyStockBoost</code> in{" "}
            <code>ArbitHook.sol</code>, calculating <code>(amount * 150) / 100</code> on every fee collection.
            Trades fill the shared burn pool 50% faster, triggering the autonomous <code>_executeBuyback()</code> sooner.
          </div>
        </section>

        {/* ── Section 4: Arbit Badges ───────────────────────────────── */}
        <section className="section" id="badges">
          <div className="section-header">
            <div className="section-tag">Onchain Reputation Passes</div>
            <h2 className="section-title">Arbit Badges & Holder Perks</h2>
            <p className="section-desc">
              Achievement badges issued via <code>ArbitBadge.sol</code>.
              Holding <strong>ANY</strong> badge cuts your swap fees in half across all Arbit pools.
            </p>
          </div>

          <div className="badges-grid">
            {/* Bronze */}
            <div className="badge-card">
              <div className="badge-tier-top">
                <div className="badge-icon-wrap tier-bronze">BR</div>
                <span className="badge-req">Tier 0 · Register</span>
              </div>
              <h3 className="badge-title">Bronze Pass</h3>
              <div className="badge-perk">Halves all swap fees</div>
              <p className="badge-desc">
                Awarded immediately upon staking ≥100 ARBT in the registry. Signals valid collateral backing.
              </p>
              <div className="badge-action-area">
                {agentStatus.badges.bronze ? (
                  <div className="badge-claimed-pill">✓ Claimed / Active</div>
                ) : (
                  <button
                    className="btn btn-outline"
                    style={{ width: "100%" }}
                    onClick={() => handleClaimBadge(0)}
                    disabled={!agentStatus.isRegistered || badgeBusyTier === 0}
                  >
                    {badgeBusyTier === 0 ? "Minting…" : "Claim Bronze"}
                  </button>
                )}
              </div>
            </div>

            {/* Silver */}
            <div className="badge-card">
              <div className="badge-tier-top">
                <div className="badge-icon-wrap tier-silver">AG</div>
                <span className="badge-req">Tier 1 · 500+ Rep</span>
              </div>
              <h3 className="badge-title">Silver Pass</h3>
              <div className="badge-perk">Halves all swap fees</div>
              <p className="badge-desc">
                Unlocked when an agent reaches 500 reputation score through verified trades and zero exploit attempts.
              </p>
              <div className="badge-action-area">
                {agentStatus.badges.silver ? (
                  <div className="badge-claimed-pill">✓ Claimed / Active</div>
                ) : (
                  <button
                    className="btn btn-outline"
                    style={{ width: "100%" }}
                    onClick={() => handleClaimBadge(1)}
                    disabled={!agentStatus.isRegistered || agentStatus.reputationScore < 500 || badgeBusyTier === 1}
                  >
                    {badgeBusyTier === 1 ? "Minting…" : "Claim Silver (500 Rep)"}
                  </button>
                )}
              </div>
            </div>

            {/* Gold */}
            <div className="badge-card">
              <div className="badge-tier-top">
                <div className="badge-icon-wrap tier-gold">AU</div>
                <span className="badge-req">Tier 2 · 800+ Rep</span>
              </div>
              <h3 className="badge-title">Gold Pass</h3>
              <div className="badge-perk">Halves all swap fees</div>
              <p className="badge-desc">
                Elite status for top institutional and algorithmic traders. Maximizes token cash-back and protocol governance weight.
              </p>
              <div className="badge-action-area">
                {agentStatus.badges.gold ? (
                  <div className="badge-claimed-pill">✓ Claimed / Active</div>
                ) : (
                  <button
                    className="btn btn-outline"
                    style={{ width: "100%" }}
                    onClick={() => handleClaimBadge(2)}
                    disabled={!agentStatus.isRegistered || agentStatus.reputationScore < 800 || badgeBusyTier === 2}
                  >
                    {badgeBusyTier === 2 ? "Minting…" : "Claim Gold (800 Rep)"}
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="badge-banner">
            <div>
              <h4 className="heading" style={{ fontSize: 18, marginBottom: 4 }}>
                Direct Hook Verification: <code>badge.balanceOf(trader) &gt; 0</code>
              </h4>
              <p className="stat-desc" style={{ maxWidth: 700 }}>
                In <code>ArbitHook:220</code>, any swapper holding an Arbit Badge gets their fee cut in half:
                Human 0.30% → 0.15%, Agent High 0.05% → 0.025%.
              </p>
            </div>
            <a href="#register" className="btn btn-primary">
              Register to Qualify →
            </a>
          </div>
        </section>

        {/* ── Section 5: Register as Agent ──────────────────────────── */}
        <section className="section" id="register">
          <div className="section-header">
            <div className="section-tag">Direct Onchain Integration</div>
            <h2 className="section-title">Register as Trading Agent</h2>
            <p className="section-desc">
              Directly call <code>ArbitRegistry.register(stakeAmount)</code>. No wrappers or complex setup.
              Stake ARBT collateral, unlock the 0.05% tier, and begin earning fee rebates.
            </p>
          </div>

          <div className="register-grid">
            {/* Left Box: Registration Form */}
            <div className="reg-card">
              <h3 className="heading" style={{ fontSize: 20, marginBottom: 16 }}>
                {agentStatus.isRegistered ? "Agent Collateral Management" : "New Agent Stake"}
              </h3>

              <div className="form-group">
                <label className="form-label">Stake Amount (ARBT)</label>
                <div className="form-input-box">
                  <input
                    type="number"
                    className="form-input"
                    value={stakeInput}
                    onChange={(e) => setStakeInput(e.target.value)}
                    min="100"
                    placeholder="100"
                  />
                  <span className="form-unit">ARBT</span>
                </div>
                <div className="preset-pills">
                  <button className="preset-btn" onClick={() => setStakeInput("100")}>Min (100)</button>
                  <button className="preset-btn" onClick={() => setStakeInput("250")}>250 ARBT</button>
                  <button className="preset-btn" onClick={() => setStakeInput("500")}>500 ARBT</button>
                  <button className="preset-btn" onClick={() => setStakeInput("1000")}>1,000 ARBT</button>
                </div>
              </div>

              <div className="form-group">
                <div className="flow-breakdown">
                  <div className="flow-item">
                    <span className="flow-key">Minimum Stake</span>
                    <span className="flow-val">100 ARBT</span>
                  </div>
                  <div className="flow-item">
                    <span className="flow-key">Starting Reputation</span>
                    <span className="flow-val text-electric">500 / 1000</span>
                  </div>
                  <div className="flow-item">
                    <span className="flow-key">Your ARBT Balance</span>
                    <span className="flow-val">{Number(agentStatus.arbtBalance).toFixed(2)} ARBT</span>
                  </div>
                </div>
              </div>

              <button
                className="btn btn-primary"
                style={{ width: "100%", padding: "14px" }}
                onClick={handleApproveAndRegister}
                disabled={txType === "busy"}
              >
                {txType === "busy"
                  ? "Processing on Robinhood Chain…"
                  : agentStatus.isRegistered
                  ? "Deposit Additional Collateral"
                  : "Approve ARBT & Register"}
              </button>

              {txMessage && (
                <div className={`status-terminal ${txType === "success" ? "success" : txType === "error" ? "error" : ""}`}>
                  {txMessage}
                </div>
              )}
            </div>

            {/* Right Box: Live Agent Status */}
            <div className="agent-live-card">
              <h3 className="heading" style={{ fontSize: 20, marginBottom: 16 }}>
                Connected Identity Status
              </h3>

              <div className="flow-breakdown" style={{ marginBottom: 20 }}>
                <div className="flow-item">
                  <span className="flow-key">Wallet Address</span>
                  <span className="flow-val mono">{account ? truncateAddress(account) : "Not Connected"}</span>
                </div>
                <div className="flow-item">
                  <span className="flow-key">Registration Status</span>
                  <span className="flow-val">
                    {agentStatus.active ? (
                      <span className="text-electric">ACTIVE AGENT</span>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>UNREGISTERED (HUMAN)</span>
                    )}
                  </span>
                </div>
                <div className="flow-item">
                  <span className="flow-key">Collateral Staked</span>
                  <span className="flow-val mono">{agentStatus.stakedAmount} ARBT</span>
                </div>
                <div className="flow-item">
                  <span className="flow-key">Current Fee Rate</span>
                  <span className="flow-val text-electric mono">
                    {(agentStatus.feeTierBps / 100).toFixed(2)}% ({agentStatus.feeTierBps} bps)
                  </span>
                </div>
              </div>

              {/* Reputation Meter */}
              <div className="rep-meter-container">
                <div className="rep-meter-labels">
                  <span>Reputation Score</span>
                  <span className="text-electric mono">
                    {agentStatus.reputationScore} / 1000
                  </span>
                </div>
                <div className="rep-bar-bg">
                  <div
                    className="rep-bar-fill"
                    style={{ width: `${Math.min(100, (agentStatus.reputationScore / 1000) * 100)}%` }}
                  ></div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10, color: "var(--text-muted)" }} className="mono">
                  <span>0 (Low)</span>
                  <span>500 (Base)</span>
                  <span>800 (High Fee Tier)</span>
                </div>
              </div>

              {/* Pending Rewards Claim */}
              <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border-subtle)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }} className="mono">ACCUMULATED CASH-BACK</div>
                    <div style={{ fontSize: 20, fontWeight: 700 }} className="mono text-electric">
                      {Number(agentStatus.pendingRewards).toFixed(2)} ARBT
                    </div>
                  </div>
                  <button
                    className="btn btn-outline"
                    onClick={handleClaimReward}
                    disabled={Number(agentStatus.pendingRewards) <= 0 || rewardBusy}
                  >
                    {rewardBusy ? "Claiming…" : "Claim Rewards"}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  Agents pull rewards via <code>hook.claimReward()</code> — reentrancy protected pull pattern.
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <footer className="footer">
        <div className="page-container">
          <div className="footer-grid">
            {/* Left: Contracts */}
            <div>
              <h4 className="heading" style={{ fontSize: 16, marginBottom: 16, color: "#FFFFFF" }}>
                Verified Contract Addresses
              </h4>
              <div className="footer-contract-list">
                <div className="contract-row">
                  <span className="contract-name">ArbitHook</span>
                  <span className="contract-addr mono">{truncateAddress(CONFIG.HOOK_ADDRESS)}</span>
                  <button
                    className="copy-btn"
                    onClick={() => copyToClipboard(CONFIG.HOOK_ADDRESS, "hook")}
                  >
                    {copiedKey === "hook" ? "COPIED" : "COPY"}
                  </button>
                </div>

                <div className="contract-row">
                  <span className="contract-name">ArbitRegistry</span>
                  <span className="contract-addr mono">{truncateAddress(CONFIG.REGISTRY_ADDRESS)}</span>
                  <button
                    className="copy-btn"
                    onClick={() => copyToClipboard(CONFIG.REGISTRY_ADDRESS, "reg")}
                  >
                    {copiedKey === "reg" ? "COPIED" : "COPY"}
                  </button>
                </div>

                <div className="contract-row">
                  <span className="contract-name">ArbitToken (ARBT)</span>
                  <span className="contract-addr mono">{truncateAddress(CONFIG.ARBT_ADDRESS)}</span>
                  <button
                    className="copy-btn"
                    onClick={() => copyToClipboard(CONFIG.ARBT_ADDRESS, "arbt")}
                  >
                    {copiedKey === "arbt" ? "COPIED" : "COPY"}
                  </button>
                </div>

                <div className="contract-row">
                  <span className="contract-name">PoolManager</span>
                  <span className="contract-addr mono">{truncateAddress(CONFIG.POOL_MANAGER_ADDRESS)}</span>
                  <button
                    className="copy-btn"
                    onClick={() => copyToClipboard(CONFIG.POOL_MANAGER_ADDRESS, "pm")}
                  >
                    {copiedKey === "pm" ? "COPIED" : "COPY"}
                  </button>
                </div>
              </div>
            </div>

            {/* Right: Ecosystem Links */}
            <div>
              <h4 className="heading" style={{ fontSize: 16, marginBottom: 16, color: "#FFFFFF" }}>
                Network & Ecosystem
              </h4>
              <div className="footer-links-list">
                <a
                  href={CONFIG.EXPLORER}
                  target="_blank"
                  rel="noreferrer"
                  className="footer-link-item"
                >
                  ↗ Robinhood Chain Explorer
                </a>
                <a
                  href={CONFIG.X_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="footer-link-item"
                >
                  ↗ Official X Updates (@arbit_hook)
                </a>
                <a
                  href={CONFIG.DOCS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="footer-link-item"
                >
                  ↗ GitHub Source & Verification Suite
                </a>
              </div>
            </div>
          </div>

          <div className="disclaimer-box">
            <strong>COMPLIANCE & RISK NOTICE:</strong> ARBT is a utility and governance token on Robinhood Chain.
            Smart contracts are subject to market and technological risk; tokens can lose value. This interface is provided
            as an informational open-source tool for decentralized protocol interaction. Not financial, tax, or investment advice.
            Tokenized stock pools may be subject to jurisdictional restrictions; US persons are excluded regarding synthetic equities.
          </div>
        </div>
      </footer>
    </div>
  );
}
