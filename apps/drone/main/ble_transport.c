/* SPDX-License-Identifier: MIT
 * Copyright 2026 TLAY / arc-drone-show-demo contributors
 *
 * ble_transport.c — NimBLE central transport for the boat-mer buyer engine.
 *
 * Responsibilities (BLE plumbing only — zero protocol logic):
 *   - scan, IDLE-gate the connect on the seller's advertised state byte
 *   - connect, exchange MTU, discover service 0xEE00 + its characteristics,
 *     subscribe to the seller->buyer notify characteristics
 *   - provide the four transport-vtable primitives (write/read/disconnect/reset)
 *   - feed GAP/GATT events into boat_buyer_on_{connect,disconnect,notify,
 *     read_result} and tick the engine every cfg.tick_ms
 *
 * Everything else — the A-prime power self-drive, per-slice validation, EIP-3009
 * signing, and the self-heal watchdog — lives in the boat-mer buyer engine and
 * is reached only through this thin shell.
 */
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "esp_system.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"

#include "boat_nano_wire.h"      /* canonical 0xEE00 UUIDs + adv layout */
#include "app_config.h"
#include "ble_transport.h"

static const char *TAG = "ble_drone";

/* ------------------------------------------------------------------ */
/* Module state                                                        */
/* ------------------------------------------------------------------ */

/* The engine this transport drives (set in drone_transport_init). */
static boat_buyer_ctx_t *s_ctx;

static bool     s_connected;
static uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;

/* 0xEE01..0xEE06 cached value handles, indexed by CHR_IDX(uuid). */
#define CHR_COUNT 6
#define CHR_IDX(u) ((int)((u) - BOAT_NANO_CHR_STREAM_REQUEST))   /* 0xEE01->0 .. 0xEE06->5 */
static uint16_t s_val_handle[CHR_COUNT];

/* 0xEE00 service handle range + per-chr descriptor end (for CCCD discovery). */
static uint16_t s_svc_start, s_svc_end;
static uint16_t s_def_handle[CHR_COUNT];

/* Seller->buyer notify characteristics we subscribe to. 0xEE05 is READ by the
 * engine's watchdog, not subscribed. */
static const uint16_t k_notify_uuids[] = {
    BOAT_NANO_CHR_STREAM_OFFER,    /* 0xEE02 */
    BOAT_NANO_CHR_SLICE_REQUEST,   /* 0xEE03 */
    BOAT_NANO_CHR_SESSION_CONTROL, /* 0xEE06 */
};
#define NUM_NOTIFY_CHRS (sizeof k_notify_uuids / sizeof k_notify_uuids[0])
static unsigned s_notify_idx;
/* Set when a CCCD write has been issued for the current chr: the subscribe-write
 * callback then owns advancing the cursor, so the descriptor-disc EDONE must not
 * also advance (else the cursor double-advances and on_connect fires repeatedly). */
static bool     s_cccd_pending;

static const ble_uuid16_t s_svc_uuid = BLE_UUID16_INIT(BOAT_NANO_SVC_UUID16);

static esp_timer_handle_t s_tick_timer;

static void scan_start(void);
static int  gap_event_cb(struct ble_gap_event *event, void *arg);

static void reset_handle_cache(void)
{
    memset(s_val_handle, 0, sizeof s_val_handle);
    memset(s_def_handle, 0, sizeof s_def_handle);
    s_svc_start = s_svc_end = 0;
    s_notify_idx = 0;
}

static uint16_t handle_to_uuid(uint16_t h)
{
    for (int i = 0; i < CHR_COUNT; i++)
        if (s_val_handle[i] == h)
            return (uint16_t)(BOAT_NANO_CHR_STREAM_REQUEST + i);
    return 0;
}

/* ------------------------------------------------------------------ */
/* Transport vtable — the only BLE I/O the engine can reach            */
/* ------------------------------------------------------------------ */

