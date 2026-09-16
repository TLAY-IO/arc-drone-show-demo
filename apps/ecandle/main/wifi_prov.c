// SPDX-License-Identifier: MIT
//
// SoftAP captive-portal WiFi provisioning — see wifi_prov.h.

#include "wifi_prov.h"

#include <string.h>
#include <ctype.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_http_server.h"
#include "nvs.h"
#include "sdkconfig.h"
#include "lwip/sockets.h"

static const char *TAG = "wifi_prov";

#define PROV_NS  "wifiprov"

/* ───────────────────────── NVS credential store ───────────────────────── */
bool wifi_prov_load(char *ssid, size_t ssid_len, char *pass, size_t pass_len)
{
    nvs_handle_t h;
    if (nvs_open(PROV_NS, NVS_READONLY, &h) != ESP_OK) return false;
    size_t sl = ssid_len, pl = pass_len;
    esp_err_t es = nvs_get_str(h, "ssid", ssid, &sl);
    esp_err_t ep = nvs_get_str(h, "pass", pass, &pl);
    nvs_close(h);
    if (es != ESP_OK) return false;
    if (ep != ESP_OK && pass_len) pass[0] = '\0';   // open networks have no pass
    return ssid[0] != '\0';
}

void wifi_prov_save(const char *ssid, const char *pass)
{
    nvs_handle_t h;
    ESP_ERROR_CHECK(nvs_open(PROV_NS, NVS_READWRITE, &h));
    ESP_ERROR_CHECK(nvs_set_str(h, "ssid", ssid));
    ESP_ERROR_CHECK(nvs_set_str(h, "pass", pass ? pass : ""));
    ESP_ERROR_CHECK(nvs_commit(h));
    nvs_close(h);
    ESP_LOGI(TAG, "saved WiFi creds for '%s'", ssid);
}

