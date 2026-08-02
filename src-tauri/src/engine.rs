use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("{0}")]
    Message(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl serde::Serialize for EngineError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub wxid: String,
    pub nickname: Option<String>,
    pub avatar_url: Option<String>,
    pub modified_time: Option<i64>,
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

enum EngineLaunch {
    Exe(PathBuf),
    Node { script: PathBuf },
}

fn resolve_engine_launch(app: &AppHandle) -> Result<EngineLaunch, EngineError> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidates = [
            resource_dir.join("engine").join("weport-engine.exe"),
            resource_dir
                .join("engine")
                .join("win-unpacked")
                .join("weport-engine.exe"),
        ];
        for path in candidates {
            if path.exists() {
                return Ok(EngineLaunch::Exe(path));
            }
        }
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let roots = [
        cwd.clone(),
        cwd.join(".."),
        cwd.parent().unwrap_or(Path::new(".")).to_path_buf(),
    ];
    for root in roots {
        let path = root
            .join("release")
            .join("engine")
            .join("win-unpacked")
            .join("weport-engine.exe");
        if path.exists() {
            return Ok(EngineLaunch::Exe(path));
        }
        let script = root.join("scripts").join("weport-cli.cjs");
        if script.exists() {
            return Ok(EngineLaunch::Node { script });
        }
    }

    Err(EngineError::Message(
        "未找到 Weport 导出引擎。请先构建: npm run build:engine:pack".into(),
    ))
}

async fn run_engine_raw(
    app: &AppHandle,
    args: &[String],
    on_stderr_line: Option<Arc<dyn Fn(String) + Send + Sync>>,
) -> Result<(i32, String, String), EngineError> {
    let launch = resolve_engine_launch(app)?;

    let mut cmd = match &launch {
        EngineLaunch::Exe(path) => {
            let mut c = Command::new(path);
            c.args(args);
            c
        }
        EngineLaunch::Node { script } => {
            let mut c = Command::new("node");
            c.arg(script);
            c.args(args);
            c
        }
    };

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        EngineError::Message(format!("启动导出引擎失败: {e}"))
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| EngineError::Message("引擎未提供 stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| EngineError::Message("引擎未提供 stderr".into()))?;

    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    let stdout_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf = Arc::new(Mutex::new(String::new()));

    let stdout_collect = {
        let stdout_buf = stdout_buf.clone();
        async move {
            while let Ok(Some(line)) = stdout_reader.next_line().await {
                let mut g = stdout_buf.lock().await;
                if !g.is_empty() {
                    g.push('\n');
                }
                g.push_str(&line);
            }
        }
    };

    let stderr_collect = {
        let stderr_buf = stderr_buf.clone();
        let on_stderr_line = on_stderr_line.clone();
        async move {
            while let Ok(Some(line)) = stderr_reader.next_line().await {
                if let Some(cb) = &on_stderr_line {
                    cb(line.clone());
                }
                let mut g = stderr_buf.lock().await;
                if !g.is_empty() {
                    g.push('\n');
                }
                g.push_str(&line);
            }
        }
    };

    let (_, _) = tokio::join!(stdout_collect, stderr_collect);
    let status = child.wait().await?;
    let code = status.code().unwrap_or(1);
    let out = stdout_buf.lock().await.clone();
    let err = stderr_buf.lock().await.clone();
    Ok((code, out, err))
}

fn parse_json_output(stdout: &str) -> Result<Value, EngineError> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err(EngineError::Message("引擎无输出".into()));
    }

    // Prefer last JSON object/array line (engine prints one JSON blob)
    for candidate in trimmed.lines().rev() {
        let c = candidate.trim();
        if c.starts_with('{') || c.starts_with('[') {
            if let Ok(v) = serde_json::from_str::<Value>(c) {
                return Ok(v);
            }
        }
    }

    serde_json::from_str::<Value>(trimmed).map_err(|e| {
        EngineError::Message(format!("无法解析引擎输出: {e}\n{trimmed}"))
    })
}

pub async fn detect_db_path(app: AppHandle) -> Result<Value, EngineError> {
    let (code, out, err) = run_engine_raw(&app, &["detect".into()], None).await?;
    if !out.trim().is_empty() {
        return parse_json_output(&out);
    }
    Err(EngineError::Message(if err.is_empty() {
        format!("detect 失败 (code {code})")
    } else {
        err
    }))
}

