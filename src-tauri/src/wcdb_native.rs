//! In-process FFI for wcdb_api.dll — must run inside a host named WeFlow.exe.
//! (DLL returns -1006 from wcdb_init otherwise: "expired: self-destruct" security check.)
use crate::paths::{find_session_db, resolve_wcdb_dir};
use libloading::{Library, Symbol};
use once_cell::sync::OnceCell;
use serde_json::Value;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

type FnInitProtection = unsafe extern "C" fn(*const c_char) -> c_int;
type FnInit = unsafe extern "C" fn() -> c_int;
type FnShutdown = unsafe extern "C" fn() -> c_int;
type FnOpenAccount = unsafe extern "C" fn(*const c_char, *const c_char, *mut i64) -> c_int;
type FnCloseAccount = unsafe extern "C" fn(i64) -> c_int;
type FnSetMyWxid = unsafe extern "C" fn(i64, *const c_char) -> c_int;
type FnGetSessions = unsafe extern "C" fn(i64, *mut *mut c_char) -> c_int;
type FnGetMessages = unsafe extern "C" fn(i64, *const c_char, c_int, c_int, *mut *mut c_char) -> c_int;
type FnGetMessageCount = unsafe extern "C" fn(i64, *const c_char, *mut c_int) -> c_int;
type FnGetContact = unsafe extern "C" fn(i64, *const c_char, *mut *mut c_char) -> c_int;
type FnGetDisplayNames = unsafe extern "C" fn(i64, *const c_char, *mut *mut c_char) -> c_int;
type FnFreeString = unsafe extern "C" fn(*mut c_char);

struct WcdbApi {
    _lib: Library,
    _deps: Vec<Library>,
    init: FnInit,
    shutdown: FnShutdown,
    open_account: FnOpenAccount,
    close_account: FnCloseAccount,
    set_my_wxid: Option<FnSetMyWxid>,
    get_sessions: FnGetSessions,
    get_messages: FnGetMessages,
    get_contact: FnGetContact,
    get_display_names: Option<FnGetDisplayNames>,
    free_string: FnFreeString,
    dll_dir: PathBuf,
}

/// Process-wide engine (WeFlow initializes once).
struct Engine {
    api: WcdbApi,
    handle: Option<i64>,
}

static ENGINE: OnceCell<Mutex<Option<Engine>>> = OnceCell::new();

/// Global lock for export/connect (public for CLI).
static _WCDB_LOCK_UNUSED: Mutex<()> = Mutex::new(());

fn load_symbol<T>(lib: &Library, name: &[u8]) -> Result<T, String>
where
    T: Copy,
{
    unsafe {
        let sym: Symbol<T> = lib
            .get(name)
            .map_err(|e| format!("symbol {} missing: {e}", String::from_utf8_lossy(name)))?;
        Ok(*sym)
    }
}

fn try_load_optional<T>(lib: &Library, name: &[u8]) -> Option<T>
where
    T: Copy,
{
    unsafe {
        let sym: Symbol<T> = lib.get(name).ok()?;
        Some(*sym)
    }
}

fn set_dll_search_dir(dir: &Path) {
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
            // Also add to process default search path
            let _ = windows_sys::Win32::System::LibraryLoader::AddDllDirectory(wide.as_ptr());
        }
        // Working directory relative lookups (some native code uses cwd)
        let _ = std::env::set_current_dir(dir);
    }
}

fn path_to_cstring(path: &Path) -> Result<CString, String> {
    // Prefer lossy UTF-8; on Chinese Windows long paths are still usually valid UTF-8 for NTFS
    let s = path.to_string_lossy();
    CString::new(s.as_bytes()).map_err(|_| format!("路径含非法字符: {}", path.display()))
}

fn explain_code(code: i32) -> String {
    match code {
        -1006 | -101 | -102 => format!(
            "数据服务安全初始化失败 (错误码 {code})。通常是 WCDB 原生库路径不正确或依赖 DLL 未找到。\n\
             请重新安装 Weport，或以管理员身份运行。若仍失败，确认安装目录下存在 resources/wcdb/win32/x64/wcdb_api.dll 与 WCDB.dll。"
        ),
        -2301 => "动态库加载失败，请检查安装是否完整".into(),
        -2302 | -2303 => format!("WCDB 初始化异常 (错误码 {code})"),
        -3001 => "未找到数据库目录 (db_storage)".into(),
        -3002 => "未找到 session.db".into(),
        c if (-2212..=-2201).contains(&c) => {
            format!("数据服务完整性校验失败 (错误码 {c})")
        }
        other => format!("操作失败，错误码: {other}"),
    }
}

