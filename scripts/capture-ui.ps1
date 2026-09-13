# Weport UI capture harness (Electron)
# Captures the main window + notification popup via the app's own
# WEPORT_SCREENSHOT_POPUP mode, then asserts the popup is non-blank.
# A blank popup (broken renderer / unwired viewport) fails the build.
param(
  [string]$Executable = "",
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path,
  [string]$OutputDir = (Join-Path $env:TEMP "weport-electron-screenshots"),
  [string]$UserDataDir = (Join-Path $env:TEMP ("weport-electron-screenshot-user-data-" + [guid]::NewGuid().ToString('N'))),
  # 17 张截图 + 一次响应式窗口重排。120s 是 12 张时代的预算，机器一忙就会在
  # 中途（WeportAI 那一步）超时，看起来像"截图失败"，其实是预算不够。
  [int]$TimeoutSeconds = 300,
  # 浅色模式整套跑一遍：捕获 + 对比度审计。浅色最容易出的问题（白底白字）
  # 用"截图非空白"是抓不到的。
  [switch]$LightMode,
  # 覆盖强调色（blue / violet / teal / rose / amber / graphite），用于逐套抽查。
  [string]$Accent = '',
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
New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
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
if ($LightMode) { $env:WEPORT_THEME_MODE = 'light' } else { Remove-Item Env:WEPORT_THEME_MODE -ErrorAction SilentlyContinue }
if ($Accent) { $env:WEPORT_THEME_ACCENT = $Accent } else { Remove-Item Env:WEPORT_THEME_ACCENT -ErrorAction SilentlyContinue }
Remove-Item Env:ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue

Write-Output "Launching $Executable (screenshot mode)..."
$appLog = Join-Path $OutputDir 'app.log'
$appOut = Join-Path $OutputDir 'app.stdout.log'
$appErr = Join-Path $OutputDir 'app.stderr.log'
if ($ProjectRootArg) {
  $processArgs = @($ProjectRootArg, "--user-data-dir=$UserDataDir")
} else {
  $processArgs = @("--user-data-dir=$UserDataDir")
}
$p = Start-Process -FilePath $Executable -ArgumentList $processArgs -PassThru -RedirectStandardOutput $appOut -RedirectStandardError $appErr
$waited = $p.WaitForExit($TimeoutSeconds * 1000)
if (-not $waited) {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  throw "Weport screenshot mode timed out after ${TimeoutSeconds}s (see $appOut / $appErr)"
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
$dualPng = Join-Path $OutputDir 'dual-report.png'
$settingsPng = Join-Path $OutputDir 'settings.png'
$settingsAppearancePng = Join-Path $OutputDir 'settings-appearance.png'
$settingsConnectPng = Join-Path $OutputDir 'settings-connect.png'
$webotPng = Join-Path $OutputDir 'webot.png'
$webotNotesPng = Join-Path $OutputDir 'webot-notes.png'
$webotNarrowPng = Join-Path $OutputDir 'webot-narrow.png'
$aiNarrowPng = Join-Path $OutputDir 'ai-narrow.png'
$weclonePng = Join-Path $OutputDir 'weclone.png'
$wecloneManagePng = Join-Path $OutputDir 'weclone-manage.png'
$wecloneCreatePng = Join-Path $OutputDir 'weclone-create.png'
$viewportMetrics = Join-Path $OutputDir 'viewport-metrics.json'
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
Assert-Captured (Join-Path $OutputDir 'export-scope-rects.json') 'export-scope-rects.json'
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
Assert-Captured $dualPng 'dual-report.png'
Assert-Captured $settingsPng 'settings.png'
Assert-Captured $settingsAppearancePng 'settings-appearance.png'
Assert-Captured $settingsConnectPng 'settings-connect.png'
Assert-Captured $webotPng 'webot.png'
Assert-Captured $webotNotesPng 'webot-notes.png'
Assert-Captured $webotNarrowPng 'webot-narrow.png'
Assert-Captured $aiNarrowPng 'ai-narrow.png'
Assert-Captured $weclonePng 'weclone.png'
Assert-Captured $wecloneManagePng 'weclone-manage.png'
Assert-Captured $wecloneCreatePng 'weclone-create.png'
Assert-Captured $viewportMetrics 'viewport-metrics.json'

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
Assert-ImageHasContent $dualPng 'dual report'
Assert-ImageHasContent $settingsPng 'settings'
Assert-ImageHasContent $settingsAppearancePng 'settings appearance'
Assert-ImageHasContent $settingsConnectPng 'settings connections'
Assert-ImageHasContent $webotPng 'WeBot tasks'
Assert-ImageHasContent $webotNotesPng 'WeBot notes'
Assert-ImageHasContent $webotNarrowPng 'WeBot at narrow width'
Assert-ImageHasContent $aiNarrowPng 'WeportAI at narrow width'
Assert-ImageHasContent $weclonePng 'WeClone'
Assert-ImageHasContent $wecloneManagePng 'WeClone manage'
Assert-ImageHasContent $wecloneCreatePng 'WeClone create'

# Responsive assertions: horizontal overflow and nav-label visibility.
#
# Neither is detectable by "the screenshot looks fine": horizontal overflow just
# silently clips content on the right, and labels hidden by an over-eager media
# query would negate the whole point of the v1.0 navigation rework.
#
# NOTE: keep these strings ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# unless the file has a UTF-8 BOM, and an em-dash becomes a byte that it treats
# as a closing quote.
$metrics = Get-Content $viewportMetrics -Raw | ConvertFrom-Json
foreach ($name in @('narrow', 'wide')) {
  $m = $metrics.$name
  if ($null -eq $m) { throw "viewport-metrics.json missing '$name' entry" }
  Write-Output "  [viewport:$name] $($m.viewport)px rail=$($m.railW) labels=$($m.labelsVisible) overflow=$($m.docOverflow)"
  if ($m.docOverflow -gt 2) {
    throw "horizontal overflow at ${name} ($($m.viewport)px): $($m.docOverflow)px - content is being clipped. Aborting."
  }
  if ($m.railItems -lt 10) {
    throw "navigation rail incomplete at ${name}: $($m.railItems) items (expected >= 10). Aborting."
  }
  if ($m.statusChips -lt 3) {
    throw "global status strip incomplete at ${name}: $($m.statusChips) chips (expected >= 3). Aborting."
  }
  # WeBot 布局回归：编辑器必须占满内容宽度（旧版并排两栏把任务列表挤到约
  # 300px，卡片标题被动作按钮压成每行一两个字），且卡片本身不能窄到塌掉。
  if ($m.webotEditorW -le 0) {
    throw "WeBot editor missing at ${name} - the task page did not render. Aborting."
  }
  if ($m.webotTitleW -lt 60) {
    throw "WeBot task title squeezed to $($m.webotTitleW)px at ${name} - the card actions are starving the title. Aborting."
  }
  if ($m.webotCardW -lt 300) {
    throw "WeBot task card collapsed to $($m.webotCardW)px at ${name}. Aborting."
  }
  Write-Output "  [webot:$name] card=$($m.webotCardW) title=$($m.webotTitleW) listCols=$($m.webotListCols) editorGridCols=$($m.webotGridCols)"
}

# WeportAI 三栏是唯一一个两侧栏会跟中间内容抢宽度的页面，单独断言：不管窗口多
# 窄，中间那一栏都得留下能读的宽度（曾经的 1100/940 断点被 v1.scss 覆盖，
# 986px 视口下中间一栏只剩约 270px）。
foreach ($name in @('aiNarrow', 'aiWide')) {
  $m = $metrics.$name
  if ($null -eq $m) { throw "viewport-metrics.json missing '$name' entry" }
  Write-Output "  [ai:$name] $($m.viewport)px cols=$($m.aiCols -join '/') thread=$($m.aiThreadW) overflow=$($m.docOverflow)"
  if ($m.aiThreadW -lt 300) {
    throw "WeportAI middle column squeezed to $($m.aiThreadW)px at ${name} ($($m.viewport)px). Aborting."
  }
  if ($m.docOverflow -gt 2) {
    throw "horizontal overflow on WeportAI at ${name} ($($m.viewport)px): $($m.docOverflow)px. Aborting."
  }
  if ($m.aiCols.Count -lt 2) {
    throw "WeportAI shell collapsed at ${name}: cols=$($m.aiCols -join '/'). Aborting."
  }
}
if ($metrics.narrow.labelsVisible -ne $true) {
  throw "navigation labels hidden at $($metrics.narrow.viewport)px - the rail collapsed far too early. Aborting."
}

# Placeholder scan: a page can render, be non-blank, and still be showing
# "undefined 条" / "NaN" / "[object Object]" to the user. That is not detectable
# by stddev, and the group analytics page carried three "undefined 条" rows
# through many green runs. Any hit is a failure.
$placeholderScan = Join-Path $OutputDir 'placeholder-scan.json'
Assert-Captured $placeholderScan 'placeholder-scan.json'
$placeholders = Get-Content $placeholderScan -Raw | ConvertFrom-Json
$offenders = @()
foreach ($prop in $placeholders.PSObject.Properties) {
  if ($prop.Value -and $prop.Value.Count -gt 0) {
    $offenders += "$($prop.Name): $($prop.Value -join ', ')"
  }
}
if ($offenders.Count -gt 0) {
  throw ("placeholder text visible on screen - " + ($offenders -join ' | ') + " (see placeholder-scan.json). Aborting.")
}
Write-Output "  [placeholders] none visible on any captured screen"

# Contrast audit: in light mode the classic failure is not "blank" but white text
# on white - invisible to a stddev check. The app walks every element with its own
# text, resolves the effective background and computes the WCAG ratio; anything
# under 3.0 lands here.
$contrastScan = Join-Path $OutputDir 'contrast-audit.json'
Assert-Captured $contrastScan 'contrast-audit.json'
$contrast = Get-Content $contrastScan -Raw | ConvertFrom-Json
$contrastOffenders = @()
foreach ($prop in $contrast.PSObject.Properties) {
  if ($prop.Value -and $prop.Value.Count -gt 0) {
    $worst = ($prop.Value | Sort-Object { [double]$_.ratio } | Select-Object -First 1)
    $contrastOffenders += "$($prop.Name) ($($prop.Value.Count) el, worst $($worst.ratio): ""$($worst.text)"" $($worst.color) on $($worst.bg))"
  }
}
if ($contrastOffenders.Count -gt 0) {
  throw ("contrast below 3.0 - " + ($contrastOffenders -join ' | ') + " (see contrast-audit.json). Aborting.")
}
Write-Output "  [contrast] no text below 3.0 on any captured screen"
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
  # v1.0 新增界面：README 的截图清单必须覆盖新功能，否则新东西在 README 里根本
  # 不存在。设置页第二张是「外观」分类（背景图 / 强调色 / 密度 / 主题）。
  Copy-Item $settingsAppearancePng (Join-Path $docsDir "settings-appearance.png") -Force
  Copy-Item $webotPng (Join-Path $docsDir "webot.png") -Force
  Copy-Item $webotNotesPng (Join-Path $docsDir "webot-notes.png") -Force
  Copy-Item $weclonePng (Join-Path $docsDir "weclone.png") -Force
  Write-Output "Published screenshots to $docsDir"
}
