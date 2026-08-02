//! Export all sessions to 群聊_/私聊_ TXT or JSON.
//!
//! WCDB rows use snake_case WeChat fields (message_content, local_type, create_time,
//! sender_username, is_send). Session rows only carry `username` — display names come
//! from contact lookup (remark → nickName → alias → username), matching WeFlow.
use crate::wcdb::WcdbHandle;
use chrono::{Local, TimeZone};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Txt,
    Json,
}

impl ExportFormat {
    pub fn from_str(s: &str) -> Self {
        if s.eq_ignore_ascii_case("json") {
            Self::Json
        } else {
            Self::Txt
        }
    }

    pub fn ext(self) -> &'static str {
        match self {
            Self::Txt => "txt",
            Self::Json => "json",
        }
    }

    /// Subfolder under the user-selected export root (uppercase).
    pub fn folder_name(self) -> &'static str {
        match self {
            Self::Txt => "TXT",
            Self::Json => "JSON",
        }
    }
}

/// Root-level log file next to TXT/ and JSON/ folders.
pub const EXPORT_LOG_NAME: &str = "export_log.txt";

pub struct ExportProgress {
    pub current: f64,
    pub total: f64,
    pub current_session: String,
    pub phase_label: String,
}

fn sanitize_name(raw: &str) -> String {
    let s = raw
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .trim_end_matches('.')
        .to_string();
    if s.is_empty() {
        "session".into()
    } else {
        s.chars().take(80).collect()
    }
}

fn is_group(session_id: &str) -> bool {
    session_id.ends_with("@chatroom")
}

fn prefix_for(session_id: &str) -> &'static str {
    if is_group(session_id) {
        "群聊_"
    } else {
        "私聊_"
    }
}

/// Coerce JSON value to trimmed string (WCDB often returns numbers as strings).
fn value_as_str(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn field_str(obj: &Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(v) = obj.get(*k).and_then(value_as_str) {
            return v;
        }
    }
    String::new()
}

fn field_i64(obj: &Value, keys: &[&str], default: i64) -> i64 {
    for k in keys {
        if let Some(v) = obj.get(*k) {
            if let Some(n) = v.as_i64() {
                return n;
            }
            if let Some(n) = v.as_u64() {
                return n as i64;
            }
            if let Some(s) = v.as_str() {
                let t = s.trim();
                if let Ok(n) = t.parse::<i64>() {
                    return n;
                }
                if let Ok(n) = t.parse::<u64>() {
                    return n as i64;
                }
            }
        }
    }
    default
}

/// WeFlow / contact priority: remark → nickName → alias → fallback.
fn contact_display_name(contact: &Value, fallback: &str) -> String {
    for key in [
        "remark",
        "Remark",
        "nickName",
        "nickname",
        "NickName",
        "nick_name",
        "alias",
        "Alias",
        "displayName",
        "name",
    ] {
        if let Some(v) = contact.get(key).and_then(value_as_str) {
            return v;
        }
    }
    fallback.to_string()
}

fn session_id_of(session: &Value) -> String {
    field_str(
        session,
        &["username", "userName", "sessionId", "talker", "user_name"],
    )
}

fn session_display_name_from_row(session: &Value, fallback: &str) -> String {
    // Session rows from WCDB usually only have `username` — no displayName.
    for key in [
        "displayName",
        "nickname",
        "nickName",
        "remark",
        "name",
        "last_sender_display_name",
    ] {
        if let Some(v) = session.get(key).and_then(value_as_str) {
            // last_sender_display_name is the last message sender, not the session name —
            // only accept explicit display fields above; skip that key for session title.
            if key == "last_sender_display_name" {
                continue;
            }
            return v;
        }
    }
    fallback.to_string()
}

