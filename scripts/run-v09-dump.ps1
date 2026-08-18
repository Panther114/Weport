# Isolated v0.9.x renderer smoke harness.
# Uses a dedicated Electron user-data directory so it cannot reuse the
# installed Weport instance or write demo data into the user's profile.
param(
  [string]$Executable = "",
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path,
  [string]$OutputDir = (Join-Path $env:TEMP "weport-v097-dump"),
  [string]$UserDataDir = (Join-Path $env:TEMP "weport-v097-user-data")
)

$ErrorActionPreference = 'Stop'
$ProjectRootArg = $null

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
New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
$stdoutPath = Join-Path $OutputDir 'app.stdout.log'
$stderrPath = Join-Path $OutputDir 'app.stderr.log'
$fatalPath = Join-Path $OutputDir 'fatal.log'

$env:WEPORT_V09_DUMP = '1'
$env:WEPORT_V09_DUMP_OUT = $OutputDir
$env:WEPORT_FATAL_LOG = $fatalPath
Remove-Item Env:WEPORT_SCREENSHOT_POPUP -ErrorAction SilentlyContinue
Remove-Item Env:WEPORT_AI_SELFTEST -ErrorAction SilentlyContinue

try {
  if ($ProjectRootArg) {
    $processArgs = @($ProjectRootArg, "--user-data-dir=$UserDataDir")
  } else {
    $processArgs = @("--user-data-dir=$UserDataDir")
  }
  Write-Output "Launching $Executable (v0.9 dump mode)..."
  $process = Start-Process -FilePath $Executable -ArgumentList $processArgs -PassThru `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  if (-not $process.WaitForExit(180000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "v0.9 dump timed out after 180s (see $stdoutPath / $stderrPath)"
  }

  $code = $process.ExitCode
  if ($null -eq $code) {
    $stdout = Get-Content $stdoutPath -Raw -ErrorAction SilentlyContinue
    $code = if ($stdout -match 'RESULT =') { 0 } else { -1 }
  }
  if ($code -ne 0) {
    Write-Output "--- app.stdout.log (tail) ---"
    Get-Content $stdoutPath -ErrorAction SilentlyContinue | Select-Object -Last 80
    Write-Output "--- app.stderr.log (tail) ---"
    Get-Content $stderrPath -ErrorAction SilentlyContinue | Select-Object -Last 30
    if (Test-Path $fatalPath) {
      Write-Output "--- fatal.log ---"
      Get-Content $fatalPath -ErrorAction SilentlyContinue | Select-Object -Last 30
    }
    throw "v0.9 dump exited with code $code"
  }

  $dumpPath = Join-Path $OutputDir 'v09-dump.json'
  if (-not (Test-Path $dumpPath)) {
    throw "v0.9 dump did not produce $dumpPath"
  }
  Write-Output "v0.9 dump passed: $dumpPath"
} finally {
  Remove-Item Env:WEPORT_V09_DUMP -ErrorAction SilentlyContinue
  Remove-Item Env:WEPORT_V09_DUMP_OUT -ErrorAction SilentlyContinue
  Remove-Item Env:WEPORT_FATAL_LOG -ErrorAction SilentlyContinue
}
