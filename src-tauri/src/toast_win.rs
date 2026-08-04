//! Standalone Windows notification popup (WeFlow-inspired card).
//!
//! Completely independent of the egui event loop so toasts still appear when
//! the main window is hidden in the tray. Uses a topmost, non-activating
//! tool window at the primary work-area top-right (like WeFlow's notification
//! window), with avatar circle + title + time + body + close.
#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const TOAST_W: i32 = 360;
const TOAST_H: i32 = 96;
const MARGIN: i32 = 20;
const CORNER: i32 = 16;
const DEFAULT_MS: u64 = 5500;

static SHOWING: AtomicBool = AtomicBool::new(false);

fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn work_area() -> (i32, i32, i32, i32) {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETWORKAREA};
    unsafe {
        let mut r: RECT = std::mem::zeroed();
        if SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut r as *mut _ as *mut _, 0) != 0 {
            return (r.left, r.top, r.right - r.left, r.bottom - r.top);
        }
    }
    (0, 0, 1920, 1080)
}

/// Show a WeFlow-style toast at the screen top-right. Non-blocking.
/// Replaces any currently showing toast.
pub fn show(title: &str, body: &str, kind_label: &str) {
    let title = title.to_string();
    let body = body.to_string();
    let kind = kind_label.to_string();
    // Drop previous by flipping the flag; new thread owns display.
    SHOWING.store(false, Ordering::SeqCst);
    thread::sleep(Duration::from_millis(30));
    SHOWING.store(true, Ordering::SeqCst);
    let token = Instant::now();
    thread::Builder::new()
        .name("weport-toast".into())
        .spawn(move || run_toast_window(title, body, kind, token))
        .ok();
}