fn msg_timestamp(msg: &Value) -> i64 {
    let n = field_i64(
        msg,
        &[
            "create_time",
            "createTime",
            "msg_time",
            "msgTime",
            "timestamp",
            "msgCreateTime",
            "time",
            "sort_seq",
            "sortSeq",
        ],
        0,
    );
    if n <= 0 {
        return 0;
    }
    // sort_seq is often ms; create_time is seconds
    if n > 10_000_000_000 {
        n / 1000
    } else {
        n
    }
}

fn format_time(ts: i64) -> String {
    if ts <= 0 {
        return String::new();
    }
    match Local.timestamp_opt(ts, 0) {
        chrono::LocalResult::Single(dt) => dt.format("%Y-%m-%d %H:%M:%S").to_string(),
        _ => String::new(),
    }
}

/// Normalize WeChat local_type (may be string or large composite int).
fn msg_type(msg: &Value) -> i64 {
    let raw = field_i64(msg, &["local_type", "localType", "type", "msgType", "msg_type"], 1);
    // Composite types occasionally pack subtype in high bits; keep low 32 bits for labeling.
    if raw > i64::from(u32::MAX) {
        raw & 0xFFFF_FFFF
    } else if raw < 0 {
        1
    } else {
        raw
    }
}

fn type_label(t: i64) -> &'static str {
    match t {
        1 => "文本",
        3 => "图片",
        34 => "语音",
        42 => "名片",
        43 => "视频",
        47 | 1048625 => "表情",
        48 => "位置",
        49 => "链接/应用",
        50 => "通话",
        10000 | 10002 => "系统",
        _ => "其他",
    }
}

fn looks_like_hex(s: &str) -> bool {
    let compact: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    compact.len() > 16 && compact.len() % 2 == 0 && compact.chars().all(|c| c.is_ascii_hexdigit())
}

fn decode_hex_utf8(s: &str) -> Option<String> {
    let compact: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.len() < 2 || compact.len() % 2 != 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(compact.len() / 2);
    let chars: Vec<char> = compact.chars().collect();
    let mut i = 0;
    while i + 1 < chars.len() {
        let pair: String = chars[i..i + 2].iter().collect();
        match u8::from_str_radix(&pair, 16) {
            Ok(b) => bytes.push(b),
            Err(_) => return None,
        }
        i += 2;
    }
    // Skip zstd magic — leave as empty so caller falls back to type label
    if bytes.len() >= 4 {
        let magic = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        if magic == 0xFD2F_B528 {
            return None;
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    let replacement = text.chars().filter(|c| *c == '\u{FFFD}').count();
    if replacement as f64 > text.len() as f64 * 0.2 {
        return None;
    }
    let cleaned: String = text
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\r' || *c == '\t')
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn decode_maybe_compressed(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return String::new();
    }
    if looks_like_hex(raw) {
        if let Some(decoded) = decode_hex_utf8(raw) {
            return decoded;
        }
        // Binary / non-utf8 payload — treat as empty so type placeholder is used
        return String::new();
    }
    raw.to_string()
}

/// Prefer compress_content, then message_content (WeFlow order).
fn decode_message_body(msg: &Value) -> String {
    let compress = field_str(
        msg,
        &["compress_content", "compressContent", "CompressContent"],
    );
    let message = field_str(
        msg,
        &[
            "message_content",
            "messageContent",
            "content",
            "text",
            "parsedContent",
            "rawContent",
        ],
    );
    let mut body = decode_maybe_compressed(&compress);
    if body.is_empty() {
        body = decode_maybe_compressed(&message);
    }
    // Group messages sometimes store "wxid:\ntext" in content
    if let Some(rest) = strip_group_sender_prefix(&body) {
        body = rest;
    }
    body
}

fn strip_group_sender_prefix(content: &str) -> Option<String> {
    // Pattern: username:\nmessage  (WeChat group raw format)
    let first_line_end = content.find('\n')?;
    let head = content[..first_line_end].trim();
    if !head.ends_with(':') {
        return None;
    }
    let candidate = head.trim_end_matches(':').trim();
    if candidate.len() < 4 {
        return None;
    }
    // wxid_*, pure digits@chatroom senders, or simple alphanum ids
    let ok = candidate.starts_with("wxid_")
        || candidate.contains('@')
        || (candidate
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            && candidate.len() >= 4);
    if !ok {
        return None;
    }
    Some(content[first_line_end + 1..].trim_start().to_string())
}

fn msg_content(msg: &Value) -> String {
    let raw = decode_message_body(msg);
    let t = msg_type(msg);
    if raw.trim().is_empty() {
        format!("[{}]", type_label(t))
    } else if t == 1 || t == 10000 || t == 10002 {
        raw
    } else if t == 3 || t == 34 || t == 43 || t == 47 {
        // Media: keep short raw if readable, else label
        if raw.chars().count() > 200 || looks_like_hex(&raw) {
            format!("[{}]", type_label(t))
        } else {
            format!("[{}] {}", type_label(t), raw)
        }
    } else {
        raw
    }
}

fn msg_is_send(msg: &Value) -> bool {
    let v = msg
        .get("computed_is_send")
        .or_else(|| msg.get("is_send"))
        .or_else(|| msg.get("isSend"));
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0) == 1,
        Some(Value::String(s)) => {
            let t = s.trim();
            t == "1" || t.eq_ignore_ascii_case("true")
        }
        _ => false,
    }
}

