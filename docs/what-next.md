# What's next — build your own machine-economy app

You ran this demo. Now what?

This repository is one specific integration of two upstream products:

- **[TLAY-IO/boat-mer](https://github.com/TLAY-IO/boat-mer)** — the reusable runtime (5 tiers) + reusable seller/buyer protocol libraries
- **[TLAY-IO/hashanchor](https://github.com/TLAY-IO/hashanchor)** — the settle-bridge client SDK

If you want to build your own machine-economy app (with different hardware,
different loads, or a different settle target), you don't need to fork this
demo. You want the upstream libraries.

## Three directions you can go

### 1. Different load on the buyer side (same BLE protocol)

The drone in this demo is a charging load. You could replace it with:

- A **bandwidth router** that pays per MB
- A **3D printer** that pays per gram of filament dispensed
- A **vacuum robot** that pays per square meter cleaned
- A **smart appliance** that pays per energy consumed (mirror of this demo)

In all cases the buyer logic is the same: read the seller's offer over BLE,
sign an EIP-3009 slice, write to 0xEE04. Replace the *load* (which is the
thing setting `power_start_threshold_w` and `power_stop_threshold_w` in
your config), not the protocol.

See [TLAY-IO/boat-mer/docs/writing-a-buyer-app.md](https://github.com/TLAY-IO/boat-mer/blob/main/docs/writing-a-buyer-app.md).

### 2. Different seller (different physical resource)

The eCandle in this demo sells electricity. You could replace it with:

- A **water dispenser** selling water-by-the-liter
- A **gas pump** selling fuel
- A **time-share access point** selling minutes of compute / studio time
- A **wifi hotspot** selling MBs

In all cases the seller logic is the same: broadcast IDLE on BLE adv,
accept buyer connection, stream slice requests, count the buyer's signed
proofs. Replace the *meter* (the thing reporting `ac_output_dw` in your
config), not the protocol.

See [TLAY-IO/boat-mer/protocols/seller/README.md](https://github.com/TLAY-IO/boat-mer/blob/main/protocols/seller/README.md)
and the reference implementation `protocols/seller/boat_seller_nanopay.c`.

### 3. Different MCU (port BoAT MER beyond ESP32)

BoAT MER's 5 tiers are not ESP32-specific. The runtime is C with thin
porting layers. We've targeted ESP32 (NimBLE) in this demo, but the runtime
can be ported to:

- STM32 (any BLE stack)
- nRF52 (Nordic SoftDevice)
- Raspberry Pi / Linux (BlueZ)
- Even a desktop computer (for testing)

The minimum porting closure is documented in
[TLAY-IO/boat-mer/docs/DEVELOPER_GUIDE.md](https://github.com/TLAY-IO/boat-mer/blob/main/docs/DEVELOPER_GUIDE.md).

## Where to settle (cloud side)

This demo uses HashAnchor's public `/v1/x402/settle` endpoint for testnet settle. For
production deployments, contact TLAY for managed-service tiers or self-host
your own settle bridge using the open-source `@tlay/hashanchor-client` SDK
against your own Circle Gateway / x402 facilitator.

See [TLAY-IO/hashanchor/docs/getting-started.md](https://github.com/TLAY-IO/hashanchor/blob/main/docs/getting-started.md)
and [api-reference.md](https://github.com/TLAY-IO/hashanchor/blob/main/docs/api-reference.md).

## Community

- GitHub Discussions (TLAY-IO/boat-mer): roadmap, porting questions, RFC for new tiers
- Issues on this demo repo: integration bugs, docs improvements, "I built X — here's my fork"

We'd love to see what you build. If you publish a fork or extension, let us
know — we'll feature noteworthy ones in this README.

— TLAY
