// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli_update;

use std::env;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn is_cli_invocation(args: &[String]) -> bool {
    if args.len() <= 1 {
        return false;
    }
    let first = args[1].as_str();
    // GUI launch flags from OS / shortcuts
    matches!(
        first,
        "help"
            | "-h"
            | "--help"
            | "version"
            | "-V"
            | "--version"
            | "detect"
            | "accounts"
            | "key"
            | "image-key"
            | "config"
            | "config-set"
            | "connect"
            | "sessions"
            | "export"
            | "update"
            | "cli"
    ) || first.starts_with('-') && first != "--"
}

fn resolve_engine_exe() -> Option<PathBuf> {
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidates = [
                dir.join("engine").join("weport-engine.exe"),
                dir.join("resources")
                    .join("engine")
                    .join("weport-engine.exe"),
                dir.join("resources")
                    .join("engine")
                    .join("win-unpacked")
                    .join("weport-engine.exe"),
            ];
            for c in candidates {
                if c.exists() {
                    return Some(c);
                }
            }
        }
    }

    // Dev layout
    let cwd = env::current_dir().ok()?;
    let roots = [
        cwd.clone(),
        cwd.join(".."),
        cwd.join("src-tauri").join(".."),
    ];
    for root in roots {
        let c = root
            .join("release")
            .join("engine")
            .join("win-unpacked")
            .join("weport-engine.exe");
        if c.exists() {
            return Some(c);
        }
    }
    None
}

fn run_engine_cli(args: &[String]) -> i32 {
    // Built-in update / help / version handled here when possible
    if args.len() >= 2 {
        match args[1].as_str() {
            "help" | "-h" | "--help" => {
                cli_update::print_cli_help();
                return 0;
            }
            "version" | "-V" | "--version" => {
                println!("weport {}", env!("CARGO_PKG_VERSION"));
                return 0;
            }
            "update" => {
                let install = args.iter().any(|a| a == "--install" || a == "install");
                let yes = args.iter().any(|a| a == "-y" || a == "--yes");
                let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
                let result = if install {
                    rt.block_on(cli_update::perform_update(yes))
                } else {
                    rt.block_on(cli_update::check_update())
                };
                return match result {
                    Ok(()) => 0,
                    Err(e) => {
                        eprintln!("[update] {e}");
                        1
                    }
                };
            }
            "cli" => {
                // strip "cli" and forward
                return run_engine_cli_forward(&args[2..]);
            }
            _ => {}
        }
    }
    run_engine_cli_forward(&args[1..])
}

fn run_engine_cli_forward(engine_args: &[String]) -> i32 {
    if let Some(engine) = resolve_engine_exe() {
        let mut cmd = Command::new(&engine);
        cmd.args(engine_args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        return match cmd.status() {
            Ok(status) => status.code().unwrap_or(1),
            Err(e) => {
                eprintln!("Failed to start engine {}: {e}", engine.display());
                1
            }
        };
    }

    // Dev fallback: node scripts/weport-cli.cjs
    let project = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let candidates = [
        project.join("scripts").join("weport-cli.cjs"),
        project.join("..").join("scripts").join("weport-cli.cjs"),
    ];
    for cli in candidates {
        if cli.exists() {
            let mut cmd = Command::new("node");
            cmd.arg(&cli)
                .args(engine_args)
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit());
            return match cmd.status() {
                Ok(status) => status.code().unwrap_or(1),
                Err(e) => {
                    eprintln!("Failed to start node CLI: {e}");
                    1
                }
            };
        }
    }

    eprintln!("Weport engine not found. Install Weport or run from a built release.");
    eprintln!("Try: weport help");
    1
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if is_cli_invocation(&args) {
        let code = run_engine_cli(&args);
        std::process::exit(code);
    }
    weport_lib::run();
}
