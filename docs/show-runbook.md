# Operator Runbook

> Operating guide for reproducing the drone-charging nanopayment demo. Public viewers see only the demo page; this document is for whoever is at the laptop.
>
> Every address below is read from environment variables. Nothing in this file is specific to one deployment.

## What this shows

A buyer ESP32 (mounted on the drone) parks on an Arkreen eCandle ESP32 (the charging station). Every 5 seconds the buyer signs an EIP-3009 authorization with its on-chip secp256k1 key — **Path B**. Every ~6 slices the eCandle batches the signed proofs and forwards them to Circle Gateway. Real Circle transfer UUIDs stream into the right-hand column of the demo page.

When the seller's Gateway credit crosses the mint floor (`MIN_MINT_VALUE_MICRO`, default 10,000 µUSDC) **plus fee headroom**, the operator clicks **Mint to Arc** on any unminted settlement row. That triggers **Path A**: the eCandle signs an EIP-712 BurnIntent, the cloud worker posts it to Circle's `/v1/transfer` for an attestation, and the operator wallet calls `GatewayMinter.gatewayMint(...)`. Typically 7–26 seconds later, settlement rows covered by that mint **and still held in the live page cache** upgrade to a clickable block-explorer link.

> **Two caveats the page cannot show you.**
>
> **Fee headroom.** The BurnIntent must also cover `BURN_INTENT_MAX_FEE_MICRO` (default 5,000 µUSDC; observed fee 3,500). A balance of exactly 10,000 µUSDC is refused by Circle, and the page's balance read is advisory — it does not gate the click locally. Budget ~15,000 µUSDC as the practical minimum for one mint.
>
> **The floor pads upward.** `MIN_MINT_VALUE_MICRO` is not only a threshold: if accrued earnings are below it, the mint value is *raised* to it, and the difference comes out of the seller's existing Gateway balance. Mint after a short run and the on-chain number is larger than the device actually earned. A round 10,000 is the tell; an unround figure (99,843) is a run that cleared the floor on its own.
>
> **Not every covered row becomes a link.** `/api/stream` keeps only the most recent `CACHE_CAP_SETTLES` rows (default **100**) in process memory, and it does not hydrate from the database on start. `mint_ack` back-fills the tx hash only into rows still in that cache. At one slice per 5 s that is roughly **8 minutes** of history: rows older than the cache — and every row that arrived before the web process last restarted — stay unlinked. The on-chain record is unaffected and still verifiable from the worker's tx hash.

> **How many slices that takes depends entirely on the charging load.** At $10/kWh with 5-second slices: ~120 W ≈ 6 slices, ~40 W ≈ 18 slices, ~20 W ≈ 36 slices. Measure your actual load before assuming a number — the difference between a 30-second wait and a 3-minute wait is the difference between a good demo and dead air.

That clickable link is what the demo is for: **off-chain nanopayments, settled on-chain on demand, with a verifiable trail.** Plan the run so the rows you intend to click are recent ones — a first mint over a long backlog can legitimately produce no clickable row at all.

---

## Configuration

No identity is hardcoded. Everything below comes from your environment — except the operator private key, which is read from a file (see the first row).

| Variable | What it is |
|---|---|
| `BUYER_EOA` † | Buyer/drone wallet — must have USDC deposited into Circle Gateway |
| `SELLER_EOA` | Seller/eCandle wallet — receives the settled credit |
| `OPERATOR_KEY_PATH` | **File** holding the operator private key (default `~/.ecandle-secrets/operator.key`). Pays gas for `gatewayMint()`. Under `docker compose`, set `OPERATOR_KEY_FILE` in `.env` to the host path and compose mounts it. **The key is never read from an environment variable.** |
| `MQTT_BROKER` | Where the eCandle publishes |
| `APP_BASE_URL` † | Where the demo page is served |
| `ARC_CHAIN_ID` / `ARC_RPC_URL` / `ARC_EXPLORER` | Chain profile |
| `CIRCLE_TRANSFER_URL` | Circle Gateway transfer endpoint |
| `HASHANCHOR_SETTLE_URL` | Settlement relay |

