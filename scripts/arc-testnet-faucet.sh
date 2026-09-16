#!/usr/bin/env bash
#
# Request Arc Testnet USDC for a wallet address.
#
# Usage:
#   bash scripts/arc-testnet-faucet.sh 0xYOUR_EOA_ADDRESS
#
# Note: This is a placeholder. The actual Arc Testnet faucet URL and
# protocol may change. Update this script as Circle publishes the
# canonical endpoint.

set -euo pipefail

ADDR="${1:-}"
if [[ -z "$ADDR" ]]; then
  echo "usage: $0 0xYOUR_EOA_ADDRESS"
  exit 1
fi

if [[ ! "$ADDR" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "error: '$ADDR' does not look like an Ethereum address"
  exit 1
fi

FAUCET_URL="${ARC_TESTNET_FAUCET_URL:-https://faucet.arc-testnet.com/request}"

echo "Requesting Arc Testnet USDC for $ADDR via $FAUCET_URL"

curl -fsS -X POST "$FAUCET_URL" \
  -H "Content-Type: application/json" \
  -d "{\"address\":\"$ADDR\"}"

echo
echo "Done. Verify balance with:"
echo "  cast balance $ADDR --rpc-url https://rpc.arc-testnet.com --erc20 0x3600000000000000000000000000000000000000"
