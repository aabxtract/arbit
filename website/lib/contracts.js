export const CONFIG = {
  MAINNET_CHAIN_ID: 4663,
  TESTNET_CHAIN_ID: 46630,
  CHAIN_NAME: "Robinhood Chain Testnet",
  MAINNET_NAME: "Robinhood Chain",
  RPC_URL: process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.testnet.chain.robinhood.com",
  MAINNET_RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
  
  HOOK_ADDRESS: process.env.NEXT_PUBLIC_HOOK_ADDRESS || "0xb099980588E1458D678E5bdfe048A37f910A40C0",
  REGISTRY_ADDRESS: process.env.NEXT_PUBLIC_REGISTRY_ADDRESS || "0x07f0118fe19c003D7AE90C7D43b4d1D3985eCa9b",
  ARBT_ADDRESS: process.env.NEXT_PUBLIC_ARBT_ADDRESS || "0xd2cAA129a525D65684C112b074425E8d85a71533",
  POOL_MANAGER_ADDRESS: process.env.NEXT_PUBLIC_POOL_MANAGER_ADDRESS || "0x38d13B77728c357652313AA0a6fc97229F44CD8E",
  
  TESTNET_EXPLORER: "https://explorer.testnet.chain.robinhood.com",
  MAINNET_EXPLORER: "https://robinhoodchain.blockscout.com",
  X_URL: "https://x.com/arbit_hook",
  
  TOTAL_SUPPLY: "1,000,000,000 ARBT",
  DEAD_ADDRESS: "0x000000000000000000000000000000000000dEaD",
};

export const HOOK_ABI = [
  "function getPoolState() external view returns (uint256 _buybackPool, uint256 _victimPool, uint256 _lastBuybackTime, uint256 _nextBuybackEligible)",
  "function buybackPool() external view returns (uint256)",
  "function victimPool() external view returns (uint256)",
  "function lastBuybackTime() external view returns (uint256)",
  "function BUYBACK_COOLDOWN() external view returns (uint256)",
  "function MIN_BUYBACK_AMOUNT() external view returns (uint256)",
  "function badge() external view returns (address)",
  "function arbitToken() external view returns (address)",
  "function registry() external view returns (address)",
  "function pendingRewards(address) external view returns (uint256)",
  "function claimBadge(uint8 tier) external",
  "function claimReward() external",
  "event FeeCollected(address swapper, uint256 feeBps, uint8 pType)",
  "event BuybackExecuted(uint256 amount, uint256 timestamp)",
  "event AgentRewarded(address agent, uint256 amount)",
  "event VictimCompensated(address victim, uint256 amount)"
];

export const REGISTRY_ABI = [
  "function register(uint256 stakeAmount) external",
  "function getAgent(address swapper) external view returns (tuple(uint256 stakedAmount, uint256 reputationScore, bool active))",
  "function previewFee(address swapper, uint256 gasPrice) external view returns (uint256 feeBps, uint8 pType)",
  "function MIN_STAKE() external view returns (uint256)",
  "function MAX_REPUTATION() external view returns (uint256)",
  "event AgentRegistered(address agent, uint256 stake)",
  "event ReputationUpdated(address agent, uint256 score, bool increased)"
];

export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

export const BADGE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function claimed(address owner, uint8 tier) view returns (bool)",
  "function tierOf(uint256 tokenId) view returns (uint8)"
];
