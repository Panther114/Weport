//! Native egui shell — SpaceX monochrome, rounded, dense, larger type.
use crate::engine::{self, EngineState};
use crate::export;
use crate::paths::AccountInfo;
use crate::settings::{load_settings, save_settings, AppSettings};
use eframe::egui::{
    self, Color32, CornerRadius, FontData, FontDefinitions, FontFamily, FontId, Frame, Margin,
    RichText, Sense, Stroke, StrokeKind, Vec2,
};
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

const R: u8 = 10;

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
}

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
            Ok(Box::new(WeportApp::new()))
        }),
    )
}

fn load_app_icon() -> Option<egui::IconData> {
    let bytes = include_bytes!("../../assets/icons/logo.webp");
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
    style.spacing.item_spacing = Vec2::new(6.0, 4.0);
    style.spacing.button_padding = Vec2::new(10.0, 5.0);
    style.spacing.indent = 10.0;
    style.spacing.window_margin = Margin::same(10);
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
        FontId::new(15.0, FontFamily::Proportional),
    );
    style.text_styles.insert(
        egui::TextStyle::Button,
        FontId::new(14.0, FontFamily::Proportional),
    );
    style.text_styles.insert(
        egui::TextStyle::Heading,
        FontId::new(18.0, FontFamily::Proportional),
    );
    style.text_styles.insert(
        egui::TextStyle::Small,
        FontId::new(13.0, FontFamily::Proportional),
    );
    style.text_styles.insert(
        egui::TextStyle::Monospace,
        FontId::new(13.5, FontFamily::Monospace),
    );
    ctx.set_style(style);
}

struct Toast {
    kind: u8, // 0 ok 1 err 2 info
    title: String,
    body: String,
    until: f64,
}

struct WeportApp {
    db_path: String,
    export_path: String,
    format: String, // txt | json
    accounts: Vec<AccountInfo>,
    selected_wxid: String,
    decrypt_key: String,
    show_key: bool,
    busy: bool,
    busy_label: String,
    progress: Option<(f64, f64, String, String)>,
    toasts: Vec<Toast>,
    about_open: bool,
    clear_open: bool,
    key_ready_hint: bool,
    export_log_txt: Option<String>,
    export_log_json: Option<String>,
    update_info: Option<(String, String)>,
    tx: Sender<BgMsg>,
    rx: Receiver<BgMsg>,
    engine_busy: Arc<AtomicBool>,
    _engine: Arc<Mutex<EngineState>>,
}

