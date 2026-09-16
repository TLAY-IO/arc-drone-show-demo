"use client"

/**
 * /demo — Arc Drone Show headline visualization
 *
 * Single-screen layout (no scroll). Centerpiece is the bidirectional payment
 * flow: USDC drone→eCandle on the top arc (via Arc hub), kWh
 * eCandle→drone on the bottom arc. Drop real photos into
 * /public/drone-demo/drone.png + ecandle.png — the inline SVG fallbacks
 * below render until the files exist.
 *
 * Two modes:
 *   no query param → simulation cycles (mock data, useful when devices are off)
 *   ?live=1        → real broker traffic via /api/stream (the verified path)
 *
 * Ported from the internal production visualization (1074 lines)
 * for the OSS arc-drone-show-demo repo on 2026-06-14.
 */

import { useEffect, useRef, useState } from "react"
import { QRCodeCanvas } from "qrcode.react"

const SLICE_INTERVAL_MS = 5_000
const SETTLE_INTERVAL_MS = 30_000
const SLICE_SEC = SLICE_INTERVAL_MS / 1000
// The protocol prices energy at $10/kWh ($10 per 1000 Wh); the UI presents the
// mathematically identical $0.01/Wh. Both numbers appear on screen, so keep
// this note: they are one rate, not two.
// The signed slice value at 120W × 5s × $10/kWh = 1667 µUSDC, which
// is far enough above Circle's batched x402 fee floor that recipient net is
// the dominant term (vs the historical $0.25/kWh = 42 µUSDC where fee was
// 98% of value).
const RATE_USDC_PER_KWH = 10.0
const RATE_DISPLAY = "$0.01/Wh"
const RATE_DISPLAY_LABEL = "premium nano-charge"
const DRONE_WALLET = "0xDRN7c5Aa4f12B6c5e9D8A2F3B6C7e1A4D9C8E0F1A"
const DRONE_WALLET_SHORT = "0xDRN7…E0F1A"
// Block explorer base for settlement links. Default = Arc Testnet; for
// mainnet set NEXT_PUBLIC_ARC_EXPLORER (inlined at build time).
const ARC_EXPLORER = process.env.NEXT_PUBLIC_ARC_EXPLORER || "https://testnet.arcscan.app/tx/"
// The chain name shown on screen is DERIVED from the explorer above rather
// than written separately. They used to be independent, so pointing the
// explorer at mainnet left the page saying "Arc Testnet" right next to a
// mainnet link. Deriving it makes that contradiction unrepresentable.
const ARC_CHAIN_LABEL = ARC_EXPLORER.includes("testnet") ? "Arc Testnet" : "Arc Mainnet"
// Single-device demo: the seller EOA is the BurnIntent depositor for any
// Mint to Arc click. For a multi-device demo this should be derived from
// the settlement's source proof (proof.payTo) rather than hardcoded.
// No fallback on purpose: the depositor is deployment-specific real money —
// a baked-in default would silently mint against a stranger's deposit. When
// unset, the mint flow is hard-disabled and the UI says why.
const DEMO_DEVICE_ID = process.env.NEXT_PUBLIC_DEMO_DEVICE_ID ?? "ecandle-demo"
const DEMO_SELLER_EOA = process.env.NEXT_PUBLIC_DEMO_SELLER_EOA ?? null
// Circle batched x402 mint floor — value < this would net-mint 0 after fee.
// Worker re-floors anyway; this is a UI gate so the button only enables when
// the user has actually accumulated enough credit to clear it.
const MINT_FLOOR_MICRO_USDC = 10_000

/**
 * Simulate variable per-slice power to mimic the real CC-CV charging curve.
 * In production, eCandle measures `power.ac_output` averaged over the 5s
 * slice and tells the drone via BLE 0xEE03 SliceRequest. For preview this
 * generator approximates the same distribution: random jitter + occasional
 * tapering sequence.
 */
function simulateSlicePower(sliceIdx: number): number {
  // Cycle every 60 slices (~5 min) for visual variety in the preview.
  const cycleIdx = sliceIdx % 60
  if (cycleIdx < 42) {
    // CC phase: ~120W with ±10W jitter
    return 110 + Math.random() * 20
  }
  if (cycleIdx < 54) {
    // CV phase: linear taper from 120W to 30W over 12 slices, ±5W jitter
    const t = (cycleIdx - 42) / 12
    return 120 - t * 90 + (Math.random() - 0.5) * 10
  }
  // Trickle phase: ~15W with small jitter
  return 12 + Math.random() * 6
}

/** Energy delivered in a slice given average power. */
function sliceEnergyWh(powerW: number): number {
  return (powerW * SLICE_SEC) / 3600
}

/** USDC cost for a slice given the measured power. */
function sliceCostUsdc(powerW: number): number {
  return (sliceEnergyWh(powerW) / 1000) * RATE_USDC_PER_KWH
}

type Settlement = {
  // Stable id for React keys
  id: string
  // Circle Gateway off-chain credit-move identifier (UUID). Always present.
  transferUuid: string
  // Short display form for the table row (UUID-shortened by default;
  // upgrades to "0xabc…" form once a Path A mint lands).
  shortHash: string
  // Total µUSDC moved in this settle event
  amount: number  // in USDC
  ts: Date
  // Backlink to the originating proof
  sid: number
  sliceId: number | null
  // Path A: set once the off-chain credit corresponding to this settle has
  // been minted on-chain via gatewayMint. Until then this row is honest
  // off-chain credit only (no Arcscan link).
  onChainTxHash: string | null
  blockNumber: number
}

type SliceRecord = {
  id: string
  idx: number
  sid: number
  ts: Date
  powerW: number
  amountMicroUsdc: number
}

// Preview phase cycle to demonstrate both charging + idle states.
// Production state machine is driven by eCandle's real AC threshold detection.
const CHARGING_PHASE_MS = 90_000  // 90s charging in preview (real session ~45 min)
const IDLE_PHASE_MS = 30_000      // 30s idle in preview (real ~minutes between drones)

function genHash(): string {
  const hex = "0123456789abcdef"
  let s = "0x"
  for (let i = 0; i < 64; i++) s += hex[Math.floor(Math.random() * 16)]
  return s
}

