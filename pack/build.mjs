#!/usr/bin/env node
// Arbit pack builder — adapts the official robinhood-v4-no-broadcast pattern
// to our graph (token + registry + hook + initializer). No key, no signing,
// no broadcast. Produces standard-json.json, out/*.json, evidence/* and
// programmable-launch.config.json. Run: npm run build  (see README/PACKING)
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import solc from "solc";

const CAPABILITIES_URL = "https://api.programmable.market/v4/chains/4663/capabilities";
const ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const EXPECTED_SOLC = "0.8.26+commit.8a97fa7a.Emscripten.clang";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.includes("--help")) {
  process.stdout.write(`Arbit pack builder\n\nRequired env:\n  PROGRAMMABLE_LAUNCH_WALLET (0x...40hex)\n  PROGRAMMABLE_LAUNCH_NONCE (0x...64hex nonzero)\n  PROGRAMMABLE_SOURCE_REVISION (40-hex public commit)\n  PROGRAMMABLE_PROJECT_IMAGE_SOURCE_PATH (pack/assets/project.png)\n  PROGRAMMABLE_PROJECT_IMAGE_URI (https public URL)\n  PROGRAMMABLE_WEBSITE_URL, PROGRAMMABLE_X_URL\n  PROGRAMMABLE_INITIAL_BUY_WEI, PROGRAMMABLE_LP_ETH_WEI, PROGRAMMABLE_MAX_GAS_WEI\n  PROGRAMMABLE_SEED_ARBT, PROGRAMMABLE_HOOK_FUND_ARBT, PROGRAMMABLE_MIN_TOKENS_OUT\nOptional:\n  PROGRAMMABLE_SOURCE_ORIGIN (default https://github.com/aabxtract/arbit)\n  PROGRAMMABLE_TOKEN_NAME/SYMBOL (default Arbit/ARBT)\n  PROGRAMMABLE_PROJECT_DESCRIPTION\n  PROGRAMMABLE_CHECKED_AT\nRefuses to run with PROGRAMMABLE_API_KEY set.\n`);
  process.exit(0);
}
if (Object.hasOwn(process.env, "PROGRAMMABLE_API_KEY")) {
  throw new TypeError("this unauthenticated builder refuses PROGRAMMABLE_API_KEY");
}

const root = path.dirname(fileURLToPath(import.meta.url)); // pack/ (run from anywhere)
const DRYRUN = process.env.ARBIT_DRYRUN === "1";

// ---- 1. inputs (no invented metadata: DRYRUN placeholders are explicit) ----
const launchWallet = req("PROGRAMMABLE_LAUNCH_WALLET", /^0x[0-9a-fA-F]{40}$/);
const nonce = req("PROGRAMMABLE_LAUNCH_NONCE", /^0x(?!0{64}$)[0-9a-f]{64}$/);
const sourceRevision = req("PROGRAMMABLE_SOURCE_REVISION", /^[0-9a-f]{40}$/);
const sourceOrigin = process.env.PROGRAMMABLE_SOURCE_ORIGIN ?? "https://github.com/aabxtract/arbit";
const tokenName = process.env.PROGRAMMABLE_TOKEN_NAME ?? "Arbit";
const tokenSymbol = process.env.PROGRAMMABLE_TOKEN_SYMBOL ?? "ARBT";
const description = process.env.PROGRAMMABLE_PROJECT_DESCRIPTION
  ?? (DRYRUN
    ? "[DRYRUN placeholder] Arbit Uniswap v4 hook: participant-priced swaps, buyback burns, victim fund."
    : missing("PROGRAMMABLE_PROJECT_DESCRIPTION"));
