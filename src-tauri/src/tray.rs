//! Windows system-tray icon (Shell_NotifyIcon) on a hidden message-only window.
//!
//! The tray lives on its own thread with its own message pump so it never
//! interferes with the egui/winit event loop. Events (left-click, context
//! menu) are surfaced through a shared `TrayEvent` channel; the GUI polls it
//! every frame via [`poll`]. A right-click menu offers 显示主窗口 / 退出.
//!
//! Icon loading builds an HICON from RGBA PNG pixels (GDI CreateIconIndirect)
//! so PNG-compressed .ico entries cannot fail silently and kill tray support.
#![cfg(windows)]

use egui::Context;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::JoinHandle;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayEvent {
    ShowMainWindow,
    ToggleMainWindow,
    Quit,
}

pub struct Tray {
    rx: Receiver<TrayEvent>,
    join: Option<JoinHandle<()>>,
    hwnd: *mut core::ffi::c_void,
    thread_id: u32,
}

unsafe impl Send for Tray {}

const TRAY_ID: u32 = 1;
const WM_TRAY: u32 = 0x8000 + 1; // WM_APP + 1
const ID_SHOW: usize = 0x8002;
const ID_QUIT: usize = 0x8004;

struct TrayThreadState {
    tx: Sender<TrayEvent>,
    ctx: Context,
}

