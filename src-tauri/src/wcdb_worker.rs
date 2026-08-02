//! WCDB worker protocol + process management.
//!
//! Root cause of -1006: wcdb_api.dll's piracy check requires the *host executable
//! file name* to be exactly `WeFlow.exe` / `weflow.exe`. InitProtection can return 0
//! while wcdb_init returns -1006 when the process is named `weport.exe`.
//!
//! Fix: spawn a copy of this binary named WeFlow.exe with `--wcdb-worker` and speak
//! JSON-lines over stdio.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
// json! used in worker responses
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkerRequest {
    pub id: u64,
    pub cmd: String,
    #[serde(default)]
    pub resource_root: Option<String>,
    #[serde(default)]
    pub account_dir: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub wxid: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub limit: Option<i32>,
    #[serde(default)]
    pub offset: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkerResponse {
    pub id: u64,
    pub ok: bool,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub debug: Option<Value>,
}

pub struct WcdbWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

// Global worker for sequential use
static WORKER: Mutex<Option<WcdbWorker>> = Mutex::new(None);

fn strip_extended_prefix(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

fn worker_exe_path() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    let current = strip_extended_prefix(&current);

    // Prefer bundled sidecar next to main exe or in resources
    if let Some(dir) = current.parent() {
        for c in [
            dir.join("WeFlow.exe"),
            dir.join("resources").join("WeFlow.exe"),
            dir.join("wcdb-host").join("WeFlow.exe"),
        ] {
            if c.exists() {
                return Ok(c);
            }
        }
    }

    // Copy self to temp as WeFlow.exe (same binary, dual-mode entry)
    let temp = std::env::temp_dir().join("weport-wcdb-host");
    std::fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
    let dest = temp.join("WeFlow.exe");
    // Refresh copy if missing or size differs
    let need_copy = match (std::fs::metadata(&dest), std::fs::metadata(&current)) {
        (Ok(a), Ok(b)) => a.len() != b.len(),
        _ => true,
    };
    if need_copy {
        std::fs::copy(&current, &dest).map_err(|e| {
            format!(
                "无法创建 WCDB 宿主进程 WeFlow.exe: {e}\n源: {}\n目标: {}",
                current.display(),
                dest.display()
            )
        })?;
    }
    Ok(dest)
}

impl WcdbWorker {
    pub fn spawn() -> Result<Self, String> {
        let exe = worker_exe_path()?;
        let mut cmd = Command::new(&exe);
        cmd.arg("--wcdb-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动 WCDB 宿主失败 ({}): {e}", exe.display()))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        })
    }

    pub fn request(&mut self, mut req: WorkerRequest) -> Result<WorkerResponse, String> {
        let id = self.next_id;
        self.next_id += 1;
        req.id = id;
        let line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        writeln!(self.stdin, "{line}").map_err(|e| format!("write worker: {e}"))?;
        self.stdin.flush().map_err(|e| e.to_string())?;

        let mut response_line = String::new();
        self.stdout
            .read_line(&mut response_line)
            .map_err(|e| format!("read worker: {e}"))?;
        if response_line.trim().is_empty() {
            // include stderr if process died
            let status = self.child.try_wait().ok().flatten();
            return Err(format!(
                "WCDB 宿主无响应 (exit={status:?})。宿主可执行文件须名为 WeFlow.exe。"
            ));
        }
        let resp: WorkerResponse =
            serde_json::from_str(response_line.trim()).map_err(|e| {
                format!("解析宿主响应失败: {e}\nraw={}", response_line.trim())
            })?;
        if resp.id != id {
            return Err(format!("宿主响应 id 不匹配: expected {id} got {}", resp.id));
        }
        Ok(resp)
    }
}

impl Drop for WcdbWorker {
    fn drop(&mut self) {
        let _ = self.request(WorkerRequest {
            id: 0,
            cmd: "shutdown".into(),
            resource_root: None,
            account_dir: None,
            key: None,
            wxid: None,
            session_id: None,
            username: None,
            limit: None,
            offset: None,
        });
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn with_worker<R>(f: impl FnOnce(&mut WcdbWorker) -> Result<R, String>) -> Result<R, String> {
    let mut guard = WORKER
        .lock()
        .map_err(|_| "WCDB worker lock failed".to_string())?;
    if guard.is_none() {
        *guard = Some(WcdbWorker::spawn()?);
    }
    let worker = guard.as_mut().unwrap();
    match f(worker) {
        Ok(v) => Ok(v),
        Err(e) => {
            // Reset worker on hard failures
            if e.contains("无响应") || e.contains("write worker") || e.contains("read worker") {
                *guard = None;
            }
            Err(e)
        }
    }
}

/// Entry point when process is launched as WeFlow.exe --wcdb-worker
pub fn run_worker_loop() -> ! {
    // Ensure we're named WeFlow for the security check (caller must use WeFlow.exe)
    use crate::wcdb_native;
    use std::io::{self, BufRead, Write};

    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut engine: Option<wcdb_native::NativeEngine> = None;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                let _ = writeln!(
                    stdout,
                    "{}",
                    json!({"id":0,"ok":false,"error":format!("stdin: {e}")})
                );
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: WorkerRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let _ = writeln!(
                    stdout,
                    "{}",
                    json!({"id":0,"ok":false,"error":format!("bad json: {e}")})
                );
                let _ = stdout.flush();
                continue;
            }
        };

