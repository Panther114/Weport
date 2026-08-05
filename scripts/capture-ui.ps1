param(
  [string]$Executable = "$PSScriptRoot\..\src-tauri\target\release\weport.exe",
  [string]$OutputDir = (Join-Path $env:TEMP "weport-v0.6.13-screenshots")
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WeportCapture {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int max);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

# The Weport process is DPI-aware (eframe manifest), so it sees physical
# pixels. The harness MUST match, otherwise GetWindowRect/ClientToScreen return
# DPI-virtualized (scaled) coordinates and CopyFromScreen captures the wrong
# region — which is exactly why v0.6.12's popup.png came out blank.
[WeportCapture]::SetProcessDPIAware() | Out-Null

function Find-ToastHost([int]$ProcessId) {
  # The native toast host registers class "WeportToastHost-<pid>". If this
  # window is missing, toast_win never started (silent unwiring regression).
  $found = [IntPtr]::Zero
  $cb = [WeportCapture+EnumWindowsProc] {
    param($hWnd, $unused)
    $owner = 0
    [WeportCapture]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
    if ($owner -eq $ProcessId -and [WeportCapture]::IsWindowVisible($hWnd)) {
      $sb = New-Object System.Text.StringBuilder 256
      [WeportCapture]::GetClassName($hWnd, $sb, 256) | Out-Null
      if ($sb.ToString().StartsWith('WeportToastHost')) { $script:found = $hWnd }
    }
    return $true
  }
  [WeportCapture]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $script:found
}

function Assert-ImageHasContent([string]$Path, [string]$Label) {
  # Variance check: a blank/transparent capture is near-uniform (low stddev);
  # a real toast has card bg + text + avatar (high stddev). Fails loud so a
  # broken popup cannot ship silently behind a green build.
  $bmp = New-Object System.Drawing.Bitmap $Path
  $w = $bmp.Width; $h = $bmp.Height
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
    throw "popup capture for '$Label' looks blank (stddev=$([Math]::Round($stddev,2)) < 12). The native toast host did not paint — toast_win is unwired or mis-rendering. Aborting."
  }
  Write-Output "  [ok] $Label popup has content (stddev=$([Math]::Round($stddev,2)))"
}

function Get-WindowInfo([int]$ProcessId) {
  $windows = [System.Collections.Generic.List[object]]::new()
  $callback = [WeportCapture+EnumWindowsProc] {
    param($hWnd, $unused)
    $owner = 0
    [WeportCapture]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
    if ($owner -eq $ProcessId -and [WeportCapture]::IsWindowVisible($hWnd)) {
      $rect = New-Object WeportCapture+RECT
      [WeportCapture]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
      $width = $rect.Right - $rect.Left
      $height = $rect.Bottom - $rect.Top
      if ($width -gt 100 -and $height -gt 60) {
        $windows.Add([pscustomobject]@{ Handle = $hWnd; Left = $rect.Left; Top = $rect.Top; Width = $width; Height = $height })
      }
    }
    return $true
  }
  [WeportCapture]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  return $windows
}

function Capture-Client([IntPtr]$Handle, [string]$Path) {
  $client = New-Object WeportCapture+RECT
  [WeportCapture]::GetClientRect($Handle, [ref]$client) | Out-Null
  $origin = New-Object WeportCapture+POINT
  [WeportCapture]::ClientToScreen($Handle, [ref]$origin) | Out-Null
  $width = $client.Right - $client.Left
  $height = $client.Bottom - $client.Top
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($origin.X, $origin.Y, 0, 0, $bitmap.Size)
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
}

function Capture-Client-Region([IntPtr]$Handle, [int]$X, [int]$Y, [int]$Width, [int]$Height, [string]$Path) {
  $origin = New-Object WeportCapture+POINT
  [WeportCapture]::ClientToScreen($Handle, [ref]$origin) | Out-Null
  $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($origin.X + $X, $origin.Y + $Y, 0, 0, $bitmap.Size)
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
}

