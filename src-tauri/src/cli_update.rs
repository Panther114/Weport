//! CLI self-update against GitHub Releases for Panther114/Weport.
//!
//! Update policy (v0.6.6+):
//! - Settings (decrypt keys, db path, export path, account keys) live under the
//!   OS user data directory (`%APPDATA%/Weport` / data_dir), never in the
//!   install folder. NSIS only replaces Program Files content.
//! - Before running the installer we still snapshot settings.json as a safety
//!   net and restore only if the live file is missing/empty after install.
//! - Silent install waits for NSIS to finish, then relaunches weport.exe.
use crate::settings;
use futures_util::StreamExt;
use semver::Version;
use serde::Deserialize;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

const REPO: &str = "Panther114/Weport";
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    assets: Vec<GhAsset>,
    body: Option<String>,
    html_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

fn normalize_tag(tag: &str) -> String {
    tag.trim().trim_start_matches('v').to_string()
}

pub async fn check_update() -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .user_agent(format!("Weport-CLI/{}", CURRENT_VERSION))
        .build()?;
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let release: GhRelease = client
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let latest = normalize_tag(&release.tag_name);
    let current = Version::parse(CURRENT_VERSION)?;
    let remote = Version::parse(&latest)?;

    if remote <= current {
        println!(
            "{}",
            serde_json::json!({
                "success": true,
                "updateAvailable": false,
                "currentVersion": CURRENT_VERSION,
                "latestVersion": latest
            })
        );
        return Ok(());
    }

    println!(
        "{}",
        serde_json::json!({
            "success": true,
            "updateAvailable": true,
            "currentVersion": CURRENT_VERSION,
            "latestVersion": latest,
            "notes": release.body,
            "url": release.html_url
        })
    );
    Ok(())
}

pub async fn perform_update(yes: bool) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .user_agent(format!("Weport-CLI/{}", CURRENT_VERSION))
        .build()?;
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let release: GhRelease = client
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let latest = normalize_tag(&release.tag_name);
    let current = Version::parse(CURRENT_VERSION)?;
    let remote = Version::parse(&latest)?;

    if remote <= current {
        eprintln!("[update] Already on latest version v{CURRENT_VERSION}");
        println!(
            "{}",
            serde_json::json!({ "success": true, "updated": false, "version": CURRENT_VERSION })
        );
        return Ok(());
    }

    // Prefer NSIS installer for full GUI+CLI update
    let asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with("-setup.exe") || a.name.ends_with("_x64-setup.exe"))
        .or_else(|| {
            release
                .assets
                .iter()
                .find(|a| a.name.ends_with(".exe") && a.name.to_lowercase().contains("setup"))
        })
        .or_else(|| release.assets.iter().find(|a| a.name.ends_with(".msi")));

    let Some(asset) = asset else {
        eprintln!(
            "[update] No installer asset found. Open: {:?}",
            release.html_url
        );
        if let Some(html) = &release.html_url {
            let _ = open::that(html);
        }
        return Err("No installer asset in latest release".into());
    };

    eprintln!("[update] Downloading {} → v{} …", asset.name, latest);

    // Safety net: settings live outside the install dir, but snapshot anyway.
    let settings_snap = settings::backup_settings_for_update().ok();
    if let Some(ref snap) = settings_snap {
        eprintln!(
            "[update] Settings snapshot: {} (keys & paths will not be wiped)",
            snap.display()
        );
    }

    let tmp_dir = env::temp_dir().join("weport-update");
    fs::create_dir_all(&tmp_dir)?;
    let installer_path: PathBuf = tmp_dir.join(&asset.name);

    let response = client
        .get(&asset.browser_download_url)
        .send()
        .await?
        .error_for_status()?;
    let total = response.content_length().unwrap_or(0);
    let mut stream = response.bytes_stream();
    let mut file = fs::File::create(&installer_path)?;
    let mut downloaded: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk)?;
        downloaded += chunk.len() as u64;
        if total > 0 {
            let pct = (downloaded as f64 / total as f64) * 100.0;
            eprint!("\r[update] {pct:5.1}%  ({downloaded}/{total} bytes)");
        }
    }
    eprintln!();
    drop(file);

    // Always prefer a clean silent replace when user already confirmed (yes)
    // or GUI-triggered install (yes=true). Non-yes still runs interactive UI.
    let silent = yes;
    if silent {
        eprintln!("[update] Running silent installer (settings in user profile are preserved)…");
    } else {
        eprintln!("[update] Launching installer. Follow on-screen steps.");
    }

    #[cfg(windows)]
    {
        // CRITICAL FIX (v0.6.10): The old flow ran the NSIS installer from
        // within the app and then called relaunch_weport(). But the installer
        // does `taskkill /F /IM weport.exe`, killing THIS process before
        // relaunch runs. Even if it survived, the single-instance mutex would
        // block the relaunched binary.
        //
        // New flow: spawn a detached helper batch script that:
        //   1. Waits for the current weport.exe PID to exit (releases locks)
        //   2. Runs the NSIS installer (silent or interactive)
        //   3. Restores settings snapshot if needed
        //   4. Relaunches weport.exe
        // Then the app quits immediately so the helper can proceed.
        let pid = std::process::id();
        let exe = find_installed_exe();
        spawn_update_helper(
            pid,
            &installer_path,
            silent,
            &exe,
            settings_snap.as_ref().map(|p| p.as_path()),
        )?;

        // Signal the GUI to quit immediately so the helper can run the installer.
        eprintln!("[update] Helper launched — exiting current instance to allow clean install.");
        println!(
            "{}",
            serde_json::json!({
                "success": true,
                "updated": true,
                "version": latest,
                "installer": installer_path,
                "settingsPreserved": true,
                "relaunching": true
            })
        );
        // Give the caller (GUI) a moment to read the result, then exit.
        std::thread::sleep(Duration::from_millis(500));
        std::process::exit(0);
    }

    #[cfg(not(windows))]
    {
        let _ = open::that(&installer_path);
        let _ = settings_snap;
        println!(
            "{}",
            serde_json::json!({
                "success": true,
                "updated": true,
                "version": latest,
                "installer": installer_path,
                "settingsPreserved": true
            })
        );
        return Ok(());
    }

    // Windows path exits via std::process::exit above; this is never reached.
    #[allow(unreachable_code)]
    Ok(())
}