static int tr_write(void *u, uint16_t uuid16, const void *data, uint16_t len)
{
    (void)u;
    if (!s_connected) return BLE_HS_ENOTCONN;
    int idx = CHR_IDX(uuid16);
    if (idx < 0 || idx >= CHR_COUNT) return BLE_HS_EINVAL;
    uint16_t h = s_val_handle[idx];
    if (h == 0) return BLE_HS_ENOENT;
    /* Write-without-response. With the negotiated 512-byte MTU the ~400-byte
     * 0xEE04 proof JSON fits in a single ATT write (509-byte payload limit). */
    return ble_gattc_write_no_rsp_flat(s_conn_handle, h, data, len);
}

static int read_result_cb(uint16_t ch, const struct ble_gatt_error *error,
                          struct ble_gatt_attr *attr, void *arg)
{
    (void)ch;
    uint16_t uuid = (uint16_t)(uintptr_t)arg;
    uint8_t  buf[64];
    uint16_t n = 0;
    int status = error ? error->status : 0;
    if (status == 0 && attr != NULL && attr->om != NULL)
        ble_hs_mbuf_to_flat(attr->om, buf, sizeof buf, &n);
    /* Hand the read result (or the failure status) to the engine — a failed/
     * timed-out 0xEE05 read is how its watchdog detects a wedged seller. */
    boat_buyer_on_read_result(s_ctx, uuid, buf, n, status);
    return 0;
}

static int tr_read(void *u, uint16_t uuid16)
{
    (void)u;
    if (!s_connected) return BLE_HS_ENOTCONN;
    int idx = CHR_IDX(uuid16);
    if (idx < 0 || idx >= CHR_COUNT) return BLE_HS_EINVAL;
    uint16_t h = s_val_handle[idx];
    if (h == 0) return BLE_HS_ENOENT;
    return ble_gattc_read(s_conn_handle, h, read_result_cb, (void *)(uintptr_t)uuid16);
}

