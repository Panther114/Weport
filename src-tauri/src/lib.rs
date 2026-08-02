mod engine;
mod export;
mod key;
mod paths;
mod settings;
mod wcdb;
mod wcdb_native;
mod wcdb_worker;

use engine::{
    accounts, detect, diagnose_resources, extract_key, export_all_sessions, EngineError,
    EngineState,
};
use paths::AccountInfo;
use serde_json::Value;
use settings::{load_settings, save_settings, AppSettings};
use tauri::Manager;

#[tauri::command]
async fn detect_db_path(app: tauri::AppHandle) -> Result<Value, EngineError> {
    tokio::task::spawn_blocking(move || detect(&app))
        .await
        .map_err(|e| EngineError::Message(e.to_string()))?
}

#[tauri::command]
async fn scan_accounts(app: tauri::AppHandle, db_path: String) -> Result<Vec<AccountInfo>, EngineError> {
    tokio::task::spawn_blocking(move || accounts(&app, db_path))
        .await
        .map_err(|e| EngineError::Message(e.to_string()))?
}

#[tauri::command]
async fn extract_db_key(
    app: tauri::AppHandle,
    db_path: String,
    wxid: String,
) -> Result<Value, EngineError> {
    tokio::task::spawn_blocking(move || extract_key(&app, db_path, wxid))
        .await
        .map_err(|e| EngineError::Message(e.to_string()))?
}

#[tauri::command]
async fn diagnose_native(app: tauri::AppHandle) -> Result<Value, EngineError> {
    Ok(diagnose_resources(&app))
}

#[tauri::command]
fn get_settings() -> AppSettings {
    load_settings()
}

#[tauri::command]
fn set_settings(settings: AppSettings) -> Result<(), EngineError> {
    save_settings(&settings).map_err(EngineError::Message)
}

#[tauri::command]
async fn export_all(
    app: tauri::AppHandle,
    state: tauri::State<'_, EngineState>,
    db_path: String,
    wxid: String,
    decrypt_key: String,
    output_dir: String,
    format: String,
) -> Result<Value, EngineError> {
    {
        let mut running = state
            .running
            .lock()
            .map_err(|_| EngineError::Message("状态锁失败".into()))?;
        if *running {
            return Err(EngineError::Message("已有导出任务在进行中".into()));
        }
        *running = true;
    }

    let result = tokio::task::spawn_blocking(move || {
        export_all_sessions(&app, db_path, wxid, decrypt_key, output_dir, format)
    })
    .await
    .map_err(|e| EngineError::Message(e.to_string()));

    if let Ok(mut running) = state.running.lock() {
        *running = false;
    }

    result?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(EngineState::default())
        .invoke_handler(tauri::generate_handler![
            detect_db_path,
            scan_accounts,
            extract_db_key,
            diagnose_native,
            get_settings,
            set_settings,
            export_all
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Weport");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Weport");
}
