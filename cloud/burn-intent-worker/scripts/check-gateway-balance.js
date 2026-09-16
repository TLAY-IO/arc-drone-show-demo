#!/usr/bin/env node
// check-gateway-balance.js — pre-flight: does the seller have enough Circle
// Gateway credit for the first "Mint to Arc" click to succeed?
//
// Reads the on-chain GatewayWallet.availableBalance the worker logs as an
// ADVISORY (the worker no longer hard-gates on it — Circle's /v1/transfer
// is the authoritative check). Caveat: the on-chain view lags Circle-side
// credit DURING active settlement (observed 14,162µ on-chain vs 251,388µ
// Circle-side, 2026-06-23); at rest the two converge (observed exact match,
// 2026-09-01). Run this pre-flight while slices are NOT flowing and it is a
// reliable lower bound. Exit 0 = mintable now, exit 1 = on-chain view says
// not yet (if slices were just settling, Circle-side credit may already
// suffice — wait 10-30s and re-run), exit 2 = misconfigured.
//
//   SELLER_EOA                 seller/eCandle wallet (required)
//   ARC_RPC_URL                RPC endpoint (default: Arc Testnet)
//   MIN_MINT_VALUE_MICRO       mint floor, µUSDC (default 10000 — keep in sync with the worker)
//   BURN_INTENT_MAX_FEE_MICRO  maxFee cap, µUSDC (default 5000 — keep in sync with the worker)

import { ethers } from "ethers"
import { ARC } from "../burn-intent.js"

const {
  SELLER_EOA,
  ARC_RPC_URL = "https://rpc.testnet.arc.network",
  MIN_MINT_VALUE_MICRO = "10000",
  BURN_INTENT_MAX_FEE_MICRO = "5000",
} = process.env

if (!SELLER_EOA) {
  console.error("SELLER_EOA not set — export the seller/eCandle wallet address first")
  process.exit(2)
}
let seller
try {
  seller = ethers.getAddress(SELLER_EOA)
} catch {
  console.error(`SELLER_EOA is not a valid address: ${SELLER_EOA}`)
  process.exit(2)
}

const gw = new ethers.Contract(
  ARC.walletContract,
  ["function availableBalance(address token, address depositor) view returns (uint256)"],
  new ethers.JsonRpcProvider(ARC_RPC_URL),
)

let avail
try {
  avail = await gw.availableBalance(ARC.usdc, seller)
} catch (e) {
  console.error(`availableBalance() call failed via ${ARC_RPC_URL}: ${e.message}`)
  process.exit(2)
}

const floor = BigInt(MIN_MINT_VALUE_MICRO)
const maxFee = BigInt(BURN_INTENT_MAX_FEE_MICRO)
const needed = floor + maxFee

console.log(`seller    ${seller}`)
console.log(`available ${avail} µUSDC (GatewayWallet ${ARC.walletContract}, chainId ${ARC.chainId})`)
console.log(`needed    ${needed} µUSDC (floor ${floor} + maxFee ${maxFee})`)

if (avail >= needed) {
  console.log(`✓ first mint can succeed`)
} else {
  console.error(
    `✗ on-chain view short by ${needed - avail} µUSDC — wait for more slices to settle, or deposit into the seller's Gateway balance` +
      ` (if settles are actively flowing, Circle-side credit may already suffice; re-run in 30s)`,
  )
  process.exit(1)
}