const imageSourcePath = relPath(req("PROGRAMMABLE_PROJECT_IMAGE_SOURCE_PATH"));
const imageUri = reqUrl("PROGRAMMABLE_PROJECT_IMAGE_URI");
const websiteUrl = reqUrl("PROGRAMMABLE_WEBSITE_URL");
const xUrl = reqX("PROGRAMMABLE_X_URL");
const checkedAt = process.env.PROGRAMMABLE_CHECKED_AT ?? new Date().toISOString();
const buyWei = reqInt("PROGRAMMABLE_INITIAL_BUY_WEI");
const lpEthWei = reqInt("PROGRAMMABLE_LP_ETH_WEI");
const maxGasWei = reqInt("PROGRAMMABLE_MAX_GAS_WEI");
const seedArbt = reqInt("PROGRAMMABLE_SEED_ARBT");
const hookFundArbt = reqInt("PROGRAMMABLE_HOOK_FUND_ARBT");
const minTokensOut = reqInt("PROGRAMMABLE_MIN_TOKENS_OUT");

// ---- 2. vendor sources (single source of truth: ../src + ../lib) ----
const TARGETS = [
  ["src/ArbitToken.sol", "ArbitToken", "token"],
  ["src/ArbitRegistry.sol", "ArbitRegistry", "registry"],
  ["src/ArbitHook.sol", "ArbitHook", "hook"],
  ["src/ArbitInitializer.sol", "ArbitInitializer", "initializer"],
];
const PREFIX_MAP = {
  "@openzeppelin/contracts/": "lib/openzeppelin-contracts/contracts/",
  "v4-core/": "lib/v4-core/",
};
const sources = {}; // packPath -> content
const seen = new Set();
// Standard-json keys mirror the on-disk tree under pack/build/ so the
// closure is self-describing: our files at build/src/*.sol, deps below it.
async function vendorFile(repoPath, keyPath) {
  if (seen.has(keyPath)) return;
  seen.add(keyPath);
  let content = await readFile(path.join(REPO_ROOT, repoPath), "utf8");
  const dir = path.posix.dirname(keyPath);
  for (const m of content.matchAll(/import\s+(?:[^'"]+from\s+)?["']([^"']+)["']/g)) {
    const spec = m[1];
    let depRepo; let depKey;
    if (spec.startsWith(".")) {
      depRepo = path.posix.normalize(path.posix.join(path.posix.dirname(repoPath), spec));
      depKey = path.posix.normalize(path.posix.join(dir, spec));
    } else {
      const prefix = Object.keys(PREFIX_MAP).find((p) => spec.startsWith(p));
      if (!prefix) throw new TypeError(`unvendored import prefix in ${repoPath}: ${spec}`);
      depRepo = PREFIX_MAP[prefix] + spec.slice(prefix.length);
      depKey = `build/src/vendor/${depRepo}`;
      const rel = path.posix.relative(dir, depKey);
      const relNorm = rel.startsWith(".") ? rel : `./${rel}`;
      content = content.split(`"${spec}"`).join(`"${relNorm}"`);
      content = content.split(`'${spec}'`).join(`'${relNorm}'`);
    }
    await vendorFile(depRepo, depKey);
  }
  sources[keyPath] = { content };
}
for (const [rel] of TARGETS) {
  await vendorFile(rel, `build/${rel}`);
}

// ---- 3. compile with exact solc ----
if (solc.version() !== EXPECTED_SOLC) throw new TypeError(`need ${EXPECTED_SOLC}, got ${solc.version()}`);
const standardJson = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    metadata: { bytecodeHash: "none", appendCBOR: false, useLiteralContent: true },
    libraries: {},
    remappings: [],
    outputSelection: {
      "*": {
        "*": [
          "abi",
          "metadata",
          "evm.bytecode.object",
          "evm.bytecode.linkReferences",
          "evm.deployedBytecode.object",
          "evm.deployedBytecode.linkReferences",
          "evm.deployedBytecode.immutableReferences",
        ],
        "": ["ast"],
      },
    },
  },
};
const standardJsonBytes = Buffer.from(`${JSON.stringify(standardJson)}\n`, "utf8");
const output = JSON.parse(solc.compile(JSON.stringify(standardJson)));
const errs = (output.errors ?? []).filter((e) => e.severity === "error");
if (errs.length) throw new TypeError(errs.map((e) => e.formattedMessage).join("\n"));
await mkdir(path.join(root, "out"), { recursive: true });
await mkdir(path.join(root, "evidence"), { recursive: true });
await mkdir(path.join(root, "build", "src"), { recursive: true });
await writeFile(path.join(root, "standard-json.json"), standardJsonBytes);
// Mirror the vendored tree so source closure is auditable on disk
for (const [keyPath, entry] of Object.entries(sources)) {
  const full = path.join(root, ...keyPath.split("/"));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, entry.content, "utf8");
}
const artifacts = {};
for (const [sourcePath, contractName, targetId] of TARGETS) {
  const key = `build/${sourcePath}`;
  const c = output.contracts?.[key]?.[contractName];
  if (!c?.abi || !c?.metadata || !c?.evm?.bytecode?.object || !c?.evm?.deployedBytecode?.object) {
    throw new TypeError(`incomplete compiler output for ${key}:${contractName}`);
  }
  const art = Buffer.from(`${JSON.stringify({
    abi: c.abi, bytecode: c.evm.bytecode, deployedBytecode: c.evm.deployedBytecode, metadata: c.metadata,
  })}\n`, "utf8");
  await writeFile(path.join(root, "out", `${targetId}.json`), art);
  artifacts[targetId] = art;
}
// All compiler immutables per target, name-mapped via AST (never positional)
function collectImmutables(ast) {
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.nodeType === "VariableDeclaration" && n.mutability === "immutable" && n.stateVariable) {
      out.push({ id: String(n.id), name: n.name, type: n.typeDescriptions?.typeString ?? "" });
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  })(ast);
  return out;
}
const PM_LITERAL = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
function bindImmutable(targetId, name, type, ids, ctx) {
  const id = ids[name];
  if (!id) throw new TypeError(`${targetId}: immutable ${name} missing from AST`);
  const abiType = type.startsWith("uint") ? "uint256" : "address";
  if (name === "poolManager" || name === "manager") {
    return { immutableId: id, abiType, literal: ctx.pm };
  }
  if (name === "graphFactory") return { immutableId: id, abiType, literal: ctx.gf };
  if (name === "wallet") return { immutableId: id, abiType, literal: ctx.wallet };
  if (name === "chainId" || name === "CHAIN_ID") {
    return { immutableId: id, abiType: "uint256", literal: "4663" };
  }
  const targetMap = {
    arbitToken: "token", token: "token",
    registry: "registry", hook: "hook", initializer: "initializer",
  };
  const t = targetMap[name];
  if (!t) throw new TypeError(`${targetId}: no binding rule for immutable ${name}`);
  return { immutableId: id, abiType, target: t };
}
function immutablesFor(fileKey, targetId, ctx) {
  const ast = output.sources?.[fileKey]?.ast;
  const found = {};
  for (const e of collectImmutables(ast)) found[e.name] = e;
  return Object.values(found).map((e) => bindImmutable(targetId, e.name, e.type, Object.fromEntries(
    Object.entries(found).map(([n, x]) => [n, x.id]),
  ), ctx));
}