impl WeportApp {
    fn new() -> Self {
        let (tx, rx) = mpsc::channel();
        let s = load_settings();
        let mut app = Self {
            db_path: s.db_path,
            export_path: s.export_path,
            format: if s.format == "json" {
                "json".into()
            } else {
                "txt".into()
            },
            accounts: Vec::new(),
            selected_wxid: s.selected_wxid,
            decrypt_key: s.decrypt_key,
            show_key: false,
            busy: false,
            busy_label: String::new(),
            progress: None,
            toasts: Vec::new(),
            about_open: false,
            clear_open: false,
            key_ready_hint: false,
            export_log_txt: None,
            export_log_json: None,
            update_info: None,
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
        let _ = save_settings(&AppSettings {
            db_path: self.db_path.clone(),
            decrypt_key: self.decrypt_key.clone(),
            export_path: self.export_path.clone(),
            selected_wxid: self.selected_wxid.clone(),
            format: self.format.clone(),
        });
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
                            format!("成功 {n} 个会话 → {folder}/（已覆盖同名）"),
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
                            self.selected_wxid = self.accounts[0].wxid.clone();
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
                    self.push_toast(2, format!("发现新版本 v{ver}"), "可在关于中安装", 6.0);
                }
                BgMsg::UpdateCheck(Ok(None)) => {
                    if self.about_open {
                        self.push_toast(0, "已是最新版本", format!("当前 v{APP_VERSION}"), 4.0);
                    }
                }
                BgMsg::UpdateCheck(Err(e)) => {
                    if self.about_open {
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
            .corner_radius(CornerRadius::same(10))
            .inner_margin(Margin::symmetric(10, 8))
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

fn rounded_button(
    ui: &mut egui::Ui,
    label: &str,
    primary: bool,
    enabled: bool,
) -> egui::Response {
    let desired = Vec2::new(
        ui.available_width().min(280.0).max(88.0),
        40.0,
    );
    let (rect, resp) = ui.allocate_exact_size(
        if primary && ui.available_width() > 200.0 {
            Vec2::new(ui.available_width(), 46.0)
        } else {
            Vec2::new(desired.x.min(ui.available_width()), 40.0)
        },
        Sense::click(),
    );
    let enabled = enabled && !ui.ctx().is_context_menu_open();
    let resp = if enabled {
        resp
    } else {
        resp.on_disabled_hover_text("busy")
    };

    let bg = if !enabled {
        Color32::from_rgb(40, 40, 40)
    } else if primary {
        if resp.hovered() || resp.is_pointer_button_down_on() {
            Color32::from_rgb(230, 230, 230)
        } else {
            TEXT
        }
    } else if resp.hovered() {
        Color32::from_rgb(32, 32, 32)
    } else {
        ELEVATED
    };
    let fg = if primary && enabled { BG } else { TEXT };
    let stroke = if primary {
        Stroke::new(1.0, TEXT)
    } else {
        Stroke::new(1.0, if resp.hovered() { LINE_STRONG } else { LINE })
    };

    ui.painter()
        .rect(rect, CornerRadius::same(R), bg, stroke, StrokeKind::Inside);
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        label,
        FontId::new(if primary { 15.0 } else { 14.0 }, FontFamily::Proportional),
        if enabled {
            fg
        } else {
            TEXT_FAINT
        },
    );
    if enabled {
        resp
    } else {
        resp.interact(Sense::hover())
    }
}

impl eframe::App for WeportApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_bg(ctx);

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
            .exact_height(36.0)
            .frame(
                Frame::new()
                    .fill(BG)
                    .inner_margin(Margin::symmetric(10, 4))
                    .stroke(Stroke::new(1.0_f32, LINE)),
            )
            .show(ctx, |ui| {
                ui.horizontal_centered(|ui| {
                    ui.label(
                        RichText::new("WEPORT")
                            .size(15.0)
                            .strong()
                            .color(TEXT)
                            .extra_letter_spacing(1.5),
                    );
                    ui.label(
                        RichText::new(format!("v{APP_VERSION}"))
                            .size(12.5)
                            .color(TEXT_FAINT),
                    );
                    if !self.busy_label.is_empty() {
                        ui.separator();
                        ui.label(RichText::new(&self.busy_label).size(12.5).color(TEXT_DIM));
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui
                            .add(
                                egui::Button::new(RichText::new("ⓘ 关于").size(13.0))
                                    .corner_radius(R)
                                    .min_size(Vec2::new(0.0, 26.0)),
                            )
                            .clicked()
                        {
                            self.about_open = true;
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
            .frame(Frame::new().fill(BG).inner_margin(Margin::symmetric(8, 6)))
            .show(ctx, |ui| {
                let full = ui.available_size();
                let gap = 8.0;
                let col_w = (full.x - gap) * 0.5;

                ui.horizontal_top(|ui| {
                    // LEFT
                    ui.allocate_ui_with_layout(
                        Vec2::new(col_w, full.y),
                        egui::Layout::top_down(egui::Align::Min),
                        |ui| {
                            self.ui_left(ui);
                        },
                    );
                    ui.add_space(gap);
                    // RIGHT
                    ui.allocate_ui_with_layout(
                        Vec2::new(col_w, full.y),
                        egui::Layout::top_down(egui::Align::Min),
                        |ui| {
                            self.ui_right(ui);
                        },
                    );
                });
            });

        self.ui_modals(ctx);
    }
}

impl WeportApp {
    fn section_title(&self, ui: &mut egui::Ui, title: &str, right: &str) {
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(title)
                    .size(12.5)
                    .strong()
                    .color(TEXT)
                    .extra_letter_spacing(0.8),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.label(RichText::new(right).size(12.0).color(TEXT_FAINT));
            });
        });
        ui.add_space(3.0);
        let y = ui.cursor().top();
        ui.painter().hline(
            ui.max_rect().x_range(),
            y,
            Stroke::new(1.0_f32, LINE),
        );
        ui.add_space(6.0);
    }

    fn ui_left(&mut self, ui: &mut egui::Ui) {
        // Data path — compact
        WeportApp::panel_frame().show(ui, |ui| {
            self.section_title(ui, "数据位置", "xwechat_files");
            ui.horizontal(|ui| {
                ui.label(RichText::new("数据文件夹").size(12.5).color(TEXT_FAINT));
                let resp = ui.add(
                    egui::TextEdit::singleline(&mut self.db_path)
                        .desired_width(ui.available_width() - 70.0)
                        .font(FontId::new(13.0, FontFamily::Monospace))
                        .hint_text(r"C:\Users\…\xwechat_files")
                        .margin(Margin::symmetric(6, 4)),
                );
                if resp.lost_focus() {
                    self.persist();
                    self.spawn_scan_accounts();
                }
                if ui
                    .add_enabled(
                        !self.busy,
                        egui::Button::new(RichText::new("浏览").size(13.0))
                            .corner_radius(R)
                            .min_size(Vec2::new(56.0, 28.0)),
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
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(
                        !self.busy,
                        egui::Button::new(RichText::new("重新扫描").size(13.0))
                            .corner_radius(R)
                            .min_size(Vec2::new(0.0, 28.0)),
                    )
                    .clicked()
                {
                    self.spawn_detect();
                }
                if ui
                    .add_enabled(
                        !self.busy && !self.db_path.trim().is_empty(),
                        egui::Button::new(RichText::new("刷新账号").size(13.0))
                            .corner_radius(R)
                            .min_size(Vec2::new(0.0, 28.0)),
                    )
                    .clicked()
                {
                    self.spawn_scan_accounts();
                }
            });
        });

        ui.add_space(6.0);

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
                    .max_height(140.0)
                    .show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 3.0;
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
                                .inner_margin(Margin::symmetric(8, 5))
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
                                                .size(12.0)
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
                                self.selected_wxid = acc.wxid;
                                self.decrypt_key.clear();
                                self.persist();
                            }
                        }
                    });
            }
        });

        ui.add_space(6.0);

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
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.label(RichText::new("密钥").size(12.5).color(TEXT_FAINT));
                let mut te = egui::TextEdit::singleline(&mut self.decrypt_key)
                    .desired_width(ui.available_width() - 64.0)
                    .font(FontId::new(13.0, FontFamily::Monospace))
                    .hint_text("64 位十六进制…")
                    .margin(Margin::symmetric(6, 4));
                if !self.show_key {
                    te = te.password(true);
                }
                if ui.add(te).changed() {
                    self.persist();
                }
                let lab = if self.show_key { "隐藏" } else { "显示" };
                if ui
                    .add(
                        egui::Button::new(RichText::new(lab).size(13.0))
                            .corner_radius(R)
                            .min_size(Vec2::new(52.0, 28.0)),
                    )
                    .clicked()
                {
                    self.show_key = !self.show_key;
                }
            });
            ui.add_space(4.0);
            if ui
                .add_enabled(
                    !self.busy,
                    egui::Button::new(
                        RichText::new(if self.busy && self.progress.is_none() {
                            "提取中…"
                        } else {
                            "提取密钥"
                        })
                        .size(14.0)
                        .color(BG),
                    )
                    .corner_radius(R)
                    .min_size(Vec2::new(ui.available_width(), 34.0))
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

    fn ui_right(&mut self, ui: &mut egui::Ui) {
        WeportApp::panel_frame().show(ui, |ui| {
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

            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.label(RichText::new("输出").size(12.5).color(TEXT_FAINT));
                if ui
                    .add(
                        egui::TextEdit::singleline(&mut self.export_path)
                            .desired_width(ui.available_width() - 70.0)
                            .font(FontId::new(13.0, FontFamily::Monospace))
                            .hint_text("导出根目录…")
                            .margin(Margin::symmetric(6, 4)),
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
                            .min_size(Vec2::new(56.0, 28.0)),
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
            ui.add_space(3.0);
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

    fn ui_modals(&mut self, ctx: &egui::Context) {
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

        if self.about_open {
            egui::Window::new(format!("Weport v{APP_VERSION}"))
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
                    ui.set_min_width(400.0);
                    ui.label(
                        RichText::new(
                            "轻量原生 WeChat 聊天记录导出。egui 界面，无 WebView。导出 TXT/JSON 至子目录。",
                        )
                        .size(14.0)
                        .color(TEXT_DIM),
                    );
                    ui.add_space(8.0);
                    ui.label(
                        RichText::new("数据仅本地处理。路径与密钥保存在本机。")
                            .size(13.5)
                            .color(TEXT_FAINT),
                    );
                    ui.add_space(6.0);
                    ui.label(
                        RichText::new("更新：GitHub Releases (Panther114/Weport)")
                            .size(12.5)
                            .color(TEXT_FAINT),
                    );
                    ui.add_space(14.0);
                    ui.horizontal(|ui| {
                        if ui
                            .add_enabled(
                                !self.busy,
                                egui::Button::new("检查更新").corner_radius(R).min_size(Vec2::new(110.0, 38.0)),
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
                                        .min_size(Vec2::new(120.0, 38.0)),
                                )
                                .clicked()
                            {
                                self.spawn_update_install();
                            }
                        }
                        if ui
                            .add(egui::Button::new("关闭").corner_radius(R).min_size(Vec2::new(90.0, 38.0)))
                            .clicked()
                        {
                            self.about_open = false;
                        }
                    });
                });
        }
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
