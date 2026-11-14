
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract MockUSDC {
  string public name = "MockUSDC";
  string public symbol = "mUSDC";
  uint8 public decimals = 6;
  uint256 public totalSupply;
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  event Transfer(address indexed from, address indexed to, uint256 value);
  event Approval(address indexed owner, address indexed spender, uint256 value);
  constructor() {
    uint256 a = 1_000_000_000_000; // 1e12 * 1e0 raw (1e6 units * 1e6)
    totalSupply = a;
    balanceOf[msg.sender] = a;
    emit Transfer(address(0), msg.sender, a);
  }
  function transfer(address to, uint256 v) external returns (bool) {
    require(balanceOf[msg.sender] >= v, "bal");
    balanceOf[msg.sender] -= v;
    balanceOf[to] += v;
    emit Transfer(msg.sender, to, v);
    return true;
  }
  function approve(address s, uint256 v) external returns (bool) {
    allowance[msg.sender][s] = v;
    emit Approval(msg.sender, s, v);
    return true;
  }
}
