//! Native egui shell — SpaceX monochrome, rounded, dense, larger type.
use crate::antirecall;
use crate::engine::{self, EngineState};
use crate::export;
use crate::notify::{NotifyConfig, NotifyEvent, NotifyKind, NotifyService};
use crate::paths::AccountInfo;
use crate::settings::{load_settings, save_settings, AppSettings};
use crate::startup;
use eframe::egui::{
    self, Color32, CornerRadius, FontData, FontDefinitions, FontFamily, FontId, Frame, Margin,
    RichText, Sense, Stroke, Vec2,
};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

const BG: Color32 = Color32::from_rgb(0, 0, 0);
const PANEL: Color32 = Color32::from_rgb(14, 14, 14);
const ELEVATED: Color32 = Color32::from_rgb(22, 22, 22);
const LINE: Color32 = Color32::from_rgb(48, 48, 48);
const LINE_STRONG: Color32 = Color32::from_rgb(90, 90, 90);
const TEXT: Color32 = Color32::from_rgb(255, 255, 255);
const TEXT_DIM: Color32 = Color32::from_rgb(170, 170, 170);
const TEXT_FAINT: Color32 = Color32::from_rgb(110, 110, 110);
const GITHUB_URL: &str = "https://github.com/Panther114/Weport";

const R: u8 = 10;

#[derive(Clone, Copy, PartialEq, Eq)]
enum AppMode {
    Connect,
    Export,
    AntiRecall,
    Notifications,
}

impl AppMode {
    fn label(self) -> &'static str {
        match self {
            Self::Connect => "连接数据库",
            Self::Export => "导出聊天",
            Self::AntiRecall => "安装防撤回",
            Self::Notifications => "消息提醒",
        }
    }
}

enum BgMsg {
    Status(String),
    KeyDone(Result<String, String>),
    ExportProgress {
        current: f64,
        total: f64,
        session: String,
        phase: String,
    },
    ExportDone(Result<serde_json::Value, String>),
    Accounts(Result<Vec<AccountInfo>, String>),
    Detect(Result<String, String>),
    UpdateCheck(Result<Option<(String, String)>, String>),
    UpdateInstall(Result<(), String>),
    ClearDone(Result<String, String>),
    AntiStatus(Result<(String, String), String>),
    AntiDone(Result<serde_json::Value, String>),
}

/// Primary-display work-area rect (top-right toast placement).
fn primary_work_area() -> (f32, f32, f32, f32) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
        };
        unsafe {
            let pt = POINT { x: 0, y: 0 };
            let mon = MonitorFromPoint(pt, MONITOR_DEFAULTTOPRIMARY);
            if !mon.is_null() {
                let mut info: MONITORINFO = std::mem::zeroed();
                info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                if GetMonitorInfoW(mon, &mut info) != 0 {
                    let r = info.rcWork;
                    return (
                        r.left as f32,
                        r.top as f32,
                        (r.right - r.left) as f32,
                        (r.bottom - r.top) as f32,
                    );
                }
            }
        }
    }
    (0.0, 0.0, 1920.0, 1040.0)
}

fn toast_vp_id() -> egui::ViewportId {
    egui::ViewportId::from_hash_of("weport-toast")
}

const TOAST_W: f32 = 344.0;
const TOAST_H: f32 = 96.0;
const TOAST_DURATION: f64 = 6.0;

pub fn run_gui() -> eframe::Result<()> {
    let icon = load_app_icon();
    let mut viewport = egui::ViewportBuilder::default()
        .with_inner_size([1080.0, 720.0])
        .with_min_inner_size([900.0, 580.0])
        .with_title(format!("Weport v{APP_VERSION}"))
        .with_decorations(true);

    if let Some(icon) = icon {
        viewport = viewport.with_icon(icon);
    }

    let options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };

    eframe::run_native(
        "Weport",
        options,
        Box::new(|cc| {
            setup_style(&cc.egui_ctx);
            setup_fonts(&cc.egui_ctx);
            Ok(Box::new(WeportApp::new(cc)))
        }),
    )
}

fn load_app_icon() -> Option<egui::IconData> {
    let bytes = include_bytes!("../../assets/icons/icon.png");
    let img = image::load_from_memory(bytes).ok()?.into_rgba8();
    let (w, h) = img.dimensions();
    Some(egui::IconData {
        rgba: img.into_raw(),
        width: w,
        height: h,
    })
}

fn setup_fonts(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();
    let data = FontData::from_static(include_bytes!("../../src/assets/fonts/weport.ttf"));
    fonts
        .font_data
        .insert("weport".to_owned(), Arc::new(data));
    fonts
        .families
        .entry(FontFamily::Proportional)
        .or_default()
        .insert(0, "weport".to_owned());
    fonts
        .families
        .entry(FontFamily::Monospace)
        .or_default()
        .insert(0, "weport".to_owned());
    ctx.set_fonts(fonts);
}

fn setup_style(ctx: &egui::Context) {
    let mut style = (*ctx.style()).clone();
    style.spacing.item_spacing = Vec2::new(10.0, 8.0);
    style.spacing.button_padding = Vec2::new(12.0, 7.0);
    style.spacing.indent = 12.0;
    style.spacing.window_margin = Margin::same(16);
    style.visuals.dark_mode = true;
    style.visuals.override_text_color = Some(TEXT);
    style.visuals.panel_fill = BG;
    style.visuals.window_fill = PANEL;
    style.visuals.extreme_bg_color = BG;
    style.visuals.faint_bg_color = ELEVATED;
    style.visuals.widgets.noninteractive.bg_fill = PANEL;
    style.visuals.widgets.inactive.bg_fill = ELEVATED;
    style.visuals.widgets.hovered.bg_fill = Color32::from_rgb(36, 36, 36);
    style.visuals.widgets.active.bg_fill = TEXT;
    style.visuals.widgets.active.fg_stroke = Stroke::new(1.0, BG);
    style.visuals.selection.bg_fill = TEXT;
    style.visuals.selection.stroke = Stroke::new(1.0, TEXT);
    style.visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, TEXT_DIM);
    style.visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, TEXT);
    style.visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT_DIM);
    style.visuals.widgets.inactive.bg_stroke = Stroke::new(1.0, LINE);
    style.visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, LINE_STRONG);
    style.visuals.widgets.active.bg_stroke = Stroke::new(1.0, TEXT);
    style.visuals.window_stroke = Stroke::new(1.0, LINE_STRONG);
    style.visuals.window_corner_radius = CornerRadius::same(12);
    style.visuals.menu_corner_radius = CornerRadius::same(10);
    style.visuals.widgets.noninteractive.corner_radius = CornerRadius::same(R);
    style.visuals.widgets.inactive.corner_radius = CornerRadius::same(R);
    style.visuals.widgets.hovered.corner_radius = CornerRadius::same(R);
    style.visuals.widgets.active.corner_radius = CornerRadius::same(R);
    // f32 stroke widths
    style.text_styles.insert(
        egui::TextStyle::Body,
        FontId::new(16.0, FontFamily::Proportional),
    );
    style.text_styles.insert(
        egui::TextStyle::Button,
        FontId::new(15.0, FontFamily::Proportional),
    );
    style.text_styles.insert(
        egui::TextStyle::Heading,
        FontId::new(20.0, FontFamily::Proportional),
    );
    style.text_styles.insert(
        egui::TextStyle::Small,
        FontId::new(14.0, FontFamily::Proportional),
    );
    style.text_styles.insert(
        egui::TextStyle::Monospace,
        FontId::new(14.0, FontFamily::Monospace),
    );
    ctx.set_style(style);
}

/// Compact vector icons drawn with egui painter (no external asset deps).
mod icons {
    use super::{BG, ELEVATED, LINE, TEXT_DIM, R};
    use eframe::egui::{
        self, Color32, CornerRadius, Frame, Margin, Pos2, RichText, Sense, Stroke, StrokeKind, Vec2,
    };

    fn icon_rect(ui: &mut egui::Ui, size: f32) -> egui::Rect {
        let (rect, _) = ui.allocate_exact_size(Vec2::splat(size), Sense::hover());
        rect
    }

    fn dir(angle: f32) -> Vec2 {
        Vec2::new(angle.cos(), angle.sin())
    }

    /// GitHub-style cat mark (simplified, readable at toolbar sizes).
    pub fn github(ui: &mut egui::Ui, color: Color32, size: f32) {
        let rect = icon_rect(ui, size);
        let c = rect.center();
        let s = size / 18.0;
        let painter = ui.painter();
        painter.circle_filled(c + Vec2::new(0.0, 1.0 * s), 6.2 * s, color);
        painter.add(egui::Shape::convex_polygon(
            vec![
                c + Vec2::new(-5.6 * s, -1.2 * s),
                c + Vec2::new(-4.2 * s, -7.4 * s),
                c + Vec2::new(-1.2 * s, -4.2 * s),
            ],
            color,
            Stroke::NONE,
        ));
        painter.add(egui::Shape::convex_polygon(
            vec![
                c + Vec2::new(5.6 * s, -1.2 * s),
                c + Vec2::new(4.2 * s, -7.4 * s),
                c + Vec2::new(1.2 * s, -4.2 * s),
            ],
            color,
            Stroke::NONE,
        ));
        let eye = if color.r() > 100 {
            BG
        } else {
            Color32::from_rgb(20, 20, 20)
        };
        painter.circle_filled(c + Vec2::new(-2.2 * s, 0.4 * s), 1.05 * s, eye);
        painter.circle_filled(c + Vec2::new(2.2 * s, 0.4 * s), 1.05 * s, eye);
        painter.line_segment(
            [c + Vec2::new(-3.5 * s, 5.5 * s), c + Vec2::new(-4.2 * s, 8.0 * s)],
            Stroke::new(1.4 * s, color),
        );
        painter.line_segment(
            [c + Vec2::new(3.5 * s, 5.5 * s), c + Vec2::new(4.2 * s, 8.0 * s)],
            Stroke::new(1.4 * s, color),
        );
        painter.line_segment(
            [c + Vec2::new(0.0, 6.0 * s), c + Vec2::new(0.0, 8.2 * s)],
            Stroke::new(1.4 * s, color),
        );
    }

    pub fn gear(ui: &mut egui::Ui, color: Color32, size: f32) {
        let rect = icon_rect(ui, size);
        let c = rect.center();
        let painter = ui.painter();
        let r_outer = size * 0.34;
        painter.circle_stroke(c, r_outer, Stroke::new(size * 0.14, color));
        for i in 0..6 {
            let a = (i as f32) * std::f32::consts::TAU / 6.0 - std::f32::consts::FRAC_PI_2;
            let p = c + dir(a) * (r_outer + size * 0.02);
            painter.rect_filled(
                egui::Rect::from_center_size(p, Vec2::splat(size * 0.15)),
                CornerRadius::same(2),
                color,
            );
        }
        painter.circle_filled(c, size * 0.1, color);
        painter.circle_filled(c, size * 0.05, BG);
    }

