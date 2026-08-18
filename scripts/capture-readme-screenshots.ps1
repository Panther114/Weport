# Capture README screenshots from the user's real Weport configuration without
# exposing the source profile. The app receives a temporary clone, applies its
# renderer privacy mask in WEPORT_REAL_SCREENSHOT mode, and this script copies
# only the image assets referenced by README.md into docs/screenshots.
[CmdletBinding()]
param(
  [string]$Executable = "",
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path,
  [string]$SourceUserDataDir = (Join-Path $env:APPDATA "Weport"),
  [string]$UserDataDir = (Join-Path $env:TEMP ("weport-readme-profile-" + [guid]::NewGuid().ToString('N'))),
  [string]$OutputDir = (Join-Path $env:TEMP ("weport-readme-screenshots-" + [guid]::NewGuid().ToString('N'))),
  [string]$DocsDir = ""
)

$ErrorActionPreference = 'Stop'

if (-not $Executable) {
  $installed = Join-Path $env:LOCALAPPDATA "Programs\Weport\Weport.exe"
  $packaged = Join-Path $ProjectRoot "release\win-unpacked\Weport.exe"
  if (Test-Path -LiteralPath $installed) {
    $Executable = $installed
  } elseif (Test-Path -LiteralPath $packaged) {
    $Executable = $packaged
  } else {
    throw "Weport.exe was not found. Pass -Executable explicitly."
  }
}
if (-not $DocsDir) {
  $DocsDir = Join-Path $ProjectRoot "docs\screenshots"
}

if (-not (Test-Path -LiteralPath $SourceUserDataDir -PathType Container)) {
  throw "Source Weport profile was not found: $SourceUserDataDir"
}
$sourceConfig = Join-Path $SourceUserDataDir 'Weport-config.json'
if (-not (Test-Path -LiteralPath $sourceConfig -PathType Leaf)) {
  throw "Weport-config.json was not found in the source profile: $SourceUserDataDir"
}

New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
New-Item -ItemType Directory -Force -Path $DocsDir | Out-Null
Get-ChildItem -LiteralPath $OutputDir -File -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }

# Copy only state needed to render the real account. Caches, lock files, logs,
# cookies, and the original profile directory stay out of the clone.
Copy-Item -LiteralPath $sourceConfig -Destination (Join-Path $UserDataDir 'Weport-config.json') -Force
$sourceConfigBackup = Join-Path $SourceUserDataDir 'Weport-config.json.bak'
if (Test-Path -LiteralPath $sourceConfigBackup -PathType Leaf) {
  Copy-Item -LiteralPath $sourceConfigBackup -Destination (Join-Path $UserDataDir 'Weport-config.json.bak') -Force
}
$sourceAiDir = Join-Path $SourceUserDataDir 'weport-ai'
if (Test-Path -LiteralPath $sourceAiDir -PathType Container) {
  $targetAiDir = Join-Path $UserDataDir 'weport-ai'
  New-Item -ItemType Directory -Force -Path $targetAiDir | Out-Null
  $sourceAiIndex = Join-Path $sourceAiDir 'index.json'
  if (Test-Path -LiteralPath $sourceAiIndex -PathType Leaf) {
    Copy-Item -LiteralPath $sourceAiIndex -Destination (Join-Path $targetAiDir 'index.json') -Force
  }
  $sourceAiSessions = Join-Path $sourceAiDir 'sessions'
  if (Test-Path -LiteralPath $sourceAiSessions -PathType Container) {
    Copy-Item -LiteralPath $sourceAiSessions -Destination $targetAiDir -Recurse -Force
  }
}

Add-Type -AssemblyName System.Drawing
function Assert-ImageHasContent([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label was not captured: $Path"
  }
  $bmp = New-Object System.Drawing.Bitmap $Path
  try {
    if ($bmp.Width -lt 50 -or $bmp.Height -lt 50) {
      throw "$Label is too small ($($bmp.Width)x$($bmp.Height))"
    }
    $sum = 0.0
    $sumSq = 0.0
    $n = 0
    for ($x = 0; $x -lt $bmp.Width; $x += 4) {
      for ($y = 0; $y -lt $bmp.Height; $y += 4) {
        $c = $bmp.GetPixel($x, $y)
        $v = [int]$c.R * 0.3 + [int]$c.G * 0.59 + [int]$c.B * 0.11
        $sum += $v
        $sumSq += $v * $v
        $n++
      }
    }
    $mean = $sum / [Math]::Max(1, $n)
    $variance = ($sumSq / [Math]::Max(1, $n)) - ($mean * $mean)
    $stddev = [Math]::Sqrt([Math]::Max(0.0, $variance))
    if ($stddev -lt 8.0) {
      throw "$Label appears blank (stddev=$([Math]::Round($stddev, 2)))"
    }
    Write-Output "  [ok] $Label $($bmp.Width)x$($bmp.Height), stddev=$([Math]::Round($stddev, 2))"
  } finally {
    $bmp.Dispose()
  }
}