fn msg_sender_username(msg: &Value) -> String {
    // Do not use real_sender_id — it is an internal numeric contact id, not a display name.
    field_str(
        msg,
        &["sender_username", "senderUsername", "fromUser", "talker"],
    )
}

fn msg_sender(msg: &Value, is_group_chat: bool, names: &HashMap<String, String>) -> String {
    if msg_is_send(msg) {
        return "我".into();
    }

    let t = msg_type(msg);
    if t == 10000 || t == 10002 {
        return "系统".into();
    }

    let username = msg_sender_username(msg);
    if !username.is_empty() {
        if let Some(n) = names.get(&username) {
            if !n.is_empty() {
                return n.clone();
            }
        }
        // Prefer any display field already on the row
        let inline = field_str(
            msg,
            &[
                "senderDisplayName",
                "displayName",
                "senderNickname",
                "senderName",
                "last_sender_display_name",
            ],
        );
        if !inline.is_empty() {
            return inline;
        }
        return username;
    }

    if is_group_chat {
        "成员".into()
    } else {
        "对方".into()
    }
}

/// Read existing export_log.txt timestamps (TXT / JSON lines).
fn parse_export_log(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(text) = fs::read_to_string(path) else {
        return (None, None);
    };
    let mut txt = None;
    let mut json = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("TXT:") {
            let v = rest.trim();
            if !v.is_empty() && v != "—" && !v.eq_ignore_ascii_case("never") {
                txt = Some(v.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("JSON:") {
            let v = rest.trim();
            if !v.is_empty() && v != "—" && !v.eq_ignore_ascii_case("never") {
                json = Some(v.to_string());
            }
        }
    }
    (txt, json)
}

fn write_export_log(
    root: &Path,
    format: ExportFormat,
    when: &str,
    success: usize,
    fail: usize,
) -> Result<(), String> {
    let log_path = root.join(EXPORT_LOG_NAME);
    let (mut txt_line, mut json_line) = parse_export_log(&log_path);
    let summary = format!("{when}  ·  success={success}  fail={fail}");
    match format {
        ExportFormat::Txt => txt_line = Some(summary),
        ExportFormat::Json => json_line = Some(summary),
    }
    let body = format!(
        "# Weport export log\n\
         # Last successful run times for each format (local time).\n\
         # Files live under TXT/ and JSON/ subfolders; re-export overwrites same names.\n\
         \n\
         TXT: {}\n\
         JSON: {}\n",
        txt_line.as_deref().unwrap_or("—"),
        json_line.as_deref().unwrap_or("—"),
    );
    fs::write(&log_path, body).map_err(|e| format!("写入导出日志失败: {e}"))
}

/// Read last-export summary for the UI.
pub fn read_export_log(root: &Path) -> Value {
    let log_path = root.join(EXPORT_LOG_NAME);
    let (txt, json) = parse_export_log(&log_path);
    json!({
        "path": log_path.to_string_lossy(),
        "txt": txt,
        "json": json,
        "exists": log_path.exists(),
    })
}

/// Empty the export library: remove TXT/, JSON/, and export_log.txt under root.
/// Does not delete the root folder itself.
pub fn clear_export_library(root: &Path) -> Result<Value, String> {
    if root.as_os_str().is_empty() {
        return Err("输出目录为空".into());
    }
    if !root.exists() {
        return Ok(json!({
            "success": true,
            "removed": [],
            "message": "目录不存在，无需清理",
        }));
    }
    if !root.is_dir() {
        return Err(format!("不是目录: {}", root.display()));
    }

    let mut removed: Vec<String> = Vec::new();
    for name in ["TXT", "JSON", EXPORT_LOG_NAME] {
        let p = root.join(name);
        if !p.exists() {
            continue;
        }
        if p.is_dir() {
            fs::remove_dir_all(&p).map_err(|e| format!("删除 {} 失败: {e}", p.display()))?;
        } else {
            fs::remove_file(&p).map_err(|e| format!("删除 {} 失败: {e}", p.display()))?;
        }
        removed.push(p.to_string_lossy().into_owned());
    }

    // Also remove any legacy flat chat files in the root (群聊_/私聊_)
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let is_legacy = (name.starts_with("群聊_") || name.starts_with("私聊_"))
                && (name.ends_with(".txt") || name.ends_with(".json"));
            if is_legacy {
                let _ = fs::remove_file(&path);
                removed.push(path.to_string_lossy().into_owned());
            }
        }
    }

    Ok(json!({
        "success": true,
        "removed": removed,
        "message": if removed.is_empty() {
            "导出库已是空的"
        } else {
            "已清空导出库"
        },
    }))
}

