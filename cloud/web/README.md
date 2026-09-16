# cloud/web — Next.js demo visualization

A minimal Next.js 16 + App Router app that:

- Subscribes to the MQTT broker (`mosquitto` service in `docker-compose.yml`)
- Bridges the device events to a Server-Sent Events stream on `/api/stream`
- Renders the demo visualization at `/demo`. Without a query parameter the
  page runs **simulation cycles on mock data** (useful when no devices are
  powered). Add `?live=1` for real broker traffic via `/api/stream` — that is
  the path this repo verifies.

This is the **showcase** for the SF Drone Show. It is intentionally minimal —
just enough to demonstrate that BLE slice events from the eCandle/drone pair
flow through the cloud and result in batched Arc Testnet settlements.

## Run

Via docker-compose (recommended):

```bash
cd ..    # arc-drone-show-demo/cloud
docker compose up web
```

Or standalone:

```bash
npm install
MQTT_BROKER=mqtt://localhost:1883 npm run dev
```

Then open <http://localhost:3000/demo?live=1>.
(Without `?live=1` you get the mock simulation, not your devices.)

## License

MIT (see ../../LICENSE).
