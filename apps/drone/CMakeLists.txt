# SPDX-License-Identifier: MIT
# apps/drone — drone-agent buyer (ESP32) for the SF Drone Show demo.
cmake_minimum_required(VERSION 3.16)

# Build the boat-mer dependency in the lean BUYER profile: the drone is a buyer,
# it must not compile the seller engine (which also pulls cJSON/NimBLE deps into
# boat-mer). Set before project() so it seeds the cache before the Component
# Manager registers boat-mer (whose own `set(... CACHE)` then keeps this value).
set(BOAT_PROFILE buyer CACHE STRING "boat-mer build profile (buyer|seller|full)")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(drone_buyer)
