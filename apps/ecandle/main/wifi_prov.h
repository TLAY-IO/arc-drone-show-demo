// SPDX-License-Identifier: MIT
//
// SoftAP captive-portal WiFi provisioning for the eCandle reference seller.
//
// On first boot (no saved credentials and no compile-time default) the device
// brings up an open SoftAP named after `ap_ssid` and a captive portal: any
// phone that joins is auto-redirected to a page where the user picks their
// home WiFi from a scanned list and enters the password. The credentials are
// stored in NVS and the device reboots into station mode. Subsequent boots read
// NVS and connect directly — no portal.
#pragma once

#include <stddef.h>
#include <stdbool.h>

// Load saved station credentials. Returns true only if a non-empty SSID was
// found in NVS. `ssid`/`pass` are NUL-terminated on success.
bool wifi_prov_load(char *ssid, size_t ssid_len, char *pass, size_t pass_len);

// Persist station credentials to NVS (namespace "wifiprov").
void wifi_prov_save(const char *ssid, const char *pass);

// Erase saved credentials. Used when the saved creds are rejected by the AP so
// the next boot falls back into the captive portal for re-entry.
void wifi_prov_erase(void);

// True if the device already has credentials to connect with — either saved in
// NVS or a non-empty compile-time default (CONFIG_DEMO_WIFI_SSID). When this is
// false, app_main should run the captive portal before starting station mode.
bool wifi_prov_have_creds(void);

// Bring up the SoftAP captive portal and block. When the user submits creds the
// portal saves them to NVS and reboots the device, so this never returns.
// `ap_ssid` is the SoftAP name to advertise (e.g. "eCandle-ab12").
void wifi_prov_run_portal(const char *ap_ssid);
