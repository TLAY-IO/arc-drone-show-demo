# SPDX-License-Identifier: MIT
# apps/drone main component.
#
# boat-mer is pulled by the ESP-IDF Component Manager (see idf_component.yml in
# this dir) into managed_components/ and exposes its public headers
# (boat_buyer_nanopay.h, boat_nano_wire.h, boat_crypto.h). Its managed-component
# name is the namespaced manifest key, "TLAY-IO__boat-mer".
idf_component_register(
    SRCS
        "main.c"
        "ble_transport.c"
    INCLUDE_DIRS
        "."
    REQUIRES
        bt              # NimBLE host (esp_nimble)
        nvs_flash       # PAL keypair persistence
        esp_timer       # buyer tick
        esp_system      # esp_restart (hard_reset)
        TLAY-IO__boat-mer
)

# Sept-2026 image variants. Defaults (no cache vars) = Arc Testnet 5042002 +
# testnet Gateway contract. Mainnet:
#   idf.py -B build-mainnet -DDRONE_CHAIN_ID=5042 \
#          -DDRONE_GATEWAY_CONTRACT_HEX=77777777Dcc4d5A8B6E418Fd04D8997ef11000eE build
# BOTH cache vars are REQUIRED for a mainnet image -- they are not independent
# knobs. Setting only the chain id leaves the testnet Gateway compiled in, so
# the EIP-712 domain carries mainnet chainId with the testnet verifyingContract:
# the signature recovers to the wrong address and Circle rejects every settle.
# That failure is silent -- the device keeps signing, the UI keeps moving, and
# nothing logs an error. Verify with the boot banner (it prints both).
# SEPARATE build dir per variant — values are cached; a stale cache silently
# ships the wrong chain. Verify chainId in the boot log before any flash.
if(DEFINED DRONE_CHAIN_ID)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE "DRONE_CHAIN_ID=${DRONE_CHAIN_ID}u")
    message(STATUS "apps/drone: DRONE_CHAIN_ID override = ${DRONE_CHAIN_ID}")
endif()
if(DEFINED DRONE_GATEWAY_CONTRACT_HEX)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE "DRONE_GATEWAY_CONTRACT_HEX=\"${DRONE_GATEWAY_CONTRACT_HEX}\"")
    message(STATUS "apps/drone: DRONE_GATEWAY_CONTRACT_HEX override set")
endif()
# REHEARSAL-ONLY: lower the per-session money cap so a cap-hit and its
# "lift, count 35, replace" recovery can be drilled in minutes. Runtime value,
# not struct-sizing, so a per-target define is safe here (unlike the nonce
# cap, which is build-global — see the project CMakeLists). Never on a show
# image; pair with DRONE_NONCE_CAP_OVERRIDE in the ROLLTEST build dir.
if(DEFINED DRONE_SESSION_CAP_MICRO)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE "DRONE_SESSION_CAP_MICRO=${DRONE_SESSION_CAP_MICRO}u")
    message(STATUS "apps/drone: REHEARSAL session cap override = ${DRONE_SESSION_CAP_MICRO} uUSDC")
endif()
if(DEFINED DRONE_EIP712_DOMAIN_NAME)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE "DRONE_EIP712_DOMAIN_NAME=\"${DRONE_EIP712_DOMAIN_NAME}\"")
    message(STATUS "apps/drone: DRONE_EIP712_DOMAIN_NAME override set")
endif()
if(DEFINED DRONE_EIP712_DOMAIN_VERSION)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE "DRONE_EIP712_DOMAIN_VERSION=\"${DRONE_EIP712_DOMAIN_VERSION}\"")
    message(STATUS "apps/drone: DRONE_EIP712_DOMAIN_VERSION override set")
endif()
