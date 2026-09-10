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
import { FloatingPixelBadges } from "../components/ui/floating-pixel-badges";

const FAQ_ITEMS = [
  {
    q: "How is Arbit different from a normal pool?",
    a: "Arbit still gives traders and LPs the familiar Uniswap v4 experience. The difference is the hook around the pool: it classifies swaps, applies participant-specific fees, tracks bot behavior, routes fees, and executes buybacks according to onchain rules."
  },
  {
    q: "Do I need to register before trading?",
    a: "No. Anyone can trade an allowlisted pool without registration, an account, or an Arbit identity."
  },
  {
    q: "Can I add liquidity?",
    a: "Yes. LPs can add and remove liquidity normally. The hook does not block liquidity providers."
  },
  {
    q: "What fee do normal traders pay?",
    a: "Human traders pay 0.30%. 80% goes to LPs and 20% goes to the buyback pool."
  },
  {
    q: "What do registered agents get?",
    a: "Agents stake 100 ARBT to register and start with 500 reputation. Their fee can range from 0.05%–0.30% based on reputation, and they can claim accrued ARBT rewards."
  },
  {
    q: "How does Arbit deal with bots?",
    a: "Arbit tracks frequency and gas patterns across swaps. Detected bot behavior is charged the 1.00% bot fee, with 60% going to the victim fund and 40% going toward buyback and burn."
  },
  {
    q: "Can fees be raised later?",
    a: "No. Every rate is either a capped constant (no fee can exceed 5%, bots max 1%) or an immutable set at launch (creator 0.30%/0.30%, platform 0.20%). See the Fee limits section above."
  },
  {
    q: "Am I guaranteed protection from MEV?",
    a: "No. One-shot attackers can slip through before patterns confirm. Arbit's protection comes from its detection and fee mechanism, with the victim fund providing a response mechanism for detected attacks."
  },
  {
    q: "What happens to the victim fund?",
    a: "The victim fund receives 60% of the bot surcharge. Governance can release compensation to victims from that fund."
  },
  {
    q: "What makes ARBT go up?",
    a: "Nothing in Arbit guarantees an increase in ARBT's price. The protocol uses defined trading fees to fund buybacks, and ARBT bought through the mechanism is burned when the threshold and cooldown conditions are met."
  },
  {
    q: "Can agents withdraw their stake?",
    a: "Not in the current registry — stake is locked while identity and reputation are active. An exit path is on the roadmap; do not stake funds you may need liquid."
  },
  {
    q: "What are stock pools?",
    a: "They are pools flagged by governance for tokenized stocks such as AAPL and TSLA paired with USDG. Flagged pools use ⅔ fees and 1.5× buyback accrual."
  },
  {
    q: "What can governance change?",
    a: "The owner/governance address can allowlist pools, flag stock pools, pay victims from the victim fund, and perform the one-time contract wiring required by the system."
  },
  {
    q: "Can the owner take LP funds?",
    a: "No. The owner cannot touch LP funds. The relevant administrative permissions are separate from custody of LP liquidity."
  }
];

