// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// @title MintableToken
// @dev Mock mintable token for testing and testnets
contract MintableToken is ERC20 {
    uint8 private _decimals;

    mapping(address => bool) blacklisted;

    error BlackListed();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }

    // @dev mint tokens to an account
    // @param account the account to mint to
    // @param amount the amount of tokens to mint
    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    // @dev burn tokens from an account
    // @param account the account to burn tokens for
    // @param amount the amount of tokens to burn
    function burn(address account, uint256 amount) external {
        _burn(account, amount);
    }

    function transfer(address to, uint256 amount) public virtual override returns (bool) {
        if (blacklisted[to] || blacklisted[msg.sender]) revert BlackListed();
        return super.transfer(to, amount);
    }

    function blacklist(address account) external {
        blacklisted[account] = true;
    }
}
