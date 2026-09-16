# Reproducing the SF Drone Show 2026 nanopayment demo

This walkthrough takes you from a clean machine to a running demo in about 30 minutes
(5 minutes if you've done it before).

## What you need

- Two ESP32 dev boards (any variant with NimBLE BT 5.0). Recommended: ESP32-C3 / ESP32-S3.
- macOS, Linux, or Windows with WSL2 + Docker
- ESP-IDF v5.5.1 or newer
- ~0.1 USDC on Arc Testnet (faucet provided below)

The default `HASHANCHOR_SETTLE_URL` points at HashAnchor's public settle
endpoint — no API key required. Devices select the chain by signing
Arc Testnet payloads, so settlement naturally routes to testnet only.

## Step 1 — Clone and configure cloud

> **Paths in this walkthrough are relative to the repository root.** Each step
> starts there; `cd` back after any step that moves you.

```bash
git clone https://github.com/TLAY-IO/arc-drone-show-demo
cd arc-drone-show-demo
cp cloud/.env.example cloud/.env
```

The Arc and HashAnchor defaults work as-is — `HASHANCHOR_SETTLE_URL` points at
the public settle endpoint, which requires no API key.

**Two values you must fill in, in Step 2:** `MQTT_URL_WEB` and
`MQTT_URL_WORKER` ship empty on purpose. Compose exits with an error naming
the fix while they are unset, rather than starting on a password this repo
publishes. A third, `MQTT_BIND_IP`, is needed only once you run the seller
board — also Step 2.

Everything else is optional (e.g. Basic Auth for the visualization page):

```
DRONE_DEMO_AUTH_USER=demo                # optional Basic Auth for /demo viz
DRONE_DEMO_AUTH_PASS=                    # leave empty to disable auth
```

## Step 2 — Start cloud

The broker requires authentication — an open broker would let anyone on the LAN
obtain seller signatures over attacker-chosen digests. Generate the broker
credentials once before the first start, then set `MQTT_URL_WEB` /
`MQTT_URL_WORKER` in `.env` to match:

```bash
cd cloud
./mosquitto/gen-passwd.sh          # writes mosquitto/passwd (users: device, worker, web)
#   ^ prints random passwords. Paste the two MQTT_URL_* lines it shows into
#     cloud/.env, and keep the device password for Step 4 (firmware).
#     They are shown once — the passwd file stores only hashes.

#   Running the eCandle board? The board is a separate device and cannot reach
#   this host's loopback, so add its LAN address to cloud/.env as well, and use
#   the same address in the firmware broker URI in Step 4:
#       MQTT_BIND_IP=192.0.2.10        # <- this host's LAN IP
#   Leave it unset for cloud-only testing; the broker then stays on loopback.
#   Only ever bind it to a LAN you control.

docker compose up
```

This brings up:

- Mosquitto (authenticated) on `mqtt://${MQTT_BIND_IP}:1883` — `localhost` when
  `MQTT_BIND_IP` is unset
- Next.js demo viz on `http://localhost:3000/demo?live=1`
- settle-worker subscribed to MQTT, forwarding batches to HashAnchor's public settle endpoint

Verify by opening `http://localhost:3000/demo?live=1`. In live mode the panels
render with no slice or settlement rows yet — the page is waiting on the broker.

> **`?live=1` is not optional.** Without it the page runs simulation cycles on
> mock data and animates on its own, which looks like a working system before
> you have flashed a single board.

## Step 3 — Fund the drone's Gateway balance on Arc Testnet

The drone's EOA is generated on first boot — get its address from the serial log
the first time you flash. The drone needs **nothing on-chain**: it is BLE-only,
signs its EIP-3009 authorizations offline, and spends from a Circle Gateway
balance, never from an on-chain wallet. So you fund a **wallet you control** and
have it deposit *on the drone's behalf* — the on-chip key never leaves the board.

On Arc the native gas token is USDC-denominated, so a single faucet payment to
your funder wallet covers both the gas and the deposit:

```bash
# 1. Faucet testnet funds into a funder wallet YOU control (not the drone)
bash scripts/arc-testnet-faucet.sh 0xYOUR_FUNDER_ADDR
cast balance 0xYOUR_FUNDER_ADDR --rpc-url https://rpc.testnet.arc.network

# 2. Deposit into the drone's Gateway balance via depositFor (approve +
#    depositFor in one script; the board key is never exported)
FUNDER_PRIV_KEY=0x… node cloud/burn-intent-worker/scripts/gateway-deposit.js 0.05 0xYOUR_DRONE_EOA
```

(See [`docs/eip712-domain-trap.md`](https://github.com/TLAY-IO/boat-mer/blob/main/docs/eip712-domain-trap.md) before doing this — there is a critical Gateway-domain trap.)

## Step 4 — Flash the eCandle seller

Set the broker URI with the **device** credentials from Step 2 (the broker
rejects anonymous clients) and your broker's LAN address:

```bash
cd apps/ecandle
idf.py set-target esp32c3      # the reference seller is an ESP32-C3
idf.py menuconfig             # eCandle demo seller → MQTT broker URI:
                              #   mqtt://device:<your-device-pass>@<broker-ip>:1883
idf.py -p /dev/ttyUSB0 flash monitor
```

This emits synthetic AC output on a self-driving profile (see
`apps/ecandle/README.md`); no interaction is needed to start it.

You should see in the serial log:

```
boat-mer v1.0.1 seller initialized
BLE adv mfg_data[5] = 0 (IDLE, ready to connect)
```

## Step 5 — Flash the drone buyer

```bash
cd apps/drone                  # from the repo root
idf.py set-target esp32c3      # the reference drone is an ESP32-C3
idf.py -p /dev/ttyUSB1 flash monitor
```

You should see:

```
boat-mer v1.0.1 buyer initialized
EOA: 0xYOUR_DRONE_EOA
BLE scan started, looking for IDLE seller...
```

## Step 6 — Watch the first slice

Nothing to trigger: `synthetic_power_task` starts on its own once SNTP has synced
and drives a ramp / hold / off cycle. When it crosses the 5 W threshold you should
see in both boards' serial logs:

- Seller: `state -> ACTIVE, advertising 0xEE05 status`
- Buyer: `connected; subscribing to 0xEE03; signing slice #1; writing 0xEE04 proof`
- Cloud `/demo?live=1` page: a new slice record appears, batched into a settle every ~30s

After ~3 minutes you should see your first settle in the demo page's "Settlement" panel
with a Circle Gateway UUID.

## Optional — Mint to Arc (Path A)

Steps 1–6 exercise **Path B** (per-slice settle → batched into Circle Gateway
credit, which is off-chain). The demo also ships **Path A** — "Mint to Arc", which mints a seller's
accumulated Gateway credit on demand from the `/demo` page. It is **opt-in**: it
needs real chain credentials and a seller with settled Gateway credit, so it is
not part of the default stack.

```bash
# generate an operator key, then bring the stack up with the mint profile
node cloud/burn-intent-worker/scripts/gen-operator-wallet.js
docker compose --profile mint up
```

The operator key path, the seller identity, and the optional
`MINT_MAX_VALUE_MICRO` guardrail (unset = unlimited) are configured in
`cloud/.env.example`.

## Known gotchas

- **EIP-712 Gateway domain is NOT USDC token domain.** See [`docs/eip712-domain-trap.md`](https://github.com/TLAY-IO/boat-mer/blob/main/docs/eip712-domain-trap.md). The single most common reason your settle fails.
- **`value` / `validAfter` / `validBefore` must be JSON strings in the settle envelope**, not numbers. Circle returns a terse `success:false` with no `errorReason` if you send numbers. The `@tlay/hashanchor-client` SDK handles this for you.
- **Chain parameters must match across the buyer firmware and the cloud.** The seller is chain-agnostic, but if the buyer is built for one chain while the cloud `.env` points at another, every settle fails to recover and looks like a signing bug. See [Networks](../README.md#networks).
- **Re-flashing without a clean Gateway approve+deposit** will produce `insufficient_balance` errors. Re-run Step 3 if you re-create the on-chip EOA.

## Next steps

You ran the demo. Now what?

- **Build your own machine-economy app**: see [`docs/what-next.md`](what-next.md) and the upstream [TLAY-IO/boat-mer/docs/writing-a-buyer-app.md](https://github.com/TLAY-IO/boat-mer/blob/main/docs/writing-a-buyer-app.md).
- **Port BoAT MER to a different MCU** (STM32, nRF52): see upstream [TLAY-IO/boat-mer/docs/DEVELOPER_GUIDE.md](https://github.com/TLAY-IO/boat-mer/blob/main/docs/DEVELOPER_GUIDE.md)
  and [TECHNICAL.md](https://github.com/TLAY-IO/boat-mer/blob/main/docs/TECHNICAL.md).
- **Integrate HashAnchor into your own stack** (not BLE): see [TLAY-IO/hashanchor/docs/api-reference.md](https://github.com/TLAY-IO/hashanchor/blob/main/docs/api-reference.md).
