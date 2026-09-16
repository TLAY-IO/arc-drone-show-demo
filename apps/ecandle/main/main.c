// SPDX-License-Identifier: MIT
// Copyright 2026 TLAY — arc-drone-show-demo (apps/ecandle reference seller)
//
// eCandle reference SELLER for the SF Drone Show nanopayment demo.
//
// MIT integration glue wiring the Apache-2.0 BoAT MER runtime (Component-Manager
// dependency, never vendored) onto an ESP32-C3. It:
//   - brings up a NimBLE peripheral + the 0xEE00 seller GATT family
//   - advertises the IDLE-gate handshake
//   - feeds a SYNTHETIC AC-power source into the per-slice billing loop
//   - (uplink) joins WiFi → SNTP for valid slice timestamps + MQTT to forward
//     each buyer SlicePayment proof to the cloud settle-worker → HashAnchor.
//
// Settle path (3-layer contract, locked):
//   drone signs → 0xEE04 flat proof → seller batches + MQTT publishes VERBATIM
//   {sid,batch_idx,network,proofs:[...]} to ecandle/<id>/settle → settle-worker
//   → @tlay/hashanchor-client.settle() does the flat→nested transform → HashAnchor.
// The seller never reshapes the signed proof (just transits it).
//
// HONESTY (boat_mer_usage.md): a real eCandle reads its inverter over a
// proprietary Arkreen protocol NOT in this repo; here the power is synthetic, so
// the MER attest tier witnesses synthetic readings — mechanism, not a live meter.

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/timers.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "esp_sntp.h"
#include "nvs_flash.h"
#include "mqtt_client.h"

#include "wifi_prov.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
void ble_store_config_init(void);

// BoAT MER runtime (Apache-2.0, fetched via idf_component.yml — not vendored).
#include "boat_seller_nanopay.h"   // protocols/seller — 0xEE00 seller engine
#include "boat_nano_wire.h"        // canonical wire contract (adv defines)
#include "boat_crypto.h"           // tier: crypto/identity (device EOA)
#include "boat_attest.h"           // tier: attest (witness a reading)
#include "cJSON.h"                  // parse the Path A sign-digest command

static const char *TAG = "ecandle_seller";

/* ───────────────────────── demo seller policy ───────────────────────── */
static const boat_seller_config_t s_cfg = {
    .rate_usdc_per_kwh_micro       = CONFIG_DEMO_RATE_USDC_PER_KWH_MICRO, // $10/kWh default
    .slice_duration_ms             = 5000,     // bill every 5 s
    .batch_size                    = 6,        // settle every ~30 s
    .max_session_amount_usdc_micro = 1000000,  // $1 session cap
    .expected_power_w_min          = 36,
    .expected_power_w_max          = 200,
    .slice_valid_secs              = 691200,   // 8 days (≥ settlement window)
    .adv_price_uslice              = 1667,     // ~nominal µUSDC/slice at 120W·5s·$10/kWh
    .payment_token                 = { 0x36 }, // Arc USDC 0x3600..0000
};

static char s_device_id[16];                   // "ecandle-xxxx" (lowercase MAC)
static uint8_t own_addr_type;

static inline bool clock_synced(void) { return time(NULL) > 1700000000; /* ~2023-11 */ }

/* ============================ settle-proof uplink ============================
 * The buyer's signed 0xEE04 proof JSON is transited VERBATIM (never reshaped —
 * the EIP-712 signature covers the authorization field values, and the worker /
 * @tlay/hashanchor-client.settle() do the flat→nested transform downstream).
 * We batch up to batch_size proofs (or flush on a timer) and publish:
 *   topic   ecandle/<id>/settle
 *   payload {"sid":N,"batch_idx":M,"network":"<caip2>","proofs":[<verbatim>...]} */
#define SETTLE_BATCH_MAX 8
static struct {
    SemaphoreHandle_t lock;
    char    *proofs[SETTLE_BATCH_MAX];   // strdup'd verbatim 0xEE04 JSON
    int      count;
    uint32_t sid;
    uint32_t batch_idx;
} s_batch;

static esp_mqtt_client_handle_t s_mqtt;
static volatile bool s_mqtt_up;

