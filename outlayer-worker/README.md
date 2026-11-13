# SnowMoon OutLayer TEE Worker (`snowmoon-tee-worker`)

Minimal zero-dependency Rust `wasm32-wasip2` worker for [OutLayer](https://app.outlayer.ai/docs/getting-started) verifiable execution.

## 1. Prerequisites & Build

### Windows (PowerShell)
```powershell
rustup target add wasm32-wasip2
cd outlayer-worker
cargo build --target wasm32-wasip2 --release
```

### Linux / macOS (Bash)
```bash
rustup target add wasm32-wasip2
cd outlayer-worker
cargo build --target wasm32-wasip2 --release
```

Output binary:
`outlayer-worker/target/wasm32-wasip2/release/snowmoon-tee-worker.wasm`

## 2. Install OutLayer CLI & Independent Verifier

```bash
# Install outlayer CLI (per https://app.outlayer.ai/docs/getting-started) and independent DCAP verifier
cargo install --git https://github.com/out-layer/outlayer-verify outlayer-verify
```

## 3. Reproducible Upload & Project Deployment

### Windows (PowerShell)
```powershell
# Preview without uploading or deploying:
.\outlayer-worker\scripts\deploy-outlayer.ps1 -ProjectOwner <your-near-account> -ProjectName snowmoon-worker -DryRun

# Upload WASM and deploy project version:
.\outlayer-worker\scripts\deploy-outlayer.ps1 -ProjectOwner <your-near-account> -ProjectName snowmoon-worker -Deploy
```

### Linux / macOS (Bash)
```bash
# Preview without uploading or deploying:
bash outlayer-worker/scripts/deploy-outlayer.sh --owner <your-near-account> --project snowmoon-worker --dry-run

# Upload WASM and deploy project version:
bash outlayer-worker/scripts/deploy-outlayer.sh --owner <your-near-account> --project snowmoon-worker --deploy
```

## 4. Production Smoke Test (Single Paid Execution + `outlayer-verify`)

```bash
cd snowmoon
npm run outlayer:smoke -- --confirm-paid-execution
```
