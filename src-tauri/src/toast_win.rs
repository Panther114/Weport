//! Multi-toast host: modern monochrome cards at screen top-right.
//!
//! - Independent of egui (works while main window is tray-hidden)
//! - Stacks multiple cards with fade-in / fade-out
//! - When a card dismisses, remaining cards smoothly slide into its slot
//! - Non-activating topmost tool window (no focus steal)
#![cfg(windows)]

use std::collections::VecDeque;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

const TOAST_W: i32 = 370;
const TOAST_H: i32 = 100;
const GAP: i32 = 12;
const MARGIN: i32 = 20;
const MAX_VISIBLE: usize = 4;
const LIFE_MS: u64 = 6000;
const FADE_MS: f32 = 280.0;
const SLIDE_MS: f32 = 240.0;

#[derive(Clone)]
struct ToastItem {
    id: u64,
    title: String,
    body: String,
    kind: String,
    born: Instant,
    /// When set, fade-out has started.
    dying: Option<Instant>,
    /// Animated vertical position (pixels from top of host).
    display_y: f32,
    /// Target slot index (0 = top).
    target_slot: usize,
    /// Whether display_y has been initialized.
    y_init: bool,
}

struct Host {
    items: VecDeque<ToastItem>,
    next_id: u64,
    gen: u64,
}

static HOST: Mutex<Option<Host>> = Mutex::new(None);
static HOST_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn host_mut() -> std::sync::MutexGuard<'static, Option<Host>> {
    HOST.lock().unwrap()
}

fn ensure_host() {
    let mut g = host_mut();
    if g.is_none() {
        *g = Some(Host {
            items: VecDeque::new(),
            next_id: 1,
            gen: 0,
        });
    }
    drop(g);
    if !HOST_RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        thread::Builder::new()
            .name("weport-toast-host".into())
            .spawn(run_host)
            .ok();
    }
}

/// Push a toast onto the stack (non-blocking). Multiple can be visible.
pub fn show(title: &str, body: &str, kind_label: &str) {
    ensure_host();
    let mut g = host_mut();
    let h = g.as_mut().unwrap();
    let id = h.next_id;
    h.next_id += 1;
    h.items.push_back(ToastItem {
        id,
        title: title.to_string(),
        body: body.to_string(),
        kind: kind_label.to_string(),
        born: Instant::now(),
        dying: None,
        display_y: 0.0,
        target_slot: 0,
        y_init: false,
    });
    // Cap queue
    while h.items.len() > MAX_VISIBLE + 2 {
        h.items.pop_front();
    }
    h.gen += 1;
}

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

fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

fn ease_out(t: f32) -> f32 {
    let t = clamp01(t);
    1.0 - (1.0 - t) * (1.0 - t)
}

/// Snapshot of live toasts with computed opacity + display Y.
struct LiveCard {
    item: ToastItem,
    opacity: f32,
    y: i32,
}

fn snapshot_live(dt: f32) -> Vec<LiveCard> {
    let mut g = host_mut();
    let Some(h) = g.as_mut() else {
        return Vec::new();
    };
    let now = Instant::now();

    // Start fade-out for expired items
    for it in h.items.iter_mut() {
        if it.dying.is_none() && now.duration_since(it.born).as_millis() as u64 >= LIFE_MS {
            it.dying = Some(now);
        }
    }
    // Drop fully faded
    h.items.retain(|it| match it.dying {
        Some(d) => now.duration_since(d).as_millis() < FADE_MS as u128 + 40,
        None => true,
    });

    // Assign target slots (alive items only, order preserved)
    let mut slot = 0usize;
    for it in h.items.iter_mut() {
        it.target_slot = slot.min(MAX_VISIBLE.saturating_sub(1));
        let target_y = it.target_slot as f32 * (TOAST_H + GAP) as f32;
        if !it.y_init {
            // Enter from slightly below its target so stack feels stacked.
            it.display_y = target_y + 14.0;
            it.y_init = true;
        }
        // Smooth slide toward target (independent of OS animation prefs).
        let speed = 1.0 - (-dt * 1000.0 / SLIDE_MS).exp();
        it.display_y += (target_y - it.display_y) * speed.clamp(0.08, 1.0);
        if (it.display_y - target_y).abs() < 0.4 {
            it.display_y = target_y;
        }
        if slot < MAX_VISIBLE {
            slot += 1;
        }
    }

    let mut out = Vec::new();
    for it in h.items.iter().take(MAX_VISIBLE) {
        let opacity = if let Some(d) = it.dying {
            let t = now.duration_since(d).as_millis() as f32 / FADE_MS;
            1.0 - ease_out(t)
        } else {
            let t = now.duration_since(it.born).as_millis() as f32 / FADE_MS;
            ease_out(t)
        };
        out.push(LiveCard {
            item: it.clone(),
            opacity: clamp01(opacity),
            y: it.display_y.round() as i32,
        });
    }
    out
}

