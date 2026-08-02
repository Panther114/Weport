//! FFI bindings for wcdb_api.dll (WeChat 4.x encrypted DB access).
use crate::paths::{find_session_db, resolve_wcdb_dir};
use libloading::{Library, Symbol};
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
    init_protection: FnInitProtection,
    init: FnInit,
    shutdown: FnShutdown,
    open_account: FnOpenAccount,
    close_account: FnCloseAccount,
    set_my_wxid: Option<FnSetMyWxid>,
    get_sessions: FnGetSessions,
    get_messages: FnGetMessages,
    get_message_count: Option<FnGetMessageCount>,
    get_contact: FnGetContact,
    get_display_names: Option<FnGetDisplayNames>,
    free_string: FnFreeString,
}

pub struct WcdbHandle {
    api: WcdbApi,
    handle: i64,
}

// WCDB is used sequentially from async tasks via spawn_blocking; protect with mutex at call site.
unsafe impl Send for WcdbHandle {}

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

fn preload_deps(dir: &Path) {
    for name in ["SDL2.dll", "WCDB.dll"] {
        let p = dir.join(name);
        if p.exists() {
            let _ = unsafe { Library::new(&p) };
        }
    }
}

impl WcdbApi {
    fn load(resource_root: &Path) -> Result<Self, String> {
        let dll_dir = resolve_wcdb_dir(resource_root);
        let dll_path = dll_dir.join("wcdb_api.dll");
        if !dll_path.exists() {
            return Err(format!("未找到 wcdb_api.dll: {}", dll_path.display()));
        }

        // Ensure DLL directory is on the search path so WCDB.dll resolves
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let wide: Vec<u16> = dll_dir
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            unsafe {
                windows_sys::Win32::System::LibraryLoader::SetDllDirectoryW(wide.as_ptr());
            }
        }

        preload_deps(&dll_dir);

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
        let get_message_count =
            try_load_optional::<FnGetMessageCount>(&lib, b"wcdb_get_message_count\0");
        let get_display_names =
            try_load_optional::<FnGetDisplayNames>(&lib, b"wcdb_get_display_names\0");

        // InitProtection — try several resource roots
        let try_paths: Vec<PathBuf> = [
            dll_dir.clone(),
            dll_dir.parent().unwrap_or(&dll_dir).to_path_buf(),
            resource_root.to_path_buf(),
            resource_root.join("native"),
            resource_root.join("wcdb").join("win32").join("x64"),
        ]
        .into_iter()
        .collect();

        let mut protection_ok = false;
        let mut last_code = -1;
        for p in &try_paths {
            let c = CString::new(p.to_string_lossy().as_bytes()).unwrap_or_default();
            let code = unsafe { init_protection(c.as_ptr()) };
            last_code = code;
            if code == 0 {
                protection_ok = true;
                break;
            }
        }
        if !protection_ok {
            return Err(format!(
                "数据服务保护初始化失败 (code {last_code})。请确认 native 资源完整。"
            ));
        }

        let init_code = unsafe { init() };
        if init_code != 0 {
            return Err(format!("wcdb_init 失败: {init_code}"));
        }

