// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUnlockCallback} from "../lib/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPoolManager} from "../lib/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "../lib/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "../lib/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "../lib/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "../lib/v4-core/src/types/Currency.sol";
import {SwapParams} from "../lib/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "../lib/v4-core/src/libraries/TickMath.sol";

/// @notice Minimal creator-fee vault interface (exact kernel's vault).
interface ICreatorVault {
    function claimCreator() external returns (uint256 amount);
}

/// @title ArbitDistributor
/// @notice Creator-fee sidecar for the kernel path: claims accrued creator ETH
/// from the fee vault, market-buys ARBT and burns most of it (Guard-gated),
/// holding back a victim reserve paid out by the owner. Agent perks on the
/// official pool are fee discounts (module tiers), not token payouts.
/// @dev Keeper-gated (not permissionless): the caller-supplied minTokensOut
/// is MEV-sensitive, so a designated keeper runs buys off fresh quotes.
/// TWAP-based permissionless execution is post-hackathon.
contract ArbitDistributor is Ownable, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable manager;
    address public immutable arbitToken;
    address public immutable keeper;
    ICreatorVault public vault;
    bool private vaultSet;

    // Buyback Guard — same semantics as the hook's, in exact ETH units
    uint256 public lastBuybackTime;
    uint256 public victimPool; // ETH reserved for victims
    uint256 public constant BUYBACK_COOLDOWN = 1 hours;
    uint256 public constant MIN_BUYBACK_ETH = 0.005 ether;
    uint256 public constant VICTIM_SHARE = 20; // 20% of each buyback reserved

    PoolKey public buyKey; // ARBT/ETH pool used for market buys (set once)
    bool private buyKeySet;

    event VaultSet(address indexed vault);
    event BuyKeySet(bytes32 indexed poolId);
    event CreatorClaimed(uint256 ethAmount);
    event BuybackExecuted(uint256 ethIn, uint256 arbtOut, uint256 burned, uint256 timestamp);
    event VictimCompensated(address indexed victim, uint256 amount);

    error Unauthorized();

    modifier onlyKeeper() {
        if (msg.sender != keeper && msg.sender != owner()) revert Unauthorized();
        _;
    }

    constructor(IPoolManager _manager, address _arbitToken, address _keeper, address _owner)
        Ownable(_owner)
    {
        require(
            address(_manager) != address(0) && _arbitToken != address(0)
                && _keeper != address(0) && _owner != address(0),
            "Zero address"
        );
        manager = _manager;
        arbitToken = _arbitToken;
        keeper = _keeper;
        lastBuybackTime = block.timestamp;
    }

    /// @notice Bind the vault (kernel's deterministic child — known only after
    /// the kernel deploys). Owner only, set once, post-launch.
    function setVault(address _vault) external onlyOwner {
        require(!vaultSet, "Vault already set");
        require(_vault != address(0), "Zero address");
        vault = ICreatorVault(_vault);
        vaultSet = true;
        emit VaultSet(_vault);
    }

    /// @notice Bind the buy pool once (must be an ARBT/ETH pool with depth).
    function setBuyKey(PoolKey calldata key) external onlyOwner {
        require(!buyKeySet, "Buy key already set");
        require(Currency.unwrap(key.currency1) == arbitToken, "Not ARBT pool");
        buyKey = key;
        buyKeySet = true;
        emit BuyKeySet(PoolId.unwrap(key.toId()));
    }

    /// @notice Claim creator fees, market-buy ARBT, burn 80%, reserve 20% for
    /// victims. Keeper-gated; minTokensOut from a fresh quote per call.
    function executeBuyback(uint256 minTokensOut) external onlyKeeper nonReentrant {
        require(vaultSet && buyKeySet, "Not wired");
        require(
            block.timestamp >= lastBuybackTime + BUYBACK_COOLDOWN, "Cooldown active"
        );

        // EFFECT first
        lastBuybackTime = block.timestamp;

        // INTERACTION: claim first (first run starts from zero balance),
        // then enforce the threshold on post-claim funds.
        uint256 claimed = vault.claimCreator();
        emit CreatorClaimed(claimed);

        // Split applies to the CLAIM (not the full balance): prior runs leave
        // retained reserves behind, and re-splitting them would overstate the
        // victim pool past actual holdings (review finding Sep 8). Invariant
        // victimPool ≤ balance holds inductively: buyIn spends only the
        // unreserved remainder.
        uint256 reserveAdd = (claimed * VICTIM_SHARE) / 100;
        victimPool += reserveAdd;
        uint256 bal = address(this).balance;
        require(bal >= MIN_BUYBACK_ETH, "Below threshold");
        uint256 buyIn = bal - victimPool;

        uint256 arbtOut = abi.decode(
            manager.unlock(abi.encodeCall(this._buy, (buyIn, minTokensOut))), (uint256)
        );
        IERC20(arbitToken).safeTransfer(address(0xdead), arbtOut);

        emit BuybackExecuted(buyIn, arbtOut, arbtOut, block.timestamp);
    }

    /// @notice Pay a victim from the ETH reserve. Owner only.
    function compensateVictim(address victim, uint256 amount) external onlyOwner nonReentrant {
        require(victim != address(0), "Zero address");
        require(amount <= victimPool, "Insufficient victim pool");
        require(amount <= address(this).balance, "Insufficient balance");

        // EFFECT first
        victimPool -= amount;

        // INTERACTION
        (bool ok,) = victim.call{value: amount}("");
        require(ok, "ETH transfer failed");

        emit VictimCompensated(victim, amount);
    }

    function _buy(uint256 amountIn, uint256 minOut) external returns (bytes memory) {
        if (msg.sender != address(this)) revert Unauthorized();
        BalanceDelta d = manager.swap(
            buyKey,
            SwapParams({
                zeroForOne: true, // ETH in → ARBT out
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        int128 d0 = d.amount0();
        if (d0 < 0) manager.settle{value: uint128(uint256(-int256(d0)))}();
        else revert Unauthorized();
        int128 out = d.amount1();
        if (out <= 0 || uint256(int256(out)) < minOut) revert Unauthorized();
        uint256 outAbs = uint256(int256(out));
        manager.take(buyKey.currency1, address(this), outAbs);
        return abi.encode(outAbs);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert Unauthorized();
        (bool ok, bytes memory ret) = address(this).call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    receive() external payable {}
}