/// Find the installed weport.exe location (preferred) or fall back to current_exe.
#[cfg(windows)]
fn find_installed_exe() -> PathBuf {
    let candidates = [
        dirs::data_local_dir().map(|d| d.join("Programs").join("Weport").join("weport.exe")),
        std::env::var_os("LOCALAPPDATA").map(|p| {
            PathBuf::from(p)
                .join("Programs")
                .join("Weport")
                .join("weport.exe")
        }),
        std::env::current_exe().ok(),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
        .unwrap_or_else(|| std::env::current_exe().unwrap_or_else(|_| PathBuf::from("weport.exe")))
}

/// Spawn a detached batch script that waits for the current process to exit,
/// runs the installer, optionally restores settings, and relaunches the app.
///
/// This is the ONLY safe way to self-update: the NSIS installer kills
/// weport.exe (taskkill /F /IM), so the installer MUST run after we exit.
/// The helper runs detached (no parent-child handle) so it survives our exit.
#[cfg(windows)]
fn spawn_update_helper(
    pid: u32,
    installer_path: &Path,
    silent: bool,
    exe: &Path,
    settings_snap: Option<&std::path::Path>,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::windows::process::CommandExt;

    // Write a batch helper to temp — simpler and more reliable than PowerShell
    // for detached execution.
    let helper_path = std::env::temp_dir().join(format!("weport-update-{}.bat", pid));

    let installer_str = installer_path.display().to_string().replace('\\', "/");
    let exe_str = exe.display().to_string().replace('\\', "/");
    let snap_str = settings_snap
        .map(|p| p.display().to_string().replace('\\', "/"))
        .unwrap_or_default();
    let silent_flag = if silent { "/S" } else { "" };

    let script = format!(
        r#"@echo off
setlocal EnableExtensions EnableDelayedExpansion
:: Weport self-update helper — waits for old PID to exit, runs installer, relaunches.
:: Generated by weport.exe — safe to delete.
set "LOG=%TEMP%\weport-update.log"
echo [%DATE% %TIME%] helper started for PID {pid} > "%LOG%"

:: 1. Wait for the current weport.exe process to exit (bounded at 30s).
::    This releases file locks and the single-instance mutex.
set /a waited=0
:wait_loop
tasklist /FI "PID eq {pid}" 2>NUL | find "{pid}" >NUL
if not errorlevel 1 (
    if !waited! GEQ 30 goto wait_timeout
    timeout /t 1 /nobreak >NUL
    set /a waited+=1
    goto wait_loop
)
:: Extra grace period for file handle release.
timeout /t 1 /nobreak >NUL

:: 2. Run the installer (silent or interactive).
echo [%DATE% %TIME%] installing {installer_str} >> "%LOG%"
start "" /B /WAIT "{installer_str}" {silent_flag}
set "installer_rc=%ERRORLEVEL%"
echo [%DATE% %TIME%] installer exit code %installer_rc% >> "%LOG%"

:: 3. Restore settings snapshot if the live file was wiped.
if not "{snap_str}"=="" (
    if not exist "%APPDATA%\Weport\settings.json" (
        copy /Y "{snap_str}" "%APPDATA%\Weport\settings.json" >NUL 2>NUL
    )
)

:: 4. Relaunch the newly installed binary.
if exist "{exe_str}" (
    echo [%DATE% %TIME%] relaunching visible app >> "%LOG%"
    start "" "{exe_str}"
) else (
    echo [%DATE% %TIME%] installed executable missing >> "%LOG%"
)

:: 5. Clean up this helper script.
(goto) 2>NUL & del "%~f0"
exit /b 0

:wait_timeout
echo [%DATE% %TIME%] timed out waiting for old process >> "%LOG%"
if exist "{exe_str}" start "" "{exe_str}"
(goto) 2>NUL & del "%~f0"
"#,
        pid = pid,
        installer_str = installer_str,
        silent_flag = silent_flag,
        snap_str = snap_str,
        exe_str = exe_str,
    );

    fs::write(&helper_path, script)?;

    // Launch the batch script detached (CREATE_NO_WINDOW so no console flashes).
    let mut cmd = std::process::Command::new("cmd.exe");
    cmd.args(["/C", "start", "", "/B"])
        .arg(&helper_path)
        .creation_flags(0x08000000); // CREATE_NO_WINDOW

    cmd.spawn().map_err(|e| format!("启动更新助手失败: {e}"))?;
    Ok(())
}

/// Find the installed weport.exe location (preferred) or fall back to current_exe.
#[cfg(not(windows))]
fn find_installed_exe() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("weport"))
}