// Build + publish the current batch. Caller holds s_batch.lock.
static void settle_flush_locked(void)
{
    if (s_batch.count == 0) return;
    if (!s_mqtt || !s_mqtt_up) {
        ESP_LOGW(TAG, "settle: MQTT down, dropping batch of %d", s_batch.count);
        for (int i = 0; i < s_batch.count; i++) { free(s_batch.proofs[i]); s_batch.proofs[i] = NULL; }
        s_batch.count = 0;
        return;
    }

    size_t cap = 128;
    for (int i = 0; i < s_batch.count; i++) cap += strlen(s_batch.proofs[i]) + 1;
    char *env = malloc(cap);
    if (!env) { ESP_LOGE(TAG, "settle: OOM (%u)", (unsigned)cap); return; }

    int n = snprintf(env, cap, "{\"sid\":%u,\"batch_idx\":%u,\"network\":\"%s\",\"proofs\":[",
                     (unsigned)s_batch.sid, (unsigned)s_batch.batch_idx, CONFIG_DEMO_SETTLE_NETWORK);
    for (int i = 0; i < s_batch.count; i++) {
        n += snprintf(env + n, cap - n, "%s%s", i ? "," : "", s_batch.proofs[i]);
        free(s_batch.proofs[i]);
        s_batch.proofs[i] = NULL;
    }
    n += snprintf(env + n, cap - n, "]}");

    char topic[40];
    snprintf(topic, sizeof topic, "ecandle/%s/settle", s_device_id);
    int rc = esp_mqtt_client_publish(s_mqtt, topic, env, n, /*qos*/1, /*retain*/0);
    ESP_LOGI(TAG, "settle: published sid=%u batch=%u (%d proofs, %d B) rc=%d",
             (unsigned)s_batch.sid, (unsigned)s_batch.batch_idx, s_batch.count, n, rc);
    free(env);

    s_batch.count = 0;
    s_batch.batch_idx++;
}

// SlicePayment proof sink (called from the boat_seller worker task). Append the
// VERBATIM proof to the batch; flush when full.
static void on_slice_proof(uint32_t session_id, uint32_t slice_id,
                           uint64_t amount_micro_usdc, const char *auth_json)
{
    ESP_LOGI(TAG, "slice proof sid=%u slice=%u amount=%lluuUSDC",
             (unsigned)session_id, (unsigned)slice_id,
             (unsigned long long)amount_micro_usdc);

    xSemaphoreTake(s_batch.lock, portMAX_DELAY);
    if (s_batch.count > 0 && session_id != s_batch.sid) settle_flush_locked(); // session changed → flush first
    if (s_batch.count == 0) s_batch.sid = session_id;     // batch is per-session
    if (s_batch.count < SETTLE_BATCH_MAX) {
        s_batch.proofs[s_batch.count] = strdup(auth_json);
        if (s_batch.proofs[s_batch.count]) s_batch.count++;
    }
    if (s_batch.count >= (int)s_cfg.batch_size) settle_flush_locked();
    xSemaphoreGive(s_batch.lock);
}

static void settle_flush_timer_cb(TimerHandle_t t)
{
    (void)t;
    xSemaphoreTake(s_batch.lock, portMAX_DELAY);
    settle_flush_locked();             // publish any partial batch
    xSemaphoreGive(s_batch.lock);
}

// Telemetry hook: seller emits compact JSON events. Mirror to console + MQTT
// (ecandle/<id>/nanopay) for the cloud /demo visualization.
static void on_seller_event(const char *json_event)
{
    printf("[nanopay] %s\n", json_event);
    if (s_mqtt && s_mqtt_up) {
        char topic[40];
        snprintf(topic, sizeof topic, "ecandle/%s/nanopay", s_device_id);
        esp_mqtt_client_publish(s_mqtt, topic, json_event, 0, 0, 0);
    }
}

/* ───────────────────────── MQTT ───────────────────────── */
// Path A (BurnIntent) command handler — defined later (needs the device keypair).
static void handle_sign_burn_intent(const char *payload, int len);

// Topic the cloud burn-intent-worker publishes sign requests to.
static void burn_intent_cmd_topic(char *buf, size_t n)
{
    snprintf(buf, n, "ecandle/%s/cmd/sign_burn_intent", s_device_id);
}