    pub fn folder(ui: &mut egui::Ui, color: Color32, size: f32) {
        let rect = icon_rect(ui, size);
        let painter = ui.painter();
        let r = rect.shrink(size * 0.12);
        let tab = egui::Rect::from_min_max(
            Pos2::new(r.left(), r.top()),
            Pos2::new(r.left() + r.width() * 0.42, r.top() + r.height() * 0.28),
        );
        painter.rect_filled(tab, CornerRadius::same(2), color);
        painter.rect_stroke(
            egui::Rect::from_min_max(
                Pos2::new(r.left(), r.top() + r.height() * 0.2),
                r.right_bottom(),
            ),
            CornerRadius::same(3),
            Stroke::new(1.5, color),
            StrokeKind::Middle,
        );
    }

    pub fn key(ui: &mut egui::Ui, color: Color32, size: f32) {
        let rect = icon_rect(ui, size);
        let c = rect.center();
        let painter = ui.painter();
        let s = size / 18.0;
        painter.circle_stroke(c + Vec2::new(-3.5 * s, 0.0), 4.0 * s, Stroke::new(1.6 * s, color));
        painter.line_segment(
            [c + Vec2::new(0.2 * s, 0.0), c + Vec2::new(7.0 * s, 0.0)],
            Stroke::new(1.8 * s, color),
        );
        painter.line_segment(
            [c + Vec2::new(5.2 * s, 0.0), c + Vec2::new(5.2 * s, 3.2 * s)],
            Stroke::new(1.6 * s, color),
        );
        painter.line_segment(
            [c + Vec2::new(7.0 * s, 0.0), c + Vec2::new(7.0 * s, 2.4 * s)],
            Stroke::new(1.6 * s, color),
        );
    }

    pub fn database(ui: &mut egui::Ui, color: Color32, size: f32) {
        let rect = icon_rect(ui, size);
        let c = rect.center();
        let painter = ui.painter();
        let s = size / 18.0;
        let w = 6.0 * s;
        // Stacked discs (reads as a DB cylinder at small sizes)
        for (dy, rx) in [(-4.0, w), (0.0, w), (4.0, w)] {
            painter.circle_stroke(c + Vec2::new(0.0, dy * s * 0.7), rx * 0.55, Stroke::new(1.4 * s, color));
        }
        painter.line_segment(
            [c + Vec2::new(-w * 0.55, -2.8 * s), c + Vec2::new(-w * 0.55, 2.8 * s)],
            Stroke::new(1.4 * s, color),
        );
        painter.line_segment(
            [c + Vec2::new(w * 0.55, -2.8 * s), c + Vec2::new(w * 0.55, 2.8 * s)],
            Stroke::new(1.4 * s, color),
        );
    }

    pub fn export_arrow(ui: &mut egui::Ui, color: Color32, size: f32) {
        let rect = icon_rect(ui, size);
        let c = rect.center();
        let painter = ui.painter();
        let s = size / 18.0;
        painter.line_segment(
            [c + Vec2::new(0.0, -6.0 * s), c + Vec2::new(0.0, 4.0 * s)],
            Stroke::new(1.8 * s, color),
        );
        painter.add(egui::Shape::convex_polygon(
            vec![
                c + Vec2::new(0.0, 6.5 * s),
                c + Vec2::new(-3.8 * s, 2.2 * s),
                c + Vec2::new(3.8 * s, 2.2 * s),
            ],
            color,
            Stroke::NONE,
        ));
        painter.line_segment(
            [c + Vec2::new(-5.5 * s, 6.5 * s), c + Vec2::new(5.5 * s, 6.5 * s)],
            Stroke::new(1.6 * s, color),
        );
    }

    pub fn shield(ui: &mut egui::Ui, color: Color32, size: f32) {
        let rect = icon_rect(ui, size);
        let c = rect.center();
        let painter = ui.painter();
        let s = size / 18.0;
        let pts = [
            c + Vec2::new(0.0, -7.0 * s),
            c + Vec2::new(6.2 * s, -4.0 * s),
            c + Vec2::new(5.4 * s, 2.5 * s),
            c + Vec2::new(0.0, 7.2 * s),
            c + Vec2::new(-5.4 * s, 2.5 * s),
            c + Vec2::new(-6.2 * s, -4.0 * s),
            c + Vec2::new(0.0, -7.0 * s),
        ];
        for i in 0..pts.len() - 1 {
            painter.line_segment([pts[i], pts[i + 1]], Stroke::new(1.6 * s, color));
        }
        painter.line_segment(
            [c + Vec2::new(-2.5 * s, 0.2 * s), c + Vec2::new(-0.5 * s, 2.4 * s)],
            Stroke::new(1.6 * s, color),
        );
        painter.line_segment(
            [c + Vec2::new(-0.5 * s, 2.4 * s), c + Vec2::new(3.2 * s, -2.2 * s)],
            Stroke::new(1.6 * s, color),
        );
    }

    pub fn bell(ui: &mut egui::Ui, color: Color32, size: f32) {
        let rect = icon_rect(ui, size);
        let c = rect.center();
        let painter = ui.painter();
        let s = size / 18.0;
        painter.circle_stroke(c + Vec2::new(0.0, -1.2 * s), 4.5 * s, Stroke::new(1.5 * s, color));
        painter.line_segment(
            [c + Vec2::new(-5.5 * s, 3.2 * s), c + Vec2::new(5.5 * s, 3.2 * s)],
            Stroke::new(1.5 * s, color),
        );
        painter.circle_filled(c + Vec2::new(0.0, 5.4 * s), 1.3 * s, color);
        painter.circle_stroke(c + Vec2::new(0.0, -5.8 * s), 1.2 * s, Stroke::new(1.2 * s, color));
    }

    pub fn refresh(ui: &mut egui::Ui, color: Color32, size: f32) {
        let rect = icon_rect(ui, size);
        let c = rect.center();
        let painter = ui.painter();
        let s = size / 18.0;
        painter.circle_stroke(c, 5.5 * s, Stroke::new(1.5 * s, color));
        painter.add(egui::Shape::convex_polygon(
            vec![
                c + Vec2::new(5.5 * s, -1.0 * s),
                c + Vec2::new(8.0 * s, 1.5 * s),
                c + Vec2::new(3.0 * s, 2.0 * s),
            ],
            color,
            Stroke::NONE,
        ));
    }

    pub fn check(ui: &mut egui::Ui, color: Color32, size: f32) {
        let rect = icon_rect(ui, size);
        let c = rect.center();
        let painter = ui.painter();
        let s = size / 18.0;
        painter.line_segment(
            [c + Vec2::new(-4.5 * s, 0.2 * s), c + Vec2::new(-1.2 * s, 3.5 * s)],
            Stroke::new(2.0 * s, color),
        );
        painter.line_segment(
            [c + Vec2::new(-1.2 * s, 3.5 * s), c + Vec2::new(5.0 * s, -3.5 * s)],
            Stroke::new(2.0 * s, color),
        );
    }

    pub fn eye(ui: &mut egui::Ui, color: Color32, size: f32, open: bool) {
        let rect = icon_rect(ui, size);
        let c = rect.center();
        let painter = ui.painter();
        let s = size / 18.0;
        // Almond outline via two arcs approximated with a diamond + circle
        painter.circle_stroke(c, 5.5 * s, Stroke::new(1.3 * s, color));
        if open {
            painter.circle_filled(c, 2.0 * s, color);
            painter.circle_filled(c + Vec2::new(0.5 * s, -0.4 * s), 0.7 * s, BG);
        } else {
            painter.line_segment(
                [c + Vec2::new(-5.5 * s, 5.0 * s), c + Vec2::new(5.5 * s, -5.0 * s)],
                Stroke::new(1.4 * s, color),
            );
        }
    }

    pub fn github_button(ui: &mut egui::Ui) -> egui::Response {
        Frame::new()
            .fill(ELEVATED)
            .stroke(Stroke::new(1.0, LINE))
            .corner_radius(CornerRadius::same(R))
            .inner_margin(Margin::symmetric(12, 6))
            .show(ui, |ui| {
                ui.set_min_size(Vec2::new(118.0, 40.0));
                ui.horizontal_centered(|ui| {
                    github(ui, TEXT_DIM, 18.0);
                    ui.add_space(6.0);
                    ui.label(RichText::new("GitHub").size(14.0).color(TEXT_DIM));
                });
            })
            .response
            .interact(Sense::click())
    }

    pub fn mode_icon(ui: &mut egui::Ui, mode: super::AppMode, color: Color32) {
        match mode {
            super::AppMode::Connect => database(ui, color, 16.0),
            super::AppMode::Export => export_arrow(ui, color, 16.0),
            super::AppMode::AntiRecall => shield(ui, color, 16.0),
            super::AppMode::Notifications => bell(ui, color, 16.0),
        }
    }
}

struct Toast {
    kind: u8, // 0 ok 1 err 2 info
    title: String,
    body: String,
    until: f64,
}

struct WeportApp {
    mode: AppMode,
    db_path: String,
    export_path: String,
    format: String, // txt | json
    accounts: Vec<AccountInfo>,
    selected_wxid: String,
    decrypt_key: String,
    account_keys: std::collections::HashMap<String, String>,
    show_key: bool,
    busy: bool,
    busy_label: String,
    progress: Option<(f64, f64, String, String)>,
    toasts: Vec<Toast>,
    clear_open: bool,
    settings_open: bool,
    key_ready_hint: bool,
    export_log_txt: Option<String>,
    export_log_json: Option<String>,
    update_info: Option<(String, String)>,
    // --- v0.6.1: background / tray / settings ---
    launch_at_startup: bool,
    start_in_background: bool,
    close_to_tray: bool,
    anti_recall_enabled: bool,
    notifications_enabled: bool,
    tray: Option<crate::tray::Tray>,
    quit_requested: bool,
    /// Wall-clock deadline after which we hard-exit if Close hung.
    force_exit_at: Option<std::time::Instant>,
    main_visible: bool,
    pending_start_hidden: bool,
    // anti-recall
    anti_install: Option<String>,
    anti_state: Option<String>, // human-readable status line
    anti_busy: bool,
    // notifications
    notify: Option<NotifyService>,
    toast_queue: VecDeque<NotifyEvent>,
    current_toast: Option<NotifyEvent>,
    toast_shown_at: f64,
    notify_cfg_sent: Option<NotifyConfig>,
    tx: Sender<BgMsg>,
    rx: Receiver<BgMsg>,
    engine_busy: Arc<AtomicBool>,
    _engine: Arc<Mutex<EngineState>>,
}

impl WeportApp {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let (tx, rx) = mpsc::channel();
        let s = load_settings();
        let account_keys = s.account_keys.clone();
        // Current account's key wins; fall back to the legacy flat key.
        let decrypt_key = account_keys
            .get(&s.selected_wxid)
            .cloned()
            .filter(|k| !k.is_empty())
            .unwrap_or_else(|| s.decrypt_key.clone());

