#!/usr/bin/env node
// Arbit pack builder v3 — seed-shape graph (profile 4.1.0).
// Targets: seed-token (exact) + kernel (exact kit) + seed-initializer (exact)
// + distributor (ours). Registry/hook/module/badge ship post-launch or live
// on testnet; they are NOT packed. No key, no signing, no broadcast.
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
  process.stdout.write(`Arbit seed-shape pack builder\n\nRequired env:\n  PROGRAMMABLE_LAUNCH_WALLET (0x...40hex)\n  PROGRAMMABLE_LAUNCH_NONCE (0x...64hex nonzero)\n  PROGRAMMABLE_SOURCE_REVISION (40-hex public commit)\n  PROGRAMMABLE_PROJECT_IMAGE_SOURCE_PATH (assets/arbit-official.png)\n  PROGRAMMABLE_PROJECT_IMAGE_URI (https)\n  PROGRAMMABLE_WEBSITE_URL, PROGRAMMABLE_X_URL\n  PROGRAMMABLE_CLI_PACKAGE (abs path to verified @programmable/launch 4.1.0)\n  PROGRAMMABLE_INITIAL_BUY_WEI, PROGRAMMABLE_MAX_GAS_WEI, PROGRAMMABLE_MIN_TOKENS_OUT\n  PROGRAMMABLE_CREATOR_BUY_BPS, PROGRAMMABLE_CREATOR_SELL_BPS\nOptional:\n  PROGRAMMABLE_SOURCE_ORIGIN, PROGRAMMABLE_TOKEN_NAME/SYMBOL, PROGRAMMABLE_PROJECT_DESCRIPTION\n  PROGRAMMABLE_CHECKED_AT\nRefuses to run with PROGRAMMABLE_API_KEY set.\n`);
  process.exit(0);
}
if (Object.hasOwn(process.env, "PROGRAMMABLE_API_KEY")) {
  throw new TypeError("this unauthenticated builder refuses PROGRAMMABLE_API_KEY");
}

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
const minTokensOut = reqInt("PROGRAMMABLE_MIN_TOKENS_OUT");
const creatorBuyBps = reqInt("PROGRAMMABLE_CREATOR_BUY_BPS");
const creatorSellBps = reqInt("PROGRAMMABLE_CREATOR_SELL_BPS");

// ---- units ----
// kernel: EXACT kit input, byte-for-byte.
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
  if (errs.length) throw new TypeError("kit kernel input failed: " + errs.map((e) => e.formattedMessage).join("\n"));
}
const kernelCompiled =
  kernelOut.contracts[kitArtifact.kernel.sourcePath][kitArtifact.kernel.contractName];
