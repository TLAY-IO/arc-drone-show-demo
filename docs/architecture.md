# Architecture

This document is the layered view of the demo. For the *protocol* spec (0xEE00 wire,
struct layouts, BLE timing), see upstream
[TLAY-IO/boat-mer/docs/ble-protocol.md](https://github.com/TLAY-IO/boat-mer/blob/main/docs/ble-protocol.md).

## Three layers

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 3 — On-chain settlement                                      │
│                                                                     │
│    Arc mainnet / testnet ◀── Circle Gateway batched x402 ◀──        │
│                                                                     │
│  TLAY does not implement this layer; we are a customer of Circle.   │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTPS, batched proofs
                              │
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 2 — Cloud reference (this repo, MIT)                         │
│                                                                     │
│   ┌──────────────┐    ┌──────────────┐    ┌─────────────────────┐   │
│   │  Mosquitto   │───▶│ settle-worker│───▶│ HashAnchor          │   │
│   │  MQTT broker │    │ forward batch │    │ public settle       │   │
│   └──────────────┘    └──────────────┘    │ endpoint (no key)   │   │
│                                            └─────────────────────┘   │
│         ▲                                                           │
│         │ MQTT publish                                              │
│         │                                                           │
│   ┌──────────────┐                                                  │
│   │  Next.js     │  SSE  ▶  http://localhost:3000/demo?live=1       │
│   │   /demo viz  │                                                  │
│   └──────────────┘                                                  │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ MQTT pub — ONLY from the seller side
                              │ (drone is BLE-only; its signed proofs
                              │  travel back to the seller over 0xEE04
                              │  and the seller batches+publishes them)
                              │
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1 — Two ESP32 devices                                        │
│                                                                     │
│   ┌──────────────────┐         BLE 0xEE00         ┌───────────────┐ │
│   │  apps/ecandle    │  ───── slice_req ────────▶ │  apps/drone   │ │
│   │  (seller)        │  ◀── signed slice proof ── │  (buyer)      │ │
│   │                  │      (0xEE04 write)        │               │ │
│   │  WiFi + MQTT     │                            │  BLE-ONLY     │ │
│   │                  │                            │  (no WiFi)    │ │
│   │  uses boat-mer:  │                            │  uses boat-mer│ │
│   │  - identity      │                            │  - identity   │ │
│   │  - attest        │                            │  - pay        │ │
│   │  - protocols/    │                            │  - x402       │ │
│   │    seller        │                            │  - protocols/ │ │
│   │  - synth AC out  │                            │    buyer      │ │
│   │  ★ publishes its │                            │               │ │
│   │   own telemetry  │                            │               │ │
│   │   AND drone-     │                            │               │ │
│   │   signed batches │                            │               │ │
│   │   to MQTT        │                            │               │ │
│   └──────────────────┘                            └───────────────┘ │
│                                                                     │
│   ★ Both devices fetch boat-mer at v1.0.1 via ESP-IDF               │
│     Component Manager. boat-mer source is NOT vendored here.        │
└─────────────────────────────────────────────────────────────────────┘
```

### Why the drone does not publish MQTT directly

The drone is intentionally **BLE-only**: no WiFi stack, no MQTT client. This
keeps the buyer-side hardware minimal (no provisioning, no captive portal,
no credentials) and ensures the signed slice proof lives entirely on the
device until it's handed to the seller over BLE characteristic 0xEE04.
The seller is the WAN gateway for both sides:

- The seller publishes its own telemetry (`ecandle/<MAC>/status`).
- The seller publishes the drone's signed slice proofs as a settle batch
  (`ecandle/<MAC>/settle`).
- The cloud `settle-worker` subscribes to `ecandle/+/settle`, forwards
  each batch to HashAnchor.

This means the demo works on any BLE-capable buyer regardless of network
connectivity — useful for portable / battery-powered loads.

## Repo dependency graph

```
                                  ┌─────────────────────────────┐
                                  │  TLAY-IO/boat-mer           │
                                  │  Apache-2.0 (runtime + SDK) │
                                  │                             │
              ┌──────── idf_component.yml pin v1.0.1 ──────────▶│
              │                   │  - sdk/                     │
              │                   │  - protocols/seller         │
┌─────────────┴───────┐           │  - protocols/buyer          │
│  this repo (MIT)    │           │  - include/boat_nano_wire.h │
│  apps/ecandle       │           └─────────────────────────────┘
│  apps/drone         │
│  cloud/             │           ┌─────────────────────────────┐
│  docs/              │           │  TLAY-IO/hashanchor         │
│                     │           │  Apache-2.0 (client SDK)    │
│  settle-worker  ────┼─ npm ────▶│  @tlay/hashanchor-client    │
└─────────────────────┘           └─────────────────────────────┘

  ★ License boundary: this repo never vendors source from the Apache repos.
    Component Manager fetches into managed_components/ (gitignored, build-time only).
    npm install fetches into node_modules/ (gitignored, build-time only).
    The two licenses coexist legally because deps are not embedded.
```

## What lives where

| Concern | Lives in | Why |
|---------|----------|-----|
| 0xEE00 BLE wire spec | `boat-mer/include/boat_nano_wire.h` | Single source of truth, shared by seller and buyer |
| Seller protocol engine (GATT server + slice math) | `boat-mer/protocols/seller/` | Reusable across hardware platforms |
| Buyer protocol engine (GATT client + slice signing + power self-drive) | `boat-mer/protocols/buyer/` | Reusable across BLE stacks (uses thin vtable) |
| eCandle-on-ESP32 integration (NimBLE wiring, sdkconfig, tuned params, synth AC) | `apps/ecandle/` (this repo) | Demo-specific, MIT |
| drone-on-ESP32 integration (NimBLE inject, tuned 5W/hysteresis/6s supervision) | `apps/drone/` (this repo) | Demo-specific, MIT |
| Demo visualization | `cloud/web/` (this repo) | Showcase, MIT |
| Mosquitto + docker-compose | `cloud/` (this repo) | Reference deployment, MIT |
| settle-worker (MQTT → batch → POST) | `cloud/settle-worker/` (this repo) | Reference, uses `@tlay/hashanchor-client` |
| HashAnchor server / on-chain verify | NOT in any public repo | Closed-source commercial service |
| Real eCandle BMS / inverter driver | NOT in any public repo | Arkreen hardware vendor IP |

## A-prime self-drive contract (live since 2026-06-12)

The buyer (`apps/drone`) reads the seller's BLE characteristic `0xEE05` (`boat_nano_stream_status_t`)
to learn the seller's current AC output. Based on that single signal, the buyer decides whether to
open or close a streaming session — no cloud orchestration involved in the slice path.

```
0xEE05 boat_nano_stream_status_t {
  proto_ver           // ≥ 2 means A-prime contract supported
  streaming           // seller-asserted: am I currently streaming a session?
  ac_output_dw        // 0.1 W units — current AC output
  heartbeat           // monotonic counter; advances every tick on seller
  session_id          // 0 when idle
  ...
}
```

Buyer logic:

```
if (status.ac_output_dw / 10 >= power_start_threshold_w) {
    write 0xEE01 = 0x02   // open streaming
} else if (status.ac_output_dw / 10 < power_stop_threshold_w for sustained_ticks) {
    write 0xEE01 = 0x00   // close streaming
}
```

This is the contract that lets us run the demo with **zero cloud in the slice loop**.
Cloud is observer + settle batch forwarder, not session orchestrator.

See upstream `boat-mer/docs/writing-a-buyer-app.md` for the full lifecycle including IDLE-gate
handshake, self-heal watchdog, and EIP-3009 signing flow.
