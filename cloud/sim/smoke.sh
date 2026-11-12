#!/usr/bin/env bash
#
# smoke.sh — bring up the no-hardware stack and prove events reach the page's
# SSE endpoint. Used by CI; also the quickest local check that a change to the
# broker topics, the SSE bridge or the simulator did not break the pipeline.
#
#   cloud/sim/smoke.sh            # build, run, assert, tear down
#   KEEP_UP=1 cloud/sim/smoke.sh  # leave the stack running afterwards
#
# It asserts on what the SERVER streamed, not on anything the simulator says
# about itself: a slice_paid and a circle_ack must arrive on /api/stream.

set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SIM_WEB_PORT:-3000}"
export SIM_WEB_PORT="$PORT"
COMPOSE=(docker compose -f docker-compose.sim.yml)
OUT="$(mktemp)"

cleanup() {
  rm -f "$OUT"
  if [[ "${KEEP_UP:-}" != "1" ]]; then "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

"${COMPOSE[@]}" up --build -d

echo "waiting for web on :$PORT ..."
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/demo" 2>/dev/null; then break; fi
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/demo" || { echo "FAIL: web never came up"; "${COMPOSE[@]}" logs --tail 40; exit 1; }

# One batch is 6 slices × 5 s, so the first circle_ack lands ~30 s into a
# session, and the longest gap between acks (across the idle period) is ~55 s.
# 70 s therefore always contains one, however late this read starts. curl
# exits 28 on the timeout —
# that is the expected way for this read to end.
echo "reading /api/stream for 70 s ..."
curl -sS -N -m 70 "http://127.0.0.1:$PORT/api/stream" >"$OUT" 2>/dev/null || true

fail=0
for want in '"ev":"slice_req"' '"ev":"slice_paid"' 'event: circle_ack' '"transaction":"sim-'; do
  n=$(grep -c -- "$want" "$OUT" || true)
  if [[ "$n" -gt 0 ]]; then echo "ok    $want  ($n)"; else echo "FAIL  $want  (0)"; fail=1; fi
done

# Negative control: this stack must never produce an on-chain mint event. If
# this ever matches, something is publishing mint_ack on the sim broker.
if grep -q 'event: mint_ack' "$OUT"; then echo "FAIL  unexpected mint_ack on the sim stack"; fail=1; else echo "ok    no mint_ack (expected: nothing here can mint)"; fi

if [[ "$fail" -ne 0 ]]; then "${COMPOSE[@]}" logs --tail 40; exit 1; fi
echo "SMOKE OK"
