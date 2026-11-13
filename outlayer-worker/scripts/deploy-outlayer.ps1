<#
.SYNOPSIS
  Reproducible OutLayer wasm32-wasip2 build, SHA-256 verification, upload, and optional deploy script for Windows.
  Never reads or prints OUTLAYER_PAYMENT_KEY or any private key.
#>
param(
  [string]$ProjectOwner = $env:OUTLAYER_PROJECT_OWNER,
  [string]$ProjectName = $(if ($env:OUTLAYER_PROJECT_NAME) { $env:OUTLAYER_PROJECT_NAME } else { "snowmoon-worker" }),
  [switch]$Deploy,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$WorkerDir = Split-Path -Parent $PSScriptRoot
$WasmRelPath = "target\wasm32-wasip2\release\snowmoon-tee-worker.wasm"
$WasmFullPath = Join-Path $WorkerDir $WasmRelPath

Push-Location $WorkerDir
try {
  Write-Host "[1/4] Building snowmoon-tee-worker for wasm32-wasip2..."
  cargo build --target wasm32-wasip2 --release
  if (-not (Test-Path $WasmFullPath)) {
    throw "WASM artifact not found at $WasmFullPath"
  }

  $LocalSha256 = (Get-FileHash -Algorithm SHA256 $WasmFullPath).Hash.ToLowerInvariant()
  $FileBytes = (Get-Item $WasmFullPath).Length
  Write-Host "[2/4] Local WASM SHA-256: $LocalSha256 ($FileBytes bytes)"

  if ($DryRun) {
    Write-Host "[3/4] DryRun enabled: skipping 'outlayer upload' and 'outlayer deploy'."
    Write-Host "      Would run: outlayer upload $WasmRelPath"
    if ($Deploy) {
      Write-Host "      Would run: outlayer deploy $ProjectName <FASTFS_URL>"
    }
    Write-Host ""
    Write-Host "[4/4] Required SnowMoon .env configuration (fill OUTLAYER_PAYMENT_KEY separately):"
    Write-Host "OUTLAYER_BASE_URL=https://api.outlayer.ai"
    if ($ProjectOwner) { Write-Host "OUTLAYER_PROJECT_OWNER=$ProjectOwner" } else { Write-Host "OUTLAYER_PROJECT_OWNER=<your-near-account>" }
    Write-Host "OUTLAYER_PROJECT_NAME=$ProjectName"
    Write-Host "OUTLAYER_EXPECTED_WASM_HASH=$LocalSha256"
    Write-Host "OUTLAYER_COMPUTE_LIMIT=10000"
    Write-Host "OUTLAYER_ATTACHED_DEPOSIT=0"
    Write-Host "OUTLAYER_MAX_PER_CALL=100000"
    exit 0
  }

  if (-not (Get-Command outlayer -ErrorAction SilentlyContinue)) {
    throw "outlayer CLI not found on PATH. Install it per https://app.outlayer.ai/docs/getting-started before running without -DryRun."
  }

  Write-Host "[3/4] Uploading WASM via 'outlayer upload $WasmRelPath'..."
  $UploadOutput = (& outlayer upload $WasmRelPath 2>&1 | Out-String)
  Write-Host $UploadOutput

  $UrlMatch = [regex]::Match($UploadOutput, 'https://[^\s"''<>]+')
  if (-not $UrlMatch.Success) {
    throw "Could not parse FastFS/HTTPS URL from 'outlayer upload' output."
  }
  $FastFsUrl = $UrlMatch.Value

  $HashMatch = [regex]::Match($UploadOutput, '\b([a-fA-F0-9]{64})\b')
  if ($HashMatch.Success) {
    $UploadedHash = $HashMatch.Groups[1].Value.ToLowerInvariant()
    if ($UploadedHash -ne $LocalSha256) {
      throw "SHA-256 mismatch! Local=$LocalSha256 vs Uploaded=$UploadedHash"
    }
  }

  if ($Deploy) {
    Write-Host "[3b] Deploying project '$ProjectName' to OutLayer..."
    & outlayer deploy $ProjectName $FastFsUrl
    if ($LASTEXITCODE -ne 0) {
      throw "outlayer deploy exited with code $LASTEXITCODE"
    }
  } else {
    Write-Host "[3b] Upload complete. To deploy version, run: outlayer deploy $ProjectName $FastFsUrl"
  }

  Write-Host ""
  Write-Host "[4/4] Required SnowMoon .env configuration (secrets not printed):"
  Write-Host "OUTLAYER_BASE_URL=https://api.outlayer.ai"
  if ($ProjectOwner) { Write-Host "OUTLAYER_PROJECT_OWNER=$ProjectOwner" } else { Write-Host "OUTLAYER_PROJECT_OWNER=<your-near-account>" }
  Write-Host "OUTLAYER_PROJECT_NAME=$ProjectName"
  Write-Host "OUTLAYER_EXPECTED_WASM_HASH=$LocalSha256"
  Write-Host "OUTLAYER_COMPUTE_LIMIT=10000"
  Write-Host "OUTLAYER_ATTACHED_DEPOSIT=0"
  Write-Host "OUTLAYER_MAX_PER_CALL=100000"
} finally {
  Pop-Location
}