† Runbook shorthand for a value *you* look up and check — the code does not read these as environment variables.

**Chain-invariant contracts** (published by Circle, identical across the supported testnet domains):

| Contract | Address |
|---|---|
| GatewayWallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| GatewayMinter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` |
| USDC on Arc | `0x3600000000000000000000000000000000000000` |

> ⚠️ Mainnet uses different Gateway addresses. Verify against Circle's published contract-address reference before pointing this at a mainnet chain profile — the EIP-712 domain includes `verifyingContract`, so a wrong address means every signature fails to recover. This is not a theoretical failure: nothing settles, and the logs look like a signing problem rather than a configuration one.

---

## Pre-flight (T−30 min)

1. **Single-instance check** — `ps aux | grep "node.*index.js" | grep -v grep`. Expect exactly **two** rows: one settle-worker, one burn-intent-worker. Kill any extras. Running two settle-workers against the same topic causes every proof to be sent twice.

2. **Broker running** — `docker ps` should show the mosquitto container. If not: `cd cloud && docker compose up -d mosquitto`.

3. **Demo page reachable** — open the demo URL in two browser tabs. Both should render, with the SSE indicator pulsing.

4. **Operator wallet has gas** — `node cloud/burn-intent-worker/scripts/check-operator-gas.js` (exit 0 = enough), or check the operator address it prints on the block explorer. Needs at least 0.05 USDC. Top up from your own funding source if low.

5. **Seller has Gateway credit** — `SELLER_EOA=… node cloud/burn-intent-worker/scripts/check-gateway-balance.js`. A brand-new seller starts at zero and needs roughly `MIN_MINT_VALUE_MICRO + maxFee` of settled credit before the first mint can succeed.

   > The script reads the on-chain `availableBalance`, which is a reliable **lower bound only while slices are NOT flowing** — during active settlement the on-chain view lags Circle's batch reconcile, sometimes by a lot (observed 14,162 µ on-chain vs 251,388 µ Circle-side). Run it pre-flight, at rest. Circle's `/v1/transfer` is the authoritative balance check at mint time; the worker treats its own on-chain read as advisory for the same reason.

6. **Worker logs visible** — `tail -f /tmp/settle-worker.log /tmp/burn-intent-worker.log` in a side terminal. Expect `circle_ack added N settle(s)` every ~30 s once slices are flowing.

---

## Boot sequence (T−10 min)

1. **Flash the buyer board** (if not already):
   ```bash
   cd apps/drone
   idf.py -p /dev/cu.usbserial-XXXX flash monitor
   ```
   Wait for `boat-mer buyer initialized` and the EOA print. **Confirm the printed EOA matches `$BUYER_EOA`** — the key lives in NVS, and flashing with `--erase-all` would generate a new one and orphan the Gateway deposit.

2. **Power on the eCandle board** — it reconnects to its saved Wi-Fi and starts publishing to `$MQTT_BROKER`.

3. **Verify the pipeline before you need it:**
   - eCandle serial: `0xEE03 SliceRequest #N amount=…uUSDC`
   - settle-worker log: `forwarding sid=… batch=… (N proofs)` then `settled sid=… batch=…: N/N ok`
   - demo page: Slices panel ticking; Settlements panel showing **real Circle UUIDs** — no `unk-` prefixes, no placeholder hashes

---

## During the demo

1. **Let it run** until the Settlements panel has accumulated enough unminted credit to cross the mint floor (see the load table above — this is the step people underestimate). Each row is labelled `off-chain · Circle Gateway`.

2. **Explain Path B while it runs** — a real EIP-3009 signature every 5 seconds, a real Circle settle every 30, and no on-chain transaction yet. The money is moving; it just lives in Circle's batched ledger so far.

3. **Click "Mint to Arc"** on any unminted row. The worker log shows:
   ```
   [worker] mint job: …
   [worker] burn intent digest=0x…
   [worker] device signed: 0x… signer=0x…
   [worker] Circle attestation received
   [worker] gatewayMint sent tx=0x…
   [worker] gatewayMint confirmed: block=…
   [worker] mint_ack published
   ```
   End to end this typically takes 7–26 seconds (observed range; it depends on
   Circle's attestation latency and the chain's block time).

