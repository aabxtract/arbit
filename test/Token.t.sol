// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ArbitToken} from "../src/ArbitToken.sol";

contract TokenTest is Test {
    function test_FixedSupplyToHolderNoMoreMint() public {
        address holder = makeAddr("holder");
        ArbitToken token = new ArbitToken(holder);

        assertEq(token.name(), "Arbit");
        assertEq(token.symbol(), "ARBT");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), token.MAX_SUPPLY());
        assertEq(token.balanceOf(holder), token.MAX_SUPPLY());

        vm.expectRevert("Zero address");
        new ArbitToken(address(0));
    }
}
