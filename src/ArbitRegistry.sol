// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @title ArbitRegistry
/// @notice Agent registration + stake, reputation scores, bot-pattern data,
/// and the canonical pool allowlist. Spec: arbit-final-build-guide.md.
/// @dev Standard ERC-20 only. Fee-on-transfer / rebase / callback tokens are
/// unsupported and will break accounting — do not register them.
contract ArbitRegistry is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum ParticipantType {
        HUMAN,
        AGENT_HIGH,
        AGENT_MED,
        AGENT_LOW,
        BOT
    }

    struct Agent {
        uint256 stakedAmount;
        uint256 reputationScore; // 0-1000, starts 500
        bool active;
    }

    struct BotPattern {
        uint256 lastSwapBlock;
        uint256 swapsInWindow;
        uint256 avgGasPrice;
    }

    mapping(address => Agent) public agents;
    mapping(address => BotPattern) public botPatterns;
    mapping(PoolId => bool) public allowedPools;

    address public immutable arbitToken;
    address public hook;
    /// @notice Launch initializer (graph target). May call setHook/allowPool
    /// during the atomic launch — the owner EOA cannot act in-launch, so this
    /// path is what wires the official pool before its first swap.
    address public immutable initializer;
    bool private hookSet;

    uint256 public constant MIN_STAKE = 100e18;
    uint256 public constant MAX_REPUTATION = 1000;

    // Fee tiers in basis points
    uint256 public constant FEE_HUMAN = 30; // 0.30%
    uint256 public constant FEE_AGENT_HIGH = 5; // 0.05%
    uint256 public constant FEE_AGENT_MED = 15; // 0.15%
    uint256 public constant FEE_AGENT_LOW = 30; // 0.30%
    uint256 public constant FEE_BOT = 100; // 1.00%
    uint256 public constant MAX_FEE_BPS = 500; // hard cap 5%

    event AgentRegistered(address agent, uint256 stake);
    event ReputationUpdated(address agent, uint256 score, bool increased);
    event PoolAllowed(PoolId indexed poolId);
    event HookSet(address indexed hook);

    modifier onlyHook() {
        require(msg.sender == hook, "Only hook");
        _;
    }

    constructor(address _arbitToken, address _initializer, address _owner)
        Ownable(_owner)
    {
        require(_arbitToken != address(0) && _owner != address(0), "Zero address");
        arbitToken = _arbitToken;
        initializer = _initializer; // zero = no in-launch wiring (tests / standalone)
    }

    /// @notice Set once — by the launch initializer in-launch, or by the owner after.
    function setHook(address _hook) external {
        require(!hookSet, "Hook already set");
        require(_hook != address(0), "Zero address");
        require(
            msg.sender == owner() || msg.sender == initializer, "Not owner/initializer"
        );
        hook = _hook;
        hookSet = true;
        emit HookSet(_hook);
    }

    /// @notice Owner approves which pools can use this registry.
    /// The initializer wires the official pool during launch (same gating).
    /// The allowlist is load-bearing: swaps on non-allowlisted pools skip all
    /// accounting, so unbacked reward claims are impossible by construction.
    function allowPool(PoolId poolId) external {
        require(
            msg.sender == owner() || msg.sender == initializer, "Not owner/initializer"
        );
        allowedPools[poolId] = true;
        emit PoolAllowed(poolId);
    }

    function register(uint256 stakeAmount) external nonReentrant {
        require(stakeAmount >= MIN_STAKE, "Below minimum stake");
        require(!agents[msg.sender].active, "Already registered");

        // EFFECT first (CEI) — state before any external interaction.
        agents[msg.sender] = Agent({stakedAmount: stakeAmount, reputationScore: 500, active: true});

        // INTERACTION last (SafeERC20 — reverts on non-standard return values).
        IERC20(arbitToken).safeTransferFrom(msg.sender, address(this), stakeAmount);

        emit AgentRegistered(msg.sender, stakeAmount);
    }

    /// @notice View-only fee preview — safe to call anywhere, changes nothing.
    function previewFee(address swapper, uint256 gasPrice)
        external
        view
        returns (uint256 feeBps, ParticipantType pType)
    {
        Agent storage agent = agents[swapper];

        if (agent.active) {
            if (agent.reputationScore >= 800) return (FEE_AGENT_HIGH, ParticipantType.AGENT_HIGH);
            if (agent.reputationScore >= 500) return (FEE_AGENT_MED, ParticipantType.AGENT_MED);
            return (FEE_AGENT_LOW, ParticipantType.AGENT_LOW);
        }

        BotPattern storage pattern = botPatterns[swapper];
        if (_isBot(gasPrice, pattern)) return (FEE_BOT, ParticipantType.BOT);
        return (FEE_HUMAN, ParticipantType.HUMAN);
    }

    /// @notice Called by the hook ONCE per swap (in beforeSwap).
    /// The hook caches the result for afterSwap — never call twice per swap.
    /// O(1), no loops.
    function classify(address swapper, uint256 gasPrice)
        external
        onlyHook
        returns (uint256 feeBps, ParticipantType pType)
    {
        Agent storage agent = agents[swapper];

        // Registered agent path
        if (agent.active) {
            if (agent.reputationScore >= 800) return (FEE_AGENT_HIGH, ParticipantType.AGENT_HIGH);
            if (agent.reputationScore >= 500) return (FEE_AGENT_MED, ParticipantType.AGENT_MED);
            return (FEE_AGENT_LOW, ParticipantType.AGENT_LOW);
        }

        // Bot detection — pattern analysis O(1)
        BotPattern storage pattern = botPatterns[swapper];
        bool isBot = _isBot(gasPrice, pattern);

        // Record pattern (shared with poke() below)
        _recordPattern(gasPrice, pattern);

        if (isBot) return (FEE_BOT, ParticipantType.BOT);
        return (FEE_HUMAN, ParticipantType.HUMAN);
    }

    /// @notice Permissionless pattern recorder for view-only consumers (the
    /// kernel fee module cannot write state, so keepers/demo scripts record
    /// observed swaps here; classification reads last-written data, one tx lag).
    /// Griefing bound: poking only inflates the recorded trader's own
    /// frequency (they price as BOT and overpay LPs) — attacker pays gas,
    /// victim loses basis points per swap, LPs gain. Disclosed, accepted.
    function poke(address trader, uint256 gasPrice) external {
        _recordPattern(gasPrice, botPatterns[trader]);
    }

    function _recordPattern(uint256 gasPrice, BotPattern storage pattern) internal {
        // Update pattern
        if (block.number <= pattern.lastSwapBlock + 10) {
            pattern.swapsInWindow++;
        } else {
            pattern.swapsInWindow = 1;
        }
        pattern.lastSwapBlock = block.number;
        pattern.avgGasPrice =
            pattern.avgGasPrice == 0 ? gasPrice : (pattern.avgGasPrice + gasPrice) / 2;
    }

    function _isBot(uint256 gasPrice, BotPattern storage pattern)
        internal
        view
        returns (bool)
    {
        bool highFreq =
            pattern.swapsInWindow >= 3 && block.number <= pattern.lastSwapBlock + 10;
        bool gasSpike = pattern.avgGasPrice > 0 && gasPrice > pattern.avgGasPrice * 3;
        return highFreq || gasSpike;
    }

    function reward(address agent) external onlyHook nonReentrant {
        Agent storage a = agents[agent];
        if (!a.active) return;
        // EFFECT
        uint256 newScore = a.reputationScore + 5;
        a.reputationScore = newScore > MAX_REPUTATION ? MAX_REPUTATION : newScore;
        emit ReputationUpdated(agent, a.reputationScore, true);
    }

    function slash(address agent) external onlyHook nonReentrant {
        Agent storage a = agents[agent];
        if (!a.active) return;
        // EFFECT
        a.reputationScore = a.reputationScore > 50 ? a.reputationScore - 50 : 0;
        if (a.reputationScore == 0) a.active = false;
        emit ReputationUpdated(agent, a.reputationScore, false);
    }

    function getAgent(address swapper) external view returns (Agent memory) {
        return agents[swapper];
    }
}
