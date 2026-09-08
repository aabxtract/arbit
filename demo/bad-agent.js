import { ethers } from "ethers";

// Misbehaving agent: reuses an executor deployed + registered by good-agent.js
// (set EXECUTOR_ADDRESS), then attempts an oversized swap.
// PENALTY LANE: the violating swap still executes, and the slash + suspension
// commit in the SAME successful transaction. The NEXT attempt hard-blocks.

if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY env var is required but not set");
const ARBT_ADDRESS = process.env.ARBT_ADDRESS || process.env.ARBT_TOKEN_ADDRESS;
const { REGISTRY_ADDRESS, HOOK_ADDRESS, POOL_KEY_JSON, RPC_URL, EXECUTOR_ADDRESS } = process.env;
for (const [k, v] of Object.entries({
  ARBT_ADDRESS,
  REGISTRY_ADDRESS,
  HOOK_ADDRESS,
  POOL_KEY_JSON,
  RPC_URL,
  EXECUTOR_ADDRESS,
})) {
  if (!v) throw new Error(`Missing required env var: ${k}`);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const REGISTRY_ABI = [
  "function getManifest(address) view returns (tuple(uint256 maxSwapSize,uint256 frequencyCap,uint256 stakedAmount,uint256 reputationScore,uint256 lastSwapTime,uint8 status))",
  "event AgentSlashed(address indexed agent, uint256 amount, uint8 violationType)",
];
const HOOK_ABI = ["event SwapPenalized(address indexed executor, uint8 violationType)"];
const EXECUTOR_ABI = [
  "function swapExactInputSingle(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, bool zeroForOne, uint256 amountIn, bytes hookData)",
  "function rescue(address currency, uint256 amount)",
  "event SwapBlocked(address indexed executor, bytes revertData)",
];
const TOKEN_ABI = ["function approve(address,uint256) returns (bool)"];

const token = new ethers.Contract(ARBT_ADDRESS, TOKEN_ABI, wallet);
const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, wallet);
const hook = new ethers.Contract(HOOK_ADDRESS, HOOK_ABI, wallet);
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
const tx2 = await executor.swapExactInputSingle(poolKey, true, ethers.parseEther("1"), "0x");
const receipt2 = await tx2.wait();
const blockedTopic = executor.interface.getEvent("SwapBlocked").topicHash;
const blocked = receipt2.logs.some((l) => l.topics[0] === blockedTopic);
console.log(blocked ? "Retry hard-blocked (SwapBlocked emitted)" : "WARNING: expected SwapBlocked on retry");
