// burn-intent-worker — Path A: BurnIntent → Circle /v1/transfer → gatewayMint
//
// Source-of-truth: this worker is the canonical authority on "which Circle
// transfer UUIDs are still unminted for each seller". The browser does NOT
// get to decide what gets covered by a mint — it can only request "mint
// whatever the seller has accumulated". This closes the traceability gap
// where stale browser state could let synthetic UUIDs (e.g. `unk-<ts>`)
// claim to be covered by a real Arc tx.
//
// Flow (Q3 = B aggregate-on-click + Traceability hardening):
//   1. Worker subscribes to `ecandle/+/circle_ack` and to every Circle UUID
//      with `success: true` ADDs it to a per-device unminted Map (uuid→µ), plus
//      adds the slice's signed value to unmintedValueMicro.
//   2. /api/mint endpoint receives {deviceId, depositor} from the demo page.
//      No `transferUuids` from browser — body.transferUuids is IGNORED if
//      present.
//   3. Worker reads its own server-side state for that device:
//      covered_uuids = FIFO subset with sum ≤ MINT_MAX_VALUE_MICRO;
//      value = MAX(subsetSum, FLOOR). Excess UUIDs stay for the next click.
//   4. Build EIP-712 BurnIntent (GatewayWallet domain), publish digest to
//      `ecandle/<deviceId>/cmd/sign_burn_intent`, await sig, verify ecrecover.
//   5. POST signed payload to Circle `/v1/transfer`, get attestation + sig.
//   6. operator wallet calls `GatewayMinter.gatewayMint(attestation, sig)` on
//      Arc Testnet — real on-chain tx hash.
//   7. Publish `ecandle/<deviceId>/mint_ack` with real covered_uuids + tx hash.
//   8. CLEAR only the covered UUIDs and reduce unmintedValueMicro for that
//      device. Subsequent settles re-populate for the next mint cycle.
//
// Operator key is at `~/.ecandle-secrets/operator.key` (mode 0600, gitignored,
// outside any repo workdir so it can never be staged by accident).

import fs from "fs"
import os from "os"
import path from "path"
import mqtt from "mqtt"
import { ethers } from "ethers"
import {
  buildArcSelfMint,
  digestOf,
  verifySignature,
  toTransferPayload,
  ARC,
} from "./burn-intent.js"
import { acquire as acquireSingleInstance } from "./single-instance-guard.js"

// Refuse to start if another burn-intent-worker is already running.
// (`pkill -f` does not reliably catch nohup-detached node processes, so a
// lock file is used instead of a process scan.)
acquireSingleInstance("burn-intent-worker")

const {
  MQTT_BROKER = "mqtt://localhost:1883",
  CIRCLE_TRANSFER_URL = "https://gateway-api-testnet.circle.com/v1/transfer",
  ARC_RPC_URL = "https://rpc.testnet.arc.network",
  OPERATOR_KEY_PATH = path.join(os.homedir(), ".ecandle-secrets", "operator.key"),
  // Circle batched x402 maxFee floor has drifted twice in May-June 2026
  // (4d→7d validity, 1000→3500 µUSDC fee). 5000 µUSDC clears the current
  // floor with headroom; bumped here so future Circle increases don't
  // silently start rejecting our /v1/transfer.
  BURN_INTENT_MAX_FEE_MICRO = "5000",
  // value < maxFee → net mint = 0. Floor every mint at 10000 µUSDC
  // ($0.01) so a single click always materializes a non-trivial credit
  // even if only one slice has accumulated.
  MIN_MINT_VALUE_MICRO = "10000",
  // 10s timeout + 3 retries mirrors May 28 worker. ESP32 takes ~150 ms to
  // sign but MQTT reconnect after the seller publishes status can spike
  // the wall-clock.
  // OPTIONAL per-mint hard cap in µUSDC. Empty = unlimited (default). When
  // set, one click covers a FIFO subset of unminted UUIDs whose values sum
  // to ≤ this cap; the rest stays unminted for the next click. Guardrail
  // for operators who want bounded per-click mints.
  MINT_MAX_VALUE_MICRO = "",
  SIGN_TIMEOUT_MS = "10000",
  SIGN_RETRIES = "3",
} = process.env

