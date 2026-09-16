#!/bin/sh
# Generates ./passwd for mosquitto.conf using the official image (no local
# mosquitto install needed). Usage:
#   ./gen-passwd.sh [device_pw] [worker_pw] [web_pw]
set -e
cd "$(dirname "$0")"
# Default to RANDOM passwords. A published default password on a broker that
# blind-signs digests is a signing oracle — see the note at the top of
# mosquitto.conf. Pass your own as arguments if you prefer.
# No `head` in this pipeline on purpose: head closes the pipe as soon as it
# has enough bytes, which sends SIGPIPE upstream. That is harmless under plain
# `set -e` (which only inspects the last command of a pipeline) but would abort
# the script for anyone who later adds `set -o pipefail`. `cut` reads to EOF.
rnd() {
  LC_ALL=C dd if=/dev/urandom bs=512 count=1 2>/dev/null \
    | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-24
}
DEV="${1:-$(rnd)}"; WRK="${2:-$(rnd)}"; WEB="${3:-$(rnd)}"
docker run --rm -v "$PWD":/work eclipse-mosquitto:2.0 sh -c "
  mosquitto_passwd -c -b /work/passwd device '$DEV' &&
  mosquitto_passwd    -b /work/passwd worker '$WRK' &&
  mosquitto_passwd    -b /work/passwd web    '$WEB'"
echo "wrote $(pwd)/passwd (users: device, worker, web)"
echo
echo "device password (set this in the eCandle firmware via idf.py menuconfig):"
echo "  $DEV"
echo
echo "paste these two lines into cloud/.env:"
echo "  MQTT_URL_WEB=mqtt://web:$WEB@mosquitto:1883"
echo "  MQTT_URL_WORKER=mqtt://worker:$WRK@mosquitto:1883"
echo
echo "shown once — the passwd file stores only hashes"
