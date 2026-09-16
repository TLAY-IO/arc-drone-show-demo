// Generate a fresh secp256k1 wallet for the Path A operator (the EOA that
// signs gatewayMint() Arc transactions and pays gas). Writes the key to
// ~/.ecandle-secrets/operator.key with mode 0600 and prints the address so
// the user can ask HashAnchor (or anyone) to faucet Arc Testnet gas.
//
// Idempotent: refuses to overwrite an existing key file. If you really want
// to rotate, move/delete the old file by hand first.

import fs from "fs"
import os from "os"
import path from "path"
import { ethers } from "ethers"

const KEY_PATH = path.join(os.homedir(), ".ecandle-secrets", "operator.key")
const DIR_PATH = path.dirname(KEY_PATH)

function main() {
  if (!fs.existsSync(DIR_PATH)) {
    fs.mkdirSync(DIR_PATH, { mode: 0o700, recursive: true })
  }
  if (fs.existsSync(KEY_PATH)) {
    const wallet = new ethers.Wallet(fs.readFileSync(KEY_PATH, "utf8").trim())
    console.log(`Operator wallet already exists at ${KEY_PATH}`)
    console.log(`Address: ${wallet.address}`)
    console.log(`(refusing to overwrite; delete file manually if you really want to rotate)`)
    process.exit(0)
  }
  const wallet = ethers.Wallet.createRandom()
  fs.writeFileSync(KEY_PATH, wallet.privateKey, { mode: 0o600 })
  console.log(`Generated new operator wallet`)
  console.log(`  Address: ${wallet.address}`)
  console.log(`  Key file: ${KEY_PATH} (mode 0600)`)
  console.log(``)
  console.log(`Next steps:`)
  console.log(`  1. Hand this address to HashAnchor (or any faucet operator)`)
  console.log(`     and ask them to send Arc Testnet gas (a few ETH-equivalent`)
  console.log(`     is enough for many gatewayMint calls).`)
  console.log(`  2. cd .. && node index.js  to start the worker.`)
}

main()