const MINT_CAP_MICRO = MINT_MAX_VALUE_MICRO ? BigInt(MINT_MAX_VALUE_MICRO) : null
if (MINT_CAP_MICRO !== null && MINT_CAP_MICRO < BigInt(MIN_MINT_VALUE_MICRO)) {
  throw new Error(
    `MINT_MAX_VALUE_MICRO (${MINT_CAP_MICRO}) < MIN_MINT_VALUE_MICRO ` +
      `(${MIN_MINT_VALUE_MICRO}) — cap below floor makes every mint impossible`,
  )
}

const MINT_QUEUE_TOPIC = "ecandle/mint-queue"
const SIG_REPLY_FILTER = "ecandle/+/burn_intent_sig"
const CIRCLE_ACK_FILTER = "ecandle/+/circle_ack"
const SIGN_CMD_TOPIC = (deviceId) => `ecandle/${deviceId}/cmd/sign_burn_intent`
const MINT_ACK_TOPIC = (deviceId) => `ecandle/${deviceId}/mint_ack`

const GATEWAY_MINTER_ABI = [
  "function gatewayMint(bytes attestation, bytes signature) external",
]

const GATEWAY_WALLET_ABI = [
  // selector 0x3ccb64ae — returns the µUSDC available for BurnIntent burn
  "function availableBalance(address token, address depositor) view returns (uint256)",
]

// Read seller's on-chain Gateway availableBalance (µUSDC). ADVISORY ONLY —
// this view lags Circle-side credit during active settlement, so it is
// logged for context but never used to refuse a mint (see the comment at
// the call site). Circle's /v1/transfer is the authoritative balance check.
async function readSellerAvailable(provider, sellerEOA) {
  const gw = new ethers.Contract(ARC.walletContract, GATEWAY_WALLET_ABI, provider)
  const usdc = ARC.usdc
  return await gw.availableBalance(usdc, sellerEOA)
}

// ── Per-device unminted-credit state (traceability source-of-truth) ──────
//
// Map<deviceId, { unminted: Map<uuid, valueMicro> (arrival order), unmintedValueMicro: bigint }>
//
// Populated by circle_ack subscription. Drained by mint completion. NEVER
// influenced by anything the browser sends — the browser can ask for a
// mint, but the worker decides what's in it.
const deviceState = new Map()

function getDeviceState(deviceId) {
  let state = deviceState.get(deviceId)
  if (!state) {
    state = { unminted: new Map(), unmintedValueMicro: 0n }
    deviceState.set(deviceId, state)
  }
  return state
}

function handleCircleAck(deviceId, parsed) {
  const results = parsed?.results
  if (!Array.isArray(results)) return
  const state = getDeviceState(deviceId)
  let added = 0
  for (const r of results) {
    if (!r?.success || !r?.transaction) continue
    if (state.unminted.has(r.transaction)) continue
    const v = BigInt(String(r.value ?? "0"))
    state.unminted.set(r.transaction, v)
    state.unmintedValueMicro += v
    added += 1
  }
  if (added > 0) {
    console.log(
      `[worker] circle_ack device=${deviceId} added ${added} settle(s), ` +
        `unminted now: ${state.unminted.size} UUID(s), ` +
        `${state.unmintedValueMicro} µUSDC accumulated`,
    )
  }
}

// ── Operator wallet (gas-only; never holds nominal USDC) ─────────────────
function loadOperatorWallet(provider) {
  if (!fs.existsSync(OPERATOR_KEY_PATH)) {
    throw new Error(
      `operator key not found at ${OPERATOR_KEY_PATH}. ` +
        `Generate one with scripts/gen-operator-wallet.js and ask HashAnchor to faucet gas.`,
    )
  }
  const raw = fs.readFileSync(OPERATOR_KEY_PATH, "utf8").trim()
  const wallet = new ethers.Wallet(raw, provider)
  return wallet
}

// ── MQTT request/reply machinery for sign_burn_intent ────────────────────
const pendingSignRequests = new Map() // request_id → {resolve, reject, timer}

