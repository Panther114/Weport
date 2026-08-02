//! Locate WeChat 4.x data directories and account folders.
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub wxid: String,
    pub nickname: Option<String>,
    pub avatar_url: Option<String>,
    pub modified_time: Option<i64>,
}

pub fn default_wechat_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        // WeChat 4.x default on Windows
        roots.push(home.join("Documents").join("xwechat_files"));
        // Alternate Documents location
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            roots.push(PathBuf::from(user_profile).join("Documents").join("xwechat_files"));
        }
    }
    roots
}

pub fn is_account_dir(path: &Path) -> bool {
    path.join("db_storage").is_dir()
        || path.join("msg").is_dir()
        || path.join("business").is_dir()
}

pub fn find_account_dirs(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if is_account_dir(root) {
        out.push(root.to_path_buf());
        return out;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && is_account_dir(&path) {
            out.push(path);
        }
    }
    out
}

pub fn detect_db_path() -> Result<PathBuf, String> {
    for root in default_wechat_roots() {
        if !root.is_dir() {
            continue;
        }
        if !find_account_dirs(&root).is_empty() || is_account_dir(&root) {
            return Ok(root);
        }
    }
    Err("未能自动检测到微信数据库目录（默认 Documents\\xwechat_files）".into())
}

fn mtime_secs(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

/// Parse WeChat global_config (AES-128-CFB with fixed key) for nickname/avatar.
fn parse_global_config(root: &Path) -> Option<(String, String, String)> {
    use aes::Aes128;
    use cipher::{AsyncStreamCipher, KeyIvInit};

    type Aes128CfbDec = cfb_mode::Decryptor<Aes128>;

    let config_path = root.join("all_users").join("config").join("global_config");
    let full = fs::read(&config_path).ok()?;
    if full.len() <= 4 {
        return None;
    }
    let encrypted = &full[4..];
    let mut key = [0u8; 16];
    let src = b"xwechat_crypt_key";
    key[..src.len().min(16)].copy_from_slice(&src[..src.len().min(16)]);
    let iv = [0u8; 16];
    let mut data = encrypted.to_vec();
    let cipher = Aes128CfbDec::new_from_slices(&key, &iv).ok()?;
    cipher.decrypt(&mut data);

    let extract = |name: &str| -> String {
        let key_bytes = name.as_bytes();
        let Some(idx) = data.windows(key_bytes.len()).position(|w| w == key_bytes) else {
            return String::new();
        };
        let mut offset = idx + key_bytes.len();
        // skip two varints (mmkv layout)
        for _ in 0..2 {
            let mut shift = 0u32;
            let mut value = 0u32;
            while offset < data.len() && shift < 32 {
                let b = data[offset];
                offset += 1;
                value |= ((b & 0x7f) as u32) << shift;
                if b & 0x80 == 0 {
                    break;
                }
                shift += 7;
            }
            if shift == 0 {
                break;
            }
            // second varint is string length — capture on second loop
            if name == "__len_probe__" {
                let _ = value;
            }
        }
        // re-parse more carefully
        let _ = offset;
        String::new()
    };
    let _ = extract;

    // Simpler string extraction: search key then read following printable/utf8 length-prefixed region
    let get_mmkv = |key_name: &str| -> String {
        let kb = key_name.as_bytes();
        let Some(idx) = data.windows(kb.len()).position(|w| w == kb) else {
            return String::new();
        };
        let mut offset = idx + kb.len();
        // varint 1
        let mut shift = 0u32;
        while offset < data.len() && shift < 35 {
            let b = data[offset];
            offset += 1;
            if b & 0x80 == 0 {
                break;
            }
            shift += 7;
        }
        // varint 2 = length
        let mut value = 0u32;
        shift = 0;
        while offset < data.len() && shift < 32 {
            let b = data[offset];
            offset += 1;
            value |= ((b & 0x7f) as u32) << shift;
            if b & 0x80 == 0 {
                break;
            }
            shift += 7;
        }
        if value == 0 || value > 10000 || offset + value as usize > data.len() {
            return String::new();
        }
        String::from_utf8_lossy(&data[offset..offset + value as usize]).to_string()
    };

    let wxid = get_mmkv("mmkv_key_user_name");
    let nickname = get_mmkv("mmkv_key_nick_name");
    let mut avatar = get_mmkv("mmkv_key_head_img_url");
    if avatar.is_empty() {
        if let Some(http_idx) = data.windows(4).position(|w| w == b"http") {
            let end = data[http_idx..]
                .iter()
                .position(|&b| b == 0)
                .map(|i| http_idx + i)
                .unwrap_or(data.len().min(http_idx + 200));
            avatar = String::from_utf8_lossy(&data[http_idx..end]).to_string();
        }
    }
    if wxid.is_empty() && nickname.is_empty() {
        return None;
    }
    Some((wxid, nickname, avatar))
}

pub fn scan_accounts(root: &Path) -> Vec<AccountInfo> {
    let global = parse_global_config(root);
    let dirs = find_account_dirs(root);
    let mut accounts = Vec::new();

    for dir in dirs {
        let name = dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() || name == "all_users" || name.starts_with('.') {
            continue;
        }
        // Skip obvious non-account folders
        if name == "Backup" || name == "WMPF" {
            continue;
        }

        let mut nickname = None;
        let mut avatar = None;
        if let Some((g_wxid, g_nick, g_avatar)) = &global {
            if !g_wxid.is_empty()
                && (name == *g_wxid
                    || name.starts_with(&format!("{g_wxid}_"))
                    || g_wxid.starts_with(&name))
            {
                if !g_nick.is_empty() {
                    nickname = Some(g_nick.clone());
                }
                if !g_avatar.is_empty() {
                    avatar = Some(g_avatar.clone());
                }
            }
        }

        accounts.push(AccountInfo {
            wxid: name,
            nickname,
            avatar_url: avatar,
            modified_time: mtime_secs(&dir),
        });
    }

    accounts.sort_by(|a, b| {
        b.modified_time
            .unwrap_or(0)
            .cmp(&a.modified_time.unwrap_or(0))
    });
    accounts
}

pub fn resolve_account_dir(db_root: &Path, wxid: &str) -> Option<PathBuf> {
    let direct = db_root.join(wxid);
    if is_account_dir(&direct) {
        return Some(direct);
    }
    // suffix variants wxid_xxx_1234
    if let Ok(entries) = fs::read_dir(db_root) {
        let lower = wxid.to_lowercase();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if (name == lower || name.starts_with(&format!("{lower}_"))) && is_account_dir(&path) {
                return Some(path);
            }
        }
    }
    if is_account_dir(db_root) {
        return Some(db_root.to_path_buf());
    }
    None
}

