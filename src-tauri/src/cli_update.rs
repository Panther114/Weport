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
    let release: GhRelease = client.get(&url).send().await?.error_for_status()?.json().await?;

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
    let release: GhRelease = client.get(&url).send().await?.error_for_status()?.json().await?;
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
        eprintln!("[update] No installer asset found. Open: {:?}", release.html_url);
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
        launch_installer_and_wait(&installer_path, silent)?;
        // Give the installer a moment to flush files.
        std::thread::sleep(Duration::from_millis(800));
        if let Some(ref snap) = settings_snap {
            match settings::restore_settings_if_missing(snap) {
                Ok(true) => eprintln!("[update] Restored settings snapshot (live file was empty)"),
                Ok(false) => eprintln!("[update] Settings intact (keys & db path preserved)"),
                Err(e) => eprintln!("[update] Settings check: {e}"),
            }
        }
        // Relaunch the newly installed binary when we know the install dir.
        if let Err(e) = relaunch_weport() {
            eprintln!("[update] Relaunch skipped: {e}");
        }
    }

    #[cfg(not(windows))]
    {
        let _ = open::that(&installer_path);
        let _ = settings_snap;
    }

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
    Ok(())
}

#[cfg(windows)]
fn launch_installer_and_wait(
    installer_path: &Path,
    silent: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::WaitForSingleObject;
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let mut file: Vec<u16> = installer_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // /S = silent; NSIS only replaces $INSTDIR, never user AppData\Weport.
    let mut params: Vec<u16> = wide(if silent { "/S" } else { "" });
    let mut verb: Vec<u16> = wide("open");

    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_FLAG_NO_UI | SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_mut_ptr();
    info.lpFile = file.as_mut_ptr();
    info.lpParameters = if silent {
        params.as_mut_ptr()
    } else {
        ptr::null_mut()
    };
    info.nShow = SW_SHOWNORMAL;

    let ok = unsafe { ShellExecuteExW(&mut info) };
    if ok == 0 {
        let err = std::io::Error::last_os_error();
        return Err(format!(
            "启动安装程序失败: {err}\n安装包: {}",
            installer_path.display()
        )
        .into());
    }

    // Wait up to 10 minutes for silent/interactive install to finish.
    if !info.hProcess.is_null() {
        let wait = unsafe { WaitForSingleObject(info.hProcess, 600_000) };
        unsafe { CloseHandle(info.hProcess) };
        // WAIT_OBJECT_0 == 0
        if wait != 0 {
            eprintln!("[update] Installer still running or timed out (wait={wait})");
        }
    }
    Ok(())
}

#[cfg(windows)]
fn relaunch_weport() -> Result<(), Box<dyn std::error::Error>> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // Prefer the installed location; fall back to current_exe.
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
    let exe = candidates
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
        .ok_or("weport.exe not found after install")?;

    let mut file: Vec<u16> = exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut verb: Vec<u16> = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_FLAG_NO_UI;
    info.lpVerb = verb.as_mut_ptr();
    info.lpFile = file.as_mut_ptr();
    info.lpParameters = ptr::null_mut();
    info.nShow = SW_SHOWNORMAL;
    let ok = unsafe { ShellExecuteExW(&mut info) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    eprintln!("[update] Relaunched {}", exe.display());
    Ok(())
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
