//! Locate bundled WCDB / key DLLs next to the executable (or dev tree).
use std::path::PathBuf;

pub fn looks_like_resource_root(dir: &std::path::Path) -> bool {
    dir.join("wcdb")
        .join("win32")
        .join("x64")
        .join("wcdb_api.dll")
        .exists()
        || dir
            .join("native")
            .join("win32")
            .join("x64")
            .join("wcdb_api.dll")
            .exists()
        || dir.join("wcdb_api.dll").exists()
}

pub fn resource_root() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for c in [
                dir.join("resources"),
                dir.to_path_buf(),
                dir.join("..").join("resources"),
            ] {
                if looks_like_resource_root(&c) {
                    return c;
                }
            }
        }
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for root in [cwd.clone(), cwd.join(".."), cwd.join("src-tauri").join("..")] {
        let p = root.join("src-tauri").join("resources");
        if looks_like_resource_root(&p) {
            return p;
        }
        let p2 = root.join("resources");
        if looks_like_resource_root(&p2) {
            return p2;
        }
    }
    cwd
}
