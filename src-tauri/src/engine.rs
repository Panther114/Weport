//! Pure-Rust WeChat export engine (no Electron / Node).
use crate::export::{export_all, ExportFormat};
use crate::key::extract_db_key;
use crate::paths::{
    detect_db_path, resolve_account_dir, resolve_key_dll, scan_accounts, AccountInfo,
};
use crate::wcdb::{WcdbHandle, WCDB_LOCK};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("{0}")]
    Message(String),
}

impl serde::Serialize for EngineError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub struct EngineState {
    pub running: Mutex<bool>,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            running: Mutex::new(false),
        }
    }
}

fn resource_root(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        // Packaged: resources/native/win32/x64 is under resource_dir
        if dir.join("native").join("win32").join("x64").join("wcdb_api.dll").exists() {
            return dir;
        }
        if dir.join("wcdb_api.dll").exists() {
            return dir;
        }
        // Sometimes files land in resource_dir/resources
        if dir.join("resources").join("native").join("win32").join("x64").join("wcdb_api.dll").exists() {
            return dir.join("resources");
        }
        return dir;
    }
    // Dev fallback
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for root in [cwd.clone(), cwd.join(".."), cwd.join("src-tauri").join("..")] {
        if root
            .join("src-tauri")
            .join("resources")
            .join("native")
            .join("win32")
            .join("x64")
            .join("wcdb_api.dll")
            .exists()
        {
            return root.join("src-tauri").join("resources");
        }
        if root
            .join("resources")
            .join("wcdb")
            .join("win32")
            .join("x64")
            .join("wcdb_api.dll")
            .exists()
        {
            return root.join("resources");
        }
    }
    cwd
}

pub fn detect(app: &AppHandle) -> Result<Value, EngineError> {
    let _ = app;
    match detect_db_path() {
        Ok(path) => Ok(json!({ "success": true, "path": path })),
        Err(e) => Ok(json!({ "success": false, "error": e })),
    }
}

pub fn accounts(_app: &AppHandle, db_path: String) -> Result<Vec<AccountInfo>, EngineError> {
    let root = PathBuf::from(db_path.trim());
    if !root.is_dir() {
        return Err(EngineError::Message("数据目录不存在".into()));
    }
    Ok(scan_accounts(&root))
}

pub fn extract_key(
    app: &AppHandle,
    _db_path: String,
    _wxid: String,
) -> Result<Value, EngineError> {
    let root = resource_root(app);
    let dll = resolve_key_dll(&root);
    let app2 = app.clone();
    // WeFlow uses ~60s; allow 120s so user can re-login after Hook ready.
    let result = extract_db_key(&dll, Duration::from_secs(120), |msg| {
        let _ = app2.emit("engine-status", &msg);
        let _ = app2.emit("key-status", &msg);
    });
    match result {
        Ok(key) => Ok(json!({ "success": true, "key": key })),
        Err(e) => Ok(json!({ "success": false, "error": e })),
    }
}

pub fn export_all_sessions(
    app: &AppHandle,
    db_path: String,
    wxid: String,
    decrypt_key: String,
    output_dir: String,
    format: String,
) -> Result<Value, EngineError> {
    let root = resource_root(app);
    let db_root = PathBuf::from(db_path.trim());
    let account_dir = resolve_account_dir(&db_root, wxid.trim())
        .ok_or_else(|| EngineError::Message("未找到账号目录".into()))?;
    let out = PathBuf::from(output_dir.trim());
    let fmt = ExportFormat::from_str(&format);
    let key = decrypt_key.trim().to_string();
    if key.len() != 64 {
        return Err(EngineError::Message(
            "数据库密钥无效（需要 64 位十六进制）".into(),
        ));
    }

    let _guard = WCDB_LOCK
        .lock()
        .map_err(|_| EngineError::Message("引擎忙".into()))?;

    let db = WcdbHandle::open(&root, &account_dir, &key, wxid.trim())
        .map_err(EngineError::Message)?;

    let app2 = app.clone();
    let result = export_all(&db, &out, fmt, |p| {
        let _ = app2.emit(
            "export-progress",
            json!({
                "current": p.current,
                "total": p.total,
                "currentSession": p.current_session,
                "phaseLabel": p.phase_label,
                "phase": "exporting"
            }),
        );
        let _ = app2.emit(
            "engine-status",
            format!("{} · {}", p.phase_label, p.current_session),
        );
    })
    .map_err(EngineError::Message)?;

    Ok(result)
}
