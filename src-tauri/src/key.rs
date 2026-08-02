//! wx_key.dll — extract WeChat 4.x database decrypt key from a running client.
use libloading::{Library, Symbol};
use std::ffi::{CStr, CString};
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

fn load_key_api(dll_path: &Path) -> Result<KeyApi, String> {
    if !dll_path.exists() {
        return Err(format!("未找到 wx_key.dll: {}", dll_path.display()));
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

#[cfg(windows)]
fn find_wechat_pids() -> Vec<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut pids = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return pids;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let name = String::from_utf16_lossy(
                    &entry.szExeFile[..entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len())],
                )
                .to_lowercase();
                if name == "weixin.exe" || name == "wechat.exe" {
                    pids.push(entry.th32ProcessID);
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    pids
}

#[cfg(not(windows))]
fn find_wechat_pids() -> Vec<u32> {
    Vec::new()
}

fn decode_cbuf(buf: &[u8]) -> String {
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).trim().to_string()
}

pub fn extract_db_key(
    dll_path: &Path,
    timeout: Duration,
    mut on_status: impl FnMut(String),
) -> Result<String, String> {
    let api = load_key_api(dll_path)?;
    on_status("正在查找微信进程…".into());
    let pids = find_wechat_pids();
    let pid = *pids
        .first()
        .ok_or_else(|| "未找到微信进程，请先启动并登录微信".to_string())?;

    on_status(format!("检测到微信 PID {pid}，正在提取密钥…"));
    let ok = unsafe { (api.init_hook)(pid) };
    if !ok {
        let err = if let Some(f) = api.last_error {
            let ptr = unsafe { f() };
            if ptr.is_null() {
                String::new()
            } else {
                unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
            }
        } else {
            String::new()
        };
        let _ = unsafe { (api.cleanup)() };
        if err.is_empty() {
            return Err("密钥 Hook 初始化失败（可尝试以管理员身份运行）".into());
        }
        return Err(err);
    }

    let deadline = Instant::now() + timeout;
    let mut key_buf = vec![0u8; 128];
    let mut status_buf = vec![0u8; 256];

    while Instant::now() < deadline {
        let got = unsafe {
            (api.poll_key)(key_buf.as_mut_ptr() as *mut c_char, key_buf.len() as c_int)
        };
        if got {
            let key = decode_cbuf(&key_buf);
            if key.len() == 64 {
                let _ = unsafe { (api.cleanup)() };
                on_status("密钥获取成功".into());
                return Ok(key);
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
            if !msg.is_empty() {
                on_status(msg);
            }
        }

        std::thread::sleep(Duration::from_millis(120));
    }

    let _ = unsafe { (api.cleanup)() };
    Err("获取密钥超时。请确认微信已登录，必要时以管理员身份重试。".into())
}

// silence unused import when not using CString elsewhere
#[allow(dead_code)]
fn _keep_cstring() {
    let _ = CString::new("x");
}
