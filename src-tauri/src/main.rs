// Native Weport — no console window in release GUI builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod antirecall;
mod cli_update;
mod engine;
mod export;
mod gui;
mod key;
mod notify;
mod paths;
mod resource_root;
mod settings;
mod startup;
mod tray;
mod wcdb;
mod wcdb_native;
mod wcdb_worker;
#[cfg(windows)]
mod window_ctrl;

use serde_json::json;
use std::env;

fn is_cli_invocation(args: &[String]) -> bool {
    if args.len() <= 1 {
        return false;
    }
    matches!(
        args[1].as_str(),
        "help"
            | "-h"
            | "--help"
            | "version"
            | "-V"
            | "--version"
            | "detect"
            | "accounts"
            | "key"
            | "export"
            | "update"
            | "antirecall"
            | "cli"
    )
}

fn flag(args: &[String], name: &str) -> Option<String> {
    let key = format!("--{name}");
    let mut i = 0;
    while i < args.len() {
        if args[i] == key {
            return args.get(i + 1).cloned();
        }
        if let Some(rest) = args[i].strip_prefix(&format!("{key}=")) {
            return Some(rest.to_string());
        }
        i += 1;
    }
    None
}

fn has_flag(args: &[String], name: &str) -> bool {
    args.iter()
        .any(|a| a == &format!("--{name}") || a == name || a == &format!("-{name}"))
}

fn run_cli(args: &[String]) -> i32 {
    match args.get(1).map(|s| s.as_str()).unwrap_or("help") {
        "help" | "-h" | "--help" => {
            cli_update::print_cli_help();
            0
        }
        "version" | "-V" | "--version" => {
            println!("weport {}", env!("CARGO_PKG_VERSION"));
            0
        }
        "update" => {
            let install = has_flag(args, "install") || args.iter().any(|a| a == "--install");
            let yes = has_flag(args, "yes") || args.iter().any(|a| a == "-y" || a == "--yes");
            let rt = tokio::runtime::Runtime::new().expect("tokio");
            let result = if install {
                rt.block_on(cli_update::perform_update(yes))
            } else {
                rt.block_on(cli_update::check_update())
            };
            match result {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("[update] {e}");
                    1
                }
            }
        }
        "detect" => match paths::detect_db_path() {
            Ok(path) => {
                println!("{}", json!({ "success": true, "path": path }));
                0
            }
            Err(e) => {
                println!("{}", json!({ "success": false, "error": e }));
                1
            }
        },
        "accounts" => {
            let db = flag(args, "db").unwrap_or_default();
            if db.is_empty() {
                eprintln!("Missing --db <path>");
                return 1;
            }
            let list = paths::scan_accounts(std::path::Path::new(&db));
            println!("{}", serde_json::to_string_pretty(&list).unwrap_or_default());
            0
        }
        "key" => {
            let root = resource_root::resource_root();
            let dll = paths::resolve_key_dll(&root);
            match key::extract_db_key(&dll, std::time::Duration::from_secs(180), |msg| {
                eprintln!("[key] {msg}");
            }) {
                Ok(k) => {
                    println!("{}", json!({ "success": true, "key": k }));
                    0
                }
                Err(e) => {
                    println!("{}", json!({ "success": false, "error": e }));
                    1
                }
            }
        }
        "antirecall" => {
            let action = args
                .get(2)
                .map(|s| s.as_str())
                .unwrap_or("status");
            match run_antirecall_cli(args, action) {
                Ok(code) => code,
                Err(e) => {
                    println!("{}", json!({ "success": false, "error": e }));
                    1
                }
            }
        }
        "export" => {
            let db = flag(args, "db").unwrap_or_default();
            let wxid = flag(args, "wxid").unwrap_or_default();
            let key_hex = flag(args, "key").unwrap_or_default();
            let out = flag(args, "out").unwrap_or_default();
            let format = flag(args, "format").unwrap_or_else(|| "txt".into());
            if db.is_empty() || wxid.is_empty() || key_hex.is_empty() || out.is_empty() {
                eprintln!(
                    "Usage: weport export --db <path> --wxid <id> --key <hex> --out <dir> [--format txt|json]"
                );
                return 1;
            }
            match engine::export_all_sessions(
                db,
                wxid,
                key_hex,
                out,
                format,
                |p| {
                    eprintln!(
                        "[export] {} {}/{} {}",
                        p.phase_label, p.current, p.total, p.current_session
                    );
                },
            ) {
                Ok(v) => {
                    println!("{v}");
                    if v.get("success").and_then(|x| x.as_bool()).unwrap_or(false) {
                        0
                    } else {
                        1
                    }
                }
                Err(e) => {
                    println!("{}", json!({ "success": false, "error": e.to_string() }));
                    1
                }
            }
        }
        other => {
            eprintln!("Unknown command: {other}");
            cli_update::print_cli_help();
            1
        }
    }
}