unsafe extern "system" fn wnd_proc(
    hwnd: *mut core::ffi::c_void,
    msg: u32,
    wparam: usize,
    lparam: isize,
) -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    if msg == WM_TRAY {
        let state = unsafe {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if ptr == 0 {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            &*(ptr as *const TrayThreadState)
        };
        match (lparam as u32) & 0xFFFF {
            // Left click always shows the main window (never toggle-hide).
            // Hide is only via the window X button (close-to-tray).
            WM_LBUTTONUP | WM_LBUTTONDBLCLK => {
                let _ = state.tx.send(TrayEvent::ShowMainWindow);
                state.ctx.request_repaint();
            }
            WM_RBUTTONUP | WM_CONTEXTMENU => {
                show_menu(hwnd, &state.tx, &state.ctx);
            }
            _ => {}
        }
        return 0;
    }

    if msg == WM_COMMAND {
        let id = wparam & 0xFFFF;
        if id == ID_SHOW as usize {
            let state = unsafe {
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                if ptr == 0 {
                    return 0;
                }
                &*(ptr as *const TrayThreadState)
            };
            let _ = state.tx.send(TrayEvent::ShowMainWindow);
            state.ctx.request_repaint();
            return 0;
        }
        if id == ID_QUIT as usize {
            let state = unsafe {
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                if ptr == 0 {
                    return 0;
                }
                &*(ptr as *const TrayThreadState)
            };
            let _ = state.tx.send(TrayEvent::Quit);
            state.ctx.request_repaint();
            return 0;
        }
    }

    if msg == WM_DESTROY {
        PostQuitMessage(0);
        return 0;
    }

    if msg == WM_CLOSE {
        DestroyWindow(hwnd);
        return 0;
    }

    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn show_menu(hwnd: *mut core::ffi::c_void, tx: &Sender<TrayEvent>, ctx: &Context) {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    unsafe {
        let menu = CreatePopupMenu();
        if menu.is_null() {
            return;
        }
        let show = to_wide("显示主窗口");
        let quit = to_wide("退出");
        AppendMenuW(menu, MF_STRING, ID_SHOW as usize, show.as_ptr());
        AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
        AppendMenuW(menu, MF_STRING, ID_QUIT as usize, quit.as_ptr());

        SetForegroundWindow(hwnd);
        let mut pt = std::mem::zeroed();
        GetCursorPos(&mut pt);
        let cmd = TrackPopupMenu(
            menu,
            TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
            pt.x,
            pt.y,
            0,
            hwnd,
            std::ptr::null(),
        );
        DestroyMenu(menu);
        PostMessageW(hwnd, WM_NULL, 0, 0);

        if cmd as usize == ID_SHOW {
            let _ = tx.send(TrayEvent::ShowMainWindow);
            ctx.request_repaint();
        } else if cmd as usize == ID_QUIT {
            let _ = tx.send(TrayEvent::Quit);
            ctx.request_repaint();
        }
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Build an HICON from raw RGBA (top-down). Uses GDI so tray never depends on
/// CreateIconFromResourceEx PNG support.
fn hicon_from_rgba(width: i32, height: i32, rgba: &[u8]) -> windows_sys::Win32::UI::WindowsAndMessaging::HICON {
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    if width <= 0 || height <= 0 {
        return std::ptr::null_mut();
    }
    let expected = (width as usize) * (height as usize) * 4;
    if rgba.len() < expected {
        return std::ptr::null_mut();
    }

    unsafe {
        // BGRA bottom-up DIB for the color bitmap.
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width;
        bmi.bmiHeader.biHeight = -height; // top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;

        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let hdc = GetDC(std::ptr::null_mut());
        let color = CreateDIBSection(
            hdc,
            &bmi,
            DIB_RGB_COLORS,
            &mut bits,
            std::ptr::null_mut(),
            0,
        );
        ReleaseDC(std::ptr::null_mut(), hdc);
        if color.is_null() || bits.is_null() {
            return std::ptr::null_mut();
        }

        // RGBA → BGRA, keep alpha in high byte.
        let dst = std::slice::from_raw_parts_mut(bits as *mut u8, expected);
        for i in 0..(width as usize * height as usize) {
            let r = rgba[i * 4];
            let g = rgba[i * 4 + 1];
            let b = rgba[i * 4 + 2];
            let a = rgba[i * 4 + 3];
            dst[i * 4] = b;
            dst[i * 4 + 1] = g;
            dst[i * 4 + 2] = r;
            dst[i * 4 + 3] = a;
        }

        // 1-bit AND mask (all zero = use alpha channel on modern Windows).
        let mask_stride = ((width + 31) / 32) * 4;
        let mask_bytes = (mask_stride as usize) * (height as usize);
        let mask_buf = vec![0u8; mask_bytes];
        let mask = CreateBitmap(width, height, 1, 1, mask_buf.as_ptr() as *const _);
        if mask.is_null() {
            DeleteObject(color);
            return std::ptr::null_mut();
        }

        let mut ii: ICONINFO = std::mem::zeroed();
        ii.fIcon = 1;
        ii.hbmMask = mask;
        ii.hbmColor = color;
        let icon = CreateIconIndirect(&ii);
        DeleteObject(mask);
        DeleteObject(color);
        icon
    }
}

/// Tray icon from the sole branding source (build.rs → OUT_DIR/tray-32.png).
fn load_tray_icon() -> windows_sys::Win32::UI::WindowsAndMessaging::HICON {
    const TRAY_PNG: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/tray-32.png"));
    let Ok(img) = image::load_from_memory(TRAY_PNG) else {
        return std::ptr::null_mut();
    };
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    // Prefer 32×32; resize if build output ever differs.
    let rgba = if w != 32 || h != 32 {
        image::imageops::resize(&rgba, 32, 32, image::imageops::FilterType::Lanczos3)
    } else {
        rgba
    };
    let icon = hicon_from_rgba(32, 32, &rgba);
    if !icon.is_null() {
        return icon;
    }
    std::ptr::null_mut()
}

impl Tray {
    /// Spawn the tray thread. Returns `Ok(None)` if Shell_NotifyIcon fails
    /// (e.g. Explorer not running). Returns `Err` only for hard failures.
    pub fn spawn(ctx: Context) -> Result<Option<Self>, String> {
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::UI::Shell::*;
        use windows_sys::Win32::UI::WindowsAndMessaging::*;

        let (tx, rx) = mpsc::channel::<TrayEvent>();
        let thread_tx = tx.clone();

        let class_name = format!("WeportTrayClass-{}", std::process::id());
        let class = to_wide(&class_name);
        let class_ptr: *const u16 = class.as_ptr();

        unsafe {
            let wc: WNDCLASSW = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(wnd_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: std::ptr::null_mut(),
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class_ptr,
            };
            let _ = RegisterClassW(&wc);

            let hwnd = CreateWindowExW(
                0,
                class_ptr,
                to_wide("WeportTray").as_ptr(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if hwnd.is_null() {
                return Err("创建托盘窗口失败".into());
            }

            let icon = load_tray_icon();
            if icon.is_null() {
                let _ = DestroyWindow(hwnd);
                return Err("加载托盘图标失败".into());
            }

            let state = Box::into_raw(Box::new(TrayThreadState {
                tx: thread_tx,
                ctx: ctx.clone(),
            }));
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, state as isize);

            let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
            nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
            nid.hWnd = hwnd;
            nid.uID = TRAY_ID;
            nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            nid.uCallbackMessage = WM_TRAY;
            nid.hIcon = icon;
            let tip = to_wide("Weport — 微信聊天记录导出");
            let copy_len = tip.len().min(127);
            std::ptr::copy_nonoverlapping(tip.as_ptr(), nid.szTip.as_mut_ptr(), copy_len);
            nid.szTip[copy_len] = 0;

            if Shell_NotifyIconW(NIM_ADD, &nid) == 0 {
                // Retry once after a short delay (Explorer may not be ready).
                std::thread::sleep(Duration::from_millis(250));
                if Shell_NotifyIconW(NIM_ADD, &nid) == 0 {
                    let _ = DestroyWindow(hwnd);
                    let _ = Box::from_raw(state);
                    DestroyIcon(icon);
                    return Ok(None);
                }
            }

            let hwnd_send = hwnd as usize;
            let state_send = state as usize;
            let icon_send = icon as usize;
            let (tid_tx, tid_rx) = mpsc::channel::<u32>();
            let join = std::thread::Builder::new()
                .name("weport-tray".into())
                .spawn(move || {
                    let hwnd = hwnd_send as *mut core::ffi::c_void;
                    let state = state_send as *mut TrayThreadState;
                    let icon = icon_send as windows_sys::Win32::UI::WindowsAndMessaging::HICON;
                    let tid = windows_sys::Win32::System::Threading::GetCurrentThreadId();
                    let _ = tid_tx.send(tid);
                    loop {
                        let mut msg: MSG = std::mem::zeroed();
                        let r = GetMessageW(&mut msg, HWND::default(), 0, 0);
                        if r <= 0 {
                            break;
                        }
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    let mut nid2: NOTIFYICONDATAW = std::mem::zeroed();
                    nid2.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
                    nid2.hWnd = hwnd;
                    nid2.uID = TRAY_ID;
                    Shell_NotifyIconW(NIM_DELETE, &nid2);
                    let _ = DestroyWindow(hwnd);
                    if !icon.is_null() {
                        DestroyIcon(icon);
                    }
                    if !state.is_null() {
                        let _ = Box::from_raw(state);
                    }
                })
                .map_err(|e| format!("启动托盘线程失败: {e}"))?;

            let thread_id = tid_rx.recv_timeout(Duration::from_secs(2)).unwrap_or(0);

            Ok(Some(Self {
                rx,
                join: Some(join),
                hwnd,
                thread_id,
            }))
        }
    }

    pub fn poll(&mut self) -> Option<TrayEvent> {
        self.rx.try_recv().ok()
    }

    pub fn request_shutdown(&mut self) {
        use windows_sys::Win32::UI::Shell::{Shell_NotifyIconW, NOTIFYICONDATAW, NIM_DELETE};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            PostMessageW, PostThreadMessageW, WM_CLOSE, WM_QUIT,
        };
        unsafe {
            let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
            nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
            nid.hWnd = self.hwnd;
            nid.uID = TRAY_ID;
            Shell_NotifyIconW(NIM_DELETE, &nid);
            if !self.hwnd.is_null() {
                PostMessageW(self.hwnd, WM_CLOSE, 0, 0);
            }
            if self.thread_id != 0 {
                let _ = PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0);
            }
        }
    }
}

impl Drop for Tray {
    fn drop(&mut self) {
        self.request_shutdown();
        if let Some(join) = self.join.take() {
            let deadline = std::time::Instant::now() + Duration::from_millis(400);
            loop {
                if join.is_finished() {
                    let _ = join.join();
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}
