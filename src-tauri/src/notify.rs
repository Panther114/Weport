//! Background WeChat message watcher.
//!
//! Watches the account's DB tree for file changes (mtime polling — WCDB writes
//! WAL/DB files on message arrival), then reads the Session table through the
//! WCDB worker and diffs it against a baseline (lastTimestamp / unreadCount).
//! New incoming messages and recall notices are emitted as [`NotifyEvent`]s
//! for the GUI to show as top-right toasts.
//!
//! Logic mirrors WeFlow's GlobalSessionMonitor / messagePushService
//! (https://github.com/pptfz/WeFlow, MIT) adapted to Rust + the WCDB worker.
use crate::paths::resolve_account_dir;
use crate::wcdb::{WcdbHandle, WCDB_LOCK};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyKind {
    NewMessage,
    Recalled,
}

#[derive(Debug, Clone)]
pub struct NotifyEvent {
    pub kind: NotifyKind,
    #[allow(dead_code)] // payload carried for future navigation / logging
    pub session_id: String,
    pub title: String,
    pub content: String,
    #[allow(dead_code)] // unix seconds; used for ordering/dedup in future versions
    pub timestamp: i64,
}

/// Runtime configuration pushed to the watcher thread.
#[derive(Debug, Clone, Default)]
pub struct NotifyConfig {
    pub enabled: bool,
    pub db_root: String,
    pub wxid: String,
    pub decrypt_key: String,
}

const POLL_INTERVAL: Duration = Duration::from_millis(1500);
const DEBOUNCE: Duration = Duration::from_millis(500);
const GROUP_SUFFIX: &str = "@chatroom";

struct SessionBaseline {
    last_timestamp: i64,
    unread_count: i64,
}

pub struct NotifyService {
    tx: Sender<NotifyConfig>,
    rx: Receiver<NotifyEvent>,
    join: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
}

impl NotifyService {
    pub fn start() -> Self {
        let (cfg_tx, cfg_rx) = mpsc::channel::<NotifyConfig>();
        let (ev_tx, ev_rx) = mpsc::channel::<NotifyEvent>();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let join = std::thread::Builder::new()
            .name("weport-notify".into())
            .spawn(move || run_loop(cfg_rx, ev_tx, stop_clone))
            .ok();
        Self {
            tx: cfg_tx,
            rx: ev_rx,
            join,
            stop,
        }
    }

    /// Push a new configuration (thread-safe, resets baseline on change).
    pub fn configure(&self, cfg: NotifyConfig) {
        let _ = self.tx.send(cfg);
    }

    /// Non-blocking poll for toast events.
    pub fn poll(&self) -> Option<NotifyEvent> {
        self.rx.try_recv().ok()
    }
}