void wifi_prov_erase(void)
{
    nvs_handle_t h;
    if (nvs_open(PROV_NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_erase_all(h);
    nvs_commit(h);
    nvs_close(h);
    ESP_LOGW(TAG, "erased saved WiFi creds");
}

bool wifi_prov_have_creds(void)
{
    char s[33] = {0}, p[65] = {0};
    if (wifi_prov_load(s, sizeof s, p, sizeof p)) return true;
    return strlen(CONFIG_DEMO_WIFI_SSID) > 0;   // compile-time default counts
}

/* ───────────────────────── nearby-AP scan cache ───────────────────────── */
static char s_ssids[24][33];
static int  s_ssid_count;

static void scan_aps(void)
{
    wifi_scan_config_t sc = { 0 };
    if (esp_wifi_scan_start(&sc, true) != ESP_OK) return;
    uint16_t n = 0;
    esp_wifi_scan_get_ap_num(&n);
    if (n > 24) n = 24;
    wifi_ap_record_t recs[24];
    if (esp_wifi_scan_get_ap_records(&n, recs) != ESP_OK) return;
    s_ssid_count = 0;
    for (int i = 0; i < n; i++) {
        const char *name = (const char *)recs[i].ssid;
        if (name[0] == '\0') continue;
        bool dup = false;
        for (int j = 0; j < s_ssid_count; j++)
            if (strcmp(s_ssids[j], name) == 0) { dup = true; break; }
        if (dup) continue;
        strncpy(s_ssids[s_ssid_count], name, 32);
        s_ssids[s_ssid_count][32] = '\0';
        if (++s_ssid_count >= 24) break;
    }
    ESP_LOGI(TAG, "scan found %d networks", s_ssid_count);
}

/* ───────────────────────── DNS hijack (catch-all → 192.168.4.1) ───────── */
// Answer every A query with the SoftAP IP so the phone's captive-portal probe
// resolves to us and the OS pops the sign-in page automatically.
static void dns_task(void *arg)
{
    (void)arg;
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (sock < 0) { ESP_LOGE(TAG, "dns socket failed"); vTaskDelete(NULL); return; }
    struct sockaddr_in sa = {
        .sin_family = AF_INET,
        .sin_port = htons(53),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(sock, (struct sockaddr *)&sa, sizeof sa) < 0) {
        ESP_LOGE(TAG, "dns bind failed");
        close(sock);
        vTaskDelete(NULL);
        return;
    }
    uint8_t buf[512];
    for (;;) {
        struct sockaddr_in client;
        socklen_t cl = sizeof client;
        int n = recvfrom(sock, buf, sizeof buf, 0, (struct sockaddr *)&client, &cl);
        if (n < 12 || n > (int)(sizeof buf - 16)) continue;   // header + room for answer
        // Turn the query into a response: QR=1, RA=1, ANCOUNT=1, drop NS/AR.
        buf[2] = 0x81;                 // QR=1, opcode 0, RD copied loosely
        buf[3] = 0x80;                 // RA=1, RCODE 0
        buf[6] = 0x00; buf[7] = 0x01;  // ANCOUNT = 1
        buf[8] = 0; buf[9] = 0;        // NSCOUNT = 0
        buf[10] = 0; buf[11] = 0;      // ARCOUNT = 0
        uint8_t *p = buf + n;          // append answer after the question
        *p++ = 0xC0; *p++ = 0x0C;                          // name → offset 12
        *p++ = 0x00; *p++ = 0x01;                          // type A
        *p++ = 0x00; *p++ = 0x01;                          // class IN
        *p++ = 0x00; *p++ = 0x00; *p++ = 0x00; *p++ = 0x3C; // TTL 60s
        *p++ = 0x00; *p++ = 0x04;                          // RDLENGTH 4
        *p++ = 192; *p++ = 168; *p++ = 4; *p++ = 1;        // 192.168.4.1
        sendto(sock, buf, p - buf, 0, (struct sockaddr *)&client, cl);
    }
}

/* ───────────────────────── HTTP captive portal ───────────────────────── */
static const char FORM_HEAD[] =
    "<!doctype html><html><head><meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>eCandle WiFi</title></head>"
    "<body style='font-family:sans-serif;max-width:420px;margin:24px auto;padding:0 14px'>"
    "<h2>eCandle WiFi Setup</h2>"
    "<form method=POST action=/save>"
    "<label>WiFi Network</label><br>"
    "<select name=ssid style='width:100%;padding:8px;margin:6px 0'>";
static const char FORM_TAIL[] =
    "</select><br>"
    "<label>Password</label><br>"
    // autocapitalize/autocorrect/spellcheck off: mobile captive-portal webviews
    // otherwise silently capitalize or autocorrect the password field, producing
    // a same-length but wrong password that fails the WPA2 handshake.
    "<input name=pass type=password autocapitalize=off autocorrect=off "
    "autocomplete=off spellcheck=false style='width:100%;padding:8px;margin:6px 0'>"
    "<br><label style='font-size:90%'>"
    "<input type=checkbox onclick=\"var p=document.getElementsByName('pass')[0];"
    "p.type=this.checked?'text':'password'\"> Show password</label><br>"
    "<button type=submit style='width:100%;padding:10px;margin-top:10px'>Connect</button>"
    "</form></body></html>";

// HTML-escape into `out`. SSIDs are attacker-controllable (anyone can broadcast
// one), so they must be escaped before going into the page or a crafted SSID
// like "</option><script>…" would be a captive-portal XSS.
static void html_escape(const char *in, char *out, size_t out_len)
{
    size_t o = 0;
    for (const char *p = in; *p && o + 6 < out_len; p++) {
        const char *rep = NULL;
        switch (*p) {
            case '<':  rep = "&lt;";   break;
            case '>':  rep = "&gt;";   break;
            case '&':  rep = "&amp;";  break;
            case '"':  rep = "&quot;"; break;
            case '\'': rep = "&#39;";  break;
        }
        if (rep) { size_t l = strlen(rep); memcpy(out + o, rep, l); o += l; }
        else     { out[o++] = *p; }
    }
    out[o] = '\0';
}

static esp_err_t form_get(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_sendstr_chunk(req, FORM_HEAD);
    for (int i = 0; i < s_ssid_count; i++) {
        char esc[200];
        html_escape(s_ssids[i], esc, sizeof esc);
        httpd_resp_sendstr_chunk(req, "<option>");
        httpd_resp_sendstr_chunk(req, esc);
        httpd_resp_sendstr_chunk(req, "</option>");
    }
    httpd_resp_sendstr_chunk(req, FORM_TAIL);
    httpd_resp_sendstr_chunk(req, NULL);
    return ESP_OK;
}

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return 0;
}

static void urldecode(char *s)
{
    char *o = s;
    for (char *p = s; *p; p++) {
        if (*p == '+') {
            *o++ = ' ';
        } else if (*p == '%' && isxdigit((unsigned char)p[1]) && isxdigit((unsigned char)p[2])) {
            *o++ = (char)(hexval(p[1]) * 16 + hexval(p[2]));
            p += 2;
        } else {
            *o++ = *p;
        }
    }
    *o = '\0';
}

// Extract value of `key` from an application/x-www-form-urlencoded body.
static void form_field(const char *body, const char *key, char *out, size_t out_len)
{
    out[0] = '\0';
    char pat[20];
    snprintf(pat, sizeof pat, "%s=", key);
    const char *p = strstr(body, pat);
    // require the match to start the body or follow an '&' so "ssid" never
    // matches inside another field's value
    while (p && p != body && p[-1] != '&')
        p = strstr(p + 1, pat);
    if (!p) return;
    p += strlen(pat);
    size_t i = 0;
    while (*p && *p != '&' && i < out_len - 1) out[i++] = *p++;
    out[i] = '\0';
}

static esp_err_t save_post(httpd_req_t *req)
{
    char buf[320];
    int want = req->content_len < (int)(sizeof buf - 1) ? req->content_len : (int)(sizeof buf - 1);
    int total = 0;
    while (total < want) {                       // body may span TCP segments
        int r = httpd_req_recv(req, buf + total, want - total);
        if (r == HTTPD_SOCK_ERR_TIMEOUT) continue;
        if (r <= 0) return ESP_FAIL;
        total += r;
    }
    buf[total] = '\0';

    char ssid[33] = {0}, pass[65] = {0};
    form_field(buf, "ssid", ssid, sizeof ssid);
    form_field(buf, "pass", pass, sizeof pass);
    urldecode(ssid);
    urldecode(pass);

    if (ssid[0] == '\0') {
        httpd_resp_set_type(req, "text/html; charset=utf-8");
        httpd_resp_sendstr(req, "<html><body><h2>WiFi network name cannot be empty</h2><a href=/>Back</a></body></html>");
        return ESP_OK;
    }

    wifi_prov_save(ssid, pass);
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_sendstr(req,
        "<html><body style='font-family:sans-serif;text-align:center;margin-top:60px'>"
        "<h2>Saved ✓</h2><p>The device is rebooting and connecting to WiFi…</p></body></html>");
    ESP_LOGI(TAG, "creds received via portal, rebooting into station mode");
    vTaskDelay(pdMS_TO_TICKS(1500));
    esp_restart();
    return ESP_OK;   // unreachable
}

static void start_httpd(void)
{
    httpd_handle_t srv = NULL;
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    cfg.lru_purge_enable = true;
    cfg.stack_size = 6144;        // save_post writes NVS + esp_restart
    if (httpd_start(&srv, &cfg) != ESP_OK) { ESP_LOGE(TAG, "httpd start failed"); return; }

    httpd_uri_t save = { .uri = "/save", .method = HTTP_POST, .handler = save_post };
    httpd_register_uri_handler(srv, &save);
    httpd_uri_t any = { .uri = "/*", .method = HTTP_GET, .handler = form_get };
    httpd_register_uri_handler(srv, &any);
}

/* ───────────────────────── portal entry point ───────────────────────── */
// Runs on its own generous stack: esp_wifi_init + the scan record array are too
// heavy for the default ~3.6 KB main-task stack (overflows -> stack-protection
// fault). Lives until save_post() reboots the device.
static void portal_task(void *arg)
{
    const char *ap_ssid = (const char *)arg;

    // esp_netif_init() + esp_event_loop_create_default() are done by app_main.
    esp_netif_create_default_wifi_ap();
    esp_netif_create_default_wifi_sta();   // station iface so we can scan
    wifi_init_config_t wic = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&wic));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));

    wifi_config_t ap = { 0 };
    strncpy((char *)ap.ap.ssid, ap_ssid, sizeof ap.ap.ssid - 1);
    ap.ap.ssid_len = strlen((char *)ap.ap.ssid);
    ap.ap.channel = 1;
    ap.ap.max_connection = 4;
    ap.ap.authmode = WIFI_AUTH_OPEN;       // open AP so users join without a key
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "captive portal up — join WiFi \"%s\" then any page opens the setup form (http://192.168.4.1)", ap_ssid);

    scan_aps();
    xTaskCreate(dns_task, "dns_hijack", 4096, NULL, 5, NULL);
    start_httpd();

    for (;;) vTaskDelay(pdMS_TO_TICKS(1000));   // until save_post → esp_restart()
}

void wifi_prov_run_portal(const char *ap_ssid)
{
    xTaskCreate(portal_task, "wifi_portal", 8192, (void *)ap_ssid, 5, NULL);
    for (;;) vTaskDelay(pdMS_TO_TICKS(1000));   // park the caller; portal_task drives
}
