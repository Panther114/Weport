# run-weclone-server.ps1 — start the WeClone server detached for local evaluation.
#
# Why a script: this server must outlive the shell that starts it. Killing it from the
# same tool invocation that launched it has twice taken the whole command runner down
# with it, so the launcher is written once, documented, and invoked via
# `cmd /c start` (a detached process with no job object relationship to the caller).
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/run-weclone-server.ps1 [-Restart]

param([switch]$Restart, [string]$Port = '8099')

$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $env:TEMP 'weclone-server.pid'
if ($Restart -and (Test-Path $pidFile)) {
  $old = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($old) { Stop-Process -Id $old -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

# 端口可由调用方指定（应用内自动拉起时会带上配置里的端口）；
# 已经通过环境变量传进来的话以环境变量为准。
if (-not $env:PORT) { $env:PORT = $Port }
$env:HOST = '127.0.0.1'
$env:WECLONE_DATA_DIR = 'D:\Devs\Weflow\weport\weclone-server\data'
$env:WECLONE_LLM_API_KEY = 'sk-qCluV5o9ldutuuxtQPkhaFxqEi5d6uTE6SqLxugxtN6RDtoALWPJxxsArxZmRizO'
# Local evaluation only: the upload route allows a handful per hour by design, which
# makes a measurement loop impossible. Never set these on a reachable host.
$env:WECLONE_E2E = '1'
$env:WECLONE_RATE_LIMIT_UPLOAD = '200'
$env:WECLONE_RATE_LIMIT_CHAT = '2000'
$env:WECLONE_MAX_CLONES_PER_TOKEN = '40'

$out = Join-Path $env:TEMP 'weclone-server-out.log'
$err = Join-Path $env:TEMP 'weclone-server-err.log'
$proc = Start-Process -FilePath 'node' -ArgumentList 'dist/server.js' -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $out -RedirectStandardError $err `
  -WorkingDirectory 'D:\Devs\Weflow\weport\weclone-server'
Set-Content -LiteralPath $pidFile -Value $proc.Id
Start-Sleep -Seconds 4
Get-Content $out -Tail 3
Write-Output "pid=$($proc.Id)"
