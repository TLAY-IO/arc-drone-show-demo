// POST /api/mint — queues a Path A (BurnIntent + gatewayMint) job to the
// burn-intent-worker by publishing to MQTT topic `ecandle/mint-queue`.
//
// Body shape (sent by demo page when user clicks "Mint to Arc"):
//   {
//     deviceId: "ecandle-demo",
//     depositor: "0x…",           // seller EOA (BurnIntent sourceDepositor)
//   }
//
// Note: there is intentionally NO `transferUuids` field, and there is NO
// `valueMicroUsdc` field. The worker maintains the canonical set of unminted
// Circle UUIDs per device by subscribing to `ecandle/+/circle_ack` directly,
// and computes the BurnIntent value from those UUIDs. This makes the chain
// of evidence on the demo page (each "minted · Arc" row links a real Circle
// UUID to a real Arc tx hash) machine-verifiable end-to-end, not "the browser
// said so".
//
// The worker (cloud/burn-intent-worker/index.js) listens on mint-queue,
// reads its server-side state for that device, constructs the EIP-712
// BurnIntent, gets it signed by the device, posts to Circle /v1/transfer,
// calls gatewayMint with the operator wallet, and then publishes mint_ack
// on ecandle/<deviceId>/mint_ack with the authoritative covered_uuids set.
// The SSE bridge picks that up and upgrades the corresponding settlement
// rows to Arcscan links.

import { NextRequest, NextResponse } from "next/server"
import mqtt from "mqtt"

const MQTT_BROKER = process.env.MQTT_BROKER ?? "mqtt://mosquitto:1883"
const MINT_QUEUE_TOPIC = "ecandle/mint-queue"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

async function publishOnce(payload: string): Promise<void> {
  // One-shot publish: connect, publish QoS 0, graceful drain, end.
  // The QoS-0 graceful end matters — a force-close after the publish
  // callback races the broker reading the TCP buffer. We use end(false) so
  // pending writes drain.
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(MQTT_BROKER, {
      clientId: `mint-trigger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      connectTimeout: 4000,
    })
    const gracefulEnd = () => {
      try { client.end(false) } catch { /* noop */ }
    }
    const timer = setTimeout(() => {
      try { client.end(true) } catch { /* noop */ }
      reject(new Error("mqtt_publish_timeout"))
    }, 5000)
    client.on("connect", () => {
      client.publish(MINT_QUEUE_TOPIC, payload, { qos: 0 }, (err) => {
        clearTimeout(timer)
        if (err) {
          gracefulEnd()
          reject(err)
          return
        }
        gracefulEnd()
        resolve()
      })
    })
    client.on("error", (err) => {
      clearTimeout(timer)
      gracefulEnd()
      reject(err)
    })
  })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { deviceId?: string; depositor?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }

  const { deviceId, depositor } = body
  if (!deviceId || !depositor) {
    return NextResponse.json(
      { error: "missing_required_fields", required: ["deviceId", "depositor"] },
      { status: 422 },
    )
  }

  const job = { deviceId, depositor, ts_ms: Date.now() }

  try {
    await publishOnce(JSON.stringify(job))
  } catch (e) {
    return NextResponse.json(
      { error: `mqtt_publish_failed: ${(e as Error).message}` },
      { status: 502 },
    )
  }

  console.log(`[mint] queued device=${deviceId} (worker uses server-side state for covered UUIDs)`)
  return NextResponse.json({ ok: true, queued: true })
}