static int tr_disconnect(void *u)
{
    (void)u;
    if (!s_connected) return 0;
    return ble_gap_terminate(s_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
}

static void tr_hard_reset(void *u)
{
    (void)u;
    ESP_LOGE(TAG, "engine requested hard reset — esp_restart()");
    esp_restart();
}

static const boat_buyer_transport_t s_transport = {
    .write_chr  = tr_write,
    .read_chr   = tr_read,
    .disconnect = tr_disconnect,
    .hard_reset = tr_hard_reset,
};

const boat_buyer_transport_t *drone_transport_vtable(void)
{
    return &s_transport;
}

/* ------------------------------------------------------------------ */
/* Periodic tick — drives the engine's power self-drive + watchdog     */
/* ------------------------------------------------------------------ */

static void tick_cb(void *arg)
{
    (void)arg;
    boat_buyer_tick(s_ctx);
}

static void tick_start(uint32_t period_ms)
{
    const esp_timer_create_args_t args = { .callback = tick_cb, .name = "buyer_tick" };
    if (esp_timer_create(&args, &s_tick_timer) == ESP_OK)
        esp_timer_start_periodic(s_tick_timer, (uint64_t)period_ms * 1000);
    else
        ESP_LOGE(TAG, "esp_timer_create failed — power self-drive/watchdog won't run");
}

/* ------------------------------------------------------------------ */
/* GATT discovery: service -> characteristics -> CCCD subscribe        */
/* ------------------------------------------------------------------ */

static int subscribe_cb(uint16_t conn, const struct ble_gatt_error *error,
                        struct ble_gatt_attr *attr, void *arg);
static void subscribe_next(void);

static int dsc_disc_cb(uint16_t conn, const struct ble_gatt_error *error,
                       uint16_t chr_val_handle, const struct ble_gatt_dsc *dsc, void *arg)
{
    int idx = (int)(intptr_t)arg;
    if (error->status == 0 && dsc != NULL) {
        if (ble_uuid_u16(&dsc->uuid.u) == BLE_GATT_DSC_CLT_CFG_UUID16) {
            /* Found the CCCD — enable notifications (write 0x0001). On success the
             * write callback (subscribe_cb) advances the cursor, so flag it and
             * let EDONE below skip its own advance. */
            uint8_t val[2] = { 0x01, 0x00 };
            int rc = ble_gattc_write_flat(s_conn_handle, dsc->handle,
                                          val, sizeof val, subscribe_cb,
                                          (void *)(intptr_t)idx);
            if (rc == 0)
                s_cccd_pending = true;
            else
                ESP_LOGW(TAG, "CCCD write 0x%04x rc=%d", k_notify_uuids[s_notify_idx], rc);
        }
        return 0;
    }
    /* EDONE (end of descriptors) or an error: advance only if no CCCD write is in
     * flight for this chr — otherwise subscribe_cb owns the advance. */
    if (error->status != BLE_HS_EDONE)
        ESP_LOGW(TAG, "dsc disc error status=%d", error->status);
    if (!s_cccd_pending) {
        s_notify_idx++;
        subscribe_next();
    }
    return 0;
}

static int subscribe_cb(uint16_t conn, const struct ble_gatt_error *error,
                        struct ble_gatt_attr *attr, void *arg)
{
    (void)conn; (void)attr; (void)arg;
    if (error->status != 0)
        ESP_LOGW(TAG, "subscribe write status=%d", error->status);
    s_notify_idx++;
    subscribe_next();
    return 0;
}

static void subscribe_next(void)
{
    if (s_notify_idx >= NUM_NOTIFY_CHRS) {
        ESP_LOGI(TAG, "discovery+subscribe complete (EE02=%u EE03=%u EE05=%u EE06=%u) "
                      "— handing the link to the buyer engine",
                 s_val_handle[CHR_IDX(BOAT_NANO_CHR_STREAM_OFFER)],
                 s_val_handle[CHR_IDX(BOAT_NANO_CHR_SLICE_REQUEST)],
                 s_val_handle[CHR_IDX(BOAT_NANO_CHR_STREAM_STATUS)],
                 s_val_handle[CHR_IDX(BOAT_NANO_CHR_SESSION_CONTROL)]);
        /* Link is ready: the engine now self-drives the session from 0xEE05
         * ac_output and arms its watchdog on the next tick. */
        boat_buyer_on_connect(s_ctx);
        return;
    }

    uint16_t uuid = k_notify_uuids[s_notify_idx];
    int idx = CHR_IDX(uuid);
    uint16_t start = s_val_handle[idx];
    if (start == 0) {
        ESP_LOGW(TAG, "notify chr 0x%04x not discovered — skip", uuid);
        s_notify_idx++;
        subscribe_next();
        return;
    }
    /* Descriptor range = (val_handle .. next def_handle - 1), else service end. */
    uint16_t end = s_svc_end;
    for (int i = 0; i < CHR_COUNT; i++)
        if (s_def_handle[i] > start && s_def_handle[i] - 1 < end)
            end = s_def_handle[i] - 1;
    if (end <= start) {
        ESP_LOGW(TAG, "0x%04x has no descriptor range — skip", uuid);
        s_notify_idx++;
        subscribe_next();
        return;
    }
    s_cccd_pending = false;   /* reset per-chr; set true once a CCCD write is issued */
    int rc = ble_gattc_disc_all_dscs(s_conn_handle, start, end, dsc_disc_cb,
                                     (void *)(intptr_t)idx);
    if (rc != 0) {
        ESP_LOGW(TAG, "disc_all_dscs 0x%04x rc=%d", uuid, rc);
        s_notify_idx++;
        subscribe_next();
    }
}

static int chr_disc_cb(uint16_t conn, const struct ble_gatt_error *error,
                       const struct ble_gatt_chr *chr, void *arg)
{
    (void)conn; (void)arg;
    if (error->status == 0 && chr != NULL) {
        uint16_t u = ble_uuid_u16(&chr->uuid.u);
        if (u >= BOAT_NANO_CHR_STREAM_REQUEST && u <= BOAT_NANO_CHR_SESSION_CONTROL) {
            int idx = CHR_IDX(u);
            s_def_handle[idx] = chr->def_handle;
            s_val_handle[idx] = chr->val_handle;
            ESP_LOGI(TAG, "  chr 0x%04x val=%u props=0x%02x", u, chr->val_handle, chr->properties);
        }
        return 0;
    }
    if (error->status == BLE_HS_EDONE) {
        s_notify_idx = 0;
        subscribe_next();
        return 0;
    }
    ESP_LOGW(TAG, "chr disc error status=%d", error->status);
    return 0;
}

static int svc_disc_cb(uint16_t conn, const struct ble_gatt_error *error,
                       const struct ble_gatt_svc *svc, void *arg)
{
    (void)conn; (void)arg;
    if (error->status == 0 && svc != NULL) {
        s_svc_start = svc->start_handle;
        s_svc_end = svc->end_handle;
        return 0;
    }
    if (error->status == BLE_HS_EDONE) {
        if (s_svc_start == 0) {
            ESP_LOGW(TAG, "0x%04x not found on peer — disconnecting", BOAT_NANO_SVC_UUID16);
            ble_gap_terminate(s_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
            return 0;
        }
        int rc = ble_gattc_disc_all_chrs(s_conn_handle, s_svc_start, s_svc_end,
                                         chr_disc_cb, NULL);
        if (rc != 0) ESP_LOGW(TAG, "disc_all_chrs rc=%d", rc);
        return 0;
    }
    ESP_LOGW(TAG, "svc disc error status=%d", error->status);
    return 0;
}

static int mtu_cb(uint16_t conn, const struct ble_gatt_error *error, uint16_t mtu, void *arg)
{
    (void)conn; (void)arg;
    /* error is NULL on the synchronous-failure fallback path from
     * BLE_GAP_EVENT_CONNECT (exchange_mtu returned non-zero) — guard it like
     * read_result_cb does; we proceed to discovery at the default MTU either way. */
    if (error && error->status == 0) ESP_LOGI(TAG, "MTU = %u", mtu);
    int rc = ble_gattc_disc_svc_by_uuid(s_conn_handle, &s_svc_uuid.u, svc_disc_cb, NULL);
    if (rc != 0) ESP_LOGW(TAG, "disc_svc_by_uuid rc=%d", rc);
    return 0;
}

/* ------------------------------------------------------------------ */
/* Scan + IDLE-gate                                                    */
/* ------------------------------------------------------------------ */

static bool adv_has_nano_svc(const struct ble_hs_adv_fields *f)
{
    for (int i = 0; i < f->num_uuids16; i++)
        if (ble_uuid_u16(&f->uuids16[i].u) == BOAT_NANO_SVC_UUID16)
            return true;
    return false;
}

static void try_connect(const struct ble_gap_disc_desc *disc)
{
    ble_gap_disc_cancel();
    ble_addr_t peer = disc->addr;
    /* 6s supervision timeout (default 2.56s flapped under BT/Wi-Fi coexistence
     * MQTT bursts; 6s drove steady-state disconnects to ~0 in bench testing). */
    struct ble_gap_conn_params cp = {
        .scan_itvl = 0x0010, .scan_window = 0x0010,
        .itvl_min = BLE_GAP_INITIAL_CONN_ITVL_MIN,
        .itvl_max = BLE_GAP_INITIAL_CONN_ITVL_MAX,
        .latency = 0,
        .supervision_timeout = 600,   /* 600 * 10ms = 6.0s */
        .min_ce_len = 0, .max_ce_len = 0,
    };
    int rc = ble_gap_connect(BLE_OWN_ADDR_PUBLIC, &peer, 30000, &cp, gap_event_cb, NULL);
    if (rc != 0) {
        ESP_LOGW(TAG, "ble_gap_connect rc=%d — rescan", rc);
        scan_start();
    }
}

static int gap_event_cb(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_DISC: {
        struct ble_hs_adv_fields f;
        if (ble_hs_adv_parse_fields(&f, event->disc.data, event->disc.length_data) != 0)
            return 0;
        if (!adv_has_nano_svc(&f)) return 0;
        /* IDLE-gate: connect only when the seller advertises IDLE (mfg[5]==0).
         * boat_buyer_adv_is_idle returns true when no mfg_data (back-compat). */
        if (!boat_buyer_adv_is_idle(f.mfg_data, f.mfg_data_len)) {
            ESP_LOGI(TAG, "seller busy (adv state != IDLE) — waiting");
            return 0;
        }
        try_connect(&event->disc);
        return 0;
    }

    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            s_connected = true;
            s_conn_handle = event->connect.conn_handle;
            reset_handle_cache();
            ESP_LOGI(TAG, "connected handle=%u — exchanging MTU then discovering 0x%04x",
                     s_conn_handle, BOAT_NANO_SVC_UUID16);
            if (ble_gattc_exchange_mtu(s_conn_handle, mtu_cb, NULL) != 0)
                mtu_cb(s_conn_handle, NULL, 0, NULL);
        } else {
            ESP_LOGW(TAG, "connect failed status=%d — rescan", event->connect.status);
            scan_start();
        }
        return 0;

    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "disconnected reason=%d", event->disconnect.reason);
        s_connected = false;
        s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        reset_handle_cache();
        boat_buyer_on_disconnect(s_ctx);
        scan_start();
        return 0;

    case BLE_GAP_EVENT_NOTIFY_RX: {
        uint16_t uuid = handle_to_uuid(event->notify_rx.attr_handle);
        if (uuid == 0) return 0;
        uint8_t  buf[128];   /* largest wire payload is the 88-byte SliceRequest */
        uint16_t n = 0;
        if (ble_hs_mbuf_to_flat(event->notify_rx.om, buf, sizeof buf, &n) != 0)
            return 0;
        /* Route every 0xEE02/03/06 notification into the engine; it validates,
         * signs, and writes any response (0xEE04/0xEE01/0xEE06) back through the
         * vtable. The transport stays oblivious to protocol semantics. */
        boat_buyer_on_notify(s_ctx, uuid, buf, n);
        return 0;
    }

    default:
        return 0;
    }
}

