// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "./vendor/lib/openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "./vendor/lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "./vendor/lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @title ArbitBadge
/// @notice Achievement passes mirroring registry reputation: Bronze for
/// registering, Silver for mid rep, Gold for 800+. Holding ANY badge halves
/// swap fees in ArbitHook (one balanceOf check). Transferable, no royalties.
/// @dev Minter is the hook, set once by the owner post-launch (badges need no
/// in-launch wiring — claims are pull-based, user pays gas).
contract ArbitBadge is ERC721, Ownable, ReentrancyGuard {
    enum Tier {
        Bronze,
        Silver,
        Gold
    }

    address public minter;
    bool private minterSet;
    uint256 public nextTokenId = 1;

    mapping(address => mapping(Tier => bool)) public claimed;
    mapping(uint256 => Tier) public tierOf;

    event BadgeMinted(address indexed to, uint256 indexed tokenId, Tier tier);
    event MinterSet(address indexed minter);

    constructor(address _owner) ERC721("Arbit Badge", "ARBB") Ownable(_owner) {}

    function setMinter(address _minter) external onlyOwner {
        require(!minterSet, "Minter already set");
        require(_minter != address(0), "Zero address");
        minter = _minter;
        minterSet = true;
        emit MinterSet(_minter);
    }

    /// @notice Mints one badge of `tier` to `to`. One per tier per address.
    /// EFFECT (claimed flag) goes before the INTERACTION (_safeMint calls the
    /// recipient hook on contracts — reentrancy-safe by ordering).
    function mint(address to, Tier tier) external nonReentrant {
        require(msg.sender == minter, "Only minter");
        require(!claimed[to][tier], "Already claimed");
        claimed[to][tier] = true;

        uint256 tokenId = nextTokenId++;
        tierOf[tokenId] = tier;
        _safeMint(to, tokenId);
        emit BadgeMinted(to, tokenId, tier);
    }
}