// ---- 4. capabilities + permit window + image ----
const imageBytes = await readFile(path.join(root, ...imageSourcePath.split("/")));
assertPng(imageBytes);
const capabilities = await (await fetch(CAPABILITIES_URL)).json();
const pmTrust = capabilities?.chainDeployment?.contracts?.poolManager;
const gfTrust = capabilities?.chainDeployment?.contracts?.graphFactory;
if (pmTrust?.address !== "0x8366a39CC670B4001A1121B8F6A443A643e40951" || !gfTrust?.address) {
  throw new TypeError("canonical trust-root binding changed — stop and review");
}
const bindCtx = { pm: pmTrust.address, gf: gfTrust.address, wallet: launchWallet };
const [rpcChainId, finBlock] = await Promise.all([
  rpc("eth_chainId", []),
  rpc("eth_getBlockByNumber", ["finalized", false]),
]);
const permitWindow = permitFromFinalized(rpcChainId, finBlock, Math.floor(Date.parse(capabilities.serverTime) / 1000));

// ---- 5. config ----
const totalValue = (BigInt(buyWei) + BigInt(lpEthWei)).toString();
const config = {
  schemaVersion: "programmable.launch-pack-config.v4",
  chainId: "4663",
  caip2: "eip155:4663",
  chainDeployment: capabilities.chainDeployment,
  profile: capabilities.profile,
  externalContracts: [],
  launchWallet,
  nonce,
  permitWindow,
    source: {
      root: ".",
      paths: ["build/src"],
      sourceLineageNonce: "1",
      publicOrigin: { url: new URL(sourceOrigin).href, revision: sourceRevision },
    },
  compilationUnits: [{ compilationUnitId: "arbit-v4", standardJson: "standard-json.json" }],
  targets: [
    {
      targetId: "token", compilationUnitId: "arbit-v4", artifact: "out/token.json",
      applicantSalt: `0x${"11".repeat(32)}`,
      constructorArguments: [launchWallet],
      initializer: null, deploymentValueWei: "0", initializerValueWei: "0",
      componentKind: "token", declaredHookPermissions: null, runtimeImmutables: [],
    },
    {
      targetId: "registry", compilationUnitId: "arbit-v4", artifact: "out/registry.json",
      applicantSalt: `0x${"22".repeat(32)}`,
      constructorArguments: [{ target: "token" }, { target: "initializer" }, launchWallet],
      initializer: null, deploymentValueWei: "0", initializerValueWei: "0",
      componentKind: "other", declaredHookPermissions: null,
      runtimeImmutables: immutablesFor("build/src/ArbitRegistry.sol", "registry", bindCtx),
    },
    {
      targetId: "hook", compilationUnitId: "arbit-v4", artifact: "out/hook.json",
      applicantSalt: { mode: "deterministic-hook-permission-grind-v1", start: "0", maxAttempts: "262144" },
      constructorArguments: [
        pmTrust.address, { target: "registry" }, { target: "token" }, launchWallet, 4663,
      ],
      initializer: null, deploymentValueWei: "0", initializerValueWei: "0",
      componentKind: "hook", declaredHookPermissions: ["beforeSwap", "afterSwap"],
      runtimeImmutables: immutablesFor("build/src/ArbitHook.sol", "hook", bindCtx),
    },
    {
      targetId: "initializer", compilationUnitId: "arbit-v4", artifact: "out/initializer.json",
      applicantSalt: `0x${"44".repeat(32)}`,
      constructorArguments: [pmTrust.address, gfTrust.address, launchWallet, 4663],
      initializer: {
        function: "initialize",
        arguments: [{
          registry: { target: "registry" },
          hook: { target: "hook" },
          token: { target: "token" },
          hookFund: hookFundArbt,
          seedAmount: seedArbt,
          buyAmount: buyWei,
          fee: 8388608,
          tickSpacing: 60,
          sqrtPrice: "79228162514264337593543950336",
          tickLower: -600,
          tickUpper: 600,
          liquidityDelta: "100000000000000000000",
          minTokensOut,
        }],
      },
      deploymentValueWei: "0", initializerValueWei: totalValue,
      componentKind: "other", declaredHookPermissions: null,
      runtimeImmutables: immutablesFor("build/src/ArbitInitializer.sol", "initializer", bindCtx),
    },
  ],
  pool: {
    tokenTargetId: "token", hookTargetId: "hook", fee: 8388608, tickSpacing: 60,
    quoteCurrency: "0x0000000000000000000000000000000000000000",
  },
  projectMetadata: {
    schemaVersion: "programmable.project-metadata-input.v1",
    token: { name: tokenName, symbol: tokenSymbol },
    presentation: {
      description,
      image: { sourcePath: imageSourcePath, uri: imageUri },
      links: [{ kind: "website", uri: websiteUrl }, { kind: "x", uri: xUrl }],
    },
  },
  funding: { schemaVersion: "programmable.custom-launch-funding-intent.v2", mode: "wallet-transaction-value", valueWei: totalValue },
  fundingPlan: {
    schemaVersion: "programmable.robinhood-funding-plan.v1",
    capitalSource: "creator-funded",
    pricingModel: "concentrated-liquidity",
    nativeAllocations: {
      initialLiquidityWei: lpEthWei, initialBuyWei: buyWei, reserveWei: "0", otherLaunchValueWei: "0",
    },
    maxLaunchValueWei: totalValue,
    maxGasCostWei: process.env.PROGRAMMABLE_MAX_GAS_WEI ?? maxGasWei,
    launchMode: "fund-and-launch",
  },
  liquidityModel: {
    schemaVersion: "programmable.custom-launch-liquidity-model.v1",
    model: "project-provided-liquidity",
    declaredLaunchState: "liquidity-provided-by-launch",
    targetIds: ["initializer"],
  },
  agentAttestation: {
    agentId: "arbit-pack", checkedAt,
    checks: [
      { checkId: "capabilities", evidence: "evidence/capabilities.json" },
      { checkId: "exact-build", evidence: "evidence/build.json" },
    ],
  },
};
await writeFile(path.join(root, "evidence", "capabilities.json"), `${JSON.stringify(capabilities, null, 2)}\n`);
await writeFile(path.join(root, "evidence", "build.json"), `${JSON.stringify({
  schemaVersion: "programmable.arbit-build.v1", compilerVersion: solc.version(),
  standardJsonSha256: sha(standardJsonBytes), fundingMode: "creator-funded",
  signing: false, broadcast: false, checkedAt, dryrun: DRYRUN,
}, null, 2)}\n`);
await writeFile(path.join(root, "programmable-launch.config.json"), `${JSON.stringify(config, null, 2)}\n`);
process.stdout.write(`Wrote capability-bound programmable-launch.config.json${DRYRUN ? " (DRYRUN values)" : ""}; no signing or broadcast performed.\n`);