        // Tray (Windows only; harmless to skip elsewhere).
        #[cfg(windows)]
        let tray = crate::tray::Tray::spawn(cc.egui_ctx.clone()).ok().flatten();
        #[cfg(not(windows))]
        let tray = None;

        let notify = NotifyService::start();

        // Prefer tray-only launch when a tray icon is available.
        let start_hidden = s.start_in_background && tray.is_some();
        // Default ON: enable login auto-start unless the user previously disabled it.
        let launch_at_startup = s.launch_at_startup;
        if launch_at_startup && !startup::is_run_at_startup() {
            let _ = startup::set_run_at_startup(true);
        }
        let mut app = Self {
            db_path: s.db_path,
            mode: AppMode::Connect,
            export_path: s.export_path,
            format: if s.format == "json" {
                "json".into()
            } else {
                "txt".into()
            },
            accounts: Vec::new(),
            selected_wxid: s.selected_wxid,
            decrypt_key,
            account_keys,
            show_key: false,
            busy: false,
            busy_label: String::new(),
            progress: None,
            toasts: Vec::new(),
            clear_open: false,
            settings_open: false,
            key_ready_hint: false,
            export_log_txt: None,
            export_log_json: None,
            update_info: None,
            launch_at_startup,
            start_in_background: s.start_in_background,
            close_to_tray: s.close_to_tray,
            anti_recall_enabled: s.anti_recall_enabled,
            notifications_enabled: s.notifications_enabled,
            tray,
            quit_requested: false,
            force_exit_at: None,
            main_visible: !start_hidden,
            pending_start_hidden: start_hidden,
            anti_install: None,
            anti_state: None,
            anti_busy: false,
            notify: Some(notify),
            toast_queue: VecDeque::new(),
            current_toast: None,
            toast_shown_at: 0.0,
            notify_cfg_sent: None,
            tx,
            rx,
            engine_busy: Arc::new(AtomicBool::new(false)),
            _engine: Arc::new(Mutex::new(EngineState::default())),
        };
        if !app.db_path.is_empty() {
            app.spawn_scan_accounts();
        } else {
            app.spawn_detect();
        }
        app.refresh_export_log();
        app.spawn_update_check(false);
        // Startup anti-recall sanity check (status only, never patches by itself).
        app.spawn_antirecall_status();
        app
    }

    fn push_toast(&mut self, kind: u8, title: impl Into<String>, body: impl Into<String>, secs: f64) {
        let until = now_secs() + secs;
        self.toasts.push(Toast {
            kind,
            title: title.into(),
            body: body.into(),
            until,
        });
        if self.toasts.len() > 5 {
            self.toasts.remove(0);
        }
    }

    fn persist(&self) {
        let mut account_keys = self.account_keys.clone();
        // Always keep the current field under the selected account so an
        // extracted / pasted key survives restarts, updates and account switches.
        account_keys.insert(self.selected_wxid.clone(), self.decrypt_key.clone());
        let _ = save_settings(&AppSettings {
            db_path: self.db_path.clone(),
            decrypt_key: self.decrypt_key.clone(),
            export_path: self.export_path.clone(),
            selected_wxid: self.selected_wxid.clone(),
            format: self.format.clone(),
            account_keys,
            launch_at_startup: self.launch_at_startup,
            start_in_background: self.start_in_background,
            close_to_tray: self.close_to_tray,
            anti_recall_enabled: self.anti_recall_enabled,
            notifications_enabled: self.notifications_enabled,
        });
    }

    fn select_account(&mut self, wxid: &str) {
        self.selected_wxid = wxid.to_string();
        self.decrypt_key = self
            .account_keys
            .get(wxid)
            .cloned()
            .unwrap_or_default();
        self.persist();
    }

    fn refresh_export_log(&mut self) {
        if self.export_path.trim().is_empty() {
            self.export_log_txt = None;
            self.export_log_json = None;
            return;
        }
        let v = export::read_export_log(std::path::Path::new(self.export_path.trim()));
        self.export_log_txt = v
            .get("txt")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        self.export_log_json = v
            .get("json")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
    }

    fn spawn_detect(&mut self) {
        self.busy = true;
        self.busy_label = "正在扫描微信数据目录…".into();
        let tx = self.tx.clone();
        thread::spawn(move || {
            let r = engine::detect().map_err(|e| e.to_string()).and_then(|v| {
                if v.get("success").and_then(|x| x.as_bool()).unwrap_or(false) {
                    Ok(v.get("path")
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string())
                } else {
                    Err(v.get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or("未找到")
                        .to_string())
                }
            });
            let _ = tx.send(BgMsg::Detect(r));
        });
    }

    fn spawn_scan_accounts(&mut self) {
        let path = self.db_path.clone();
        if path.trim().is_empty() {
            return;
        }
        let tx = self.tx.clone();
        thread::spawn(move || {
            let r = engine::accounts(path).map_err(|e| e.to_string());
            let _ = tx.send(BgMsg::Accounts(r));
        });
    }

    fn spawn_extract_key(&mut self) {
        if self.engine_busy.swap(true, Ordering::SeqCst) {
            self.push_toast(1, "忙", "已有任务在进行", 4.0);
            return;
        }
        self.busy = true;
        self.key_ready_hint = false;
        self.busy_label = "正在连接微信进程…".into();
        self.push_toast(
            2,
            "开始提取密钥",
            "关闭自动登录；就绪后重新登录微信",
            7.0,
        );
        let tx = self.tx.clone();
        let busy = self.engine_busy.clone();
        thread::spawn(move || {
            let result = engine::extract_key(|msg| {
                let _ = tx.send(BgMsg::Status(msg));
            });
            busy.store(false, Ordering::SeqCst);
            let mapped = match result {
                Ok(v) if v.get("success").and_then(|x| x.as_bool()).unwrap_or(false) => {
                    Ok(v.get("key")
                        .and_then(|k| k.as_str())
                        .unwrap_or("")
                        .to_string())
                }
                Ok(v) => Err(v
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("提取失败")
                    .to_string()),
                Err(e) => Err(e.to_string()),
            };
            let _ = tx.send(BgMsg::KeyDone(mapped));
        });
    }

    fn spawn_export(&mut self) {
        if self.db_path.trim().is_empty() {
            self.push_toast(1, "请选择微信数据目录", "", 4.0);
            return;
        }
        if self.selected_wxid.is_empty() {
            self.push_toast(1, "请选择账号", "", 4.0);
            return;
        }
        if self.export_path.trim().is_empty() {
            self.push_toast(1, "请选择导出目录", "", 4.0);
            return;
        }
        if self.engine_busy.swap(true, Ordering::SeqCst) {
            self.push_toast(1, "忙", "已有任务在进行", 4.0);
            return;
        }

        let mut key = self.decrypt_key.trim().to_string();
        if key.len() != 64 {
            // auto key first
            self.busy = true;
            self.busy_label = "未检测到密钥，开始自动提取…".into();
            let tx = self.tx.clone();
            let busy = self.engine_busy.clone();
            let db = self.db_path.clone();
            let wxid = self.selected_wxid.clone();
            let out = self.export_path.clone();
            let fmt = self.format.clone();
            thread::spawn(move || {
                let key_res = engine::extract_key(|msg| {
                    let _ = tx.send(BgMsg::Status(msg));
                });
                let key = match key_res {
                    Ok(v) if v.get("success").and_then(|x| x.as_bool()).unwrap_or(false) => v
                        .get("key")
                        .and_then(|k| k.as_str())
                        .unwrap_or("")
                        .to_string(),
                    Ok(v) => {
                        busy.store(false, Ordering::SeqCst);
                        let _ = tx.send(BgMsg::ExportDone(Err(v
                            .get("error")
                            .and_then(|e| e.as_str())
                            .unwrap_or("密钥提取失败")
                            .to_string())));
                        return;
                    }
                    Err(e) => {
                        busy.store(false, Ordering::SeqCst);
                        let _ = tx.send(BgMsg::ExportDone(Err(e.to_string())));
                        return;
                    }
                };
                let _ = tx.send(BgMsg::KeyDone(Ok(key.clone())));
                run_export_job(tx, busy, db, wxid, key, out, fmt);
            });
            return;
        }

        self.busy = true;
        self.progress = Some((0.0, 0.0, String::new(), "准备中".into()));
        self.busy_label = "开始导出全部会话…".into();
        let tx = self.tx.clone();
        let busy = self.engine_busy.clone();
        let db = self.db_path.clone();
        let wxid = self.selected_wxid.clone();
        let out = self.export_path.clone();
        let fmt = self.format.clone();
        thread::spawn(move || {
            run_export_job(tx, busy, db, wxid, key, out, fmt);
        });
    }

    fn spawn_clear(&mut self) {
        let out = self.export_path.trim().to_string();
        if out.is_empty() {
            self.push_toast(1, "请先选择输出文件夹", "", 4.0);
            self.clear_open = false;
            return;
        }
        self.busy = true;
        self.busy_label = "正在清空导出库…".into();
        let tx = self.tx.clone();
        thread::spawn(move || {
            let r = export::clear_export_library(std::path::Path::new(&out))
                .map(|v| {
                    v.get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("已清空")
                        .to_string()
                })
                .map_err(|e| e);
            let _ = tx.send(BgMsg::ClearDone(r));
        });
    }

    fn spawn_update_check(&mut self, notify_when_latest: bool) {
        let tx = self.tx.clone();
        thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            let result = match rt {
                Ok(rt) => rt.block_on(async {
                    check_update_async().await.map_err(|e| e.to_string())
                }),
                Err(e) => Err(e.to_string()),
            };
            let mapped = result.map(|(avail, notes)| match avail {
                Some(ver) => Some((ver, notes.unwrap_or_default())),
                None if notify_when_latest => None, // about: show "already latest"
                None => None,
            });
            let _ = tx.send(BgMsg::UpdateCheck(mapped));
        });
    }

    fn spawn_update_install(&mut self) {
        self.busy = true;
        self.busy_label = "正在下载更新…".into();
        let tx = self.tx.clone();
        thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            let result = match rt {
                Ok(rt) => rt.block_on(async {
                    crate::cli_update::perform_update(true)
                        .await
                        .map_err(|e| e.to_string())
                }),
                Err(e) => Err(e.to_string()),
            };
            let _ = tx.send(BgMsg::UpdateInstall(result));
        });
    }

    /// Background check of the WeChat 4 anti-recall patch state.
    fn spawn_antirecall_status(&mut self) {
        let tx = self.tx.clone();
        thread::spawn(move || {
            let r = antirecall::find_weixin_install_path()
                .ok_or_else(|| "未找到微信 4 安装目录".to_string())
                .and_then(|install| {
                    let state = antirecall::patch_state(&install);
                    let label = match state {
                        antirecall::PatchState::NotInstalled => "未安装微信 4".to_string(),
                        antirecall::PatchState::WeChatRunning => "微信正在运行（需退出后操作）".to_string(),
                        antirecall::PatchState::Patched => "已安装（撤回消息将保留）".to_string(),
                        antirecall::PatchState::NotPatched => "未安装".to_string(),
                        antirecall::PatchState::Unsupported => "版本不受支持".to_string(),
                    };
                    Ok((install.display().to_string(), label))
                });
            let _ = tx.send(BgMsg::AntiStatus(r));
        });
    }

    /// Apply or remove the anti-recall patch through an elevated child.
    fn spawn_antirecall_action(&mut self, apply: bool) {
        if self.anti_busy {
            return;
        }
        let Some(install) = self.anti_install.clone() else {
            self.push_toast(1, "未找到微信 4 安装目录", "", 6.0);
            return;
        };
        self.anti_busy = true;
        self.push_toast(
            2,
            if apply { "正在安装防撤回补丁…" } else { "正在还原防撤回补丁…" },
            "需要管理员权限，微信需已完全退出",
            6.0,
        );
        let tx = self.tx.clone();
        thread::spawn(move || {
            let result_file = std::env::temp_dir().join(format!(
                "weport-antirecall-{}.json",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&result_file);
            let args = vec![
                format!("--antirecall-{}", if apply { "apply" } else { "remove" }),
                format!("\"{install}\""),
                format!("--antirecall-result \"{}\"", result_file.display()),
            ];
            let r = antirecall::relaunch_elevated(&args)
                .map_err(|e| e.to_string())
                .and_then(|_| {
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
                    loop {
                        if let Ok(text) = std::fs::read_to_string(&result_file) {
                            if !text.trim().is_empty() {
                                let _ = std::fs::remove_file(&result_file);
                                return serde_json::from_str(&text)
                                    .map_err(|e| format!("解析结果失败: {e}"));
                            }
                        }
                        if std::time::Instant::now() >= deadline {
                            let _ = std::fs::remove_file(&result_file);
                            return Err("等待管理员授权超时（可能取消了 UAC 弹窗）".to_string());
                        }
                        std::thread::sleep(std::time::Duration::from_millis(300));
                    }
                });
            let _ = tx.send(BgMsg::AntiDone(r));
        });
    }

    fn sync_notify_config(&mut self) {
        let cfg = NotifyConfig {
            enabled: self.notifications_enabled
                && !self.db_path.trim().is_empty()
                && !self.selected_wxid.is_empty()
                && self.decrypt_key.trim().len() == 64,
            db_root: self.db_path.clone(),
            wxid: self.selected_wxid.clone(),
            decrypt_key: self.decrypt_key.clone(),
        };
        let changed = match &self.notify_cfg_sent {
            Some(prev) => {
                prev.enabled != cfg.enabled
                    || prev.db_root != cfg.db_root
                    || prev.wxid != cfg.wxid
                    || prev.decrypt_key != cfg.decrypt_key
            }
            None => true,
        };
        if changed {
            self.notify_cfg_sent = Some(cfg.clone());
            if let Some(n) = &self.notify {
                n.configure(cfg);
            }
        }
    }

    fn advance_toast(&mut self) {
        self.current_toast = self.toast_queue.pop_front();
        self.toast_shown_at = now_secs();
        if self.current_toast.is_some() {
            // Keep the toast viewport alive while a toast is up.
        }
    }

    fn dismiss_current_toast(&mut self) {
        self.current_toast = None;
        self.advance_toast();
    }

    fn poll_bg(&mut self, ctx: &egui::Context) {
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                BgMsg::Status(s) => {
                    self.busy_label = s.clone();
                    if s.contains("已准备就绪")
                        || s.contains("可以登录")
                        || s.contains("Hook安装成功")
                    {
                        self.key_ready_hint = true;
                        self.push_toast(2, "密钥 Hook 已就绪", "请现在登录/重新登录微信", 8.0);
                    }
                }
                BgMsg::KeyDone(Ok(k)) => {
                    if !k.is_empty() {
                        self.decrypt_key = k;
                        self.persist();
                        if !self.engine_busy.load(Ordering::SeqCst) {
                            self.busy = false;
                            self.busy_label.clear();
                            self.key_ready_hint = false;
                            self.push_toast(0, "密钥提取成功", "可以开始导出", 5.0);
                        }
                    }
                }
                BgMsg::KeyDone(Err(e)) => {
                    self.busy = false;
                    self.busy_label.clear();
                    self.key_ready_hint = false;
                    self.push_toast(1, "密钥提取失败", e, 10.0);
                }
                BgMsg::ExportProgress {
                    current,
                    total,
                    session,
                    phase,
                } => {
                    self.progress = Some((current, total, session.clone(), phase.clone()));
                    self.busy_label = if session.is_empty() {
                        phase
                    } else {
                        format!("{phase} · {session}")
                    };
                }
                BgMsg::ExportDone(Ok(v)) => {
                    self.busy = false;
                    self.busy_label.clear();
                    self.engine_busy.store(false, Ordering::SeqCst);
                    self.refresh_export_log();
                    let ok = v.get("success").and_then(|x| x.as_bool()).unwrap_or(false);
                    let n = v.get("successCount").and_then(|x| x.as_u64()).unwrap_or(0);
                    let folder = v
                        .get("formatFolder")
                        .and_then(|x| x.as_str())
                        .unwrap_or("?");
                    if ok {
                        self.push_toast(
                            0,
                            "导出完成",
                            format!("成功 {n} 个会话 -> {folder}/（已覆盖同名）"),
                            7.0,
                        );
                        if let Some(p) = &mut self.progress {
                            p.0 = p.1.max(1.0);
                            p.3 = "完成".into();
                        }
                    } else {
                        let fail = v.get("failCount").and_then(|x| x.as_u64()).unwrap_or(0);
                        self.push_toast(1, "导出未完全成功", format!("成功 {n} / 失败 {fail}"), 12.0);
                    }
                }
                BgMsg::ExportDone(Err(e)) => {
                    self.busy = false;
                    self.busy_label.clear();
                    self.engine_busy.store(false, Ordering::SeqCst);
                    self.push_toast(1, "导出失败", e, 12.0);
                }
                BgMsg::Accounts(Ok(list)) => {
                    let n = list.len();
                    self.accounts = list;
                    if n > 0 {
                        if !self.accounts.iter().any(|a| a.wxid == self.selected_wxid) {
                            // Selected account disappeared — move to the newest one
                            // and restore its stored key (never wipe the key).
                            let first = self.accounts[0].wxid.clone();
                            self.select_account(&first);
                        }
                        self.push_toast(0, format!("找到 {n} 个账号"), self.db_path.clone(), 3.0);
                    } else {
                        self.selected_wxid.clear();
                        self.push_toast(2, "未找到账号目录", "确认是 xwechat_files 根目录", 5.0);
                    }
                    self.persist();
                }
                BgMsg::Accounts(Err(e)) => {
                    self.accounts.clear();
                    self.push_toast(1, "扫描账号失败", e, 6.0);
                }
                BgMsg::Detect(Ok(path)) => {
                    self.busy = false;
                    self.busy_label.clear();
                    if !path.is_empty() {
                        self.db_path = path;
                        self.persist();
                        self.spawn_scan_accounts();
                        self.push_toast(0, "已定位数据目录", self.db_path.clone(), 4.0);
                    }
                }
                BgMsg::Detect(Err(e)) => {
                    self.busy = false;
                    self.busy_label.clear();
                    self.push_toast(2, "未能自动检测", e, 5.0);
                }
                BgMsg::UpdateCheck(Ok(Some((ver, notes)))) => {
                    self.update_info = Some((ver.clone(), notes));
                    self.push_toast(2, format!("发现新版本 v{ver}"), "可在设置中安装", 6.0);
                }
                BgMsg::UpdateCheck(Ok(None)) => {
                    if self.settings_open {
                        self.push_toast(0, "已是最新版本", format!("当前 v{APP_VERSION}"), 4.0);
                    }
                }
                BgMsg::UpdateCheck(Err(e)) => {
                    if self.settings_open {
                        self.push_toast(1, "检查更新失败", e, 6.0);
                    }
                }
                BgMsg::UpdateInstall(Ok(())) => {
                    self.busy = false;
                    self.busy_label.clear();
                    self.push_toast(0, "更新已启动", "按安装程序提示完成", 8.0);
                }
                BgMsg::UpdateInstall(Err(e)) => {
                    self.busy = false;
                    self.busy_label.clear();
                    self.push_toast(1, "更新失败", e, 10.0);
                }
                BgMsg::ClearDone(Ok(msg)) => {
                    self.busy = false;
                    self.busy_label.clear();
                    self.clear_open = false;
                    self.refresh_export_log();
                    self.push_toast(0, msg, "", 4.0);
                }
                BgMsg::ClearDone(Err(e)) => {
                    self.busy = false;
                    self.busy_label.clear();
                    self.clear_open = false;
                    self.push_toast(1, "清空失败", e, 8.0);
                }
                BgMsg::AntiStatus(Ok((install, label))) => {
                    self.anti_install = Some(install);
                    self.anti_state = Some(label.clone());
                    if self.anti_recall_enabled && label == "未安装" {
                        self.push_toast(2, "防撤回未生效", "微信 4 的防撤回补丁尚未安装，可切换到“安装防撤回”处理", 8.0);
                    } else if self.anti_recall_enabled && label == "微信正在运行（需退出后操作）" {
                        self.push_toast(2, "微信正在运行", "防撤回补丁需要退出微信后安装", 6.0);
                    }
                }
                BgMsg::AntiStatus(Err(e)) => {
                    let msg = e.clone();
                    self.anti_state = Some(e);
                    self.push_toast(2, "防撤回状态未知", msg, 6.0);
                }
                BgMsg::AntiDone(Ok(v)) => {
                    self.anti_busy = false;
                    let ok = v.get("success").and_then(|x| x.as_bool()).unwrap_or(false);
                    let msg = v
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or(if ok { "操作成功" } else { "操作失败" });
                    if ok {
                        self.push_toast(0, msg, "", 6.0);
                    } else {
                        self.push_toast(1, "防撤回操作失败", msg, 10.0);
                    }
                    self.spawn_antirecall_status();
                }
                BgMsg::AntiDone(Err(e)) => {
                    self.anti_busy = false;
                    self.push_toast(1, "防撤回操作失败", e, 10.0);
                    self.spawn_antirecall_status();
                }
            }
        }
        // prune toasts
        let t = now_secs();
        self.toasts.retain(|x| x.until > t);
        if self.busy || !self.toasts.is_empty() {
            ctx.request_repaint_after(std::time::Duration::from_millis(100));
        }
    }

    fn panel_frame() -> Frame {
        Frame::new()
            .fill(PANEL)
            .stroke(Stroke::new(1.0_f32, LINE))
            .corner_radius(CornerRadius::same(12))
            .inner_margin(Margin::symmetric(28, 20))
    }
}