$appOut = Join-Path $OutputDir 'app.stdout.log'
$appErr = Join-Path $OutputDir 'app.stderr.log'
$fatalLog = Join-Path $OutputDir 'fatal.log'
$process = $null
$cloneCreated = $true
try {
  $env:WEPORT_SCREENSHOT_POPUP = '1'
  $env:WEPORT_REAL_SCREENSHOT = '1'
  $env:WEPORT_SCREENSHOT_OUT = $OutputDir
  $env:WEPORT_FATAL_LOG = $fatalLog
  Remove-Item Env:ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue

  Write-Output "Launching real-profile screenshot capture with $Executable"
  Write-Output "Using isolated profile clone: $UserDataDir"
  $process = Start-Process -FilePath $Executable `
    -ArgumentList @("--user-data-dir=$UserDataDir") `
    -PassThru -RedirectStandardOutput $appOut -RedirectStandardError $appErr
  if (-not $process.WaitForExit(300000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "Real-profile screenshot capture timed out after 300 seconds. See $OutputDir"
  }
  $exitCode = $process.ExitCode
  if ($null -eq $exitCode) {
    # Electron can force-exit after app.exit while PowerShell still reports a
    # null Process.ExitCode. The completion marker is emitted only after all
    # captures and service shutdown have finished.
    $stdout = Get-Content -LiteralPath $appOut -Raw -ErrorAction SilentlyContinue
    $exitCode = if ($stdout -match 'forcing process\.exit') { 0 } else { -1 }
  }
  if ($exitCode -ne 0) {
    $stdoutTail = (Get-Content -LiteralPath $appOut -ErrorAction SilentlyContinue | Select-Object -Last 40) -join "`n"
    $stderrTail = (Get-Content -LiteralPath $appErr -ErrorAction SilentlyContinue | Select-Object -Last 20) -join "`n"
    Write-Output '--- app.stdout.log (tail) ---'
    Write-Output $stdoutTail
    Write-Output '--- app.stderr.log (tail) ---'
    Write-Output $stderrTail
    throw "Real-profile screenshot capture exited with code $exitCode."
  }

  $mapping = [ordered]@{
    'main.png' = 'connect.png'
    'export.png' = 'export.png'
    'sns.png' = 'sns.png'
    'analytics-hub.png' = 'analytics-hub.png'
    'analytics-global.png' = 'analytics-global.png'
    'analytics-group.png' = 'analytics-group.png'
    'annual-report.png' = 'annual-report.png'
    'ai.png' = 'ai.png'
    'settings.png' = 'settings.png'
    'popup.png' = 'popup.png'
  }
  foreach ($entry in $mapping.GetEnumerator()) {
    $source = Join-Path $OutputDir $entry.Key
    Assert-ImageHasContent $source $entry.Key
    Copy-Item -LiteralPath $source -Destination (Join-Path $DocsDir $entry.Value) -Force
  }
  Write-Output "Published only screenshot assets to $DocsDir"
} finally {
  Remove-Item Env:WEPORT_SCREENSHOT_POPUP -ErrorAction SilentlyContinue
  Remove-Item Env:WEPORT_REAL_SCREENSHOT -ErrorAction SilentlyContinue
  Remove-Item Env:WEPORT_SCREENSHOT_OUT -ErrorAction SilentlyContinue
  Remove-Item Env:WEPORT_FATAL_LOG -ErrorAction SilentlyContinue

  if ($cloneCreated -and (Test-Path -LiteralPath $UserDataDir)) {
    $tempRoot = ([IO.Path]::GetFullPath($env:TEMP)).TrimEnd('\') + '\'
    $cloneFull = [IO.Path]::GetFullPath($UserDataDir)
    if ($cloneFull.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $cloneFull -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      Write-Warning "Refusing to remove profile clone outside TEMP: $cloneFull"
    }
  }
}