await writeFile(path.join(root, "out", "kernel.json"), `${JSON.stringify({
  abi: kernelCompiled.abi, bytecode: kernelCompiled.evm.bytecode,
  deployedBytecode: kernelCompiled.evm.deployedBytecode, metadata: kernelCompiled.metadata,
})}\n`);
// seed: reviewed native20 unit, copied verbatim from the reference build.
// A separate augmented in-memory copy adds output selections for local
// artifact parsing only (submitted bytes stay exact).
const seedInput = JSON.parse(await readFile(path.join(root, "standard-json-seed.json"), "utf8"));
const seedLocal = structuredClone(seedInput);
seedLocal.settings.outputSelection["*"]["*"] = [...new Set([
  ...seedLocal.settings.outputSelection["*"]["*"],
  "metadata", "evm.bytecode.linkReferences", "evm.deployedBytecode.linkReferences",
])];
const seedOut = JSON.parse(solc.compile(JSON.stringify(seedLocal)));
{
  const errs = (seedOut.errors ?? []).filter((e) => e.severity === "error");
  if (errs.length) throw new TypeError("seed unit failed: " + errs.map((e) => e.formattedMessage).join("\n"));
}
const SEED_TOKEN = ["src/RobinhoodNative20Token.sol", "RobinhoodNative20Token"];
const SEED_INIT = ["src/RobinhoodNative20Initializer.sol", "RobinhoodNative20Initializer"];
for (const [sp, cn, tid] of [[...SEED_TOKEN, "token"], [...SEED_INIT, "initializer"]]) {
  const c = seedOut.contracts?.[sp]?.[cn];
  if (!c?.abi || !c?.evm?.bytecode?.object) throw new TypeError(`seed artifact missing for ${tid}`);
  await writeFile(path.join(root, "out", `${tid}.json`), `${JSON.stringify({
    abi: c.abi, bytecode: c.evm.bytecode, deployedBytecode: c.evm.deployedBytecode, metadata: c.metadata,
  })}\n`);
}
// arbit unit: distributor (+ closure) under arbit/ namespace (no key collisions).
const ARBIT_TARGETS = [["src/ArbitDistributor.sol", "ArbitDistributor", "distributor"]];
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
      depKey = `arbit/lib/${depRepo.slice(4)}`;
      const rel = path.posix.relative(dir, depKey);
      const relNorm = rel.startsWith(".") ? rel : `./${rel}`;
      content = content.split(`"${spec}"`).join(`"${relNorm}"`);
      content = content.split(`'${spec}'`).join(`'${relNorm}'`);
    }
    await vendorFile(depRepo, depKey);
  }
  sources[keyPath] = { content };
}
for (const [rel] of ARBIT_TARGETS) await vendorFile(rel, `arbit/${rel}`);
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
await writeFile(path.join(root, "standard-json-arbit.json"), `${JSON.stringify(arbitInput)}\n`);
const arbitOut = JSON.parse(solc.compile(JSON.stringify(arbitInput)));
{
  const errs = (arbitOut.errors ?? []).filter((e) => e.severity === "error");
  if (errs.length) throw new TypeError(errs.map((e) => e.formattedMessage).join("\n"));
}
for (const [sourcePath, contractName, targetId] of ARBIT_TARGETS) {
  const c = arbitOut.contracts?.[`arbit/${sourcePath}`]?.[contractName];
  if (!c?.abi || !c?.evm?.bytecode?.object) throw new TypeError(`arbit artifact missing for ${targetId}`);
  await writeFile(path.join(root, "out", `${targetId}.json`), `${JSON.stringify({
    abi: c.abi, bytecode: c.evm.bytecode, deployedBytecode: c.evm.deployedBytecode, metadata: c.metadata,
  })}\n`);
}
// Mirror both closures to disk (pack/src, pack/lib, pack/arbit/**)
await mkdir(path.join(root, "out"), { recursive: true });
await mkdir(path.join(root, "evidence"), { recursive: true });
for (const [keyPath, entry] of Object.entries({ ...seedInput.sources, ...sources })) {
  const full = path.join(root, ...keyPath.split("/"));
  await mkdir(path.dirname(full), { recursive: true });
  const content = typeof entry === "string" ? entry : entry.content;
  await writeFile(full, content, "utf8");
}

