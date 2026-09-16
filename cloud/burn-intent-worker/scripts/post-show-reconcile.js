#!/usr/bin/env node
// post-show-reconcile.js — after the demo: verify that every CONFIRMED mint
// covered a unique set of Circle UUIDs and that no UUID appears in two
// minted batches (double-mint would double-count the same settled credit).
//
// Works from the worker's own log, which prints for every mint job:
//     [worker] covered UUIDs (N):
//       - <uuid>
//       ...
//     [worker] gatewayMint confirmed: tx=0x… block=…
// A job without a following "confirmed" line (crashed / rejected mint) is
// reported but NOT treated as minted — server-side UUID state clears only
// on confirmed tx, so those UUIDs legitimately reappear in a later batch.
//
// Usage: node scripts/post-show-reconcile.js [logfile]
//        (default: /tmp/burn-intent-worker.log)
// Exit 0 = clean, 1 = overlap found, 2 = log unreadable/unparseable.

import fs from "node:fs"

const logPath = process.argv[2] || "/tmp/burn-intent-worker.log"
if (!fs.existsSync(logPath)) {
  console.error(`log file not found: ${logPath}\nUsage: node scripts/post-show-reconcile.js [logfile]`)
  process.exit(2)
}

const lines = fs.readFileSync(logPath, "utf8").split("\n")

const mints = []       // { uuids: string[], tx: string|null }
let pending = null     // UUID list collected, waiting for confirmed/next job

for (const line of lines) {
  if (/\[worker\] covered UUIDs \(\d+\):/.test(line)) {
    if (pending) mints.push(pending) // previous job never confirmed
    pending = { uuids: [], tx: null }
    continue
  }
  const uuid = line.match(/^\s+-\s+([0-9a-f-]{36})\s*$/i)
  if (uuid && pending) {
    pending.uuids.push(uuid[1].toLowerCase())
    continue
  }
  const confirmed = line.match(/\[worker\] gatewayMint confirmed: tx=(0x[0-9a-fA-F]+)/)
  if (confirmed && pending) {
    pending.tx = confirmed[1]
    mints.push(pending)
    pending = null
  }
}
if (pending) mints.push(pending)

const confirmedMints = mints.filter(m => m.tx)
const unconfirmed = mints.filter(m => !m.tx)

if (mints.length === 0) {
  console.error(`no mint jobs found in ${logPath} — wrong file, or log rotated?`)
  process.exit(2)
}

console.log(`${logPath}: ${confirmedMints.length} confirmed mint(s), ${unconfirmed.length} unconfirmed job(s)`)

const seen = new Map() // uuid → first tx
let overlaps = 0
for (const m of confirmedMints) {
  for (const u of m.uuids) {
    const first = seen.get(u)
    if (first) {
      overlaps++
      console.error(`✗ UUID ${u} covered by BOTH ${first} and ${m.tx}`)
    } else {
      seen.set(u, m.tx)
    }
  }
}

for (const m of confirmedMints) {
  console.log(`  ${m.tx}  ${m.uuids.length} UUID(s)`)
}
if (unconfirmed.length) {
  console.log(`  (${unconfirmed.length} job(s) logged UUIDs but never confirmed — expected to re-mint later, not an error)`)
}

if (overlaps) {
  console.error(`✗ ${overlaps} overlapping UUID(s) across confirmed mints`)
  process.exit(1)
}
console.log(`✓ all ${seen.size} covered UUID(s) unique across confirmed mints`)