fn run_export_job(
    tx: Sender<BgMsg>,
    busy: Arc<AtomicBool>,
    db: String,
    wxid: String,
    key: String,
    out: String,
    fmt: String,
) {
    let result = engine::export_all_sessions(db, wxid, key, out, fmt, |p| {
        let _ = tx.send(BgMsg::ExportProgress {
            current: p.current,
            total: p.total,
            session: p.current_session,
            phase: p.phase_label,
        });
    })
    .map_err(|e| e.to_string());
    busy.store(false, Ordering::SeqCst);
    let _ = tx.send(BgMsg::ExportDone(result));
}

async fn check_update_async() -> Result<(Option<String>, Option<String>), Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::builder()
        .user_agent(format!("Weport/{APP_VERSION}"))
        .build()?;
    let url = "https://api.github.com/repos/Panther114/Weport/releases/latest";
    let release: serde_json::Value = client.get(url).send().await?.error_for_status()?.json().await?;
    let tag = release
        .get("tag_name")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .trim_start_matches('v')
        .to_string();
    let notes = release
        .get("body")
        .and_then(|b| b.as_str())
        .map(|s| s.to_string());
    let current = semver::Version::parse(APP_VERSION)?;
    let remote = semver::Version::parse(&tag)?;
    if remote > current {
        Ok((Some(tag), notes))
    } else {
        Ok((None, None))
    }
}

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

