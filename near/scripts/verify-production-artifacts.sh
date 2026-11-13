#!/usr/bin/env bash
# Verifies that a target artifact directory contains ONLY eligible production WASM files
# (`snapfall_core.wasm` and `snapfall_audit.wasm`) and that neither test-only binaries
# (`snapfall_core_fail_cb.wasm`, `mock_ft.wasm`) nor test-only symbols
# (`set_test_force_payout_callback_panic`, `TEST_FORCED_CALLBACK_PANIC`) are present.

set -euo pipefail

ARTIFACT_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/artifacts/production}"

if [[ ! -d "${ARTIFACT_DIR}" ]]; then
  echo "ERROR: Artifact directory not found: ${ARTIFACT_DIR}" >&2
  exit 1
fi

# 1. Forbid test-only filenames anywhere in the production artifact directory
for forbidden_file in "snapfall_core_fail_cb.wasm" "mock_ft.wasm" "withdraw_helper.wasm"; do
  if [[ -e "${ARTIFACT_DIR}/${forbidden_file}" ]]; then
    echo "FATAL: Forbidden test-only artifact present in production directory: ${forbidden_file}" >&2
    exit 1
  fi
done

# 2. Require exact production artifacts
for required_file in "snapfall_core.wasm" "snapfall_audit.wasm"; do
  if [[ ! -f "${ARTIFACT_DIR}/${required_file}" ]]; then
    echo "FATAL: Missing required production artifact: ${required_file}" >&2
    exit 1
  fi
done

# 3. Ensure no unexpected .wasm files exist in the directory
wasm_count=$(find "${ARTIFACT_DIR}" -maxdepth 1 -name "*.wasm" | wc -l | tr -d ' ')
if [[ "${wasm_count}" -ne 2 ]]; then
  echo "FATAL: Expected exactly 2 .wasm files in ${ARTIFACT_DIR}, found ${wasm_count}" >&2
  exit 1
fi

# 4. Scan binary contents of production WASMs for forbidden test-only hooks or mock-ft exports
for forbidden_sym in "set_test_force_payout_callback_panic" "TEST_FORCED_CALLBACK_PANIC"; do
  if grep -Fq "${forbidden_sym}" "${ARTIFACT_DIR}/snapfall_core.wasm"; then
    echo "FATAL: snapfall_core.wasm contains forbidden test-only symbol '${forbidden_sym}' (compiled with test-fail-callback)!" >&2
    exit 1
  fi
done

echo "OK: Production artifacts verified (${ARTIFACT_DIR}/snapfall_core.wasm, ${ARTIFACT_DIR}/snapfall_audit.wasm)."

