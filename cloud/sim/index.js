// sim — a device simulator for running the cloud side with NO hardware.
//
// It publishes, on MQTT, the same event shapes a real eCandle seller emits
// while a drone buyer is charging from it, so the broker → SSE bridge
// (/api/stream) → /demo?live=1 pipeline runs end to end without flashing a
// single board:
//
//   ecandle/<id>/status      { power: { ac_output } }                 ~3 s
//   ecandle/<id>/nanopay     session_notify / stream_start / slice_req /
//                            slice_paid / stream_stop                 5 s slices
//   ecandle/<id>/circle_ack  one ack per 6-slice batch
//
// WHAT IS REAL AND WHAT IS NOT
//
//   Real:      the broker, the SSE bridge, its rolling cache, the page.
//   Simulated: everything upstream of the broker. There is no BLE link, no
//              EIP-3009 signature, no HashAnchor call, no Circle Gateway
//              credit move and no Arc transaction. Nothing here touches a
//              chain or spends funds, on testnet or anywhere else.
//
// The circle_ack `transaction` ids this publishes are prefixed "sim-" for
// exactly that reason: on a real stack that field is a Circle transfer UUID,
// and a simulated row must never be mistakable for one. For the same reason
// this simulator never publishes on ecandle/<id>/settle — that is the topic
// the settle-worker forwards to HashAnchor, and unsigned proofs have no
// business going there.
//
// Run it through docker-compose.sim.yml (see cloud/sim/README.md); that stack
// has its own private broker and does not start the settle or mint workers.

import mqtt from "mqtt"
import { randomUUID } from "node:crypto"

const {
  MQTT_BROKER = "mqtt://localhost:1883",
  SIM_DEVICE_ID = "ecandle-sim",
} = process.env

// These mirror constants the page and the SSE bridge hardcode. They are not
// knobs: change them here alone and the page's energy/price maths disagrees
// with what the simulator bills.
const SLICE_SEC = 5
const RATE_USDC_PER_KWH = 10.0
const BATCH_SIZE = 6 // the seller batches up to 6 proofs per settle envelope

// One simulated charge, in slices. Shaped like a CC-CV charge so the page
// shows a plateau, a taper and an idle gap; the numbers are illustrative,
// not a model of any particular battery.
const CC_SLICES = 12 // ~120 W plateau
const CV_SLICES = 6 //  taper 120 W → ~40 W
const IDLE_SEC = 25 //  gap before the next session
const PEAK_W = 120
const STANDBY_W = 4 //  dock standby draw reported between sessions

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = (span) => (Math.random() - 0.5) * span

function slicePowerW(i) {
  if (i < CC_SLICES) return Math.round(PEAK_W + jitter(12))
  const t = (i - CC_SLICES + 1) / CV_SLICES
  return Math.max(36, Math.round(PEAK_W - t * 80 + jitter(6)))
}

// µUSDC for one slice at avgW: Wh × ($/kWh ÷ 1000) × 1e6.
function sliceAmountMicro(avgW) {
  const wh = (avgW * SLICE_SEC) / 3600
  return Math.round((wh / 1000) * RATE_USDC_PER_KWH * 1_000_000)
}

const client = mqtt.connect(MQTT_BROKER, {
  clientId: `arc-demo-sim-${process.pid}`,
  reconnectPeriod: 3000,
})

const topic = (kind) => `ecandle/${SIM_DEVICE_ID}/${kind}`
const publish = (kind, obj) => client.publish(topic(kind), JSON.stringify(obj), { qos: 0 })
const nanopay = (obj) => publish("nanopay", obj)

// The status ticker runs independently of sessions, like the real device.
let currentPowerW = STANDBY_W
setInterval(() => {
  if (client.connected) publish("status", { power: { ac_output: currentPowerW } })
}, 3000)

function flushBatch(sid, batchIdx, batch) {
  if (batch.length === 0) return
  publish("circle_ack", {
    sid,
    batch_idx: batchIdx,
    network: "simulated",
    ts_ms: Date.now(),
    simulated: true,
    results: batch.map((p) => ({
      slice_id: p.sliceId,
      value: String(p.amountMicro),
      success: true,
      transaction: `sim-${randomUUID()}`,
      errorReason: null,
      network: "simulated",
    })),
  })
  console.log(`[sim] sid=${sid} batch=${batchIdx}: acked ${batch.length} simulated slices`)
}

async function runSession(sid) {
  console.log(`[sim] sid=${sid} session start`)
  nanopay({ ev: "session_notify", cmd: 1, sid })
  nanopay({ ev: "stream_start", sid })

  let batch = []
  let batchIdx = 0
  const total = CC_SLICES + CV_SLICES
  for (let i = 0; i < total; i++) {
    const sliceId = i + 1
    const avgW = slicePowerW(i)
    const amountMicro = sliceAmountMicro(avgW)
    currentPowerW = avgW

    // Seller asks for the slice; the buyer's signed proof comes back a
    // moment later. On hardware that gap is one BLE round trip.
    nanopay({ ev: "slice_req", sid, slice_id: sliceId, avg_w: avgW, amount_micro: amountMicro })
    await sleep(400)
    nanopay({ ev: "slice_paid", sid, slice_id: sliceId, amount_micro: amountMicro })

    batch.push({ sliceId, amountMicro })
    if (batch.length === BATCH_SIZE) {
      // A real ack arrives after the HashAnchor → Circle round trip.
      await sleep(1200)
      flushBatch(sid, batchIdx++, batch)
      batch = []
      await sleep(SLICE_SEC * 1000 - 1600)
    } else {
      await sleep(SLICE_SEC * 1000 - 400)
    }
  }
  flushBatch(sid, batchIdx, batch)

  currentPowerW = STANDBY_W
  nanopay({ ev: "stream_stop", sid })
  nanopay({ ev: "session_notify", cmd: 2, sid })
  console.log(`[sim] sid=${sid} session end, idle ${IDLE_SEC}s`)
}

let running = false
client.on("connect", async () => {
  console.log(`[sim] connected to ${MQTT_BROKER} as device "${SIM_DEVICE_ID}"`)
  console.log("[sim] publishing SIMULATED events — no chain, no funds, no real settlement")
  if (running) return // reconnect: the loop below is still alive
  running = true
  // Session ids on hardware are epoch-derived; start from a small number so a
  // simulated sid is recognisable in logs.
  for (let sid = 1; ; sid++) {
    await runSession(sid)
    await sleep(IDLE_SEC * 1000)
  }
})
client.on("error", (err) => console.error("[sim] mqtt error:", err.message))
client.on("close", () => console.warn("[sim] mqtt closed, will reconnect"))

const shutdown = () => client.end(false, () => process.exit(0))
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