static void mqtt_event_cb(void *handler_args, esp_event_base_t base,
                          int32_t event_id, void *event_data)
{
    (void)handler_args; (void)base;
    esp_mqtt_event_handle_t e = (esp_mqtt_event_handle_t)event_data;
    switch ((esp_mqtt_event_id_t)event_id) {
    case MQTT_EVENT_CONNECTED: {
        s_mqtt_up = true;
        ESP_LOGI(TAG, "MQTT connected (%s)", CONFIG_DEMO_MQTT_BROKER_URI);
        char topic[56];
        burn_intent_cmd_topic(topic, sizeof topic);   // Path A: accept sign requests
        esp_mqtt_client_subscribe(s_mqtt, topic, 1);
        ESP_LOGI(TAG, "subscribed %s", topic);
        break;
    }
    case MQTT_EVENT_DISCONNECTED:
        s_mqtt_up = false;
        ESP_LOGW(TAG, "MQTT disconnected");
        break;
    case MQTT_EVENT_DATA: {
        // Payloads are small (request_id + 64-hex digest) → single chunk.
        char topic[56];
        burn_intent_cmd_topic(topic, sizeof topic);
        if (e->topic_len == (int)strlen(topic) &&
            strncmp(e->topic, topic, e->topic_len) == 0) {
            handle_sign_burn_intent(e->data, e->data_len);
        }
        break;
    }
    default:
        break;
    }
}

static void mqtt_start(void)
{
    if (s_mqtt) return;
    esp_mqtt_client_config_t cfg = {
        .broker.address.uri = CONFIG_DEMO_MQTT_BROKER_URI,
    };
    s_mqtt = esp_mqtt_client_init(&cfg);
    if (!s_mqtt) { ESP_LOGE(TAG, "mqtt init failed"); return; }
    esp_mqtt_client_register_event(s_mqtt, ESP_EVENT_ANY_ID, mqtt_event_cb, NULL);
    esp_mqtt_client_start(s_mqtt);
}

/* ───────────────────────── WiFi (station) ───────────────────────── */
static bool s_creds_from_nvs;       // true if station creds came from the portal
static int  s_wifi_fails;           // consecutive disconnects before first got-IP

// Provisioned creds that the AP keeps rejecting (wrong password) would otherwise
// trap the device retrying forever. After this many failures, wipe the saved
// creds and reboot into the captive portal so the user can re-enter them. Only
// applies to portal-provisioned creds — a compile-time default is left alone.
#define WIFI_FAIL_LIMIT 10

static void wifi_event_cb(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        if (s_creds_from_nvs && ++s_wifi_fails >= WIFI_FAIL_LIMIT) {
            ESP_LOGW(TAG, "saved WiFi creds rejected after %d tries — returning to captive portal", s_wifi_fails);
            wifi_prov_erase();
            vTaskDelay(pdMS_TO_TICKS(200));
            esp_restart();
        }
        ESP_LOGW(TAG, "wifi disconnected, retrying (%d)", s_wifi_fails);
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        s_wifi_fails = 0;
        ESP_LOGI(TAG, "wifi got IP");
        if (!esp_sntp_enabled()) {          // valid slice timestamps need a real clock
            esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
            esp_sntp_setservername(0, "pool.ntp.org");
            esp_sntp_init();
        }
        mqtt_start();
    }
}

static void wifi_start(void)
{
    // esp_netif_init() is done once in app_main (shared with the captive portal).
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t wic = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&wic));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_cb, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_cb, NULL, NULL));

    // Credentials come from the captive portal (NVS); fall back to the
    // compile-time default so the team's hardcoded-creds demo still works.
    char ssid[33] = {0}, pass[65] = {0};
    s_creds_from_nvs = wifi_prov_load(ssid, sizeof ssid, pass, sizeof pass);
    if (!s_creds_from_nvs) {
        strncpy(ssid, CONFIG_DEMO_WIFI_SSID, sizeof ssid - 1);
        strncpy(pass, CONFIG_DEMO_WIFI_PASSWORD, sizeof pass - 1);
    }
    // Safe diagnostic: SSID + password LENGTH only (never the password itself).
    ESP_LOGI(TAG, "wifi creds: ssid='%s' pass_len=%d source=%s",
             ssid, (int)strlen(pass), s_creds_from_nvs ? "portal/NVS" : "build-default");

    wifi_config_t wc = { 0 };
    strncpy((char *)wc.sta.ssid, ssid, sizeof wc.sta.ssid - 1);
    strncpy((char *)wc.sta.password, pass, sizeof wc.sta.password - 1);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_LOGI(TAG, "wifi connecting to '%s'", ssid);
}

/* ───────────────────────── NimBLE advertising ───────────────────────── */
static int ble_gap_event_cb(struct ble_gap_event *event, void *arg);