pub fn find_session_db(account_dir: &Path) -> Option<PathBuf> {
    let db_storage = account_dir.join("db_storage");
    let root = if db_storage.is_dir() {
        db_storage
    } else {
        account_dir.to_path_buf()
    };
    find_named_file(&root, "session.db", 6)
}

fn find_named_file(dir: &Path, name: &str, max_depth: usize) -> Option<PathBuf> {
    if max_depth == 0 || !dir.is_dir() {
        return None;
    }
    let target = name.to_lowercase();
    let Ok(entries) = fs::read_dir(dir) else {
        return None;
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if entry.file_name().to_string_lossy().to_lowercase() == target {
                return Some(path);
            }
        } else if path.is_dir() {
            subdirs.push(path);
        }
    }
    for sub in subdirs {
        if let Some(found) = find_named_file(&sub, name, max_depth - 1) {
            return Some(found);
        }
    }
    None
}

pub fn resource_native_dir(app_resource_dir: &Path) -> PathBuf {
    // Prefer bundled slim layout
    let candidates = [
        app_resource_dir.join("native"),
        app_resource_dir.join("resources").join("native"),
        app_resource_dir
            .join("resources")
            .join("wcdb")
            .join("win32")
            .join("x64")
            .parent() // go up — not ideal
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| app_resource_dir.to_path_buf()),
    ];
    for c in candidates {
        if c.join("wcdb_api.dll").exists() || c.join("wcdb").exists() {
            return c;
        }
    }
    // Dev: project resources
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for root in [cwd.clone(), cwd.join("..")] {
        let p = root.join("resources").join("native").join("win32").join("x64");
        if p.join("wcdb_api.dll").exists() {
            return p;
        }
        let p2 = root.join("resources").join("wcdb").join("win32").join("x64");
        if p2.join("wcdb_api.dll").exists() {
            return p2.parent().unwrap().parent().unwrap().parent().unwrap().to_path_buf();
        }
    }
    app_resource_dir.to_path_buf()
}

pub fn resolve_wcdb_dir(resource_root: &Path) -> PathBuf {
    let slim = resource_root.join("native").join("win32").join("x64");
    if slim.join("wcdb_api.dll").exists() {
        return slim;
    }
    let classic = resource_root
        .join("wcdb")
        .join("win32")
        .join("x64");
    if classic.join("wcdb_api.dll").exists() {
        return classic;
    }
    // resource_root itself may be the dll dir
    if resource_root.join("wcdb_api.dll").exists() {
        return resource_root.to_path_buf();
    }
    classic
}

pub fn resolve_key_dll(resource_root: &Path) -> PathBuf {
    let candidates = [
        resource_root
            .join("native")
            .join("win32")
            .join("x64")
            .join("wx_key.dll"),
        resource_root
            .join("key")
            .join("win32")
            .join("x64")
            .join("wx_key.dll"),
        resource_root.join("wx_key.dll"),
    ];
    for c in &candidates {
        if c.exists() {
            return c.clone();
        }
    }
    candidates[0].clone()
}
