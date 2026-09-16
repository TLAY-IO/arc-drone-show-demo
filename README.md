# arc-drone-show-demo

> **Built by [TLAY](https://tlay.io) in collaboration with Circle, Arc, and Arkreen.**

A reference integration showing **BLE-native machine-economy nanopayments** — an eCandle ESP32 (energy seller) and a drone-agent ESP32 (energy buyer) negotiating, signing, and settling per-slice payments over BLE, then batched into Circle Gateway credit on Arc — and, via the optional Path A, minted on-chain on demand.

This repository is the SF Drone Show 2026 companion. **It is a showcase. The reusable building blocks live upstream:**

| Component | Repository | Role |
|-----------|-----------|------|
| **BoAT MER** (Machine Economy Runtime) | [TLAY-IO/boat-mer](https://github.com/TLAY-IO/boat-mer) | End-side runtime + 0xEE00 BLE protocol + seller/buyer engines |
| **HashAnchor** client SDK | [TLAY-IO/hashanchor](https://github.com/TLAY-IO/hashanchor) | Settle bridge client (JS/TS) |
| **This demo** | TLAY-IO/arc-drone-show-demo | ESP32 integration + cloud reference + visualization |

If you want to build your own machine-economy app on different hardware or with a different load, start at [TLAY-IO/boat-mer](https://github.com/TLAY-IO/boat-mer) and use this repo as an integration example. See [`docs/what-next.md`](docs/what-next.md).

---

## Networks

This demo runs on **Arc**. Two chains are supported:

- **Arc Mainnet** — the production chain. Point the cloud env here when you
  are ready to settle with real funds.
- **Arc Testnet** — the development and evaluation chain, so you can iterate
  without spending real funds. **New here? Start on testnet**, then move to
  mainnet with the configuration change below.

**Switching between testnet and mainnet touches three places — and the seller
is not one of them:**

| Component | What changes for mainnet |
|---|---|
| **eCandle seller firmware** | **Nothing. No rebuild.** The seller never touches chain parameters — it forwards buyer-signed authorizations verbatim (Path B) and blind-signs a cloud-computed 32-byte digest (Path A). The EIP-712 domain lives entirely off-device. Chain-agnostic by construction. |
| **drone buyer firmware** | At most **4 CMake values**, no source edits: `-DDRONE_CHAIN_ID=…`, `-DDRONE_GATEWAY_CONTRACT_HEX=…`, and (if the domain differs) `-DDRONE_EIP712_DOMAIN_NAME=…` / `-DDRONE_EIP712_DOMAIN_VERSION=…`. **Use a separate build directory per chain** (`idf.py -B build-mainnet …`) — the CMake cache will otherwise silently carry the wrong chain into the next build. |
| **cloud** | Environment variables, no code changes: chain id, RPC URL, explorer, Circle transfer endpoint, Gateway/USDC/Minter contract addresses, and the EIP-712 domain `name`/`version`. The demo page derives the chain name it displays from `NEXT_PUBLIC_ARC_EXPLORER`, so the label and the links cannot disagree. All default to testnet; see `cloud/.env.example`. |

> **Take each chain's Gateway/USDC/Minter addresses and the three EIP-712
> domain fields** (`verifyingContract`, `name`, `version`) **from Circle's
> official contract-address reference.** A wrong domain makes every signature
> fail to recover, and the failure looks like a signing bug, not a
> configuration one — so use the published values, and use a **separate build
> directory per chain** (the CMake cache will otherwise silently carry the
> wrong chain into the next build).

## Quickstart (~30–45 minutes)

**This Quickstart runs on Arc Testnet** — the development default, so you spend
no real funds. For production see [Networks](#networks) and
[Going to production](#going-to-production).

> **Prerequisite — funding.** Before any settle succeeds you must fund the
> drone's Circle Gateway balance (get testnet USDC from the faucet, then
> `depositFor`). That step plus flashing two boards is why this takes ~30–45
> minutes, not 5 — the commands below are only the cloud + flash steps. See
> [Step 3 of the full walkthrough](docs/reproduce.md) for the funding commands.

```bash
# 1. Clone
git clone https://github.com/TLAY-IO/arc-drone-show-demo
cd arc-drone-show-demo

# 2. Start the cloud side (MQTT broker + demo visualization + settle worker).
#    The broker REQUIRES auth: generate credentials once, then set the matching
#    MQTT_URL_WEB / MQTT_URL_WORKER in .env. (No API key for the public settle
#    endpoint. See docs/reproduce.md Step 2 for details.)
cd cloud
./mosquitto/gen-passwd.sh   # writes mosquitto/passwd (users: device, worker, web)
#    ^ prints randomly generated passwords — copy them into .env below.
#    Also set MQTT_BIND_IP in .env to this host's LAN address: the eCandle
#    board is a separate device and cannot reach the host's loopback. Without
#    it the broker stays on 127.0.0.1, which is right for cloud-only testing
#    but means no seller board can connect. Bind only to a LAN you control.
cp .env.example .env        # then set MQTT_URL_WEB / MQTT_URL_WORKER to match
docker compose up

# 3. Flash two ESP32 dev boards (in two separate terminals). The seller must
#    authenticate to the broker: set its broker URI to the "device" credentials
#    + your broker's LAN host via `idf.py menuconfig` (see docs/reproduce.md Step 4).
cd ../apps/ecandle
idf.py menuconfig                      # eCandle demo seller → MQTT broker URI
idf.py -p /dev/ttyUSB0 flash monitor   # seller-side (synthetic AC output)

cd ../drone
idf.py -p /dev/ttyUSB1 flash monitor   # buyer-side (drone-agent)

# 4. Open the demo visualization
open 'http://localhost:3000/demo?live=1'
```

See [`docs/reproduce.md`](docs/reproduce.md) for the full walkthrough including
Arc Testnet faucet, Circle Gateway deposit, EIP-712 trap, and known limitations.

## Going to production

Once the testnet flow works, moving to Arc Mainnet is a configuration change,
not a rewrite — walk the three components from the [Networks](#networks) table:

1. **Seller firmware** — do nothing. The board you flashed for testnet is
   already mainnet-ready; it holds no chain parameters.
2. **Buyer firmware** — rebuild into a fresh directory with the mainnet CMake
   values (see Networks). Confirm the boot log prints the mainnet chain id and
   the same EOA (flashing does not touch the NVS key, so the wallet — and any
   Gateway deposit tied to it — survives; never pass `--erase-all`).
3. **Cloud** — copy `cloud/.env.example` to `.env`, fill in the mainnet chain
   profile, Gateway/USDC addresses, and the EIP-712 domain from Circle's
   official reference, then restart the workers.
4. **Fund on mainnet** — deposit USDC into Circle Gateway for the buyer EOA
   before running. Real funds; start small.

Every mainnet contract address and EIP-712 domain value comes from Circle's
published reference — this repo does not hardcode them for mainnet.

## Operations checklist (read before running long sessions)

`cloud/burn-intent-worker` and `cloud/settle-worker` are long-lived MQTT
subscribers. Each forwards traffic to Circle on every settle batch or mint
trigger. If two instances of the same worker are alive at the same time, both
will independently forward the same payload — Circle will idempotently reject
the duplicates (`nonce_already_used`), but the symptoms look like real failures
and can mask other bugs. Worse, if both workers fire a mint job, the operator
wallet may broadcast two transactions with the same nonce, of which only one
mines on-chain; the second errors with `REPLACEMENT_UNDERPRICED`.

Both workers ship with a `single-instance-guard` (pidfile in
`$TMPDIR/arc-drone-show-demo-locks/<worker>.pid` + signal-0 liveness check +
exit-handler cleanup). A second invocation refuses to start with a clear
error message. You don't need to do anything special — just *don't* run the
workers via `nohup node index.js &` from multiple shells and expect `pkill -f`
to clean up between sessions; that pattern is not reliable.

Recommended startup pattern. The **settle-worker** is the default path (Path B,
per-slice settlement — what the demo runs). The **burn-intent-worker** is only
for Path A ("Mint to Arc") and should be started *only* when you intend to mint:

```bash
# Inspect: is anything already running?
ps aux | grep "node.*index.js" | grep -v grep

# Default (Path B settlement) — settle-worker only:
cd cloud/settle-worker && node index.js &

# Optional (Path A / Mint) — start this ONLY when you intend to mint:
cd cloud/burn-intent-worker && node index.js &
```

Or use Docker (recommended): `docker compose up` starts the default stack
(broker + viz + **settle-worker only**). To also run Path A, add the profile:
`docker compose --profile mint up` starts the burn-intent-worker as well.
Compose manages process lifecycle; the guard is belt-and-suspenders even inside
containers.

If you see `[single-instance-guard] another <worker> is already running`,
either kill the holder by PID and retry, or just trust the guard — it means
your previous instance survived. Tail the existing instance's logs instead.

## Architecture

```
                  BLE 0xEE00 streaming
                    (slice request)
              ┌──────────────▶┐
┌──────────┐  │               ▼ ┌──────────┐
│  eCandle │◀─┘   signed       │  drone   │
│  seller  │   slice proof ────│  buyer   │
│  ESP32   │   (back to seller)│  ESP32   │
│  (boat-  │                   │  (boat-  │
│   mer)   │   ★ drone is      │   mer)   │
│          │     BLE-only —    └──────────┘
│  WiFi +  │     no WiFi
│  MQTT    │
└────┬─────┘
     │   MQTT publish (seller publishes its own telemetry
     │   AND the drone's signed slice proofs, batched)
     ▼
  ┌─────────────────────────────────┐
  │  cloud/ (this repo)             │
  │   - Mosquitto broker            │
  │   - Next.js demo viz (SSE)      │
  │   - settle-worker (forward batch)│
  └─────────────┬───────────────────┘
                │
                │ @tlay/hashanchor-client
                ▼
  ┌─────────────────────────────────┐
  │  HashAnchor public endpoint     │
  └─────────────┬───────────────────┘
                │ Circle Gateway batched x402
                ▼
  ┌─────────────────────────────────┐
  │  Arc (settlement — testnet/mainnet)│
  └─────────────────────────────────┘
```

See [`docs/architecture.md`](docs/architecture.md) for the layered view including BoAT MER's 5-tier runtime.

## What's NOT here

| | Why |
|--|--|
| Real eCandle hardware (Arkreen DePIN device) | Not available to typical developers. We replace it with an ESP32 dev board emitting **synthetic AC output**. See [`docs/hardware-partner-arkreen.md`](docs/hardware-partner-arkreen.md). |
| Arkreen's inverter interface protocol | Proprietary to the hardware vendor (Arkreen). The synthetic AC output in `apps/ecandle` mimics the data shape without using the real protocol. |
| HashAnchor server source | Closed source. We use `@tlay/hashanchor-client` to talk to the hosted service's public `/v1/x402/settle` endpoint (no API key needed for settle). |
| Production secrets / mainnet keys | Not in the repo. Mainnet identities and keys come from your own environment (see [Networks](#networks)); nothing chain-specific for mainnet is committed here. |

## License

MIT. See [LICENSE](LICENSE). Upstream dependencies under their own licenses (Apache-2.0 for boat-mer + hashanchor SDK, EPL/EDL for Mosquitto, etc.). See [NOTICE](NOTICE).

## Status

`v1.0.0` is the first public snapshot. See the
[Releases page](https://github.com/TLAY-IO/arc-drone-show-demo/releases).

**Built by [TLAY](https://tlay.io) in collaboration with Circle, Arc, and Arkreen.**
