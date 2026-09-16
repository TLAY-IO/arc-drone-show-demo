#!/usr/bin/env node
// gateway-deposit.js — fund a buyer wallet's Circle Gateway deposit so it
// can pay for energy. Two on-chain txs: USDC.approve(gateway, amount) then
// GatewayWallet.deposit / depositFor. Both selectors verified against the
// deployed GatewayWallet implementation (EIP-1967 proxy) on Arc Testnet.
//
// Usage:
//   FUNDER_PRIV_KEY=0x… node scripts/gateway-deposit.js <amount-usdc> [recipient]
//
//   <amount-usdc>  e.g. 0.5 — USDC to deposit (6 decimals)
//   [recipient]    optional EOA to credit (depositFor). Omit to credit the
//                  funder itself (deposit). Use this to fund the buyer
//                  board's on-chip wallet without exporting its key.
//
// Env: FUNDER_PRIV_KEY (required — a wallet holding USDC + gas on the
// target chain), plus the ARC_* chain profile (see ../.env.example;
// defaults are Arc Testnet). Exit 0 = deposited, 1 = failed, 2 = misuse.

import { ethers } from "ethers"
import { ARC } from "../burn-intent.js"

const amountArg = process.argv[2]
const recipient = process.argv[3]

if (!process.env.FUNDER_PRIV_KEY) {
  console.error("FUNDER_PRIV_KEY not set — export a funded wallet's private key first")
  process.exit(2)
}
if (!amountArg || isNaN(Number(amountArg)) || Number(amountArg) <= 0) {
  console.error("Usage: FUNDER_PRIV_KEY=0x… node scripts/gateway-deposit.js <amount-usdc> [recipient]")
  process.exit(2)
}
const amountMicro = BigInt(Math.round(Number(amountArg) * 1_000_000))

let to = null
if (recipient) {
  try { to = ethers.getAddress(recipient) } catch {
    console.error(`recipient is not a valid address: ${recipient}`)
    process.exit(2)
  }
}

const provider = new ethers.JsonRpcProvider(process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network")
const wallet = new ethers.Wallet(process.env.FUNDER_PRIV_KEY, provider)

const usdc = new ethers.Contract(ARC.usdc, [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
], wallet)
const gateway = new ethers.Contract(ARC.walletContract, [
  "function deposit(address token, uint256 amount)",
  "function depositFor(address token, address recipient, uint256 amount)",
  "function availableBalance(address token, address depositor) view returns (uint256)",
], wallet)

const beneficiary = to ?? wallet.address
console.log(`funder      ${wallet.address}`)
console.log(`beneficiary ${beneficiary}${to ? " (depositFor)" : " (self deposit)"}`)
console.log(`amount      ${amountMicro} µUSDC on chainId ${ARC.chainId}`)

try {
  const bal = await usdc.balanceOf(wallet.address)
  if (bal < amountMicro) {
    console.error(`✗ funder USDC balance ${bal}µ < ${amountMicro}µ`)
    process.exit(1)
  }

  const approveTx = await usdc.approve(ARC.walletContract, amountMicro)
  console.log(`approve  tx=${approveTx.hash}`)
  await approveTx.wait()

  const depositTx = to
    ? await gateway.depositFor(ARC.usdc, to, amountMicro)
    : await gateway.deposit(ARC.usdc, amountMicro)
  console.log(`deposit  tx=${depositTx.hash}`)
  await depositTx.wait()

  const avail = await gateway.availableBalance(ARC.usdc, beneficiary)
  console.log(`✓ deposited — on-chain availableBalance(${beneficiary}) = ${avail} µUSDC`)
  console.log(`  (Circle-side availability can lag a deposit briefly; the`)
  console.log(`   settlement path checks Circle's ledger, not this view)`)
} catch (e) {
  console.error(`✗ ${e.shortMessage || e.message}`)
  process.exit(1)
}