fn run_toast_window(title: String, body: String, kind: String, token: Instant) {
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    let class = to_wide(&format!("WeportToastWin-{}", std::process::id()));
    let title_w = to_wide("WeportToast");

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        match msg {
            WM_NCHITTEST => {
                // Allow click-through on empty chrome; client hits close / body.
                HTCLIENT as LRESULT
            }
            WM_LBUTTONUP => {
                // Any click dismisses (WeFlow: click opens chat; we dismiss).
                DestroyWindow(hwnd);
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    unsafe {
        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: std::ptr::null_mut(),
            hIcon: std::ptr::null_mut(),
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        let _ = RegisterClassW(&wc);

        let (wx, wy, ww, _wh) = work_area();
        let x = wx + ww - TOAST_W - MARGIN;
        let y = wy + MARGIN;

        // Topmost tool window that does NOT activate (won't steal focus).
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED,
            class.as_ptr(),
            title_w.as_ptr(),
            WS_POPUP,
            x,
            y,
            TOAST_W,
            TOAST_H,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        if hwnd.is_null() {
            return;
        }

        // Soft opacity ~96%
        SetLayeredWindowAttributes(hwnd, 0, 245, LWA_ALPHA);
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        UpdateWindow(hwnd);

        // Paint card (WeFlow layout: avatar | title+time / body | close).
        paint_card(hwnd, &title, &body, &kind);

        let deadline = Instant::now() + Duration::from_millis(DEFAULT_MS);
        loop {
            if !SHOWING.load(Ordering::SeqCst) {
                // Superseded by a newer toast.
                DestroyWindow(hwnd);
                break;
            }
            if Instant::now() >= deadline {
                DestroyWindow(hwnd);
                break;
            }
            let mut msg: MSG = std::mem::zeroed();
            let r = PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE);
            if r != 0 {
                if msg.message == WM_QUIT {
                    break;
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            } else {
                // Keep painting responsive without busy-spinning.
                std::thread::sleep(Duration::from_millis(16));
                // Repaint occasionally in case of DWM glitches.
                if token.elapsed().as_millis() % 500 < 20 {
                    paint_card(hwnd, &title, &body, &kind);
                }
            }
        }
        SHOWING.store(false, Ordering::SeqCst);
    }
}

unsafe fn paint_card(hwnd: windows_sys::Win32::Foundation::HWND, title: &str, body: &str, kind: &str) {
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    let hdc = GetDC(hwnd);
    if hdc.is_null() {
        return;
    }

    // Colors (WeFlow light card defaults)
    let bg = RGB(250, 250, 252);
    let border = RGB(220, 220, 225);
    let title_c = RGB(44, 44, 44);
    let body_c = RGB(60, 60, 60);
    let muted = RGB(122, 122, 122);
    let avatar_bg = RGB(34, 34, 34);
    let accent = RGB(7, 193, 96); // WeChat green ring

    let brush_bg = CreateSolidBrush(bg);
    let brush_border = CreateSolidBrush(border);
    let brush_avatar = CreateSolidBrush(avatar_bg);

    // Fill background
    let mut rc = RECT {
        left: 0,
        top: 0,
        right: TOAST_W,
        bottom: TOAST_H,
    };
    FillRect(hdc, &rc, brush_bg);

    // Border rectangle (simple; rounded would need RoundRect)
    let pen = CreatePen(PS_SOLID, 1, border);
    let old_pen = SelectObject(hdc, pen as _);
    let old_brush = SelectObject(hdc, GetStockObject(NULL_BRUSH));
    RoundRect(hdc, 1, 1, TOAST_W - 1, TOAST_H - 1, CORNER * 2, CORNER * 2);
    SelectObject(hdc, old_pen);
    SelectObject(hdc, old_brush);
    DeleteObject(pen as _);

    // Avatar circle (left)
    let ax = 16;
    let ay = 20;
    let asz = 40;
    let old_b = SelectObject(hdc, brush_avatar as _);
    let pen_a = CreatePen(PS_SOLID, 2, accent);
    let old_p = SelectObject(hdc, pen_a as _);
    Ellipse(hdc, ax, ay, ax + asz, ay + asz);
    SelectObject(hdc, old_b);
    SelectObject(hdc, old_p);
    DeleteObject(pen_a as _);

    // Avatar initial
    SetBkMode(hdc, TRANSPARENT as i32);
    SetTextColor(hdc, RGB(255, 255, 255));
    let initial = title.chars().next().unwrap_or('W').to_string();
    let init_w = to_wide(&initial);
    let mut arc = RECT {
        left: ax,
        top: ay + 8,
        right: ax + asz,
        bottom: ay + asz,
    };
    DrawTextW(
        hdc,
        init_w.as_ptr(),
        -1,
        &mut arc,
        DT_CENTER | DT_SINGLELINE | DT_VCENTER,
    );

    // Kind pill (top, small)
    SetTextColor(hdc, muted);
    let kind_w = to_wide(kind);
    let mut krc = RECT {
        left: 68,
        top: 10,
        right: TOAST_W - 48,
        bottom: 26,
    };
    DrawTextW(hdc, kind_w.as_ptr(), -1, &mut krc, DT_LEFT | DT_SINGLELINE);

    // Title
    SetTextColor(hdc, title_c);
    let title_s = truncate(title, 22);
    let title_w = to_wide(&title_s);
    let mut trc = RECT {
        left: 68,
        top: 28,
        right: TOAST_W - 48,
        bottom: 50,
    };
    DrawTextW(
        hdc,
        title_w.as_ptr(),
        -1,
        &mut trc,
        DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS,
    );

    // Body (2 lines)
    SetTextColor(hdc, body_c);
    let body_s = truncate(body, 56);
    let body_w = to_wide(&body_s);
    let mut brc = RECT {
        left: 68,
        top: 52,
        right: TOAST_W - 20,
        bottom: TOAST_H - 12,
    };
    DrawTextW(
        hdc,
        body_w.as_ptr(),
        -1,
        &mut brc,
        DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS,
    );

    // Close "×" top-right
    SetTextColor(hdc, muted);
    let xw = to_wide("×");
    let mut xrc = RECT {
        left: TOAST_W - 28,
        top: 8,
        right: TOAST_W - 10,
        bottom: 28,
    };
    DrawTextW(hdc, xw.as_ptr(), -1, &mut xrc, DT_CENTER | DT_SINGLELINE);

    // Time (right of title row)
    let time = chrono::Local::now().format("%H:%M").to_string();
    let tw = to_wide(&time);
    SetTextColor(hdc, muted);
    let mut timer = RECT {
        left: TOAST_W - 72,
        top: 28,
        right: TOAST_W - 32,
        bottom: 48,
    };
    DrawTextW(hdc, tw.as_ptr(), -1, &mut timer, DT_RIGHT | DT_SINGLELINE);

    DeleteObject(brush_bg as _);
    DeleteObject(brush_border as _);
    DeleteObject(brush_avatar as _);
    ReleaseDC(hwnd, hdc);
    let _ = rc;
}

fn truncate(s: &str, max_chars: usize) -> String {
    let mut out: String = s.chars().take(max_chars).collect();
    if s.chars().count() > max_chars {
        out.push('…');
    }
    out
}

// RGB helper (windows-sys uses COLORREF = u32)
#[allow(non_snake_case)]
fn RGB(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}
