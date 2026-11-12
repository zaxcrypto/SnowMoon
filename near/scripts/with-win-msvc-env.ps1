<#
.SYNOPSIS
    Configures portable Windows MSVC + Windows SDK + NASM environment variables in the current process
    and executes the requested cargo command inside `near/`.
    Does not hardcode usernames or modify tracked configuration files.
#>
$ErrorActionPreference = "Stop"
if ($args.Count -eq 0) {
    throw "Usage: with-win-msvc-env.ps1 <cargo-args...>"
}

$fso = New-Object -ComObject Scripting.FileSystemObject
function Get-ShortPath([string]$p) {
    if (Test-Path $p) {
        return $fso.GetFolder($p).ShortPath
    }
    return $p
}

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $vsInstallDir = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($vsInstallDir) {
        $msvcRoot = Join-Path $vsInstallDir "VC\Tools\MSVC"
        $msvcVer = Get-ChildItem -Path $msvcRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
        if ($msvcVer) {
            $msvcBin = Join-Path $msvcVer.FullName "bin\Hostx64\x64"
            $msvcInclude = Join-Path $msvcVer.FullName "include"
            $msvcLib = Get-ShortPath (Join-Path $msvcVer.FullName "lib\x64")
            $env:PATH = "$msvcBin;$env:PATH"
            $env:CC_x86_64_pc_windows_msvc = Join-Path $msvcBin "cl.exe"
            $env:AR_x86_64_pc_windows_msvc = Join-Path $msvcBin "lib.exe"
            $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = Join-Path $msvcBin "link.exe"
        }
    }
}

# Locate system Windows Kits\10 or fallback to user-local extracted SDK in $env:TEMP
$sysSdkInclude = "${env:ProgramFiles(x86)}\Windows Kits\10\Include"
$sysSdkLib = "${env:ProgramFiles(x86)}\Windows Kits\10\Lib"

if ((Test-Path $sysSdkInclude) -and (Test-Path $sysSdkLib)) {
    $sdkVer = Get-ChildItem -Path $sysSdkLib -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if ($sdkVer) {
        $ver = $sdkVer.Name
        $umLib = Get-ShortPath "$sysSdkLib\$ver\um\x64"
        $ucrtLib = Get-ShortPath "$sysSdkLib\$ver\ucrt\x64"
        $env:INCLUDE = "$msvcInclude;$sysSdkInclude\$ver\ucrt;$sysSdkInclude\$ver\um;$sysSdkInclude\$ver\shared"
        $env:LIB = "$umLib;$ucrtLib;$msvcLib"
        $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = "-L native=$umLib -L native=$ucrtLib -L native=$msvcLib"
    }
} else {
    $tempSdkHdr = Join-Path $env:TEMP "winsdk_hdr\c\Include\10.0.22621.0"
    $tempSdkLib = Join-Path $env:TEMP "winsdk_pkg\c"
    if ((Test-Path $tempSdkHdr) -and (Test-Path $tempSdkLib)) {
        $umLib = Get-ShortPath "$tempSdkLib\um\x64"
        $ucrtLib = Get-ShortPath "$tempSdkLib\ucrt\x64"
        $env:INCLUDE = "$msvcInclude;$tempSdkHdr\ucrt;$tempSdkHdr\um;$tempSdkHdr\shared"
        $env:LIB = "$umLib;$ucrtLib;$msvcLib"
        $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = "-L native=$umLib -L native=$ucrtLib -L native=$msvcLib"
    }
}

# Add local NASM if extracted in $env:TEMP\nasm
$tempNasm = Join-Path $env:TEMP "nasm\nasm-2.16.03"
if (Test-Path $tempNasm) {
    $env:PATH = "$tempNasm;$env:PATH"
}

$nearDir = Split-Path -Parent $PSScriptRoot
Push-Location $nearDir
try {
    & cargo @args
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
