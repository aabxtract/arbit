"use client";

import { useState } from "react";
import Link from "next/link";

export default function ArbitOfficialLogoPage() {
  const [copied, setCopied] = useState(false);
  const [copiedRaw, setCopiedRaw] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [bgMode, setBgMode] = useState("dark"); // "dark" | "checker" | "glow"

  const canonicalUrl = "https://www.arbithook.app/arbit-official.png";
  const rawGithubUrl = "https://raw.githubusercontent.com/aabxtract/arbit/main/pack/assets/arbit-official.png";
  const tokenAddress = "0x34CD7dd63C550a78A3228C199474189B88565Ac9";
  const explorerUrl = "https://robinhoodchain.blockscout.com/token/0x34CD7dd63C550a78A3228C199474189B88565Ac9";

  const handleCopy = (text, setFn) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setFn(true);
      setTimeout(() => setFn(false), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-[#050814] text-white flex flex-col font-sans selection:bg-[#016EFE] selection:text-white">
      {/* Header Navigation */}
      <header className="border-b border-white/10 bg-[#050814]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 group">
            <img
              src="/arbit-official.png"
              alt="Arbit Logo"
              className="w-9 h-9 rounded-full border border-[#016EFE]/40 group-hover:border-[#016EFE] transition-all shadow-[0_0_15px_rgba(1,110,254,0.3)]"
            />
            <div className="flex flex-col">
              <span className="font-bold tracking-wider text-base">ARBIT</span>
              <span className="text-[10px] text-white/50 tracking-widest uppercase font-mono">Official Brand Asset</span>
            </div>
          </Link>

          <div className="flex items-center gap-4 text-sm font-medium">
            <Link
              href="/"
              className="px-4 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/80 hover:text-white transition-all text-xs tracking-wide"
            >
              ← Back to App
            </Link>
            <a
              href="/arbit-official.png"
              target="_blank"
              rel="noreferrer"
              className="px-4 py-1.5 rounded-lg bg-[#016EFE] hover:bg-[#016EFE]/90 text-white font-semibold text-xs transition-all shadow-[0_0_20px_rgba(1,110,254,0.4)]"
            >
              Raw Image ↗
            </a>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-12 flex flex-col items-center">
        {/* Page Badge & Heading */}
        <div className="text-center max-w-2xl mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#016EFE]/15 border border-[#016EFE]/30 text-[#016EFE] text-xs font-mono mb-4">
            <span className="w-2 h-2 rounded-full bg-[#016EFE] animate-pulse"></span>
            ARBT TOKEN LOGO ASSET
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3">
            Arbit Official Logo Asset
          </h1>
          <p className="text-white/60 text-sm sm:text-base leading-relaxed">
            The canonical high-resolution brand asset for Arbit ($ARBT) on Robinhood Chain. Verified for Blockscout token info, Uniswap tokenlists, and partner integrations.
          </p>
        </div>

        {/* Interactive Viewer Card */}
        <div className="w-full grid grid-cols-1 lg:grid-cols-12 gap-8 items-start mb-12">
          {/* Left Column: Image Canvas & View Controls */}
          <div className="lg:col-span-7 flex flex-col items-center">
            {/* View Mode Switcher */}
            <div className="flex items-center gap-2 p-1 bg-white/5 border border-white/10 rounded-xl mb-4 text-xs font-medium">
              <button
                onClick={() => setBgMode("dark")}
                className={`px-3 py-1.5 rounded-lg transition-all ${
                  bgMode === "dark"
                    ? "bg-[#016EFE] text-white shadow"
                    : "text-white/60 hover:text-white"
                }`}
              >
                Dark Canvas
              </button>
              <button
                onClick={() => setBgMode("glow")}
                className={`px-3 py-1.5 rounded-lg transition-all ${
                  bgMode === "glow"
                    ? "bg-[#016EFE] text-white shadow"
                    : "text-white/60 hover:text-white"
                }`}
              >
                Electric Glow
              </button>
              <button
                onClick={() => setBgMode("checker")}
                className={`px-3 py-1.5 rounded-lg transition-all ${
                  bgMode === "checker"
                    ? "bg-[#016EFE] text-white shadow"
                    : "text-white/60 hover:text-white"
                }`}
              >
                Checker Grid
              </button>
            </div>

            {/* Image Canvas Container */}
            <div
              className={`w-full max-w-[460px] aspect-square rounded-2xl border border-white/15 p-8 flex items-center justify-center relative transition-all duration-300 overflow-hidden ${
                bgMode === "dark"
                  ? "bg-[#090D21]"
                  : bgMode === "glow"
                  ? "bg-[#050814] shadow-[0_0_80px_rgba(1,110,254,0.35)] border-[#016EFE]/50"
                  : "bg-[radial-gradient(#222_1px,transparent_1px)] [background-size:16px_16px] bg-[#111]"
              }`}
            >
              {/* Decorative Accent Badges */}
              <div className="absolute top-3 left-3 text-[11px] font-mono px-2.5 py-0.5 rounded bg-black/40 border border-white/10 text-white/50">
                1024 × 1024
              </div>
              <div className="absolute top-3 right-3 text-[11px] font-mono px-2.5 py-0.5 rounded bg-[#016EFE]/20 border border-[#016EFE]/40 text-[#016EFE]">
                PNG
              </div>

              {/* Main Image View */}
              <img
                src="/arbit-official.png"
                alt="Arbit Official Logo"
                className="w-full h-full object-contain drop-shadow-[0_15px_35px_rgba(0,0,0,0.6)] hover:scale-105 transition-transform duration-300"
              />
            </div>

            {/* Quick Actions under Image */}
            <div className="flex flex-wrap items-center justify-center gap-3 mt-5 w-full max-w-[460px]">
              <a
                href="/arbit-official.png"
                download="arbit-official.png"
                className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/20 text-white text-xs font-semibold transition-all hover:border-white/30"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                Download PNG
              </a>

              <button
                onClick={() => handleCopy(canonicalUrl, setCopied)}
                className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#016EFE] hover:bg-[#016EFE]/90 text-white text-xs font-semibold transition-all shadow-[0_0_20px_rgba(1,110,254,0.3)]"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                {copied ? "URL Copied!" : "Copy Image URL"}
              </button>
            </div>
          </div>

          {/* Right Column: Asset Specifications & Integration Links */}
          <div className="lg:col-span-5 flex flex-col gap-5 w-full">
            {/* Asset Metadata Box */}
            <div className="p-6 rounded-2xl bg-white/[0.03] border border-white/10">
              <h3 className="text-sm font-semibold text-white/90 uppercase tracking-wider mb-4 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#016EFE]"></span>
                Asset Specifications
              </h3>

              <div className="space-y-3.5 text-xs">
                <div className="flex justify-between items-center py-1 border-b border-white/5">
                  <span className="text-white/50">File Name</span>
                  <span className="font-mono text-white/90 font-medium">arbit-official.png</span>
                </div>
                <div className="flex justify-between items-center py-1 border-b border-white/5">
                  <span className="text-white/50">Format & Resolution</span>
                  <span className="font-mono text-white/90 font-medium">PNG · 1024 × 1024 px</span>
                </div>
                <div className="flex justify-between items-center py-1 border-b border-white/5">
                  <span className="text-white/50">Aspect Ratio</span>
                  <span className="font-mono text-white/90 font-medium">1:1 (Square)</span>
                </div>
                <div className="flex justify-between items-center py-1 border-b border-white/5">
                  <span className="text-white/50">Color Palette</span>
                  <div className="flex items-center gap-1.5 font-mono text-[11px]">
                    <span className="w-3 h-3 rounded-full bg-[#016EFE] border border-white/30 inline-block" title="#016EFE"></span>
                    <span className="w-3 h-3 rounded-full bg-[#050814] border border-white/30 inline-block" title="#050814"></span>
                    <span>#016EFE / #050814</span>
                  </div>
                </div>
                <div className="flex justify-between items-center py-1 border-b border-white/5">
                  <span className="text-white/50">Network</span>
                  <span className="text-white/90 font-medium">Robinhood Chain (4663)</span>
                </div>
                <div className="flex justify-between items-center py-1">
                  <span className="text-white/50">Token Symbol</span>
                  <span className="font-mono text-[#016EFE] font-bold">ARBT</span>
                </div>
              </div>
            </div>

            {/* Token Info & URIs */}
            <div className="p-6 rounded-2xl bg-white/[0.03] border border-white/10 space-y-4">
              <h3 className="text-sm font-semibold text-white/90 uppercase tracking-wider flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]"></span>
                Verified Integration URIs
              </h3>

              {/* Canonical Website Logo URI */}
              <div>
                <label className="block text-[11px] font-mono text-white/50 mb-1.5">
                  CANONICAL LOGOURI (TOKENLIST & BLOCKSCOUT)
                </label>
                <div className="flex items-center gap-2 p-2 rounded-xl bg-black/40 border border-white/10">
                  <input
                    type="text"
                    readOnly
                    value={canonicalUrl}
                    className="bg-transparent text-white/80 font-mono text-xs w-full focus:outline-none"
                  />
                  <button
                    onClick={() => handleCopy(canonicalUrl, setCopied)}
                    className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] font-medium transition-all"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              {/* GitHub Raw Fallback URI */}
              <div>
                <label className="block text-[11px] font-mono text-white/50 mb-1.5">
                  GITHUB RAW FALLBACK URI
                </label>
                <div className="flex items-center gap-2 p-2 rounded-xl bg-black/40 border border-white/10">
                  <input
                    type="text"
                    readOnly
                    value={rawGithubUrl}
                    className="bg-transparent text-white/80 font-mono text-xs w-full focus:outline-none"
                  />
                  <button
                    onClick={() => handleCopy(rawGithubUrl, setCopiedRaw)}
                    className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] font-medium transition-all"
                  >
                    {copiedRaw ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              {/* Token Contract Address */}
              <div>
                <label className="block text-[11px] font-mono text-white/50 mb-1.5">
                  ARBT CONTRACT ADDRESS
                </label>
                <div className="flex items-center gap-2 p-2 rounded-xl bg-black/40 border border-white/10">
                  <input
                    type="text"
                    readOnly
                    value={tokenAddress}
                    className="bg-transparent text-[#016EFE] font-mono text-xs w-full focus:outline-none"
                  />
                  <button
                    onClick={() => handleCopy(tokenAddress, setCopiedAddress)}
                    className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] font-medium transition-all"
                  >
                    {copiedAddress ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              {/* Explorer Verification Link */}
              <div className="pt-2">
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-xs text-[#016EFE] hover:underline font-medium"
                >
                  View ARBT Token on Robinhood Chain Blockscout ↗
                </a>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/10 py-6 text-center text-xs text-white/40">
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <span>© 2026 Arbit Protocol · All rights reserved.</span>
          <div className="flex items-center gap-4">
            <Link href="/" className="hover:text-white transition-colors">dApp</Link>
            <span>·</span>
            <a href={canonicalUrl} target="_blank" rel="noreferrer" className="hover:text-white transition-colors">Direct Image</a>
            <span>·</span>
            <a href="https://x.com/arbit_hook" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">X (@arbit_hook)</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