fn run_host() {
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    let host_h = (TOAST_H + GAP) * MAX_VISIBLE as i32 + MARGIN;
    let class = to_wide(&format!("WeportToastHost-{}", std::process::id()));

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        match msg {
            WM_LBUTTONUP => {
                // Dismiss the card under the cursor (by Y), else topmost.
                let y = ((lparam as u32) >> 16) as i16 as i32;
                let mut g = HOST.lock().unwrap();
                if let Some(h) = g.as_mut() {
                    let mut hit: Option<u64> = None;
                    for it in h.items.iter() {
                        let top = it.display_y as i32;
                        if y >= top && y < top + TOAST_H {
                            hit = Some(it.id);
                            break;
                        }
                    }
                    if hit.is_none() {
                        hit = h.items.front().map(|i| i.id);
                    }
                    if let Some(id) = hit {
                        if let Some(it) = h.items.iter_mut().find(|i| i.id == id) {
                            if it.dying.is_none() {
                                it.dying = Some(Instant::now());
                            }
                        }
                    }
                    h.gen += 1;
                }
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

        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED,
            class.as_ptr(),
            to_wide("WeportToastHost").as_ptr(),
            WS_POPUP,
            x,
            y,
            TOAST_W,
            host_h,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        if hwnd.is_null() {
            HOST_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
            return;
        }

        // Pure black = transparent (void); cards use near-black fills so they stay visible.
        SetLayeredWindowAttributes(hwnd, rgb(0, 0, 0), 255, LWA_COLORKEY);

        let mut last = Instant::now();
        loop {
            let now = Instant::now();
            let dt = now.duration_since(last).as_secs_f32().clamp(0.001, 0.05);
            last = now;

            let live = snapshot_live(dt);
            if live.is_empty() {
                ShowWindow(hwnd, SW_HIDE);
            } else {
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                // Keep topmost without activating
                SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                paint_stack(hwnd, &live);
            }

            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                if msg.message == WM_QUIT {
                    HOST_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
                    return;
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            thread::sleep(Duration::from_millis(16));
        }
    }
}

unsafe fn paint_stack(hwnd: windows_sys::Win32::Foundation::HWND, live: &[LiveCard]) {
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Graphics::Gdi::*;

    let hdc = GetDC(hwnd);
    if hdc.is_null() {
        return;
    }
    let host_h = (TOAST_H + GAP) * MAX_VISIBLE as i32 + MARGIN;

    // Clear with pure black → color-keyed transparent.
    let void_brush = CreateSolidBrush(rgb(0, 0, 0));
    let mut full = RECT {
        left: 0,
        top: 0,
        right: TOAST_W,
        bottom: host_h,
    };
    FillRect(hdc, &full, void_brush);
    DeleteObject(void_brush as _);

    for card in live {
        paint_card(hdc, 0, card.y, &card.item, card.opacity);
    }

    ReleaseDC(hwnd, hdc);
    let _ = full;
}

/// Lerp a channel toward black by (1 - opacity) for fade effect without window alpha.
fn fade_rgb(r: u8, g: u8, b: u8, opacity: f32) -> u32 {
    let o = opacity.clamp(0.0, 1.0);
    // Keep pure black only for void; card pixels must stay non-zero so color-key doesn't eat them.
    let fr = ((r as f32) * o).round().max(if r > 0 { 1.0 } else { 0.0 }) as u8;
    let fg = ((g as f32) * o).round().max(if g > 0 { 1.0 } else { 0.0 }) as u8;
    let fb = ((b as f32) * o).round().max(if b > 0 { 1.0 } else { 0.0 }) as u8;
    rgb(fr, fg, fb)
}

unsafe fn paint_card(
    hdc: windows_sys::Win32::Graphics::Gdi::HDC,
    x: i32,
    y: i32,
    item: &ToastItem,
    opacity: f32,
) {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::*;

    // App monochrome style: near-black panel, white/grey text.
    let bg = fade_rgb(18, 18, 18, opacity.max(0.15));
    let line = fade_rgb(60, 60, 60, opacity.max(0.2));
    let text = fade_rgb(255, 255, 255, opacity.max(0.25));
    let dim = fade_rgb(180, 180, 180, opacity.max(0.2));
    let faint = fade_rgb(120, 120, 120, opacity.max(0.2));
    let avatar_bg = fade_rgb(30, 30, 30, opacity.max(0.15));

    // Drop shadow: draw slightly offset dark rects behind the card
    for i in 1..4 {
        let shadow = fade_rgb(0, 0, 0, (0.08 * (4 - i) as f32 * opacity).max(0.01));
        let sbrush = CreateSolidBrush(shadow);
        let mut srect = RECT {
            left: x + i,
            top: y + i + 2,
            right: x + TOAST_W - i,
            bottom: y + TOAST_H + i + 2,
        };
        FillRect(hdc, &srect, sbrush);
        DeleteObject(sbrush as _);
    }

    // Card background
    let brush = CreateSolidBrush(bg);
    let mut rc = RECT {
        left: x,
        top: y,
        right: x + TOAST_W,
        bottom: y + TOAST_H,
    };
    FillRect(hdc, &rc, brush);
    DeleteObject(brush as _);

    // Border
    let pen = CreatePen(PS_SOLID, 1, line);
    let old_pen = SelectObject(hdc, pen as _);
    let old_br = SelectObject(hdc, GetStockObject(NULL_BRUSH));
    Rectangle(hdc, x + 1, y + 1, x + TOAST_W - 1, y + TOAST_H - 1);
    SelectObject(hdc, old_pen);
    SelectObject(hdc, old_br);
    DeleteObject(pen as _);

    // Avatar circle (left)
    let ax = x + 14;
    let ay = y + 18;
    let asz = 50;
    let is_group = item.kind.contains("群") || item.title.contains("群");
    let abr = CreateSolidBrush(if is_group {
        fade_rgb(60, 60, 60, opacity.max(0.2))
    } else {
        avatar_bg
    });
    let apen = CreatePen(PS_SOLID, 1, if is_group {
        fade_rgb(80, 80, 80, opacity.max(0.2))
    } else {
        line
    });
    let ob = SelectObject(hdc, abr as _);
    let op = SelectObject(hdc, apen as _);
    Ellipse(hdc, ax, ay, ax + asz, ay + asz);
    SelectObject(hdc, ob);
    SelectObject(hdc, op);
    DeleteObject(abr as _);
    DeleteObject(apen as _);

    SetBkMode(hdc, 1); // TRANSPARENT

    // Use Microsoft YaHei for CJK support (falls back gracefully on English systems)
    let face = to_wide("Microsoft YaHei");
    let mk_font = |height: i32, weight: i32| -> windows_sys::Win32::Graphics::Gdi::HFONT {
        CreateFontW(
            height, 0, 0, 0, weight, 0, 0, 0,
            1u32, // DEFAULT_CHARSET
            0, 0,
            5u32, // CLEARTYPE_QUALITY
            0,
            face.as_ptr(),
        )
    };
    let font_initial = mk_font(22, 700);
    let font_kind = mk_font(13, 500);
    let font_title = mk_font(16, 600);
    let font_body = mk_font(13, 400);

    let old_font = SelectObject(hdc, font_initial as _);
    SetTextColor(hdc, text);

    // Group chat icon: two small overlapping circles + body
    if is_group {
        let s = asz as f32 / 50.0;
        let cx = (ax + asz / 2) as f32;
        let cy = (ay + asz / 2) as f32;
        let gpen = CreatePen(PS_SOLID, (1.5 * s).max(1.0) as i32, fade_rgb(200, 200, 200, opacity.max(0.3)));
        let golden = SelectObject(hdc, gpen as _);
        let old_brush2 = SelectObject(hdc, GetStockObject(NULL_BRUSH));
        // Left head
        Ellipse(hdc,
            (cx - 9.0 * s) as i32, (cy - 7.0 * s) as i32,
            (cx - 1.0 * s) as i32, (cy + 1.0 * s) as i32);
        // Right head
        Ellipse(hdc,
            (cx + 1.0 * s) as i32, (cy - 7.0 * s) as i32,
            (cx + 9.0 * s) as i32, (cy + 1.0 * s) as i32);
        // Bodies - two vertical lines from under heads
        MoveToEx(hdc, (cx - 5.0 * s) as i32, (cy + 2.0 * s) as i32, std::ptr::null_mut());
        LineTo(hdc, (cx - 5.0 * s) as i32, (cy + 12.0 * s) as i32);
        MoveToEx(hdc, (cx + 5.0 * s) as i32, (cy + 2.0 * s) as i32, std::ptr::null_mut());
        LineTo(hdc, (cx + 5.0 * s) as i32, (cy + 12.0 * s) as i32);
        SelectObject(hdc, golden);
        SelectObject(hdc, old_brush2);
        DeleteObject(gpen as _);
    } else {
        // Single initial character
        let ch = item
            .title
            .chars()
            .find(|c| !c.is_whitespace())
            .unwrap_or('W')
            .to_string();
        let cw = to_wide(&ch);
        let mut arc = RECT {
            left: ax,
            top: ay,
            right: ax + asz,
            bottom: ay + asz,
        };
        const DT_LEFT: u32 = 0x0000;
        const DT_CENTER: u32 = 0x0001;
        const DT_VCENTER: u32 = 0x0004;
        const DT_SINGLELINE: u32 = 0x0020;
        DrawTextW(
            hdc,
            cw.as_ptr(),
            -1,
            &mut arc,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE,
        );
    }

    // Kind (small, top-right of text block)
    SelectObject(hdc, font_kind as _);
    SetTextColor(hdc, faint);
    let kw = to_wide(&item.kind);
    let mut krc = RECT {
        left: x + 76,
        top: y + 10,
        right: x + TOAST_W - 14,
        bottom: y + 26,
    };
    const DT_LEFT: u32 = 0x0000;
    const DT_SINGLELINE: u32 = 0x0020;
    DrawTextW(hdc, kw.as_ptr(), -1, &mut krc, DT_LEFT | DT_SINGLELINE);

    // Title (contact name)
    SelectObject(hdc, font_title as _);
    SetTextColor(hdc, text);
    let ts = truncate(&item.title, 24);
    let tw = to_wide(&ts);
    let mut trc = RECT {
        left: x + 76,
        top: y + 28,
        right: x + TOAST_W - 14,
        bottom: y + 50,
    };
    const DT_END_ELLIPSIS: u32 = 0x8000;
    DrawTextW(
        hdc,
        tw.as_ptr(),
        -1,
        &mut trc,
        DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS,
    );

    // Body (message preview)
    SelectObject(hdc, font_body as _);
    SetTextColor(hdc, dim);
    let bs = truncate(&item.body, 56);
    let bw = to_wide(&bs);
    let mut brc = RECT {
        left: x + 76,
        top: y + 52,
        right: x + TOAST_W - 14,
        bottom: y + TOAST_H - 10,
    };
    const DT_WORDBREAK: u32 = 0x0010;
    DrawTextW(
        hdc,
        bw.as_ptr(),
        -1,
        &mut brc,
        DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS,
    );

    SelectObject(hdc, old_font);
    DeleteObject(font_initial as _);
    DeleteObject(font_kind as _);
    DeleteObject(font_title as _);
    DeleteObject(font_body as _);
}

fn truncate(s: &str, max_chars: usize) -> String {
    let mut out: String = s.chars().take(max_chars).collect();
    if s.chars().count() > max_chars {
        out.push('…');
    }
    out
}

#[allow(non_snake_case)]
fn rgb(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

const LWA_COLORKEY: u32 = 0x00000001;
const HWND_TOPMOST: windows_sys::Win32::Foundation::HWND = -1isize as _;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOACTIVATE: u32 = 0x0010;
