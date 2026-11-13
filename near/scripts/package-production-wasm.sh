#!/usr/bin/env bash
# Builds ONLY production NEAR WASM contracts (`snapfall_core.wasm` and `snapfall_audit.wasm`)
# with `--no-default-features` and verifies that test-only features/contracts (`test-fail-callback`,
# `snapfall_core_fail_cb.wasm`, `mock_ft.wasm`) are excluded and absent from the production output directory.
# No deployment is performed by this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEAR_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROD_OUT="${NEAR_DIR}/artifacts/production"

rm -rf "${PROD_OUT}"
mkdir -p "${PROD_OUT}"

cd "${NEAR_DIR}"

echo "[1/3] Building production WASM artifacts (--no-default-features)..."
if rustup toolchain list 2>/dev/null | grep -q "^nightly"; then
  cargo +nightly build -Z build-std=std,panic_abort -Z build-std-features=panic_immediate_abort -p snapfall-core -p snapfall-audit --target wasm32-unknown-unknown --release --no-default-features
else
  cargo build -p snapfall-core -p snapfall-audit --target wasm32-unknown-unknown --release --no-default-features
fi

cp "${NEAR_DIR}/target/wasm32-unknown-unknown/release/snapfall_core.wasm" "${PROD_OUT}/snapfall_core.wasm"
cp "${NEAR_DIR}/target/wasm32-unknown-unknown/release/snapfall_audit.wasm" "${PROD_OUT}/snapfall_audit.wasm"

if command -v wasm-opt >/dev/null 2>&1; then
  echo "[1b/3] Running Binaryen wasm-opt -Oz (--mvp-features --signext-lowering)..."
  wasm-opt -Oz --mvp-features --signext-lowering "${PROD_OUT}/snapfall_core.wasm" -o "${PROD_OUT}/snapfall_core.wasm"
  wasm-opt -Oz --mvp-features --signext-lowering "${PROD_OUT}/snapfall_audit.wasm" -o "${PROD_OUT}/snapfall_audit.wasm"
fi

if command -v wasm-validate >/dev/null 2>&1; then
  echo "[1c/3] Validating pure MVP WASM features..."
  for w in "${PROD_OUT}/snapfall_core.wasm" "${PROD_OUT}/snapfall_audit.wasm"; do
    wasm-validate --disable-saturating-float-to-int --disable-sign-extension --disable-simd --disable-multi-value --disable-bulk-memory --disable-reference-types "$w"
  done
fi

echo "[2/3] Running production artifact verification gates..."
bash "${SCRIPT_DIR}/verify-production-artifacts.sh" "${PROD_OUT}"

echo "[3/3] Generating SHA-256 manifest and byte sizes..."
ls -la "${PROD_OUT}"/*.wasm
(cd "${PROD_OUT}" && sha256sum snapfall_core.wasm snapfall_audit.wasm > SHA256SUMS && cat SHA256SUMS)

