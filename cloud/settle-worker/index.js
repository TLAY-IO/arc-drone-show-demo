// settle-worker — MQTT → batch → HashAnchor forwarder
//
// Subscribes to ecandle/+/settle on the demo MQTT broker. Each message is a
// pre-batched envelope from the eCandle (which already groups up to 6 proofs
// per batch — see boat-mer protocols/seller). We forward to HashAnchor, then
// publish the per-proof Circle ACKs (real UUIDs, not synthetic hashes) back
// to MQTT so the demo page can attribute each off-chain credit move to its
// authoritative identifier.
//
// For developer learning, this file is intentionally small. The interesting
// logic — batching, EIP-712 Gateway domain, low-s normalization, validity
// windows — all live in boat-mer (device side) and HashAnchor (server side).
// This worker is a transparent relay PLUS a Circle-ACK republisher.

import mqtt from "mqtt"
import { HashAnchor } from "@tlay/hashanchor-client"
import { acquire as acquireSingleInstance } from "./single-instance-guard.js"

// Refuse to start if another settle-worker is already running. Strays
// forwarding the same MQTT batches cause Circle to see N duplicate
// submissions → 1 success + N-1 nonce_already_used per slice. Discovered
// 2026-06-15 morning when 5 settle-workers were alive simultaneously.
// (`pkill -f` does not reliably catch nohup-detached node processes, so a
// lock file is used instead of a process scan.)
acquireSingleInstance("settle-worker")

const {
  MQTT_BROKER = "mqtt://localhost:1883",
  HASHANCHOR_API_KEY,
  HASHANCHOR_SETTLE_URL = "https://hashanchor.xid.network",
} = process.env

// /v1/x402/settle is a PUBLIC route — no API key required for the demo path.
// HASHANCHOR_API_KEY is only needed if you also use HashAnchor's /v1/hashes
// anchoring (unused by default in this demo).
const ha = new HashAnchor({
  apiKey: HASHANCHOR_API_KEY,    // optional
  baseUrl: HASHANCHOR_SETTLE_URL,
})

const client = mqtt.connect(MQTT_BROKER, {
  clientId: `arc-demo-settle-worker-${process.pid}`,
  reconnectPeriod: 5000,
})

client.on("connect", () => {
  console.log(`[settle-worker] connected to ${MQTT_BROKER}`)
  client.subscribe("ecandle/+/settle", (err) => {
    if (err) console.error("[settle-worker] subscribe error:", err.message)
    else console.log("[settle-worker] subscribed ecandle/+/settle")
  })
})

client.on("message", async (topic, payload) => {
  // Extract device id from topic: ecandle/<id>/settle
  const m = /^ecandle\/([^/]+)\/settle$/.exec(topic)
  const deviceId = m ? m[1] : "unknown"

  let envelope
  try {
    envelope = JSON.parse(payload.toString())
  } catch (err) {
    console.error(`[settle-worker] invalid JSON on ${topic}:`, err.message)
    return
  }

  // Envelope shape published by the seller (apps/ecandle):
  //   { sid, batch_idx, network: "eip155:5042002",
  //     proofs: [<verbatim drone 0xEE04 JSON>, ...] }
  if (!Array.isArray(envelope.proofs) || envelope.proofs.length === 0) {
    console.warn(`[settle-worker] empty proofs on ${topic}, skipping`)
    return
  }

  const sid = envelope.sid
  const batchIdx = envelope.batch_idx
  const network = envelope.network ?? "eip155:5042002"

  console.log(
    `[settle-worker] forwarding sid=${sid} batch=${batchIdx} network=${network} (${envelope.proofs.length} proofs)`,
  )

  try {
    const results = await ha.settle({ sid, batchIdx, network, proofs: envelope.proofs })
    // results is SettleResult[], one per proof, in the same order.
    // HTTP 402 (insufficient_balance / nonce_already_used / etc) come back
    // as { success: false, errorReason: "..." } rather than throwing.
    const ok = results.filter((r) => r.success).length
    const failed = results.length - ok
    console.log(
      `[settle-worker] settled sid=${sid} batch=${batchIdx}: ${ok}/${results.length} ok` +
        (failed > 0 ? `, ${failed} failed (see SettleResult.errorReason)` : ""),
    )
    for (const r of results) {
      if (!r.success) {
        console.warn(
          `[settle-worker]   fail sid=${sid} batch=${batchIdx}: ${r.errorReason ?? "(no reason)"}`,
        )
      }
    }

    // Republish per-proof Circle ACKs so the demo page (SSE bridge) can attribute
    // each off-chain credit move to its real Circle transfer UUID. Per-proof
    // shape mirrors SettleResult plus the slice_id from the original proof so
    // the page can identify which signed slice each ack corresponds to.
    //
    // Topic: ecandle/<deviceId>/circle_ack
    // Payload: { sid, batch_idx, network, ts_ms, results: [{ slice_id, value,
    //   success, transaction, errorReason, payer, network }, ...] }
    //
    // Important: the `transaction` field here is a Circle internal UUID
    // (e.g. "ed797e31-3728-…"), NOT an Arc on-chain tx hash. It identifies
    // an off-chain credit move in Circle's batched x402 ledger. The demo
    // page uses it as authoritative evidence the settle happened; it does
    // NOT link it to Arcscan. Real Arc tx hashes come from Path A (BurnIntent
    // + gatewayMint), published separately on ecandle/<deviceId>/mint_ack.
    const ackPayload = {
      sid,
      batch_idx: batchIdx,
      network,
      ts_ms: Date.now(),
      results: results.map((r, i) => ({
        slice_id: envelope.proofs[i]?.slice_id,
        value: envelope.proofs[i]?.value,
        success: r.success,
        transaction: r.transaction ?? null,
        errorReason: r.errorReason ?? null,
        payer: r.payer ?? envelope.proofs[i]?.payer,
        network: r.network ?? network,
      })),
    }
    const ackTopic = `ecandle/${deviceId}/circle_ack`
    client.publish(ackTopic, JSON.stringify(ackPayload), { qos: 0 }, (pubErr) => {
      if (pubErr) console.error(`[settle-worker] circle_ack publish error: ${pubErr.message}`)
    })
  } catch (err) {
    // Transport-level failure (network, malformed envelope, etc).
    // Business-level errors come back inside SettleResult.errorReason instead.
    console.error(
      `[settle-worker] settle transport error sid=${sid} batch=${batchIdx}:`,
      err.message,
    )
  }
})

client.on("error", (err) => console.error("[settle-worker] mqtt error:", err.message))
client.on("close", () => console.warn("[settle-worker] mqtt closed, will reconnect"))

const shutdown = () => {
  console.log("[settle-worker] shutting down")
  client.end(false, () => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
