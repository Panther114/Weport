//! wx_key.dll — extract WeChat 4.x database decrypt key.
//! Ported from WeFlow keyService.ts (Windows path).
//!
//! Critical product fact (WeFlow Welcome flow):
//! The hook does **not** reliably scrape a key from an already-logged-in session.
//! After "Hook安装成功", the user must login / logout+re-login so the key path is hit.
use libloading::{Library, Symbol};
use std::ffi::CStr;
use std::os::raw::{c_char, c_int};
use std::path::Path;
use std::time::{Duration, Instant};

type FnInitializeHook = unsafe extern "C" fn(u32) -> bool;
type FnPollKeyData = unsafe extern "C" fn(*mut c_char, c_int) -> bool;
type FnGetStatusMessage = unsafe extern "C" fn(*mut c_char, c_int, *mut c_int) -> bool;
type FnCleanupHook = unsafe extern "C" fn() -> bool;
type FnGetLastErrorMsg = unsafe extern "C" fn() -> *const c_char;

struct KeyApi {
    _lib: Library,
    init_hook: FnInitializeHook,
    poll_key: FnPollKeyData,
    get_status: FnGetStatusMessage,
    cleanup: FnCleanupHook,
    last_error: Option<FnGetLastErrorMsg>,
}

#[derive(Debug)]
enum PollResult {
    Success(String),
    ProcessEnded { login_required: bool },
    Timeout { login_required: bool },
}

fn load_key_api(dll_path: &Path) -> Result<KeyApi, String> {
    if !dll_path.exists() {
        return Err(format!(
            "未找到 wx_key.dll: {}\n请确认安装完整或从发布包安装。",
            dll_path.display()
        ));
    }

    // Ensure DLL directory is searchable for any deps
    if let Some(dir) = dll_path.parent() {
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let wide: Vec<u16> = dir
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            unsafe {
                windows_sys::Win32::System::LibraryLoader::SetDllDirectoryW(wide.as_ptr());
            }
        }
    }

    let lib =
        unsafe { Library::new(dll_path).map_err(|e| format!("加载 wx_key.dll 失败: {e}"))? };

    unsafe {
        let init_hook: Symbol<FnInitializeHook> = lib
            .get(b"InitializeHook\0")
            .map_err(|e| format!("InitializeHook: {e}"))?;
        let poll_key: Symbol<FnPollKeyData> = lib
            .get(b"PollKeyData\0")
            .map_err(|e| format!("PollKeyData: {e}"))?;
        let get_status: Symbol<FnGetStatusMessage> = lib
            .get(b"GetStatusMessage\0")
            .map_err(|e| format!("GetStatusMessage: {e}"))?;
        let cleanup: Symbol<FnCleanupHook> = lib
            .get(b"CleanupHook\0")
            .map_err(|e| format!("CleanupHook: {e}"))?;
        let last_error: Option<FnGetLastErrorMsg> = lib
            .get(b"GetLastErrorMsg\0")
            .ok()
            .map(|s: Symbol<FnGetLastErrorMsg>| *s);

        Ok(KeyApi {
            init_hook: *init_hook,
            poll_key: *poll_key,
            get_status: *get_status,
            cleanup: *cleanup,
            last_error,
            _lib: lib,
        })
    }
}

fn decode_cbuf(buf: &[u8]) -> String {
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).trim().to_string()
}

/// Normalize DLL status lines the same way WeFlow WelcomePage does.
pub fn normalize_status_message(message: &str) -> String {
    if message.contains("Hook安装成功") {
        return "已准备就绪 — 请现在登录微信，或退出微信后重新登录（关闭自动登录）".into();
    }
    if message.contains("现在可以登录") {
        return "可以登录微信了 — 请在手机上确认登录".into();
    }
    message.to_string()
}

fn is_login_related_text(value: &str) -> bool {
    let normalized: String = value.chars().filter(|c| !c.is_whitespace()).collect();
    let lower = normalized.to_lowercase();
    [
        "登录",
        "掃碼",
        "扫码",
        "二维码",
        "請在手機上確認",
        "请在手机上确认",
        "手机确认",
        "切换账号",
        "wechatlogin",
        "qrcode",
        "scan",
    ]
    .iter()
    .any(|k| lower.contains(&k.to_lowercase()))
}

