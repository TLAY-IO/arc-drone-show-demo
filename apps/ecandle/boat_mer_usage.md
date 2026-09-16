<!-- SPDX-License-Identifier: MIT -->

# How `apps/ecandle` uses BoAT MER

The eCandle reference **seller** is a thin MIT integration on top of the
Apache-2.0 BoAT MER runtime (pulled via Component Manager, never vendored — see
the repo `NOTICE`). It shows what a real machine-economy seller wires up.

## MER tiers used

| Tier | Used for | Call |
|------|----------|------|
| **crypto / identity** | device EOA = the seller's receiver wallet (the address the buyer signs payments TO) | `boat_crypto_init(&kp)` → `boat_seller_set_receiver_wallet(kp.eth_address)` |
| **attest** | sign each (synthetic) power reading — "this kWh came from this machine" | `boat_attest_create(&kp, payload_json, &att)` |
| **protocols/seller** | the 0xEE00 BLE seller engine (offer / per-slice billing / self-drive / liveness) | `boat_seller_register()` + `boat_seller_init(&cfg)` |
| **nano / pay / x402** | used *indirectly* — the buyer signs EIP-3009 via these; the seller only forwards the proof to settlement | proof → `boat_seller_set_slice_proof_cb()` |

Policy (rate / slice cadence / cap / power band / USDC token / adv price) is
injected through `boat_seller_config_t` — the library bakes in none of it.

## ⚠️ Honesty: the demo bills SYNTHETIC power

A real eCandle reads its inverter over a **proprietary Arkreen protocol that is
NOT in this repo** (hardware-vendor IP — see `docs/hardware-partner-arkreen.md`).
To keep the demo reproducible on a bare ESP32-C3 with no inverter attached,
`main.c` runs a **synthetic AC-power source** (`synthetic_power_task`) that drives
a charge-like profile.

Consequently the **attest tier here witnesses synthetic readings** — the
attestation payload is explicitly marked `"synthetic": true`. This demonstrates
the *mechanism* (the device signs what it metered), not a live physical meter. In
a production eCandle the same `boat_attest_create` call signs real inverter data.

## Settle uplink

The seller joins WiFi (creds via `idf.py menuconfig` → "eCandle demo seller") for
two things: **SNTP** (valid absolute slice timestamps the buyer signs) and an
**MQTT** publish of the buyer's signed proofs. `on_slice_proof` batches the
**verbatim** 0xEE04 proof JSON (never reshaped — the EIP-712 signature covers the
authorization field values) and publishes, per `batch_size` or a 30 s flush:

```
topic    ecandle/<id>/settle
payload  {"sid":N,"batch_idx":M,"network":"eip155:5042002","proofs":[<verbatim 0xEE04>...]}
```

`cloud/settle-worker` subscribes and hands it to `@tlay/hashanchor-client.settle()`,
which does the flat→nested transform (value/nonce via BigInt, x402Version:2, …) and
POSTs Circle Gateway. The device/seller never reshapes the signed proof.

## What is NOT here

- No inverter/BMS driver, no Arkreen protocol (vendor IP) — power is synthetic.
- No on-device signature verification — the seller is a metered oracle; the proof
  sink (`cloud/settle-worker` via `@tlay/hashanchor-client`) does settlement.
- No OTA / product control stack — this is the demo seller, not the product.

## Build

```bash
idf.py set-target esp32c3
idf.py build          # Component Manager fetches boat-mer @ the pinned tag
idf.py flash monitor
```

Requires `TLAY-IO/boat-mer` to be reachable at the tag pinned in
`main/idf_component.yml` (published 2026-08-11). See the repo README quickstart.
