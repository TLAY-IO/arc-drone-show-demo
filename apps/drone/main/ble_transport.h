/* SPDX-License-Identifier: MIT
 * Copyright 2026 TLAY / arc-drone-show-demo contributors
 *
 * ble_transport.h — NimBLE central transport for the boat-mer buyer engine.
 *
 * This is the demo-app (MIT) glue that injects a concrete BLE stack (NimBLE on
 * ESP32) into the transport-agnostic boat-mer buyer engine (Apache-2.0, pulled
 * via the ESP-IDF Component Manager). It owns scanning, the IDLE-gate connect,
 * GATT discovery + subscription, and the four transport-vtable primitives; the
 * engine owns all protocol logic (power self-drive, slice validation, EIP-3009
 * signing, the self-heal watchdog). See
 * https://github.com/TLAY-IO/boat-mer/blob/main/docs/writing-a-buyer-app.md
 */
#ifndef BLE_TRANSPORT_H
#define BLE_TRANSPORT_H

#include "boat_buyer_nanopay.h"

/* Bring up NimBLE and start driving `ctx`: scan for an IDLE seller, connect,
 * discover/subscribe 0xEE00, and feed GAP/GATT events into the engine. The
 * engine must already be boat_buyer_init()'d with the vtable returned by
 * drone_transport_vtable(). Non-reentrant; call once from app_main. */
void drone_transport_init(boat_buyer_ctx_t *ctx);

/* The transport vtable the engine calls for BLE I/O. Pass this (and a NULL
 * transport_user — the transport is a singleton backed by module state) to
 * boat_buyer_init() before drone_transport_init(). */
const boat_buyer_transport_t *drone_transport_vtable(void);

#endif /* BLE_TRANSPORT_H */
