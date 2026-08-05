//! Windows startup-at-login via the HKCU Run key (no admin required).
use std::path::PathBuf;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "Weport";

#[cfg(windows)]
pub fn is_run_at_startup() -> bool {
    is_run_at_startup_ex(false)
}

/// Validate both the executable path and the login visibility argument. A
/// registry value can exist while still pointing at an old install, which was
/// the reason previous updates left startup behavior stale.
#[cfg(windows)]
pub fn is_run_at_startup_ex(background: bool) -> bool {
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
        let mut ty: u32 = 0;
        let mut data = vec![0u8; 2048];
        let status = RegQueryValueExW(
            hkey,
            to_wide(VALUE_NAME).as_ptr(),
            std::ptr::null(),
            &mut ty,
            data.as_mut_ptr(),
            &mut size,
        );
        RegCloseKey(hkey);
        if status != 0 || size < 2 || ty != REG_SZ {
            return false;
        }
        let units = size as usize / 2;
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(
            data.as_ptr() as *const u16,
            units,
        ))
        .trim_end_matches('\0')
        .trim()
        .to_string();
        let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("weport.exe"));
        let expected = if background {
            format!("\"{}\" --background", exe.display())
        } else {
            format!("\"{}\"", exe.display())
        };
        value.eq_ignore_ascii_case(&expected)
    }
}

#[cfg(windows)]
pub fn set_run_at_startup(enabled: bool) -> Result<(), String> {
    set_run_at_startup_ex(enabled, false)
}

/// `background`: append `--background` so login auto-start opens tray-only.
#[cfg(windows)]
pub fn set_run_at_startup_ex(enabled: bool, background: bool) -> Result<(), String> {
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
            let cmd = if background {
                format!("\"{}\" --background", exe.display())
            } else {
                format!("\"{}\"", exe.display())
            };
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
pub fn is_run_at_startup_ex(_background: bool) -> bool {
    false
}

#[cfg(not(windows))]
pub fn set_run_at_startup(_enabled: bool) -> Result<(), String> {
    Err("仅 Windows 支持开机自启动".into())
}

#[cfg(not(windows))]
pub fn set_run_at_startup_ex(_enabled: bool, _background: bool) -> Result<(), String> {
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