impl WeportApp {
    /// Tear down tray + notify and ask eframe to exit (with a hard-exit fallback).
    fn begin_quit(&mut self, ctx: &egui::Context) {
        if self.quit_requested {
            return;
        }
        self.quit_requested = true;
        self.force_exit_at = Some(std::time::Instant::now() + std::time::Duration::from_millis(600));
        // Close the secondary toast viewport first so the event loop can exit.
        ctx.send_viewport_cmd_to(toast_vp_id(), egui::ViewportCommand::Close);
        ctx.send_viewport_cmd_to(toast_vp_id(), egui::ViewportCommand::Visible(false));
        if let Some(mut tray) = self.tray.take() {
            tray.request_shutdown();
            // Drop joins with a short timeout (see tray.rs).
            drop(tray);
        }
        if let Some(notify) = self.notify.take() {
            notify.request_stop();
            drop(notify);
        }
        // Make the main window visible so Close is processed (some backends
        // ignore Close on a hidden window, which left the process hung).
        ctx.send_viewport_cmd(egui::ViewportCommand::Visible(true));
        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        self.main_visible = false;
    }
}

impl eframe::App for WeportApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_bg(ctx);
        self.sync_notify_config();

        // --- Tray events (show / toggle / quit) ---
        // Drain first so we don't hold a borrow on `self.tray` across `begin_quit`.
        let mut tray_events = Vec::new();
        if let Some(tray) = &mut self.tray {
            while let Some(ev) = tray.poll() {
                tray_events.push(ev);
            }
        }
        for ev in tray_events {
            match ev {
                crate::tray::TrayEvent::ShowMainWindow => {
                    ctx.send_viewport_cmd(egui::ViewportCommand::Visible(true));
                    ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
                    ctx.send_viewport_cmd(egui::ViewportCommand::Maximized(false));
                    self.main_visible = true;
                }
                crate::tray::TrayEvent::ToggleMainWindow => {
                    if self.main_visible {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Visible(false));
                        self.main_visible = false;
                    } else {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Visible(true));
                        ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
                        self.main_visible = true;
                    }
                }
                crate::tray::TrayEvent::Quit => {
                    self.begin_quit(ctx);
                }
            }
        }

        // Close button: hide to tray by default; otherwise fully quit.
        if !self.quit_requested {
            if ctx.input(|i| i.viewport().close_requested()) {
                if self.tray.is_some() && self.close_to_tray {
                    // CancelClose must be sent the same frame the OS requests close,
                    // otherwise the window enters a half-destroyed / frozen state.
                    ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
                    ctx.send_viewport_cmd(egui::ViewportCommand::Visible(false));
                    self.main_visible = false;
                } else {
                    // User wants a real quit — tear down tray/notify cleanly.
                    self.begin_quit(ctx);
                }
            }
        }

        if self.quit_requested {
            // Keep asking the main viewport to close until we exit.
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            if let Some(deadline) = self.force_exit_at {
                if std::time::Instant::now() >= deadline {
                    // Last resort: eframe/winit sometimes stalls on multi-viewport close.
                    std::process::exit(0);
                }
            }
            // While quitting, skip painting heavy UI so Drop runs sooner.
            ctx.request_repaint();
            return;
        }

        if self.pending_start_hidden && self.tray.is_some() {
            self.pending_start_hidden = false;
            ctx.send_viewport_cmd(egui::ViewportCommand::Visible(false));
            self.main_visible = false;
        }

        // When hidden in the tray, throttle paints — still poll tray + notify.
        if !self.main_visible {
            self.poll_bg(ctx);
            self.sync_notify_config();
            if let Some(notify) = &self.notify {
                while let Some(ev) = notify.poll() {
                    self.toast_queue.push_back(ev);
                }
            }
            let now = now_secs();
            if self.current_toast.is_none() && !self.toast_queue.is_empty() {
                self.advance_toast();
            }
            if let Some(_t) = &self.current_toast {
                if now - self.toast_shown_at > TOAST_DURATION {
                    self.dismiss_current_toast();
                }
            }
            self.render_toast_viewport(ctx);
            ctx.request_repaint_after(std::time::Duration::from_millis(400));
            return;
        }

        // --- Notification toasts from the watcher ---
        if let Some(notify) = &self.notify {
            while let Some(ev) = notify.poll() {
                self.toast_queue.push_back(ev);
            }
        }
        let now = now_secs();
        if self.current_toast.is_none() && !self.toast_queue.is_empty() {
            self.advance_toast();
        }
        if let Some(_t) = &self.current_toast {
            if now - self.toast_shown_at > TOAST_DURATION {
                self.dismiss_current_toast();
            }
        }
        self.render_toast_viewport(ctx);
        if self.current_toast.is_some() || !self.toast_queue.is_empty() {
            ctx.request_repaint_after(std::time::Duration::from_millis(200));
        }

        // Toasts
        egui::Area::new(egui::Id::new("toasts"))
            .anchor(egui::Align2::RIGHT_TOP, [-16.0, 16.0])
            .order(egui::Order::Foreground)
            .show(ctx, |ui| {
                ui.set_max_width(340.0);
                for t in &self.toasts {
                    Frame::new()
                        .fill(PANEL)
                        .stroke(Stroke::new(1.0, LINE_STRONG))
                        .corner_radius(CornerRadius::same(10))
                        .inner_margin(Margin::same(12))
                        .show(ui, |ui| {
                            let color = match t.kind {
                                0 => TEXT,
                                1 => Color32::from_rgb(255, 200, 200),
                                _ => TEXT_DIM,
                            };
                            ui.label(RichText::new(&t.title).color(color).size(14.0).strong());
                            if !t.body.is_empty() {
                                ui.add_space(4.0);
                                ui.label(RichText::new(&t.body).color(TEXT_DIM).size(13.0));
                            }
                        });
                    ui.add_space(8.0);
                }
            });

        egui::TopBottomPanel::top("top")
            .exact_height(76.0)
            .frame(
                Frame::new()
                    .fill(BG)
                    .inner_margin(Margin::symmetric(36, 12))
                    .stroke(Stroke::new(1.0_f32, LINE)),
            )
            .show(ctx, |ui| {
                ui.horizontal_centered(|ui| {
                    ui.vertical(|ui| {
                        ui.set_min_width(150.0);
                        ui.label(
                            RichText::new("WEPORT")
                                .size(17.0)
                                .strong()
                                .color(TEXT)
                                .extra_letter_spacing(1.5),
                        );
                        ui.label(
                            RichText::new(format!("v{APP_VERSION}"))
                                .size(12.5)
                                .color(TEXT_FAINT),
                        );
                    });
                    ui.add_space(22.0);
                    for mode in [
                        AppMode::Connect,
                        AppMode::Export,
                        AppMode::AntiRecall,
                        AppMode::Notifications,
                    ] {
                        let selected = self.mode == mode;
                        let fill = if selected { TEXT } else { ELEVATED };
                        let fg = if selected { BG } else { TEXT_DIM };
                        let resp = Frame::new()
                            .fill(fill)
                            .stroke(Stroke::new(1.0, if selected { TEXT } else { LINE }))
                            .corner_radius(CornerRadius::same(R))
                            .inner_margin(Margin::symmetric(12, 8))
                            .show(ui, |ui| {
                                ui.set_min_size(Vec2::new(118.0, 42.0));
                                ui.horizontal_centered(|ui| {
                                    icons::mode_icon(ui, mode, fg);
                                    ui.add_space(6.0);
                                    ui.label(RichText::new(mode.label()).size(14.0).color(fg));
                                });
                            })
                            .response
                            .interact(Sense::click());
                        if resp.clicked() {
                            self.mode = mode;
                        }
                        ui.add_space(6.0);
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let settings_resp = Frame::new()
                            .fill(ELEVATED)
                            .stroke(Stroke::new(1.0, LINE))
                            .corner_radius(CornerRadius::same(R))
                            .inner_margin(Margin::symmetric(12, 6))
                            .show(ui, |ui| {
                                ui.set_min_size(Vec2::new(96.0, 40.0));
                                ui.horizontal_centered(|ui| {
                                    icons::gear(ui, TEXT_DIM, 16.0);
                                    ui.add_space(6.0);
                                    ui.label(RichText::new("设置").size(14.0).color(TEXT_DIM));
                                });
                            })
                            .response
                            .interact(Sense::click());
                        if settings_resp.clicked() {
                            self.settings_open = true;
                        }
                        ui.add_space(8.0);
                        if icons::github_button(ui).clicked() {
                            if let Err(e) = open::that(GITHUB_URL) {
                                self.push_toast(1, "无法打开 GitHub", e.to_string(), 6.0);
                            }
                        }
                    });
                });
            });

        if let Some((ver, notes)) = self.update_info.clone() {
            egui::TopBottomPanel::top("update")
                .frame(
                    Frame::new()
                        .fill(ELEVATED)
                        .inner_margin(Margin::symmetric(10, 6))
                        .stroke(Stroke::new(1.0_f32, LINE_STRONG)),
                )
                .show(ctx, |ui| {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.label(
                                RichText::new(format!("发现新版本 v{ver}"))
                                    .size(13.5)
                                    .strong(),
                            );
                            if !notes.is_empty() {
                                ui.label(
                                    RichText::new(notes.chars().take(100).collect::<String>())
                                        .size(12.0)
                                        .color(TEXT_DIM),
                                );
                            }
                        });
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui
                                .add_enabled(
                                    !self.busy,
                                    egui::Button::new(RichText::new("立即更新").size(13.0).color(BG))
                                        .fill(TEXT)
                                        .corner_radius(R)
                                        .min_size(Vec2::new(88.0, 30.0)),
                                )
                                .clicked()
                            {
                                self.spawn_update_install();
                            }
                        });
                    });
                });
        }

        egui::CentralPanel::default()
            .frame(Frame::new().fill(BG).inner_margin(Margin::symmetric(40, 26)))
            .show(ctx, |ui| {
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        ui.set_min_width(ui.available_width());
                        match self.mode {
                            AppMode::Connect => self.ui_connect(ui),
                            AppMode::Export => self.ui_export(ui),
                            AppMode::AntiRecall => self.ui_antirecall(ui),
                            AppMode::Notifications => self.ui_notifications(ui),
                        }
                    });
            });

        self.ui_modals(ctx);
    }
}

