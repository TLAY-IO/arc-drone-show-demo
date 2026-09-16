#!/usr/bin/env bash
#
# verify-build.sh — run the same checks CI runs, locally.
#
# Purpose: catch issues before pushing. Ideally runs in < 60 seconds.
#
# Checks:
#   1. No GPL / copyleft markers in any tracked file (license boundary)
#   2. No "Apache License" header in the demo repo (license boundary)
#   3. No Solana / bitaxe / ESP-Miner references (per SOW v3 + OSR launch)
#   4. No 64-character hex strings that look like committed private keys
#   5. cloud/web/ TypeScript compiles
#   6. cloud/settle-worker/ Node script parses

set -euo pipefail
cd "$(dirname "$0")/.."

red() { printf "\033[31m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
header() { printf "\n\033[1m%s\033[0m\n" "$1"; }

FAILED=0

header "1/6 GPL / copyleft markers"
if grep -rnE 'GPL|GNU General Public License|LGPL' --include='*.{c,h,cpp,hpp,ts,tsx,js,jsx,json,md,yml,yaml}' . \
     --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=managed_components --exclude-dir=.git; then
  red "FAIL: GPL/copyleft references found (license boundary violation)"
  FAILED=$((FAILED+1))
else
  green "OK"
fi

header "2/6 Apache header in demo repo (license boundary)"
if grep -rn 'Apache License' --include='*.{c,h,cpp,hpp,ts,tsx,js,jsx}' . \
     --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=managed_components --exclude-dir=.git; then
  red "FAIL: Apache headers found — boat-mer source vendored into MIT repo?"
  red "      Dependencies must be fetched at build time (Component Manager / npm), not committed."
  FAILED=$((FAILED+1))
else
  green "OK"
fi

header "3/6 Solana / bitaxe / ESP-Miner references"
# Exclude this script itself — it names the very keywords it bans.
if grep -rnEi 'solana|bitaxe|esp-miner' --include='*.{c,h,cpp,hpp,ts,tsx,js,jsx,json,md,yml,yaml,sh,toml}' . \
     --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=managed_components --exclude-dir=.git \
     --exclude='verify-build.sh'; then
  red "FAIL: forbidden references found"
  FAILED=$((FAILED+1))
else
  green "OK"
fi

header "4/6 Suspicious 64-hex strings (potential committed private keys)"
HEX_HITS=$(grep -rnE '\b[0-9a-fA-F]{64}\b' --include='*.{c,h,cpp,hpp,ts,tsx,js,jsx,json,md,yml,yaml,sh}' . \
     --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=managed_components --exclude-dir=.git \
     --exclude='package-lock.json' --exclude='pnpm-lock.yaml' --exclude='yarn.lock' || true)
if [[ -n "$HEX_HITS" ]]; then
  yellow "WARN: 64-hex strings found, please review (well-known test vectors are OK):"
  echo "$HEX_HITS"
  # Not a hard fail — manual triage required.
else
  green "OK"
fi

header "5/6 cloud/web/ TypeScript"
if [[ -d cloud/web/node_modules ]]; then
  ( cd cloud/web && npx tsc --noEmit ) && green "OK" || { red "FAIL"; FAILED=$((FAILED+1)); }
else
  yellow "SKIP: cloud/web/node_modules not installed (run: cd cloud/web && npm install)"
fi

header "6/6 cloud/settle-worker/ Node syntax"
if node --check cloud/settle-worker/index.js; then
  green "OK"
else
  red "FAIL"
  FAILED=$((FAILED+1))
fi

header "summary"
if [[ "$FAILED" -eq 0 ]]; then
  green "ALL CHECKS PASSED"
  exit 0
else
  red "$FAILED CHECK(S) FAILED"
  exit 1
fi
