#!/usr/bin/env bash
# Deploy to NEAR testnet with near-cli-rs.
# Does not create an account, does not deploy to mainnet, does not spend
# anything except the gas your existing testnet account already pays.
set -euo pipefail

NETWORK="${NEAR_NETWORK:-testnet}"
if [ "$NETWORK" != "testnet" ]; then
  echo "refusing to deploy: NEAR_NETWORK must be testnet (got: ${NETWORK})" >&2
  exit 2
fi

if [ -z "${NEAR_ACCOUNT_ID:-}" ]; then
  echo "Set NEAR_ACCOUNT_ID to your existing testnet account." >&2
  exit 2
fi

case "$NEAR_ACCOUNT_ID" in
  *.near)
    echo "refusing to deploy: ${NEAR_ACCOUNT_ID} looks like a mainnet account." >&2
    exit 2
    ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASM="${SYCEE_ANCHOR_WASM:-$ROOT/out/sycee_anchor.wasm}"
if [ ! -f "$WASM" ]; then
  "$ROOT/scripts/build.sh"
fi

ANCHORERS_JSON="[]"
if [ -n "${NEAR_ANCHORERS:-}" ]; then
  ANCHORERS_JSON="$(
    node --input-type=module -e '
      const ids = process.argv[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (!ids.every((id) => /^[a-z0-9._-]+$/.test(id))) {
        console.error("NEAR_ANCHORERS has an account id this script will not pass through");
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(ids));
    ' "$NEAR_ANCHORERS"
  )"
fi

INIT="$(
  node --input-type=module -e '
    const owner = process.argv[1];
    const anchorers = JSON.parse(process.argv[2]);
    process.stdout.write(JSON.stringify({ owner, anchorers }));
  ' "$NEAR_ACCOUNT_ID" "$ANCHORERS_JSON"
)"

echo "Deploying ${WASM} to ${NEAR_ACCOUNT_ID} on testnet."
echo "Init: ${INIT}"
echo "Signs with your near-cli-rs keychain. Does not create an account."

exec near contract deploy "$NEAR_ACCOUNT_ID" \
  use-file "$WASM" \
  with-init-call new \
  json-args "$INIT" \
  prepaid-gas '30 Tgas' \
  attached-deposit '0 NEAR' \
  network-config testnet \
  sign-with-keychain \
  send
