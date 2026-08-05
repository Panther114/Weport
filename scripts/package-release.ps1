# Package Weport native build into NSIS installer + updater assets
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$srcTauri = Join-Path $root "src-tauri"

# Derive version from Cargo.toml
$cargoToml = Join-Path $srcTauri "Cargo.toml"
$version = if (Test-Path $cargoToml) {
    $content = Get-Content $cargoToml -Raw
    if ($content -match 'version\s*=\s*"([^"]+)"') {
        $matches[1]
    } else { "0.6.10" }
} else { "0.6.10" }

$release = Join-Path $srcTauri "target\release"
$exe = Join-Path $release "weport.exe"
$stage = Join-Path $release "package"
$bundle = Join-Path $release "bundle\nsis"

if (-not (Test-Path $exe)) {
  throw "Missing weport.exe - build release first"
}

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage, $bundle | Out-Null
Copy-Item $exe (Join-Path $stage "weport.exe")

$resSrc = Join-Path $srcTauri "resources"
$resDst = Join-Path $stage "resources"
Copy-Item $resSrc $resDst -Recurse -Force

$native = Join-Path $resDst "native\win32\x64"
$wcdb = Join-Path $resDst "wcdb\win32\x64"
if ((Test-Path $native) -and -not (Test-Path (Join-Path $wcdb "wcdb_api.dll"))) {
  New-Item -ItemType Directory -Force -Path $wcdb | Out-Null
  Copy-Item (Join-Path $native "*") $wcdb -Force
}

$icon = Join-Path $srcTauri "icons\icon.ico"
$nsi = Join-Path $stage "weport.nsi"
$installName = "Weport_${version}_x64-setup.exe"
$outSetup = Join-Path $bundle $installName

$nsiBody = @"
!include "MUI2.nsh"
Name "Weport"
OutFile "$($outSetup -replace '\\','/')"
InstallDir "`$LOCALAPPDATA\Programs\Weport"
InstallDirRegKey HKCU "Software\Weport" "InstallDir"
RequestExecutionLevel user
Unicode true
SetCompressor /SOLID lzma
!define MUI_ICON "$($icon -replace '\\','/')"
!define MUI_UNICON "$($icon -replace '\\','/')"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  ; Clean binary replace only. NEVER touch %APPDATA%\Weport or %LOCALAPPDATA%\Weport
  ; user settings (decrypt keys, xwechat_files path, account keys live there).
  SetOutPath "`$INSTDIR"
  ; Kill any running weport.exe with retry
  nsExec::Exec "taskkill /F /IM weport.exe"
  Sleep 500
  nsExec::Exec "taskkill /F /IM weport.exe"
  Sleep 300
  SetOverwrite on
  File "weport.exe"
  SetOutPath "`$INSTDIR\resources"
  File /r "resources\*.*"
  WriteUninstaller "`$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Weport" "InstallDir" "`$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Weport" "DisplayName" "Weport"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Weport" "DisplayVersion" "$version"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Weport" "DisplayIcon" "`$INSTDIR\weport.exe,0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Weport" "UninstallString" "`$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Weport" "QuietUninstallString" "`$INSTDIR\Uninstall.exe /S"
  CreateDirectory "`$SMPROGRAMS\Weport"
  CreateShortCut "`$SMPROGRAMS\Weport\Weport.lnk" "`$INSTDIR\weport.exe"
  CreateShortCut "`$DESKTOP\Weport.lnk" "`$INSTDIR\weport.exe"
SectionEnd

Section "Uninstall"
  ; Remove install files only — leave user settings/keys intact.
  ; Kill any running weport.exe with retry (matches Install section).
  nsExec::Exec "taskkill /F /IM weport.exe"
  Sleep 500
  nsExec::Exec "taskkill /F /IM weport.exe"
  Sleep 300
  Delete "`$INSTDIR\weport.exe"
  Delete "`$INSTDIR\Uninstall.exe"
  RMDir /r "`$INSTDIR\resources"
  RMDir "`$INSTDIR"
  Delete "`$SMPROGRAMS\Weport\Weport.lnk"
  RMDir "`$SMPROGRAMS\Weport"
  Delete "`$DESKTOP\Weport.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Weport"
  DeleteRegKey HKCU "Software\Weport"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Weport"
SectionEnd
"@
[System.IO.File]::WriteAllText($nsi, $nsiBody)

$candidates = @(
  (Join-Path ${env:ProgramFiles(x86)} "NSIS\makensis.exe"),
  (Join-Path $env:ProgramFiles "NSIS\makensis.exe")
)
$makensis = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $makensis) {
  $cmd = Get-Command makensis -ErrorAction SilentlyContinue
  if ($cmd) { $makensis = $cmd.Source }
}
if (-not $makensis) { throw "makensis not found - install NSIS" }

Push-Location $stage
& $makensis /V2 weport.nsi
$nsisExit = $LASTEXITCODE
Pop-Location
if ($nsisExit -ne 0) { throw "makensis failed with $nsisExit" }

if (-not (Test-Path $outSetup)) {
  $found = Get-ChildItem $stage, $bundle -Filter "*setup.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { Copy-Item $found.FullName $outSetup -Force }
}
if (-not (Test-Path $outSetup)) { throw "Installer not produced at $outSetup" }

$sigPath = "$outSetup.sig"
$key = Join-Path $srcTauri "weport.key"
if (Test-Path $key) {
  $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $key
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
}
if ($env:TAURI_SIGNING_PRIVATE_KEY) {
  try {
    npx --yes @tauri-apps/cli signer sign $outSetup 2>&1 | Out-Host
  } catch {
    Write-Host "Signing skipped: $_"
  }
}

$sigText = if (Test-Path $sigPath) { (Get-Content -Raw $sigPath).Trim() } else { "" }
$latest = [ordered]@{
  version = $version
  notes = "v${version}: toast popups now render outside the app as separate egui viewport windows; multiple toasts stack vertically; fix uninstall not killing running processes"
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $sigText
      url = "https://github.com/Panther114/Weport/releases/download/v$version/$installName"
    }
  }
}
$latestPath = Join-Path $bundle "latest.json"
[System.IO.File]::WriteAllText($latestPath, ($latest | ConvertTo-Json -Depth 6))

Write-Host "OK: $outSetup"
Get-Item $outSetup, $exe | Format-Table Name, Length