impl WcdbApi {
    fn bootstrap(resource_root: &Path) -> Result<Self, String> {
        let dll_dir = resolve_wcdb_dir(resource_root);
        let dll_path = dll_dir.join("wcdb_api.dll");
        if !dll_path.exists() {
            return Err(format!(
                "未找到 wcdb_api.dll。\n已搜索资源根: {}\n期望: {}",
                resource_root.display(),
                dll_path.display()
            ));
        }

        set_dll_search_dir(&dll_dir);

        // Preload deps with absolute paths (keeps handles alive)
        let mut deps = Vec::new();
        for name in ["msvcp140.dll", "vcruntime140.dll", "SDL2.dll", "WCDB.dll"] {
            let p = dll_dir.join(name);
            if p.exists() {
                if let Ok(lib) = unsafe { Library::new(&p) } {
                    deps.push(lib);
                }
            }
        }

        let lib = unsafe {
            Library::new(&dll_path).map_err(|e| format!("加载 wcdb_api.dll 失败: {e}"))?
        };

        let init_protection: FnInitProtection = load_symbol(&lib, b"InitProtection\0")?;
        let init: FnInit = load_symbol(&lib, b"wcdb_init\0")?;
        let shutdown: FnShutdown = load_symbol(&lib, b"wcdb_shutdown\0")?;
        let open_account: FnOpenAccount = load_symbol(&lib, b"wcdb_open_account\0")?;
        let close_account: FnCloseAccount = load_symbol(&lib, b"wcdb_close_account\0")?;
        let get_sessions: FnGetSessions = load_symbol(&lib, b"wcdb_get_sessions\0")?;
        let get_messages: FnGetMessages = load_symbol(&lib, b"wcdb_get_messages\0")?;
        let get_contact: FnGetContact = load_symbol(&lib, b"wcdb_get_contact\0")?;
        let free_string: FnFreeString = load_symbol(&lib, b"wcdb_free_string\0")?;
        let set_my_wxid = try_load_optional::<FnSetMyWxid>(&lib, b"wcdb_set_my_wxid\0");
        let get_display_names =
            try_load_optional::<FnGetDisplayNames>(&lib, b"wcdb_get_display_names\0");

        // InitProtection path candidates — prefer directory that contains the DLL (WeFlow order)
        let mut try_paths: Vec<PathBuf> = vec![
            dll_dir.clone(),
            dll_dir.parent().unwrap_or(&dll_dir).to_path_buf(), // win32
            dll_dir
                .parent()
                .and_then(|p| p.parent())
                .unwrap_or(&dll_dir)
                .to_path_buf(), // wcdb
            resource_root.to_path_buf(),
            resource_root.join("resources"),
            resource_root.join("wcdb").join("win32").join("x64"),
            resource_root.join("native").join("win32").join("x64"),
        ];
        // de-dup
        try_paths.sort();
        try_paths.dedup();
        // Put dll_dir first again after sort
        try_paths.retain(|p| p != &dll_dir);
        try_paths.insert(0, dll_dir.clone());

        let mut protection_ok = false;
        let mut last_code = -1i32;
        let mut codes: Vec<String> = Vec::new();
        for p in &try_paths {
            if !p.exists() {
                continue;
            }
            let cpath = match path_to_cstring(p) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let code = unsafe { init_protection(cpath.as_ptr()) };
            codes.push(format!("{} => {code}", p.display()));
            last_code = code;
            if code == 0 {
                protection_ok = true;
                break;
            }
        }
        if !protection_ok {
            return Err(format!(
                "{}\n\nInitProtection 尝试:\n{}",
                explain_code(last_code),
                codes.join("\n")
            ));
        }

        // Do NOT call shutdown() before first init — keep state clean.
        let init_code = unsafe { init() };
        if init_code != 0 {
            let exe = std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "?".into());
            return Err(format!(
                "{}\n\n(wcdb_init 返回 {init_code})\n宿主进程: {exe}\nDLL 目录: {}\nInitProtection:\n{}\n\n\
                 若错误码为 -1006：wcdb_api.dll 要求进程名为 WeFlow.exe（Weport 应通过 WeFlow.exe 宿主加载）。",
                explain_code(init_code),
                dll_dir.display(),
                codes.join("\n")
            ));
        }

        Ok(Self {
            _lib: lib,
            _deps: deps,
            init,
            shutdown,
            open_account,
            close_account,
            set_my_wxid,
            get_sessions,
            get_messages,
            get_contact,
            get_display_names,
            free_string,
            dll_dir,
        })
    }

    fn free_c_string(&self, ptr: *mut c_char) {
        if !ptr.is_null() {
            unsafe { (self.free_string)(ptr) }
        }
    }

    fn take_json(&self, ptr: *mut c_char) -> Result<Value, String> {
        if ptr.is_null() {
            return Err("空指针".into());
        }
        let s = unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned();
        self.free_c_string(ptr);
        serde_json::from_str(&s).map_err(|e| format!("JSON 解析失败: {e}"))
    }
}

