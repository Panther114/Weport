//! Pure-Rust WeChat export engine (no WebView / Tauri).
use crate::export::{export_all, ExportFormat};
use crate::key::extract_db_key;
use crate::paths::{
    detect_db_path, resolve_account_dir, resolve_key_dll, scan_accounts, AccountInfo,
};
use crate::resource_root::resource_root;
use crate::wcdb::{WcdbHandle, WCDB_LOCK};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("{0}")]
    Message(String),
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

pub fn diagnose_resources() -> Value {
    let root = resource_root();
    let wcdb = crate::paths::resolve_wcdb_dir(&root);
    let key = crate::paths::resolve_key_dll(&root);
    json!({
        "resourceRoot": root,
        "wcdbDir": wcdb,
        "wcdbApiExists": wcdb.join("wcdb_api.dll").exists(),
        "wcdbCoreExists": wcdb.join("WCDB.dll").exists(),
        "keyDll": key,
        "keyExists": key.exists(),
    })
}

pub fn detect() -> Result<Value, EngineError> {
    match detect_db_path() {
        Ok(path) => Ok(json!({ "success": true, "path": path })),
        Err(e) => Ok(json!({ "success": false, "error": e })),
    }
}

pub fn accounts(db_path: String) -> Result<Vec<AccountInfo>, EngineError> {
    let root = PathBuf::from(db_path.trim());
    if !root.is_dir() {
        return Err(EngineError::Message("数据目录不存在".into()));
    }
    Ok(scan_accounts(&root))
}

pub fn extract_key(
    mut on_status: impl FnMut(String),
) -> Result<Value, EngineError> {
    let root = resource_root();
    let dll = resolve_key_dll(&root);
    let result = extract_db_key(&dll, Duration::from_secs(120), |msg| {
        on_status(msg);
    });
    match result {
        Ok(key) => Ok(json!({ "success": true, "key": key })),
        Err(e) => Ok(json!({ "success": false, "error": e })),
    }
}

pub fn export_all_sessions(
    db_path: String,
    wxid: String,
    decrypt_key: String,
    output_dir: String,
    format: String,
    on_progress: impl FnMut(crate::export::ExportProgress),
) -> Result<Value, EngineError> {
    let root = resource_root();
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

    export_all(&db, &out, fmt, on_progress).map_err(EngineError::Message)
}