// ---- helpers ----
function req(n, re) {
  const v = process.env[n];
  if (typeof v !== "string" || v.length === 0 || (re && !re.test(v))) {
    throw new TypeError(`${n} missing/invalid`);
  }
  return v;
}
function reqInt(n) {
  const v = process.env[n];
  if (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v)) throw new TypeError(`${n} missing/invalid uint`);
  return v;
}
function missing(n) { throw new TypeError(`${n} is required (no default outside DRYRUN)`); }
function reqUrl(n) {
  const v = req(n, /^https:\/\//);
  const u = new URL(v);
  if (u.username || u.password || u.hash) throw new TypeError(`${n} must be credential-free HTTPS`);
  return u.href;
}
function reqX(n) {
  const v = req(n, /^https:\/\/x\.com\/[A-Za-z0-9_]{1,64}$/);
  return v;
}
function relPath(v) {
  if (path.isAbsolute(v) || v.includes("\\") || v.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new TypeError("image source path must be a canonical relative path");
  }
  return v;
}
function assertPng(b) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (sig.some((x, i) => b[i] !== x) || b.length > 5242880) throw new TypeError("image must be PNG ≤5MB");
}
function findImmutableId(ast, name) {
  const all = collectImmutables(ast);
  const hit = all.find((e) => e.name === name);
  return hit ? hit.id : null;
}
function permitFromFinalized(chainId, block, nowSeconds) {
  if (BigInt(chainId) !== 4663n) throw new TypeError("RPC is not Robinhood mainnet");
  const ts = BigInt(block.timestamp);
  const validAfter = ts - 60n;
  const deadline = validAfter + 3600n;
  if (deadline < BigInt(nowSeconds) + 300n) throw new TypeError("stale finalized checkpoint");
  return { validAfter: validAfter.toString(), deadline: deadline.toString() };
}
async function rpc(method, params) {
  const r = await fetch(ROBINHOOD_RPC_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error || j.result == null) throw new TypeError("RPC read failed");
  return j.result;
}
function sha(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
