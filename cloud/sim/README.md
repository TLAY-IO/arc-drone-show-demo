# cloud/sim — run the cloud side with no hardware

A small Node script that publishes the MQTT events a real eCandle seller emits
while a drone buyer charges from it. With it, the broker → SSE bridge →
`/demo?live=1` pipeline runs end to end on a laptop: no boards, no `.env`, no
broker credentials, no faucet, no Gateway deposit.

```bash
cd cloud
docker compose -f docker-compose.sim.yml up --build
open 'http://localhost:3000/demo?live=1'      # SIM_WEB_PORT=3001 … if 3000 is taken
```

Within a few seconds the page shows a charging session: a slice every 5 s, and
a batch of six settlement rows every 30 s. Sessions repeat — about 90 s of
charging (a plateau near 120 W, then a taper), then 25 s idle.

## What is real and what is simulated

| | In this stack |
|---|---|
| Mosquitto broker, topic layout | **Real** (same image; a private, anonymous config — see below) |
| SSE bridge `/api/stream`, its rolling cache | **Real** — same code the hardware path uses |
| `/demo` page | **Real** — same page, built with a flag that labels it `Simulated devices · no chain` |
| eCandle seller, drone buyer, BLE link | Simulated |
| EIP-3009 signatures | **None.** No proof is signed or verified |
| HashAnchor, Circle Gateway, Arc | **Not contacted.** Nothing settles, mints or spends |

The settlement rows are therefore not settlements. Their ids are prefixed
`sim-` so they cannot be mistaken for Circle transfer UUIDs, and the
`Mint to Arc` button stays disabled (no seller EOA is configured, and no
burn-intent worker is running to act on it).

Use this to see the demo, to work on the page or the SSE bridge, or to check
that a change to the topic layout still flows through. It tells you nothing
about whether signing, settlement or minting work — for that you need the
boards and [`docs/reproduce.md`](../../docs/reproduce.md).

## Why a separate compose file

`docker-compose.sim.yml` is its own stack rather than a profile of
`docker-compose.yml`, so the two cannot be half-combined:

- The sim broker allows anonymous clients (`mosquitto/sim.conf`). That is only
  acceptable because it publishes **no port to the host** — the web and sim
  containers are the only things that can reach it.
- The settle-worker and burn-intent-worker are not part of it. The simulator
  also never publishes on `ecandle/<id>/settle`, the topic the settle-worker
  forwards to HashAnchor.

Do not point a real device or a worker at the sim broker, and do not run the
simulator against a real deployment's broker: it would write simulated rows
into a page showing real ones.

## Events published

| Topic | Payload | Cadence |
|---|---|---|
| `ecandle/ecandle-sim/status` | `{ "power": { "ac_output": <W> } }` | 3 s |
| `ecandle/ecandle-sim/nanopay` | `session_notify` (cmd 1 / 2), `stream_start`, `stream_stop` | per session |
| `ecandle/ecandle-sim/nanopay` | `slice_req` `{ sid, slice_id, avg_w, amount_micro }`, then `slice_paid` | 5 s |
| `ecandle/ecandle-sim/circle_ack` | `{ sid, batch_idx, simulated: true, results: [{ slice_id, value, success, transaction: "sim-…" }] }` | every 6 slices |

`amount_micro` follows the demo's price: `avg_w × 5 s` at $10/kWh, so 120 W is
1,667 µUSDC per slice.

## Smoke test

```bash
cloud/sim/smoke.sh
```

Builds the stack, reads `/api/stream` for 70 s, checks that `slice_req`,
`slice_paid` and a `sim-` `circle_ack` arrived and that no `mint_ack` did, then
tears the stack down. CI runs the same script.

## License

MIT (see ../../LICENSE).
