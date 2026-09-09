// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {TestERC20} from "v4-core/src/test/TestERC20.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ArbitDistributor} from "../src/ArbitDistributor.sol";

/// @notice Mock creator-fee vault: holds ETH, pays it all on claim.
contract MockVault {
    function claimCreator() external returns (uint256 amount) {
        amount = address(this).balance;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "pay failed");
    }

    receive() external payable {}
}

contract DistributorTest is Test {
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    IPoolManager manager;
    TestERC20 arbt;
    ArbitDistributor dist;
    MockVault vault;
    PoolKey key;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.deal(address(this), 100 ether);
        manager = new PoolManager(address(this));
        arbt = new TestERC20(1e30);
        dist = new ArbitDistributor(manager, address(arbt), address(this), address(this));
        vault = new MockVault();
        dist.setVault(address(vault));

        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(arbt)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(key, SQRT_PRICE_1_1);
        dist.setBuyKey(key);

        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        arbt.approve(address(lp), type(uint256).max);
        lp.modifyLiquidity{value: 12 ether}(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: 1e19, // ~10 ETH + ~1e19 ARBT at 1:1 full range
                salt: bytes32(0)
            }),
            ""
        );
    }

    function test_BuybackFlow() public {
        vm.deal(address(vault), 0.02 ether);
        vm.warp(block.timestamp + 1 hours + 1);

        uint256 deadBefore = arbt.balanceOf(address(0xdead));
        dist.executeBuyback(1);
        // 0.02 claimed → 80% buys (burned), 20% victim reserve
        assertEq(dist.victimPool(), 0.004 ether);
        assertGt(arbt.balanceOf(address(0xdead)) - deadBefore, 0);
    }

    function test_CooldownBlocks() public {
        vm.deal(address(vault), 0.02 ether);
        vm.warp(block.timestamp + 1 hours + 1);
        dist.executeBuyback(1);
        vm.expectRevert("Cooldown active");
        dist.executeBuyback(1);
    }

    function test_ThresholdBlocks() public {
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert("Below threshold");
        dist.executeBuyback(1);
    }

    function test_CompensateVictim() public {
        vm.deal(address(vault), 0.02 ether);
        vm.warp(block.timestamp + 1 hours + 1);
        dist.executeBuyback(1);

        address victim = makeAddr("victim");
        uint256 avail = dist.victimPool();
        assertGt(avail, 0);
        dist.compensateVictim(victim, avail);
        assertEq(victim.balance, avail);
        assertEq(dist.victimPool(), 0);

        vm.expectRevert("Insufficient victim pool");
        dist.compensateVictim(victim, 1);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        dist.compensateVictim(victim, 0);
    }

    function test_KeeperAndWiringAuth() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ArbitDistributor.Unauthorized.selector);
        dist.executeBuyback(1);

        vm.expectRevert("Vault already set");
        dist.setVault(address(1));

        vm.expectRevert("Buy key already set");
        dist.setBuyKey(key);

        PoolKey memory bad = PoolKey({
            currency0: Currency.wrap(address(arbt)),
            currency1: Currency.wrap(address(1)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        ArbitDistributor d2 =
            new ArbitDistributor(manager, address(arbt), address(this), address(this));
        vm.expectRevert("Not ARBT pool");
        d2.setBuyKey(bad);
    }

    receive() external payable {}
}