fn engine_slot() -> &'static Mutex<Option<Engine>> {
    ENGINE.get_or_init(|| Mutex::new(None))
}

fn ensure_engine(resource_root: &Path) -> Result<(), String> {
    let mut guard = engine_slot()
        .lock()
        .map_err(|_| "WCDB 引擎锁失败".to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let api = WcdbApi::bootstrap(resource_root)?;
    *guard = Some(Engine { api, handle: None });
    Ok(())
}

pub struct NativeEngine {
    // RAII close account only — keep process-wide API alive
}

// marker for Send
unsafe impl Send for NativeEngine {}

impl NativeEngine {
    pub fn open(
        resource_root: &Path,
        account_dir: &Path,
        hex_key: &str,
        wxid: &str,
    ) -> Result<Self, String> {
        ensure_engine(resource_root)?;
        let mut guard = engine_slot()
            .lock()
            .map_err(|_| "WCDB 引擎锁失败".to_string())?;
        let eng = guard.as_mut().ok_or_else(|| "WCDB 未初始化".to_string())?;

        // close previous account if any
        if let Some(h) = eng.handle.take() {
            let _ = unsafe { (eng.api.close_account)(h) };
        }

        set_dll_search_dir(&eng.api.dll_dir);

        let session_db = find_session_db(account_dir)
            .ok_or_else(|| format!("未找到 session.db: {}", account_dir.display()))?;

        let path_c = path_to_cstring(&session_db)?;
        let key_c = CString::new(hex_key).map_err(|_| "密钥含非法字符".to_string())?;

        let mut handle: i64 = 0;
        let code =
            unsafe { (eng.api.open_account)(path_c.as_ptr(), key_c.as_ptr(), &mut handle) };
        if code != 0 || handle <= 0 {
            return Err(format!(
                "{} (open_account={code})\nsession.db: {}",
                explain_code(code),
                session_db.display()
            ));
        }

        if let Some(set_wxid) = eng.api.set_my_wxid {
            if !wxid.is_empty() {
                if let Ok(w) = CString::new(wxid) {
                    let _ = unsafe { set_wxid(handle, w.as_ptr()) };
                }
            }
        }

        eng.handle = Some(handle);
        Ok(Self {})
    }

    fn with_api_handle<R>(&self, f: impl FnOnce(&WcdbApi, i64) -> Result<R, String>) -> Result<R, String> {
        let guard = engine_slot()
            .lock()
            .map_err(|_| "WCDB 引擎锁失败".to_string())?;
        let eng = guard.as_ref().ok_or_else(|| "WCDB 未初始化".to_string())?;
        let handle = eng.handle.ok_or_else(|| "数据库未打开".to_string())?;
        f(&eng.api, handle)
    }

    pub fn sessions(&self) -> Result<Vec<Value>, String> {
        self.with_api_handle(|api, handle| {
            let mut out: *mut c_char = std::ptr::null_mut();
            let code = unsafe { (api.get_sessions)(handle, &mut out) };
            if code != 0 {
                api.free_c_string(out);
                return Err(format!("获取会话失败: {code}"));
            }
            let value = api.take_json(out)?;
            match value {
                Value::Array(arr) => Ok(arr),
                other => Ok(vec![other]),
            }
        })
    }

    pub fn messages(&self, session_id: &str, limit: i32, offset: i32) -> Result<Vec<Value>, String> {
        self.with_api_handle(|api, handle| {
            let sid = CString::new(session_id).map_err(|_| "session id 非法".to_string())?;
            let mut out: *mut c_char = std::ptr::null_mut();
            let code =
                unsafe { (api.get_messages)(handle, sid.as_ptr(), limit, offset, &mut out) };
            if code != 0 {
                api.free_c_string(out);
                return Err(format!("获取消息失败: {code}"));
            }
            let value = api.take_json(out)?;
            match value {
                Value::Array(arr) => Ok(arr),
                Value::Object(map) => {
                    if let Some(Value::Array(arr)) = map.get("messages").or_else(|| map.get("rows"))
                    {
                        Ok(arr.clone())
                    } else {
                        Ok(vec![Value::Object(map)])
                    }
                }
                other => Ok(vec![other]),
            }
        })
    }

    pub fn all_messages(&self, session_id: &str) -> Result<Vec<Value>, String> {
        let mut all = Vec::new();
        let mut offset = 0i32;
        let page = 500i32;
        loop {
            let batch = self.messages(session_id, page, offset)?;
            if batch.is_empty() {
                break;
            }
            let n = batch.len() as i32;
            all.extend(batch);
            offset += n;
            if n < page || offset > 5_000_000 {
                break;
            }
        }
        Ok(all)
    }

    pub fn contact(&self, username: &str) -> Result<Value, String> {
        self.with_api_handle(|api, handle| {
            let u = CString::new(username).map_err(|_| "username 非法".to_string())?;
            let mut out: *mut c_char = std::ptr::null_mut();
            let code = unsafe { (api.get_contact)(handle, u.as_ptr(), &mut out) };
            if code != 0 {
                api.free_c_string(out);
                return Err(format!("获取联系人失败: {code}"));
            }
            api.take_json(out)
        })
    }

    /// Batch display names via wcdb_get_display_names, with per-contact fallback.
    pub fn display_names(
        &self,
        usernames: &[String],
    ) -> Result<std::collections::HashMap<String, String>, String> {
        if usernames.is_empty() {
            return Ok(std::collections::HashMap::new());
        }

        // Try native batch API first
        let batch = self.with_api_handle(|api, handle| {
            let Some(get_dn) = api.get_display_names else {
                return Ok(None);
            };
            let payload = serde_json::to_string(usernames).map_err(|e| e.to_string())?;
            let c = CString::new(payload).map_err(|_| "usernames 非法".to_string())?;
            let mut out: *mut c_char = std::ptr::null_mut();
            let code = unsafe { get_dn(handle, c.as_ptr(), &mut out) };
            if code != 0 || out.is_null() {
                api.free_c_string(out);
                return Ok(None);
            }
            let value = api.take_json(out)?;
            Ok(Some(value))
        })?;

        let mut map = std::collections::HashMap::new();
        if let Some(value) = batch {
            parse_display_name_payload(&value, &mut map);
        }

        // Fill missing via contact
        for u in usernames {
            if map.contains_key(u) {
                continue;
            }
            match self.contact(u) {
                Ok(c) => {
                    let name = pick_contact_display(&c, u);
                    map.insert(u.clone(), name);
                }
                Err(_) => {
                    map.insert(u.clone(), u.clone());
                }
            }
        }
        Ok(map)
    }
}

fn pick_contact_display(contact: &Value, fallback: &str) -> String {
    for key in [
        "remark",
        "Remark",
        "nickName",
        "nickname",
        "NickName",
        "nick_name",
        "alias",
        "Alias",
        "displayName",
        "name",
    ] {
        if let Some(v) = contact.get(key).and_then(|x| x.as_str()) {
            let t = v.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    fallback.to_string()
}

fn parse_display_name_payload(
    value: &Value,
    map: &mut std::collections::HashMap<String, String>,
) {
    match value {
        Value::Object(obj) => {
            // Could be { map: {...} } or direct { wxid: name }
            if let Some(Value::Object(inner)) = obj.get("map") {
                for (k, v) in inner {
                    if let Some(s) = v.as_str() {
                        if !s.trim().is_empty() {
                            map.insert(k.clone(), s.trim().to_string());
                        }
                    }
                }
            } else {
                for (k, v) in obj {
                    if k == "success" || k == "error" {
                        continue;
                    }
                    if let Some(s) = v.as_str() {
                        if !s.trim().is_empty() {
                            map.insert(k.clone(), s.trim().to_string());
                        }
                    } else if let Some(inner) = v.as_object() {
                        // { username: { displayName / nickName } }
                        let name = inner
                            .get("displayName")
                            .or_else(|| inner.get("nickName"))
                            .or_else(|| inner.get("remark"))
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .trim();
                        if !name.is_empty() {
                            map.insert(k.clone(), name.to_string());
                        }
                    }
                }
            }
        }
        Value::Array(arr) => {
            for item in arr {
                if let Some(obj) = item.as_object() {
                    let username = obj
                        .get("username")
                        .or_else(|| obj.get("userName"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .trim();
                    if username.is_empty() {
                        continue;
                    }
                    let name = pick_contact_display(item, username);
                    map.insert(username.to_string(), name);
                }
            }
        }
        _ => {}
    }
}

impl Drop for NativeEngine {
    fn drop(&mut self) {
        if let Ok(mut guard) = engine_slot().lock() {
            if let Some(eng) = guard.as_mut() {
                if let Some(h) = eng.handle.take() {
                    let _ = unsafe { (eng.api.close_account)(h) };
                }
            }
        }
    }
}
