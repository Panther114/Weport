//! Persist user settings (db path, key, export path) under app data.
//!
//! Key durability rules:
//! - writes are atomic (temp file + rename), so a force-kill (e.g. the
//!   updater taskkills weport.exe) can never truncate the settings file
//! - the previous good copy is kept as settings.json.bak and used as a
//!   fallback when the main file fails to parse
//! - decrypt keys are stored per account (account_keys) so switching or
//!   re-scanning accounts never loses an already-extracted key; the legacy
//!   flat decrypt_key field is still kept for backward compatibility
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub db_path: String,
    pub decrypt_key: String,
    pub export_path: String,
    pub selected_wxid: String,
    pub format: String,
    #[serde(default)]
    pub account_keys: HashMap<String, String>,
    /// Launch Weport at Windows login (registry Run key).
    /// Defaults to true so first-run installs always auto-start.
    #[serde(default = "default_true")]
    pub launch_at_startup: bool,
    /// Start hidden in the background (tray) instead of showing the window.
    /// Defaults to true: tray-only until the user opens the main window.
    #[serde(default = "default_true")]
    pub start_in_background: bool,
    /// Keep running in the tray when the window is closed.
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    /// Patch WeChat 4 (Weixin.dll) so recalled messages stay visible.
    #[serde(default)]
    pub anti_recall_enabled: bool,
    /// Show a top-right toast for incoming chat messages.
    #[serde(default)]
    pub notifications_enabled: bool,
}

fn default_true() -> bool {
    true
}

fn settings_dir() -> Result<PathBuf, String> {
    // Test hook: WEPORT_SETTINGS_DIR redirects the config folder.
    if let Ok(override_dir) = std::env::var("WEPORT_SETTINGS_DIR") {
        let dir = PathBuf::from(override_dir);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        return Ok(dir);
    }
    let base = dirs::data_dir()
        .or_else(dirs::config_dir)
        .ok_or_else(|| "无法解析用户数据目录".to_string())?;
    let dir = base.join("Weport");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(settings_dir()?.join("settings.json"))
}

fn parse_file(path: &Path) -> Option<AppSettings> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn load_settings() -> AppSettings {
    let Ok(path) = settings_path() else {
        return AppSettings::default();
    };
    // Prefer the live file; fall back to the last good backup if it was
    // truncated or corrupted (e.g. by a force-kill mid-write).
    parse_file(&path).or_else(|| parse_file(&path.with_extension("json.bak")))
        .unwrap_or_default()
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path()?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    // Keep the previous good copy before replacing.
    if path.exists() {
        let _ = fs::copy(&path, path.with_extension("json.bak"));
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // Tests share the WEPORT_SETTINGS_DIR process env var, so they must not
    // run concurrently.
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "weport-settings-test-{}-{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        std::env::set_var("WEPORT_SETTINGS_DIR", &dir);
        dir
    }

    #[test]
    fn roundtrip_keeps_account_keys() {
        let _guard = TEST_LOCK.lock().unwrap();
        let dir = sandbox("roundtrip");
        let mut keys = HashMap::new();
        keys.insert("wxid_a".into(), "a".repeat(64));
        keys.insert("wxid_b".into(), "b".repeat(64));
        let s = AppSettings {
            db_path: "D:\\xwechat_files".into(),
            decrypt_key: "a".repeat(64),
            export_path: "D:\\out".into(),
            selected_wxid: "wxid_a".into(),
            format: "txt".into(),
            account_keys: keys.clone(),
            ..Default::default()
        };
        save_settings(&s).unwrap();

        let loaded = load_settings();
        assert_eq!(loaded.db_path, "D:\\xwechat_files");
        assert_eq!(loaded.account_keys, keys);
        assert!(dir.join("settings.json").exists());
        assert!(!dir.join("settings.json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_main_file_falls_back_to_backup() {
        let _guard = TEST_LOCK.lock().unwrap();
        let dir = sandbox("corrupt");
        let mut keys = HashMap::new();
        keys.insert("wxid_a".into(), "a".repeat(64));
        let s = AppSettings {
            db_path: "D:\\xwechat_files".into(),
            decrypt_key: "a".repeat(64),
            export_path: String::new(),
            selected_wxid: "wxid_a".into(),
            format: "txt".into(),
            account_keys: keys,
            ..Default::default()
        };
        save_settings(&s).unwrap();
        // Second save creates the .bak of the first good copy.
        save_settings(&s).unwrap();
        assert!(dir.join("settings.json.bak").exists());

        // Simulate a force-kill truncating the live file mid-write.
        fs::write(dir.join("settings.json"), "{").unwrap();
        let loaded = load_settings();
        assert_eq!(loaded.selected_wxid, "wxid_a");
        assert_eq!(loaded.decrypt_key, "a".repeat(64));
        let _ = fs::remove_dir_all(&dir);
    }
}