export default function ArbitDappPage() {
  // FAQ Accordion State
  const [openFaq, setOpenFaq] = useState(null);

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

  // Expandable Lane Cards State
  const [expandedLane, setExpandedLane] = useState(null);

  const toggleLane = (laneIdx) => {
    setExpandedLane((prev) => (prev === laneIdx ? null : laneIdx));
  };

  // Carousel State & Swipe / Drag Handlers
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [dragStartX, setDragStartX] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  const TOTAL_CARDS = 6;
  const handlePrevCard = useCallback(() => setCarouselIndex((prev) => (prev === 0 ? TOTAL_CARDS - 1 : prev - 1)), []);
  const handleNextCard = useCallback(() => setCarouselIndex((prev) => (prev === TOTAL_CARDS - 1 ? 0 : prev + 1)), []);

  // Returns CSS class for carousel card positioning relative to the active index
  const getCardClass = (cardIdx) => {
    if (cardIdx === carouselIndex) return "active";
    const diff = (cardIdx - carouselIndex + TOTAL_CARDS) % TOTAL_CARDS;
    if (diff === 1) return "next";
    if (diff === TOTAL_CARDS - 1) return "prev";
    return "hidden";
  };

  const handleTouchStart = (e) => {
    setDragStartX(e.touches[0].clientX);
  };

  const handleTouchEnd = (e) => {
    if (dragStartX === null) return;
    const endX = e.changedTouches[0].clientX;
    const diff = dragStartX - endX;
    if (Math.abs(diff) > 35) {
      if (diff > 0) handleNextCard();
      else handlePrevCard();
    }
    setDragStartX(null);
  };

  const handleMouseDown = (e) => {
    setIsDragging(true);
    setDragStartX(e.clientX);
  };

  const handleMouseUp = (e) => {
    if (!isDragging || dragStartX === null) return;
    setIsDragging(false);
    const diff = dragStartX - e.clientX;
    if (Math.abs(diff) > 35) {
      if (diff > 0) handleNextCard();
      else handlePrevCard();
    }
    setDragStartX(null);
  };

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

  // ── 6b. Disconnect Wallet ───────────────────────────────────────────
  function disconnectWallet() {
    setAccount(null);
    setChainId(null);
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
    setTxMessage("Wallet disconnected.");
    setTxType("idle");
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
      {/* ── Fixed Top Header Area ─────────────────────────────────────── */}
      <header className="top-header-wrapper">
        {/* Far Left Brand Logo */}
        <div className="top-header-left">
          <a href="#" className="brand">
            <img
              src="/arbit-logo-transparent.png"
              alt="Arbit"
              className="brand-logo"
            />
          </a>
        </div>

        {/* Center Floating Glassmorphism Pill (Nav Links ONLY) */}
        <nav className="navbar-pill">
          <div className="nav-links">
            <a href="#overview" className="nav-link">Overview</a>
            <a href="#how-it-works" className="nav-link">How It Works</a>
            <a href="#whats-in-the-bag" className="nav-link">Whats In The Bag</a>
            <a href="#lanes" className="nav-link">Participant Lanes</a>
            <a href="#faq" className="nav-link">FAQ</a>
          </div>
        </nav>

        {/* Far Right Top Action: Connect Wallet Button */}
        <div className="top-header-right">
          <button
            className={`btn ${account ? "btn-disconnect" : "btn-primary"} btn-connect`}
            onClick={account ? disconnectWallet : connectWallet}
            disabled={isConnecting}
            title={account ? "Click to disconnect wallet" : "Click to connect Web3 wallet"}
          >
            {isConnecting ? (
              "Connecting…"
            ) : account ? (
              <span className="inline-flex items-center gap-2">
                <span className="pulse-dot"></span>
                <span>{truncateAddress(account)}</span>
                <span className="mono text-xs opacity-70 ml-1">✕</span>
              </span>
            ) : (
              "Connect Wallet"
            )}
          </button>
        </div>
      </header>

      {/* ── Section 1: Hero with Aceternity Background Ripple Effect ─ */}
      <header className="hero-section relative overflow-hidden" id="overview">
        {/* Aceternity Interactive Background Ripple Grid (HERO ONLY) */}
        <div className="absolute inset-0 z-0 pointer-events-auto overflow-hidden">
          <BackgroundRippleEffect
            cellSize={54}
            borderColor="rgba(1, 110, 254, 0.16)"
          />
        </div>

        {/* Aceternity Pixelified Dither Floating Badges (3 Left, 3 Right) */}
        <FloatingPixelBadges />

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

      {/* ── Section: Launched On Highlight Bar ─────────────────────────── */}
      <div className="launched-strip">
        <div className="launched-inner">
          <span className="launched-label">LAUNCHED ON :</span>

          <div className="launched-logos">
            {/* Robinhood Chain Logo */}
            <div className="launched-logo-item">
              <img
                src="/Robinhood_Chain_Logo_White.svg"
                alt="Robinhood Chain"
                className="launched-rh-logo"
              />
            </div>

            <span className="launched-divider">•</span>

            {/* Programmable Market Logo & Subtext */}
            <div className="launched-logo-item">
              <img
                src="/programmable logo.png"
                alt="Programmable"
                className="launched-prog-logo"
              />
              <span className="launched-subtext">Programmable Market</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Section: How Arbit Works (Full Width Screen Background & Side Watermark) ─ */}
      <section className="section-how-it-works" id="how-it-works">
        {/* Background Watermark Logo (10% opacity, big size, half off-screen) */}
        <img
          src="/arbit-logo-black-transparent.png"
          alt=""
          className="section-watermark"
        />

        <div className="page-container relative z-10">
          <div className="section-header">
            <div className="section-tag">HOW ARBIT WORKS</div>
            <h2 className="section-title">You trade. Arbit manages the incentives.</h2>
            <p className="section-desc">
              There are only two things a normal trader needs to do.
            </p>
          </div>

          {/* Cards Grid */}
          <div className="glass-grid">
            {/* Card: Swap */}
            <div className="glass-card">
              <h3 className="glass-card-title">Swap</h3>
              <p className="glass-card-text">
                Trade ARBT/ETH or any other allowlisted pool.
              </p>
              <div className="glass-card-highlight">
                <span>Exact-input and exact-output swaps are supported in both directions.</span>
              </div>
            </div>

            {/* Card: Provide liquidity */}
            <div className="glass-card">
              <h3 className="glass-card-title">Provide liquidity</h3>
              <p className="glass-card-text">
                Add or remove liquidity like a normal Uniswap v4 pool.
              </p>
              <div className="glass-card-highlight">
                <span>The hook never blocks LPs.</span>
              </div>
            </div>
          </div>

          {/* Arbit Automatically Glass Box */}
          <div className="glass-auto-container">
            <div className="glass-auto-header">
              <span className="glass-auto-header-icon"></span>
              <span>Arbit automatically:</span>
            </div>

            <div className="glass-auto-grid">
              <div className="auto-feature-card">
                <span className="feature-check-icon">✓</span>
                <span className="feature-text">Classifies swaps as human, agent, or bot</span>
              </div>

              <div className="auto-feature-card">
                <span className="feature-check-icon">✓</span>
                <span className="feature-text">Applies the appropriate fee</span>
              </div>

              <div className="auto-feature-card">
                <span className="feature-check-icon">✓</span>
                <span className="feature-text">Routes fees to LPs, buybacks, the victim fund, and agent rewards</span>
              </div>

              <div className="auto-feature-card">
                <span className="feature-check-icon">✓</span>
                <span className="feature-text">Tracks bot behavior using swap frequency and gas patterns</span>
              </div>

              <div className="auto-feature-card">
                <span className="feature-check-icon">✓</span>
                <span className="feature-text">Buys and burns ARBT when the threshold and cooldown are met</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Main Container for Remaining Sections ────────────────────────── */}
      <main className="page-container">
        {/* ── Carousel Section: WHATS IN THE BAG ───────────────────── */}
        <section className="section" id="whats-in-the-bag">
          <div className="section-header">
            <div className="section-tag">WHATS IN THE BAG</div>
            <h2 className="section-title">Value & Protection Overview</h2>
            <p className="section-desc">
              Explore how protocol mechanics reward honest volume, protect traders from MEV, and incentivize agents.
            </p>
          </div>

          <div
            className="carousel-wrapper"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            <div className="carousel-stage">
              {/* Card 0: FOR TRADERS */}
              <div
                className={`carousel-card ${getCardClass(0)}`}
                onClick={() => setCarouselIndex(0)}
              >
                <div className="carousel-card-tag">FOR TRADERS</div>
                <h3 className="carousel-card-title">Trade normally.</h3>
                <p className="carousel-card-sub">
                  Connect your wallet and swap with no account or registration.
                </p>

                <div className="carousel-box">
                  <div className="carousel-box-row">
                    <span style={{ color: "var(--text-muted)" }}>Human fee</span>
                    <span className="text-electric" style={{ fontWeight: 700 }}>0.30%</span>
                  </div>
                  <div className="carousel-box-row" style={{ paddingLeft: 12, fontSize: 12 }}>
                    <span>80%</span>
                    <span style={{ color: "var(--text-secondary)" }}>→ LPs</span>
                  </div>
                  <div className="carousel-box-row" style={{ paddingLeft: 12, fontSize: 12 }}>
                    <span>20%</span>
                    <span style={{ color: "var(--text-secondary)" }}>→ Buyback</span>
                  </div>

                  <div className="carousel-box-divider"></div>

                  <div className="carousel-box-row" style={{ color: "#ef4444" }}>
                    <span>Detected bot activity fee</span>
                    <span style={{ fontWeight: 700 }}>1.00%</span>
                  </div>
                  <div className="carousel-box-row" style={{ paddingLeft: 12, fontSize: 12 }}>
                    <span>60%</span>
                    <span style={{ color: "var(--text-secondary)" }}>→ Victim fund</span>
                  </div>
                  <div className="carousel-box-row" style={{ paddingLeft: 12, fontSize: 12 }}>
                    <span>40%</span>
                    <span style={{ color: "var(--text-secondary)" }}>→ Buyback + burn</span>
                  </div>
                </div>

                <div className="carousel-footer-note">
                  Simple trading. Stronger incentives.
                </div>
              </div>

              {/* Card 1: MEV PROTECTION */}
              <div
                className={`carousel-card ${getCardClass(1)}`}
                onClick={() => setCarouselIndex(1)}
              >
                <div className="carousel-card-tag">MEV PROTECTION</div>
                <h3 className="carousel-card-title">Detected extraction pays back into the system.</h3>
                <p className="carousel-card-sub">
                  Arbit monitors trading patterns and charges detected bot activity a 1.00% fee.
                </p>

                <div className="carousel-box">
                  <div style={{ marginBottom: 8, fontWeight: 600, color: "#FFFFFF" }}>That fee supports:</div>
                  <div className="carousel-box-row" style={{ paddingLeft: 8 }}>
                    <span>• Victim compensation</span>
                  </div>
                  <div className="carousel-box-row" style={{ paddingLeft: 8 }}>
                    <span>• ARBT buybacks and burns</span>
                  </div>
                </div>

                <div className="carousel-footer-note">
                  Detection is not guaranteed for every attack. The mechanism is designed to make detected extraction more expensive and useful to the ecosystem.
                </div>
              </div>

              {/* Card 2: FOR AGENTS */}
              <div
                className={`carousel-card ${getCardClass(2)}`}
                onClick={() => setCarouselIndex(2)}
              >
                <div className="carousel-card-tag">FOR AGENTS</div>
                <h3 className="carousel-card-title">Trade with better fees and earn rewards.</h3>
                <p className="carousel-card-sub">
                  Register by staking 100 ARBT and receive:
                </p>

                <div className="carousel-box">
                  <div className="carousel-box-row" style={{ paddingLeft: 4 }}>
                    <span>• Onchain identity</span>
                  </div>
                  <div className="carousel-box-row" style={{ paddingLeft: 4 }}>
                    <span>• 500 starting reputation</span>
                  </div>
                  <div className="carousel-box-row" style={{ paddingLeft: 4 }}>
                    <span>• Fees from 0.05%–0.30%</span>
                  </div>
                  <div className="carousel-box-row" style={{ paddingLeft: 4 }}>
                    <span>• ARBT rewards</span>
                  </div>
                </div>

                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
                  Trade cleanly to build reputation and unlock better fee tiers.
                </div>

                <div className="carousel-box-row" style={{ background: "rgba(1, 110, 254, 0.15)", padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(1, 110, 254, 0.3)" }}>
                  <span className="mono" style={{ fontSize: 12, color: "var(--accent-blue)" }}>Stake → Register → Trade → Earn</span>
                  <a href={CONFIG.DOCS_URL} target="_blank" rel="noreferrer" className="text-electric" style={{ fontSize: 12, textDecoration: "none", fontWeight: 600 }}>
                    Read the agent docs →
                  </a>
                </div>
              </div>

              {/* Card 3: FOR LIQUIDITY PROVIDERS */}
              <div
                className={`carousel-card ${getCardClass(3)}`}
                onClick={() => setCarouselIndex(3)}
              >
                <div className="carousel-card-tag">FOR LIQUIDITY PROVIDERS</div>
                <h3 className="carousel-card-title">Earn from trading activity.</h3>
                <p className="carousel-card-sub">
                  Provide liquidity as usual and earn from trading fees, while bot surcharges also support the victim fund and ARBT buybacks.
                </p>

                <div className="carousel-box">
                  <div style={{ marginBottom: 8, fontWeight: 600, color: "#FFFFFF" }}>Your LP earnings come from:</div>
                  <div className="carousel-box-row" style={{ paddingLeft: 8 }}>
                    <span>• 80% of human swap fees</span>
                  </div>
                  <div className="carousel-box-row" style={{ paddingLeft: 8 }}>
                    <span>• Standard Uniswap v4 fee accrual</span>
                  </div>

                  <div className="carousel-box-divider"></div>

                  <div style={{ marginBottom: 8, fontWeight: 600, color: "#FFFFFF" }}>Bot surcharges fund:</div>
                  <div className="carousel-box-row" style={{ paddingLeft: 8 }}>
                    <span>• Victim compensation pool</span>
                  </div>
                  <div className="carousel-box-row" style={{ paddingLeft: 8 }}>
                    <span>• ARBT buyback + burn engine</span>
                  </div>
                </div>

                <div className="carousel-footer-note">
                  No extra setup. Provide liquidity and benefit from Arbit's fee routing.
                </div>
              </div>

              {/* Card 4: STOCK POOLS */}
              <div
                className={`carousel-card ${getCardClass(4)}`}
                onClick={() => setCarouselIndex(4)}
              >
                <div className="carousel-card-tag">STOCK POOLS</div>
                <h3 className="carousel-card-title">Lower fees. Higher buyback accrual.</h3>
                <p className="carousel-card-sub">
                  Flagged stock pools use ⅔ fees and 1.5× buyback accrual.
                </p>

                <div className="carousel-box">
                  <div className="carousel-box-row">
                    <span style={{ color: "var(--text-muted)" }}>Human fee (stock)</span>
                    <span className="text-electric" style={{ fontWeight: 700 }}>0.20%</span>
                  </div>
                  <div className="carousel-box-row">
                    <span style={{ color: "var(--text-muted)" }}>Agent fee (stock)</span>
                    <span className="text-electric" style={{ fontWeight: 700 }}>0.033%</span>
                  </div>
                  <div className="carousel-box-row">
                    <span style={{ color: "var(--text-muted)" }}>Burn accrual</span>
                    <span style={{ fontWeight: 700, color: "#10B981" }}>1.5× accelerated</span>
                  </div>
                </div>

                <div className="carousel-box-row" style={{ background: "rgba(1, 110, 254, 0.15)", padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(1, 110, 254, 0.3)", marginTop: 8 }}>
                  <span className="mono" style={{ fontSize: 12, color: "var(--accent-blue)" }}>AAPL/USDG · TSLA/USDG</span>
                  <a href="#stock-pools" className="text-electric" style={{ fontSize: 12, textDecoration: "none", fontWeight: 600 }}>
                    Trade stock pools →
                  </a>
                </div>
              </div>

              {/* Card 5: BUYBACKS & BURNS */}
              <div
                className={`carousel-card ${getCardClass(5)}`}
                onClick={() => setCarouselIndex(5)}
              >
                <div className="carousel-card-tag">BUYBACKS & BURNS</div>
                <h3 className="carousel-card-title">Trading fees fund ARBT buybacks and burns.</h3>
                <p className="carousel-card-sub">
                  A portion of trading fees and bot surcharges funds automatic ARBT buybacks and burns once the onchain threshold and cooldown are met.
                </p>

                <div className="carousel-box">
                  <div style={{ marginBottom: 8, fontWeight: 600, color: "#FFFFFF" }}>Burn sources:</div>
                  <div className="carousel-box-row" style={{ paddingLeft: 8 }}>
                    <span>• 20% of human swap fees → Buyback Pool</span>
                  </div>
                  <div className="carousel-box-row" style={{ paddingLeft: 8 }}>
                    <span>• 40% of bot surcharge → Instant burn</span>
                  </div>

                  <div className="carousel-box-divider"></div>

                  <div className="carousel-box-row">
                    <span style={{ color: "var(--text-muted)" }}>Trigger</span>
                    <span style={{ fontWeight: 600, color: "#FFFFFF" }}>Threshold + Cooldown</span>
                  </div>
                  <div className="carousel-box-row">
                    <span style={{ color: "var(--text-muted)" }}>Destination</span>
                    <span className="mono" style={{ fontWeight: 700, color: "#ef4444" }}>0xdead</span>
                  </div>
                </div>

                <div className="carousel-footer-note">
                  Permanent ARBT deflation. Every trade contributes.
                </div>
              </div>
            </div>

            {/* Carousel Controls & Indicators */}
            <div className="carousel-controls">
              <button className="carousel-nav-btn" onClick={handlePrevCard} aria-label="Previous card">
                ←
              </button>

              <div className="carousel-dots">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <button
                    key={i}
                    className={`carousel-dot ${carouselIndex === i ? "active" : ""}`}
                    onClick={() => setCarouselIndex(i)}
                  ></button>
                ))}
              </div>

              <button className="carousel-nav-btn" onClick={handleNextCard} aria-label="Next card">
                →
              </button>
            </div>
          </div>
        </section>

        {/* ── Section 2: How It Works & Participant Lanes ───────────── */}
        <section className="section" id="lanes">
          <div className="section-header">
            <div className="section-tag">Mechanism Architecture</div>
            <h2 className="section-title">
              Identity-Based Fee Routing
              <span className="coming-soon-pill">Coming Soon</span>
            </h2>
            <p className="section-desc">
              Every swap is classified in <code>beforeSwap</code> once in O(1) gas. Assets never sit idle:
              they directly reward honest participants and penalize exploits.
            </p>
          </div>

          <div className="lanes-grid">
            {/* Lane 1: Human Trader */}
            <div className={`lane-card${expandedLane === 0 ? " expanded" : ""}`} onClick={() => toggleLane(0)}>
              <span className="lane-badge badge-human">Human Swapper</span>
              <h3 className="lane-title">Protected Flow</h3>
              <div className="lane-fee-row">
                <span className="lane-fee-large">0.30%</span>
                <span className="lane-fee-label">30 bps standard</span>
              </div>

              {/* Always Visible: Flow Percentages */}
              <div className="flow-breakdown">
                <div className="flow-item">
                  <span className="flow-key">80% of fee</span>
                  <span className="flow-val">→ LPs</span>
                </div>
                <div className="flow-item">
                  <span className="flow-key">20% of fee</span>
                  <span className="flow-val text-electric">→ Buyback Pool</span>
                </div>
              </div>

              {/* Expandable Content */}
              <div className={`lane-expandable${expandedLane === 0 ? " open" : ""}`}>
                <p className="lane-desc" style={{ marginBottom: 16 }}>
                  Standard retail and institutional swap flow. Shielded from predatory MEV extraction.
                  A healthy fraction of the fee feeds the permanent token deflation engine.
                </p>
                <div className="flow-breakdown">
                  <div className="flow-item">
                    <span className="flow-key">Classification</span>
                    <span className="flow-val">Default EOA / hookData</span>
                  </div>
                </div>
              </div>

              <div className="lane-expand-indicator">
                <span>{expandedLane === 0 ? "Collapse" : "Details"}</span>
                <span className={`lane-expand-arrow${expandedLane === 0 ? " rotated" : ""}`}>▼</span>
              </div>
            </div>

            {/* Lane 2: Registered Agent (Featured) */}
            <div className={`lane-card featured${expandedLane === 1 ? " expanded" : ""}`} onClick={() => toggleLane(1)}>
              <span className="lane-badge badge-agent">Registered Agent</span>
              <h3 className="lane-title">Incentivized Flow</h3>
              <div className="lane-fee-row">
                <span className="lane-fee-large">0.05%</span>
                <span className="lane-fee-label">5 bps (High Rep)</span>
              </div>

              {/* Always Visible: Flow Percentages */}
              <div className="flow-breakdown">
                <div className="flow-item">
                  <span className="flow-key">50% rebate</span>
                  <span className="flow-val text-electric">→ ARBT Reward</span>
                </div>
                <div className="flow-item">
                  <span className="flow-key">Net effective</span>
                  <span className="flow-val">0.025%</span>
                </div>
              </div>

              {/* Expandable Content */}
              <div className={`lane-expandable${expandedLane === 1 ? " open" : ""}`}>
                <p className="lane-desc" style={{ marginBottom: 16 }}>
                  Autonomous agents that register with ARBT collateral and build honest track records.
                  They receive the lowest fee in crypto plus tokenized cash-back rewards.
                </p>
                <div className="flow-breakdown">
                  <div className="flow-item">
                    <span className="flow-key">Base Fee</span>
                    <span className="flow-val text-electric">0.05% (800+ rep)</span>
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

              <div className="lane-expand-indicator">
                <span>{expandedLane === 1 ? "Collapse" : "Details"}</span>
                <span className={`lane-expand-arrow${expandedLane === 1 ? " rotated" : ""}`}>▼</span>
              </div>
            </div>

            {/* Lane 3: Unregistered Bot */}
            <div className={`lane-card${expandedLane === 2 ? " expanded" : ""}`} onClick={() => toggleLane(2)}>
              <span className="lane-badge badge-bot">Unregistered Bot</span>
              <h3 className="lane-title">Penalty Lane</h3>
              <div className="lane-fee-row">
                <span className="lane-fee-large">1.00%</span>
                <span className="lane-fee-label">100 bps tax</span>
              </div>

              {/* Always Visible: Flow Percentages */}
              <div className="flow-breakdown">
                <div className="flow-item">
                  <span className="flow-key">60% of tax</span>
                  <span className="flow-val">→ Victim Fund</span>
                </div>
                <div className="flow-item">
                  <span className="flow-key">40% of tax</span>
                  <span className="flow-val text-electric">→ Buyback + Burn</span>
                </div>
              </div>

              {/* Expandable Content */}
              <div className={`lane-expandable${expandedLane === 2 ? " open" : ""}`}>
                <p className="lane-desc" style={{ marginBottom: 16 }}>
                  Sandwich bots, rapid multi-swap blocks, and uncollateralized extractors face a 100 bps
                  penalty fee. Their toll directly funds victims and burns ARBT.
                </p>
                <div className="flow-breakdown">
                  <div className="flow-item">
                    <span className="flow-key">Detection</span>
                    <span className="flow-val">Block bursts & gas spikes</span>
                  </div>
                </div>
              </div>

              <div className="lane-expand-indicator">
                <span>{expandedLane === 2 ? "Collapse" : "Details"}</span>
                <span className={`lane-expand-arrow${expandedLane === 2 ? " rotated" : ""}`}>▼</span>
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

        {/* ── Section: Fee Limits (onchain-enforced caps) ──────────────────── */}
        <section className="section" id="fee-limits">
          <div className="section-head">
            <h2 className="section-title">
              Capped by code, <span className="text-electric">not by promise.</span>
            </h2>
            <p className="section-desc">
              Every limit below is a constant or immutable in the deployed contracts.
              No fee on any Arbit pool can exceed 5% — the transaction reverts instead.
            </p>
          </div>

          <div className="flow-breakdown">
            <div className="flow-item">
              <span className="flow-key">Absolute max fee (any trader)</span>
              <span className="flow-val">5.00% hard cap</span>
            </div>
            <div className="flow-item">
              <span className="flow-key">Bot surcharge ceiling</span>
              <span className="flow-val">1.00%</span>
            </div>
            <div className="flow-item">
              <span className="flow-key">Creator buy / sell rates</span>
              <span className="flow-val">0.30% / 0.30%, frozen at launch</span>
            </div>
            <div className="flow-item">
              <span className="flow-key">Platform fee</span>
              <span className="flow-val">0.20%, fixed recipient</span>
            </div>
            <div className="flow-item">
              <span className="flow-key">Rewards, payouts &amp; burns</span>
              <span className="flow-val text-electric">Never exceed real balances</span>
            </div>
          </div>

          <p className="section-desc" style={{ marginTop: 16 }}>
            Shortfalls revert instead of printing. Verify: registry{" "}
            <code>MAX_FEE_BPS</code>, hook <code>beforeSwap</code> cap check, immutable
            creator rates — all readable on Blockscout.
          </p>
        </section>

        {/* ── Section: Why The System Exists ─────────────────────────────── */}
        <section className="section" id="why-system-exists">
          {/* Background Watermark Logo (10% opacity, half off-screen) */}
          <img
            src="/arbit-logo-black-transparent.png"
            alt=""
            className="why-watermark"
          />

          <div className="why-card relative z-10">
            <div className="section-tag" style={{ marginBottom: 20 }}>WHY THE SYSTEM EXISTS</div>
            <h2 className="why-headline">
              We want every trader on Robinhood Chain to get more from every swap.
            </h2>
            <p className="why-desc">
              Protection, better fees, rewards, liquidity incentives, and buybacks — all made possible by a programmable market that can adapt the economics of every trade.
            </p>
            <div className="why-author">
              — Hesed Anu, Founder & Lead Developer
            </div>
          </div>
        </section>

        {/* ── Section 4: FAQ (Frequently Asked Questions) ───────────────── */}
        <section className="section" id="faq">
          <div className="section-header">
            <div className="section-tag">FAQ</div>
            <h2 className="section-title">Frequently Asked Questions</h2>
            <p className="section-desc">
              Everything you need to know about how Arbit handles pools, trading fees, bot detection, MEV protection, and governance.
            </p>
          </div>

          <div className="faq-grid">
            {FAQ_ITEMS.map((item, idx) => {
              const isOpen = openFaq === idx;
              return (
                <div
                  key={idx}
                  className={`faq-card ${isOpen ? "open" : ""}`}
                  onClick={() => setOpenFaq(isOpen ? null : idx)}
                >
                  <div className="faq-question">
                    <span className="faq-q-text">{item.q}</span>
                    <span className={`faq-icon ${isOpen ? "rotated" : ""}`}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9"></polyline>
                      </svg>
                    </span>
                  </div>
                  {isOpen && (
                    <div className="faq-answer">
                      <p>{item.a}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </main>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <footer className="footer">
        <div className="footer-container">
          <div className="footer-brand-col">
            <div className="footer-brand-row">
              <img
                src="/arbit-logo-transparent.png"
                alt="Arbit"
                className="footer-brand-logo"
              />
              <h3 className="footer-brand-title">Arbit</h3>
            </div>
            <p className="footer-brand-desc">
              Trading infrastructure with onchain incentives and protection.
            </p>
          </div>

          <div className="footer-links">
            <a href="https://robinhoodchain.blockscout.com" target="_blank" rel="noreferrer" className="footer-link">Explorer</a>
            <span className="footer-sep">·</span>
            <a href={CONFIG.DOCS_URL} target="_blank" rel="noreferrer" className="footer-link">Docs</a>
            <span className="footer-sep">·</span>
            <a href="/arbit-official" className="footer-link">Official Logo</a>
            <span className="footer-sep">·</span>
            <a href="https://x.com/arbit_hook" target="_blank" rel="noreferrer" className="footer-link">X</a>
          </div>

          <div className="footer-disclaimer">
            Crypto assets can lose all value. Nothing here is financial advice. Stock-token availability excludes restricted jurisdictions including the US.
          </div>

          <div className="footer-copyright">
            © 2026 Arbit
          </div>
        </div>
      </footer>
    </div>
  );
}
