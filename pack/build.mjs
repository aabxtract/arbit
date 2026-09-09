#!/usr/bin/env node
// Arbit pack builder v2 — kernel graph (profile 4.1.0).
// Targets: token + kernel(exact kit) + fee-module + registry + distributor +
// initializer. Our ArbitHook/ArbitBadge/ArbitAgentExecutor are NOT packed
// (hook dead on the official pool; badge post-launch; executor off-graph).
// No key, no signing, no broadcast. Run: npm run build
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import solc from "solc";

const CAPABILITIES_URL = "https://api.programmable.market/v4/chains/4663/capabilities";
const ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const EXPECTED_SOLC = "0.8.26+commit.8a97fa7a.Emscripten.clang";
const EXPECTED_CLI_VERSION = "4.1.0";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.includes("--help")) {
  process.stdout.write(`Arbit kernel-graph pack builder\n\nRequired env:\n  PROGRAMMABLE_LAUNCH_WALLET (0x...40hex)\n  PROGRAMMABLE_LAUNCH_NONCE (0x...64hex nonzero)\n  PROGRAMMABLE_SOURCE_REVISION (40-hex public commit)\n  PROGRAMMABLE_PROJECT_IMAGE_SOURCE_PATH (assets/project.png)\n  PROGRAMMABLE_PROJECT_IMAGE_URI (https)\n  PROGRAMMABLE_WEBSITE_URL, PROGRAMMABLE_X_URL\n  PROGRAMMABLE_CLI_PACKAGE (abs path to verified @programmable/launch 4.1.0)\n  PROGRAMMABLE_INITIAL_BUY_WEI, PROGRAMMABLE_LP_ETH_WEI, PROGRAMMABLE_MAX_GAS_WEI\n  PROGRAMMABLE_SEED_ARBT, PROGRAMMABLE_HOOK_FUND_ARBT, PROGRAMMABLE_MIN_TOKENS_OUT\n  PROGRAMMABLE_CREATOR_BUY_BPS, PROGRAMMABLE_CREATOR_SELL_BPS (e.g. 30/30)\n  PROGRAMMABLE_START_SQRT_PRICE (decimal key, e.g. 1:1 raw units)\nOptional:\n  PROGRAMMABLE_SOURCE_ORIGIN (default https://github.com/aabxtract/arbit)\n  PROGRAMMABLE_TOKEN_NAME/SYMBOL (default Arbit/ARBT)\n  PROGRAMMABLE_PROJECT_DESCRIPTION\n  PROGRAMMABLE_CHECKED_AT\nRefuses to run with PROGRAMMABLE_API_KEY set.\n`);
  process.exit(0);
}
if (Object.hasOwn(process.env, "PROGRAMMABLE_API_KEY")) {
  throw new TypeError("this unauthenticated builder refuses PROGRAMMABLE_API_KEY");
}

// ---- CLI package (verified 4.1.0): kit artifact + kernel helpers ----
const cliPkgDir = req("PROGRAMMABLE_CLI_PACKAGE", /^.+/);
const cliPkg = JSON.parse(await readFile(path.join(cliPkgDir, "package.json"), "utf8"));
if (cliPkg.version !== EXPECTED_CLI_VERSION) {
  throw new TypeError(`CLI package must be ${EXPECTED_CLI_VERSION}, got ${cliPkg.version}`);
}
const kitArtifact = JSON.parse(await readFile(
  path.join(cliPkgDir, "contracts", "robinhood-native-fee-v1", "artifact.json"), "utf8"));
if (solc.version() !== EXPECTED_SOLC) throw new TypeError(`need ${EXPECTED_SOLC}, got ${solc.version()}`);
const { createRobinhoodNativeFeeRuntimeImmutablesV1, ROBINHOOD_NATIVE_FEE_PERMISSIONS_V1 } =
  await import(pathToFileURL(path.join(cliPkgDir, "src", "robinhood-native-fee-v1.mjs")).href);
