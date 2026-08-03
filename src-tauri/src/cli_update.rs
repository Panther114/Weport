//! CLI self-update against GitHub Releases for Panther114/Weport.
use futures_util::StreamExt;
use semver::Version;
use serde::Deserialize;
use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

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

    eprintln!(
        "[update] Downloading {} → v{} …",
        asset.name, latest
    );

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

    if !yes {
        eprintln!("[update] Launching installer. Follow on-screen steps.");
    }

    #[cfg(windows)]
    {
        // NSIS silent if --yes. Launch via ShellExecuteEx (like Explorer), not
        // CreateProcess: CreateProcess cannot start an exe that requires
        // elevation and fails with ERROR_ELEVATION_REQUIRED (os error 740).
        launch_installer(&installer_path, yes)?;
    }

    #[cfg(not(windows))]
    {
        let _ = open::that(&installer_path);
    }

    println!(
        "{}",
        serde_json::json!({
            "success": true,
            "updated": true,
            "version": latest,
            "installer": installer_path
        })
    );
    Ok(())
}

#[cfg(windows)]
fn launch_installer(installer_path: &std::path::Path, silent: bool) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SHELLEXECUTEINFOW,
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
    let mut params: Vec<u16> = wide(if silent { "/S" } else { "" });
    let mut verb: Vec<u16> = wide("open");

    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_FLAG_NO_UI;
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
  export --out <dir> [opts]
  update               Check for updates (CLI)
  update --install     Download and run latest installer
  update --install -y  Silent install when possible

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
  TXT/                 text exports (overwrite same names)
  JSON/                json exports
  export_log.txt       last export times for TXT and JSON

File names:
  群聊_[name].txt|json
  私聊_[name].txt|json

Examples:
  weport detect
  weport export --db "C:\\Users\\me\\Documents\\xwechat_files" --wxid wxid_xxx --key <hex> --out D:\\export --format txt
  weport update --install
"#
    );
}
