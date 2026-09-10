// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
contract SimpleBuy is IUnlockCallback {
    IPoolManager public immutable pm;
    constructor(IPoolManager _pm){ pm=_pm; }
    function buy(address token, address hook, uint256 ethValue) external payable {
        require(msg.value==ethValue, "val");
        PoolKey memory key=PoolKey({currency0:Currency.wrap(address(0)), currency1:Currency.wrap(token), fee:0, tickSpacing:60, hooks: IHooks(hook)});
        bytes memory data=abi.encode(key, ethValue, msg.sender);
        pm.unlock(data);
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory){
        require(msg.sender==address(pm), "pm");
        (PoolKey memory key, uint256 ethValue, address recipient)=abi.decode(data,(PoolKey,uint256,address));
        // swap ETH -> ARBT, exact input  ethValue
        pm.swap(key, SwapParams({zeroForOne:true, amountSpecified: -int256(ethValue), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE+1}), "");
        // take ARBT to recipient
        // after swap, pm will have ARBT delta, we take it
        // need to handle delta? swap already does take via unlock?
        // Actually pm.swap will handle settlement via unlock, we need to settle ETH and take ARBT
        // The swap's delta will be settled in this callback via pm.sync/settle/take
        // For ETH input, we already sent ETH via msg.value to pm via unlock? Let's sync
        pm.sync(Currency.wrap(address(0)));
        // settle ETH
        // value already in pm? Need to send ETH to pm
        // Since we are in unlock, we can settle by sending ETH
        // pm.settle will handle
        return "";
    }
}
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