const { buildLaunch } = await import(pathToFileURL(path.join(cliPkgDir, "src", "pack.mjs")).href);
const { getContractAddress, keccak256 } = await import(
  pathToFileURL(path.join(cliPkgDir, "node_modules", "viem", "_esm", "index.js")).href
);

const root = path.dirname(fileURLToPath(import.meta.url)); // pack/
const DRYRUN = process.env.ARBIT_DRYRUN === "1";

// ---- inputs ----
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
const creatorBuyBps = reqInt("PROGRAMMABLE_CREATOR_BUY_BPS");
const creatorSellBps = reqInt("PROGRAMMABLE_CREATOR_SELL_BPS");
const startSqrtPrice = reqInt("PROGRAMMABLE_START_SQRT_PRICE");

// ---- our unit: vendor + compile ----
const TARGETS = [
  ["src/ArbitToken.sol", "ArbitToken", "token"],
  ["src/ArbitRegistry.sol", "ArbitRegistry", "registry"],
  ["src/ArbitFeeModule.sol", "ArbitFeeModule", "module"],
  ["src/ArbitDistributor.sol", "ArbitDistributor", "distributor"],
  ["src/ArbitInitializer.sol", "ArbitInitializer", "initializer"],
];
const PREFIX_MAP = {
  "@openzeppelin/contracts/": "lib/openzeppelin-contracts/contracts/",
  "v4-core/": "lib/v4-core/",
};
const sources = {};
const seen = new Set();
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
      depKey = depRepo; // lib/** keys match on-disk layout (kit convention)
      const rel = path.posix.relative(dir, depKey);
      const relNorm = rel.startsWith(".") ? rel : `./${rel}`;
      content = content.split(`"${spec}"`).join(`"${relNorm}"`);
      content = content.split(`'${spec}'`).join(`'${relNorm}'`);
    }
    await vendorFile(depRepo, depKey);
  }
  sources[keyPath] = { content };
}
for (const [rel] of TARGETS) await vendorFile(rel, rel);
const arbitInput = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 1000 },
    evmVersion: "cancun",
    metadata: { bytecodeHash: "none", appendCBOR: false },
    libraries: {},
    remappings: [],
    outputSelection: {
      "*": {
        "*": ["abi", "metadata", "evm.bytecode.object", "evm.bytecode.linkReferences", "evm.deployedBytecode.object", "evm.deployedBytecode.linkReferences", "evm.deployedBytecode.immutableReferences"],
        "": ["ast"],
      },
    },
  },
};
const arbitJsonBytes = Buffer.from(`${JSON.stringify(arbitInput)}\n`, "utf8");
const arbitOut = JSON.parse(solc.compile(JSON.stringify(arbitInput)));
{
  const errs = (arbitOut.errors ?? []).filter((e) => e.severity === "error");
  if (errs.length) throw new TypeError(errs.map((e) => e.formattedMessage).join("\n"));
}
await mkdir(path.join(root, "out"), { recursive: true });
await mkdir(path.join(root, "evidence"), { recursive: true });
await writeFile(path.join(root, "standard-json-arbit.json"), arbitJsonBytes);
// Mirror the closure to disk (pack/src/**, pack/lib/**) so the CLI's
// source.paths resolve to real files
for (const [keyPath, entry] of Object.entries(sources)) {
  const full = path.join(root, ...keyPath.split("/"));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, entry.content, "utf8");
}
for (const [sourcePath, contractName, targetId] of TARGETS) {
  const c = arbitOut.contracts?.[sourcePath]?.[contractName];
  if (!c?.abi || !c?.metadata || !c?.evm?.bytecode?.object || !c?.evm?.deployedBytecode?.object) {
    throw new TypeError(`incomplete compiler output for ${sourcePath}:${contractName}`);
  }
  await writeFile(path.join(root, "out", `${targetId}.json`), `${JSON.stringify({
    abi: c.abi, bytecode: c.evm.bytecode, deployedBytecode: c.evm.deployedBytecode, metadata: c.metadata,
  })}\n`);
}
// Kernel unit: EXACT kit input, byte-for-byte (reviewed). A separate augmented
// in-memory copy adds output selections for local artifact parsing only.
const kernelInput = structuredClone(kitArtifact.standardJsonInput);
await writeFile(path.join(root, "standard-json-kernel.json"), `${JSON.stringify(kernelInput)}\n`);
const kernelLocal = structuredClone(kernelInput);
kernelLocal.settings.outputSelection["*"]["*"] = [...new Set([
  ...kernelLocal.settings.outputSelection["*"]["*"],
  "metadata", "evm.bytecode.linkReferences", "evm.deployedBytecode.linkReferences",
])];
const kernelOut = JSON.parse(solc.compile(JSON.stringify(kernelLocal)));
{
  const errs = (kernelOut.errors ?? []).filter((e) => e.severity === "error");
  if (errs.length) throw new TypeError("kit kernel input failed to compile: " + errs.map((e) => e.formattedMessage).join("\n"));
}
const KERNEL_SRC = kitArtifact.kernel.sourcePath;
const KERNEL_NAME = kitArtifact.kernel.contractName;
const kernelCompiled = kernelOut.contracts[KERNEL_SRC][KERNEL_NAME];
await writeFile(path.join(root, "out", "kernel.json"), `${JSON.stringify({
  abi: kernelCompiled.abi, bytecode: kernelCompiled.evm.bytecode,
  deployedBytecode: kernelCompiled.evm.deployedBytecode, metadata: kernelCompiled.metadata,
})}\n`);