static void ble_advertise(void)
{
    struct ble_hs_adv_fields fields;
    memset(&fields, 0, sizeof(fields));
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.tx_pwr_lvl_is_present = 1;
    fields.tx_pwr_lvl = BLE_HS_ADV_TX_PWR_LVL_AUTO;
    fields.uuids16 = (ble_uuid16_t[]){ BLE_UUID16_INIT(BOAT_NANO_SVC_UUID16) };
    fields.num_uuids16 = 1;
    fields.uuids16_is_complete = 1;

    uint16_t price = boat_seller_adv_price_uslice();
    uint8_t mfg[6] = {
        0xFF, 0xFF,
        (uint8_t)(price & 0xFF), (uint8_t)((price >> 8) & 0xFF),
        15,                          // available Wh (nominal, demo)
        boat_seller_adv_state(),     // 0=IDLE / 1=busy
    };
    _Static_assert(BOAT_NANO_ADV_STATE_OFFSET == 5, "adv state byte offset");
    fields.mfg_data = mfg;
    fields.mfg_data_len = sizeof(mfg);

    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) { ESP_LOGE(TAG, "adv_set_fields rc=%d", rc); return; }

    struct ble_hs_adv_fields rsp;             // name in scan response (31 B limit)
    memset(&rsp, 0, sizeof(rsp));
    const char *name = ble_svc_gap_device_name();
    rsp.name = (uint8_t *)name;
    rsp.name_len = strlen(name);
    rsp.name_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) ESP_LOGW(TAG, "adv_rsp_set_fields rc=%d", rc);

    struct ble_gap_adv_params params;
    memset(&params, 0, sizeof(params));
    params.conn_mode = BLE_GAP_CONN_MODE_UND;
    params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    rc = ble_gap_adv_start(own_addr_type, NULL, BLE_HS_FOREVER, &params, ble_gap_event_cb, NULL);
    if (rc != 0) { ESP_LOGE(TAG, "adv_start rc=%d", rc); return; }
    ESP_LOGI(TAG, "advertising as '%s' (state=%u)", name, boat_seller_adv_state());
}

static int ble_gap_event_cb(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_LINK_ESTAB:
        if (event->connect.status == 0) boat_seller_on_connect(event->connect.conn_handle);
        else ble_advertise();
        return 0;
    case BLE_GAP_EVENT_DISCONNECT:
        boat_seller_on_disconnect(event->disconnect.conn.conn_handle, event->disconnect.reason);
        ble_advertise();
        return 0;
    case BLE_GAP_EVENT_ADV_COMPLETE:
        ble_advertise();
        return 0;
    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "mtu=%d", event->mtu.value);
        return 0;
    case BLE_GAP_EVENT_REPEAT_PAIRING:
        return BLE_GAP_REPEAT_PAIRING_RETRY;
    default:
        return 0;
    }
}

static void ble_on_sync(void)
{
    int rc = ble_hs_util_ensure_addr(0);
    if (rc != 0) { ESP_LOGE(TAG, "ensure_addr %d", rc); return; }
    rc = ble_hs_id_infer_auto(0, &own_addr_type);
    if (rc != 0) { ESP_LOGE(TAG, "infer_auto %d", rc); return; }
    ble_advertise();
}

static void ble_on_reset(int reason) { ESP_LOGW(TAG, "host reset: %d", reason); }
static void ble_host_task(void *param) { (void)param; nimble_port_run(); nimble_port_freertos_deinit(); }

/* ───────────────────────── synthetic AC power source ───────────────────────── */
static boat_keypair_t s_kp;
static bool s_have_identity;

/* ───────────────────────── Path A: BurnIntent sign-digest ───────────────────────── */
// The cloud burn-intent-worker computes the full EIP-712 BurnIntent digest
// (Circle "GatewayWallet" domain — distinct from Path B's "GatewayWalletBatched")
// and sends only the 32-byte digest. The device blind-signs it with its
// secp256k1 EOA key — the SAME EOA that holds the seller's accumulated Circle
// Gateway credit, so signing a BurnIntent withdraws that credit on-chain via
// gatewayMint. NOTE: the device does NOT reconstruct/verify the BurnIntent
// contents (trust is delegated to the worker that built the digest).
//   in : ecandle/<id>/cmd/sign_burn_intent  {"request_id":"…","digest":"0x<64hex>"}
//   out: ecandle/<id>/burn_intent_sig       {"request_id":"…","ok":true,
//                                             "signature":"0x<r‖s‖v 130hex>",
//                                             "signer_address":"0x<40hex>"}
static void publish_burn_intent_result(const char *json)
{
    if (!s_mqtt || !s_mqtt_up) return;
    char topic[56];
    snprintf(topic, sizeof topic, "ecandle/%s/burn_intent_sig", s_device_id);
    esp_mqtt_client_publish(s_mqtt, topic, json, 0, /*qos*/1, /*retain*/0);
}