impl WeportApp {
    /// Top-right always-on-top toast window (egui secondary viewport).
    fn render_toast_viewport(&mut self, ctx: &egui::Context) {
        let builder = egui::ViewportBuilder::default()
            .with_title("WeportToast")
            .with_inner_size([TOAST_W, TOAST_H])
            .with_min_inner_size([TOAST_W, TOAST_H])
            .with_max_inner_size([TOAST_W, TOAST_H])
            .with_resizable(false)
            .with_decorations(false)
            .with_transparent(true)
            .with_always_on_top()
            .with_taskbar(false);

        let toast = self.current_toast.clone();
        let mut dismiss = false;
        let (wx, wy, ww, _wh) = primary_work_area();
        let pos = [wx + ww - TOAST_W - 20.0, wy + 20.0];

        ctx.show_viewport_immediate(toast_vp_id(), builder, |vctx, class| {
            vctx.send_viewport_cmd(egui::ViewportCommand::Transparent(true));
            if let Some(t) = &toast {
                vctx.send_viewport_cmd(egui::ViewportCommand::Visible(true));
                vctx.send_viewport_cmd(egui::ViewportCommand::MousePassthrough(false));
                vctx.send_viewport_cmd(egui::ViewportCommand::OuterPosition(egui::Pos2::new(
                    pos[0],
                    pos[1],
                )));

                egui::CentralPanel::default()
                    .frame(Frame::NONE.fill(Color32::TRANSPARENT))
                    .show(vctx, |ui| {
                        let accent = match t.kind {
                            NotifyKind::Recalled => Color32::from_rgb(255, 190, 120),
                            NotifyKind::NewMessage => TEXT,
                        };
                        let card = Frame::new()
                            .fill(PANEL)
                            .stroke(Stroke::new(1.0, LINE_STRONG))
                            .corner_radius(CornerRadius::same(12))
                            .inner_margin(Margin::symmetric(14, 10));
                        let resp = card
                            .show(ui, |ui| {
                                ui.set_min_width(TOAST_W - 28.0);
                                ui.horizontal(|ui| {
                                    let kind_label = match t.kind {
                                        NotifyKind::NewMessage => "新消息",
                                        NotifyKind::Recalled => "撤回提醒",
                                    };
                                    ui.label(
                                        RichText::new(kind_label)
                                            .size(11.5)
                                            .strong()
                                            .color(accent),
                                    );
                                    ui.with_layout(
                                        egui::Layout::right_to_left(egui::Align::Center),
                                        |ui| {
                                            ui.label(
                                                RichText::new("点击关闭")
                                                    .size(10.5)
                                                    .color(TEXT_FAINT),
                                            );
                                        },
                                    );
                                });
                                ui.add_space(2.0);
                                ui.label(
                                    RichText::new(&t.title)
                                        .size(14.5)
                                        .strong()
                                        .color(TEXT),
                                );
                                ui.add_space(3.0);
                                let body = if t.content.chars().count() > 60 {
                                    let mut s: String = t.content.chars().take(60).collect();
                                    s.push('…');
                                    s
                                } else {
                                    t.content.clone()
                                };
                                ui.label(
                                    RichText::new(body).size(12.5).color(TEXT_DIM),
                                );
                            })
                            .response;
                        if resp.clicked() {
                            dismiss = true;
                        }
                    });
            } else {
                vctx.send_viewport_cmd(egui::ViewportCommand::Visible(false));
                vctx.send_viewport_cmd(egui::ViewportCommand::MousePassthrough(true));
                if class == egui::ViewportClass::Embedded {
                    // Fallback (no multi-viewport backend): nothing to show.
                }
            }
        });
        if dismiss {
            self.dismiss_current_toast();
        }
    }