const moduleCodeHash = keccak256(
  `0x${JSON.parse(await readFile(path.join(root, "out", "module.json"), "utf8")).deployedBytecode.object}`,
);

// ---- capabilities + permit window + image ----
const imageBytes = await readFile(path.join(root, ...imageSourcePath.split("/")));
assertPng(imageBytes);
const capabilities = await (await fetch(CAPABILITIES_URL)).json();
const pm = capabilities?.chainDeployment?.contracts?.poolManager?.address;
const gf = capabilities?.chainDeployment?.contracts?.graphFactory?.address;
if (pm !== "0x8366a39CC670B4001A1121B8F6A443A643e40951" || !gf) {
  throw new TypeError("canonical trust-root binding changed — stop and review");
}
const [rpcChainId, finBlock] = await Promise.all([
  rpc("eth_chainId", []),
  rpc("eth_getBlockByNumber", ["finalized", false]),
]);
const permitWindow = permitFromFinalized(rpcChainId, finBlock, Math.floor(Date.parse(capabilities.serverTime) / 1000));

// ---- per-target immutable bindings (AST name-mapped) ----
function immutablesFor(fileKey, targetId, rules) {
  const ast = arbitOut.sources?.[fileKey]?.ast;
  const found = {};
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.nodeType === "VariableDeclaration" && n.mutability === "immutable" && n.stateVariable) {
      found[n.name] = { id: String(n.id), type: n.typeDescriptions?.typeString ?? "" };
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  })(ast);
  return Object.entries(found).map(([name, e]) => {
    const rule = rules[name];
    if (!rule) throw new TypeError(`${targetId}: no binding rule for immutable ${name}`);
    return { immutableId: e.id, abiType: e.type.startsWith("uint") ? "uint256" : "address", ...rule };
  });
}
const T = (target) => ({ target });
const L = (literal) => ({ literal });
const W = launchWallet;
const chainLit = "4663";
// runtimeImmutables literals must be canonical lowercase (pack-v4 contract)
const pmL = pm.toLowerCase();
const gfL = gf.toLowerCase();
const WL = W.toLowerCase();
const targetRules = {
  token: [],
  registry: immutablesFor("src/ArbitRegistry.sol", "registry", {
    arbitToken: T("token"), initializer: T("initializer"),
  }),
  module: immutablesFor("src/ArbitFeeModule.sol", "module", {
    registry: T("registry"),
  }),
  distributor: immutablesFor("src/ArbitDistributor.sol", "distributor", {
    manager: L(pmL), arbitToken: T("token"), keeper: L(WL),
  }),
  initializer: immutablesFor("src/ArbitInitializer.sol", "initializer", {
    manager: L(pmL), graphFactory: L(gfL), wallet: L(WL), chainId: L(chainLit),
  }),
};