/* ------------------------------------------------------------------ */
/* Host lifecycle                                                      */
/* ------------------------------------------------------------------ */

static void scan_start(void)
{
    struct ble_gap_disc_params p = {0};
    p.passive = 0;             /* active scan to also pull the scan-response name */
    p.filter_duplicates = 1;
    p.itvl = 0x0080;
    p.window = 0x0050;
    int rc = ble_gap_disc(BLE_OWN_ADDR_PUBLIC, BLE_HS_FOREVER, &p, gap_event_cb, NULL);
    if (rc != 0 && rc != BLE_HS_EALREADY)
        ESP_LOGW(TAG, "ble_gap_disc rc=%d", rc);
}

static void on_sync(void)
{
    if (ble_hs_util_ensure_addr(0) != 0) {
        ESP_LOGE(TAG, "ble_hs_util_ensure_addr failed");
        return;
    }
    ESP_LOGI(TAG, "host sync — scanning for IDLE seller (svc=0x%04x)", BOAT_NANO_SVC_UUID16);
    scan_start();
}

static void on_host_reset(int reason) { ESP_LOGW(TAG, "host reset reason=%d", reason); }

static void host_task(void *param)
{
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void drone_transport_init(boat_buyer_ctx_t *ctx)
{
    s_ctx = ctx;

    if (nimble_port_init() != 0) {
        ESP_LOGE(TAG, "nimble_port_init failed");
        return;
    }
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_host_reset;

    /* Tick the engine on the same 5s cadence the config expects (power
     * self-drive sampling + watchdog liveness probe). Safe to arm before host
     * sync — boat_buyer_tick is a no-op until the engine is connected. */
    tick_start(DRONE_TICK_MS);

    /* Central-only, but BLE_GATTS stays enabled in sdkconfig so NimBLE compiles
     * in the inbound-notification dispatch path (a pure central silently drops
     * notifications otherwise). We never register a GATT server or advertise. */
    nimble_port_freertos_init(host_task);
}