impl NotifyService {
    /// Signal the watcher to stop without joining (safe to call before process exit).
    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for NotifyService {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(join) = self.join.take() {
            // WCDB sync can block; never freeze process exit waiting on it.
            let deadline = std::time::Instant::now() + Duration::from_millis(350);
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

fn run_loop(
    cfg_rx: Receiver<NotifyConfig>,
    ev_tx: Sender<NotifyEvent>,
    stop: Arc<AtomicBool>,
) {
    let mut cfg = NotifyConfig::default();
    let mut db_root: PathBuf = PathBuf::new();
    let mut account_dir: PathBuf = PathBuf::new();
    let mut baseline: HashMap<String, SessionBaseline> = HashMap::new();
    let mut revoke_seen: HashSet<(String, String)> = HashSet::new();
    let mut fingerprint: Option<Vec<(PathBuf, u64)>> = None;
    let mut pending_sync = false;
    let mut changed_at: Option<SystemTime> = None;
    let mut names_cache: HashMap<String, String> = HashMap::new();
    let mut last_heartbeat: Option<SystemTime> = None;

    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }

        // Drain config updates.
        while let Ok(next) = cfg_rx.try_recv() {
            let changed = next.enabled != cfg.enabled
                || next.db_root != cfg.db_root
                || next.wxid != cfg.wxid
                || next.decrypt_key != cfg.decrypt_key;
            if changed {
                baseline.clear();
                revoke_seen.clear();
                fingerprint = None;
                pending_sync = false;
                changed_at = None;
                names_cache.clear();
                db_root = if next.db_root.trim().is_empty() {
                    PathBuf::new()
                } else {
                    PathBuf::from(next.db_root.trim())
                };
                account_dir = resolve_account_dir(&db_root, next.wxid.trim())
                    .unwrap_or_else(|| db_root.clone());
            }
            cfg = next;
        }

        if cfg.enabled && !cfg.db_root.trim().is_empty() && !cfg.wxid.trim().is_empty() {
            let f = db_fingerprint(&account_dir);
            let changed = fingerprint.as_ref() != Some(&f);
            if changed {
                fingerprint = Some(f);
                changed_at = Some(SystemTime::now());
            }
            if let Some(start) = changed_at {
                if start.elapsed().unwrap_or(Duration::ZERO) >= DEBOUNCE {
                    pending_sync = true;
                    changed_at = None;
                }
            }
            // Heartbeat: even if mtime fingerprint stalls (some WCDB writes
            // reuse mtime), re-check sessions periodically so new messages
            // still surface after the first toast.
            let hb_due = match last_heartbeat {
                None => true,
                Some(t) => t.elapsed().unwrap_or(Duration::ZERO) >= Duration::from_secs(3),
            };
            if hb_due {
                pending_sync = true;
                last_heartbeat = Some(SystemTime::now());
            }
            if pending_sync {
                pending_sync = false;
                let events = sync_once(
                    &cfg,
                    &db_root,
                    &account_dir,
                    &mut baseline,
                    &mut revoke_seen,
                    &mut names_cache,
                );
                for ev in events {
                    if ev_tx.send(ev).is_err() {
                        return;
                    }
                }
            }
        }

        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Collect (path, mtime-nanos) pairs under the account DB tree.
fn db_fingerprint(root: &Path) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    if !root.is_dir() {
        return out;
    }
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut depth = 0;
    while let Some(dir) = stack.pop() {
        if depth > 8 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name == "cache" || name == "cache2" || name == "thumbnail" {
                    continue;
                }
                stack.push(p);
            } else if meta.is_file() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.ends_with(".db") || name.ends_with(".db-wal") || name.ends_with(".db-shm")
                {
                    if let Ok(m) = meta.modified() {
                        if let Ok(d) = m.duration_since(SystemTime::UNIX_EPOCH) {
                            out.push((p, d.as_nanos() as u64));
                        }
                    }
                }
            }
        }
        depth += 1;
    }
    out.sort();
    out
}

