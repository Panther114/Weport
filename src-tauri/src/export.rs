//! Export all sessions to 群聊_/私聊_ TXT or JSON.
use crate::wcdb::WcdbHandle;
use chrono::{Local, TimeZone};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

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
}

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

fn session_display_name(session: &Value, fallback: &str) -> String {
    for key in ["displayName", "nickname", "nickName", "remark", "name", "username"] {
        if let Some(v) = session.get(key).and_then(|x| x.as_str()) {
            let t = v.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    fallback.to_string()
}

fn session_id_of(session: &Value) -> String {
    session
        .get("username")
        .or_else(|| session.get("userName"))
        .or_else(|| session.get("sessionId"))
        .or_else(|| session.get("talker"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn msg_field_str(msg: &Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(v) = msg.get(*k) {
            if let Some(s) = v.as_str() {
                return s.to_string();
            }
            if let Some(n) = v.as_i64() {
                return n.to_string();
            }
            if let Some(n) = v.as_u64() {
                return n.to_string();
            }
        }
    }
    String::new()
}

fn msg_timestamp(msg: &Value) -> i64 {
    for k in ["createTime", "timestamp", "msgCreateTime", "time"] {
        if let Some(v) = msg.get(k) {
            if let Some(n) = v.as_i64() {
                // seconds or ms
                return if n > 10_000_000_000 { n / 1000 } else { n };
            }
            if let Some(n) = v.as_u64() {
                let n = n as i64;
                return if n > 10_000_000_000 { n / 1000 } else { n };
            }
            if let Some(s) = v.as_str() {
                if let Ok(n) = s.parse::<i64>() {
                    return if n > 10_000_000_000 { n / 1000 } else { n };
                }
            }
        }
    }
    0
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

fn msg_type(msg: &Value) -> i64 {
    for k in ["localType", "type", "msgType"] {
        if let Some(n) = msg.get(k).and_then(|v| v.as_i64()) {
            return n;
        }
    }
    1
}

fn type_label(t: i64) -> &'static str {
    match t {
        1 => "文本",
        3 => "图片",
        34 => "语音",
        43 => "视频",
        47 | 1048625 => "表情",
        48 => "位置",
        49 => "链接/应用",
        50 => "通话",
        10000 | 10002 => "系统",
        _ => "其他",
    }
}

fn msg_content(msg: &Value) -> String {
    let raw = msg_field_str(msg, &["content", "text", "parsedContent", "messageContent"]);
    let t = msg_type(msg);
    if raw.trim().is_empty() {
        format!("[{}]", type_label(t))
    } else if t == 1 || t == 10000 || t == 10002 {
        raw
    } else {
        // Keep raw for links/app messages; prefix non-text
        if t == 3 || t == 34 || t == 43 {
            format!("[{}] {}", type_label(t), raw)
        } else {
            raw
        }
    }
}

fn msg_sender(msg: &Value, is_group_chat: bool) -> String {
    let is_send = msg
        .get("isSend")
        .or_else(|| msg.get("is_send"))
        .and_then(|v| v.as_i64().or_else(|| v.as_bool().map(|b| if b { 1 } else { 0 })))
        .unwrap_or(0)
        == 1;

    if is_send {
        return "我".into();
    }

    let name = msg_field_str(
        msg,
        &[
            "senderDisplayName",
            "displayName",
            "senderNickname",
            "senderName",
            "senderUsername",
            "fromUser",
        ],
    );
    if !name.is_empty() {
        return name;
    }
    if is_group_chat {
        "成员".into()
    } else {
        "对方".into()
    }
}

fn unique_path(preferred: PathBuf) -> PathBuf {
    if !preferred.exists() {
        return preferred;
    }
    let stem = preferred
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("session");
    let ext = preferred
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("txt");
    let parent = preferred.parent().unwrap_or_else(|| Path::new("."));
    for i in 2..10_000 {
        let candidate = parent.join(format!("{stem}_{i}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem}_{}.{}", chrono::Local::now().timestamp(), ext))
}

fn write_txt(path: &Path, session_id: &str, display: &str, messages: &[Value]) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(|e| format!("创建文件失败: {e}"))?;
    writeln!(file, "会话: {display}").map_err(|e| e.to_string())?;
    writeln!(file, "ID: {session_id}").map_err(|e| e.to_string())?;
    writeln!(
        file,
        "类型: {}",
        if is_group(session_id) { "群聊" } else { "私聊" }
    )
    .map_err(|e| e.to_string())?;
    writeln!(file, "消息数: {}", messages.len()).map_err(|e| e.to_string())?;
    writeln!(file, "{}", "-".repeat(48)).map_err(|e| e.to_string())?;

    let group = is_group(session_id);
    for msg in messages {
        let time = format_time(msg_timestamp(msg));
        let sender = msg_sender(msg, group);
        let content = msg_content(msg).replace('\r', "");
        if time.is_empty() {
            writeln!(file, "{sender}: {content}").map_err(|e| e.to_string())?;
        } else {
            writeln!(file, "[{time}] {sender}: {content}").map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn write_json(path: &Path, session_id: &str, display: &str, messages: &[Value]) -> Result<(), String> {
    let group = is_group(session_id);
    let mapped: Vec<Value> = messages
        .iter()
        .map(|msg| {
            json!({
                "time": format_time(msg_timestamp(msg)),
                "timestamp": msg_timestamp(msg),
                "sender": msg_sender(msg, group),
                "type": type_label(msg_type(msg)),
                "typeCode": msg_type(msg),
                "content": msg_content(msg),
                "raw": msg,
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

pub fn export_all(
    db: &WcdbHandle,
    output_dir: &Path,
    format: ExportFormat,
    mut on_progress: impl FnMut(ExportProgress),
) -> Result<Value, String> {
    fs::create_dir_all(output_dir).map_err(|e| format!("创建输出目录失败: {e}"))?;

    let sessions = db.sessions()?;
    let total = sessions.len() as f64;
    let mut success = 0usize;
    let mut fail = 0usize;
    let mut failed: Vec<Value> = Vec::new();
    let mut outputs: Vec<String> = Vec::new();

    for (idx, session) in sessions.iter().enumerate() {
        let sid = session_id_of(session);
        if sid.is_empty() {
            fail += 1;
            continue;
        }
        // skip system / filehelper noise? keep all for "every single contact"
        let display = session_display_name(session, &sid);
        on_progress(ExportProgress {
            current: idx as f64,
            total,
            current_session: display.clone(),
            phase_label: "导出中".into(),
        });

        // Enrich display from contact if needed
        let display = if display == sid {
            db.contact(&sid)
                .ok()
                .map(|c| {
                    c.get("remark")
                        .or_else(|| c.get("nickName"))
                        .or_else(|| c.get("nickname"))
                        .or_else(|| c.get("alias"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&sid)
                        .to_string()
                })
                .unwrap_or(display)
        } else {
            display
        };

        let messages = match db.all_messages(&sid) {
            Ok(m) => m,
            Err(e) => {
                fail += 1;
                failed.push(json!({ "sessionId": sid, "error": e }));
                continue;
            }
        };

        if messages.is_empty() {
            // skip empty sessions silently but count as success-skip
            success += 1;
            continue;
        }

        // sort by timestamp ascending
        let mut messages = messages;
        messages.sort_by_key(|m| msg_timestamp(m));

        let base = format!("{}{}", prefix_for(&sid), sanitize_name(&display));
        let preferred = output_dir.join(format!("{base}.{}", format.ext()));
        let path = unique_path(preferred);

        let write_result = match format {
            ExportFormat::Txt => write_txt(&path, &sid, &display, &messages),
            ExportFormat::Json => write_json(&path, &sid, &display, &messages),
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
    }))
}