        Ok(Self {
            _lib: lib,
            init_protection,
            init,
            shutdown,
            open_account,
            close_account,
            set_my_wxid,
            get_sessions,
            get_messages,
            get_message_count,
            get_contact,
            get_display_names,
            free_string,
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

impl WcdbHandle {
    pub fn open(
        resource_root: &Path,
        account_dir: &Path,
        hex_key: &str,
        wxid: &str,
    ) -> Result<Self, String> {
        let api = WcdbApi::load(resource_root)?;
        let session_db = find_session_db(account_dir)
            .ok_or_else(|| format!("未找到 session.db: {}", account_dir.display()))?;

        let path_c = CString::new(session_db.to_string_lossy().as_bytes())
            .map_err(|_| "路径含非法字符".to_string())?;
        let key_c = CString::new(hex_key).map_err(|_| "密钥含非法字符".to_string())?;

        let mut handle: i64 = 0;
        let code = unsafe { (api.open_account)(path_c.as_ptr(), key_c.as_ptr(), &mut handle) };
        if code != 0 || handle <= 0 {
            let _ = unsafe { (api.shutdown)() };
            return Err(format!(
                "打开数据库失败 (code {code})。请检查密钥与账号目录是否匹配。"
            ));
        }

        if let Some(set_wxid) = api.set_my_wxid {
            if !wxid.is_empty() {
                if let Ok(w) = CString::new(wxid) {
                    let _ = unsafe { set_wxid(handle, w.as_ptr()) };
                }
            }
        }

        Ok(Self { api, handle })
    }

    pub fn sessions(&self) -> Result<Vec<Value>, String> {
        let mut out: *mut c_char = std::ptr::null_mut();
        let code = unsafe { (self.api.get_sessions)(self.handle, &mut out) };
        if code != 0 {
            self.api.free_c_string(out);
            return Err(format!("获取会话失败: {code}"));
        }
        let value = self.api.take_json(out)?;
        match value {
            Value::Array(arr) => Ok(arr),
            other => Ok(vec![other]),
        }
    }

    pub fn message_count(&self, session_id: &str) -> Result<i32, String> {
        let Some(f) = self.api.get_message_count else {
            return Ok(-1);
        };
        let sid = CString::new(session_id).map_err(|_| "session id 非法".to_string())?;
        let mut count: c_int = 0;
        let code = unsafe { f(self.handle, sid.as_ptr(), &mut count) };
        if code != 0 {
            return Err(format!("获取消息数失败: {code}"));
        }
        Ok(count)
    }

    pub fn messages(&self, session_id: &str, limit: i32, offset: i32) -> Result<Vec<Value>, String> {
        let sid = CString::new(session_id).map_err(|_| "session id 非法".to_string())?;
        let mut out: *mut c_char = std::ptr::null_mut();
        let code =
            unsafe { (self.api.get_messages)(self.handle, sid.as_ptr(), limit, offset, &mut out) };
        if code != 0 {
            self.api.free_c_string(out);
            return Err(format!("获取消息失败: {code}"));
        }
        let value = self.api.take_json(out)?;
        match value {
            Value::Array(arr) => Ok(arr),
            Value::Object(map) => {
                // some builds wrap as { messages: [...] } or { rows: [...] }
                if let Some(Value::Array(arr)) = map.get("messages").or_else(|| map.get("rows")) {
                    Ok(arr.clone())
                } else {
                    Ok(vec![Value::Object(map)])
                }
            }
            other => Ok(vec![other]),
        }
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
            if n < page {
                break;
            }
            // safety cap
            if offset > 5_000_000 {
                break;
            }
        }
        Ok(all)
    }

    pub fn contact(&self, username: &str) -> Result<Value, String> {
        let u = CString::new(username).map_err(|_| "username 非法".to_string())?;
        let mut out: *mut c_char = std::ptr::null_mut();
        let code = unsafe { (self.api.get_contact)(self.handle, u.as_ptr(), &mut out) };
        if code != 0 {
            self.api.free_c_string(out);
            return Err(format!("获取联系人失败: {code}"));
        }
        self.api.take_json(out)
    }

    pub fn display_names(&self, usernames: &[String]) -> Result<Value, String> {
        let Some(f) = self.api.get_display_names else {
            return Ok(Value::Object(serde_json::Map::new()));
        };
        let json = serde_json::to_string(usernames).unwrap_or_else(|_| "[]".into());
        let c = CString::new(json).map_err(|_| "usernames json 非法".to_string())?;
        let mut out: *mut c_char = std::ptr::null_mut();
        let code = unsafe { f(self.handle, c.as_ptr(), &mut out) };
        if code != 0 {
            self.api.free_c_string(out);
            return Err(format!("获取显示名失败: {code}"));
        }
        self.api.take_json(out)
    }
}

impl Drop for WcdbHandle {
    fn drop(&mut self) {
        if self.handle > 0 {
            let _ = unsafe { (self.api.close_account)(self.handle) };
            self.handle = 0;
        }
        let _ = unsafe { (self.api.shutdown)() };
    }
}

/// Process-wide lock so only one WCDB session is open (DLL is not multi-instance safe).
pub static WCDB_LOCK: Mutex<()> = Mutex::new(());
