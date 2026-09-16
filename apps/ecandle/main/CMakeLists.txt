# SPDX-License-Identifier: MIT
idf_component_register(
    SRCS "main.c" "wifi_prov.c"
    INCLUDE_DIRS "."
    # boat-mer (the seller engine + crypto/identity/attest tiers) is pulled by
    # the Component Manager from main/idf_component.yml and auto-added as a
    # dependency of this "main" component, so its public headers resolve here.
    # esp_http_server + esp_wifi (+ lwip, transitive) back the SoftAP captive
    # portal in wifi_prov.c.
    REQUIRES bt nvs_flash esp_timer esp_wifi esp_netif esp_event mqtt esp_http_server json
)