pub fn print_cli_help() {
    println!(
        r#"Weport — lightweight WeChat chat history exporter

Usage:
  weport                      Launch GUI
  weport <command> [options]  Run CLI command

Commands:
  help                 Show this help
  version              Print version
  detect               Auto-detect WeChat data directory
  accounts --db <path> List accounts under a data directory
  key                  Extract database key (WeChat must be logged in)
  antirecall status    Show WeChat 4 anti-recall patch state
  antirecall apply     Install anti-recall patch (needs admin, WeChat closed)
  antirecall remove    Restore Weixin.dll from backup (needs admin)
  export --out <dir> [opts]
  update               Check for updates (CLI)
  update --install     Download and run latest installer (preserves keys/paths)
  update --install -y  Silent install when possible

Anti-recall options:
  --install-path <dir> WeChat 4 install directory (auto-detected by default)

Export options:
  --out <dir>          Output folder (required)
  --format txt|json    Export format (default: txt)
  --db <path>          WeChat data directory
  --wxid <id>          Account wxid
  --key <hex>          Database decrypt key
  --all                Export every contact and group (default when no --sessions)
  --sessions a,b       Specific session usernames
  --no-media           Skip media (default)

Layout under --out:
  TXT/   群聊_*.txt  私聊_*.txt
  JSON/  群聊_*.json 私聊_*.json
  export_log.txt
"#
    );
}
