# apps/drone — buyer-side ESP32 integration

This app runs on an ESP32 dev board and acts as the **drone-agent buyer** in the demo.
It scans for an IDLE eCandle, connects, reads `ac_output_dw`, and self-drives a
streaming nanopayment session based on the seller's power output.

## Files

| File | Role |
|------|------|
| `main/main.c` | app entry: on-chip wallet, builds `boat_buyer_config_t`, result callbacks, hands off |
| `main/ble_transport.c` | NimBLE central shell: scan / IDLE-gate / discover / subscribe + the transport vtable, feeds events into the engine |
| `main/app_config.h` | Phase-1 tuning (thresholds, watchdog, **EIP-712 Gateway domain**) — single source of truth |
| `main/idf_component.yml` | Component Manager manifest pinning boat-mer `v1.0.1` |

## What this app does

- BLE scan for sellers advertising the 0xEE00 service with `mfg_data[5] = 0` (IDLE-gate handshake)
- Connect, exchange MTU (512), GATT discovery, subscribe to 0xEE02/0xEE03/0xEE06
- Run the boat-mer **buyer engine** (from `protocols/buyer/`) — the engine takes a thin
  transport vtable (`write_chr` / `read_chr` / `disconnect` / `hard_reset`) so it knows
  nothing about NimBLE specifically; the app feeds it
  `boat_buyer_on_{connect,disconnect,notify,read_result}` and ticks it every 5 s
- A-prime self-drive: `ac_output_dw` ≥ `power_start_dw` → write 0xEE01=0x02 (open stream),
  below `power_stop_dw` for `power_stop_ticks` → 0xEE01=0x00 (close)
- The engine signs each EIP-3009 slice authorization on-chip and writes the proof to 0xEE04
- The drone is **BLE-only (no Wi-Fi)**: the cloud/MQTT viz sees drone payments via the
  **seller's** settle path (the seller batches the 0xEE04 proofs to Circle Gateway), not a
  direct drone publish

## Build

```bash
cd apps/drone
idf.py set-target esp32c3   # the reference drone is an ESP32-C3; esp32s3 also works
idf.py -p /dev/ttyUSB1 flash monitor
```

## Tuned parameters (Phase 1 demo defaults)

These values were tuned during the 2026-06-11/12 SF Drone Show integration days
and the 2026-06-13 vacuum-robot rehearsal:

All in `main/app_config.h`:

| `boat_buyer_config_t` field | Value | Why |
|-----------|-------|-----|
| `power_start_dw` | 50 (5.0 W) | Above 5W = real load, below = noise / standby |
| `power_stop_dw` | 50 (5.0 W) | Symmetric hysteresis (start = stop) |
| `power_start_ticks` | 1 | Open stream instantly on power detect |
| `power_stop_ticks` | 6 | ~30s sustained idle before stopping (debounce dock-contact bounce) |
| `tick_ms` | 5000 | Power-sample + watchdog-probe period |
| `wedge_secs` | 30 | Connected but no 0xEE05 liveness this long → re-pair |
| `hard_reset_secs` | 150 | No link at all this long → `esp_restart()` |

The BLE supervision timeout (6000 ms; the NimBLE 2.56s default flapped under
BT/Wi-Fi coexistence) is set in `ble_transport.c`'s connect params, not the
engine config. You should override these for your own load. See
[TLAY-IO/boat-mer/docs/writing-a-buyer-app.md](https://github.com/TLAY-IO/boat-mer/blob/main/docs/writing-a-buyer-app.md).

## EIP-712 Gateway domain trap

The single most common reason for failed settles. The drone signs an EIP-3009
authorization, but the EIP-712 domain it uses is the **Circle Gateway** domain,
NOT the USDC token domain. Get this wrong and your signatures will pass
`ecrecover` but settle will reject with `address_mismatch`.

Configuration:

```c
boat_buyer_config_t cfg = {
    .domain_name      = "GatewayWalletBatched",  // NOT "USDC" / the token domain
    .domain_version   = "1",
    .gateway_contract = { /* 20 bytes, parsed from DRONE_GATEWAY_CONTRACT_HEX */ },
    .chain_id         = 5042002,                 // Arc Testnet
    ...
};
```

(See `main/app_config.h` for the actual values; `gateway_contract` is the
20-byte Circle Gateway address `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`.)

Verify the on-chain values before you ship:

```bash
node ../../scripts/eip712-domain-probe.js
```

See upstream [TLAY-IO/boat-mer/docs/eip712-domain-trap.md](https://github.com/TLAY-IO/boat-mer/blob/main/docs/eip712-domain-trap.md).

## First-boot setup

On first flash, `boat_crypto_init()` generates an on-chip secp256k1 keypair and
persists it in NVS via the boat-mer PAL (the private key never leaves the chip;
enable NVS encryption for production). The serial log prints the EOA address; copy it and
fund it on Arc Testnet (see [../../scripts/arc-testnet-faucet.sh](../../scripts/arc-testnet-faucet.sh))
plus deposit ~0.05 USDC into Circle Gateway.

```
boat-mer buyer initialized
  proto_ver = 2
  eoa = 0xab1234567890abcdef1234567890abcdef123456
  did = did:mw:0xab1234567890...
Deposit ≥ 0.05 USDC into 0x0077... before paying for slices.
```

A plain `idf.py flash` does **not** touch NVS: the key survives re-flashing,
and so does the Gateway deposit made against it. Never pass `--erase-all` —
that wipes NVS, generates a new EOA, and orphans whatever you deposited.
