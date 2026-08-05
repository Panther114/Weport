//! Reliable Windows main-window show/hide for tray mode.
//!
//! Critical design: tray Show/Quit must work **without** the egui event loop.
//! When the main window is SW_HIDE'd, winit often stops pumping `App::update`,
//! so channel-only tray handling silently dies. Callers in the tray thread
//! invoke `force_show` / `post_close` directly.
#![cfg(windows)]

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

/// Cached main window HWND (set from the GUI thread when available).
static MAIN_HWND: AtomicIsize = AtomicIsize::new(0);
static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);

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

pub fn request_quit_flag() {
    QUIT_REQUESTED.store(true, Ordering::SeqCst);
}

pub fn take_quit_flag() -> bool {
    QUIT_REQUESTED.swap(false, Ordering::SeqCst)
}

fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Find our main window by **current process id** (most reliable when hidden).
pub fn find_weport_hwnd() -> Option<isize> {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindow, GWL_STYLE, GW_OWNER, WS_VISIBLE,
    };

    struct State {
        pid: u32,
        found: HWND,
        found_any: HWND,
    }

    let mut state = State {
        pid: unsafe { GetCurrentProcessId() },
        found: std::ptr::null_mut(),
        found_any: std::ptr::null_mut(),
    };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam as *mut State);
        if hwnd.is_null() {
            return TRUE;
        }
        let mut wpid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut wpid);
        if wpid != state.pid {
            return TRUE;
        }
        // Skip owned popups (tool windows / toast).
        if !GetWindow(hwnd, GW_OWNER).is_null() {
            return TRUE;
        }
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let title = if n > 0 {
            String::from_utf16_lossy(&buf[..n as usize])
        } else {
            String::new()
        };
        // Prefer titled main frame; accept empty title if it's our only top-level.
        if title.starts_with("Weport v") || title == "Weport" {
            state.found = hwnd;
            return 0;
        }
        if title.starts_with("Weport") && !title.contains("Toast") && !title.contains("消息") {
            if state.found.is_null() {
                state.found = hwnd;
            }
        }
        if state.found_any.is_null() && !title.contains("Toast") {
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            let _ = style & WS_VISIBLE;
            state.found_any = hwnd;
        }
        TRUE
    }

    unsafe {
        let _ = EnumWindows(Some(enum_proc), &mut state as *mut State as LPARAM);
        let pick = if !state.found.is_null() {
            state.found
        } else {
            state.found_any
        };
        if !pick.is_null() && IsWindow(pick) != 0 {
            let h = pick as isize;
            MAIN_HWND.store(h, Ordering::SeqCst);
            return Some(h);
        }
    }
    None
}

/// Force the main Weport window visible, restored, and focused.
/// Safe to call from the tray thread.
pub fn force_show() {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    let _ = find_weport_hwnd();
    let hwnd = main_hwnd();
    if hwnd == 0 {
        return;
    }
    // Restore the taskbar button in case we hid it when minimizing to tray.
    show_in_taskbar();
    let hwnd = hwnd as HWND;

    unsafe {
        // SW_SHOW + restore covers SW_HIDE and minimized cases.
        ShowWindow(hwnd, SW_SHOW);
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        } else {
            ShowWindow(hwnd, SW_SHOWNORMAL);
        }

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
        // Nudge: allow set foreground for this process.
        // ASFW_ANY = (DWORD)-1
        let _ = AllowSetForegroundWindow(0xFFFFFFFFu32);
        let _ = SetForegroundWindow(hwnd);
    }
}

/// Hide the main window for tray mode.
///
/// **DO NOT use SW_HIDE** — winit stops pumping `App::update` when the window
/// is hidden, which kills toast viewport rendering (the v0.6.11/v0.6.12
/// tray-hidden toast bug). Use `Minimized(true)` via egui's ViewportCommand
/// instead, then call `hide_from_taskbar()` to remove the taskbar button.
/// This keeps the winit event loop alive so `update` → `render_toast_viewport`
/// → `show_viewport_immediate` keeps working while tray-hidden.
pub fn force_hide() {
    // Deprecated: only minimizes. The caller should use egui's
    // ViewportCommand::Minimized(true) + hide_from_taskbar() instead.
    // Kept for the tray thread's direct use if needed.
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindow, ShowWindow, SW_HIDE};

    let _ = find_weport_hwnd();
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

/// Remove the main window's taskbar button (used when minimizing to tray).
/// Toggles WS_EX_TOOLWINDOW on (hides from taskbar) / off (shows in taskbar).
pub fn hide_from_taskbar() {
    set_taskbar_button(false);
}

/// Restore the main window's taskbar button (used when restoring from tray).
pub fn show_in_taskbar() {
    set_taskbar_button(true);
}

fn set_taskbar_button(show: bool) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    let _ = find_weport_hwnd();
    let hwnd = main_hwnd();
    if hwnd == 0 {
        return;
    }
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_APPWINDOW: u32 = 0x00040000;
    const WS_EX_TOOLWINDOW: u32 = 0x00000080;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    unsafe {
        let h = hwnd as HWND;
        let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
        let new_ex = if show {
            (ex | WS_EX_APPWINDOW) & !WS_EX_TOOLWINDOW
        } else {
            (ex & !WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW
        };
        SetWindowLongW(h, GWL_EXSTYLE, new_ex as i32);
        // Force the taskbar to pick up the style change.
        SetWindowPos(
            h,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
        );
    }
}

/// Post WM_CLOSE to the main window (tray Quit path).
pub fn post_close_main() {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};

    let _ = find_weport_hwnd();
    let hwnd = main_hwnd();
    if hwnd == 0 {
        return;
    }
    unsafe {
        PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0);
    }
}

/// Allow other processes (second instance) to request "show main".
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
        // Also try native show from the second process (helps even if first is stuck).
        force_show();
    }
}

pub fn poll_show_event(handle: *mut core::ffi::c_void) -> bool {
    use windows_sys::Win32::System::Threading::WaitForSingleObject;
    if handle.is_null() {
        return false;
    }
    unsafe { WaitForSingleObject(handle, 0) == 0 }
}
