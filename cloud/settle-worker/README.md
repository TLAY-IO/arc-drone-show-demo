# settle-worker

A small Node.js service that subscribes to MQTT topic `ecandle/+/settle` and
forwards each batched settle envelope to HashAnchor's hosted public
`/v1/x402/settle` endpoint via
`@tlay/hashanchor-client`.

This is a **reference implementation**, intentionally minimal. In a production
deployment you'd add:

- Retry queue for transient failures
- Dead-letter handling for `unsupported_domain` / `invalid_signature` (these are
  config bugs, not transient — retrying won't help)
- Metrics (proofs/sec, batch latency, success rate per chain)
- Per-tenant routing

For the demo, this single-process worker is enough — the eCandle pre-batches
6 proofs per envelope and emits ~1 envelope per 30 seconds — well inside the
hosted service's rate limits.

## Run

```bash
npm install
npm start        # the demo settle path is public; no API key required
```

Or via docker-compose:

```bash
cd ..    # arc-drone-show-demo/cloud
docker compose up settle-worker
```

## Env vars

| | Default | Meaning |
|--|--|--|
| `MQTT_BROKER` | `mqtt://localhost:1883` | MQTT broker URL |
| `HASHANCHOR_API_KEY` | (optional) | Only needed if you also use `/v1/hashes` anchoring; demo settle path is public |
| `HASHANCHOR_SETTLE_URL` | `https://hashanchor.xid.network` | HashAnchor base URL (public settle endpoint) |

## License

MIT (see ../../LICENSE).
