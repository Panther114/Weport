//! Reliable Windows main-window show/hide for tray mode.
//!
//! egui/winit `ViewportCommand::Visible` alone is not enough on Windows:
//! after `Visible(false)`, tray restore often does nothing without a native
//! `ShowWindow` + `SetForegroundWindow` (with the usual thread-attach dance).

#![cfg(windows)]

use std::sync::atomic::{AtomicIsize, Ordering};

/// Cached main window HWND (set from the GUI thread when available).
static MAIN_HWND: AtomicIsize = AtomicIsize::new(0);

pub fn set_main_hwnd(hwnd: isize) {
    if hwnd != 0 {
        MAIN_HWND.store(hwnd, Ordering::SeqCst);
    }
}

pub fn main_hwnd() -> isize {
    let h = MAIN_HWND.load(Ordering::SeqCst);
    if h != 0 {
        return h;
    }
    find_weport_hwnd().unwrap_or(0)
}

fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Find a top-level window whose title starts with "Weport".
pub fn find_weport_hwnd() -> Option<isize> {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, IsWindow, IsWindowVisible,
    };

    struct State {
        found: HWND,
    }
    let mut state = State {
        found: std::ptr::null_mut(),
    };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam as *mut State);
        if hwnd.is_null() {
            return TRUE;
        }
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if n <= 0 {
            return TRUE;
        }
        let title = String::from_utf16_lossy(&buf[..n as usize]);
        // Main window title is "Weport vX.Y.Z"; toast is "Weport 消息".
        if title.starts_with("Weport v") || title == "Weport" {
            // Prefer a real frame window; skip tool windows if needed later.
            state.found = hwnd;
            return 0; // stop
        }
        let _ = IsWindowVisible(hwnd);
        TRUE
    }

    unsafe {
        let _ = EnumWindows(Some(enum_proc), &mut state as *mut State as LPARAM);
        if !state.found.is_null() && IsWindow(state.found) != 0 {
            let h = state.found as isize;
            MAIN_HWND.store(h, Ordering::SeqCst);
            return Some(h);
        }
    }
    None
}

/// Force the main Weport window visible, restored, and focused.
pub fn force_show() {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::Threading::{
        AttachThreadInput, GetCurrentThreadId,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    let hwnd = main_hwnd();
    if hwnd == 0 {
        let _ = find_weport_hwnd();
    }
    let hwnd = main_hwnd();
    if hwnd == 0 {
        return;
    }
    let hwnd = hwnd as HWND;

    unsafe {
        // If minimized or hidden, restore first.
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        } else {
            ShowWindow(hwnd, SW_SHOW);
        }
        ShowWindow(hwnd, SW_SHOWNORMAL);

        // Classic "steal focus" pattern used by tray apps.
        let fg = GetForegroundWindow();
        let fg_tid = if !fg.is_null() {
            GetWindowThreadProcessId(fg, std::ptr::null_mut())
        } else {
            0
        };
        let cur_tid = GetCurrentThreadId();
        if fg_tid != 0 && fg_tid != cur_tid {
            let _ = AttachThreadInput(cur_tid, fg_tid, 1);
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            let _ = AttachThreadInput(cur_tid, fg_tid, 0);
        } else {
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
        }
        // Flash once if still not foreground (user attention).
        if GetForegroundWindow() != hwnd {
            let mut fi: FLASHWINFO = std::mem::zeroed();
            fi.cbSize = std::mem::size_of::<FLASHWINFO>() as u32;
            fi.hwnd = hwnd;
            fi.dwFlags = FLASHW_TRAY | FLASHW_TIMERNOFG;
            fi.uCount = 3;
            fi.dwTimeout = 0;
            let _ = FlashWindowEx(&fi);
        }
    }
}

/// Hide the main window for tray mode (native hide — reliable with Show later).
pub fn force_hide() {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindow, ShowWindow, SW_HIDE};

    let hwnd = main_hwnd();
    if hwnd == 0 {
        let _ = find_weport_hwnd();
    }
    let hwnd = main_hwnd();
    if hwnd == 0 {
        return;
    }
    unsafe {
        let h = hwnd as HWND;
        if IsWindow(h) != 0 {
            ShowWindow(h, SW_HIDE);
        }
    }
}

/// Capture HWND for a title we just set (call after first frame).
pub fn cache_from_title_prefix(_prefix: &str) {
    let _ = find_weport_hwnd();
}

/// Allow other processes (second instance) to request "show main".
/// Uses a named event the GUI polls each frame.
const SHOW_EVENT_NAME: &str = "Local\\WeportShowMainWindow";

pub fn create_show_event() -> Option<*mut core::ffi::c_void> {
    use windows_sys::Win32::System::Threading::CreateEventW;
    unsafe {
        let name = to_wide(SHOW_EVENT_NAME);
        let h = CreateEventW(std::ptr::null(), 0, 0, name.as_ptr());
        if h.is_null() {
            None
        } else {
            Some(h)
        }
    }
}

pub fn signal_show_event() {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenEventW, SetEvent, EVENT_MODIFY_STATE};
    unsafe {
        let name = to_wide(SHOW_EVENT_NAME);
        let h = OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr());
        if !h.is_null() {
            let _ = SetEvent(h);
            CloseHandle(h);
        }
    }
}

pub fn poll_show_event(handle: *mut core::ffi::c_void) -> bool {
    use windows_sys::Win32::System::Threading::WaitForSingleObject;
    if handle.is_null() {
        return false;
    }
    // WAIT_OBJECT_0 == 0
    unsafe { WaitForSingleObject(handle, 0) == 0 }
}
