//! Windows startup-at-login via the HKCU Run key (no admin required).
use std::path::PathBuf;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "Weport";

#[cfg(windows)]
pub fn is_run_at_startup() -> bool {
    use windows_sys::Win32::System::Registry::*;
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            to_wide(RUN_KEY).as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut hkey,
        ) != 0
        {
            return false;
        }
        let mut size: u32 = 0;
        let status = RegQueryValueExW(
            hkey,
            to_wide(VALUE_NAME).as_ptr(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        );
        RegCloseKey(hkey);
        status == 0 && size > 0
    }
}

#[cfg(windows)]
pub fn set_run_at_startup(enabled: bool) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::*;
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegCreateKeyExW(
            HKEY_CURRENT_USER,
            to_wide(RUN_KEY).as_ptr(),
            0,
            std::ptr::null(),
            0,
            KEY_SET_VALUE | KEY_QUERY_VALUE,
            std::ptr::null(),
            &mut hkey,
            std::ptr::null_mut(),
        ) != 0
        {
            return Err("无法打开注册表 Run 项".into());
        }
        let result = if enabled {
            let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("weport.exe"));
            // Quote the path so the shell launches it correctly.
            let cmd = format!("\"{}\"", exe.display());
            let wide = to_wide(&cmd);
            RegSetValueExW(
                hkey,
                to_wide(VALUE_NAME).as_ptr(),
                0,
                REG_SZ,
                wide.as_ptr() as *const u8,
                (wide.len() * 2) as u32,
            )
        } else {
            RegDeleteValueW(hkey, to_wide(VALUE_NAME).as_ptr())
        };
        RegCloseKey(hkey);
        if result == 0 {
            Ok(())
        } else {
            Err("写入注册表 Run 项失败".into())
        }
    }
}

#[cfg(not(windows))]
pub fn is_run_at_startup() -> bool {
    false
}

#[cfg(not(windows))]
pub fn set_run_at_startup(_enabled: bool) -> Result<(), String> {
    Err("仅 Windows 支持开机自启动".into())
}

#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
