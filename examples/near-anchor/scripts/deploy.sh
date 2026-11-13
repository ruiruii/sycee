#!/usr/bin/env bash
# Deploy to NEAR testnet with near-cli-rs.
# Does not create an account, does not deploy to mainnet, does not spend
# anything except the gas your existing testnet account already pays.
# Does not print a private key.
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

# OS keyring (sign-with-keychain) has no session on a headless Linux box.
# The legacy keychain is the JSON file ~/.near-credentials/<network>/<account>.json.
os_keyring_available() {
  case "$(uname -s)" in
    Darwin) return 0 ;;
    Linux)
      if [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
        return 0
      fi
      if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "${XDG_RUNTIME_DIR}/bus" ]; then
        return 0
      fi
      return 1
      ;;
    *) return 1 ;;
  esac
}

case "${NEAR_SIGN_WITH:-auto}" in
  keychain) SIGN_WITH="sign-with-keychain" ;;
  legacy) SIGN_WITH="sign-with-legacy-keychain" ;;
  auto)
    if os_keyring_available; then
      SIGN_WITH="sign-with-keychain"
    else
      echo "No OS keyring session. Signing with ~/.near-credentials (sign-with-legacy-keychain)." >&2
      echo "Set NEAR_SIGN_WITH=keychain to require the OS keyring, or NEAR_SIGN_WITH=legacy to keep this." >&2
      SIGN_WITH="sign-with-legacy-keychain"
    fi
    ;;
  *)
    echo "NEAR_SIGN_WITH must be auto, keychain, or legacy." >&2
    exit 2
    ;;
esac

if [ "${NEAR_DEPLOY_PRINT_SIGN:-}" = "1" ]; then
  echo "sign:${SIGN_WITH}"
  exit 0
fi

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
echo "Signer: ${SIGN_WITH}. Does not create an account. Does not print a key."

exec near contract deploy "$NEAR_ACCOUNT_ID" \
  use-file "$WASM" \
  with-init-call new \
  json-args "$INIT" \
  prepaid-gas '30 Tgas' \
  attached-deposit '0 NEAR' \
  network-config testnet \
  "$SIGN_WITH" \
  send
