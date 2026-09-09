// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @title ArbitToken
/// @notice Fixed-supply ARBT. No mint, tax, pause, blacklist, or upgrade
/// surface — the Programmable V4 admission hard-blocks those categories, and
/// the fee/buyback logic lives in ArbitHook, not the token.
/// @dev In the Programmable V4 launch graph this is the `componentKind:
/// "token"` target; constructor arg is the launch wallet (receives supply).
contract ArbitToken is ERC20 {
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18; // 1B ARBT

    constructor(address to) ERC20("Arbit", "ARBT") {
        require(to != address(0), "Zero address");
        _mint(to, MAX_SUPPLY);
    }
}