fn sync_once(
    cfg: &NotifyConfig,
    _db_root: &Path,
    account_dir: &Path,
    baseline: &mut HashMap<String, SessionBaseline>,
    revoke_seen: &mut HashSet<(String, String)>,
    names_cache: &mut HashMap<String, String>,
) -> Vec<NotifyEvent> {
    if cfg.decrypt_key.trim().len() != 64 {
        return Vec::new();
    }
    let root = crate::resource_root::resource_root();
    let key = cfg.decrypt_key.trim().to_string();
    let wxid = cfg.wxid.trim().to_string();

    let _guard = match WCDB_LOCK.lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    let handle = match WcdbHandle::open(&root, account_dir, &key, &wxid) {
        Ok(h) => h,
        Err(_) => return Vec::new(),
    };
    let sessions = match handle.sessions() {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let mut events: Vec<NotifyEvent> = Vec::new();
    let mut next_baseline: HashMap<String, SessionBaseline> = HashMap::new();
    // Sessions where unread grew (incoming messages only — self-sent messages
    // advance lastTimestamp but never increase unreadCount).
    let mut new_msg_candidates: Vec<Value> = Vec::new();
    // Sessions with any timestamp activity (for revoke scanning — revokes can
    // arrive without growing unread, e.g. the other side recalls a message).
    let mut revoke_candidates: Vec<Value> = Vec::new();
    // First successful sync only seeds the baseline — avoids a flood of
    // "historical unread" toasts, and ensures subsequent unread bumps fire.
    let seeding = baseline.is_empty();

    for row in &sessions {
        let username = field_str(row, &["username", "userName", "sessionId", "user_name"]);
        if username.is_empty() || username.to_lowercase().contains("placeholder_foldgroup") {
            continue;
        }
        let last_ts = field_i64(
            row,
            &[
                "lastTimestamp",
                "last_timestamp",
                "lastMsgTime",
                "sortTimestamp",
                "sort_timestamp",
            ],
            0,
        );
        let unread = field_i64(row, &["unreadCount", "unread_count"], 0);
        let prev = baseline.get(&username);
        let is_muted = field_bool(row, &["isMuted", "muted", "mute"]);
        let is_folded = field_bool(row, &["isFolded", "folded"]);

        next_baseline.insert(
            username.clone(),
            SessionBaseline {
                last_timestamp: last_ts,
                unread_count: unread,
            },
        );

        if seeding || is_muted || is_folded {
            continue;
        }

        let Some(p) = prev else {
            continue;
        };

        // Any timestamp advance → revoke scan candidate (revokes may not grow
        // unread). We'll dedupe revoke rows by message key below.
        if last_ts > p.last_timestamp {
            revoke_candidates.push(row.clone());
        }

        // New-message detection (WeFlow GlobalSessionMonitor / messagePushService
        // approach): require unread to STRICTLY increase. Sending a message
        // advances lastTimestamp but leaves unreadCount unchanged, so this
        // filters self-sent messages for both private and group chats.
        if unread <= p.unread_count {
            continue;
        }

        // Secondary filter: if lastMsgSender is populated and matches self,
        // skip (covers group chats where sender info is reliable).
        let sender = field_str(row, &["lastMsgSender", "last_msg_sender", "lastSender"]);
        if !sender.is_empty() && sender_wxid_equal(&sender, &wxid) {
            continue;
        }

        new_msg_candidates.push(row.clone());
    }

    // Merge for name resolution (dedup by username).
    let mut candidates: Vec<Value> = new_msg_candidates.clone();
    for row in &revoke_candidates {
        let u = field_str(row, &["username", "userName", "sessionId", "user_name"]);
        if !candidates.iter().any(|c| {
            field_str(c, &["username", "userName", "sessionId", "user_name"]) == u
        }) {
            candidates.push(row.clone());
        }
    }

    // Resolve display names in one batch.
    let ids: Vec<String> = candidates
        .iter()
        .map(|row| field_str(row, &["username", "userName", "sessionId", "user_name"]))
        .collect();
    let mut names: HashMap<String, String> = HashMap::new();
    if !ids.is_empty() {
        if let Ok(map) = handle.display_names(&ids) {
            names = map;
        }
        names_cache.retain(|k, _| ids.contains(k));
        for id in &ids {
            if let Some(n) = names.get(id) {
                names_cache.insert(id.clone(), n.clone());
            }
        }
    }

    // New-message toasts (only sessions where unread strictly increased).
    for row in &new_msg_candidates {
        let username = field_str(row, &["username", "userName", "sessionId", "user_name"]);
        let summary = field_str(row, &["summary", "lastMsg", "last_message"]);
        if summary.is_empty() {
            continue;
        }
        let content = summarize_content(&summary);
        if content.is_empty() {
            continue;
        }
        let title = names
            .get(&username)
            .cloned()
            .or_else(|| names_cache.get(&username).cloned())
            .filter(|s| !s.is_empty() && !s.starts_with("wxid_"))
            .unwrap_or_else(|| username.clone());
        let title = if username.ends_with(GROUP_SUFFIX) {
            let sender = field_str(row, &["lastMsgSender", "last_msg_sender", "lastSender"]);
            let sender_name = if !sender.is_empty() {
                names
                    .get(&sender)
                    .cloned()
                    .or_else(|| names_cache.get(&sender).cloned())
                    .unwrap_or_else(|| sender.clone())
            } else {
                String::new()
            };
            if sender_name.is_empty() {
                title
            } else {
                format!("{title} · {sender_name}")
            }
        } else {
            title
        };
        events.push(NotifyEvent {
            kind: NotifyKind::NewMessage,
            session_id: username.clone(),
            title,
            content,
            timestamp: field_i64(row, &["lastTimestamp", "last_timestamp"], 0),
        });
    }

    // Recall toasts: scan recent messages of revoke-candidate sessions.
    // (Sessions with any timestamp advance — revokes may not grow unread.)
    for row in &revoke_candidates {
        let username = field_str(row, &["username", "userName", "sessionId", "user_name"]);
        let Ok(msgs) = handle.messages(&username, 60, 0) else {
            continue;
        };
        let mut revoke_rows: Vec<&Value> = Vec::new();
        for m in &msgs {
            let local_type = field_i64(m, &["localType", "local_type", "msgType"], 0);
            let content = raw_content(m);
            let is_revoke = local_type == 10000
                || local_type == 10002
                || content.contains("revokemsg")
                || content.contains("<replacemsg")
                || content.contains("撤回了一条消息")
                || content.contains("尝试撤回此消息");
            if is_revoke && !content.contains("你撤回") {
                revoke_rows.push(m);
            }
        }
        for rev in revoke_rows {
            let mkey = field_str(rev, &["messageKey", "message_key", "localId"]);
            if mkey.is_empty() {
                continue;
            }
            let dedupe_key = (username.clone(), mkey.clone());
            if revoke_seen.contains(&dedupe_key) {
                continue;
            }
            revoke_seen.insert(dedupe_key.clone());
            // Original message is the last non-system message before the revoke row.
            let original = msgs
                .iter()
                .filter(|m| {
                    let t = field_i64(m, &["createTime", "create_time"], 0);
                    t <= field_i64(rev, &["createTime", "create_time"], 0)
                        && !is_system_row(m)
                        && field_str(m, &["messageKey", "message_key", "localId"]) != mkey
                })
                .last();
            let original_content = original
                .map(|m| summarize_content(&message_display(m)))
                .filter(|s| !s.is_empty());
            let fallback = revoke_fallback_content(rev);
            let content = match original_content.or(fallback) {
                Some(text) => format!("对方撤回了一条消息，内容：{text}"),
                None => "对方撤回了一条消息".to_string(),
            };
            let title = names
                .get(&username)
                .cloned()
                .or_else(|| names_cache.get(&username).cloned())
                .unwrap_or_else(|| username.clone());
            events.push(NotifyEvent {
                kind: NotifyKind::Recalled,
                session_id: username.clone(),
                title,
                content,
                timestamp: field_i64(rev, &["createTime", "create_time"], 0),
            });
        }
    }

    // Keep the revoke dedupe set bounded.
    if revoke_seen.len() > 8192 {
        revoke_seen.clear();
    }

    *baseline = next_baseline;
    events
}

// ---------------------------------------------------------------------------
// Row helpers (field names follow WeFlow's WCDB JSON mapping)
// ---------------------------------------------------------------------------

fn is_system_row(m: &Value) -> bool {
    let t = field_i64(m, &["localType", "local_type", "msgType"], 0);
    t == 10000 || t == 10002
}

fn raw_content(m: &Value) -> String {
    field_str(
        m,
        &["rawContent", "raw_content", "content", "messageContent"],
    )
}

fn message_display(m: &Value) -> String {
    let t = field_i64(m, &["localType", "local_type", "msgType"], 0);
    let text = field_str(m, &["parsedContent", "parsed_content", "rawContent", "raw_content", "content"]);
    let normalized = text
        .replace(
            |c: char| c == '\n' || c == '\r',
            "",
        )
        .trim()
        .to_string();
    match t {
        1 => normalized,
        3 => "[图片]".into(),
        34 => "[语音]".into(),
        43 => "[视频]".into(),
        47 => "[表情]".into(),
        42 => "[名片]".into(),
        48 => "[位置]".into(),
        49 => "[链接/文件]".into(),
        _ => normalized,
    }
}

fn summarize_content(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        return String::new();
    }
    let t = t.replace("\r\n", " ").replace('\n', " ");
    let mut chars = t.chars();
    let mut out: String = chars.by_ref().take(120).collect();
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

fn revoke_fallback_content(rev: &Value) -> Option<String> {
    let content = raw_content(rev);
    let lower = content.to_lowercase();
    for tag in ["replacemsg", "newmsg", "msg"] {
        let open = format!("<{tag}>");
        if let Some(idx) = lower.find(&open) {
            let rest = &content[idx + open.len()..];
            if let Some(end) = rest.find("</") {
                let value = rest[..end].trim();
                if !value.is_empty() && !value.contains("撤回了一条消息") {
                    return Some(summarize_content(value));
                }
            }
        }
    }
    None
}

fn sender_wxid_equal(sender: &str, self_wxid: &str) -> bool {
    let clean = |s: &str| -> String { s.trim().trim_start_matches("wxid_").to_lowercase() };
    clean(sender) == clean(self_wxid)
}

fn field_str(v: &Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    String::new()
}

fn field_i64(v: &Value, keys: &[&str], default: i64) -> i64 {
    for k in keys {
        if let Some(x) = v.get(*k) {
            if let Some(n) = x.as_i64() {
                return n;
            }
            if let Some(s) = x.as_str() {
                if let Ok(n) = s.trim().parse::<i64>() {
                    return n;
                }
            }
            if let Some(f) = x.as_f64() {
                return f as i64;
            }
        }
    }
    default
}

fn field_bool(v: &Value, keys: &[&str]) -> bool {
    for k in keys {
        if let Some(x) = v.get(*k) {
            if let Some(b) = x.as_bool() {
                return b;
            }
            if let Some(n) = x.as_i64() {
                return n != 0;
            }
            if let Some(s) = x.as_str() {
                return s == "1" || s.eq_ignore_ascii_case("true");
            }
        }
    }
    false
}
