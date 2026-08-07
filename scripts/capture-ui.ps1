# Weport UI capture harness (Electron)
# Captures the main window + notification popup via the app's own
# WEPORT_SCREENSHOT_POPUP mode, then asserts the popup is non-blank.
# A blank popup (broken renderer / unwired viewport) fails the build.
param(
  [string]$Executable = "",
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path,
  [string]$OutputDir = (Join-Path $env:TEMP "weport-electron-screenshots")
)

$ErrorActionPreference = 'Stop'
$ProjectRootArg = $null

# 默认优先测打包版（win-unpacked），否则退回 dev 版 electron
if (-not $Executable) {
  $packaged = Join-Path $ProjectRoot "release\win-unpacked\Weport.exe"
  if (Test-Path $packaged) {
    $Executable = $packaged
  } else {
    $Executable = Join-Path $ProjectRoot "node_modules\electron\dist\electron.exe"
    $ProjectRootArg = $ProjectRoot
  }
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Add-Type -AssemblyName System.Drawing

function Assert-ImageHasContent([string]$Path, [string]$Label) {
  # Variance check: a blank/transparent capture is near-uniform (low stddev);
  # a real toast has card bg + text + avatar (high stddev). Fails loud so a
  # broken popup cannot ship silently behind a green build.
  $bmp = New-Object System.Drawing.Bitmap $Path
  $w = $bmp.Width; $h = $bmp.Height
  if ($w -lt 50 -or $h -lt 50) { $bmp.Dispose(); throw "capture for '$Label' too small (${w}x${h}). Aborting." }
  $sum = 0.0; $sumSq = 0.0; $n = 0
  for ($x = 0; $x -lt $w; $x += 3) {
    for ($y = 0; $y -lt $h; $y += 3) {
      $c = $bmp.GetPixel($x, $y)
      $v = [int]$c.R * 0.3 + [int]$c.G * 0.59 + [int]$c.B * 0.11
      $sum += $v; $sumSq += $v * $v; $n++
    }
  }
  $bmp.Dispose()
  if ($n -eq 0) { throw "Assert-ImageHasContent: empty image for $Label" }
  $mean = $sum / $n
  $variance = ($sumSq / $n) - ($mean * $mean)
  $stddev = [Math]::Sqrt([Math]::Max(0.0, $variance))
  if ($stddev -lt 12.0) {
    throw "popup capture for '$Label' looks blank (stddev=$([Math]::Round($stddev,2)) < 12). The notification window did not paint. Aborting."
  }
  Write-Output "  [ok] $Label has content (stddev=$([Math]::Round($stddev,2)))"
}

$env:WEPORT_SCREENSHOT_POPUP = '1'
$env:WEPORT_SCREENSHOT_OUT = $OutputDir
Remove-Item Env:ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue

Write-Output "Launching $Executable (screenshot mode)..."
if ($ProjectRootArg) {
  $p = Start-Process -FilePath $Executable -ArgumentList $ProjectRootArg -PassThru
} else {
  $p = Start-Process -FilePath $Executable -PassThru
}
if (-not $p.WaitForExit(120000)) {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  throw "Weport screenshot mode timed out after 120s"
}
if ($p.ExitCode -ne 0) {
  throw "Weport screenshot mode exited with code $($p.ExitCode)"
}

Remove-Item Env:WEPORT_SCREENSHOT_POPUP -ErrorAction SilentlyContinue
Remove-Item Env:WEPORT_SCREENSHOT_OUT -ErrorAction SilentlyContinue

$mainPng = Join-Path $OutputDir 'main.png'
$popupPng = Join-Path $OutputDir 'popup.png'
if (-not (Test-Path $mainPng)) { throw "main.png missing - main window capture failed" }
if (-not (Test-Path $popupPng)) { throw "popup.png missing - notification window capture failed" }

Assert-ImageHasContent $mainPng 'main window'
Assert-ImageHasContent $popupPng 'notification popup'
Write-Output "Screenshots written to $OutputDir"
