//! WeChat 4.x anti-recall patcher for Weixin.dll.
//!
//! Port of the patch *mechanism* from huiyadanli/RevokeMsgPatcher
//! (GPLv3, https://github.com/huiyadanli/RevokeMsgPatcher) — fuzzy wildcard
//! byte matching + backup/restore + patch-data JSON. WeChat 3.x is not
//! supported: only the Weixin.dll (WeChat 4) feature patterns are bundled.
//!
//! How it works (see RevokeMsgPatcher wiki):
//! WeChat's recall logic lives in Weixin.dll next to the "revokemsg" marker.
//! A conditional jump decides whether a recalled message gets hidden; the
//! patch flips that branch (je/jne -> jmp or nop+jmp) so recalled messages
//! stay visible inside WeChat.
//!
//! Patch data: `src-tauri/resources/antirecall/patch.json` (a Weixin-only
//! extract of RevokeMsgPatcher's patch.json, 防撤回 category only).
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const PATCH_DATA_RESOURCE: &str = "antirecall/patch.json";

/// 0x3F wildcard byte used inside Search patterns (from FuzzyMatcher.cs).
const WILDCARD: u8 = 0x3F;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PatchConfig {
    pub apps: HashMap<String, AppConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct AppConfig {
    pub name: String,
    pub file_target_infos: HashMap<String, TargetInfo>,
    pub file_common_modify_infos: HashMap<String, Vec<CommonModifyInfo>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct TargetInfo {
    pub name: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct CommonModifyInfo {
    pub name: String,
    pub start_version: String,
    pub end_version: String,
    pub replace_patterns: Vec<ReplacePattern>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ReplacePattern {
    pub search: Vec<u8>,
    pub replace: Vec<u8>,
    pub category: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatchState {
    NotInstalled,
    WeChatRunning,
    Patched,
    NotPatched,
    Unsupported,
}

impl PatchConfig {
    pub fn weixin() -> Option<AppConfig> {
        Self::load()
            .ok()
            .and_then(|c| c.apps.get("Weixin").cloned())
            .or_else(|| Self::load_embedded().apps.get("Weixin").cloned())
    }

    fn load() -> Result<PatchConfig, String> {
        let root = crate::resource_root::resource_root();
        let path = root.join(PATCH_DATA_RESOURCE);
        let text = fs::read_to_string(&path)
            .map_err(|e| format!("读取补丁数据失败 ({}): {e}", path.display()))?;
        serde_json::from_str(&text).map_err(|e| format!("解析补丁数据失败: {e}"))
    }

    fn load_embedded() -> PatchConfig {
        const EMBEDDED: &str = include_str!("../resources/antirecall/patch.json");
        serde_json::from_str(EMBEDDED).expect("embedded antirecall patch.json must parse")
    }
}

// ---------------------------------------------------------------------------
// Fuzzy matcher (port of FuzzyMatcher.cs + BoyerMooreMatcher.cs)
// ---------------------------------------------------------------------------

/// Boyer-Moore match-all on a plain (wildcard-free) needle.
fn boyer_moore_match_all(content: &[u8], needle: &[u8]) -> Vec<usize> {
    let mut out = Vec::new();
    let n = content.len();
    let m = needle.len();
    if m == 0 || n < m {
        return out;
    }
    // Bad-character table over the last byte alphabet.
    let mut bad_char = [m as usize; 256];
    for (i, &b) in needle[..m - 1].iter().enumerate() {
        bad_char[b as usize] = m - 1 - i;
    }
    let mut i = m - 1;
    while i < n {
        let mut j = m - 1;
        while content[i - (m - 1 - j)] == needle[j] {
            if j == 0 {
                out.push(i - (m - 1));
                break;
            }
            j -= 1;
        }
        let skip = bad_char[content[i] as usize].max(1);
        i += skip;
    }
    out
}

/// Wildcard-aware equality: 0x3F matches any byte.
fn is_equal(content: &[u8], start: usize, pattern: &[u8]) -> bool {
    if start + pattern.len() > content.len() {
        return false;
    }
    for (i, &p) in pattern.iter().enumerate() {
        if p != WILDCARD && content[start + i] != p {
            return false;
        }
    }
    true
}

/// All positions where `pattern` (possibly wildcarded) matches `content`.
fn match_all(content: &[u8], pattern: &[u8]) -> Vec<usize> {
    // Head: everything up to the first wildcard.
    let head_len = pattern
        .iter()
        .position(|&b| b == WILDCARD)
        .unwrap_or(pattern.len());
    if head_len == 0 {
        return Vec::new();
    }
    let head = &pattern[..head_len];
    let hits = boyer_moore_match_all(content, head);
    if head_len == pattern.len() {
        return hits;
    }
    hits.into_iter()
        .filter(|&idx| is_equal(content, idx, pattern))
        .collect()
}

fn has_pattern(content: &[u8], pattern: &[u8]) -> bool {
    !match_all(content, pattern).is_empty()
}

// ---------------------------------------------------------------------------
// Install path discovery (port of WeixinModifier.cs + PathUtil.cs)
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn registry_uninstall_string(name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::*;
    let key_path = format!(
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{name}"
    );
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            to_wide(&key_path).as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut hkey,
        ) != 0
        {
            return None;
        }
        let mut size: u32 = 0;
        let status = RegQueryValueExW(
            hkey,
            to_wide("UninstallString").as_ptr(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        );
        if status != 0 || size == 0 || size > 4096 {
            RegCloseKey(hkey);
            return None;
        }
        let mut buf = vec![0u16; (size / 2) as usize + 1];
        let status = RegQueryValueExW(
            hkey,
            to_wide("UninstallString").as_ptr(),
            std::ptr::null(),
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut u8,
            &mut size,
        );
        RegCloseKey(hkey);
        if status != 0 {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let s = String::from_utf16_lossy(&buf[..end]).replace('"', "");
        if s.trim().is_empty() {
            None
        } else {
            Some(s.trim().to_string())
        }
    }
}

#[cfg(not(windows))]
fn registry_uninstall_string(_name: &str) -> Option<String> {
    None
}

fn dir_contains_weixin_dll(dir: &Path) -> bool {
    dir.join("Weixin.dll").is_file()
}

/// Real install path: the newest subfolder containing Weixin.dll (WeChat 4
/// keeps versioned subdirectories under the install root).
fn get_real_install_path(base: &Path) -> Option<PathBuf> {
    if dir_contains_weixin_dll(base) {
        return Some(base.to_path_buf());
    }
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = fs::read_dir(base)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let p = e.path();
            let mtime = fs::metadata(&p)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            Some((mtime, p))
        })
        .collect();
    dirs.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    for (_, dir) in dirs {
        if dir_contains_weixin_dll(&dir) {
            return Some(dir);
        }
    }
    None
}

pub fn find_weixin_install_path() -> Option<PathBuf> {
    // 1) Registry UninstallString
    if let Some(uninstall) = registry_uninstall_string("Weixin") {
        let p = Path::new(&uninstall);
        let base = if p.is_dir() { p.to_path_buf() } else { p.parent()?.to_path_buf() };
        if let Some(real) = get_real_install_path(&base) {
            return Some(real);
        }
    }
    // 2) Default Program Files layouts
    for drive in default_drives() {
        for rel in [r"Program Files (x86)\Tencent\Weixin", r"Program Files\Tencent\Weixin"] {
            let base = drive.join(rel);
            if base.is_dir() {
                if let Some(real) = get_real_install_path(&base) {
                    return Some(real);
                }
            }
        }
    }
    None
}

fn default_drives() -> Vec<PathBuf> {
    let mut drives = Vec::new();
    if let Ok(drive) = std::env::var("SystemDrive") {
        drives.push(PathBuf::from(format!("{}\\", drive.trim_end_matches('\\'))));
    }
    // Fall back to C: only (the C# original scans every logical drive).
    if drives.is_empty() {
        drives.push(PathBuf::from("C:\\"));
    }
    drives
}

fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

// ---------------------------------------------------------------------------
// PE file version (via the Windows version API — same source the original
// RevokeMsgPatcher uses via .NET FileVersionInfo)
// ---------------------------------------------------------------------------

/// Extract the FileVersion string ("4.1.11.55") from the DLL's version
/// resource. Returns None when the resource cannot be parsed.
pub fn pe_version(path: &Path) -> Option<String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
        };
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let mut handle: u32 = 0;
            let size = GetFileVersionInfoSizeW(wide.as_ptr(), &mut handle);
            if size == 0 {
                return None;
            }
            let mut buf = vec![0u8; size as usize];
            if GetFileVersionInfoW(wide.as_ptr(), handle, size, buf.as_mut_ptr() as *mut _) == 0 {
                return None;
            }
            let mut ptr: *mut core::ffi::c_void = std::ptr::null_mut();
            let mut len: u32 = 0;
            let key = to_wide("\\");
            if VerQueryValueW(
                buf.as_ptr() as *const _,
                key.as_ptr(),
                &mut ptr,
                &mut len,
            ) == 0
                || ptr.is_null()
                || len < 52
            {
                return None;
            }
            // VS_FIXEDFILEINFO: dwFileVersionMS at +8, dwFileVersionLS at +12.
            let fixed = ptr as *const u8;
            let ms = u32::from_le_bytes(std::slice::from_raw_parts(fixed.add(8), 4).try_into().ok()?);
            let ls = u32::from_le_bytes(std::slice::from_raw_parts(fixed.add(12), 4).try_into().ok()?);
            Some(format!(
                "{}.{}.{}.{}",
                (ms >> 16) & 0xFFFF,
                ms & 0xFFFF,
                (ls >> 16) & 0xFFFF,
                ls & 0xFFFF
            ))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

/// Version-range gate, mirroring RevokeMsgPatcher's IsInVersionRange
/// (start < version <= end; empty end means no upper bound).
pub fn in_version_range(version: &str, start: &str, end: &str) -> bool {
    let cmp = |a: &str, b: &str| -> Option<std::cmp::Ordering> {
        let pa: Vec<u64> = a
            .split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect();
        let pb: Vec<u64> = b
            .split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect();
        for i in 0..pa.len().max(pb.len()) {
            let x = pa.get(i).copied().unwrap_or(0);
            let y = pb.get(i).copied().unwrap_or(0);
            if x != y {
                return Some(x.cmp(&y));
            }
        }
        Some(std::cmp::Ordering::Equal)
    };
    let Some(above_start) = cmp(version, start) else {
        return false;
    };
    if above_start != std::cmp::Ordering::Greater {
        return false;
    }
    if end.is_empty() {
        return true;
    }
    cmp(version, end).map(|c| c != std::cmp::Ordering::Greater).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Status + patch application
// ---------------------------------------------------------------------------

fn weixin_dll_path(install: &Path) -> PathBuf {
    install.join("Weixin.dll")
}

/// True when the binary already carries the patched bytes for a pattern set.
fn changes_for_range(bytes: &[u8], info: &CommonModifyInfo) -> Option<Vec<(usize, Vec<u8>)>> {
    let mut changes = Vec::new();
    for pattern in &info.replace_patterns {
        let search_hits = match_all(bytes, &pattern.search);
        if search_hits.is_empty() {
            // Already replaced? (search absent + replace present)
            if has_pattern(bytes, &pattern.replace) {
                continue;
            }
            return None; // this range does not fit this DLL
        }
        // 0x3F wildcards inside Replace inherit the matched bytes; otherwise
        // the replace bytes are fixed (same length as search for all WeChat 4
        // patterns).
        for hit in search_hits {
            let mut content = pattern.replace.clone();
            for (i, b) in content.iter_mut().enumerate() {
                if *b == WILDCARD {
                    *b = bytes[hit + i];
                }
            }
            changes.push((hit, content));
        }
    }
    Some(changes)
}

/// Determine the patch state for a Weixin install.
pub fn patch_state(install: &Path) -> PatchState {
    if !weixin_dll_path(install).is_file() {
        return PatchState::NotInstalled;
    }
    if crate::key::wechat_running() {
        return PatchState::WeChatRunning;
    }
    patch_state_impl(install)
}

fn patch_state_impl(install: &Path) -> PatchState {
    let Ok(bytes) = fs::read(weixin_dll_path(install)) else {
        return PatchState::Unsupported;
    };
    let Some(weixin) = PatchConfig::weixin() else {
        return PatchState::Unsupported;
    };
    let Some(ranges) = weixin.file_common_modify_infos.get("Weixin.dll") else {
        return PatchState::Unsupported;
    };

    let version = pe_version(&weixin_dll_path(install));
    let mut any_range_match = false;
    for info in version_gated_ranges(version.as_deref(), ranges) {
        let Some(changes) = changes_for_range(&bytes, info) else {
            continue;
        };
        if changes.is_empty() {
            // Every pattern in this range is already replaced.
            return PatchState::Patched;
        }
        any_range_match = true;
    }
    if any_range_match {
        PatchState::NotPatched
    } else {
        PatchState::Unsupported
    }
}

/// Apply the anti-recall patch (backup + byte replacement).
pub fn apply(install: &Path) -> Result<(), String> {
    if crate::key::wechat_running() {
        return Err("请先退出微信（Weixin.exe）再安装防撤回补丁".into());
    }
    apply_impl(install)
}

fn apply_impl(install: &Path) -> Result<(), String> {
    let dll = weixin_dll_path(install);
    if !dll.is_file() {
        return Err(format!("未找到 Weixin.dll: {}", dll.display()));
    }
    let Some(weixin) = PatchConfig::weixin() else {
        return Err("补丁数据加载失败".into());
    };
    let Some(ranges) = weixin.file_common_modify_infos.get("Weixin.dll") else {
        return Err("补丁数据缺少 Weixin.dll 特征".into());
    };

    let bytes = fs::read(&dll).map_err(|e| format!("读取 Weixin.dll 失败: {e}"))?;
    let version = pe_version(&dll);

    // Find the first matching version range with pending changes.
    let mut target_changes: Option<Vec<(usize, Vec<u8>)>> = None;
    for info in version_gated_ranges(version.as_deref(), ranges) {
        if let Some(changes) = changes_for_range(&bytes, info) {
            if !changes.is_empty() {
                target_changes = Some(changes);
                break;
            }
        }
    }
    let Some(changes) = target_changes else {
        return Err("当前微信版本不受支持（特征码未匹配）。请在 Weport 更新后重试。".into());
    };

    // Backup once (never overwrite an existing backup of the same DLL).
    let bak = dll.with_file_name("Weixin.dll.h.bak");
    if !bak.exists() {
        fs::copy(&dll, &bak).map_err(|e| format!("备份 Weixin.dll 失败: {e}"))?;
    }

    let mut patched = bytes.clone();
    for (pos, content) in &changes {
        let end = pos + content.len();
        if end > patched.len() {
            return Err("补丁写入越界，已中止".into());
        }
        patched[*pos..end].copy_from_slice(content);
    }

    fs::write(&dll, &patched).map_err(|e| format!("写入 Weixin.dll 失败: {e}"))?;
    Ok(())
}

/// Restore Weixin.dll from the backup file.
pub fn remove(install: &Path) -> Result<(), String> {
    if crate::key::wechat_running() {
        return Err("请先退出微信（Weixin.exe）再还原防撤回补丁".into());
    }
    remove_impl(install)
}

fn remove_impl(install: &Path) -> Result<(), String> {
    let dll = weixin_dll_path(install);
    let bak = dll.with_file_name("Weixin.dll.h.bak");
    if !bak.is_file() {
        return Err("备份文件不存在，无法还原".into());
    }
    fs::copy(&bak, &dll).map_err(|e| format!("还原 Weixin.dll 失败: {e}"))?;
    Ok(())
}
// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

/// Is the current process running elevated (admin token)?
pub fn is_elevated() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY};
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut elevation: TOKEN_ELEVATION = std::mem::zeroed();
            let mut size: u32 = 0;
            let ok = GetTokenInformation(
                token,
                20, // TokenElevation
                &mut elevation as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            );
            windows_sys::Win32::Foundation::CloseHandle(token);
            ok != 0 && elevation.TokenIsElevated != 0
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Relaunch the current executable elevated with the given arguments
/// (ShellExecuteExW with the "runas" verb — same pattern as cli_update.rs).
pub fn relaunch_elevated(args: &[String]) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut file: Vec<u16> = exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let mut params: Vec<u16> = wide(&args.join(" "));
    let mut verb: Vec<u16> = wide("runas");

    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_FLAG_NO_UI;
    info.lpVerb = verb.as_mut_ptr();
    info.lpFile = file.as_mut_ptr();
    info.lpParameters = params.as_mut_ptr();
    info.nShow = SW_SHOWNORMAL;

    let ok = unsafe { ShellExecuteExW(&mut info) };
    if ok == 0 {
        return Err(format!("请求管理员权限失败: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

/// Ranges that apply to the installed version. When the PE version cannot be
/// read, every range is considered (file order acts as a tie-breaker).
fn version_gated_ranges<'a>(
    version: Option<&str>,
    ranges: &'a [CommonModifyInfo],
) -> Vec<&'a CommonModifyInfo> {
    match version {
        Some(v) => ranges
            .iter()
            .filter(|r| in_version_range(v, &r.start_version, &r.end_version))
            .collect(),
        None => ranges.iter().collect(),
    }
}

/// Diagnostics: report which version range matches the installed Weixin.dll
/// and how many change points would be written. Read-only, never modifies.
pub fn dry_run(install: &Path) -> Result<serde_json::Value, String> {
    let dll = weixin_dll_path(install);
    if !dll.is_file() {
        return Err(format!("未找到 Weixin.dll: {}", dll.display()));
    }
    let Some(weixin) = PatchConfig::weixin() else {
        return Err("补丁数据加载失败".into());
    };
    let Some(ranges) = weixin.file_common_modify_infos.get("Weixin.dll") else {
        return Err("补丁数据缺少 Weixin.dll 特征".into());
    };
    let bytes = fs::read(&dll).map_err(|e| format!("读取 Weixin.dll 失败: {e}"))?;
    let version = pe_version(&dll);

    let mut matched = Vec::new();
    for info in ranges {
        let mut pattern_reports = Vec::new();
        let mut ok = true;
        for pattern in &info.replace_patterns {
            let search_hits = match_all(&bytes, &pattern.search).len();
            let replace_hits = has_pattern(&bytes, &pattern.replace);
            pattern_reports.push(serde_json::json!({
                "searchHits": search_hits,
                "replacePresent": replace_hits
            }));
            if search_hits == 0 && !replace_hits {
                ok = false;
            }
        }
        let in_range = version
            .as_deref()
            .map(|v| in_version_range(v, &info.start_version, &info.end_version))
            .unwrap_or(true);
        matched.push(serde_json::json!({
            "startVersion": info.start_version,
            "endVersion": info.end_version,
            "inVersionRange": in_range,
            "matches": ok && in_range,
            "patterns": pattern_reports
        }));
    }
    Ok(serde_json::json!({
        "dll": dll.display().to_string(),
        "version": version,
        "size": bytes.len(),
        "ranges": matched
    }))
}

/// Elevated helper entry point: run the requested anti-recall action headless
/// and write a JSON result file (the non-elevated GUI polls for it).
pub fn run_elevated_action(action: &str, install: &str, result_file: &str) -> i32 {
    let result = match action {
        "apply" => apply(Path::new(install))
            .map(|_| serde_json::json!({"success": true, "message": "防撤回补丁已安装"})),
        "remove" => remove(Path::new(install))
            .map(|_| serde_json::json!({"success": true, "message": "防撤回补丁已还原"})),
        other => Err(format!("未知操作: {other}")),
    };
    let json = match result {
        Ok(v) => v.to_string(),
        Err(e) => serde_json::json!({"success": false, "message": e}).to_string(),
    };
    if !result_file.is_empty() {
        let _ = fs::write(result_file, &json);
    } else {
        println!("{json}");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("weport-antirecall-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn wildcard_match_all_finds_offsets() {
        let content: Vec<u8> = vec![1, 2, 3, 4, 5, 1, 2, 3, 6, 7, 8];
        let pattern: Vec<u8> = vec![1, 2, super::WILDCARD, 4];
        assert_eq!(super::match_all(&content, &pattern), vec![0]);
        let pattern2: Vec<u8> = vec![1, 2, super::WILDCARD, 5];
        assert!(super::match_all(&content, &pattern2).is_empty());
    }

    #[test]
    fn wildcard_skips_wildcards() {
        let content: Vec<u8> = vec![0xAA, 0x00, 0x00, 0xBB];
        let pattern: Vec<u8> = vec![0xAA, super::WILDCARD, super::WILDCARD, 0xBB];
        assert!(super::is_equal(&content, 0, &pattern));
    }

    #[test]
    fn embedded_patch_data_parses() {
        let cfg = PatchConfig::load_embedded();
        let weixin = cfg.apps.get("Weixin").expect("Weixin app");
        let ranges = weixin
            .file_common_modify_infos
            .get("Weixin.dll")
            .expect("Weixin.dll ranges");
        assert!(!ranges.is_empty());
        for r in ranges {
            assert!(!r.replace_patterns.is_empty());
            for p in &r.replace_patterns {
                assert_eq!(p.search.len(), p.replace.len(), "search/replace length");
                assert!(!p.category.is_empty());
                // Search must have a wildcard-free head.
                assert_ne!(p.search[0], super::WILDCARD);
            }
        }
    }

    #[test]
    fn empty_boyer_moore_returns_empty() {
        assert!(super::boyer_moore_match_all(&[1, 2, 3], &[]).is_empty());
        assert!(super::boyer_moore_match_all(&[1, 2], &[1, 2, 3]).is_empty());
    }

    #[test]
    fn version_range_gate_matches_revmspatcher_semantics() {
        // RevokeMsgPatcher: start < version <= end (empty end = unbounded).
        assert!(super::in_version_range("4.1.11.55", "4.1.9.0", "4.1.12.0"));
        assert!(!super::in_version_range("4.1.9.0", "4.1.9.0", "4.1.12.0"));
        assert!(super::in_version_range("4.1.12.0", "4.1.9.0", "4.1.12.0")); // end inclusive
        assert!(!super::in_version_range("4.0.0.0", "4.1.9.0", "4.1.12.0"));
        assert!(super::in_version_range("4.1.12.0", "4.1.9.0", ""));
        assert!(super::in_version_range("4.2.0.0", "4.1.9.0", ""));
        assert!(!super::in_version_range("4.0.5.0", "4.1.9.0", ""));
    }

    #[test]
    fn apply_creates_backup_and_changes_bytes_remove_restores() {
        // Pull the 4.1.9.0→4.1.12.0 range straight from the embedded data so
        // the test stays consistent with the shipped patch.json.
        let cfg = PatchConfig::load_embedded();
        let weixin = cfg.apps.get("Weixin").expect("Weixin app");
        let ranges = weixin
            .file_common_modify_infos
            .get("Weixin.dll")
            .expect("Weixin.dll ranges");
        let range = ranges
            .iter()
            .find(|r| r.start_version == "4.1.9.0" && r.end_version == "4.1.12.0")
            .expect("4.1.9.0 range");
        let pattern = &range.replace_patterns[0];

        let td = TempDir::new("roundtrip");
        let install = td.0.clone();
        let dll = install.join("Weixin.dll");

        // Synthetic DLL: 8 KiB of 0x90 with the search pattern at offset 1000.
        let mut bytes = vec![0x90u8; 8192];
        bytes[1000..1000 + pattern.search.len()].copy_from_slice(&pattern.search);
        fs::write(&dll, &bytes).unwrap();

        // Not patched yet.
        assert_eq!(super::patch_state_impl(&install), PatchState::NotPatched);

        super::apply_impl(&install).unwrap();

        // Bytes at 1000.. must now equal the replace pattern.
        let patched = fs::read(&dll).unwrap();
        assert_eq!(
            &patched[1000..1000 + pattern.replace.len()],
            &pattern.replace[..]
        );
        // Backup must exist next to the DLL.
        assert!(install.join("Weixin.dll.h.bak").is_file());
        // State flips to Patched.
        assert_eq!(super::patch_state_impl(&install), PatchState::Patched);

        // Remove restores the original bytes.
        super::remove_impl(&install).unwrap();
        let restored = fs::read(&dll).unwrap();
        assert_eq!(
            &restored[1000..1000 + pattern.search.len()],
            &pattern.search[..]
        );
        assert_eq!(super::patch_state_impl(&install), PatchState::NotPatched);
    }

    #[test]
    fn apply_refuses_unknown_version_without_side_effects() {
        let td = TempDir::new("unknown");
        let install = td.0.clone();
        let dll = install.join("Weixin.dll");
        // A DLL whose bytes match no pattern set.
        let bytes = vec![0xCCu8; 4096];
        fs::write(&dll, &bytes).unwrap();
        assert_eq!(super::patch_state_impl(&install), PatchState::Unsupported);
        assert!(super::apply_impl(&install).is_err());
        assert!(!install.join("Weixin.dll.h.bak").exists());
    }
}