function newRequestId() {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

async function requestDeviceSignature(client, deviceId, digestHex) {
  const timeoutMs = parseInt(SIGN_TIMEOUT_MS)
  const maxRetries = parseInt(SIGN_RETRIES)
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const requestId = newRequestId()
    const payload = JSON.stringify({ request_id: requestId, digest: digestHex })
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingSignRequests.delete(requestId)
        resolve(null) // timeout — will retry
      }, timeoutMs)
      pendingSignRequests.set(requestId, {
        resolve: (msg) => {
          clearTimeout(timer)
          pendingSignRequests.delete(requestId)
          resolve(msg)
        },
        reject: (err) => {
          clearTimeout(timer)
          pendingSignRequests.delete(requestId)
          reject(err)
        },
      })
      client.publish(SIGN_CMD_TOPIC(deviceId), payload, { qos: 0 }, (err) => {
        if (err) {
          pendingSignRequests.delete(requestId)
          clearTimeout(timer)
          reject(err)
        }
      })
    })
    if (reply) return reply
    console.warn(`[worker] sign attempt ${attempt + 1}/${maxRetries + 1} timed out`)
  }
  throw new Error("device did not return signature within retry budget")
}

// ── Circle /v1/transfer ──────────────────────────────────────────────────
async function postCircleTransfer(intent, signature) {
  const body = JSON.stringify(toTransferPayload(intent, signature))
  const res = await fetch(CIRCLE_TRANSFER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Circle response not JSON (HTTP ${res.status}): ${text.slice(0, 300)}`)
  }
  if (!res.ok) {
    throw new Error(`Circle HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`)
  }
  return data
}

// ── gatewayMint() on Arc Testnet ─────────────────────────────────────────
async function submitGatewayMint(wallet, attestation, opSignature) {
  const minter = new ethers.Contract(
    ARC.minterContract,
    GATEWAY_MINTER_ABI,
    wallet,
  )
  const tx = await minter.gatewayMint(attestation, opSignature)
  console.log(`[worker] gatewayMint sent tx=${tx.hash}`)
  const rec = await tx.wait()
  return {
    txHash: tx.hash,
    blockNumber: rec ? Number(rec.blockNumber) : null,
  }
}

// ── Serialize mint jobs (one in-flight at a time) ────────────────────────
//
// Concurrent processJob() calls would race on the operator wallet's nonce
// → second tx gets REPLACEMENT_UNDERPRICED. Worse, both Circle attestations
// debit seller credit but only one mint hits Arc → stuck credit.
//
// Catch credit to ecandle-firmware 2026-06-15 08:43 — concurrent fire
// observed (two cmd/sign_burn_intent in the same second, two attestations,
// one successful Arc tx, one REPLACEMENT_UNDERPRICED).
let mintInFlight = false

// ── Main job processor (uses server-side state for traceability) ─────────
async function processJob(client, wallet, job) {
  if (mintInFlight) {
    console.warn(
      `[worker] mint already in flight, dropping concurrent job for device=${job.deviceId} ` +
        `(serialization gate)`,
    )
    return
  }
  mintInFlight = true
  try {
    return await processJobUnsafe(client, wallet, job)
  } finally {
    mintInFlight = false
  }
}

async function processJobUnsafe(client, wallet, job) {
  const { deviceId, depositor } = job
  if (!deviceId || !depositor) {
    console.error(`[worker] mint job missing deviceId or depositor: ${JSON.stringify(job)}`)
    return
  }

  // Snapshot server-side state at job start — this is the authoritative
  // set of UUIDs we are minting. We do NOT use anything the browser sent.
  // If the browser also sent transferUuids (legacy), they are advisory at
  // best and ignored here.
  const state = getDeviceState(deviceId)
  const totalUuids = state.unminted.size
  const totalValueMicro = state.unmintedValueMicro

  console.log(
    `[worker] mint job: device=${deviceId} depositor=${depositor} ` +
      `server-side state has ${totalUuids} unminted UUID(s), ` +
      `accumulated ${totalValueMicro} µUSDC`,
  )

  if (totalUuids === 0 && totalValueMicro === 0n) {
    console.warn(`[worker] device=${deviceId} has no unminted credit — refusing to mint`)
    return
  }

  // FIFO subset selection under the per-mint cap: cover whole UUIDs only,
  // never mint value that exceeds the sum of the covered set (that would
  // orphan credit from the per-UUID ledger). Excess UUIDs stay unminted
  // for the next click.
  const snapshotUuids = []
  let snapshotValueMicro = 0n
  for (const [uuid, v] of state.unminted) {
    if (MINT_CAP_MICRO !== null && snapshotValueMicro + v > MINT_CAP_MICRO) break
    snapshotUuids.push(uuid)
    snapshotValueMicro += v
  }
  if (snapshotUuids.length === 0) {
    console.error(
      `[worker] MINT_MAX_VALUE_MICRO=${MINT_CAP_MICRO}µ cannot cover even the first ` +
        `unminted settle row — raise the cap`,
    )
    return
  }

  // Full UUID dump for HashAnchor + ecandle step-3 machine verification
  // (covered_uuids == real Circle .transaction UUID set).
  console.log(`[worker] covered UUIDs (${snapshotUuids.length}):`)
  for (const u of snapshotUuids) console.log(`  - ${u}`)

  // ADVISORY balance read — deliberately NOT a gate. The on-chain
  // `GatewayWallet.availableBalance()` view lags Circle-side credit during
  // active settlement ("Circle reconciles batches off the on-chain slot
  // lazily" — observed 14,162µ on-chain vs 251,388µ Circle-side on
  // 2026-06-23). A hard gate on this number false-refuses mints exactly
  // when settles are flowing, i.e. mid-demo. Circle's `/v1/transfer` is the
  // authoritative check and fails safe BEFORE any gas is spent, so we log
  // the comparison and let Circle decide.
  const provider = wallet.provider
  const maxFee = BigInt(BURN_INTENT_MAX_FEE_MICRO)
  const floor = BigInt(MIN_MINT_VALUE_MICRO)
  const effectiveValue = snapshotValueMicro < floor ? floor : snapshotValueMicro

  try {
    const avail = await readSellerAvailable(provider, depositor)
    console.log(
      `[worker] device=${deviceId} seller on-chain avail=${avail}µUSDC ` +
        `(maxFee=${maxFee}, floor=${floor}, gross accumulated=${snapshotValueMicro}) ` +
        `→ mint value=${effectiveValue}µUSDC`,
    )
    if (effectiveValue + maxFee > avail) {
      console.warn(
        `[worker] on-chain availableBalance reads below the requested mint ` +
          `(${avail}µ < ${effectiveValue}µ + maxFee ${maxFee}µ), but this view lags ` +
          `Circle-side credit during active settlement — proceeding and letting ` +
          `Circle decide. If Circle also refuses, wait 10-30s for reconcile and retry.`,
      )
    }
  } catch (e) {
    console.warn(`[worker] advisory availableBalance read failed (continuing): ${e.message}`)
  }

  const intent = buildArcSelfMint({
    depositor,
    valueMicroUsdc: effectiveValue,
    maxFee: BigInt(BURN_INTENT_MAX_FEE_MICRO),
  })
  const digest = digestOf(intent)
  console.log(`[worker] burn intent digest=${digest} value=${effectiveValue}µUSDC`)

  const reply = await requestDeviceSignature(client, deviceId, digest)
  if (!reply.ok || !reply.signature || !reply.signer_address) {
    throw new Error(`device declined to sign: ${JSON.stringify(reply)}`)
  }
  const signature = reply.signature
  console.log(`[worker] device signed: ${signature.slice(0, 14)}… signer=${reply.signer_address}`)

  if (!verifySignature(intent, signature, depositor)) {
    throw new Error(
      `signature ecrecover does not match depositor ${depositor}` +
        ` (got signer_address ${reply.signer_address})`,
    )
  }

  const circleResp = await postCircleTransfer(intent, signature)
  // FULL Circle response logging — the response may contain fee fields that
  // we need for Path A fee measurement (per HashAnchor 2026-06-15 finding:
  // on-chain avail-delta is confounded by batch reconcile + parallel settles,
  // so Circle's `/v1/transfer` response is the only clean fee source).
  console.log(
    `[worker] Circle response: ${JSON.stringify(circleResp).slice(0, 2000)}`,
  )
  const first = Array.isArray(circleResp) ? circleResp[0] : circleResp
  const attestation = first?.attestation
  const operatorSig = first?.signature
  if (!attestation || !operatorSig) {
    throw new Error(
      `Circle did not return attestation/signature: ${JSON.stringify(circleResp).slice(0, 300)}`,
    )
  }
  console.log(`[worker] Circle attestation received`)
  if (first?.fee !== undefined) {
    console.log(`[worker] Circle reported fee=${first.fee} µUSDC (confound-free)`)
  }

  const mintResult = await submitGatewayMint(wallet, attestation, operatorSig)
  console.log(
    `[worker] gatewayMint confirmed: tx=${mintResult.txHash}` +
      ` block=${mintResult.blockNumber}`,
  )

  // Atomic state mutation: any UUID not selected (over-cap remainder, or
  // landed between snapshot and now) stays in the map for the next mint.
  // We only clear the UUIDs we actually included.
  for (const uuid of snapshotUuids) state.unminted.delete(uuid)
  state.unmintedValueMicro -= snapshotValueMicro
  if (state.unmintedValueMicro < 0n) state.unmintedValueMicro = 0n  // belt-and-suspenders

  const ackTopic = MINT_ACK_TOPIC(deviceId)
  const ackPayload = JSON.stringify({
    tx_hash: mintResult.txHash,
    block_number: mintResult.blockNumber,
    covered_uuids: snapshotUuids,   // authoritative — real Circle UUIDs only
    value_micro: effectiveValue.toString(),
    accumulated_micro: snapshotValueMicro.toString(),
    remaining_uuids: state.unminted.size,
    remaining_micro: state.unmintedValueMicro.toString(),
    depositor,
    ts_ms: Date.now(),
  })
  client.publish(ackTopic, ackPayload, { qos: 0 }, (err) => {
    if (err) console.error(`[worker] mint_ack publish error: ${err.message}`)
    else console.log(
      `[worker] mint_ack published → ${ackTopic} ` +
        `(${snapshotUuids.length} real Circle UUIDs covered)`,
    )
  })
}

// ── Entry ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[worker] connecting to MQTT ${MQTT_BROKER}`)
  console.log(`[worker] Circle endpoint: ${CIRCLE_TRANSFER_URL}`)
  console.log(`[worker] Arc RPC: ${ARC_RPC_URL}`)
  console.log(`[worker] operator key path: ${OPERATOR_KEY_PATH}`)

  const provider = new ethers.JsonRpcProvider(ARC_RPC_URL)
  const wallet = loadOperatorWallet(provider)
  console.log(`[worker] operator EOA: ${wallet.address}`)

  const client = mqtt.connect(MQTT_BROKER, {
    clientId: `burn-intent-worker-${process.pid}`,
    reconnectPeriod: 5000,
  })

  client.on("connect", () => {
    console.log(`[worker] connected to ${MQTT_BROKER}`)
    client.subscribe(
      [MINT_QUEUE_TOPIC, SIG_REPLY_FILTER, CIRCLE_ACK_FILTER],
      (err) => {
        if (err) console.error(`[worker] subscribe error: ${err.message}`)
        else
          console.log(
            `[worker] subscribed: ${MINT_QUEUE_TOPIC}, ${SIG_REPLY_FILTER}, ${CIRCLE_ACK_FILTER}`,
          )
      },
    )
  })

  client.on("message", (topic, payload) => {
    // Signature reply path
    if (topic.endsWith("/burn_intent_sig")) {
      let parsed
      try { parsed = JSON.parse(payload.toString()) } catch { return }
      const pending = pendingSignRequests.get(parsed.request_id)
      if (pending) pending.resolve(parsed)
      return
    }

    // Circle ack path — populates the server-side unminted map
    if (topic.endsWith("/circle_ack")) {
      const m = /^ecandle\/([^/]+)\/circle_ack$/.exec(topic)
      const deviceId = m ? m[1] : null
      if (!deviceId) return
      let parsed
      try { parsed = JSON.parse(payload.toString()) } catch { return }
      handleCircleAck(deviceId, parsed)
      return
    }

    // Mint queue path
    if (topic === MINT_QUEUE_TOPIC) {
      let job
      try { job = JSON.parse(payload.toString()) } catch (e) {
        console.error(`[worker] invalid mint job JSON: ${e.message}`)
        return
      }
      processJob(client, wallet, job).catch((err) => {
        console.error(`[worker] processJob failed: ${err.message}`)
      })
    }
  })

  client.on("error", (e) => console.error(`[worker] mqtt error: ${e.message}`))
  client.on("close", () => console.warn(`[worker] mqtt closed, reconnecting`))

  const shutdown = () => {
    console.log(`[worker] shutting down`)
    client.end(false, () => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  console.error(`[worker] fatal: ${err.message}`)
  process.exit(1)
})
