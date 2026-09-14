# 系统级改动的安全护栏。
#
# 背景（教训）：测玻璃透过率时换过桌面壁纸，恢复那一步把路径里的反斜杠又转义了
# 一次，Windows 于是回退成纯色 —— 用户看到的是"我的壁纸变成一片紫色"。同一次探测
# 里为了露出桌面还把可见窗口都最小化了，顺手把用户正在编辑的 Word 也收了下去。
#
# 这个脚本提供两件事：
#   1. Restore-Wallpaper —— 用**原始路径字符串**恢复壁纸（不做任何转义变换）
#   2. 记录 / 恢复被最小化的窗口
#
# 用法：
#   pwsh -File scripts/system-safety.ps1 -Action Snapshot        # 改动前先存快照
#   pwsh -File scripts/system-safety.ps1 -Action RestoreWallpaper
#   pwsh -File scripts/system-safety.ps1 -Action RestoreWindows
#   pwsh -File scripts/system-safety.ps1 -Action Restore         # 全部恢复

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Snapshot', 'RestoreWallpaper', 'RestoreWindows', 'Restore', 'Show')]
  [string]$Action,
  [string]$SnapshotPath = (Join-Path $env:TEMP 'weport-system-snapshot.json')
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace Safety -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern int SystemParametersInfo(int uiAction, int uiParam, string pvParam, int fWinIni);
[DllImport("user32.dll")]
public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")]
public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")]
public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")]
public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll", SetLastError=true)]
public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
'@

function Get-WallpaperState {
  $k = Get-ItemProperty 'HKCU:\Control Panel\Desktop'
  [pscustomobject]@{
    # 关键：原样保存字符串，恢复时**不要**再对它做任何 replace —— 反斜杠加倍过一次
    # 就会让 SystemParametersInfo 找不到文件，系统直接回退成纯色。
    WallPaper      = [string]$k.WallPaper
    WallpaperStyle = [string]$k.WallpaperStyle
    TileWallpaper  = [string]$k.TileWallpaper
  }
}

function Get-WindowState {
  Get-Process |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    ForEach-Object {
      [pscustomobject]@{
        ProcessName = $_.ProcessName
        Id          = $_.Id
        Handle      = [int64]$_.MainWindowHandle
        Minimized   = [Safety.Native]::IsIconic($_.MainWindowHandle)
      }
    }
}

function Write-Snapshot {
  $snap = [pscustomobject]@{
    CapturedAt = (Get-Date).ToString('o')
    Wallpaper  = Get-WallpaperState
    Windows    = Get-WindowState
  }
  $snap | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $SnapshotPath -Encoding utf8
  Write-Output "snapshot written: $SnapshotPath"
  Write-Output "  wallpaper: $($snap.Wallpaper.WallPaper)"
  Write-Output "  windows:   $($snap.Windows.Count) (minimized: $(($snap.Windows | Where-Object Minimized).Count))"
}

function Restore-Wallpaper {
  if (-not (Test-Path $SnapshotPath)) { throw "no snapshot at $SnapshotPath — run -Action Snapshot first" }
  $snap = Get-Content -LiteralPath $SnapshotPath -Raw | ConvertFrom-Json
  $wp = $snap.Wallpaper
  $path = [string]$wp.WallPaper
  if (-not $path) { throw 'snapshot has an empty wallpaper path' }
  if (-not (Test-Path -LiteralPath $path)) {
    Write-Warning "wallpaper file is missing: $path"
  }
  # 原样写回：路径字符串不再做任何转义处理
  Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name Wallpaper -Value $path -Type String
  if ($wp.WallpaperStyle) { Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name WallpaperStyle -Value ([string]$wp.WallpaperStyle) -Type String }
  if ($wp.TileWallpaper) { Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name TileWallpaper -Value ([string]$wp.TileWallpaper) -Type String }
  [Safety.Native]::SystemParametersInfo(20, 0, $path, 3) | Out-Null
  Start-Sleep -Seconds 2
  [Safety.Native]::SystemParametersInfo(20, 0, $path, 3) | Out-Null
  Write-Output "wallpaper restored: $path (style=$($wp.WallpaperStyle) tile=$($wp.TileWallpaper))"
}

function Restore-Windows {
  if (-not (Test-Path $SnapshotPath)) { throw "no snapshot at $SnapshotPath — run -Action Snapshot first" }
  $snap = Get-Content -LiteralPath $SnapshotPath -Raw | ConvertFrom-Json
  # 先还原 Shell_TrayWnd：explorer 被最小化时任务栏会整体消失
  $shell = [Safety.Native]::FindWindow('Shell_TrayWnd', $null)
  if ($shell -ne [IntPtr]::Zero) { [Safety.Native]::ShowWindow($shell, 9) | Out-Null }
  $restored = 0
  foreach ($w in $snap.Windows) {
    if ($w.Minimized) { continue }
    try {
      $p = Get-Process -Id $w.Id -ErrorAction Stop
      if ($p.MainWindowHandle -ne 0) {
        [Safety.Native]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
        $restored += 1
      }
    } catch {
      # 进程已经退出：跳过
    }
  }
  Write-Output "restored $restored window(s) that were visible before"
}

switch ($Action) {
  'Snapshot'         { Write-Snapshot }
  'RestoreWallpaper' { Restore-Wallpaper }
  'RestoreWindows'   { Restore-Windows }
  'Restore'          { Restore-Wallpaper; Restore-Windows }
  'Show' {
    $w = Get-WallpaperState
    Write-Output "wallpaper path : $($w.WallPaper)"
    Write-Output "  file exists  : $(Test-Path -LiteralPath $w.WallPaper)"
    Write-Output "  style/tile   : $($w.WallpaperStyle) / $($w.TileWallpaper)"
    $win = Get-WindowState
    Write-Output "visible windows: $($win.Count) (minimized: $(($win | Where-Object Minimized).Count))"
  }
}