function Click-Client([IntPtr]$Handle, [int]$X, [int]$Y) {
  $point = New-Object WeportCapture+POINT
  $point.X = $X; $point.Y = $Y
  [WeportCapture]::ClientToScreen($Handle, [ref]$point) | Out-Null
  [WeportCapture]::SetForegroundWindow($Handle) | Out-Null
  Start-Sleep -Milliseconds 150
  [WeportCapture]::SetCursorPos($point.X, $point.Y) | Out-Null
  [WeportCapture]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
  [WeportCapture]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 500
}

function Click-Absolute([IntPtr]$Handle, [int]$X, [int]$Y) {
  [WeportCapture]::SetForegroundWindow($Handle) | Out-Null
  Start-Sleep -Milliseconds 150
  [WeportCapture]::SetCursorPos($X, $Y) | Out-Null
  [WeportCapture]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
  [WeportCapture]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 700
}

$existing = Get-Process weport -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Resolve-Path $Executable).Path }
if ($existing) { throw "Stop the existing Weport process before running the screenshot harness." }

function Capture-Panel([string]$Panel, [bool]$WithPopup) {
  $env:WEPORT_SCREENSHOT_PANEL = $Panel
  if ($WithPopup) { $env:WEPORT_SCREENSHOT_POPUP = '1' } else { Remove-Item Env:WEPORT_SCREENSHOT_POPUP -ErrorAction SilentlyContinue }
  $process = Start-Process -FilePath (Resolve-Path $Executable).Path -PassThru
  try {
    $main = $null
    for ($i = 0; $i -lt 40 -and $null -eq $main; $i++) {
      Start-Sleep -Milliseconds 250
      $main = Get-WindowInfo $process.Id | Sort-Object Width -Descending | Select-Object -First 1
    }
    if ($null -eq $main) { throw "Weport main window did not appear for $Panel." }
    [WeportCapture]::ShowWindow($main.Handle, 5) | Out-Null
    [WeportCapture]::SetForegroundWindow($main.Handle) | Out-Null
    Start-Sleep -Milliseconds 500
    Capture-Client $main.Handle (Join-Path $OutputDir "$Panel.png")

    if ($WithPopup) {
      Start-Sleep -Seconds 1
      # v0.6.11 captured a region of the MAIN window because the toast was an
      # embedded egui viewport. v0.6.12 moved the toast into a separate native
      # topmost window (class WeportToastHost-<pid>), so the old capture was
      # blank. Find that host window and capture its first card directly.
      $toastHwnd = [IntPtr]::Zero
      for ($i = 0; $i -lt 20 -and $toastHwnd -eq [IntPtr]::Zero; $i++) {
        $toastHwnd = Find-ToastHost $process.Id
        if ($toastHwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 150 }
      }
      if ($toastHwnd -eq [IntPtr]::Zero) {
        throw "WeportToastHost window never appeared for $Panel — toast_win is not wired (regression)."
      }
      # Capture the top card: full client width, first ~140px (card is 112 + margin).
      $origin = New-Object WeportCapture+POINT
      [WeportCapture]::ClientToScreen($toastHwnd, [ref]$origin) | Out-Null
      $popupPath = Join-Path $OutputDir 'popup.png'
      $bitmap = New-Object System.Drawing.Bitmap 400, 140
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($origin.X, $origin.Y, 0, 0, $bitmap.Size)
      $bitmap.Save($popupPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $graphics.Dispose(); $bitmap.Dispose()
      Assert-ImageHasContent $popupPath $Panel
    }
  }
  finally {
    if (-not $process.HasExited) { $process.CloseMainWindow() | Out-Null; Start-Sleep -Milliseconds 800; if (-not $process.HasExited) { $process.Kill() } }
    Start-Sleep -Milliseconds 800
  }
}

foreach ($panel in @('connect', 'export', 'antirecall', 'notifications')) {
  Capture-Panel $panel ($panel -eq 'notifications')
}
Remove-Item Env:WEPORT_SCREENSHOT_PANEL -ErrorAction SilentlyContinue
Remove-Item Env:WEPORT_SCREENSHOT_POPUP -ErrorAction SilentlyContinue
Write-Output "Screenshots written to $OutputDir"
