#!/usr/bin/env bash
# Compile the anchor contract and lower Wasm features the NEAR runtime
# used by near-sandbox (nearcore 2.6.2) cannot parse. Does not deploy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Rust 1.86 matches contract/rust-toolchain.toml. near-sandbox (nearcore 2.6.2)
# rejects Wasm from newer compilers until wasm-opt lowers it below.
if ! command -v rustup >/dev/null 2>&1; then
  echo "scripts/build.sh needs rustup so it can install Rust 1.86.0 and the wasm32-unknown-unknown target." >&2
  echo "Install rustup from https://rustup.rs and run this script again. No NEAR account is required." >&2
  exit 1
fi
rustup toolchain install 1.86.0 --profile minimal --target wasm32-unknown-unknown

cd "$ROOT/contract"
cargo +1.86.0 build --target wasm32-unknown-unknown --release --locked
RAW="target/wasm32-unknown-unknown/release/sycee_anchor.wasm"
mkdir -p "$ROOT/out" "$ROOT/.tools"

WASM_OPT="${WASM_OPT:-}"
if [ -z "$WASM_OPT" ]; then
  if command -v wasm-opt >/dev/null 2>&1; then
    WASM_OPT="$(command -v wasm-opt)"
  else
    WASM_OPT="$ROOT/.tools/wasm-opt"
  fi
fi
if [ ! -x "$WASM_OPT" ]; then
  ARCHIVE="$ROOT/.tools/binaryen.tar.gz"
  curl -fsSL -o "$ARCHIVE" \
    https://github.com/WebAssembly/binaryen/releases/download/version_120/binaryen-version_120-x86_64-linux.tar.gz
  tar -xzf "$ARCHIVE" -C "$ROOT/.tools" --strip-components=2 binaryen-version_120/bin/wasm-opt
  chmod +x "$WASM_OPT"
fi

"$WASM_OPT" -Oz \
  --signext-lowering \
  --disable-bulk-memory \
  --disable-reference-types \
  --disable-multivalue \
  --disable-simd \
  --disable-nontrapping-float-to-int \
  "$RAW" \
  -o "$ROOT/out/sycee_anchor.wasm"
wc -c "$ROOT/out/sycee_anchor.wasm"
