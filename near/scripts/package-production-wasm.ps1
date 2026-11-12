<#
.SYNOPSIS
    Builds ONLY production NEAR WASM contracts (`snapfall_core.wasm` and `snapfall_audit.wasm`)
    with `--no-default-features` into `near/artifacts/production/`, verifies that test-only
    hooks (`set_test_force_payout_callback_panic`, `TEST_FORCED_CALLBACK_PANIC`) and test-only
    WASM binaries (`snapfall_core_fail_cb.wasm`, `mock_ft.wasm`) are absent, and writes `SHA256SUMS`.
    No deployment is performed by this script.
#>
$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$nearDir = Split-Path -Parent $scriptDir
$prodOut = Join-Path $nearDir "artifacts\production"

if (Test-Path $prodOut) {
    Remove-Item -Recurse -Force $prodOut
}
New-Item -ItemType Directory -Force -Path $prodOut | Out-Null

Write-Host "[1/3] Building production WASM artifacts (--no-default-features)..."
& (Join-Path $scriptDir "with-win-msvc-env.ps1") build -p snapfall-core -p snapfall-audit --target wasm32-unknown-unknown --release --no-default-features
if ($LASTEXITCODE -ne 0) {
    throw "Production WASM build failed with exit code $LASTEXITCODE"
}

$relDir = Join-Path $nearDir "target\wasm32-unknown-unknown\release"
Copy-Item (Join-Path $relDir "snapfall_core.wasm") (Join-Path $prodOut "snapfall_core.wasm")
Copy-Item (Join-Path $relDir "snapfall_audit.wasm") (Join-Path $prodOut "snapfall_audit.wasm")

Write-Host "[2/3] Verifying production artifact separation..."
foreach ($forbidden in @("snapfall_core_fail_cb.wasm", "mock_ft.wasm", "withdraw_helper.wasm")) {
    if (Test-Path (Join-Path $prodOut $forbidden)) {
        throw "FATAL: Forbidden test-only artifact present in production directory: $forbidden"
    }
}

$wasmFiles = Get-ChildItem -Path $prodOut -Filter "*.wasm"
if ($wasmFiles.Count -ne 2) {
    throw "FATAL: Expected exactly 2 .wasm files in $prodOut, found $($wasmFiles.Count)"
}

$coreBytes = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes((Join-Path $prodOut "snapfall_core.wasm")))
foreach ($sym in @("set_test_force_payout_callback_panic", "TEST_FORCED_CALLBACK_PANIC")) {
    if ($coreBytes.Contains($sym)) {
        throw "FATAL: snapfall_core.wasm contains forbidden test-only symbol '$sym'!"
    }
}

Write-Host "[3/3] Generating SHA256SUMS..."
$hashes = foreach ($f in @("snapfall_core.wasm", "snapfall_audit.wasm")) {
    $h = (Get-FileHash -Algorithm SHA256 (Join-Path $prodOut $f)).Hash.ToLowerInvariant()
    "$h  $f"
}
$hashes | Set-Content -Encoding ASCII (Join-Path $prodOut "SHA256SUMS")
Get-Content (Join-Path $prodOut "SHA256SUMS")
Write-Host "OK: Production artifacts verified in $prodOut"

