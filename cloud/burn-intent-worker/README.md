# burn-intent-worker — "Mint to Arc" (Path A)

Turns settled Circle credit into real USDC on Arc: builds an EIP-712
BurnIntent for the seller device's accumulated credit, has the device sign
it over MQTT, posts the signed payload to Circle `/v1/transfer`, and submits
the returned attestation via `GatewayMinter.gatewayMint()`.

This service is **optional** — the default compose stack runs the demo
without it (Path B only). It needs real chain credentials and a funded
seller, so it is gated behind a compose profile:

```bash
docker compose --profile mint up -d
```

## One-time setup

1. **Operator wallet** (gas-only; never holds nominal USDC):

   ```bash
   node scripts/gen-operator-wallet.js
   ```

   This writes the key to `~/.ecandle-secrets/operator.key`. Set
   `OPERATOR_KEY_FILE` in `../.env` to that path — compose mounts it
   read-only into the container; the key never enters the image. Fund the
   operator with a little native gas (one faucet drip covers it on Arc
   Testnet, where gas is USDC-denominated).

2. **Seller credit**: the depositor (your eCandle's EOA) must have Gateway
   `availableBalance` to burn. Credit accrues from settled energy slices;
   you can also pre-fund it directly:

   ```bash
   FUNDER_PRIV_KEY=0x… node scripts/gateway-deposit.js 0.5 <seller-eoa>
   ```

3. **MQTT credentials**: the worker connects as the `worker` user (see
   `../mosquitto/gen-passwd.sh`); compose passes the credentialed URL via
   `MQTT_URL_WORKER`.

## Tuning (all optional, see `../.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `MIN_MINT_VALUE_MICRO` | `10000` | Floor: every mint is at least this many µUSDC |
| `MINT_MAX_VALUE_MICRO` | unset (unlimited) | Per-click cap: when set, one mint covers a FIFO subset of unminted settles summing to ≤ this; the remainder stays for the next click |
| `BURN_INTENT_MAX_FEE_MICRO` | `5000` | maxFee field of the BurnIntent |
| `SIGN_TIMEOUT_MS` / `SIGN_RETRIES` | `10000` / `3` | Device signature request over MQTT |

## After a session

```bash
node scripts/post-show-reconcile.js /path/to/worker.log
```

verifies that no Circle UUID was covered by two confirmed mints.

## Safety properties

- Single-instance guard (pidfile + exclusive lock) — two workers minting
  from private backlogs is the historical failure mode this prevents.
- The browser can *request* a mint but never chooses its contents: covered
  UUIDs and value come only from the worker's server-side state, and the
  covered set is cleared atomically only after the mint tx confirms.
- On-chain `availableBalance` is read for logging but never gates the mint
  (it lags Circle-side credit during active settlement); Circle's
  `/v1/transfer` is the authoritative check and fails safe before gas.
