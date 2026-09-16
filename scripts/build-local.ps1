# build-local.ps1 - build Weport on this machine.
#
# Why this wrapper exists: on this network github.com:443 is unreachable, so
# electron-builder's download of the Electron archive fails with
#
#   connect ETIMEDOUT 20.205.243.166:443
#
# Setting a mirror makes the build succeed. Pinning the mirror environment here
# means nobody has to remember it - forgetting costs ten minutes and looks like
# a code failure.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/build-local.ps1           # build:dir
#   powershell -ExecutionPolicy Bypass -File scripts/build-local.ps1 build     # NSIS installer
#
# build:mac and build:linux need their own host OS (electron-builder does not
# cross-package); this script does not block them, electron-builder will.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 files as
# ANSI unless they carry a UTF-8 BOM, and non-ASCII bytes can corrupt the parse.

param(
  [string]$Task = 'build:dir',
  [switch]$SkipMirror
)

$ErrorActionPreference = 'Stop'

if (-not $SkipMirror) {
  # Only fill in when unset, so a machine with a working proxy keeps its own values.
  if (-not $env:ELECTRON_MIRROR) {
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  }
  if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
  }
  Write-Output "ELECTRON_MIRROR=$env:ELECTRON_MIRROR"
  Write-Output "ELECTRON_BUILDER_BINARIES_MIRROR=$env:ELECTRON_BUILDER_BINARIES_MIRROR"
}

$projectRoot = (Resolve-Path "$PSScriptRoot\..").Path
Push-Location $projectRoot

$exit = 1
try {
  Write-Output "Building: $Task"
  npm run $Task
  $exit = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($exit -ne 0) {
  Write-Output "Build FAILED (exit=$exit). If the error was an Electron download timeout, check that the mirror variables above are set."
  exit $exit
}

Write-Output 'Build finished.'
Get-ChildItem (Join-Path $projectRoot 'release') -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 3 Name, LastWriteTime |
  Format-Table -AutoSize
