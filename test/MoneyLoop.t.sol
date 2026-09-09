// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TestERC20} from "v4-core/src/test/TestERC20.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {ArbitRegistry} from "../src/ArbitRegistry.sol";
import {ArbitFeeModule} from "../src/ArbitFeeModule.sol";
import {ArbitDistributor} from "../src/ArbitDistributor.sol";
import {RobinhoodNativeFeeHookV1} from "./vendor/robinhood-fee-v1/RobinhoodNativeFeeHookV1.sol";
import {ForkHelper} from "./Kernel.t.sol";

/// @notice End-to-end money loop on a mainnet fork: swaps through the exact
/// kernel accrue creator fees → distributor claims → market-buys ARBT → burns
/// 80%, reserves 20% for victims.
/// Run: RUN_FORK_TESTS=1 forge test --match-contract MoneyLoopTest -vvv
contract MoneyLoopTest is Test {
    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    function test_MoneyLoop() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true, "set RUN_FORK_TESTS=1 to run network fork tests");
            return;
        }
        vm.createSelectFork(
            vm.envOr("ROBINHOOD_MAINNET_RPC", string("https://rpc.mainnet.chain.robinhood.com"))
        );
        vm.deal(address(this), 300 ether);

        TestERC20 token = new TestERC20(1e30);
        ArbitRegistry registry = new ArbitRegistry(address(token), address(0), address(this));
        ArbitFeeModule module = new ArbitFeeModule(address(registry), address(0xbeef));
        ArbitDistributor dist =
            new ArbitDistributor(MANAGER, address(token), address(this), address(this));

        RobinhoodNativeFeeHookV1.PoolConfig memory cfg = RobinhoodNativeFeeHookV1.PoolConfig({
            token: address(token),
            lpFee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            initialSqrtPriceX96: SQRT_PRICE_1_1,
            initializer: address(this),
            creatorFeeRecipient: address(dist),
            creatorBuyFeeBps: 100,
            creatorSellFeeBps: 100,
            module: address(module),
            maxModuleLpFeePips: 10000
        });
        (address hookAddress, bytes32 salt) = HookMiner.find(
            address(this),
            uint160(
                Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                    | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            ),
            type(RobinhoodNativeFeeHookV1).creationCode,
            abi.encode(address(MANAGER), cfg)
        );
        RobinhoodNativeFeeHookV1 kernel =
            new RobinhoodNativeFeeHookV1{salt: salt}(MANAGER, cfg);
        require(address(kernel) == hookAddress, "kernel address mismatch");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(kernel))
        });
        MANAGER.initialize(key, SQRT_PRICE_1_1);

        ForkHelper router = new ForkHelper(MANAGER);
        token.approve(address(router), type(uint256).max);
        token.transfer(address(router), 60 ether);
        router.addLiquidity{value: 55 ether}(
            key, TickMath.minUsableTick(60), TickMath.maxUsableTick(60), 5e19
        );

        // Wire distributor (post-kernel-deploy, like mainnet)
        dist.setVault(address(kernel.feeVault()));
        dist.setBuyKey(key);

        // Three buys accrue ~1% creator fees each → ~0.015 ETH claimable
        address trader = makeAddr("loop-trader");
        for (uint256 i; i < 3; i++) {
            router.swapExactIn{value: 0.5 ether}(key, 0.5 ether, abi.encode(trader));
        }

        vm.warp(block.timestamp + 1 hours + 1);
        uint256 deadBefore = token.balanceOf(address(0xdead));
        dist.executeBuyback(1);

        assertGt(token.balanceOf(address(0xdead)) - deadBefore, 0, "nothing burned");
        assertGt(dist.victimPool(), 0, "no victim reserve");

        // Victim payout works from the reserve
        address victim = makeAddr("loop-victim");
        uint256 avail = dist.victimPool();
        dist.compensateVictim(victim, avail);
        assertEq(victim.balance, avail);
    }
}
