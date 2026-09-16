<!-- SPDX-License-Identifier: MIT -->

# apps/ecandle — seller-side ESP32 integration

This app runs on an ESP32-C3 dev board as the **eCandle seller** in the SF Drone
Show nanopayment demo. It's MIT integration glue on top of the Apache-2.0 BoAT
MER runtime (pulled via Component Manager, never vendored). See
[`boat_mer_usage.md`](boat_mer_usage.md) for the tier-by-tier breakdown.

Instead of reading real AC output from an Arkreen inverter, it **synthesizes** a
power value so the demo is reproducible on a bare board with no inverter.

## What it does

- NimBLE peripheral; **advertises** the IDLE-gate handshake (`mfg_data[5]=0` =
  IDLE when no buyer is connected; name in the scan response to stay under 31 B)
- Registers the 0xEE00 seller GATT family from `protocols/seller`
  (`boat_seller_register` + `boat_seller_init`)
- Publishes the synthetic AC output over 0xEE05 (proto_ver=2) so the buyer can
  self-drive the stream; bills per slice from `boat_seller_config_t`
- **MER identity**: on-chip secp256k1 EOA → the seller's receiver wallet
- **MER attest**: Ed25519-signs each (synthetic) power reading
- **WiFi + SNTP** for valid absolute slice timestamps; **MQTT** publishes each
  buyer proof (batched, verbatim) to `ecandle/<id>/settle` → cloud settle-worker
  → HashAnchor. Telemetry events → console + `ecandle/<id>/nanopay`.
  WiFi/MQTT creds via `idf.py menuconfig` → "eCandle demo seller".

## Synthetic power profile

`synthetic_power_task` runs a self-driving charge-like profile (no interaction
needed): ramp 0→120 W over 4 s → hold 120 W for 60 s → drop to 0 for 45 s →
repeat. This exercises the buyer's self-drive loop end to end: power > 5 W →
buyer opens the stream and signs slices; power < 5 W → buyer self-stops.

> The off phase must outlast the buyer's self-stop hysteresis, which counts
> **6 successful 0xEE05 reads**, not 30 seconds of wall clock — a failed or
> short read does not advance the count. 30 s is therefore a lower bound, not
> a value; 45 s (9 nominal ticks) leaves room for dropped reads. Shortening it
> to ~30 s can leave the session open and the demo never shows a stop/restart.

> Interactive override (a UART `set_power_w` console command) is a planned
> enhancement; this build uses the scripted profile above.

## Build

```bash
cd apps/ecandle
idf.py set-target esp32c3
idf.py build          # Component Manager fetches TLAY-IO/boat-mer @ the pinned tag
idf.py -p /dev/ttyUSB0 flash monitor
```

The pinned tag is in [`main/idf_component.yml`](main/idf_component.yml)
(`v1.0.1`); boat-mer is public, so the Component Manager fetches it directly.

## Honest disclosure

This seller witnesses **synthetic** AC output. The MER attestation is real in
cryptographic terms (the device signs what it metered) but the measurement is
firmware-generated, not from a real inverter. A production eCandle uses Arkreen's
vendor-private inverter protocol (not in this repo —
[../../docs/hardware-partner-arkreen.md](../../docs/hardware-partner-arkreen.md)).
