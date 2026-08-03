# Package Weport native build into NSIS installer + updater assets
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$srcTauri = Join-Path $root "src-tauri"
$release = Join-Path $srcTauri "target\release"
$exe = Join-Path $release "weport.exe"
$stage = Join-Path $release "package"
$bundle = Join-Path $release "bundle\nsis"
$version = "0.5.0"

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
InstallDir "`$PROGRAMFILES64\Weport"
InstallDirRegKey HKLM "Software\Weport" "InstallDir"
RequestExecutionLevel admin
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
  SetOutPath "`$INSTDIR"
  File "weport.exe"
  SetOutPath "`$INSTDIR\resources"
  File /r "resources\*.*"
  WriteUninstaller "`$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Weport" "InstallDir" "`$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Weport" "DisplayName" "Weport"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Weport" "DisplayVersion" "$version"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Weport" "DisplayIcon" "`$INSTDIR\weport.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Weport" "UninstallString" "`$INSTDIR\Uninstall.exe"
  CreateDirectory "`$SMPROGRAMS\Weport"
  CreateShortCut "`$SMPROGRAMS\Weport\Weport.lnk" "`$INSTDIR\weport.exe"
  CreateShortCut "`$DESKTOP\Weport.lnk" "`$INSTDIR\weport.exe"
SectionEnd

Section "Uninstall"
  Delete "`$INSTDIR\weport.exe"
  Delete "`$INSTDIR\Uninstall.exe"
  RMDir /r "`$INSTDIR\resources"
  RMDir "`$INSTDIR"
  Delete "`$SMPROGRAMS\Weport\Weport.lnk"
  RMDir "`$SMPROGRAMS\Weport"
  Delete "`$DESKTOP\Weport.lnk"
  DeleteRegKey HKLM "Software\Weport"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Weport"
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
  try {
    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $key
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
    npx --yes @tauri-apps/cli signer sign $outSetup 2>&1 | Out-Host
  } catch {
    Write-Host "Signing skipped: $_"
  }
}

$sigText = if (Test-Path $sigPath) { (Get-Content -Raw $sigPath).Trim() } else { "" }
$latest = [ordered]@{
  version = $version
  notes = "Native egui UI (no WebView2). Same export/key features."
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
