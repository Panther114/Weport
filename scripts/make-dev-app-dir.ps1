# make-dev-app-dir.ps1 - turn the packaged build into a fast-iteration install.
#
# Why: `npm run build:dir` re-downloads/repacks Electron every time (~5 min), but
# 95% of UI work only changes the renderer bundle. Electron loads
# `resources/app.asar`, falling back to `resources/app` when the asar is absent,
# so extracting the asar once into a plain directory lets later renderer-only
# iterations be "vite build + robocopy dist" (seconds instead of minutes).
#
# `asarUnpack`ed files are NOT inside the asar (the runtime redirects those paths
# to `app.asar.unpacked`), so they have to be merged back in or koffi / native
# modules fail to load from the directory layout.
#
# Usage:
#   pwsh -NoProfile -File scripts/make-dev-app-dir.ps1            # setup + refresh dist
#   pwsh -NoProfile -File scripts/make-dev-app-dir.ps1 -Setup     # force re-extract
#
# Keep this file ASCII-only (Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM).

param(
  [switch]$Setup
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path "$PSScriptRoot\..").Path
$resources = Join-Path $root 'release\win-unpacked\resources'
$asar = Join-Path $resources 'app.asar'
$appDir = Join-Path $resources 'app'
$unpacked = Join-Path $resources 'app.asar.unpacked'

if (-not (Test-Path $resources)) {
  throw "Packaged app not found at $resources - run scripts/build-local.ps1 first."
}

if ($Setup -or (-not (Test-Path $appDir))) {
  if (Test-Path $asar) {
    Write-Output 'Extracting app.asar -> resources/app (one-time, ~1 min)...'
    if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force }
    npx --yes asar extract $asar $appDir
    if ($LASTEXITCODE -ne 0) { throw 'asar extract failed' }

    if (Test-Path $unpacked) {
      Write-Output 'Merging app.asar.unpacked into resources/app (native modules)...'
      Copy-Item (Join-Path $unpacked '*') $appDir -Recurse -Force
    }

    Move-Item $asar "$asar.bak" -Force
    Write-Output "Renamed app.asar -> app.asar.bak so Electron loads resources/app."
  } elseif (-not (Test-Path $appDir)) {
    throw "Neither app.asar nor app/ exists under $resources."
  }
}

Write-Output 'Building renderer (vite build)...'
Push-Location $root
try {
  npx vite build
  if ($LASTEXITCODE -ne 0) { throw 'vite build failed' }
} finally {
  Pop-Location
}

Write-Output 'Syncing dist + dist-electron into resources/app...'
robocopy (Join-Path $root 'dist') (Join-Path $appDir 'dist') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
robocopy (Join-Path $root 'dist-electron') (Join-Path $appDir 'dist-electron') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null

Write-Output 'Dev app dir ready: release\win-unpacked\Weport.exe'