4. **Every row covered by that mint upgrades** to `minted · Arc · 0x…` with a working explorer link. Open one — it is a real on-chain transaction.

5. **Repeat if asked.** Each mint is its own transaction and costs one gas fee on the operator wallet.

---

## Failure modes

| Symptom | Diagnosis | Response |
|---|---|---|
| Slices panel empty | buyer not signing — usually BLE pairing | Power-cycle the buyer board; it re-pairs within ~10 s |
| Slices tick but Settlements empty | settle-worker down, or the settlement relay is unreachable | `tail /tmp/settle-worker.log`; confirm `$HASHANCHOR_SETTLE_URL` responds |
| "Mint to Arc" never appears | seller's unminted credit is below the mint floor | Wait for more slices — check the load table, this takes longer at low wattage than people expect |
| `[single-instance-guard] another worker is already running` | a previous worker survived | **This is the good case.** Find it with `ps aux \| grep node` and tail its existing log instead of starting a second one |
| `REPLACEMENT_UNDERPRICED` | operator wallet nonce race, or two concurrent mints | First confirm the previous transaction's on-chain status from its tx hash; only if it never mined, trigger another mint |
| Settlements show `unk-<ts>` instead of UUIDs | the page is attached to a stale SSE cache | Hard-refresh the browser. If it persists, restart the web server |
| Circle refuses the transfer with `insufficient_balance` | seller credit genuinely < (mint value + maxFee) — or the mint raced Circle's batch reconcile during active settling (the on-chain slot lags; observed 14,162 µ on-chain vs 251,388 µ Circle-side) | Wait 10–30 s for reconcile and retry. If it persists at rest, wait for more slices or deposit into the seller's Gateway balance |
| Worker log warns `on-chain availableBalance reads below the requested mint … proceeding` | advisory only — the on-chain view lags during active settlement | Nothing. The worker states its own read is unreliable and lets Circle decide |
| Worker dies mid-mint | rare | Restart it. Server-side UUID state clears only on confirmed tx, so there is no double-mint path |

---

## Don't do these

- **Don't restart workers between mints.** In-memory UUID state tracks which slices are unminted; restarting loses that. Restart only between full demo cycles.
- **Don't start workers from multiple terminals.** The pidfile guard uses the OS temp dir, so it catches the common case but not processes started with a different `$TMPDIR`. Use `docker compose` or a process manager.
- **Don't double-click Mint.** The `mintInFlight` mutex refuses the second click, but the button may look unresponsive. Wait for the row to upgrade.
- **Don't flash the buyer board with `--erase-all`.** It wipes NVS, generating a new EOA and orphaning whatever was deposited into Gateway for the old one.
- **Don't open the buyer's serial port during a live session.** On some USB-UART bridges, merely opening the port pulses EN and resets the board (observed on CP2102N + macOS even with DTR/RTS deasserted). The engine self-heals in ~11 s, but collect serial evidence only between sessions.
- **Don't walk through Path A source during the demo.** The audience wants the explorer link, not the BurnIntent encoding.

---

## After

1. Record the transaction hashes used.
2. `node cloud/burn-intent-worker/scripts/post-show-reconcile.js [logfile]` — parses the worker log and verifies that every confirmed mint corresponds to a unique set of covered Circle UUIDs and that no UUID appears in two minted batches.
3. Ship fixes the demo surfaced, but **not on the same day.**

---

## Quick reference

| | |
|---|---|
| Demo page | `$APP_BASE_URL/demo?live=1` |
| MQTT broker | `$MQTT_BROKER` |
| Buyer / seller wallets | `$BUYER_EOA` / `$SELLER_EOA` |
| Operator wallet | printed by `check-operator-gas.js` (derived from the key file) |
| Chain ID | `$ARC_CHAIN_ID` |
| Explorer | `$ARC_EXPLORER` |
| Circle transfer status (public, no auth) | `$CIRCLE_TRANSFER_URL/<transferId>` |
