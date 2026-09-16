#!/usr/bin/env node
// check-operator-gas.js — pre-flight: does the operator wallet hold enough
// native balance (Arc gas is USDC-denominated) to pay for gatewayMint()?
//
// Mirrors the worker's key handling exactly (same OPERATOR_KEY_PATH default,
// same ethers Wallet derivation) so the address checked here is the address
// that will pay. Exit 0 = enough, exit 1 = top up, exit 2 = misconfigured.
//
//   OPERATOR_KEY_PATH   path to the operator private-key file
//                       (default: ~/.ecandle-secrets/operator.key)
//   ARC_RPC_URL         RPC endpoint (default: Arc Testnet)
//   MIN_OPERATOR_GAS    minimum acceptable balance, in whole USDC
//                       (default: 0.05 — ~14 mints at the observed 3500 µUSDC fee)

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ethers } from "ethers"

const {
  ARC_RPC_URL = "https://rpc.testnet.arc.network",
  OPERATOR_KEY_PATH = path.join(os.homedir(), ".ecandle-secrets", "operator.key"),
  MIN_OPERATOR_GAS = "0.05",
} = process.env

if (!fs.existsSync(OPERATOR_KEY_PATH)) {
  console.error(
    `operator key not found at ${OPERATOR_KEY_PATH}\n` +
      `Set OPERATOR_KEY_PATH, or generate one with scripts/gen-operator-wallet.js`,
  )
  process.exit(2)
}

const raw = fs.readFileSync(OPERATOR_KEY_PATH, "utf8").trim()
let wallet
try {
  wallet = new ethers.Wallet(raw)
} catch (e) {
  console.error(`operator key file is not a valid private key: ${e.message}`)
  process.exit(2)
}

const provider = new ethers.JsonRpcProvider(ARC_RPC_URL)
let balanceWei
try {
  balanceWei = await provider.getBalance(wallet.address)
} catch (e) {
  console.error(`RPC ${ARC_RPC_URL} unreachable: ${e.message}`)
  process.exit(2)
}

const balance = ethers.formatEther(balanceWei) // Arc native = USDC, 18 decimals at the EVM layer
const min = Number(MIN_OPERATOR_GAS)
console.log(`operator ${wallet.address}`)
console.log(`balance  ${balance} USDC (native, via ${ARC_RPC_URL})`)

if (Number(balance) < min) {
  console.error(`✗ below MIN_OPERATOR_GAS=${min} — top up from your own funding source`)
  process.exit(1)
}
console.log(`✓ above MIN_OPERATOR_GAS=${min}`)
