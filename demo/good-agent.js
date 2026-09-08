import { ethers } from "ethers";
import { readFileSync } from "fs";

// Well-behaved agent: deploys its own executor (its onchain identity),
// registers a manifest + stake, then swaps within the cap and earns reputation.

if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY env var is required but not set");
const ARBT_ADDRESS = process.env.ARBT_ADDRESS || process.env.ARBT_TOKEN_ADDRESS;
const { REGISTRY_ADDRESS, POOL_MANAGER_ADDRESS, POOL_KEY_JSON, RPC_URL } = process.env;
for (const [k, v] of Object.entries({ ARBT_ADDRESS, REGISTRY_ADDRESS, POOL_MANAGER_ADDRESS, POOL_KEY_JSON, RPC_URL })) {
  if (!v) throw new Error(`Missing required env var: ${k}`);
}

const provider = new ethers.JsonRpcProvider(RPC_URL); // Robinhood Chain, chain ID 4663
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const TOKEN_ABI = ["function approve(address,uint256) returns (bool)"];
const REGISTRY_ABI = [
  "function getManifest(address) view returns (tuple(uint256 maxSwapSize,uint256 frequencyCap,uint256 stakedAmount,uint256 reputationScore,uint256 lastSwapTime,uint8 status))",
];
const EXECUTOR_ABI = [
  "constructor(address manager, address registry)",
  "function register(uint256 maxSwapSize, uint256 frequencyCap, uint256 stakeAmount)",
  "function swapExactInputSingle(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, bool zeroForOne, uint256 amountIn, bytes hookData)",
];

const token = new ethers.Contract(ARBT_ADDRESS, TOKEN_ABI, wallet);
const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, wallet);
const poolKey = JSON.parse(POOL_KEY_JSON);

const MAX_SWAP_SIZE = ethers.parseEther("50"); // manifest cap
const FREQUENCY_CAP = 60n; // 60s between swaps
const STAKE = ethers.parseEther("100"); // MIN_STAKE

// 1. Deploy the per-agent executor — its address IS the agent identity
const artifact = JSON.parse(readFileSync("../out/ArbitAgentExecutor.sol/ArbitAgentExecutor.json", "utf8"));
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
console.log("EXECUTOR_ADDRESS=" + executorAddress);
