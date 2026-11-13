#!/usr/bin/env bash
set -euo pipefail

# Reproducible OutLayer wasm32-wasip2 build, SHA-256 verification, upload, and optional deploy script.
# Never reads or prints OUTLAYER_PAYMENT_KEY or any private key.

PROJECT_OWNER="${OUTLAYER_PROJECT_OWNER:-}"
PROJECT_NAME="${OUTLAYER_PROJECT_NAME:-snowmoon-worker}"
DEPLOY=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner)
      PROJECT_OWNER="$2"
      shift 2
      ;;
    --project)
      PROJECT_NAME="$2"
      shift 2
      ;;
    --deploy)
      DEPLOY=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WASM_REL="target/wasm32-wasip2/release/snowmoon-tee-worker.wasm"
WASM_FULL="$WORKER_DIR/$WASM_REL"

cd "$WORKER_DIR"

echo "[1/4] Building snowmoon-tee-worker for wasm32-wasip2..."
cargo build --target wasm32-wasip2 --release

if [[ ! -f "$WASM_FULL" ]]; then
  echo "WASM artifact not found at $WASM_FULL" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  LOCAL_SHA256="$(sha256sum "$WASM_FULL" | awk '{print tolower($1)}')"
else
  LOCAL_SHA256="$(shasum -a 256 "$WASM_FULL" | awk '{print tolower($1)}')"
fi

echo "[2/4] Local WASM SHA-256: $LOCAL_SHA256"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[3/4] --dry-run enabled: skipping 'outlayer upload' and 'outlayer deploy'."
  echo "      Would run: outlayer upload $WASM_REL"
  if [[ "$DEPLOY" -eq 1 ]]; then
    echo "      Would run: outlayer deploy $PROJECT_NAME <FASTFS_URL>"
  fi
else
  if ! command -v outlayer >/dev/null 2>&1; then
    echo "outlayer CLI not found on PATH. Install it per https://app.outlayer.ai/docs/getting-started" >&2
    exit 1
  fi

  echo "[3/4] Uploading WASM via 'outlayer upload $WASM_REL'..."
  UPLOAD_OUT="$(outlayer upload "$WASM_REL" 2>&1)"
  echo "$UPLOAD_OUT"

  FASTFS_URL="$(printf '%s\n' "$UPLOAD_OUT" | grep -Eo 'https://[^[:space:]"'\''<>]+' | head -n1 || true)"
  if [[ -z "$FASTFS_URL" ]]; then
    echo "Could not parse FastFS/HTTPS URL from 'outlayer upload' output." >&2
    exit 1
  fi

  UPLOADED_HASH="$(printf '%s\n' "$UPLOAD_OUT" | grep -Eo '\b[a-fA-F0-9]{64}\b' | head -n1 | tr '[:upper:]' '[:lower:]' || true)"
  if [[ -n "$UPLOADED_HASH" && "$UPLOADED_HASH" != "$LOCAL_SHA256" ]]; then
    echo "SHA-256 mismatch! Local=$LOCAL_SHA256 vs Uploaded=$UPLOADED_HASH" >&2
    exit 1
  fi

  if [[ "$DEPLOY" -eq 1 ]]; then
    echo "[3b] Deploying project '$PROJECT_NAME' to OutLayer..."
    outlayer deploy "$PROJECT_NAME" "$FASTFS_URL"
  else
    echo "[3b] Upload complete. To deploy version, run: outlayer deploy $PROJECT_NAME $FASTFS_URL"
  fi
fi

echo ""
echo "[4/4] Required SnowMoon .env configuration (secrets not printed):"
echo "OUTLAYER_BASE_URL=https://api.outlayer.ai"
echo "OUTLAYER_PROJECT_OWNER=${PROJECT_OWNER:-<your-near-account>}"
echo "OUTLAYER_PROJECT_NAME=$PROJECT_NAME"
echo "OUTLAYER_EXPECTED_WASM_HASH=$LOCAL_SHA256"
echo "OUTLAYER_COMPUTE_LIMIT=10000"
echo "OUTLAYER_ATTACHED_DEPOSIT=0"
echo "OUTLAYER_MAX_PER_CALL=100000"