fn run_antirecall_cli(args: &[String], action: &str) -> Result<i32, String> {
    match action {
        "status" => {
            let Some(install) = antirecall::find_weixin_install_path() else {
                println!(
                    "{}",
                    json!({ "success": false, "error": "未找到微信 4 安装路径（Weixin.exe / Weixin.dll）" })
                );
                return Ok(1);
            };
            let state = antirecall::patch_state(&install);
            let state_str = match state {
                antirecall::PatchState::NotInstalled => "not_installed",
                antirecall::PatchState::WeChatRunning => "wechat_running",
                antirecall::PatchState::Patched => "patched",
                antirecall::PatchState::NotPatched => "not_patched",
                antirecall::PatchState::Unsupported => "unsupported",
            };
            println!(
                "{}",
                json!({
                    "success": true,
                    "installPath": install.display().to_string(),
                    "state": state_str
                })
            );
            Ok(0)
        }
        "apply" | "remove" => {
            let install = flag(args, "install-path")
                .filter(|s| !s.is_empty())
                .map(std::path::PathBuf::from)
                .or_else(antirecall::find_weixin_install_path)
                .ok_or_else(|| "未找到微信 4 安装路径，请使用 --install-path <目录> 指定".to_string())?;

            let result = if antirecall::is_elevated() {
                let r = if action == "apply" {
                    antirecall::apply(&install)
                } else {
                    antirecall::remove(&install)
                };
                r.map(|_| {
                    json!({ "success": true, "message": if action == "apply" { "防撤回补丁已安装" } else { "防撤回补丁已还原" } })
                })
                .map_err(|e| e.to_string())
            } else {
                // Relaunch elevated and wait for the result file.
                let result_file = env::temp_dir().join(format!(
                    "weport-antirecall-{}.json",
                    std::process::id()
                ));
                let _ = std::fs::remove_file(&result_file);
                let args: Vec<String> = vec![
                    format!("--antirecall-{action}"),
                    format!("\"{}\"", install.display()),
                    format!("--antirecall-result \"{}\"", result_file.display()),
                ];
                antirecall::relaunch_elevated(&args)?;
                wait_for_result_file(&result_file, 120)
            };

            match result {
                Ok(v) => {
                    println!("{v}");
                    Ok(0)
                }
                Err(e) => {
                    println!("{}", json!({ "success": false, "error": e }));
                    Ok(1)
                }
            }
        }
        other => {
            eprintln!("Unknown antirecall action: {other}");
            eprintln!("Usage: weport antirecall status|apply|remove [--install-path <dir>]");
            Ok(1)
        }
    }
}

/// Poll for the elevated child's result file (bounded wait).
fn wait_for_result_file(path: &std::path::Path, timeout_secs: u64) -> Result<serde_json::Value, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            if !text.trim().is_empty() {
                let _ = std::fs::remove_file(path);
                return serde_json::from_str(&text).map_err(|e| format!("解析结果失败: {e}"));
            }
        }
        if std::time::Instant::now() >= deadline {
            let _ = std::fs::remove_file(path);
            return Err("等待管理员授权超时（可能取消了 UAC 弹窗）".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}

/// Ensure only one GUI instance runs. A second launch asks the first to show.
#[cfg(windows)]
fn acquire_single_instance() -> Option<*mut core::ffi::c_void> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let name: Vec<u16> = std::ffi::OsStr::new("Local\\WeportSingleInstance")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if handle.is_null() {
            return None;
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            // Wake the existing instance and bring its window forward.
            window_ctrl::signal_show_event();
            window_ctrl::force_show();
            windows_sys::Win32::Foundation::CloseHandle(handle);
            return None;
        }
        Some(handle)
    }
}

#[cfg(not(windows))]
fn acquire_single_instance() -> Option<*mut core::ffi::c_void> {
    Some(std::ptr::null_mut())
}

fn main() {
    // Custom panic hook: log crashes to %TEMP%\weport-crash.log
    let orig_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = format!("[Weport panic] {info}\n");
        let _ = std::fs::write(
            std::env::temp_dir().join("weport-crash.log"),
            &msg,
        );
        // Also write to stderr (visible if launched from terminal)
        eprintln!("{}", msg.trim());
        orig_hook(info);
    }));

    let args: Vec<String> = env::args().collect();

    if args.iter().any(|a| a == "--wcdb-worker") {
        wcdb_worker::run_worker_loop();
    }

    // Elevated anti-recall helper entry (spawned with "runas" by the GUI/CLI).
    if let Some(idx) = args
        .iter()
        .position(|a| a == "--antirecall-apply" || a == "--antirecall-remove")
    {
        let action = if args[idx] == "--antirecall-apply" {
            "apply"
        } else {
            "remove"
        };
        let install = args
            .get(idx + 1)
            .cloned()
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();
        let result_file = flag(&args, "antirecall-result").unwrap_or_default();
        std::process::exit(antirecall::run_elevated_action(
            action,
            &install,
            &result_file,
        ));
    }

    // Read-only diagnostics (no elevation needed).
    if let Some(idx) = args.iter().position(|a| a == "--antirecall-dryrun") {
        let install = args
            .get(idx + 1)
            .cloned()
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();
        match antirecall::dry_run(std::path::Path::new(&install)) {
            Ok(v) => {
                println!("{v}");
                std::process::exit(0);
            }
            Err(e) => {
                println!("{}", json!({ "success": false, "error": e }));
                std::process::exit(1);
            }
        }
    }

    if is_cli_invocation(&args) {
        std::process::exit(run_cli(&args));
    }

    // GUI: single instance only (CLI commands above skip this).
    let _instance_guard = match acquire_single_instance() {
        Some(h) => h,
        None => {
            eprintln!("Weport 已在运行（请查看系统托盘）");
            std::process::exit(0);
        }
    };

    if let Err(e) = gui::run_gui() {
        eprintln!("GUI error: {e}");
        std::process::exit(1);
    }
}