static void publish_burn_intent_failure(const char *req_id)
{
    char out[128];
    snprintf(out, sizeof out, "{\"request_id\":\"%s\",\"ok\":false}", req_id ? req_id : "");
    publish_burn_intent_result(out);
}

static void handle_sign_burn_intent(const char *payload, int len)
{
    cJSON *json = cJSON_ParseWithLength(payload, len);
    if (!json) { ESP_LOGW(TAG, "sign_burn_intent: invalid JSON"); publish_burn_intent_failure(""); return; }

    cJSON *jrid = cJSON_GetObjectItem(json, "request_id");
    const char *rid = (jrid && cJSON_IsString(jrid)) ? jrid->valuestring : "";

    cJSON *jd = cJSON_GetObjectItem(json, "digest");
    if (!jd || !cJSON_IsString(jd)) {
        ESP_LOGW(TAG, "sign_burn_intent: missing digest");
        publish_burn_intent_failure(rid); cJSON_Delete(json); return;
    }
    const char *hex = jd->valuestring;
    if (hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) hex += 2;
    if (strlen(hex) != 64) {                       // strict: exactly 32 bytes
        ESP_LOGW(TAG, "sign_burn_intent: digest must be 32 bytes");
        publish_burn_intent_failure(rid); cJSON_Delete(json); return;
    }
    uint8_t digest[32];
    for (int i = 0; i < 32; i++) {
        char hi = hex[i*2], lo = hex[i*2 + 1];
        int hv = (hi <= '9') ? (hi - '0') : ((hi & 0xdf) - 'A' + 10);
        int lv = (lo <= '9') ? (lo - '0') : ((lo & 0xdf) - 'A' + 10);
        if (hv < 0 || hv > 15 || lv < 0 || lv > 15) {
            ESP_LOGW(TAG, "sign_burn_intent: bad digest hex");
            publish_burn_intent_failure(rid); cJSON_Delete(json); return;
        }
        digest[i] = (uint8_t)((hv << 4) | lv);
    }

    if (!s_have_identity) {
        ESP_LOGW(TAG, "sign_burn_intent: no device identity");
        publish_burn_intent_failure(rid); cJSON_Delete(json); return;
    }
    uint8_t sig[65];                                // r(32)+s(32)+v(1), v in {27,28}
    if (boat_secp256k1_sign(&s_kp, digest, sig) != BOAT_OK) {
        ESP_LOGW(TAG, "sign_burn_intent: sign failed");
        publish_burn_intent_failure(rid); cJSON_Delete(json); return;
    }

    char sighex[2 + 130 + 1];
    sighex[0] = '0'; sighex[1] = 'x';
    static const char H[] = "0123456789abcdef";
    for (int i = 0; i < 65; i++) {
        sighex[2 + i*2]     = H[sig[i] >> 4];
        sighex[2 + i*2 + 1] = H[sig[i] & 0xf];
    }
    sighex[2 + 130] = '\0';

    char out[300];
    snprintf(out, sizeof out,
             "{\"request_id\":\"%s\",\"ok\":true,\"signature\":\"%s\",\"signer_address\":\"%s\"}",
             rid, sighex, s_kp.eth_addr_hex);
    publish_burn_intent_result(out);
    ESP_LOGI(TAG, "BurnIntent signed request_id=%s signer=%s", rid, s_kp.eth_addr_hex);
    cJSON_Delete(json);
}

#define SYN_PEAK_W   120
#define SYN_RAMP_S    4
#define SYN_HOLD_S   60
// Off-phase must exceed the buyer's self-stop hysteresis (A-prime: ~30 s =
// 6 ticks x 5 s) so the buyer accumulates enough <5 W reads to close the
// stream before the ramp climbs back to peak. 45 s = 9 ticks, comfortable margin.
#define SYN_OFF_S    45