    fn section_title(&self, ui: &mut egui::Ui, title: &str, right: &str) {
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(title)
                    .size(14.0)
                    .strong()
                    .color(TEXT)
                    .extra_letter_spacing(0.8),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.label(RichText::new(right).size(12.0).color(TEXT_FAINT));
            });
        });
        ui.add_space(7.0);
        let y = ui.cursor().top();
        ui.painter().hline(
            ui.max_rect().x_range(),
            y,
            Stroke::new(1.0_f32, LINE),
        );
        ui.add_space(13.0);
    }

    fn ui_connect(&mut self, ui: &mut egui::Ui) {
        // Data path and account/key setup share the connection workspace.
        WeportApp::panel_frame().show(ui, |ui| {
            self.section_title(ui, "数据位置", "xwechat_files");
            ui.horizontal(|ui| {
                icons::folder(ui, TEXT_FAINT, 16.0);
                ui.add_space(6.0);
                ui.label(RichText::new("数据文件夹").size(12.5).color(TEXT_FAINT));
                let resp = ui.add(
                    egui::TextEdit::singleline(&mut self.db_path)
                        .desired_width(ui.available_width() - 88.0)
                        .font(FontId::new(14.0, FontFamily::Monospace))
                        .hint_text(r"C:\Users\…\xwechat_files")
                        .margin(Margin::symmetric(10, 7)),
                );
                if resp.lost_focus() {
                    self.persist();
                    self.spawn_scan_accounts();
                }
                if ui
                    .add_enabled(
                        !self.busy,
                        egui::Button::new(RichText::new("浏览").size(14.0))
                            .corner_radius(R)
                            .min_size(Vec2::new(72.0, 36.0)),
                    )
                    .clicked()
                {
                    if let Some(p) = rfd::FileDialog::new()
                        .set_title("选择微信数据目录 (xwechat_files)")
                        .pick_folder()
                    {
                        self.db_path = p.display().to_string();
                        self.persist();
                        self.spawn_scan_accounts();
                    }
                }
            });
            ui.add_space(10.0);
            ui.horizontal(|ui| {
                let scan_resp = Frame::new()
                    .fill(ELEVATED)
                    .stroke(Stroke::new(1.0, LINE))
                    .corner_radius(CornerRadius::same(R))
                    .inner_margin(Margin::symmetric(12, 7))
                    .show(ui, |ui| {
                        ui.set_min_size(Vec2::new(120.0, 36.0));
                        ui.add_enabled_ui(!self.busy, |ui| {
                            ui.horizontal_centered(|ui| {
                                icons::refresh(ui, TEXT_DIM, 15.0);
                                ui.add_space(6.0);
                                ui.label(RichText::new("重新扫描").size(14.0).color(TEXT_DIM));
                            });
                        });
                    })
                    .response
                    .interact(Sense::click());
                if scan_resp.clicked() && !self.busy {
                    self.spawn_detect();
                }
                ui.add_space(8.0);
                let refresh_resp = Frame::new()
                    .fill(ELEVATED)
                    .stroke(Stroke::new(1.0, LINE))
                    .corner_radius(CornerRadius::same(R))
                    .inner_margin(Margin::symmetric(12, 7))
                    .show(ui, |ui| {
                        ui.set_min_size(Vec2::new(120.0, 36.0));
                        ui.add_enabled_ui(!self.busy && !self.db_path.trim().is_empty(), |ui| {
                            ui.horizontal_centered(|ui| {
                                icons::database(ui, TEXT_DIM, 15.0);
                                ui.add_space(6.0);
                                ui.label(RichText::new("刷新账号").size(14.0).color(TEXT_DIM));
                            });
                        });
                    })
                    .response
                    .interact(Sense::click());
                if refresh_resp.clicked() && !self.busy && !self.db_path.trim().is_empty() {
                    self.spawn_scan_accounts();
                }
            });
        });

        ui.add_space(18.0);

        // Accounts — name + wxid on one line
        WeportApp::panel_frame().show(ui, |ui| {
            let n = self.accounts.len();
            self.section_title(
                ui,
                "账号",
                if n > 0 {
                    format!("{n} 个")
                } else {
                    "—".into()
                }
                .as_str(),
            );
            if self.accounts.is_empty() {
                ui.label(
                    RichText::new("选择或扫描数据目录后显示账号")
                        .size(13.0)
                        .color(TEXT_FAINT),
                );
            } else {
                egui::ScrollArea::vertical()
                    .max_height(220.0)
                    .show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 6.0;
                        for acc in self.accounts.clone() {
                            let active = acc.wxid == self.selected_wxid;
                            let fill = if active { TEXT } else { ELEVATED };
                            let fg = if active { BG } else { TEXT };
                            let dim = if active {
                                Color32::from_rgb(80, 80, 80)
                            } else {
                                TEXT_FAINT
                            };
                            let name = acc
                                .nickname
                                .clone()
                                .filter(|s| !s.is_empty())
                                .unwrap_or_else(|| acc.wxid.clone());
                            let resp = Frame::new()
                                .fill(fill)
                                .stroke(Stroke::new(
                                    1.0_f32,
                                    if active { TEXT } else { LINE },
                                ))
                                .corner_radius(CornerRadius::same(8))
                                .inner_margin(Margin::symmetric(10, 7))
                                .show(ui, |ui| {
                                    ui.set_min_width(ui.available_width());
                                    ui.horizontal(|ui| {
                                        ui.label(
                                            RichText::new(&name)
                                                .size(14.0)
                                                .strong()
                                                .color(fg),
                                        );
                                        ui.label(
                                            RichText::new(&acc.wxid)
                                                .size(13.0)
                                                .color(dim)
                                                .family(FontFamily::Monospace),
                                        );
                                        ui.with_layout(
                                            egui::Layout::right_to_left(egui::Align::Center),
                                            |ui| {
                                                ui.label(
                                                    RichText::new(if active { "当前" } else { "选择" })
                                                        .size(11.5)
                                                        .color(if active { BG } else { TEXT_FAINT }),
                                                );
                                            },
                                        );
                                    });
                                })
                                .response
                                .interact(Sense::click());
                            if resp.clicked() && !self.busy {
                                self.select_account(&acc.wxid);
                            }
                        }
                    });
            }
        });

        ui.add_space(18.0);

        // Key — compact steps
        WeportApp::panel_frame().show(ui, |ui| {
            let key_ok = self.decrypt_key.trim().len() == 64;
            self.section_title(ui, "解密密钥", if key_ok { "已就绪" } else { "待提取" });
            for (i, line) in [
                "打开微信并关闭「自动登录」",
                "点「提取密钥」，就绪后重新登录微信",
                "密钥自动填入，或粘贴 64 位十六进制",
            ]
            .iter()
            .enumerate()
            {
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new(format!("{}.", i + 1))
                            .size(12.5)
                            .strong()
                            .color(TEXT_DIM),
                    );
                    ui.label(RichText::new(*line).size(13.0).color(TEXT_DIM));
                });
            }
            if self.key_ready_hint && self.busy {
                ui.add_space(4.0);
                Frame::new()
                    .fill(ELEVATED)
                    .stroke(Stroke::new(1.0_f32, LINE_STRONG))
                    .corner_radius(CornerRadius::same(6))
                    .inner_margin(Margin::symmetric(8, 6))
                    .show(ui, |ui| {
                        ui.label(
                            RichText::new("Hook 已就绪 — 请现在登录/重新登录微信")
                                .size(13.0)
                                .color(TEXT),
                        );
                    });
            }
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                icons::key(ui, TEXT_FAINT, 15.0);
                ui.add_space(6.0);
                ui.label(RichText::new("密钥").size(12.5).color(TEXT_FAINT));
                let mut te = egui::TextEdit::singleline(&mut self.decrypt_key)
                    .desired_width(ui.available_width() - 80.0)
                    .font(FontId::new(13.0, FontFamily::Monospace))
                    .hint_text("64 位十六进制…")
                    .margin(Margin::symmetric(8, 5));
                if !self.show_key {
                    te = te.password(true);
                }
                if ui.add(te).changed() {
                    self.persist();
                }
                let eye_resp = Frame::new()
                    .fill(ELEVATED)
                    .stroke(Stroke::new(1.0, LINE))
                    .corner_radius(CornerRadius::same(R))
                    .inner_margin(Margin::symmetric(8, 4))
                    .show(ui, |ui| {
                        ui.set_min_size(Vec2::new(36.0, 28.0));
                        icons::eye(ui, TEXT_DIM, 16.0, self.show_key);
                    })
                    .response
                    .interact(Sense::click());
                if eye_resp.clicked() {
                    self.show_key = !self.show_key;
                }
            });
            ui.add_space(6.0);
            if ui
                .add_enabled(
                    !self.busy,
                    egui::Button::new(
                        RichText::new(if self.busy && self.progress.is_none() {
                            "提取中…"
                        } else {
                            "  提取密钥"
                        })
                        .size(14.0)
                        .color(BG),
                    )
                    .corner_radius(R)
                    .min_size(Vec2::new(ui.available_width(), 38.0))
                    .fill(TEXT)
                    .stroke(Stroke::new(1.0_f32, TEXT)),
                )
                .clicked()
            {
                self.spawn_extract_key();
            }
            ui.add_space(2.0);
            if key_ok {
                ui.label(RichText::new("密钥已就绪，可在右侧导出。").size(12.5).color(TEXT));
            } else {
                ui.label(
                    RichText::new("密钥在登录瞬间捕获，非已登录会话直读。")
                        .size(12.0)
                        .color(TEXT_FAINT),
                );
            }
        });
    }

    fn ui_export(&mut self, ui: &mut egui::Ui) {
        let min_height = ui.available_height().max(460.0);
        WeportApp::panel_frame().show(ui, |ui| {
            ui.set_min_height(min_height - 48.0);
            self.section_title(ui, "导出", "全部联系人 + 群聊");

            ui.horizontal(|ui| {
                ui.label(RichText::new("格式").size(12.5).color(TEXT_FAINT));
                for (id, lab) in [("txt", "TXT"), ("json", "JSON")] {
                    let active = self.format == id;
                    let fill = if active { TEXT } else { ELEVATED };
                    let fg = if active { BG } else { TEXT_DIM };
                    if ui
                        .add(
                            egui::Button::new(RichText::new(lab).size(13.5).color(fg))
                                .fill(fill)
                                .stroke(Stroke::new(1.0_f32, if active { TEXT } else { LINE }))
                                .corner_radius(R)
                                .min_size(Vec2::new(72.0, 30.0)),
                        )
                        .clicked()
                        && !self.busy
                    {
                        self.format = id.into();
                        self.persist();
                    }
                }
            });

            ui.add_space(6.0);
            ui.horizontal(|ui| {
                icons::folder(ui, TEXT_FAINT, 15.0);
                ui.add_space(6.0);
                ui.label(RichText::new("输出").size(12.5).color(TEXT_FAINT));
                if ui
                    .add(
                        egui::TextEdit::singleline(&mut self.export_path)
                            .desired_width(ui.available_width() - 88.0)
                            .font(FontId::new(13.0, FontFamily::Monospace))
                            .hint_text("导出根目录…")
                            .margin(Margin::symmetric(8, 5)),
                    )
                    .changed()
                {
                    self.persist();
                    self.refresh_export_log();
                }
                if ui
                    .add_enabled(
                        !self.busy,
                        egui::Button::new(RichText::new("浏览").size(13.0))
                            .corner_radius(R)
                            .min_size(Vec2::new(72.0, 32.0)),
                    )
                    .clicked()
                {
                    if let Some(p) = rfd::FileDialog::new()
                        .set_title("选择导出输出文件夹")
                        .pick_folder()
                    {
                        self.export_path = p.display().to_string();
                        self.persist();
                        self.refresh_export_log();
                    }
                }
            });

            let folder = if self.format == "json" { "JSON" } else { "TXT" };
            ui.add_space(5.0);
            ui.label(
                RichText::new(format!(
                    "写入 {folder}/，同名覆盖 · 群聊_名称 / 私聊_名称"
                ))
                .size(12.0)
                .color(TEXT_FAINT),
            );

            ui.add_space(6.0);
            Frame::new()
                .fill(ELEVATED)
                .stroke(Stroke::new(1.0_f32, LINE))
                .corner_radius(CornerRadius::same(8))
                .inner_margin(Margin::symmetric(8, 6))
                .show(ui, |ui| {
                    row_meta(ui, "上次 TXT", self.export_log_txt.as_deref().unwrap_or("尚未导出"));
                    row_meta(ui, "上次 JSON", self.export_log_json.as_deref().unwrap_or("尚未导出"));
                    row_meta(ui, "日志", "export_log.txt");
                });

            if let Some((cur, total, session, phase)) = &self.progress {
                ui.add_space(6.0);
                let pct = if *total > 0.0 {
                    (*cur / *total).clamp(0.0, 1.0) as f32
                } else if phase == "完成" {
                    1.0
                } else {
                    0.0
                };
                let bar = ui.available_width();
                let (_, rect) = ui.allocate_space(Vec2::new(bar, 6.0));
                ui.painter()
                    .rect_filled(rect, CornerRadius::same(3), Color32::from_rgb(40, 40, 40));
                let mut fill = rect;
                fill.set_width(rect.width() * pct);
                ui.painter()
                    .rect_filled(fill, CornerRadius::same(3), TEXT);
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new(if session.is_empty() {
                            phase.as_str()
                        } else {
                            session.as_str()
                        })
                        .size(12.5)
                        .color(TEXT_DIM),
                    );
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if *total > 0.0 {
                            ui.label(
                                RichText::new(format!("{:.0} / {:.0}", cur.min(*total), total))
                                    .size(12.5)
                                    .color(TEXT_FAINT),
                            );
                        }
                    });
                });
            }

            ui.add_space(8.0);
            let export_label = if self.busy && self.progress.is_some() {
                "导出中…"
            } else {
                "导出全部聊天记录"
            };
            if ui
                .add_enabled(
                    !self.busy,
                    egui::Button::new(RichText::new(export_label).size(14.5).color(BG))
                        .fill(TEXT)
                        .stroke(Stroke::new(1.0_f32, TEXT))
                        .corner_radius(R)
                        .min_size(Vec2::new(ui.available_width(), 38.0)),
                )
                .clicked()
            {
                self.spawn_export();
            }
            ui.add_space(4.0);
            if ui
                .add_enabled(
                    !self.busy && !self.export_path.trim().is_empty(),
                    egui::Button::new(RichText::new("清空导出库").size(13.0))
                        .corner_radius(R)
                        .min_size(Vec2::new(ui.available_width(), 32.0)),
                )
                .clicked()
            {
                self.clear_open = true;
            }
            ui.add_space(3.0);
            ui.label(
                RichText::new("清空删除 TXT/、JSON/、export_log.txt；数据仅本地处理。")
                    .size(11.5)
                    .color(TEXT_FAINT),
            );
        });
    }

    fn ui_antirecall(&mut self, ui: &mut egui::Ui) {
        let status = self
            .anti_state
            .clone()
            .unwrap_or_else(|| "检测中…".to_string());
        let status_color = if status.contains("已安装") {
            Color32::from_rgb(160, 255, 170)
        } else if status == "未安装" {
            Color32::from_rgb(255, 210, 130)
        } else {
            TEXT_DIM
        };
        let install = self.anti_install.clone();
        let min_height = ui.available_height().max(460.0);

        WeportApp::panel_frame().show(ui, |ui| {
            ui.set_min_height(min_height - 48.0);
            self.section_title(ui, "安装防撤回", "微信 4");
            ui.label(
                RichText::new("让撤回的消息继续保留在微信聊天窗口中")
                    .size(21.0)
                    .strong()
                    .color(TEXT),
            );
            ui.add_space(8.0);
            ui.label(
                RichText::new("补丁只修改微信 4 的 Weixin.dll，不会读取或上传聊天内容。")
                    .size(15.0)
                    .color(TEXT_DIM),
            );
            ui.add_space(22.0);

            Frame::new()
                .fill(ELEVATED)
                .stroke(Stroke::new(1.0, LINE))
                .corner_radius(CornerRadius::same(10))
                .inner_margin(Margin::symmetric(16, 14))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("当前状态").size(15.0).color(TEXT_DIM));
                        ui.label(RichText::new(&status).size(16.0).strong().color(status_color));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui
                                .add_enabled(
                                    !self.anti_busy,
                                    egui::Button::new("刷新状态")
                                        .corner_radius(R)
                                        .min_size(Vec2::new(100.0, 34.0)),
                                )
                                .clicked()
                            {
                                self.spawn_antirecall_status();
                            }
                        });
                    });
                    if let Some(path) = &install {
                        ui.add_space(10.0);
                        ui.label(
                            RichText::new(format!("微信安装目录：{path}"))
                                .size(13.5)
                                .color(TEXT_FAINT)
                                .family(FontFamily::Monospace),
                        );
                    }
                });

            ui.add_space(24.0);
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(
                        !self.anti_busy && install.is_some(),
                        egui::Button::new(
                            RichText::new(if self.anti_busy { "处理中…" } else { "安装防撤回补丁" })
                                .size(16.0)
                                .color(BG),
                        )
                        .fill(TEXT)
                        .stroke(Stroke::new(1.0, TEXT))
                        .corner_radius(R)
                        .min_size(Vec2::new(190.0, 48.0)),
                    )
                    .clicked()
                {
                    self.anti_recall_enabled = true;
                    self.spawn_antirecall_action(true);
                    self.persist();
                }
                if ui
                    .add_enabled(
                        !self.anti_busy && install.is_some(),
                        egui::Button::new(RichText::new("还原补丁").size(15.0))
                            .corner_radius(R)
                            .min_size(Vec2::new(140.0, 48.0)),
                    )
                    .clicked()
                {
                    self.anti_recall_enabled = false;
                    self.spawn_antirecall_action(false);
                    self.persist();
                }
            });

            ui.add_space(22.0);
            Frame::new()
                .fill(PANEL)
                .stroke(Stroke::new(1.0, LINE))
                .corner_radius(CornerRadius::same(10))
                .inner_margin(Margin::symmetric(16, 14))
                .show(ui, |ui| {
                    ui.label(RichText::new("使用前请注意").size(15.0).strong().color(TEXT));
                    ui.add_space(8.0);
                    for line in [
                        "安装和还原需要管理员权限（UAC）。",
                        "操作前请完全退出微信；微信运行时补丁不会执行。",
                        "微信更新后可能需要重新安装补丁。",
                    ] {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new("•").size(16.0).color(TEXT_DIM));
                            ui.label(RichText::new(line).size(14.0).color(TEXT_DIM));
                        });
                    }
                });
        });
    }

    fn ui_notifications(&mut self, ui: &mut egui::Ui) {
        let db_ready = !self.db_path.trim().is_empty();
        let account_ready = !self.selected_wxid.is_empty();
        let key_ready = self.decrypt_key.trim().len() == 64;
        let all_ready = db_ready && account_ready && key_ready;
        let mut toggled = false;
        let min_height = ui.available_height().max(460.0);

        WeportApp::panel_frame().show(ui, |ui| {
            ui.set_min_height(min_height - 48.0);
            self.section_title(ui, "消息提醒", "屏幕右上角");
            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    ui.label(
                        RichText::new("及时看到新消息与撤回提醒")
                            .size(21.0)
                            .strong()
                            .color(TEXT),
                    );
                    ui.add_space(6.0);
                    ui.label(
                        RichText::new("提醒不会抢焦点；消息内容只在本机解密和显示。")
                            .size(15.0)
                            .color(TEXT_DIM),
                    );
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    toggled |= ui
                        .checkbox(&mut self.notifications_enabled, "启用消息提醒")
                        .changed();
                });
            });

            ui.add_space(24.0);
            Frame::new()
                .fill(ELEVATED)
                .stroke(Stroke::new(1.0, LINE))
                .corner_radius(CornerRadius::same(10))
                .inner_margin(Margin::symmetric(16, 14))
                .show(ui, |ui| {
                    ui.label(RichText::new("提醒条件").size(15.0).strong().color(TEXT));
                    ui.add_space(10.0);
                    for (label, ok, detail) in [
                        ("数据目录", db_ready, if db_ready { "已连接" } else { "未选择" }),
                        ("微信账号", account_ready, if account_ready { "已选择" } else { "未选择" }),
                        ("解密密钥", key_ready, if key_ready { "已就绪" } else { "待提取" }),
                    ] {
                        ui.horizontal(|ui| {
                            if ok {
                                icons::check(ui, TEXT, 16.0);
                            } else {
                                ui.label(
                                    RichText::new("—")
                                        .size(16.0)
                                        .strong()
                                        .color(TEXT_FAINT),
                                );
                            }
                            ui.add_space(4.0);
                            ui.label(RichText::new(label).size(15.0).color(TEXT_DIM));
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                ui.label(RichText::new(detail).size(14.0).color(if ok { TEXT } else { TEXT_FAINT }));
                            });
                        });
                        ui.add_space(4.0);
                    }
                });

            ui.add_space(24.0);
            let state = if !self.notifications_enabled {
                "消息提醒已关闭"
            } else if all_ready {
                "正在监听当前账号的新消息和撤回事件"
            } else {
                "已开启，完成上面的准备条件后开始监听"
            };
            let state_color = if self.notifications_enabled && all_ready {
                Color32::from_rgb(160, 255, 170)
            } else if self.notifications_enabled {
                Color32::from_rgb(255, 210, 130)
            } else {
                TEXT_DIM
            };
            ui.label(RichText::new(state).size(16.0).strong().color(state_color));
            ui.add_space(8.0);
            ui.label(
                RichText::new("撤回提醒即使没有安装防撤回补丁也可以检测；安装补丁后，撤回的原消息也会继续留在微信里。")
                    .size(14.0)
                    .color(TEXT_FAINT),
            );
        });

        if toggled {
            self.persist();
            self.sync_notify_config();
        }
    }

    fn ui_modals(&mut self, ctx: &egui::Context) {
        if self.settings_open {
            self.ui_settings(ctx);
        }
        if self.clear_open {
            egui::Window::new("清空导出库？")
                .collapsible(false)
                .resizable(false)
                .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
                .frame(
                    Frame::new()
                        .fill(PANEL)
                        .stroke(Stroke::new(1.0, LINE_STRONG))
                        .corner_radius(CornerRadius::same(14))
                        .inner_margin(Margin::same(18)),
                )
                .show(ctx, |ui| {
                    ui.set_min_width(380.0);
                    ui.label(
                        RichText::new("将删除 TXT/、JSON/、export_log.txt（不可恢复）")
                            .size(14.0)
                            .color(TEXT_DIM),
                    );
                    if !self.export_path.is_empty() {
                        ui.add_space(6.0);
                        ui.label(
                            RichText::new(format!("根目录：{}", self.export_path))
                                .size(13.0)
                                .color(TEXT_FAINT)
                                .family(FontFamily::Monospace),
                        );
                    }
                    ui.add_space(14.0);
                    ui.horizontal(|ui| {
                        if ui
                            .add(egui::Button::new("取消").corner_radius(R).min_size(Vec2::new(100.0, 38.0)))
                            .clicked()
                        {
                            self.clear_open = false;
                        }
                        if ui
                            .add_enabled(
                                !self.busy,
                                egui::Button::new(if self.busy { "清空中…" } else { "确认清空" })
                                    .corner_radius(R)
                                    .min_size(Vec2::new(120.0, 38.0))
                                    .fill(TEXT)
                                    .stroke(Stroke::new(1.0, TEXT)),
                            )
                            .clicked()
                        {
                            self.spawn_clear();
                        }
                    });
                });
        }

    }
}