// ---- per-target immutable bindings (AST name-mapped) ----
function immutablesForSources(compiledSources, fileKey, targetId, rules) {
  const ast = compiledSources?.[fileKey]?.ast;
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
function immutablesFor(fileKey, targetId, rules) {
  return immutablesForSources(arbitOut.sources, fileKey, targetId, rules);
}

// ---- capabilities + permit window + image ----
const imageBytes = await readFile(path.join(root, ...imageSourcePath.split("/")));
assertPng(imageBytes);
const capabilities = await (await fetch(CAPABILITIES_URL)).json();
const pm = capabilities?.chainDeployment?.contracts?.poolManager?.address;
const gf = capabilities?.chainDeployment?.contracts?.graphFactory?.address;
if (pm !== "0x8366a39CC670B4001A1121B8F6A443A643e40951" || !gf) {
  throw new TypeError("canonical trust-root binding changed — stop and review");
}
const pmL = pm.toLowerCase();
const gfL = gf.toLowerCase();
const WL = W.toLowerCase();
const [rpcChainId, finBlock] = await Promise.all([
  rpc("eth_chainId", []),
  rpc("eth_getBlockByNumber", ["finalized", false]),
]);
const permitWindow = permitFromFinalized(rpcChainId, finBlock, Math.floor(Date.parse(capabilities.serverTime) / 1000));

// ---- config ----
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = `0x${"00".repeat(32)}`;
const FIXED_PRICE = "1747735933952748037356115466503453";
const totalValue = buyWei; // buyer-funded: only the atomic first buy carries value
function kernelImmutables(feeVault) {
  // NOTE: helper takes the RAW solc contract output (evm nesting), not the
  // flattened out/*.json artifact shape.
  return createRobinhoodNativeFeeRuntimeImmutablesV1(
    kernelCompiled,
    {
      poolManager: pmL, token: T("token"), lpFee: "0", tickSpacing: "60",
      initialSqrtPriceX96: FIXED_PRICE, initializer: T("initializer"),
      creatorBuyFeeBps: creatorBuyBps, creatorSellFeeBps: creatorSellBps, module: ZERO,
      moduleCodeHash: ZERO32, maxModuleLpFeePips: "0", feeVault,
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
    paths: ["src", "lib", "arbit/src", "arbit/lib"],
    sourceLineageNonce: "1",
    publicOrigin: { url: new URL(sourceOrigin).href, revision: sourceRevision },
  },
  compilationUnits: [
    { compilationUnitId: "kernel", standardJson: "standard-json-kernel.json" },
    { compilationUnitId: "seed", standardJson: "standard-json-seed.json" },
    { compilationUnitId: "arbit", standardJson: "standard-json-arbit.json" },
  ],
  targets: [
    {
      targetId: "token", compilationUnitId: "seed", artifact: "out/token.json",
      applicantSalt: `0x${"02".repeat(32)}`,
      constructorArguments: [{ target: "initializer" }, tokenName, tokenSymbol],
      initializer: null, deploymentValueWei: "0", initializerValueWei: "0",
      componentKind: "token", declaredHookPermissions: null, runtimeImmutables: [],
    },
    {
      targetId: "hook", compilationUnitId: "kernel", artifact: "out/kernel.json",
      applicantSalt: { mode: "deterministic-hook-permission-grind-v1", start: "0", maxAttempts: "262144" },
      constructorArguments: [pm, [{ target: "token" }, 0, 60, FIXED_PRICE, { target: "initializer" }, W, creatorBuyBps, creatorSellBps, ZERO, 0]],
      initializer: null, deploymentValueWei: "0", initializerValueWei: "0",
      componentKind: "hook", declaredHookPermissions: [...ROBINHOOD_NATIVE_FEE_PERMISSIONS_V1],
      runtimeImmutables: kernelImmutables(ZERO),
    },
    {
      targetId: "initializer", compilationUnitId: "seed", artifact: "out/initializer.json",
      applicantSalt: `0x${"01".repeat(32)}`,
      constructorArguments: [pm, gf],
      initializer: {
        function: "initialize",
        arguments: [{ target: "token" }, { target: "hook" }, W, minTokensOut],
      },
      deploymentValueWei: "0", initializerValueWei: buyWei,
      componentKind: "other", declaredHookPermissions: null,
      runtimeImmutables: immutablesForSources(seedOut.sources, "src/RobinhoodNative20Initializer.sol", "initializer", {
        poolManager: L(pm.toLowerCase()), graphFactory: L(gf.toLowerCase()),
      }),
    },
    {
      targetId: "distributor", compilationUnitId: "arbit", artifact: "out/distributor.json",
      applicantSalt: `0x${"44".repeat(32)}`,
      constructorArguments: [pm, { target: "token" }, W, W],
      initializer: null, deploymentValueWei: "0", initializerValueWei: "0",
      componentKind: "other", declaredHookPermissions: null,
      runtimeImmutables: immutablesFor("arbit/src/ArbitDistributor.sol", "distributor", {
        manager: L(pmL), arbitToken: T("token"), keeper: L(WL),
      }),
    },
  ],
  pool: {
    tokenTargetId: "token", hookTargetId: "hook", fee: 0, tickSpacing: 60,
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
  funding: { schemaVersion: "programmable.custom-launch-funding-intent.v2", mode: "wallet-transaction-value", valueWei: buyWei },
  fundingPlan: {
    schemaVersion: "programmable.robinhood-funding-plan.v1",
    capitalSource: "buyer-funded",
    pricingModel: "concentrated-liquidity",
    nativeAllocations: {
      initialLiquidityWei: "0", initialBuyWei: buyWei, reserveWei: "0", otherLaunchValueWei: "0",
    },
    maxLaunchValueWei: buyWei,
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

// ---- two-pass vault binding: predict hook, derive vault, rewrite, rebuild ----
const { getContractAddress } = await import(
  pathToFileURL(path.join(cliPkgDir, "node_modules", "viem", "_esm", "index.js")).href
);
const first = await buildLaunch({ configPath });
const hookAddr = first.predictions.find((p) => p.targetId === "hook").predictedAddress;
const vaultAddr = getContractAddress({ from: hookAddr, nonce: 1n });
config.targets.find((t) => t.targetId === "hook").runtimeImmutables =
  kernelImmutables(vaultAddr);
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
const built = await buildLaunch({ configPath });
if (built.predictions.find((p) => p.targetId === "hook").predictedAddress !== hookAddr) {
  throw new TypeError("vault derivation changed the kernel address");
}
process.stdout.write(`PREDICTED hook=${hookAddr} vault=${vaultAddr}\n`);
process.stdout.write(`Wrote capability-bound programmable-launch.config.json${DRYRUN ? " (DRYRUN values)" : ""}; no signing or broadcast performed.\n`);

// ---- helpers ----
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