fn write_txt(
    path: &Path,
    session_id: &str,
    display: &str,
    messages: &[Value],
    names: &HashMap<String, String>,
) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(|e| format!("创建文件失败: {e}"))?;
    writeln!(file, "会话: {display}").map_err(|e| e.to_string())?;
    writeln!(file, "ID: {session_id}").map_err(|e| e.to_string())?;
    writeln!(
        file,
        "类型: {}",
        if is_group(session_id) {
            "群聊"
        } else {
            "私聊"
        }
    )
    .map_err(|e| e.to_string())?;
    writeln!(file, "消息数: {}", messages.len()).map_err(|e| e.to_string())?;
    writeln!(file, "{}", "-".repeat(48)).map_err(|e| e.to_string())?;

    let group = is_group(session_id);
    for msg in messages {
        let time = format_time(msg_timestamp(msg));
        let sender = msg_sender(msg, group, names);
        let content = msg_content(msg).replace('\r', "");
        if time.is_empty() {
            writeln!(file, "{sender}: {content}").map_err(|e| e.to_string())?;
        } else {
            writeln!(file, "[{time}] {sender}: {content}").map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn write_json(
    path: &Path,
    session_id: &str,
    display: &str,
    messages: &[Value],
    names: &HashMap<String, String>,
) -> Result<(), String> {
    let group = is_group(session_id);
    let mapped: Vec<Value> = messages
        .iter()
        .map(|msg| {
            json!({
                "time": format_time(msg_timestamp(msg)),
                "timestamp": msg_timestamp(msg),
                "sender": msg_sender(msg, group, names),
                "senderUsername": msg_sender_username(msg),
                "type": type_label(msg_type(msg)),
                "typeCode": msg_type(msg),
                "content": msg_content(msg),
            })
        })
        .collect();

    let doc = json!({
        "sessionId": session_id,
        "displayName": display,
        "type": if group { "群聊" } else { "私聊" },
        "messageCount": mapped.len(),
        "exportedAt": Local::now().to_rfc3339(),
        "messages": mapped,
    });

    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| format!("写入失败: {e}"))
}

fn resolve_display_names(db: &WcdbHandle, usernames: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if usernames.is_empty() {
        return map;
    }

    // Prefer batch API when available
    if let Ok(batch) = db.display_names(usernames) {
        for (k, v) in batch {
            if !k.is_empty() && !v.is_empty() {
                map.insert(k, v);
            }
        }
    }

    // Fill gaps with per-contact lookup
    for u in usernames {
        if map.contains_key(u) {
            continue;
        }
        if let Ok(c) = db.contact(u) {
            let name = contact_display_name(&c, u);
            map.insert(u.clone(), name);
        } else {
            map.insert(u.clone(), u.clone());
        }
    }
    map
}

fn merge_sender_names(
    db: &WcdbHandle,
    base: &HashMap<String, String>,
    messages: &[Value],
) -> HashMap<String, String> {
    let mut map = base.clone();
    let mut missing = Vec::new();
    for m in messages {
        let u = msg_sender_username(m);
        if !u.is_empty() && !map.contains_key(&u) {
            missing.push(u);
        }
    }
    missing.sort();
    missing.dedup();
    if missing.is_empty() {
        return map;
    }
    let extra = resolve_display_names(db, &missing);
    map.extend(extra);
    map
}

pub fn export_all(
    db: &WcdbHandle,
    output_dir: &Path,
    format: ExportFormat,
    mut on_progress: impl FnMut(ExportProgress),
) -> Result<Value, String> {
    // Root = user-selected folder; chat files go under TXT/ or JSON/
    fs::create_dir_all(output_dir).map_err(|e| format!("创建输出目录失败: {e}"))?;
    let format_dir = output_dir.join(format.folder_name());
    fs::create_dir_all(&format_dir).map_err(|e| format!("创建格式子目录失败: {e}"))?;

    let sessions = db.sessions()?;
    let total = sessions.len() as f64;
    let mut success = 0usize;
    let mut fail = 0usize;
    let mut failed: Vec<Value> = Vec::new();
    let mut outputs: Vec<String> = Vec::new();

    // Pre-resolve session display names (WeFlow-style)
    let session_ids: Vec<String> = sessions
        .iter()
        .map(session_id_of)
        .filter(|s| !s.is_empty())
        .collect();
    on_progress(ExportProgress {
        current: 0.0,
        total,
        current_session: String::new(),
        phase_label: "解析联系人名称".into(),
    });
    let mut name_map = resolve_display_names(db, &session_ids);

    for (idx, session) in sessions.iter().enumerate() {
        let sid = session_id_of(session);
        if sid.is_empty() {
            fail += 1;
            continue;
        }

        let display = name_map
            .get(&sid)
            .cloned()
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| session_display_name_from_row(session, &sid));

        // Ensure contact enrichment if still raw id
        let display = if display == sid {
            if let Ok(c) = db.contact(&sid) {
                let n = contact_display_name(&c, &sid);
                name_map.insert(sid.clone(), n.clone());
                n
            } else {
                display
            }
        } else {
            display
        };

        on_progress(ExportProgress {
            current: idx as f64,
            total,
            current_session: display.clone(),
            phase_label: "导出中".into(),
        });

        let messages = match db.all_messages(&sid) {
            Ok(m) => m,
            Err(e) => {
                fail += 1;
                failed.push(json!({ "sessionId": sid, "error": e }));
                continue;
            }
        };

        if messages.is_empty() {
            success += 1;
            continue;
        }

        // Resolve group member / peer names for this session
        let names = merge_sender_names(db, &name_map, &messages);
        // Keep accumulating for later sessions
        for (k, v) in &names {
            name_map.entry(k.clone()).or_insert_with(|| v.clone());
        }

        let mut messages = messages;
        messages.sort_by_key(|m| msg_timestamp(m));

        let base = format!("{}{}", prefix_for(&sid), sanitize_name(&display));
        // Always overwrite same path (no _2 suffix)
        let path = format_dir.join(format!("{base}.{}", format.ext()));

        let write_result = match format {
            ExportFormat::Txt => write_txt(&path, &sid, &display, &messages, &names),
            ExportFormat::Json => write_json(&path, &sid, &display, &messages, &names),
        };

        match write_result {
            Ok(()) => {
                success += 1;
                outputs.push(path.to_string_lossy().into_owned());
            }
            Err(e) => {
                fail += 1;
                failed.push(json!({ "sessionId": sid, "error": e }));
            }
        }
    }

    let when = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let _ = write_export_log(output_dir, format, &when, success, fail);

    on_progress(ExportProgress {
        current: total,
        total,
        current_session: String::new(),
        phase_label: "完成".into(),
    });

    Ok(json!({
        "success": fail == 0,
        "successCount": success,
        "failCount": fail,
        "failed": failed,
        "files": outputs,
        "outputDir": output_dir.to_string_lossy(),
        "formatDir": format_dir.to_string_lossy(),
        "formatFolder": format.folder_name(),
        "exportLog": output_dir.join(EXPORT_LOG_NAME).to_string_lossy(),
        "exportedAt": when,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_wcdb_text_message_content() {
        let msg = json!({
            "message_content": "ok",
            "compress_content": "",
            "local_type": "1",
            "create_time": "1785657976",
            "is_send": "0",
            "sender_username": "wxid_mjls9q8gezm132"
        });
        assert_eq!(msg_content(&msg), "ok");
        assert_eq!(msg_type(&msg), 1);
        assert_eq!(msg_timestamp(&msg), 1785657976);
        assert!(!msg_is_send(&msg));
        assert_eq!(msg_sender_username(&msg), "wxid_mjls9q8gezm132");
    }

    #[test]
    fn uses_contact_priority_remark_then_nickname() {
        let c = json!({
            "username": "wxid_mjls9q8gezm132",
            "nickName": "Max Shuang 🐯🐯",
            "remark": "",
            "alias": "niuniukrokodil"
        });
        assert_eq!(
            contact_display_name(&c, "wxid_mjls9q8gezm132"),
            "Max Shuang 🐯🐯"
        );

        let c2 = json!({
            "username": "wxid_x",
            "nickName": "Nick",
            "remark": "Best Friend",
            "alias": "a"
        });
        assert_eq!(contact_display_name(&c2, "wxid_x"), "Best Friend");
    }

    #[test]
    fn group_contact_uses_nickname() {
        let c = json!({
            "username": "48541931573@chatroom",
            "nickName": "AGI",
            "remark": "",
            "alias": ""
        });
        assert_eq!(contact_display_name(&c, "48541931573@chatroom"), "AGI");
    }

    #[test]
    fn sent_message_shows_me() {
        let msg = json!({
            "message_content": "imagine wechat",
            "local_type": 1,
            "is_send": "1",
            "sender_username": "wxid_gsnpwh6vh2z012"
        });
        let names = HashMap::new();
        assert_eq!(msg_sender(&msg, true, &names), "我");
        assert_eq!(msg_content(&msg), "imagine wechat");
    }

    #[test]
    fn resolves_sender_via_name_map() {
        let msg = json!({
            "message_content": "hello",
            "local_type": "1",
            "is_send": "0",
            "sender_username": "wxid_mjls9q8gezm132"
        });
        let mut names = HashMap::new();
        names.insert(
            "wxid_mjls9q8gezm132".into(),
            "Max Shuang 🐯🐯".into(),
        );
        assert_eq!(msg_sender(&msg, false, &names), "Max Shuang 🐯🐯");
    }

    #[test]
    fn empty_media_shows_type_placeholder() {
        let msg = json!({
            "message_content": "",
            "compress_content": "",
            "local_type": "3",
            "is_send": "0"
        });
        assert_eq!(msg_content(&msg), "[图片]");
    }

    #[test]
    fn binary_hex_content_falls_back_to_placeholder() {
        let msg = json!({
            "message_content": "28b52ffd603603251100a61d5b25108fe8014028fa0b4148692cf69bffc204987a8a261fc8d31ae5",
            "compress_content": "",
            "local_type": "244813135921",
            "is_send": "0"
        });
        // large composite type → low 32 bits; content is opaque hex → placeholder
        let c = msg_content(&msg);
        assert!(c.starts_with('['), "got {c}");
    }

    #[test]
    fn session_id_from_username_only_row() {
        let s = json!({
            "username": "wxid_mjls9q8gezm132",
            "summary": "ok",
            "type": "0"
        });
        assert_eq!(session_id_of(&s), "wxid_mjls9q8gezm132");
        assert_eq!(
            session_display_name_from_row(&s, "wxid_mjls9q8gezm132"),
            "wxid_mjls9q8gezm132"
        );
    }

    #[test]
    fn strips_group_wxid_prefix() {
        let body = "wxid_abc123:\nhello world";
        assert_eq!(
            strip_group_sender_prefix(body).as_deref(),
            Some("hello world")
        );
    }

    #[test]
    fn write_txt_renders_real_content() {
        let dir = std::env::temp_dir().join(format!("weport-export-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.txt");
        let msgs = vec![json!({
            "message_content": "ok",
            "local_type": "1",
            "create_time": "1700000000",
            "is_send": "0",
            "sender_username": "wxid_mjls9q8gezm132"
        })];
        let mut names = HashMap::new();
        names.insert("wxid_mjls9q8gezm132".into(), "Max Shuang".into());
        write_txt(&path, "wxid_mjls9q8gezm132", "Max Shuang", &msgs, &names).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("会话: Max Shuang"));
        assert!(text.contains("Max Shuang: ok"), "body was:\n{text}");
        assert!(!text.contains("[其他]"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn format_folders_are_uppercase() {
        assert_eq!(ExportFormat::Txt.folder_name(), "TXT");
        assert_eq!(ExportFormat::Json.folder_name(), "JSON");
    }

    #[test]
    fn export_log_merges_formats() {
        let dir = std::env::temp_dir().join(format!("weport-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        write_export_log(&dir, ExportFormat::Txt, "2026-01-01 12:00:00", 10, 0).unwrap();
        write_export_log(&dir, ExportFormat::Json, "2026-01-02 13:00:00", 5, 1).unwrap();
        let (t, j) = parse_export_log(&dir.join(EXPORT_LOG_NAME));
        assert!(t.unwrap().contains("2026-01-01"));
        assert!(j.unwrap().contains("2026-01-02"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_export_library_removes_subdirs_and_log() {
        let dir = std::env::temp_dir().join(format!("weport-clear-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("TXT")).unwrap();
        fs::create_dir_all(dir.join("JSON")).unwrap();
        fs::write(dir.join("TXT").join("a.txt"), "x").unwrap();
        fs::write(dir.join(EXPORT_LOG_NAME), "TXT: hi\n").unwrap();
        let r = clear_export_library(&dir).unwrap();
        assert!(r["success"].as_bool().unwrap());
        assert!(!dir.join("TXT").exists());
        assert!(!dir.join("JSON").exists());
        assert!(!dir.join(EXPORT_LOG_NAME).exists());
        assert!(dir.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn overwrite_writes_same_path() {
        let dir = std::env::temp_dir().join(format!("weport-ow-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let sub = dir.join("TXT");
        fs::create_dir_all(&sub).unwrap();
        let path = sub.join("私聊_Test.txt");
        let names = HashMap::new();
        let m1 = vec![json!({"message_content":"first","local_type":"1","is_send":"1"})];
        let m2 = vec![json!({"message_content":"second","local_type":"1","is_send":"1"})];
        write_txt(&path, "wxid_x", "Test", &m1, &names).unwrap();
        write_txt(&path, "wxid_x", "Test", &m2, &names).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("second"));
        assert!(!text.contains("first"));
        assert!(!sub.join("私聊_Test_2.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