impl WeportApp {
    /// Settings modal: startup / tray behavior and application updates.
    fn ui_settings(&mut self, ctx: &egui::Context) {
        let mut startup_toggled = false;
        let mut bg_toggled = false;
        let mut tray_toggled = false;

        egui::Window::new("设置")
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
            .frame(
                Frame::new()
                    .fill(PANEL)
                    .stroke(Stroke::new(1.0, LINE_STRONG))
                    .corner_radius(CornerRadius::same(14))
                    .inner_margin(Margin::same(18)),
            )
            .show(ctx, |ui| {
                ui.set_min_width(520.0);

                // --- Startup & tray ---
                WeportApp::settings_section(ui, "启动与托盘");
                startup_toggled |= ui
                    .checkbox(&mut self.launch_at_startup, "开机时自动启动 Weport")
                    .changed();
                ui.label(
                    RichText::new("写入当前用户注册表 Run 项（HKCU），无需管理员权限")
                        .size(11.5)
                        .color(TEXT_FAINT),
                );
                bg_toggled |= ui
                    .checkbox(&mut self.start_in_background, "启动后隐藏到托盘（后台运行）")
                    .changed();
                tray_toggled |= ui
                    .checkbox(&mut self.close_to_tray, "关闭窗口时最小化到托盘而不是退出")
                    .changed();
                if self.tray.is_none() {
                    ui.label(
                        RichText::new("当前系统无法创建托盘图标，后台/托盘功能不可用")
                            .size(11.5)
                            .color(Color32::from_rgb(255, 200, 200)),
                    );
                }

                ui.add_space(20.0);
                WeportApp::settings_section(ui, "版本与更新");
                ui.horizontal(|ui| {
                    ui.label(RichText::new("当前版本").size(15.0).color(TEXT_DIM));
                    ui.label(RichText::new(format!("v{APP_VERSION}")).size(15.0).strong().color(TEXT));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(RichText::new("GitHub Releases").size(13.0).color(TEXT_FAINT));
                    });
                });
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    if ui
                        .add_enabled(
                            !self.busy,
                            egui::Button::new("检查更新")
                                .corner_radius(R)
                                .min_size(Vec2::new(120.0, 38.0)),
                        )
                        .clicked()
                    {
                        self.spawn_update_check(true);
                    }
                    if let Some((ver, _)) = &self.update_info {
                        if ui
                            .add_enabled(
                                !self.busy,
                                egui::Button::new(format!("安装 v{ver}"))
                                    .corner_radius(R)
                                    .fill(TEXT)
                                    .stroke(Stroke::new(1.0, TEXT))
                                    .min_size(Vec2::new(140.0, 38.0)),
                            )
                            .clicked()
                        {
                            self.spawn_update_install();
                        }
                    }
                });
                ui.label(
                    RichText::new("版本检查和安装通过 GitHub Releases 完成。")
                        .size(13.0)
                        .color(TEXT_FAINT),
                );

                ui.add_space(20.0);
                ui.horizontal(|ui| {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui
                            .add(egui::Button::new("关闭").corner_radius(R).min_size(Vec2::new(90.0, 34.0)))
                            .clicked()
                        {
                            self.settings_open = false;
                        }
                    });
                });
            });

        if startup_toggled {
            let enabled = self.launch_at_startup;
            match startup::set_run_at_startup(enabled) {
                Ok(()) => {
                    self.launch_at_startup = enabled;
                    self.push_toast(
                        0,
                        if enabled { "已设置开机自启动" } else { "已取消开机自启动" },
                        "",
                        4.0,
                    );
                }
                Err(e) => {
                    self.launch_at_startup = !enabled;
                    self.push_toast(1, "设置开机自启动失败", e, 8.0);
                }
            }
            self.persist();
        }
        if bg_toggled {
            self.persist();
        }
        if tray_toggled {
            self.persist();
        }
    }

    fn settings_section(ui: &mut egui::Ui, title: &str) {
        ui.label(
            RichText::new(title)
                .size(12.5)
                .strong()
                .color(TEXT)
                .extra_letter_spacing(0.8),
        );
        ui.add_space(3.0);
        let y = ui.cursor().top();
        ui.painter()
            .hline(ui.max_rect().x_range(), y, Stroke::new(1.0_f32, LINE));
        ui.add_space(7.0);
    }
}

fn row_meta(ui: &mut egui::Ui, left: &str, right: &str) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(left).size(12.5).color(TEXT_DIM));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(RichText::new(right).size(12.5).color(TEXT));
        });
    });
}
