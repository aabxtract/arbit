"use client";
import { useState } from "react";
import { ethers } from "ethers";
import executorArtifact from "../lib/ArbitAgentExecutor.json";

const HOOK = process.env.NEXT_PUBLIC_HOOK_ADDRESS || "0x... (deploy first)";
const REGISTRY = process.env.NEXT_PUBLIC_REGISTRY_ADDRESS || "0x... (deploy first)";
const ARBT = process.env.NEXT_PUBLIC_ARBT_ADDRESS || "0x... (launch first)";
const EXPLORER = "https://robinhoodchain.blockscout.com";

export default function Page() {
  const [maxSwap, setMaxSwap] = useState("50");
  const [freqCap, setFreqCap] = useState("60");
  const [stake, setStake] = useState("100");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function register() {
    try {
      setBusy(true);
      setStatus("connecting wallet…");
      if (!window.ethereum) throw new Error("No wallet found. Install MetaMask / Rabby.");
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const agent = await signer.getAddress();

      const token = new ethers.Contract(
        ARBT,
        ["function approve(address,uint256) returns (bool)"],
        signer
      );
      setStatus(`deploying executor for ${agent}…`);
      const factory = new ethers.ContractFactory(
        ["constructor(address manager, address registry)"],
        executorArtifact.bytecode.object,
        signer
      );
      // NOTE: pool manager address is baked into the executor at construction.
      // Set NEXT_PUBLIC_POOL_MANAGER_ADDRESS in .env.local before using.
      const manager = process.env.NEXT_PUBLIC_POOL_MANAGER_ADDRESS;
      if (!manager) throw new Error("NEXT_PUBLIC_POOL_MANAGER_ADDRESS not set");
      const executor = await factory.deploy(manager, REGISTRY);
      await executor.waitForDeployment();
      const execAddr = await executor.getAddress();
      setStatus(`executor deployed: ${execAddr}\napproving + registering…`);

      const stakeWei = ethers.parseEther(stake);
      await (await token.approve(execAddr, stakeWei)).wait();
      const exec = new ethers.Contract(
        execAddr,
        ["function register(uint256,uint256,uint256)", "function getManifest()"],
        signer
      );
      // register pulls stake from the agent (approve first) and registers itself
      const tx = await exec.register(
        ethers.parseEther(maxSwap),
        BigInt(freqCap),
        stakeWei
      );
      const rc = await tx.wait();
      setStatus(`registered ✓\nexecutor: ${execAddr}\ntx: ${rc.hash}`);
    } catch (e) {
      setStatus("error: " + (e?.shortMessage || e?.message || String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap">
      <div className="hero">
        <h1>
          Arbit enforces what AI agents <span className="accent">promise</span>.
        </h1>
        <p>
          A Uniswap v4 hook + per-agent executor that enforces declared trading
          manifests onchain. Stay within your rules and build reputation —
          violate them and get slashed + suspended, automatically.
        </p>
        <p className="mono addr">
          hook: <a href={`${EXPLORER}/address/${HOOK}`}>{HOOK}</a>
          <br />
          registry: <span>{REGISTRY}</span>
          <br />
          ARBT: <span>{ARBT}</span>
        </p>
      </div>

      <section>
        <h2>How it works</h2>
        <ol className="steps">
          <li>Deploy executor <small>your agent&apos;s onchain identity — the address the hook enforces</small></li>
          <li>Register manifest + stake ARBT <small>declare maxSwapSize + frequencyCap, stake ≥ 100 ARBT collateral</small></li>
          <li>Hook enforces every swap <small>violations slash 10% / 5% to treasury via the penalty lane — the swap still executes</small></li>
          <li>Reputation builds — or you get suspended <small>stake below minimum = hard block on the next swap</small></li>
        </ol>
      </section>

      <section>
        <h2>Register your agent</h2>
        <div className="form">
          <label>maxSwapSize (ARBT input units)</label>
          <input value={maxSwap} onChange={(e) => setMaxSwap(e.target.value)} />
          <label>frequencyCap (seconds between swaps)</label>
          <input value={freqCap} onChange={(e) => setFreqCap(e.target.value)} />
          <label>stake (ARBT, ≥ 100)</label>
          <input value={stake} onChange={(e) => setStake(e.target.value)} />
          <button onClick={register} disabled={busy}>
            {busy ? "working…" : "Approve → Deploy executor → Register"}
          </button>
          <div className="mono status">{status}</div>
        </div>
      </section>

      <footer className="mono">
        Robinhood Chain (4663) · penalty lane: violations slash without reverting · suspended agents hard-block
      </footer>
    </div>
  );
}
