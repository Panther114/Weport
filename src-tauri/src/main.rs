// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli_update;
mod export;
mod key;
mod paths;
mod settings;
mod wcdb;
mod wcdb_native;
mod wcdb_worker;

use serde_json::json;
use std::env;
use std::path::PathBuf;

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

fn resource_root() -> PathBuf {
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            for c in [
                dir.join("resources"),
                dir.to_path_buf(),
                dir.join("..").join("resources"),
            ] {
                if c
                    .join("native")
                    .join("win32")
                    .join("x64")
                    .join("wcdb_api.dll")
                    .exists()
                    || c
                        .join("wcdb")
                        .join("win32")
                        .join("x64")
                        .join("wcdb_api.dll")
                        .exists()
                {
                    return c;
                }
            }
        }
    }
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for root in [cwd.clone(), cwd.join("..")] {
        let p = root.join("src-tauri").join("resources");
        if p
            .join("native")
            .join("win32")
            .join("x64")
            .join("wcdb_api.dll")
            .exists()
        {
            return p;
        }
        let p2 = root.join("resources");
        if p2
            .join("wcdb")
            .join("win32")
            .join("x64")
            .join("wcdb_api.dll")
            .exists()
        {
            return p2;
        }
    }
    cwd
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
            let root = resource_root();
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
            let root = resource_root();
            let account = match paths::resolve_account_dir(std::path::Path::new(&db), &wxid) {
                Some(p) => p,
                None => {
                    eprintln!("Account directory not found");
                    return 1;
                }
            };
            let _lock = wcdb::WCDB_LOCK.lock().unwrap();
            let handle = match wcdb::WcdbHandle::open(&root, &account, &key_hex, &wxid) {
                Ok(h) => h,
                Err(e) => {
                    println!("{}", json!({ "success": false, "error": e }));
                    return 1;
                }
            };
            let fmt = export::ExportFormat::from_str(&format);
            match export::export_all(&handle, std::path::Path::new(&out), fmt, |p| {
                eprintln!(
                    "[export] {} {}/{} {}",
                    p.phase_label, p.current, p.total, p.current_session
                );
            }) {
                Ok(v) => {
                    println!("{v}");
                    if v.get("success").and_then(|x| x.as_bool()).unwrap_or(false) {
                        0
                    } else {
                        1
                    }
                }
                Err(e) => {
                    println!("{}", json!({ "success": false, "error": e }));
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

fn main() {
    let args: Vec<String> = env::args().collect();

    // WCDB host mode: process MUST be named WeFlow.exe (dll security check).
    if args.iter().any(|a| a == "--wcdb-worker") {
        wcdb_worker::run_worker_loop();
    }

    if is_cli_invocation(&args) {
        std::process::exit(run_cli(&args));
    }
    weport_lib::run();
}