pub async fn scan_accounts(app: AppHandle, db_path: String) -> Result<Vec<AccountInfo>, EngineError> {
    let (code, out, err) =
        run_engine_raw(&app, &["accounts".into(), "--db".into(), db_path], None).await?;
    if out.trim().is_empty() {
        return Err(EngineError::Message(if err.is_empty() {
            format!("accounts 失败 (code {code})")
        } else {
            err
        }));
    }
    let value = parse_json_output(&out)?;

    let items = if let Some(arr) = value.as_array() {
        arr.clone()
    } else if let Some(arr) = value.get("accounts").and_then(|v| v.as_array()) {
        arr.clone()
    } else {
        return Err(EngineError::Message(format!("无法解析账号列表: {value}")));
    };

    let mut accounts = Vec::new();
    for item in items {
        let wxid = item
            .get("wxid")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if wxid.is_empty() {
            continue;
        }
        accounts.push(AccountInfo {
            wxid,
            nickname: item
                .get("nickname")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            avatar_url: item
                .get("avatarUrl")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            modified_time: item.get("modifiedTime").and_then(|v| v.as_i64()),
        });
    }
    Ok(accounts)
}

pub async fn extract_db_key(
    app: AppHandle,
    db_path: String,
    wxid: String,
) -> Result<Value, EngineError> {
    let app_status = app.clone();
    let on_status: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |line: String| {
        let msg = line
            .trim()
            .trim_start_matches("[key]")
            .trim()
            .to_string();
        if !msg.is_empty() {
            let _ = app_status.emit("engine-status", msg);
        }
    });

    let _ = run_engine_raw(
        &app,
        &[
            "config-set".into(),
            "--db".into(),
            db_path,
            "--wxid".into(),
            wxid,
        ],
        None,
    )
    .await;

    let (code, out, err) = run_engine_raw(&app, &["key".into()], Some(on_status)).await?;
    if !out.trim().is_empty() {
        let mut value = parse_json_output(&out)?;
        if let Some(obj) = value.as_object_mut() {
            obj.entry("success".to_string())
                .or_insert(Value::Bool(code == 0));
        }
        return Ok(value);
    }
    Err(EngineError::Message(if err.is_empty() {
        format!("密钥提取失败 (code {code})")
    } else {
        err
    }))
}

pub async fn export_all(
    app: AppHandle,
    db_path: String,
    wxid: String,
    decrypt_key: String,
    output_dir: String,
    format: String,
) -> Result<Value, EngineError> {
    let fmt = if format == "json" { "json" } else { "txt" };

    let app_progress = app.clone();
    let on_status: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |line: String| {
        let raw = line.trim();
        if let Some(rest) = raw.strip_prefix("[export]") {
            let rest = rest.trim();
            let mut current = 0.0f64;
            let mut total = 0.0f64;
            let mut session = String::new();
            let mut phase_label = rest.to_string();

            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() >= 2 {
                if let Some((a, b)) = parts[1].split_once('/') {
                    if let (Ok(ca), Ok(tb)) = (a.parse::<f64>(), b.parse::<f64>()) {
                        current = ca;
                        total = tb;
                        phase_label = parts[0].to_string();
                        if parts.len() > 2 {
                            session = parts[2..].join(" ");
                        }
                    }
                }
            }

            let payload = serde_json::json!({
                "current": current,
                "total": total,
                "currentSession": session,
                "phaseLabel": phase_label,
                "phase": "exporting",
                "message": rest
            });
            let _ = app_progress.emit("export-progress", payload);
            let _ = app_progress.emit("engine-status", rest.to_string());
        } else if raw.starts_with("[key]") {
            let _ = app_progress.emit(
                "engine-status",
                raw.trim_start_matches("[key]").trim().to_string(),
            );
        }
    });

    let args = vec![
        "export".into(),
        "--db".into(),
        db_path,
        "--wxid".into(),
        wxid,
        "--key".into(),
        decrypt_key,
        "--out".into(),
        output_dir,
        "--format".into(),
        fmt.into(),
        "--all".into(),
        "--flat".into(),
    ];

    let (code, out, err) = run_engine_raw(&app, &args, Some(on_status)).await?;
    if !out.trim().is_empty() {
        let mut value = parse_json_output(&out)?;
        if let Some(obj) = value.as_object_mut() {
            if !obj.contains_key("success") {
                obj.insert("success".into(), Value::Bool(code == 0));
            }
        }
        return Ok(value);
    }
    Err(EngineError::Message(if err.is_empty() {
        format!("导出失败 (code {code})")
    } else {
        err
    }))
}
