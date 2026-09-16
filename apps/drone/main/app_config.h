/* SPDX-License-Identifier: MIT
 * Copyright 2026 TLAY / arc-drone-show-demo contributors
 *
 * app_config.h — Phase-1 demo tuning for the drone buyer.
 *
 * Single source of truth for every value the app injects into the boat-mer
 * buyer engine via boat_buyer_config_t (main.c) and for the transport's tick
 * period (ble_transport.c). Override these for your own load; see
 * https://github.com/TLAY-IO/boat-mer/blob/main/docs/writing-a-buyer-app.md
 *
 * ⚠️ The EIP-712 domain below is the single most common cause of rejected
 * settles. You are signing for the Circle **Gateway** contract, NOT the USDC
 * token. Verify the on-chain values before shipping:
 *     node ../../scripts/eip712-domain-probe.js
 * See https://github.com/TLAY-IO/boat-mer/blob/main/docs/eip712-domain-trap.md
 */
#ifndef APP_CONFIG_H
#define APP_CONFIG_H

/* ---- chain + EIP-712 Gateway domain ---------------------------------- */
/* Overridable so one tree builds both Sept-2026 images:
 *   testnet  5042002 (default; second board, 9/15 vacuum demo + 9/17 backup)
 *   mainnet  5042    (cmake -DDRONE_CHAIN_ID=5042; existing board, 9/17)
 * Use a SEPARATE build dir per variant — CMake caches the value. */
#ifndef DRONE_CHAIN_ID
#define DRONE_CHAIN_ID            5042002u   /* Arc Testnet */
#endif
/* Overridable for the same reason as the contract below: Arc Testnet's
 * name/version are PROVEN by real settles; the mainnet values are unconfirmed
 * until Circle publishes them. Chain switch = cmake values only, no source
 * edits:  -DDRONE_EIP712_DOMAIN_NAME=... -DDRONE_EIP712_DOMAIN_VERSION=... */
#ifndef DRONE_EIP712_DOMAIN_NAME
#define DRONE_EIP712_DOMAIN_NAME    "GatewayWalletBatched"
#endif
#ifndef DRONE_EIP712_DOMAIN_VERSION
#define DRONE_EIP712_DOMAIN_VERSION "1"
#endif
/* Circle Gateway verifyingContract. Confirm via the probe script before a
 * real settle — a wrong contract passes ecrecover but settle rejects with
 * address_mismatch.
 * ⚠️ MAINNET value UNCONFIRMED: take the mainnet Gateway address and all
 * three EIP-712 domain fields from Circle's official contract-address
 * reference — testnet and mainnet addresses may differ. Verify on-chain
 * (getCode / eip712Domain) before a mainnet settle. Do NOT bake a final
 * mainnet image until confirmed; override per image via
 * cmake -DDRONE_GATEWAY_CONTRACT_HEX=... (no quotes, 40 hex chars). */
#ifndef DRONE_GATEWAY_CONTRACT_HEX
#define DRONE_GATEWAY_CONTRACT_HEX  "0077777d7EBA4688BDeF3E311b846F25870A19B9"
#endif

/* ---- buyer guardrails ------------------------------------------------ */
#define DRONE_RATE_CEILING_MICRO   30000000u  /* reject a StreamOffer above this µUSDC/kWh. This is an UPPER BOUND and MUST be >= the seller's actual quote; a mismatch shows up as "BLE connects but zero slices". Rate aligned 2026-09-01 in-room: seller $10/kWh = 10,000,000µ (ecandle_nanopay.h:89), Lane1 ceiling 30M for headroom. */
#define DRONE_SESSION_CAP_MICRO    1000000u  /* hard spend cap per charging session ($1) */
/* WHY 604900: Circle Gateway rejects authorizations with validity < 7 days
 * (authorization_validity_too_short); Circle's own SDK (GatewayEvmScheme)
 * uses 604900 = 7 d + 100 s buffer. TLAY standard constant since the
 * 2026-08-11 A-case. Some Circle doc pages still say 3 days — wrong in
 * practice; do not lower. Failure is at settle time, not signing time. */
#define DRONE_MIN_VALID_WINDOW_S   604900u   /* 7 days + 100 s (Circle Gateway floor) */

/* ---- A-prime power self-drive (deciwatts; 5 W == 50) ----------------- */
#define DRONE_POWER_START_DW       50        /* >= 5W -> open a paying session */
#define DRONE_POWER_STOP_DW        50        /* < 5W  -> close it (symmetric hysteresis) */
#define DRONE_POWER_START_TICKS    1         /* open instantly on power detect */
#define DRONE_POWER_STOP_TICKS     6         /* ~30s sustained idle before stopping (dock bounce) */

/* ---- self-heal watchdog ---------------------------------------------- */
#define DRONE_TICK_MS              5000u     /* boat_buyer_tick() period (also the timer period) */
#define DRONE_WEDGE_SECS           30        /* connected + no 0xEE05 liveness this long -> re-pair */
#define DRONE_HARD_RESET_SECS      150       /* no link at all this long -> hard_reset (esp_restart) */

#endif /* APP_CONFIG_H */
