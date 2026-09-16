// SSE bridge: subscribes to MQTT and forwards events to browsers.
//
// Topic schema (see cloud/mosquitto/mosquitto.conf):
//   ecandle/<MAC>/nanopay     - slice_req, slice_paid, session_notify
//   ecandle/<MAC>/settle      - settle envelopes (verbatim drone proofs, pre-Circle)
//   ecandle/<MAC>/circle_ack  - per-proof Circle UUIDs (post-Circle, populated by settle-worker)
//   ecandle/<MAC>/mint_ack    - per-batch Arc on-chain mint tx hashes (Path A, populated by burn-intent-worker)
//   ecandle/<MAC>/status      - telemetry
//
// Pattern: globalThis-persisted MQTT client + rolling cache + per-connection
// snapshot on connect. Multiple browser tabs all see the same demo state.
//
// Settlement records represent off-chain Circle Gateway credit moves with
// authoritative Circle UUIDs. They are populated from circle_ack, NOT from
// the raw settle envelope (the envelope is pre-Circle; UUIDs come back after
// HashAnchor forwards). When a Path A mint lands, the corresponding settlement
// rows are upgraded with an Arc on-chain tx hash via mint_ack.

import mqtt, { type MqttClient } from "mqtt"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const SLICE_SEC = 5
const RATE_USDC_PER_KWH = 10.0  // $10/kWh = $0.01/Wh "premium nano-charge"
const CACHE_CAP_SLICES = 200
const CACHE_CAP_SETTLES = 100
const POWER_BY_KEY_CAP = 512

type Subscriber = (event: string, data: string) => void

interface SliceRecord {
  id: string
  idx: number
  sid: number
  tsMs: number
  powerW: number
  amountMicroUsdc: number
}

interface SettleRecord {
  // Stable id for React keys + UI dedup
  id: string
  // Circle Gateway off-chain credit-move identifier (UUID, e.g. "ed797e31-3728-…")
  transferUuid: string
  // Short display form for the table row
  shortHash: string
  // Total micro-USDC moved in this settle event
  amountMicroUsdc: number
  tsMs: number
  // Backlink to the originating proof
  sid: number
  sliceId: number | null
  // Path A: set when the off-chain credit corresponding to this settle has
  // been minted on-chain. Until then this row is honest off-chain credit only.
  onChainTxHash: string | null
  mintBlockNumber: number | null
}

interface Cache {
  slicePowerByKey: Map<string, number>
  sliceRecords: SliceRecord[]
  settlements: SettleRecord[]
  cumulative: { energyKWh: number; paidUSDC: number; sliceCount: number }
  demoStartTsMs: number
  globalSliceIdx: number
  globalSettleIdx: number
}

interface DemoGlobal {
  _demoSubs?: Set<Subscriber>
  _demoMqtt?: MqttClient
  _demoMqttUp?: boolean
  _demoCache?: Cache
}
const G = globalThis as unknown as DemoGlobal

G._demoSubs ??= new Set()
G._demoCache ??= {
  slicePowerByKey: new Map(),
  sliceRecords: [],
  settlements: [],
  cumulative: { energyKWh: 0, paidUSDC: 0, sliceCount: 0 },
  demoStartTsMs: 0,
  globalSliceIdx: 0,
  globalSettleIdx: 0,
}
const subs = G._demoSubs
const cache = G._demoCache

function log(msg: string) {
  try { process.stderr.write(`[stream] ${msg}\n`) } catch { /* noop */ }
}

function handleNanopay(parsed: Record<string, unknown>) {
  const ev = parsed.ev
  if (ev === "slice_req") {
    const sid = Number(parsed.sid ?? 0)
    const sliceId = Number(parsed.slice_id ?? 0)
    const avgW = Number(parsed.avg_w ?? 0)
    if (sid > 0 && sliceId > 0) {
      cache.slicePowerByKey.set(`${sid}:${sliceId}`, avgW)
      if (cache.slicePowerByKey.size > POWER_BY_KEY_CAP) {
        const firstKey = cache.slicePowerByKey.keys().next().value
        if (firstKey !== undefined) cache.slicePowerByKey.delete(firstKey)
      }
    }
  } else if (ev === "slice_paid") {
    const sid = Number(parsed.sid ?? 0)
    const sliceId = Number(parsed.slice_id ?? 0)
    const amountMicro = Number(parsed.amount_micro ?? 0)
    const powerW = cache.slicePowerByKey.get(`${sid}:${sliceId}`) ?? 0
    const wh = (powerW * SLICE_SEC) / 3600

    cache.cumulative.energyKWh += wh / 1000
    cache.cumulative.paidUSDC += amountMicro / 1_000_000
    cache.cumulative.sliceCount += 1
    cache.globalSliceIdx += 1
    if (cache.demoStartTsMs === 0) cache.demoStartTsMs = Date.now()

    cache.sliceRecords.unshift({
      id: `live-${sid}-${sliceId}-${Date.now()}`,
      idx: cache.globalSliceIdx,
      sid,
      tsMs: Date.now(),
      powerW,
      amountMicroUsdc: amountMicro,
    })
    if (cache.sliceRecords.length > CACHE_CAP_SLICES) cache.sliceRecords.length = CACHE_CAP_SLICES
  }
}

function shortenUuid(uuid: string): string {
  // ed797e31-3728-40c2-a176-1641a3c234ce → ed797e31…234ce
  if (uuid.length < 14) return uuid
  return uuid.slice(0, 8) + "…" + uuid.slice(-5)
}

