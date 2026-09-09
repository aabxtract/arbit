// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @title ArbitRegistry (kernel-path note)
/// @notice Same registry. On the official pool the KERNEL is the hook and the
/// view-only fee module reads tiers via previewFee; keeper-poked patterns
/// feed bot detection (see poke). The setHook path remains for standalone /
/// testnet / mirror pools using ArbitHook.
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
    address public immutable initializer;
    bool private hookSet;
    mapping(address => bool) public keepers;

    uint256 public constant MIN_STAKE = 100e18;
    uint256 public constant MAX_REPUTATION = 1000;

    uint256 public constant FEE_HUMAN = 30;
    uint256 public constant FEE_AGENT_HIGH = 5;
    uint256 public constant FEE_AGENT_MED = 15;
    uint256 public constant FEE_AGENT_LOW = 30;
    uint256 public constant FEE_BOT = 100;
    uint256 public constant MAX_FEE_BPS = 500;

    event AgentRegistered(address agent, uint256 stake);
    event ReputationUpdated(address agent, uint256 score, bool increased);
    event PoolAllowed(PoolId indexed poolId);
    event HookSet(address indexed hook);
    event KeeperSet(address indexed keeper, bool allowed);

    modifier onlyHook() {
        require(msg.sender == hook, "Only hook");
        _;
    }

    modifier onlyHookOrKeeper() {
        require(msg.sender == hook || keepers[msg.sender], "Only hook/keeper");
        _;
    }

    constructor(address _arbitToken, address _initializer, address _owner)
        Ownable(_owner)
    {
        require(_arbitToken != address(0) && _owner != address(0), "Zero address");
        arbitToken = _arbitToken;
        initializer = _initializer;
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        keepers[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

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
        agents[msg.sender] = Agent({stakedAmount: stakeAmount, reputationScore: 500, active: true});
        IERC20(arbitToken).safeTransferFrom(msg.sender, address(this), stakeAmount);
        emit AgentRegistered(msg.sender, stakeAmount);
    }

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

    function classify(address swapper, uint256 gasPrice)
        external
        onlyHook
        returns (uint256 feeBps, ParticipantType pType)
    {
        Agent storage agent = agents[swapper];
        if (agent.active) {
            if (agent.reputationScore >= 800) return (FEE_AGENT_HIGH, ParticipantType.AGENT_HIGH);
            if (agent.reputationScore >= 500) return (FEE_AGENT_MED, ParticipantType.AGENT_MED);
            return (FEE_AGENT_LOW, ParticipantType.AGENT_LOW);
        }
        BotPattern storage pattern = botPatterns[swapper];
        bool isBot = _isBot(gasPrice, pattern);
        _recordPattern(gasPrice, pattern);
        if (isBot) return (FEE_BOT, ParticipantType.BOT);
        return (FEE_HUMAN, ParticipantType.HUMAN);
    }

    function poke(address trader, uint256 gasPrice) external {
        _recordPattern(gasPrice, botPatterns[trader]);
    }

    function _recordPattern(uint256 gasPrice, BotPattern storage pattern) internal {
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
        // Division (not avg*3) — multiplication can overflow after a hostile
        // poke() with extreme gas values, bricking previewFee/classify for
        // the victim (review finding Sep 8, critical DoS). Semantics equal
        // within 3 wei, which is noise at gas-price magnitudes.
        bool gasSpike = pattern.avgGasPrice > 0 && gasPrice / 3 > pattern.avgGasPrice;
        return highFreq || gasSpike;
    }

    function reward(address agent) external onlyHookOrKeeper nonReentrant {
        Agent storage a = agents[agent];
        if (!a.active) return;
        uint256 newScore = a.reputationScore + 5;
        a.reputationScore = newScore > MAX_REPUTATION ? MAX_REPUTATION : newScore;
        emit ReputationUpdated(agent, a.reputationScore, true);
    }

    function slash(address agent) external onlyHookOrKeeper nonReentrant {
        Agent storage a = agents[agent];
        if (!a.active) return;
        a.reputationScore = a.reputationScore > 50 ? a.reputationScore - 50 : 0;
        if (a.reputationScore == 0) a.active = false;
        emit ReputationUpdated(agent, a.reputationScore, false);
    }

    function getAgent(address swapper) external view returns (Agent memory) {
        return agents[swapper];
    }
}
