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
cargo build -p snapfall-core -p snapfall-audit --target wasm32-unknown-unknown --release --no-default-features

cp "${NEAR_DIR}/target/wasm32-unknown-unknown/release/snapfall_core.wasm" "${PROD_OUT}/snapfall_core.wasm"
cp "${NEAR_DIR}/target/wasm32-unknown-unknown/release/snapfall_audit.wasm" "${PROD_OUT}/snapfall_audit.wasm"

echo "[2/3] Running production artifact verification gates..."
bash "${SCRIPT_DIR}/verify-production-artifacts.sh" "${PROD_OUT}"

echo "[3/3] Generating SHA-256 manifest..."
(cd "${PROD_OUT}" && sha256sum snapfall_core.wasm snapfall_audit.wasm > SHA256SUMS && cat SHA256SUMS)