// ---- config ----
const totalValue = (BigInt(buyWei) + BigInt(lpEthWei)).toString();
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = `0x${"00".repeat(32)}`;
// ARBIT_ZERO_MODULE=1: kernel module slot ZEROed (isolates whether the custom
// module triggers server 500s; everything else identical)
const ZERO_MODULE = process.env.ARBIT_ZERO_MODULE === "1";
const kernelPoolConfig = [
  T("token"), 8388608, 60, startSqrtPrice, T("initializer"), W,
  creatorBuyBps, creatorSellBps, ZERO_MODULE ? ZERO : T("module"), ZERO_MODULE ? "0" : 10000,
];
// Initial kernel immutable coverage with a ZERO vault placeholder (structurally
// complete so the first prediction pass runs); rewritten with the derived
// vault below, exactly like the native20 example.
function kernelImmutables(feeVault) {
  // NOTE: helper takes the RAW solc contract output (evm nesting), not the
  // flattened out/*.json artifact shape.
  return createRobinhoodNativeFeeRuntimeImmutablesV1(
    kernelCompiled,
    {
    poolManager: pmL, token: T("token"), lpFee: "8388608", tickSpacing: "60",
    initialSqrtPriceX96: startSqrtPrice, initializer: T("initializer"),
    creatorBuyFeeBps: creatorBuyBps, creatorSellFeeBps: creatorSellBps,
    module: ZERO_MODULE ? ZERO : T("module"), moduleCodeHash: ZERO_MODULE ? ZERO32 : moduleCodeHash,
    maxModuleLpFeePips: ZERO_MODULE ? "0" : "10000", feeVault,
    },
  );
}
const config = {
  schemaVersion: "programmable.launch-pack-config.v4",
  chainId: "4663",
  caip2: "eip155:4663",
  chainDeployment: capabilities.chainDeployment,
  profile: capabilities.profile,
  externalContracts: [],
  launchWallet: W,
  nonce,
  permitWindow,
  source: {
    root: ".",
    paths: ["src", "lib"],
    sourceLineageNonce: "1",
    publicOrigin: { url: new URL(sourceOrigin).href, revision: sourceRevision },
  },
  compilationUnits: [
    { compilationUnitId: "kernel", standardJson: "standard-json-kernel.json" },
    { compilationUnitId: "arbit", standardJson: "standard-json-arbit.json" },
  ],
  targets: [
    {
      targetId: "token", compilationUnitId: "arbit", artifact: "out/token.json",
      applicantSalt: `0x${"11".repeat(32)}`,
      constructorArguments: [W],
      initializer: null, deploymentValueWei: "0", initializerValueWei: "0",
      componentKind: "token", declaredHookPermissions: null,
      runtimeImmutables: targetRules.token,
    },
    {
      targetId: "registry", compilationUnitId: "arbit", artifact: "out/registry.json",
      applicantSalt: `0x${"22".repeat(32)}`,
      constructorArguments: [T("token"), T("initializer"), W],
      initializer: null, deploymentValueWei: "0", initializerValueWei: "0",
      componentKind: "other", declaredHookPermissions: null,
      runtimeImmutables: targetRules.registry,
    },
    {
      targetId: "module", compilationUnitId: "arbit", artifact: "out/module.json",
      applicantSalt: `0x${"33".repeat(32)}`,
      constructorArguments: [T("registry")],
      initializer: null, deploymentValueWei: "0", initializerValueWei: "0",
      componentKind: "other", declaredHookPermissions: null,
      runtimeImmutables: targetRules.module,
    },
    {
      targetId: "distributor", compilationUnitId: "arbit", artifact: "out/distributor.json",
      applicantSalt: `0x${"44".repeat(32)}`,
      constructorArguments: [pm, T("token"), W, W],
      initializer: null, deploymentValueWei: "0", initializerValueWei: "0",
      componentKind: "other", declaredHookPermissions: null,
      runtimeImmutables: targetRules.distributor,
    },
    {
      targetId: "hook", compilationUnitId: "kernel", artifact: "out/kernel.json",
      applicantSalt: { mode: "deterministic-hook-permission-grind-v1", start: "0", maxAttempts: "262144" },
      constructorArguments: [pm, kernelPoolConfig],
      initializer: null, deploymentValueWei: "0", initializerValueWei: "0",
      componentKind: "hook", declaredHookPermissions: [...ROBINHOOD_NATIVE_FEE_PERMISSIONS_V1],
      runtimeImmutables: kernelImmutables(ZERO), // rewritten with derived vault below
    },
    {
      targetId: "initializer", compilationUnitId: "arbit", artifact: "out/initializer.json",
      applicantSalt: `0x${"55".repeat(32)}`,
      constructorArguments: [pm, gf, W, 4663],
      initializer: {
        function: "initialize",
        arguments: [{
          registry: T("registry"),
          hook: T("hook"),
          token: T("token"),
          hookFund: hookFundArbt,
          seedAmount: seedArbt,
          buyAmount: buyWei,
          fee: 8388608,
          tickSpacing: 60,
          sqrtPrice: startSqrtPrice,
          tickLower: -600,
          tickUpper: 600,
          liquidityDelta: "100000000000000000000",
          minTokensOut,
        }],
      },
      deploymentValueWei: "0", initializerValueWei: totalValue,
      componentKind: "other", declaredHookPermissions: null,
      runtimeImmutables: targetRules.initializer,
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
  signing: false, broadcast: false, checkedAt, dryrun: DRYRUN,
}, null, 2)}\n`);
const configPath = path.join(root, "programmable-launch.config.json");
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

// ---- two-pass vault binding (mirror native20): predict hook, derive vault
// (CREATE nonce 1), rewrite kernel runtimeImmutables, rebuild, re-assert ----
const first = await buildLaunch({ configPath });
const hookAddr = first.predictions.find((p) => p.targetId === "hook").predictedAddress;
const vaultAddr = createAddress(hookAddr, 1n);
config.targets.find((t) => t.targetId === "hook").runtimeImmutables =
  kernelImmutables(vaultAddr);
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
const built = await buildLaunch({ configPath });
if (built.predictions.find((p) => p.targetId === "hook").predictedAddress !== hookAddr) {
  throw new TypeError("vault derivation changed the kernel address");
}
process.stdout.write(`PREDICTED hook=${hookAddr} vault=${vaultAddr}\n`);
process.stdout.write(`Wrote capability-bound programmable-launch.config.json${DRYRUN ? " (DRYRUN values)" : ""}; no signing or broadcast performed.\n`);


// CREATE nonce-address via the CLI's own pinned viem (exact keccak semantics)
function createAddress(from, nonce) {
  return getContractAddress({ from, nonce });
}

// ---- helpers (same contracts as v1 builder) ----
function req(n, re) {
  const v = process.env[n];
  if (typeof v !== "string" || v.length === 0 || (re && !re.test(v))) throw new TypeError(`${n} missing/invalid`);
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
  return req(n, /^https:\/\/x\.com\/[A-Za-z0-9_]{1,64}$/);
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
function permitFromFinalized(chainId, block, nowSeconds) {
  if (BigInt(chainId) !== 4663n) throw new TypeError("RPC is not Robinhood mainnet");
  const ts = BigInt(block.timestamp);
  const now = BigInt(nowSeconds);
  if (ts > now) throw new TypeError("finalized checkpoint is in the future");
  const validAfter = ts - 60n;
  const deadline = validAfter + 3600n;
  if (validAfter < now - 3600n || deadline < now + 300n) {
    throw new TypeError("stale finalized checkpoint");
  }
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