        let resp = match req.cmd.as_str() {
            "ping" => WorkerResponse {
                id: req.id,
                ok: true,
                data: Some(json!({"pong": true, "exe": std::env::current_exe().ok().map(|p| p.display().to_string())})),
                error: None,
                debug: None,
            },
            "open" => {
                let root = PathBuf::from(req.resource_root.unwrap_or_default());
                let account = PathBuf::from(req.account_dir.unwrap_or_default());
                let key = req.key.unwrap_or_default();
                let wxid = req.wxid.unwrap_or_default();
                match wcdb_native::NativeEngine::open(&root, &account, &key, &wxid) {
                    Ok(eng) => {
                        engine = Some(eng);
                        WorkerResponse {
                            id: req.id,
                            ok: true,
                            data: None,
                            error: None,
                            debug: Some(json!({"host":"WeFlow.exe worker"})),
                        }
                    }
                    Err(e) => WorkerResponse {
                        id: req.id,
                        ok: false,
                        data: None,
                        error: Some(e),
                        debug: Some(json!({
                            "exe": std::env::current_exe().ok().map(|p| p.display().to_string()),
                            "resourceRoot": root,
                            "accountDir": account,
                        })),
                    },
                }
            }
            "sessions" => match engine.as_ref() {
                Some(eng) => match eng.sessions() {
                    Ok(s) => WorkerResponse {
                        id: req.id,
                        ok: true,
                        data: Some(Value::Array(s)),
                        error: None,
                        debug: None,
                    },
                    Err(e) => WorkerResponse {
                        id: req.id,
                        ok: false,
                        data: None,
                        error: Some(e),
                        debug: None,
                    },
                },
                None => WorkerResponse {
                    id: req.id,
                    ok: false,
                    data: None,
                    error: Some("not open".into()),
                    debug: None,
                },
            },
            "messages" => match engine.as_ref() {
                Some(eng) => {
                    let sid = req.session_id.unwrap_or_default();
                    let limit = req.limit.unwrap_or(500);
                    let offset = req.offset.unwrap_or(0);
                    match eng.messages(&sid, limit, offset) {
                        Ok(s) => WorkerResponse {
                            id: req.id,
                            ok: true,
                            data: Some(Value::Array(s)),
                            error: None,
                            debug: None,
                        },
                        Err(e) => WorkerResponse {
                            id: req.id,
                            ok: false,
                            data: None,
                            error: Some(e),
                            debug: None,
                        },
                    }
                }
                None => WorkerResponse {
                    id: req.id,
                    ok: false,
                    data: None,
                    error: Some("not open".into()),
                    debug: None,
                },
            },
            "contact" => match engine.as_ref() {
                Some(eng) => {
                    let u = req.username.unwrap_or_default();
                    match eng.contact(&u) {
                        Ok(c) => WorkerResponse {
                            id: req.id,
                            ok: true,
                            data: Some(c),
                            error: None,
                            debug: None,
                        },
                        Err(e) => WorkerResponse {
                            id: req.id,
                            ok: false,
                            data: None,
                            error: Some(e),
                            debug: None,
                        },
                    }
                }
                None => WorkerResponse {
                    id: req.id,
                    ok: false,
                    data: None,
                    error: Some("not open".into()),
                    debug: None,
                },
            },
            "close" => {
                engine = None;
                WorkerResponse {
                    id: req.id,
                    ok: true,
                    data: None,
                    error: None,
                    debug: None,
                }
            }
            "shutdown" => {
                engine = None;
                let _ = writeln!(
                    stdout,
                    "{}",
                    serde_json::to_string(&WorkerResponse {
                        id: req.id,
                        ok: true,
                        data: None,
                        error: None,
                        debug: None,
                    })
                    .unwrap_or_default()
                );
                let _ = stdout.flush();
                std::process::exit(0);
            }
            other => WorkerResponse {
                id: req.id,
                ok: false,
                data: None,
                error: Some(format!("unknown cmd: {other}")),
                debug: None,
            },
        };

        let _ = writeln!(
            stdout,
            "{}",
            serde_json::to_string(&resp).unwrap_or_else(|e| json!({"id":req.id,"ok":false,"error":e.to_string()}).to_string())
        );
        let _ = stdout.flush();
    }
    std::process::exit(0);
}
