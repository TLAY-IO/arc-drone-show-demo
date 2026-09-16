#!/usr/bin/env node
//
// EIP-712 Gateway domain probe.
//
// The single most common reason for failed nanopayment settlements is
// signing against the wrong EIP-712 domain. The intuition is "I'm
// authorizing a USDC transfer, so I should sign with the USDC token's
// domain." That is WRONG for Circle's batched x402 settle path. The
// correct domain is the Circle Gateway's, not the USDC token's.
//
// This probe queries both on-chain and prints them side by side, so
// you can hard-code the correct values in your boat_buyer_config_t.
//
// Usage:
//   node scripts/eip712-domain-probe.js [arc-testnet]
//
// Reference: https://github.com/TLAY-IO/boat-mer/blob/main/docs/eip712-domain-trap.md

import { ethers } from "ethers"

const ARC_TESTNET = {
  rpc: "https://rpc.testnet.arc.network",
  chainId: 5042002,
  usdc: "0x3600000000000000000000000000000000000000",
  gateway: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
}

const NETWORKS = {
  "arc-testnet": ARC_TESTNET,
}

const network = process.argv[2] ?? "arc-testnet"
const cfg = NETWORKS[network]
if (!cfg) {
  console.error(`unknown network: ${network}`)
  console.error(`available: ${Object.keys(NETWORKS).join(", ")}`)
  process.exit(1)
}

const provider = new ethers.JsonRpcProvider(cfg.rpc)

const eip712NameAbi = ["function name() view returns (string)"]
const eip712VersionAbi = ["function version() view returns (string)"]
const eip712DomainAbi = [
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]

async function probe(label, address) {
  const usdc = new ethers.Contract(address, [...eip712NameAbi, ...eip712VersionAbi, ...eip712DomainAbi], provider)
  let name, version, separator
  try { name = await usdc.name() } catch { name = "<unsupported>" }
  try { version = await usdc.version() } catch { version = "<unsupported>" }
  try { separator = await usdc.DOMAIN_SEPARATOR() } catch { separator = "<unsupported>" }
  console.log(`\n  ${label}`)
  console.log(`    address:          ${address}`)
  console.log(`    name():           ${JSON.stringify(name)}`)
  console.log(`    version():        ${JSON.stringify(version)}`)
  console.log(`    DOMAIN_SEPARATOR: ${separator}`)
}

console.log(`EIP-712 domain probe — network: ${network}, chainId: ${cfg.chainId}`)
await probe("USDC token (do NOT use this domain for batched x402 settle):", cfg.usdc)
await probe("Circle Gateway (USE THIS domain for batched x402 settle):", cfg.gateway)

console.log("\nCorrect EIP-712 domain for boat_buyer_config_t:")
console.log(`    eip712_domain_name      = "GatewayWalletBatched"`)
console.log(`    eip712_domain_version   = "1"`)
console.log(`    eip712_verifying_contract = "${cfg.gateway}"`)
console.log(`    eip712_chain_id         = ${cfg.chainId}`)
console.log()
console.log("The Gateway's `name()` / `version()` reads above are the source of truth.")
console.log("If they differ from these constants on a future Gateway upgrade, update")
console.log("your config to match — your signatures will otherwise ecrecover to the")
console.log("wrong address and the settle will fail with `invalid_signature`.")