fn is_ready_status(message: &str) -> bool {
    message.contains("现在可以登录")
        || message.contains("Hook安装成功")
        || message.contains("已准备就绪")
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, TRUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GetClassNameW, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible,
    };

    pub fn find_wechat_pids() -> Vec<u32> {
        let mut pids = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if !snap.is_null() {
                let mut entry: PROCESSENTRY32W = std::mem::zeroed();
                entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                if Process32FirstW(snap, &mut entry) != 0 {
                    loop {
                        let end = entry
                            .szExeFile
                            .iter()
                            .position(|&c| c == 0)
                            .unwrap_or(entry.szExeFile.len());
                        let name = String::from_utf16_lossy(&entry.szExeFile[..end]).to_lowercase();
                        if name == "weixin.exe" || name == "wechat.exe" {
                            if !pids.contains(&entry.th32ProcessID) {
                                pids.push(entry.th32ProcessID);
                            }
                        }
                        if Process32NextW(snap, &mut entry) == 0 {
                            break;
                        }
                    }
                }
                CloseHandle(snap);
            }
        }
        pids
    }

    pub fn is_pid_alive(pid: u32) -> bool {
        // The pid must still be a WeChat process (by name) or own a WeChat window.
        // A bare OpenProcess existence check is wrong here: Windows recycles PIDs
        // quickly, so a dead WeChat pid may already belong to an unrelated live
        // process and the poll loop would never notice WeChat exited (WeFlow's
        // keyService checks the pid against the tasklist, never bare existence).
        if find_wechat_pids().contains(&pid) {
            return true;
        }
        if let Some(window_pid) = wait_for_wechat_window_pid(Duration::from_millis(250)) {
            return window_pid == pid;
        }
        false
    }

    fn window_title(hwnd: HWND) -> String {
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return String::new();
            }
            let mut buf = vec![0u16; (len + 1) as usize];
            let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), len + 1);
            if n <= 0 {
                return String::new();
            }
            String::from_utf16_lossy(&buf[..n as usize])
        }
    }

    fn class_name(hwnd: HWND) -> String {
        unsafe {
            let mut buf = [0u16; 256];
            let n = GetClassNameW(hwnd, buf.as_mut_ptr(), 256);
            if n <= 0 {
                return String::new();
            }
            String::from_utf16_lossy(&buf[..n as usize])
        }
    }

    fn is_wechat_window_title(title: &str) -> bool {
        let t = title.trim();
        if t.is_empty() {
            return false;
        }
        let lower = t.to_lowercase();
        t == "微信" || lower == "wechat" || lower == "weixin"
    }

    struct EnumState {
        target_pid: Option<u32>,
        found_pids: Vec<u32>,
        ready: bool,
        login_required: bool,
        child_infos: Vec<(String, String)>,
    }

    unsafe extern "system" fn enum_child_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam as *mut EnumState);
        let title = window_title(hwnd);
        let class = class_name(hwnd);
        state.child_infos.push((title, class));
        TRUE
    }

    fn collect_children(parent: HWND) -> Vec<(String, String)> {
        let mut state = EnumState {
            target_pid: None,
            found_pids: Vec::new(),
            ready: false,
            login_required: false,
            child_infos: Vec::new(),
        };
        unsafe {
            EnumChildWindows(
                parent,
                Some(enum_child_proc),
                &mut state as *mut _ as LPARAM,
            );
        }
        state.child_infos
    }

    fn has_ready_components(children: &[(String, String)]) -> bool {
        if children.is_empty() {
            return false;
        }
        let ready_texts = ["聊天", "登录", "账号"];
        let ready_class = [
            "WeChat",
            "Weixin",
            "TXGuiFoundation",
            "Qt5",
            "ChatList",
            "MainWnd",
            "BrowserWnd",
            "ListView",
        ];
        let mut class_match = 0usize;
        let mut title_match = 0usize;
        let mut has_valid_class = false;
        for (title, class) in children {
            let normalized: String = title.chars().filter(|c| !c.is_whitespace()).collect();
            if !normalized.is_empty() {
                if ready_texts.iter().any(|m| normalized.contains(m)) {
                    return true;
                }
                title_match += 1;
            }
            if !class.is_empty() {
                if ready_class.iter().any(|m| class.contains(m)) {
                    return true;
                }
                if class.len() > 5 {
                    class_match += 1;
                    has_valid_class = true;
                }
            }
        }
        if class_match >= 3 || title_match >= 2 {
            return true;
        }
        if children.len() >= 14 {
            return true;
        }
        if has_valid_class && children.len() >= 5 {
            return true;
        }
        false
    }

    /// Prefer PID that owns a visible main WeChat window; else first process.
    pub fn find_best_wechat_pid() -> Option<u32> {
        let pids = find_wechat_pids();
        if pids.is_empty() {
            // window fallback
            return wait_for_wechat_window_pid(Duration::from_millis(800));
        }

        // Prefer PID with WeChat main window
        if let Some(window_pid) = wait_for_wechat_window_pid(Duration::from_millis(200)) {
            if pids.contains(&window_pid) {
                return Some(window_pid);
            }
        }
        Some(pids[0])
    }

    pub fn wait_for_wechat_window_pid(timeout: Duration) -> Option<u32> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let mut found: Option<u32> = None;
            unsafe {
                EnumWindows(
                    Some(enum_find_wechat_window),
                    &mut found as *mut _ as LPARAM,
                );
            }
            if found.is_some() {
                return found;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        None
    }

    unsafe extern "system" fn enum_find_wechat_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd) == 0 {
            return TRUE;
        }
        let title = window_title(hwnd);
        if !is_wechat_window_title(&title) {
            return TRUE;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid != 0 {
            let out = &mut *(lparam as *mut Option<u32>);
            *out = Some(pid);
            return 0; // stop
        }
        TRUE
    }

    pub fn wait_for_window_components(pid: u32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let mut ready = false;
            let mut state = (pid, &mut ready);
            unsafe {
                EnumWindows(
                    Some(enum_ready_components),
                    &mut state as *mut _ as LPARAM,
                );
            }
            if ready {
                return true;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        true // WeFlow also returns true on timeout (non-blocking)
    }

    unsafe extern "system" fn enum_ready_components(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let (target_pid, ready) = &mut *(lparam as *mut (u32, &mut bool));
        if IsWindowVisible(hwnd) == 0 {
            return TRUE;
        }
        let title = window_title(hwnd);
        if !is_wechat_window_title(&title) {
            return TRUE;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid != *target_pid {
            return TRUE;
        }
        let children = collect_children(hwnd);
        if has_ready_components(&children) {
            **ready = true;
            return 0;
        }
        TRUE
    }

    pub fn detect_login_required(pid: u32) -> bool {
        let mut login_required = false;
        let mut state = (pid, &mut login_required);
        unsafe {
            EnumWindows(
                Some(enum_login_required),
                &mut state as *mut _ as LPARAM,
            );
        }
        login_required
    }

    unsafe extern "system" fn enum_login_required(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let (target_pid, login_required) = &mut *(lparam as *mut (u32, &mut bool));
        if IsWindowVisible(hwnd) == 0 {
            return TRUE;
        }
        let title = window_title(hwnd);
        if !is_wechat_window_title(&title) {
            return TRUE;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid != *target_pid {
            return TRUE;
        }
        if is_login_related_text(&title) {
            **login_required = true;
            return 0;
        }
        let children = collect_children(hwnd);
        for (ct, cc) in children {
            if is_login_related_text(&ct) || is_login_related_text(&cc) {
                **login_required = true;
                return 0;
            }
        }
        TRUE
    }
}

#[cfg(not(windows))]
mod win {
    use super::*;
    pub fn find_wechat_pids() -> Vec<u32> {
        Vec::new()
    }
    pub fn is_pid_alive(_pid: u32) -> bool {
        false
    }
    pub fn find_best_wechat_pid() -> Option<u32> {
        None
    }
    pub fn wait_for_window_components(_pid: u32, _timeout: Duration) -> bool {
        true
    }
    pub fn detect_login_required(_pid: u32) -> bool {
        false
    }
}

fn last_error_msg(api: &KeyApi) -> String {
    if let Some(f) = api.last_error {
        let ptr = unsafe { f() };
        if !ptr.is_null() {
            return unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
        }
    }
    String::new()
}

fn build_init_error(api: &KeyApi) -> String {
    let error = last_error_msg(api);
    if !error.is_empty() {
        if error.contains("0xC0000022")
            || error.contains("ACCESS_DENIED")
            || error.contains("打开目标进程失败")
        {
            return "权限不足：无法访问微信进程。\n\n解决方法：\n1. 右键 Weport → 以管理员身份运行\n2. 关闭可能拦截的安全软件\n3. 确保微信未以管理员权限运行".into();
        }
        return error;
    }
    "密钥 Hook 初始化失败".into()
}

fn poll_db_key(
    api: &KeyApi,
    pid: u32,
    deadline: Instant,
    logs: &mut Vec<String>,
    mut on_status: impl FnMut(String),
) -> PollResult {
    let mut key_buf = vec![0u8; 128];
    let mut status_buf = vec![0u8; 256];
    let mut login_required = false;
    let mut next_process_check = Instant::now();

    while Instant::now() < deadline {
        if Instant::now() >= next_process_check {
            next_process_check = Instant::now() + Duration::from_secs(1);
            if !win::is_pid_alive(pid) && !win::find_wechat_pids().contains(&pid) {
                return PollResult::ProcessEnded { login_required };
            }
        }

        let got =
            unsafe { (api.poll_key)(key_buf.as_mut_ptr() as *mut c_char, key_buf.len() as c_int) };
        if got {
            let key = decode_cbuf(&key_buf);
            if key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit()) {
                on_status("密钥获取成功".into());
                return PollResult::Success(key);
            }
        }

        for _ in 0..5 {
            let mut level: c_int = 0;
            let has = unsafe {
                (api.get_status)(
                    status_buf.as_mut_ptr() as *mut c_char,
                    status_buf.len() as c_int,
                    &mut level,
                )
            };
            if !has {
                break;
            }
            let msg = decode_cbuf(&status_buf);
            if msg.is_empty() {
                continue;
            }
            logs.push(msg.clone());
            if is_login_related_text(&msg) {
                login_required = true;
            }
            let normalized = normalize_status_message(&msg);
            if is_ready_status(&msg) {
                on_status(normalized);
            } else {
                on_status(normalized);
            }
        }

        std::thread::sleep(Duration::from_millis(120));
    }

    PollResult::Timeout { login_required }
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

/// Full WeFlow-compatible auto key extraction.
pub fn extract_db_key(
    dll_path: &Path,
    timeout: Duration,
    mut on_status: impl FnMut(String),
) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        let _ = (dll_path, timeout, &mut on_status);
        return Err("密钥提取仅支持 Windows".into());
    }

    #[cfg(windows)]
    {
        let api = load_key_api(dll_path)?;
        let deadline = Instant::now() + timeout;
        let mut logs: Vec<String> = Vec::new();

        on_status("正在查找微信进程…".into());
        let mut pid = win::find_best_wechat_pid();
        if pid.is_none() {
            on_status("未找到微信，等待启动…".into());
            // wait a bit for user to open WeChat
            let wait_until = Instant::now() + remaining(deadline).min(Duration::from_secs(30));
            while Instant::now() < wait_until {
                pid = win::find_best_wechat_pid();
                if pid.is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }

        let mut pid = pid.ok_or_else(|| {
            "未找到微信进程。请先启动微信（Weixin.exe），然后重试。".to_string()
        })?;

        let mut last_login_required = false;

        while remaining(deadline) > Duration::from_millis(500) {
            on_status(format!("检测到微信 (PID {pid})，正在准备…"));
            on_status("正在检测微信界面组件…".into());
            let component_timeout = remaining(deadline).min(Duration::from_secs(15));
            let _ = win::wait_for_window_components(pid, component_timeout);

            if !win::is_pid_alive(pid) && !win::find_wechat_pids().contains(&pid) {
                on_status("检测到微信已退出，等待重新打开…".into());
                std::thread::sleep(Duration::from_millis(500));
                match wait_for_next_pid(deadline, &mut on_status) {
                    Some(p) => {
                        pid = p;
                        continue;
                    }
                    None => break,
                }
            }

            on_status("正在安装密钥 Hook…".into());
            let ok = unsafe { (api.init_hook)(pid) };
            if !ok {
                if !win::is_pid_alive(pid) {
                    let _ = unsafe { (api.cleanup)() };
                    on_status("微信进程已结束，等待重启…".into());
                    match wait_for_next_pid(deadline, &mut on_status) {
                        Some(p) => {
                            pid = p;
                            continue;
                        }
                        None => break,
                    }
                }
                let err = build_init_error(&api);
                let _ = unsafe { (api.cleanup)() };
                return Err(format_failure(&err, &logs));
            }

            on_status(
                "已准备就绪 — 请现在登录微信，或退出后重新登录（务必关闭微信「自动登录」）".into(),
            );

            let poll = poll_db_key(&api, pid, deadline, &mut logs, |m| on_status(m));
            let _ = unsafe { (api.cleanup)() };

            match poll {
                PollResult::Success(key) => {
                    on_status("密钥获取成功".into());
                    return Ok(key);
                }
                PollResult::ProcessEnded { login_required } => {
                    last_login_required = login_required;
                    on_status("检测到微信已退出，已清理 Hook，等待重新打开微信…".into());
                    std::thread::sleep(Duration::from_millis(500));
                    match wait_for_next_pid(deadline, &mut on_status) {
                        Some(p) => {
                            pid = p;
                            continue;
                        }
                        None => break,
                    }
                }
                PollResult::Timeout { login_required } => {
                    last_login_required = login_required;
                    break;
                }
            }
        }

        let login_required =
            last_login_required || win::detect_login_required(pid) || logs.iter().any(|l| is_login_related_text(l));

        if login_required {
            return Err(format_failure(
                "微信已启动但尚未完成登录，或密钥捕获需要重新登录。\n\n请：\n1. 关闭微信「自动登录」\n2. 退出微信账号\n3. 再次点击提取密钥\n4. 看到「已准备就绪」后重新登录微信",
                &logs,
            ));
        }

        Err(format_failure(
            "获取密钥超时。\n\nWeChat 4.x 密钥通常在登录瞬间写入。\n请关闭自动登录 → 退出微信 → 再点提取密钥 → 提示就绪后重新登录。",
            &logs,
        ))
    }
}

fn wait_for_next_pid(deadline: Instant, on_status: &mut impl FnMut(String)) -> Option<u32> {
    while remaining(deadline) > Duration::from_millis(500) {
        on_status("正在查找微信进程…".into());
        if let Some(p) = win::find_best_wechat_pid() {
            return Some(p);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    None
}

fn format_failure(base: &str, logs: &[String]) -> String {
    let is_internal = |line: &str| {
        let lower = line.to_lowercase();
        lower.contains("xkey_helper")
            || lower.contains("[debug]")
            || lower.contains("breakpoint")
            || lower.contains("hook installed @")
            || lower.contains("scanner ")
    };
    let tail: Vec<String> = logs
        .iter()
        .rev()
        .filter(|l| !l.trim().is_empty() && !is_internal(l))
        .take(6)
        .map(|l| {
            let t = l.trim();
            if t.chars().count() > 80 {
                format!("{}…", t.chars().take(80).collect::<String>())
            } else {
                t.to_string()
            }
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if tail.is_empty() {
        base.to_string()
    } else {
        format!("{base}\n\n最近状态：{}", tail.join(" | "))
    }
}
