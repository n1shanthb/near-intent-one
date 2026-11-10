#!/usr/bin/env node
/** Fund portfolio A from software funder using ethers (reliable EIP-155). */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEPOLIA = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const USDC = "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2";
const A = "0x30af279bedef3bb82c7f47bb9f6a514f6264e752";
const funder = JSON.parse(
  readFileSync(join(ROOT, ".gate-i-data/sepolia-funder.json"), "utf8")
);

const provider = new ethers.JsonRpcProvider(SEPOLIA, 11155111);
const wallet = new ethers.Wallet(funder.privateKey, provider);
const usdc = new ethers.Contract(
  USDC,
  [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
    "function faucet()",
  ],
  wallet
);

async function bal(addr) {
  const [ethWei, usdcBal] = await Promise.all([
    provider.getBalance(addr),
    usdc.balanceOf(addr),
  ]);
  return { ethWei: ethWei.toString(), usdc: usdcBal.toString() };
}

const before = { funder: await bal(wallet.address), a: await bal(A) };
console.log("before", before);
console.log("wallet", wallet.address);

if (BigInt(before.funder.usdc) === 0n) {
  const tx = await usdc.faucet({ gasLimit: 300000n });
  const rec = await tx.wait();
  console.log("faucet", rec.hash, rec.status);
}

// Send ETH to A
const ethTx = await wallet.sendTransaction({
  to: A,
  value: ethers.parseEther("0.015"),
  gasLimit: 21000n,
});
const ethRec = await ethTx.wait();
console.log("eth_to_a", ethRec.hash, ethRec.status);

const mid = await bal(wallet.address);
const usdcBal = BigInt(mid.usdc);
const sendUsdc = usdcBal > 1_000_000n ? usdcBal - 100_000n : usdcBal;
let usdcTxHash = null;
let usdcStatus = null;
if (sendUsdc > 0n) {
  const tx = await usdc.transfer(A, sendUsdc, { gasLimit: 100000n });
  const rec = await tx.wait();
  usdcTxHash = rec.hash;
  usdcStatus = rec.status;
  console.log("usdc_to_a", rec.hash, rec.status, sendUsdc.toString());
}

const after = { funder: await bal(wallet.address), a: await bal(A) };
const out = {
  before,
  eth_to_a: { tx: ethRec.hash, status: ethRec.status },
  usdc_to_a: { tx: usdcTxHash, status: usdcStatus, amount: sendUsdc.toString() },
  after,
  funding_tx_user:
    "0x172375a91a49a9632657b1d097b7ad8a7a20f21670f4b53c90aabe44721682bb",
};
writeFileSync(
  join(ROOT, "evidence/live/gate-i-fund-transfer.json"),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
if (ethRec.status !== 1 || (usdcTxHash && usdcStatus !== 1)) process.exit(1);
if (BigInt(after.a.usdc) === 0n || BigInt(after.a.ethWei) === 0n) process.exit(1);