function shortenHash(h: string): string {
  return h.slice(0, 6) + "…" + h.slice(-4)
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

export default function DemoPage() {
  // `?live=1` → consume SSE from /api/stream (real broker traffic).
  // No query param → fall back to the simulation cycles below (mock).
  //
  // Detected after mount via useEffect to avoid SSR hydration mismatch:
  // useState lazy initializer would run BOTH on server (window undef → false)
  // and on client first render. React keeps the server's value for hydration
  // matching, so the initializer's client-side `true` would be discarded
  // and isLive permanently stuck at false. The post-mount detection bypasses
  // SSR entirely — the simulation cycles run for one frame then yield.
  const [isLive, setIsLive] = useState(false)
  useEffect(() => {
    setIsLive(new URLSearchParams(window.location.search).has("live"))
  }, [])

  const [now, setNow] = useState(Date.now())
  const [sessionStartTs, setSessionStartTs] = useState(() => Date.now())
  const [isCharging, setIsCharging] = useState(true)
  const [sliceCount, setSliceCount] = useState(0)
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [sliceRecords, setSliceRecords] = useState<SliceRecord[]>([])
  const [lastSettleFlash, setLastSettleFlash] = useState(0)
  const [droneBalance, setDroneBalance] = useState(5.0)
  // Mint to Arc UX (Q3 = B aggregate-on-click): a click on any unminted
  // settlement triggers a single Path A mint that materializes ALL currently-
  // unminted credit into one on-chain Arc tx. The button is one global state
  // — minting=true while a mint is in-flight; rejected if button clicked
  // again before mint_ack arrives. Once mint_ack lands the SSE handler
  // backfills onChainTxHash on every settlement covered, and the button
  // re-enables for the next batch.
  const [minting, setMinting] = useState(false)
  const [mintError, setMintError] = useState<string | null>(null)
  // Snapshot of which UUIDs we asked the worker to mint, so we can detect
  // when the SSE mint_ack handler finishes backfilling them. Using a ref
  // (not state) avoids deps churn on the watchdog effect.
  const pendingMintUuidsRef = useRef<Set<string>>(new Set())
  // Live session accumulators (variable per-slice, reset on each charging→idle→charging cycle)
  const [paidThisSession, setPaidThisSession] = useState(0)
  const [energyWhSession, setEnergyWhSession] = useState(0)
  const [lastSlicePowerW, setLastSlicePowerW] = useState(0)
  const [lastSliceUsdcMicro, setLastSliceUsdcMicro] = useState(0)
  const [pendingBatchUsdcDisplay, setPendingBatchUsdcDisplay] = useState(0)
  // Cumulative-tonight running totals — start at 0, accumulate continuously
  // across all sessions. (A sessions counter was removed — it read as
  // redundant alongside the energy + USDC totals.)
  const [cumulative, setCumulative] = useState({
    energyKWh: 0,
    paidUSDC: 0,
  })
  // Ref-backed accumulators so the settle useEffect can read/write without
  // putting them in its deps list.
  const pendingBatchUsdcRef = useRef(0)
  const lastBlockNumberRef = useRef(4_371_018)
  const sliceIdxRef = useRef(0)
  // Refs for the phase cycle — interval handlers read these without needing
  // to be in deps (which would cause cleanup-recreate every state change).
  const isChargingRef = useRef(true)
  const chargingPhaseStartTsRef = useRef(Date.now())
  // Live-mode: slice_paid handler needs to read the latest power without
  // re-binding the SSE listener on every render.
  const lastSlicePowerWRef = useRef(0)
  // Live-mode watchdog: track last slice_PAID time specifically. Tracking
  // any nanopay event doesn't work because eCandle keeps emitting
  // slice_req with avg_w=0 when AC power drops to zero (zombie state —
  // session active server-side but drone is rejecting every slice because
  // wh < MIN_EXPECTED_WH). slice_paid only fires when the drone actually
  // signed, so its absence is the definitive "not really charging" signal.
  const lastSlicePaidTsRef = useRef(0)
  // Fast-path zero-power streak detector — after 2 consecutive
  // zero-power slice_req events the page knows charging is over without
  // waiting for the slow watchdog timeout.
  const zeroPowerStreakRef = useRef(0)
  // Per-slice avg_w lookup keyed by `${sid}:${slice_id}`. Populated by
  // slice_req, read by slice_paid so the recorded powerW is the actual
  // billable avg_w for THAT slice, not whatever the global ref happens
  // to hold when slice_paid arrives. Survives bursty SSE delivery,
  // status-event interleaving, and out-of-order slice_paid arrivals.
  const slicePowerByIdRef = useRef<Map<string, number>>(new Map())
  // Debounce IDLE flip after a stream_stop / disconnect: a brief BLE
  // supervision-timeout (reason=520, ~17s reconnect) would otherwise
  // visibly flicker the CHARGING tag. Hold the IDLE transition for 20s;
  // a fresh stream_start within that window cancels it.
  const streamGapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Bumped to force the SSE useEffect to tear down and re-create the
  // EventSource. EventSource does NOT auto-reconnect on graceful server
  // close (readyState === CLOSED) — required for surviving deploys.
  const [sseReconnectKey, setSseReconnectKey] = useState(0)

  // Q3 = B aggregate-on-click + traceability hardening:
  //
  // The browser sends only `{deviceId, depositor}`. The burn-intent-worker
  // is the canonical authority on WHICH Circle UUIDs are still unminted for
  // that seller — it subscribes to circle_ack itself and maintains a
  // server-side Set. This closes the gap where stale browser state could
  // ship synthetic UUIDs (e.g. `unk-<ts>`) into the on-chain evidence trail.
  //
  // We still locally snapshot the currently-unminted UUIDs so the watchdog
  // effect below can detect when mint_ack arrives and at least one of OUR
  // visible rows gets backfilled with an onChainTxHash — i.e. the local
  // snapshot is purely for clearing the `minting` button state, not for the
  // mint payload itself.
  async function triggerMint() {
    if (minting) return
    const unmintedUuids: string[] = []
    for (const s of settlements) {
      if (s.onChainTxHash) continue
      unmintedUuids.push(s.transferUuid)
    }
    if (unmintedUuids.length === 0) {
      setMintError("no unminted settlements to materialize")
      return
    }
    if (!DEMO_SELLER_EOA) {
      setMintError(
        "NEXT_PUBLIC_DEMO_SELLER_EOA is not set — refusing to mint. Set it to YOUR seller's EOA (printed on eCandle boot) in cloud/.env; see cloud/.env.example.",
      )
      return
    }
    setMinting(true)
    setMintError(null)
    pendingMintUuidsRef.current = new Set(unmintedUuids)
    try {
      const res = await fetch("/api/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: DEMO_DEVICE_ID,
          depositor: DEMO_SELLER_EOA,
        }),
      })
      if (!res.ok) {
        const t = await res.text()
        setMintError(`HTTP ${res.status}: ${t.slice(0, 120)}`)
      }
    } catch (e) {
      setMintError((e as Error).message)
      setMinting(false)
    }
  }

  // Clear minting=true once at least one of the UUIDs we asked the worker to
  // mint has gained an onChainTxHash. That's the SSE-driven signal mint_ack
  // landed and the row(s) we triggered for have been upgraded.
  useEffect(() => {
    if (!minting) return
    if (pendingMintUuidsRef.current.size === 0) return
    for (const s of settlements) {
      if (s.onChainTxHash && pendingMintUuidsRef.current.has(s.transferUuid)) {
        setMinting(false)
        pendingMintUuidsRef.current = new Set()
        return
      }
    }
  }, [minting, settlements])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // ─── Simulation: slice generation (mock mode only) ────────────────────
  // Runs every 5s but EMITS a slice only when charging. Guarded by isLive
  // so the simulation doesn't double-write state alongside the SSE handler
  // (which would mix mock 110-130W and real ~73W slices in the records).
  useEffect(() => {
    if (isLive) return
    const t = setInterval(() => {
      if (!isChargingRef.current) return  // idle: no slices generated
      const sliceIdx = sliceIdxRef.current
      sliceIdxRef.current = sliceIdx + 1
      const power = simulateSlicePower(sliceIdx)
      const energy = sliceEnergyWh(power)
      const cost = sliceCostUsdc(power)

      setSliceCount(sliceIdx + 1)
      setLastSlicePowerW(power)
      setLastSliceUsdcMicro(cost * 1_000_000)
      setPaidThisSession(p => p + cost)
      setEnergyWhSession(e => e + energy)
      setDroneBalance(b => Math.max(0, b - cost))

      pendingBatchUsdcRef.current += cost
      setPendingBatchUsdcDisplay(pendingBatchUsdcRef.current)

      setCumulative(cu => ({
        energyKWh: cu.energyKWh + energy / 1000,
        paidUSDC: cu.paidUSDC + cost,
      }))

      setSliceRecords(prev => [
        {
          id: `${sliceIdx + 1}-${Date.now()}`,
          idx: sliceIdx + 1,
          sid: 0,
          ts: new Date(),
          powerW: power,
          amountMicroUsdc: cost * 1_000_000,
        },
        ...prev,
      ].slice(0, 200))
    }, SLICE_INTERVAL_MS)
    return () => clearInterval(t)
  }, [isLive])

  // ─── Simulation: settle batch (mock mode only) ────────────────────────
  // Settle batch — fires every 30s, but only emits an on-chain tx if there
  // are pending slices to settle.
  useEffect(() => {
    if (isLive) return
    const t = setInterval(() => {
      if (pendingBatchUsdcRef.current === 0) return  // nothing accumulated
      const batchAmount = pendingBatchUsdcRef.current
      pendingBatchUsdcRef.current = 0
      setPendingBatchUsdcDisplay(0)
      const tx = genHash()
      lastBlockNumberRef.current += Math.floor(Math.random() * 30) + 8
      // Mock mode: synthesize a UUID-shaped identifier so the off-chain
      // credit narrative is consistent with live mode. Real circle_ack
      // events arrive in live mode with the actual Circle UUID.
      const fakeUuid = `mock-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 5)}`
      setSettlements(prev => {
        const newSettle: Settlement = {
          id: fakeUuid,
          transferUuid: fakeUuid,
          shortHash: shortenHash(tx),
          amount: batchAmount,
          ts: new Date(),
          sid: 0,
          sliceId: null,
          onChainTxHash: null,
          blockNumber: lastBlockNumberRef.current,
        }
        return [newSettle, ...prev].slice(0, 100)
      })
      setLastSettleFlash(Date.now())
    }, SETTLE_INTERVAL_MS)
    return () => clearInterval(t)
  }, [isLive])

  // ─── Simulation: charging/idle phase cycle (mock mode only) ───────────
  // Phase cycle — flips isCharging between true/false to demo both states.
  // Production: this state is driven by drone-pad-monitor's threshold worker.
  useEffect(() => {
    if (isLive) return
    const t = setInterval(() => {
      const elapsed = Date.now() - chargingPhaseStartTsRef.current
      if (isChargingRef.current && elapsed > CHARGING_PHASE_MS) {
        // 90s charging → switch to idle (drone done, leaves)
        isChargingRef.current = false
        setIsCharging(false)
        chargingPhaseStartTsRef.current = Date.now()
      } else if (!isChargingRef.current && elapsed > IDLE_PHASE_MS) {
        // 30s idle → switch back to charging (next drone arrives)
        isChargingRef.current = true
        setIsCharging(true)
        chargingPhaseStartTsRef.current = Date.now()
        // Reset session-level accumulators for new session.
        // Cumulative keeps growing across sessions.
        setPaidThisSession(0)
        setEnergyWhSession(0)
        setSessionStartTs(Date.now())
        setSliceRecords([])
        setLastSlicePowerW(0)
        setLastSliceUsdcMicro(0)
      }
    }, 1000)
    return () => clearInterval(t)
  }, [isLive])

  // ─── Reset state when entering live mode ──────────────────────────────
  // The simulation effects may have populated some records before isLive
  // flipped (one render cycle's worth on mount). Clear them so live data
  // starts from a clean slate. Also seed droneBalance to the actual
  // Gateway deposit (1 USDC, see drone-deposit-helper.js block 46529915).
  useEffect(() => {
    if (!isLive) return
    setSliceCount(0)
    setSliceRecords([])
    setSettlements([])
    setPaidThisSession(0)
    setEnergyWhSession(0)
    setLastSlicePowerW(0)
    setLastSliceUsdcMicro(0)
    setPendingBatchUsdcDisplay(0)
    setCumulative({ energyKWh: 0, paidUSDC: 0 })
    setDroneBalance(1.0)
    setIsCharging(false)
    sliceIdxRef.current = 0
    pendingBatchUsdcRef.current = 0
    lastSlicePowerWRef.current = 0
    lastSlicePaidTsRef.current = 0
    zeroPowerStreakRef.current = 0
  }, [isLive])

  // ─── Live mode: slice_paid watchdog (auto-transition to IDLE) ─────────
  // Fall-back to IDLE if no slice_PAID for 7s (slice cadence is 5s, so a
  // single missed paid event already says "drone rejected" — 7s catches
  // it on the next watchdog tick). Used in addition to the
  // zero-power-streak fast path in the slice_req handler.
  useEffect(() => {
    if (!isLive) return
    const watchdog = setInterval(() => {
      if (!isCharging) return
      const last = lastSlicePaidTsRef.current
      if (last === 0) return
      if (Date.now() - last > 7000) {
        // Watchdog: only flip the CHARGING tag. eCandle may still be
        // broadcasting low-power slice_req; let those continue to refresh
        // the displayed wattage with ground-truth metering.
        setIsCharging(false)
      }
    }, 1000)
    return () => clearInterval(watchdog)
  }, [isLive, isCharging])

  // ─── Live mode: SSE-driven state (real broker traffic) ─────────────────
  // Listens to /api/stream, which forwards every MQTT message
  // on ecandle/+/nanopay and ecandle/+/settle. Updates the same display
  // state vars the simulation cycles drive — so the visual layout is
  // identical regardless of mock vs live.
  useEffect(() => {
    if (!isLive) return
    const es = new EventSource("/api/stream")

    // Status events carry live ecandle ac_output, independent of any
    // active nanopayment session. Drives the displayed "power" meter so
    // viewers see the dock-standby 4W and the 55W charging surge even
    // before/after sessions begin.
    //
    // IMPORTANT: do NOT update lastSlicePowerWRef from status — that
    // ref is read by the slice_paid handler to attribute powerW to the
    // recorded slice (the billed value, from slice_req's avg_w). If
    // status overrode it, a slice_paid landing mid-cycle would record
    // the wrong power. Display state only.
    es.addEventListener("status", (e) => {
      let m: Record<string, unknown>
      try { m = JSON.parse((e as MessageEvent).data) } catch { return }
      const ac = Number(m.ac_output ?? 0)
      setLastSlicePowerW(ac)
    })

    es.addEventListener("nanopay", (e) => {
      let m: Record<string, unknown>
      try { m = JSON.parse((e as MessageEvent).data) } catch { return }
      switch (m.ev) {
        case "session_notify": {
          // cmd 1 = START, 2 = STOP, 5 = DONE
          if (m.cmd === 1) {
            const sid = Number(m.sid ?? 0)
            setIsCharging(true)
            setSessionStartTs(Date.now())
            // Reset only the per-session "Paid This Session" + elapsed
            // metrics. sliceRecords + settlements + cumulative tonight
            // are cross-session running history and must NOT reset — the
            // demo broadcast is meant to show continuous activity.
            setPaidThisSession(0)
            setEnergyWhSession(0)
            sliceIdxRef.current = 0
            lastSlicePowerWRef.current = 0
            zeroPowerStreakRef.current = 0
            // Re-use sessionId-as-block-number so the existing UI still
            // shows a monotonically-rising "block" tag on settlements.
            lastBlockNumberRef.current = 4_400_000 + sid
          } else if (m.cmd === 2 || m.cmd === 5) {
            // Session ended. Do NOT reset displayed power — status events
            // (every ~3s) drive lastSlicePowerW from live ecandle ac_output.
            // Resetting here causes a visible 0W flicker between session
            // end and the next status tick.
            setIsCharging(false)
            setLastSliceUsdcMicro(0)
          }
          break
        }
        case "slice_req": {
          const powerW = Number(m.avg_w ?? 0)
          const amountMicro = Number(m.amount_micro ?? 0)
          const sliceSid = Number(m.sid ?? 0)
          const sliceId = Number(m.slice_id ?? 0)
          // Treat slice_req as a "session-alive" signal too — eCandle
          // broadcasts every 5s, and one missed slice_paid (BLE jitter) on
          // a 7s watchdog otherwise causes a CHARGING/IDLE flicker even
          // though the load is steady.
          lastSlicePaidTsRef.current = Date.now()
          // Remember this slice's avg_w so the matching slice_paid can
          // look it up by (sid, slice_id) regardless of what arrived in
          // between.
          slicePowerByIdRef.current.set(`${sliceSid}:${sliceId}`, powerW)
          // Cap at 256 entries to bound memory.
          if (slicePowerByIdRef.current.size > 256) {
            const firstKey = slicePowerByIdRef.current.keys().next().value
            if (firstKey !== undefined) slicePowerByIdRef.current.delete(firstKey)
          }
          setLastSlicePowerW(powerW)
          setLastSliceUsdcMicro(amountMicro)
          lastSlicePowerWRef.current = powerW
          // 5W threshold mirrors backend drone-pad-monitor's DRONE_ARRIVAL_W /
          // DRONE_DONE_W. Below 5W is eCandle inverter idle baseline + noise
          // floor (and trickle-residual when the load is already disconnected),
          // not real charging.
          if (powerW >= 5) {
            zeroPowerStreakRef.current = 0
            setIsCharging(true)
          } else {
            // Sub-threshold slice_req — eCandle's keepalive while AC load is
            // gone or trivially low. 2-strike fast-path → IDLE without waiting
            // for the 7s watchdog.
            zeroPowerStreakRef.current += 1
            if (zeroPowerStreakRef.current >= 2) {
              // 2-strike sub-threshold fast-path: only flip CHARGING tag.
              // Keep showing the live ground-truth wattage (e.g. 4W dock
              // standby) — page-level "is the drone being paid?" state
              // changes, but the power meter keeps reporting reality.
              setIsCharging(false)
            }
          }
          break
        }
        case "slice_paid": {
          const sliceSid = Number(m.sid ?? 0)
          const sliceId = Number(m.slice_id ?? 0)
          const amountMicro = Number(m.amount_micro ?? 0)
          const amountUsdc  = amountMicro / 1_000_000
          // Look up the exact avg_w for this slice. Falls back to the
          // last-known ref only if the slice_req for this slice never
          // arrived (which should be rare — only out-of-order delivery).
          const recordedPowerW = slicePowerByIdRef.current.get(`${sliceSid}:${sliceId}`)
            ?? lastSlicePowerWRef.current
          const wh = (recordedPowerW * SLICE_SEC) / 3600
          lastSlicePaidTsRef.current = Date.now()
          setPaidThisSession(p => p + amountUsdc)
          setEnergyWhSession(e => e + wh)
          setSliceCount(c => c + 1)
          sliceIdxRef.current += 1
          setCumulative(cu => ({
            energyKWh: cu.energyKWh + wh / 1000,
            paidUSDC:  cu.paidUSDC + amountUsdc,
          }))
          pendingBatchUsdcRef.current += amountUsdc
          setPendingBatchUsdcDisplay(pendingBatchUsdcRef.current)
          // Decrement drone wallet display by the slice amount. Seeded to
          // 1 USDC (the Gateway deposit) on entering live mode.
          setDroneBalance(b => Math.max(0, b - amountUsdc))
          setSliceRecords(prev => [{
            id:               `live-${sliceSid}-${sliceId}-${Date.now()}`,
            idx:              sliceIdxRef.current,   // demo-global counter
            sid:              sliceSid,
            ts:               new Date(),
            powerW:           recordedPowerW,
            amountMicroUsdc:  amountMicro,
          }, ...prev].slice(0, 200))
          break
        }
        case "stream_start": {
          // A-prime session begin (drone wrote 0xEE01 0x02). Just flip
          // the CHARGING tag and cancel any pending IDLE-debounce —
          // hero metrics are demo-cumulative now, NOT per-session.
          if (streamGapTimerRef.current) {
            clearTimeout(streamGapTimerRef.current)
            streamGapTimerRef.current = null
          }
          setIsCharging(true)
          lastSlicePowerWRef.current = 0
          zeroPowerStreakRef.current = 0
          break
        }
        case "stream_stop":
        case "disconnect": {
          // Leave power display alone, status events drive that.
          // Debounce the IDLE flip: a BLE supervision timeout (520) reconnects
          // in ~17s during which CHARGING would visibly flicker to IDLE then
          // back. If a fresh stream_start arrives within 20s, the timer
          // cancels and the page stays on CHARGING (no perceptible glitch).
          // A real session end takes 20s extra to show IDLE — acceptable.
          setLastSliceUsdcMicro(0)
          if (streamGapTimerRef.current) clearTimeout(streamGapTimerRef.current)
          streamGapTimerRef.current = setTimeout(() => {
            setIsCharging(false)
            streamGapTimerRef.current = null
          }, 20_000)
          break
        }
      }
    })

    // circle_ack: per-batch event from settle-worker carrying real Circle
    // UUIDs after the batched x402 settle has been accepted by Circle. One
    // settlement row per successful proof (not one row per batch). The
    // UUID is authoritative evidence of the off-chain credit move; the row
    // does NOT link to Arcscan because the UUID is not an Arc tx hash.
    // When a Path A mint lands, the mint_ack handler upgrades the row's
    // onChainTxHash + the UI conditionally renders an Arcscan link.
    es.addEventListener("circle_ack", (e) => {
      type AckResult = {
        slice_id?: number
        value?: string | number
        success?: boolean
        transaction?: string | null
        errorReason?: string | null
      }
      let m: { sid?: number; batch_idx?: number; results?: AckResult[] }
      try { m = JSON.parse((e as MessageEvent).data) } catch { return }
      const sid = Number(m.sid ?? 0)
      const results = Array.isArray(m.results) ? m.results : []
      const newRows: Settlement[] = []
      let batchTotalUsdc = 0
      for (const r of results) {
        if (!r.success || !r.transaction) continue
        const valueMicro = Number(r.value ?? 0)
        batchTotalUsdc += valueMicro / 1_000_000
        newRows.push({
          id: r.transaction,
          transferUuid: r.transaction,
          shortHash: shortenHash(r.transaction),
          amount: valueMicro / 1_000_000,
          ts: new Date(),
          sid,
          sliceId: typeof r.slice_id === "number" ? r.slice_id : null,
          onChainTxHash: null,
          blockNumber: 0,
        })
      }
      if (newRows.length === 0) return
      setSettlements(prev => {
        const existing = new Set(prev.map(s => s.transferUuid))
        const merged = [...newRows.filter(r => !existing.has(r.transferUuid)), ...prev]
        return merged.slice(0, 100)
      })
      pendingBatchUsdcRef.current = Math.max(0, pendingBatchUsdcRef.current - batchTotalUsdc)
      setPendingBatchUsdcDisplay(pendingBatchUsdcRef.current)
      setLastSettleFlash(Date.now())
    })

    // mint_ack: per-Arc-tx event from burn-intent-worker carrying the real
    // on-chain tx hash from gatewayMint. Backfill onChainTxHash on every
    // settlement whose transferUuid is in the ack's covered list (Q3=B
    // aggregate-on-click: one Arc tx may cover many circle settlements).
    es.addEventListener("mint_ack", (e) => {
      let m: { tx_hash?: string; block_number?: number; covered_uuids?: string[] }
      try { m = JSON.parse((e as MessageEvent).data) } catch { return }
      const txHash = m.tx_hash
      if (!txHash) return
      const blockNum = typeof m.block_number === "number" ? m.block_number : 0
      const covered = new Set(Array.isArray(m.covered_uuids) ? m.covered_uuids : [])
      setSettlements(prev => prev.map(s => {
        if (s.onChainTxHash) return s
        if (covered.size > 0 && !covered.has(s.transferUuid)) return s
        return {
          ...s,
          shortHash: shortenHash(txHash),
          onChainTxHash: txHash,
          blockNumber: blockNum,
        }
      }))
      lastBlockNumberRef.current = blockNum > 0 ? blockNum : lastBlockNumberRef.current
      setLastSettleFlash(Date.now())
    })

    es.addEventListener("hello", () => {
      // SSE handshake; the snapshot event arrives right after.
    })

    // Snapshot — server sends this right after `hello` so every newly
    // connecting browser sees the same rolling state as the broadcast
    // feed (slice records, settle records, cumulative totals). Without
    // it, a viewer that joins 30 min in would start from zero while
    // Circle's broadcast already has hundreds of records.
    es.addEventListener("snapshot", (e) => {
      type SnapshotSettle = {
        id?: string
        transferUuid?: string
        shortHash: string
        amountMicroUsdc?: number
        amount?: number
        tsMs: number
        sid?: number
        sliceId?: number | null
        onChainTxHash?: string | null
        mintBlockNumber?: number | null
        blockNumber?: number
      }
      let m: {
        sliceRecords?: Array<{ id: string; idx: number; sid?: number; tsMs: number; powerW: number; amountMicroUsdc: number }>
        settlements?: SnapshotSettle[]
        cumulative?: { energyKWh: number; paidUSDC: number; sliceCount: number }
        demoStartTsMs?: number
      }
      try { m = JSON.parse((e as MessageEvent).data) } catch { return }

      const slices = (m.sliceRecords ?? []).map(r => ({
        id:               r.id,
        idx:              r.idx,
        sid:              r.sid ?? 0,
        ts:               new Date(r.tsMs),
        powerW:           r.powerW,
        amountMicroUsdc:  r.amountMicroUsdc,
      }))
      const settles: Settlement[] = (m.settlements ?? []).map(s => {
        const uuid = s.transferUuid ?? s.id ?? `unk-${s.tsMs}`
        const amountUsdc = typeof s.amount === "number"
          ? s.amount
          : (typeof s.amountMicroUsdc === "number" ? s.amountMicroUsdc / 1_000_000 : 0)
        const onChain = s.onChainTxHash ?? null
        return {
          id:            uuid,
          transferUuid:  uuid,
          shortHash:     onChain ? shortenHash(onChain) : s.shortHash,
          amount:        amountUsdc,
          ts:            new Date(s.tsMs),
          sid:           s.sid ?? 0,
          sliceId:       s.sliceId ?? null,
          onChainTxHash: onChain,
          blockNumber:   s.mintBlockNumber ?? s.blockNumber ?? 0,
        }
      })

      setSliceRecords(slices)
      setSettlements(settles)
      if (m.cumulative) {
        setCumulative({
          energyKWh: m.cumulative.energyKWh,
          paidUSDC:  m.cumulative.paidUSDC,
        })
        // Drone wallet is seeded at 1 USDC deposit; balance = max(0, 1 - paid).
        setDroneBalance(Math.max(0, 1 - m.cumulative.paidUSDC))
        // Hero band metrics are now demo-cumulative (no per-session reset).
        setSliceCount(m.cumulative.sliceCount)
        setEnergyWhSession(m.cumulative.energyKWh * 1000)
        setPaidThisSession(m.cumulative.paidUSDC)
        // Sync the slice-idx ref so newly-arrived slice_paid increments
        // land on the same numbers the server already counted.
        sliceIdxRef.current = m.cumulative.sliceCount
      }
      if (settles.length > 0) {
        lastBlockNumberRef.current = settles[0].blockNumber
      }
      if (m.demoStartTsMs && m.demoStartTsMs > 0) {
        setSessionStartTs(m.demoStartTsMs)
      }
    })

    es.onerror = () => {
      // EventSource only auto-reconnects on transient errors
      // (readyState === CONNECTING). A graceful server close — PM2
      // restart, Next.js redeploy, app-side controller.close() —
      // moves it to CLOSED, which is permanent unless we rebuild
      // manually. Without this handler every deploy stranded
      // browsers with stale state until users hard-refreshed.
      if (es.readyState === EventSource.CLOSED) {
        setTimeout(() => setSseReconnectKey(k => k + 1), 1000)
      }
      // readyState === CONNECTING → browser is retrying, leave alone.
    }

    return () => es.close()
  }, [isLive, sseReconnectKey])

  // Clamp non-negative: setSessionStartTs(Date.now()) can be set in a SSE
  // handler one render before the 1-Hz `now` tick catches up, leaving
  // (now - sessionStartTs) briefly negative → formatElapsed → "-1:-1".
  const elapsedSec = Math.max(0, Math.floor((now - sessionStartTs) / 1000))
  const sliceCountdown = SLICE_INTERVAL_MS / 1000 - (elapsedSec % (SLICE_INTERVAL_MS / 1000))
  const settleCountdown = SETTLE_INTERVAL_MS / 1000 - (elapsedSec % (SETTLE_INTERVAL_MS / 1000))
  const flashActive = lastSettleFlash > 0 && (now - lastSettleFlash) < 1500

  return (
    <main className="h-screen overflow-hidden bg-[#06050f] text-white relative">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 opacity-25 bg-[radial-gradient(ellipse_at_top_left,_#6E47C7_0%,_transparent_50%)]" />
        <div className="absolute inset-0 opacity-20 bg-[radial-gradient(ellipse_at_bottom_right,_#F59E0B_0%,_transparent_55%)]" />
      </div>

      <div className="relative z-10 max-w-[1920px] mx-auto px-10 py-5 grid grid-rows-[auto_auto_1fr_200px_auto] gap-3 h-screen">

        {/* === ROW 1: HEADER === */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-xl font-bold tracking-tight">⚡ TLAY</div>
            <div className="text-white/30">×</div>
            <div className="text-xl font-bold tracking-tight text-[#a78bfa]">Arc</div>
            <div className="text-white/30">×</div>
            <div className="text-xl font-bold tracking-tight">Circle</div>
            <div className="ml-4 text-[10px] text-white/40 uppercase tracking-widest">
              Drone Show · SF Ferry Building · 2026
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ChargingStateBadge isCharging={isCharging} />
            <div className="text-[10px] text-white/50 uppercase tracking-widest">Live · {ARC_CHAIN_LABEL}</div>
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          </div>
        </header>

        {/* === ROW 2: HERO METRICS BAND === */}
        <section className="grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-center gap-4 px-2 py-2">
          <Metric
            label="Charging Power"
            value={lastSlicePowerW.toFixed(0)}
            unit="W"
            color="#fbbf24"
            subline={`last slice ${lastSliceUsdcMicro.toFixed(0)} μUSDC · ${RATE_DISPLAY} ${RATE_DISPLAY_LABEL}`}
          />
          <Divider />
          <Metric
            label="Demo Elapsed"
            value={formatElapsed(elapsedSec)}
            mono color="#ffffff"
            subline={`${sliceCount} slices · ${energyWhSession.toFixed(3)} Wh total`}
          />
          <Divider />
          <Metric
            label="Total Paid"
            value={paidThisSession.toFixed(6)}
            unit="USDC"
            color="#34d399"
            subline={`next settle in ${settleCountdown}s (${(pendingBatchUsdcDisplay * 1_000_000).toFixed(0)} μUSDC pending)`}
          />
          <Divider />
          <DroneWalletCompact balance={droneBalance} addrShort={DRONE_WALLET_SHORT} />
        </section>

        {/* === ROW 3: PAYMENT FLOW (centerpiece) === */}
        <section className="relative flex items-center justify-center min-h-0">
          <PaymentFlow
            sliceCount={sliceCount}
            sliceCountdown={sliceCountdown}
            settleCountdown={settleCountdown}
            isCharging={isCharging}
          />
        </section>

        {/* === ROW 4: SLICES (left) + SETTLEMENTS (right) — fixed 240px panel === */}
        <section className="grid grid-cols-[1fr_1fr] gap-3 h-full min-h-0 overflow-hidden">
          {/* LEFT: per-slice nanopayment records (off-chain BLE-signed) */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3 backdrop-blur h-full overflow-hidden flex flex-col">
            <div className="flex items-center justify-between mb-2 shrink-0">
              <h2 className="text-[11px] uppercase tracking-[0.2em] text-white/50">
                Slices · 5s nanopayments <span className="text-white/30 normal-case">(off-chain · BLE EIP-3009)</span>
              </h2>
              <div className="text-[10px] text-white/30 font-mono">{sliceCount} this session</div>
            </div>
            <div className="space-y-0.5 flex-1 min-h-0 overflow-y-auto pr-1">
              {sliceRecords.length === 0 ? (
                <div className="text-center py-6 text-white/30 text-sm">
                  {isCharging ? "Awaiting first slice…" : "○ Idle — drone not on pad"}
                </div>
              ) : (
                sliceRecords.map((r, i) => (
                  <div
                    key={r.id}
                    className={`flex items-center gap-3 px-3 py-1 rounded-lg border transition-all duration-300 ${
                      i === 0 ? "bg-[#fbbf24]/10 border-[#fbbf24]/30" : "border-white/5"
                    }`}
                    style={i === 0 ? { animation: "slideIn 400ms ease-out" } : {}}
                  >
                    <span className={`${i === 0 ? "text-[#fbbf24]" : "text-[#fbbf24]/60"}`}>⚡</span>
                    <span className="font-mono text-[11px] text-white/40 tabular-nums">{r.ts.toTimeString().slice(0, 8)}</span>
                    <span className="font-mono text-[11px] text-white/50 tabular-nums">#{r.idx}</span>
                    <span className="font-mono text-[11px] text-white/60 tabular-nums">{r.powerW.toFixed(0)} W</span>
                    <span className="ml-auto font-mono text-xs text-white/90 tabular-nums">{r.amountMicroUsdc.toFixed(0)} <span className="text-white/40">μUSDC</span></span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* RIGHT: Circle Gateway settlements (off-chain credit moves with
              real Circle UUIDs); rows upgrade to Arc on-chain links once a
              Path A "Mint to Arc" lands. */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3 backdrop-blur h-full overflow-hidden flex flex-col">
            <div className="flex items-center justify-between mb-2 shrink-0">
              <h2 className="text-[11px] uppercase tracking-[0.2em] text-white/50">
                Settlements · per slice <span className="text-white/30 normal-case">(off-chain · Circle Gateway · UUID)</span>
              </h2>
              {(() => {
                const unmintedTotalMicro = settlements.reduce(
                  (s, x) => s + (x.onChainTxHash ? 0 : Math.round(x.amount * 1_000_000)),
                  0,
                )
                const effectiveMintMicro = Math.max(unmintedTotalMicro, MINT_FLOOR_MICRO_USDC)
                const unmintedCount = settlements.filter(s => !s.onChainTxHash).length
                const canMint = !minting && unmintedCount > 0 && !!DEMO_SELLER_EOA
                return (
                  <button
                    onClick={triggerMint}
                    disabled={!canMint}
                    title={
                      !DEMO_SELLER_EOA
                        ? "NEXT_PUBLIC_DEMO_SELLER_EOA is not set — mint disabled (see cloud/.env.example)"
                        : minting
                          ? "Mint in flight — awaiting Arc tx confirmation"
                          : unmintedCount === 0
                            ? "No unminted credit to materialize"
                            : `Aggregate-mint ${unmintedCount} settlement(s), ${effectiveMintMicro} µUSDC, into a single Arc tx`
                    }
                    className={`text-[10px] px-2 py-0.5 rounded border font-mono uppercase tracking-widest transition ${
                      canMint
                        ? "border-cyan-400/40 text-cyan-300 hover:bg-cyan-500/10"
                        : "border-white/10 text-white/30 cursor-not-allowed"
                    }`}
                  >
                    {minting
                      ? "minting…"
                      : unmintedCount > 0
                        ? `Mint ${unmintedCount} → Arc`
                        : "Mint to Arc"}
                  </button>
                )
              })()}
            </div>
            {mintError && (
              <div className="mb-1 px-2 py-1 text-[10px] text-red-300 bg-red-500/10 border border-red-500/30 rounded font-mono">
                mint error: {mintError}
              </div>
            )}
            <div className="space-y-0.5 flex-1 min-h-0 overflow-y-auto pr-1">
              {settlements.length === 0 ? (
                <div className="text-center py-6 text-white/30 text-sm">
                  Waiting for first Circle Gateway settle (every 30 s during charging)…
                </div>
              ) : (
                settlements.map((s, i) => {
                  const onChain = !!s.onChainTxHash
                  const sharedClass = `group flex items-center gap-3 px-3 py-1 rounded-lg transition-all duration-500 ${
                    i === 0 && flashActive
                      ? "bg-emerald-400/15 border border-emerald-400/40"
                      : "border border-white/5 hover:border-white/20 hover:bg-white/[0.04]"
                  }`
                  const style = i === 0 ? { animation: "slideIn 600ms ease-out" } : {}
                  const rowInner = (
                    <>
                      <span className={`text-emerald-400 ${i === 0 && flashActive ? "opacity-100" : "opacity-70"}`}>
                        {onChain ? "✓" : "○"}
                      </span>
                      <span className="font-mono text-[11px] text-white/40 tabular-nums">{s.ts.toTimeString().slice(0, 8)}</span>
                      <span className="font-mono text-[11px] text-white/70" title={s.transferUuid}>
                        {onChain ? "0x" : ""}{s.shortHash}
                      </span>
                      <span className="text-[9px] uppercase tracking-widest text-white/30">
                        {onChain ? "minted · Arc" : "off-chain"}
                      </span>
                      <span className="ml-auto font-mono text-xs text-white/90 tabular-nums">{s.amount.toFixed(6)} <span className="text-white/40">USDC</span></span>
                      {onChain && <span className="text-white/30 group-hover:text-white/80">↗</span>}
                    </>
                  )
                  return onChain ? (
                    <a
                      key={s.id}
                      href={`${ARC_EXPLORER}${s.onChainTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={sharedClass}
                      style={style}
                    >
                      {rowInner}
                    </a>
                  ) : (
                    <div key={s.id} className={sharedClass} style={style} title="Off-chain Circle Gateway credit. Click 'Mint to Arc' to materialize to on-chain USDC.">
                      {rowInner}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </section>

        {/* === ROW 5: FOOTER with cumulative + QR === */}
        <footer className="flex items-center justify-between gap-4 pt-2 border-t border-white/5">
          <div className="flex items-center gap-3 text-[9px] text-white/40">
            <span className="uppercase tracking-widest">Powered by</span>
            <span className="text-white/70">{ARC_CHAIN_LABEL}</span><span>·</span>
            <span className="text-white/70">Circle Nanopayments</span><span>·</span>
            <span className="text-white/70">TLAY BoAT Machine Economy Runtime</span><span>·</span>
            <span className="text-white/70">Arkreen eCandle DePIN</span>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-4 text-[10px] font-mono">
              <span className="text-white/40 uppercase tracking-widest">Cumulative tonight</span>
              <span className="text-white/90 tabular-nums">{cumulative.energyKWh.toFixed(4)} kWh</span>
              <span className="text-white/30">·</span>
              <span className="text-white/90 tabular-nums">{cumulative.paidUSDC.toFixed(6)} USDC</span>
              <span className="text-white/30">·</span>
              <span className="text-white/40">@ {RATE_DISPLAY}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="bg-white p-1 rounded">
                <QRCodeCanvas value="https://github.com/TLAY-IO/arc-drone-show-demo" size={42} level="M" />
              </div>
              <div className="text-[9px] text-white/40 leading-tight">
                <div className="uppercase tracking-widest">Day-1 OSR · MIT</div>
                <div className="font-mono text-white/60">github.com/TLAY-IO/<br/>arc-drone-show-demo</div>
              </div>
            </div>
          </div>
        </footer>
      </div>

      <style jsx global>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </main>
  )
}

/* ─── Components ────────────────────────────────────────────────────────── */

function Metric({ label, value, unit, color, mono, subline }: {
  label: string; value: string | number; unit?: string; color: string; mono?: boolean; subline?: string
}) {
  return (
    <div className="text-center">
      <div className="text-[10px] text-white/40 uppercase tracking-[0.2em] mb-1">{label}</div>
      <div className={`text-4xl font-bold tabular-nums ${mono ? "font-mono" : ""}`} style={{ color, textShadow: `0 0 24px ${color}66` }}>
        {value}
        {unit && <span className="text-lg text-white/40 ml-1.5">{unit}</span>}
      </div>
      {subline && <div className="text-[10px] text-white/40 mt-1 font-mono">{subline}</div>}
    </div>
  )
}

function Divider() {
  return <div className="w-px h-12 bg-white/10" />
}

function DroneWalletCompact({ balance, addrShort }: { balance: number; addrShort: string }) {
  return (
    <div className="text-center">
      <div className="text-[10px] text-white/40 uppercase tracking-[0.2em] mb-1">Drone Wallet</div>
      <div className="font-mono text-base text-white/70">{addrShort}</div>
      <div className="font-mono text-xl tabular-nums text-white/90 mt-0.5">
        {balance.toFixed(6)}<span className="text-sm text-white/40 ml-1">USDC</span>
        <span className="text-[#f87171] text-sm ml-1.5">↓</span>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] text-white/40 uppercase tracking-widest">{label}</span>
      <span className="font-mono text-base tabular-nums text-white/90">{value}</span>
    </div>
  )
}

/* ─── Payment Flow (centerpiece) ────────────────────────────────────────── */

function ChargingStateBadge({ isCharging }: { isCharging: boolean }) {
  if (isCharging) {
    return (
      <div className="px-3 py-1 rounded-full bg-emerald-400/15 border border-emerald-400/40 flex items-center gap-2">
        <span className="text-emerald-400 text-sm leading-none">⚡</span>
        <span className="text-emerald-400 text-[10px] uppercase tracking-[0.2em] font-medium">Charging</span>
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
      </div>
    )
  }
  return (
    <div className="px-3 py-1 rounded-full bg-white/5 border border-white/15 flex items-center gap-2">
      <span className="text-white/40 text-sm leading-none">○</span>
      <span className="text-white/50 text-[10px] uppercase tracking-[0.2em]">Idle · awaiting drone</span>
    </div>
  )
}

function PaymentFlow({ sliceCount, sliceCountdown, settleCountdown, isCharging }: {
  sliceCount: number; sliceCountdown: number; settleCountdown: number; isCharging: boolean
}) {
  return (
    <div className="w-full h-full max-w-[1500px] grid grid-cols-[240px_1fr_240px] items-center gap-6">
      {/* LEFT: Drone */}
      <DeviceCard
        title="Drone Agent"
        sub="ESP32-C3 · BoAT Machine Economy Runtime on-chip wallet"
        imgPath="/drone-demo/drone.png"
        fallback={<DroneIllustration />}
        tint="#fbbf24"
      />

      {/* CENTER: bidirectional flow */}
      <BidirectionalFlow
        sliceCount={sliceCount}
        sliceCountdown={sliceCountdown}
        settleCountdown={settleCountdown}
        isCharging={isCharging}
      />

      {/* RIGHT: eCandle */}
      <DeviceCard
        title="eCandle"
        sub="Arkreen DePIN · solar + grid"
        imgPath="/drone-demo/ecandle.png"
        fallback={<ECandleIllustration />}
        tint="#60a5fa"
      />
    </div>
  )
}

function DeviceCard({ title, sub, imgPath, fallback, tint }: {
  title: string; sub: string; imgPath: string; fallback: React.ReactNode; tint: string
}) {
  // Default to fallback SVG. Programmatically preload the real photo: only
  // switch to <img> if the preload truly succeeds (naturalWidth > 0).
  // Next.js dev returns missing-asset 404s as HTML pages, which browsers
  // treat as "image loaded" for an <img> tag — onError never fires. So we
  // can't trust the <img>'s own onError. Doing the preload ourselves and
  // checking naturalWidth bypasses the issue.
  const [imgOk, setImgOk] = useState(false)

  useEffect(() => {
    const probe = new window.Image()
    probe.onload = () => {
      if (probe.naturalWidth > 0 && probe.naturalHeight > 0) setImgOk(true)
    }
    probe.onerror = () => setImgOk(false)
    probe.src = imgPath
    return () => {
      probe.onload = null
      probe.onerror = null
    }
  }, [imgPath])

  return (
    <div
      className="rounded-3xl border border-white/10 backdrop-blur p-3 h-full flex flex-col justify-center"
      style={{ background: `${tint}0c`, boxShadow: `0 0 40px ${tint}22` }}
    >
      <div className="aspect-square rounded-2xl bg-white/[0.03] flex items-center justify-center overflow-hidden mb-2 border border-white/5 max-h-[60%]">
        {imgOk ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgPath} alt={title} className="w-full h-full object-cover" />
        ) : (
          fallback
        )}
      </div>
      <div className="text-center">
        <div className="text-lg font-bold" style={{ color: tint }}>{title}</div>
        <div className="text-[10px] text-white/40 mt-0.5">{sub}</div>
      </div>
    </div>
  )
}

function BidirectionalFlow({ sliceCount, sliceCountdown, settleCountdown, isCharging }: {
  sliceCount: number; sliceCountdown: number; settleCountdown: number; isCharging: boolean
}) {
  // Use SVG with <animateMotion> for the moving particles — declarative, no JS state.
  return (
    <div className="relative w-full h-full min-h-[220px] max-h-[400px] flex items-center">
      <svg viewBox="0 0 800 360" className="w-full h-full" preserveAspectRatio="none">
        <defs>
          {/* Top arc path: drone (left) → arc hub → eCandle (right) */}
          <path id="usdc-path" d="M 30 180 Q 400 50 770 180" fill="none" />
          {/* Bottom arc path: eCandle (right) → drone (left) */}
          <path id="kwh-path" d="M 770 180 Q 400 310 30 180" fill="none" />

          {/* Arrow markers */}
          <marker id="arrow-r" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#fbbf24" />
          </marker>
          <marker id="arrow-l" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#60a5fa" />
          </marker>

          <linearGradient id="usdc-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.2" />
            <stop offset="50%" stopColor="#fbbf24" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#fbbf24" stopOpacity="0.2" />
          </linearGradient>
          <linearGradient id="kwh-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.2" />
            <stop offset="50%" stopColor="#60a5fa" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#60a5fa" stopOpacity="0.2" />
          </linearGradient>
        </defs>

        {/* Render visible paths — dim them when idle to reinforce "no flow right now" */}
        <path d="M 30 180 Q 400 50 770 180" fill="none" stroke="url(#usdc-grad)" strokeWidth="2.5" strokeDasharray="5,4" markerEnd="url(#arrow-r)" opacity={isCharging ? 1 : 0.25} />
        <path d="M 770 180 Q 400 310 30 180" fill="none" stroke="url(#kwh-grad)" strokeWidth="2.5" strokeDasharray="5,4" markerEnd="url(#arrow-l)" opacity={isCharging ? 1 : 0.25} />

        {/* Animated dots only render when charging — when idle the paths sit static */}
        {isCharging && [0, 1.2, 2.4, 3.6].map((delay, i) => (
          <g key={`usdc-${i}`}>
            <circle r="6" fill="#fbbf24" opacity="0.9">
              <animateMotion dur="4.8s" begin={`${delay}s`} repeatCount="indefinite" rotate="auto">
                <mpath href="#usdc-path" />
              </animateMotion>
              <animate attributeName="opacity" values="0;1;1;0" dur="4.8s" begin={`${delay}s`} repeatCount="indefinite" />
            </circle>
          </g>
        ))}

        {isCharging && [0, 1.0, 2.0, 3.0, 4.0].map((delay, i) => (
          <g key={`kwh-${i}`}>
            <circle r="5" fill="#60a5fa" opacity="0.9">
              <animateMotion dur="5s" begin={`${delay}s`} repeatCount="indefinite" rotate="auto">
                <mpath href="#kwh-path" />
              </animateMotion>
              <animate attributeName="opacity" values="0;1;1;0" dur="5s" begin={`${delay}s`} repeatCount="indefinite" />
            </circle>
          </g>
        ))}

        {/* Arc hub badge sitting on the apex of USDC arc */}
        <g transform="translate(400, 50)">
          <circle r="34" fill="#1a1330" stroke="#a78bfa" strokeWidth="2" />
          <text x="0" y="-3" textAnchor="middle" fontSize="11" fill="#a78bfa" fontWeight="bold" letterSpacing="1">ARC</text>
          <text x="0" y="11" textAnchor="middle" fontSize="9" fill="#ffffffaa">TESTNET</text>
        </g>

        {/* Labels along arcs */}
        <text x="400" y="105" textAnchor="middle" fontSize="11" fill="#fbbf24" letterSpacing="2" fontWeight="500">
          USDC ↑ NANOPAYMENT  ·  EIP-3009 SIGNED ON-CHIP
        </text>
        <text x="400" y="280" textAnchor="middle" fontSize="11" fill="#60a5fa" letterSpacing="2" fontWeight="500">
          kWh ↓ ELECTRICITY  ·  120 W AC DELIVERY
        </text>
      </svg>

      {/* Pacing readout under SVG */}
      <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-6 text-[10px] font-mono text-white/40">
        <div><span className="text-[#fbbf24]">slice #{sliceCount + 1}</span> in {sliceCountdown}s</div>
        <div className="w-1 h-1 rounded-full bg-white/20" />
        <div><span className="text-emerald-400">next on-chain settle</span> in {settleCountdown}s</div>
      </div>
    </div>
  )
}

/* ─── SVG fallbacks (rendered when /public/drone-demo/*.png is missing) ─── */

function DroneIllustration() {
  return (
    <svg viewBox="0 0 200 200" className="w-3/4 h-3/4">
      {/* simple quadcopter top-down */}
      <g fill="#fbbf24aa" stroke="#fbbf24" strokeWidth="2">
        {/* arms */}
        <line x1="100" y1="100" x2="40" y2="40" />
        <line x1="100" y1="100" x2="160" y2="40" />
        <line x1="100" y1="100" x2="40" y2="160" />
        <line x1="100" y1="100" x2="160" y2="160" />
        {/* rotors */}
        <circle cx="40" cy="40" r="22" fill="#fbbf24" opacity="0.4">
          <animate attributeName="r" values="22;24;22" dur="0.5s" repeatCount="indefinite" />
        </circle>
        <circle cx="160" cy="40" r="22" fill="#fbbf24" opacity="0.4">
          <animate attributeName="r" values="22;24;22" dur="0.55s" repeatCount="indefinite" />
        </circle>
        <circle cx="40" cy="160" r="22" fill="#fbbf24" opacity="0.4">
          <animate attributeName="r" values="22;24;22" dur="0.45s" repeatCount="indefinite" />
        </circle>
        <circle cx="160" cy="160" r="22" fill="#fbbf24" opacity="0.4">
          <animate attributeName="r" values="22;24;22" dur="0.5s" repeatCount="indefinite" />
        </circle>
        {/* body */}
        <rect x="78" y="78" width="44" height="44" rx="6" fill="#1a1330" stroke="#fbbf24" strokeWidth="2" />
        <circle cx="100" cy="100" r="6" fill="#fbbf24" />
      </g>
      <text x="100" y="190" textAnchor="middle" fontSize="9" fill="#fbbf2466" fontFamily="monospace">FALLBACK — drop drone.png</text>
    </svg>
  )
}

function ECandleIllustration() {
  return (
    <svg viewBox="0 0 200 200" className="w-3/4 h-3/4">
      {/* eCandle yellow box product silhouette */}
      <g>
        {/* handle */}
        <rect x="80" y="32" width="40" height="8" rx="3" fill="none" stroke="#60a5fa" strokeWidth="2" />
        {/* body — rounded rect matching eCandle 1 product */}
        <rect x="38" y="48" width="124" height="118" rx="14" fill="#1a1330" stroke="#60a5fa" strokeWidth="2.5" />
        {/* display panel */}
        <rect x="56" y="68" width="88" height="34" rx="4" fill="#60a5fa22" stroke="#60a5fa" strokeWidth="1" />
        <text x="100" y="89" textAnchor="middle" fontSize="11" fill="#60a5fa" fontFamily="monospace">100%</text>
        {/* USB ports */}
        <rect x="58" y="118" width="20" height="6" rx="2" fill="#60a5fa66" />
        <rect x="90" y="118" width="20" height="6" rx="2" fill="#60a5fa66" />
        <rect x="122" y="118" width="20" height="6" rx="2" fill="#60a5fa66" />
        {/* AC outlet */}
        <circle cx="100" cy="146" r="10" fill="none" stroke="#60a5fa" strokeWidth="1.5" />
        <circle cx="96" cy="146" r="1.5" fill="#60a5fa" />
        <circle cx="104" cy="146" r="1.5" fill="#60a5fa" />
      </g>
      <text x="100" y="190" textAnchor="middle" fontSize="9" fill="#60a5fa66" fontFamily="monospace">FALLBACK — drop ecandle.png</text>
    </svg>
  )
}