function handleCircleAck(parsed: Record<string, unknown>) {
  // settle-worker publishes one circle_ack per batch, with per-proof results.
  // Each successful result is its own SettleRecord — we render one row per
  // slice/proof, not one row per batch. The Circle UUID is the authoritative
  // identifier; the batch index is metadata.
  const sid = Number(parsed.sid ?? 0)
  const batchIdx = Number(parsed.batch_idx ?? 0)
  const tsMs = Number(parsed.ts_ms ?? Date.now())
  const results = parsed.results
  if (!Array.isArray(results)) return

  for (const r of results as Array<{
    slice_id?: number
    value?: string | number
    success?: boolean
    transaction?: string | null
    errorReason?: string | null
  }>) {
    if (!r.success || !r.transaction) continue
    const sliceId = typeof r.slice_id === "number" ? r.slice_id : null
    const valueMicro = Number(r.value ?? 0)
    cache.globalSettleIdx += 1
    cache.settlements.unshift({
      id: r.transaction,
      transferUuid: r.transaction,
      shortHash: shortenUuid(r.transaction),
      amountMicroUsdc: valueMicro,
      tsMs,
      sid,
      sliceId,
      onChainTxHash: null,
      mintBlockNumber: null,
    })
  }
  if (cache.settlements.length > CACHE_CAP_SETTLES) cache.settlements.length = CACHE_CAP_SETTLES
}

function handleMintAck(parsed: Record<string, unknown>) {
  // burn-intent-worker publishes one mint_ack per gatewayMint Arc tx. Each
  // tx covers one or more previously-settled rows (Q3 aggregate-on-click).
  // We backfill onChainTxHash on every settlement whose transferUuid is in
  // the ack's covered list, OR — for batched mint where the worker tells us
  // a sid range — we backfill any settlement in that sid range that does
  // not yet have an on-chain hash.
  const txHash = typeof parsed.tx_hash === "string" ? parsed.tx_hash : null
  const blockNumber = typeof parsed.block_number === "number" ? parsed.block_number : null
  if (!txHash) return

  const coveredUuids = new Set(
    Array.isArray(parsed.covered_uuids) ? (parsed.covered_uuids as string[]) : [],
  )

  for (const s of cache.settlements) {
    if (s.onChainTxHash) continue
    if (coveredUuids.size > 0 && !coveredUuids.has(s.transferUuid)) continue
    s.onChainTxHash = txHash
    s.mintBlockNumber = blockNumber
  }
}

function initMqtt() {
  if (G._demoMqtt) return
  const broker = process.env.MQTT_BROKER ?? "mqtt://mosquitto:1883"
  log(`init MQTT → ${broker}`)
  const client = mqtt.connect(broker, {
    clientId: `arc-demo-web-sse-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    reconnectPeriod: 5000,
  })
  client.on("connect", () => {
    G._demoMqttUp = true
    log("MQTT connected, subscribing")
    client.subscribe("ecandle/+/nanopay")
    client.subscribe("ecandle/+/circle_ack")
    client.subscribe("ecandle/+/mint_ack")
    client.subscribe("ecandle/+/status")
  })
  client.on("close", () => { G._demoMqttUp = false })
  client.on("error", (e) => log(`MQTT err: ${e.message}`))
  client.on("message", (topic, msg) => {
    const m = /^ecandle\/([^/]+)\/(nanopay|circle_ack|mint_ack|status)$/.exec(topic)
    if (!m) return
    const [, deviceId, kind] = m
    let parsed: unknown
    try { parsed = JSON.parse(msg.toString()) } catch { return }

    let payload: string
    let sseEvent: string
    if (kind === "nanopay") {
      handleNanopay(parsed as Record<string, unknown>)
      payload = JSON.stringify({ deviceId, ...(parsed as object) })
      sseEvent = "nanopay"
    } else if (kind === "circle_ack") {
      handleCircleAck(parsed as Record<string, unknown>)
      payload = JSON.stringify({ deviceId, ...(parsed as object) })
      sseEvent = "circle_ack"
    } else if (kind === "mint_ack") {
      handleMintAck(parsed as Record<string, unknown>)
      payload = JSON.stringify({ deviceId, ...(parsed as object) })
      sseEvent = "mint_ack"
    } else {
      const t = parsed as { power?: { ac_output?: number } }
      const acOutput = typeof t.power?.ac_output === "number" ? t.power.ac_output : 0
      payload = JSON.stringify({ deviceId, ev: "status", ac_output: acOutput })
      sseEvent = "status"
    }

    for (const sub of subs) {
      try { sub(sseEvent, payload) } catch { /* noop */ }
    }
  })
  G._demoMqtt = client
}

initMqtt()

function snapshot() {
  return {
    sliceRecords: cache.sliceRecords,
    settlements: cache.settlements,
    cumulative: cache.cumulative,
    demoStartTsMs: cache.demoStartTsMs,
    rateUsdcPerKwh: RATE_USDC_PER_KWH,
    sliceSec: SLICE_SEC,
  }
}

export function GET(req: Request): Response {
  initMqtt()
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()
      const send = (event: string, data: string) => {
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`)) }
        catch { /* stream closed */ }
      }

      const ping = setInterval(() => {
        try { controller.enqueue(enc.encode(": ping\n\n")) } catch { /* noop */ }
      }, 25_000)

      send("hello", JSON.stringify({ ts: Date.now(), mqttUp: G._demoMqttUp === true }))
      send("snapshot", JSON.stringify(snapshot()))

      const sub: Subscriber = (event, data) => send(event, data)
      subs.add(sub)

      req.signal.addEventListener("abort", () => {
        clearInterval(ping)
        subs.delete(sub)
        try { controller.close() } catch { /* noop */ }
      })
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
