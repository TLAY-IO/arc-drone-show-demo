/* SPDX-License-Identifier: MIT
 * Copyright 2026 TLAY / arc-drone-show-demo contributors
 *
 * main.c — drone-agent buyer app (apps/drone).
 *
 * Wires the NimBLE transport (ble_transport.c) into the boat-mer buyer engine
 * (pulled from TLAY-IO/boat-mer via the ESP-IDF Component Manager) and runs it
 * with the Phase-1 demo tuning in app_config.h. The engine owns all protocol
 * logic; this file only (1) brings up the on-chip wallet, (2) builds the config,
 * (3) supplies result callbacks, and (4) hands off to the transport.
 *
 * The drone is BLE-only (no Wi-Fi). It never talks to the cloud directly: each
 * signed slice is written to the seller over 0xEE04, and the seller batches it
 * to Circle Gateway via its own settle path — that is how the cloud/MQTT viz
 * sees drone payments. on_slice_signed() therefore just logs locally.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <inttypes.h>

#include "esp_log.h"
#include "nvs_flash.h"

#include "boat_crypto.h"          /* boat_crypto_init, boat_keypair_t */
#include "boat_buyer_nanopay.h"   /* the buyer engine */
#include "app_config.h"
#include "ble_transport.h"

static const char *TAG = "drone_app";

/* Engine + wallet live for the lifetime of the device (no malloc). */
static boat_buyer_ctx_t s_ctx;
static boat_keypair_t   s_kp;

/* ---- helpers --------------------------------------------------------- */

static int hex_nibble(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Decode a 40-char hex string into out[20]. Returns true on success. */
static bool hex20(const char *hex, uint8_t out[20])
{
    if (strlen(hex) != 40) return false;
    for (int i = 0; i < 20; i++) {
        int hi = hex_nibble(hex[2 * i]), lo = hex_nibble(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) return false;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return true;
}

static void log_eoa(const uint8_t addr[20])
{
    char s[2 * 20 + 1];
    for (int i = 0; i < 20; i++) snprintf(s + 2 * i, 3, "%02x", addr[i]);
    ESP_LOGI(TAG, "drone wallet EOA = 0x%s", s);
    /* Both the network name and the id come from the compiled-in constant, so
     * this line can be used to tell a testnet image from a mainnet one. Do not
     * hard-code the name here: a fixed string looks correct on whichever build
     * it happens to match, and then proves nothing on the other one. */
    ESP_LOGI(TAG, "fund this EOA on Arc %s (chainId %u) + deposit >= 0.05 USDC "
                  "into Circle Gateway (0x%s) before paying for slices",
             (DRONE_CHAIN_ID == 5042u) ? "Mainnet" : "Testnet",
             (unsigned)DRONE_CHAIN_ID, DRONE_GATEWAY_CONTRACT_HEX);
}

/* ---- engine callbacks ------------------------------------------------ */

static void on_slice_signed(void *u, uint32_t slice_id, const char *proof_json, uint16_t len)
{
    (void)u; (void)len;
    /* The engine already wrote this proof to 0xEE04; the seller settles it.
     * BLE-only drone → no direct cloud publish here. Log for the serial demo. */
    ESP_LOGI(TAG, "slice %" PRIu32 " signed -> 0xEE04 (%u B): %s",
             slice_id, (unsigned)len, proof_json);
}

static void on_session(void *u, bool streaming)
{
    (void)u;
    ESP_LOGI(TAG, "power self-drive %s a paying session", streaming ? "OPENED" : "CLOSED");
}

static void on_log(void *u, int level, const char *msg)
{
    (void)u;
    switch (level) {
    case 0:  ESP_LOGE(TAG, "engine: %s", msg); break;
    case 1:  ESP_LOGW(TAG, "engine: %s", msg); break;
    default: ESP_LOGI(TAG, "engine: %s", msg); break;
    }
}

/* ---- entry ----------------------------------------------------------- */

void app_main(void)
{
    /* NVS backs the PAL keypair store (boat_crypto_init persists the EOA). */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    /* Load (or first-boot generate + persist) the on-chip secp256k1 wallet.
     * The private key never leaves the chip. */
    if (boat_crypto_init(&s_kp) != BOAT_OK) {
        ESP_LOGE(TAG, "boat_crypto_init failed — halting");
        return;
    }
    log_eoa(s_kp.eth_address);

    /* Build the buyer policy from app_config.h. */
    boat_buyer_config_t cfg = {
        .chain_id              = DRONE_CHAIN_ID,
        .domain_name           = DRONE_EIP712_DOMAIN_NAME,
        .domain_version        = DRONE_EIP712_DOMAIN_VERSION,
        .rate_ceiling_micro    = DRONE_RATE_CEILING_MICRO,
        .session_cap_micro     = DRONE_SESSION_CAP_MICRO,
        .min_valid_window_secs = DRONE_MIN_VALID_WINDOW_S,
        .power_start_dw        = DRONE_POWER_START_DW,
        .power_stop_dw         = DRONE_POWER_STOP_DW,
        .power_start_ticks     = DRONE_POWER_START_TICKS,
        .power_stop_ticks      = DRONE_POWER_STOP_TICKS,
        .tick_ms               = DRONE_TICK_MS,
        .wedge_secs            = DRONE_WEDGE_SECS,
        .hard_reset_secs       = DRONE_HARD_RESET_SECS,
    };
    if (!hex20(DRONE_GATEWAY_CONTRACT_HEX, cfg.gateway_contract)) {
        ESP_LOGE(TAG, "bad DRONE_GATEWAY_CONTRACT_HEX — halting");
        return;
    }

    boat_buyer_callbacks_t cb = {
        .on_slice_signed = on_slice_signed,
        .on_session      = on_session,
        .on_log          = on_log,
    };

    if (boat_buyer_init(&s_ctx, &s_kp, drone_transport_vtable(), NULL, &cfg, &cb, NULL) != BOAT_OK) {
        ESP_LOGE(TAG, "boat_buyer_init failed — halting");
        return;
    }

    ESP_LOGI(TAG, "buyer engine ready (proto_ver %d) — bringing up NimBLE", BOAT_NANO_WIRE_PROTO_VER);
    drone_transport_init(&s_ctx);
}