static void synthetic_power_task(void *arg)
{
    (void)arg;
    for (;;) {
        // Hold at 0 W until the clock is real (post-SNTP). At 0 W the buyer keeps
        // the stream closed (A-prime self-drive), so NO slice is billed with a
        // 1970 (expired) validity window the settlement layer would reject. Once
        // WiFi→SNTP syncs, the normal profile below starts. Zero extra coupling.
        if (!clock_synced()) {
            boat_seller_report_power_w(0);
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        for (int s = 1; s <= SYN_RAMP_S; s++) {
            boat_seller_report_power_w((uint16_t)(SYN_PEAK_W * s / SYN_RAMP_S));
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
        for (int s = 0; s < SYN_HOLD_S; s++) {
            boat_seller_report_power_w(SYN_PEAK_W);
            if (s_have_identity && (s % 10 == 0)) {
                if (!clock_synced()) {
                    ESP_LOGW(TAG, "clock not synced (WiFi/SNTP) — skipping attest");
                } else {
                    char payload[96];
                    snprintf(payload, sizeof payload,
                             "{\"metric\":\"ac_output_w\",\"value\":%d,\"synthetic\":true,\"ts\":%u}",
                             SYN_PEAK_W, (unsigned)time(NULL));
                    boat_attestation_t att;
                    if (boat_attest_create(&s_kp, payload, &att) == BOAT_OK)
                        ESP_LOGI(TAG, "attest(synthetic %dW): ed25519 ok (ts=%u)",
                                 SYN_PEAK_W, (unsigned)att.timestamp);
                }
            }
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
        for (int s = 0; s < SYN_OFF_S; s++) {       // buyer reads <5W → self-stops
            boat_seller_report_power_w(0);
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }
}

/* ───────────────────────── NimBLE init ───────────────────────── */
static int ble_init(void)
{
    int rc = nimble_port_init();
    if (rc != ESP_OK) { ESP_LOGE(TAG, "nimble_port_init %d", rc); return rc; }
    ble_hs_cfg.reset_cb = ble_on_reset;
    ble_hs_cfg.sync_cb  = ble_on_sync;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    boat_seller_register();             // 0xEE00 seller GATT family
    ble_svc_gap_device_name_set(s_device_id);
    ble_store_config_init();
    nimble_port_freertos_init(ble_host_task);
    return 0;
}

void app_main(void)
{
    ESP_LOGI(TAG, "arc-drone-show-demo: eCandle reference seller starting");

    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    ESP_ERROR_CHECK(esp_netif_init());      // shared by the portal and station paths

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_BT);
    snprintf(s_device_id, sizeof s_device_id, "ecandle-%02x%02x", mac[4], mac[5]);

    s_batch.lock = xSemaphoreCreateMutex();
    TimerHandle_t flush = xTimerCreate("settle_flush", pdMS_TO_TICKS(30000), pdTRUE, NULL,
                                       settle_flush_timer_cb);
    if (flush) xTimerStart(flush, 0);

    // No saved creds and no compile-time default → bring up the SoftAP captive
    // portal so the user can provision their WiFi from a phone. This blocks,
    // saves the submitted creds to NVS, and reboots into station mode.
    if (!wifi_prov_have_creds()) {
        ESP_LOGW(TAG, "no WiFi creds — launching SoftAP captive portal '%s'", s_device_id);
        wifi_prov_run_portal(s_device_id);   // does not return
    }

    // WiFi → (on got-IP) SNTP for valid timestamps + MQTT for the proof uplink.
    wifi_start();

    // MER identity: device EOA = the seller's receiver wallet.
    if (boat_crypto_init(&s_kp) == BOAT_OK) {
        s_have_identity = true;
        ESP_LOGI(TAG, "device identity (EOA): %s", s_kp.eth_addr_hex);
        boat_seller_set_receiver_wallet(s_kp.eth_address);
    } else {
        ESP_LOGE(TAG, "identity init failed — receiver wallet stays zero");
    }

    ble_init();

    boat_seller_init(&s_cfg);
    boat_seller_set_event_cb(on_seller_event);
    boat_seller_set_slice_proof_cb(on_slice_proof);

    // 8 KB stack: synthetic_power_task calls boat_attest_create (SHA-256 +
    // Ed25519/tweetnacl), which is stack-heavy — 4 KB overflows once the clock
    // syncs and attest actually runs (caught as a "syn_power" stack-protection
    // fault on hardware; the BLE-only build never synced so it never ran attest).
    xTaskCreate(synthetic_power_task, "syn_power", 8192, NULL, 4, NULL);

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        printf("[ecandle] seller=%s power=%uW mqtt=%s clock=%s heap=%lu\n",
               boat_seller_is_connected() ? "connected" : "advertising",
               boat_seller_current_power_w(),
               s_mqtt_up ? "up" : "down",
               clock_synced() ? "synced" : "1970",
               (unsigned long)esp_get_free_heap_size());
    }
}
