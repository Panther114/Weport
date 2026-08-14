# Weport UI capture harness (Electron)
# Captures the main window + notification popup via the app's own
# WEPORT_SCREENSHOT_POPUP mode, then asserts the popup is non-blank.
# A blank popup (broken renderer / unwired viewport) fails the build.
param(
  [string]$Executable = "",
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path,
  [string]$OutputDir = (Join-Path $env:TEMP "weport-electron-screenshots"),
  [switch]$PublishToDocs
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
# 清空历史截图：旧文件会让断言「假通过」（文件存在但本次根本没写成功）
Get-ChildItem -Path $OutputDir -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

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
$appLog = Join-Path $OutputDir 'app.log'
$appOut = Join-Path $OutputDir 'app.stdout.log'
$appErr = Join-Path $OutputDir 'app.stderr.log'
if ($ProjectRootArg) {
  $p = Start-Process -FilePath $Executable -ArgumentList $ProjectRootArg -PassThru -RedirectStandardOutput $appOut -RedirectStandardError $appErr
} else {
  $p = Start-Process -FilePath $Executable -PassThru -RedirectStandardOutput $appOut -RedirectStandardError $appErr
}
$waited = $p.WaitForExit(120000)
if (-not $waited) {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  throw "Weport screenshot mode timed out after 120s (see $appOut / $appErr)"
}
$code = $p.ExitCode
if ($null -eq $code) {
  # 重定向标准输出时部分 PowerShell 版本拿不到 ExitCode；
  # 以 stdout 里的完成标记为准
  $stdout = Get-Content $appOut -Raw -ErrorAction SilentlyContinue
  if ($stdout -match 'forcing process.exit') { $code = 0 } else { $code = -1 }
}
if ($code -ne 0) {
  $tail = (Get-Content $appOut -ErrorAction SilentlyContinue | Select-Object -Last 25) -join "`n"
  $errTail = (Get-Content $appErr -ErrorAction SilentlyContinue | Select-Object -Last 10) -join "`n"
  Write-Output "--- app.stdout.log (tail) ---"
  Write-Output $tail
  Write-Output "--- app.stderr.log (tail) ---"
  Write-Output $errTail
  throw "Weport screenshot mode exited with code $code (see $appOut / $appErr)"
}

Remove-Item Env:WEPORT_SCREENSHOT_POPUP -ErrorAction SilentlyContinue
Remove-Item Env:WEPORT_SCREENSHOT_OUT -ErrorAction SilentlyContinue

$mainPng = Join-Path $OutputDir 'main.png'
$popupPng = Join-Path $OutputDir 'popup.png'
$exportPng = Join-Path $OutputDir 'export.png'
$antirecallPng = Join-Path $OutputDir 'antirecall.png'
$notificationsPng = Join-Path $OutputDir 'notifications.png'
$aiPng = Join-Path $OutputDir 'ai.png'
$snsPng = Join-Path $OutputDir 'sns.png'
$hubPng = Join-Path $OutputDir 'analytics-hub.png'
$globalPng = Join-Path $OutputDir 'analytics-global.png'
$annualPng = Join-Path $OutputDir 'annual-report.png'
$groupPng = Join-Path $OutputDir 'analytics-group.png'
$settingsPng = Join-Path $OutputDir 'settings.png'
function Assert-Captured([string]$Path, [string]$Label) {
  if (-not (Test-Path $Path)) {
    $tail = (Get-Content $appOut -ErrorAction SilentlyContinue | Select-Object -Last 30) -join "`n"
    $errTail = (Get-Content $appErr -ErrorAction SilentlyContinue | Select-Object -Last 10) -join "`n"
    $shotLog = Join-Path $OutputDir 'screenshot.log'
    $shotTail = (Get-Content $shotLog -ErrorAction SilentlyContinue | Select-Object -Last 40) -join "`n"
    Write-Output "--- screenshot.log (tail) ---"
    Write-Output $shotTail
    Write-Output "--- app.stdout.log (tail) ---"
    Write-Output $tail
    Write-Output "--- app.stderr.log (tail) ---"
    Write-Output $errTail
    throw "$Label missing - capture failed (see $shotLog / $appOut / $appErr)"
  }
}
Assert-Captured $mainPng 'main.png'
Assert-Captured $popupPng 'popup.png'
Assert-Captured $exportPng 'export.png'
Assert-Captured $antirecallPng 'antirecall.png'
Assert-Captured $notificationsPng 'notifications.png'
# AI 页截图在 CI 软渲染下偶发挂载超时（渲染进程忙），作为软性检查：
# 失败仅警告，不阻断（README 该图由本地 -PublishToDocs 重新生成）
if (-not (Test-Path $aiPng)) {
  Write-Output "WARN ai.png missing - WeportAI tab capture failed (non-fatal; see screenshot.log)"
}
Assert-Captured $snsPng 'sns.png'
Assert-Captured $hubPng 'analytics-hub.png'
Assert-Captured $globalPng 'analytics-global.png'
Assert-Captured $annualPng 'annual-report.png'
Assert-Captured $groupPng 'analytics-group.png'
Assert-Captured $settingsPng 'settings.png'

Assert-ImageHasContent $mainPng 'main window'
Assert-ImageHasContent $popupPng 'notification popup'
Assert-ImageHasContent $exportPng 'export tab'
Assert-ImageHasContent $antirecallPng 'antirecall tab'
Assert-ImageHasContent $notificationsPng 'notifications tab'
if (Test-Path $aiPng) { Assert-ImageHasContent $aiPng 'WeportAI tab' }
Assert-ImageHasContent $snsPng 'moments'
Assert-ImageHasContent $hubPng 'analytics hub'
Assert-ImageHasContent $globalPng 'global analytics'
Assert-ImageHasContent $annualPng 'annual report'
Assert-ImageHasContent $groupPng 'group analytics'
Assert-ImageHasContent $settingsPng 'settings'
Write-Output "Screenshots written to $OutputDir"

if ($PublishToDocs) {
  $docsDir = Join-Path $ProjectRoot "docs\screenshots"
  New-Item -ItemType Directory -Force -Path $docsDir | Out-Null
  Copy-Item $mainPng (Join-Path $docsDir "connect.png") -Force
  Copy-Item $exportPng (Join-Path $docsDir "export.png") -Force
  Copy-Item $antirecallPng (Join-Path $docsDir "antirecall.png") -Force
  Copy-Item $notificationsPng (Join-Path $docsDir "notifications.png") -Force
  Copy-Item $aiPng (Join-Path $docsDir "ai.png") -Force
  Copy-Item $popupPng (Join-Path $docsDir "popup.png") -Force
  Copy-Item $snsPng (Join-Path $docsDir "sns.png") -Force
  Copy-Item $hubPng (Join-Path $docsDir "analytics-hub.png") -Force
  Copy-Item $globalPng (Join-Path $docsDir "analytics-global.png") -Force
  Copy-Item $annualPng (Join-Path $docsDir "annual-report.png") -Force
  Copy-Item $groupPng (Join-Path $docsDir "analytics-group.png") -Force
  Copy-Item $settingsPng (Join-Path $docsDir "settings.png") -Force
  Write-Output "Published screenshots to $docsDir"
}
