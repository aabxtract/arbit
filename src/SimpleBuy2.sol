// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
contract SimpleBuy2 is IUnlockCallback {
    IPoolManager public immutable pm;
    constructor(IPoolManager _pm){ pm=_pm; }
    function buy(address token, address hook) external payable {
        PoolKey memory key=PoolKey({currency0:Currency.wrap(address(0)), currency1:Currency.wrap(token), fee:0, tickSpacing:60, hooks: IHooks(hook)});
        bytes memory data=abi.encode(key, msg.value, msg.sender);
        pm.unlock(data);
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory){
        require(msg.sender==address(pm), "pm");
        (PoolKey memory key, uint256 ethValue, address recipient)=abi.decode(data,(PoolKey,uint256,address));
        BalanceDelta delta = pm.swap(key, SwapParams({zeroForOne:true, amountSpecified: -int256(ethValue), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE+1}), "");
        uint256 tokensOut = uint256(int256(delta.amount1()));
        require(tokensOut>0, "no out");
        pm.sync(Currency.wrap(address(0)));
        // settle ETH
        pm.settle{value: ethValue}();
        // take ARBT
        pm.take(key.currency1, recipient, tokensOut);
        return "";
    }
}
