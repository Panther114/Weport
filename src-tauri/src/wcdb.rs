//! Public WCDB access via WeFlow.exe-named worker (required by wcdb_api security check).
use crate::wcdb_worker::{with_worker, WorkerRequest};
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;

/// Serialize export / open operations.
pub static WCDB_LOCK: Mutex<()> = Mutex::new(());

pub struct WcdbHandle {
    // Session is held open inside the worker until Drop sends "close".
}

unsafe impl Send for WcdbHandle {}

impl WcdbHandle {
    pub fn open(
        resource_root: &Path,
        account_dir: &Path,
        hex_key: &str,
        wxid: &str,
    ) -> Result<Self, String> {
        let resp = with_worker(|w| {
            w.request(WorkerRequest {
                id: 0,
                cmd: "open".into(),
                resource_root: Some(resource_root.to_string_lossy().to_string()),
                account_dir: Some(account_dir.to_string_lossy().to_string()),
                key: Some(hex_key.to_string()),
                wxid: Some(wxid.to_string()),
                session_id: None,
                username: None,
                usernames: None,
                limit: None,
                offset: None,
            })
        })?;
        if !resp.ok {
            let mut msg = resp.error.unwrap_or_else(|| "open failed".into());
            if let Some(dbg) = resp.debug {
                msg = format!("{msg}\n\n[debug] {dbg}");
            }
            // Explain -1006 root cause clearly if still seen
            if msg.contains("-1006") {
                msg = format!(
                    "{msg}\n\n诊断：wcdb_api.dll 要求宿主进程名为 WeFlow.exe。\
                     Weport 已通过临时 WeFlow.exe 宿主加载；若仍失败请查看 debug 中的 exe 路径。"
                );
            }
            return Err(msg);
        }
        Ok(Self {})
    }

    pub fn sessions(&self) -> Result<Vec<Value>, String> {
        let resp = with_worker(|w| {
            w.request(WorkerRequest {
                id: 0,
                cmd: "sessions".into(),
                resource_root: None,
                account_dir: None,
                key: None,
                wxid: None,
                session_id: None,
                username: None,
                usernames: None,
                limit: None,
                offset: None,
            })
        })?;
        if !resp.ok {
            return Err(resp.error.unwrap_or_else(|| "sessions failed".into()));
        }
        match resp.data {
            Some(Value::Array(a)) => Ok(a),
            Some(other) => Ok(vec![other]),
            None => Ok(vec![]),
        }
    }

    pub fn messages(&self, session_id: &str, limit: i32, offset: i32) -> Result<Vec<Value>, String> {
        let resp = with_worker(|w| {
            w.request(WorkerRequest {
                id: 0,
                cmd: "messages".into(),
                resource_root: None,
                account_dir: None,
                key: None,
                wxid: None,
                session_id: Some(session_id.into()),
                username: None,
                usernames: None,
                limit: Some(limit),
                offset: Some(offset),
            })
        })?;
        if !resp.ok {
            return Err(resp.error.unwrap_or_else(|| "messages failed".into()));
        }
        match resp.data {
            Some(Value::Array(a)) => Ok(a),
            Some(Value::Object(map)) => {
                if let Some(Value::Array(arr)) = map.get("messages").or_else(|| map.get("rows")) {
                    Ok(arr.clone())
                } else {
                    Ok(vec![Value::Object(map)])
                }
            }
            Some(other) => Ok(vec![other]),
            None => Ok(vec![]),
        }
    }

    pub fn all_messages(&self, session_id: &str) -> Result<Vec<Value>, String> {
        let mut all = Vec::new();
        let mut offset = 0i32;
        let page = 500i32;
        loop {
            let batch = self.messages(session_id, page, offset)?;
            if batch.is_empty() {
                break;
            }
            let n = batch.len() as i32;
            all.extend(batch);
            offset += n;
            if n < page || offset > 5_000_000 {
                break;
            }
        }
        Ok(all)
    }

    pub fn contact(&self, username: &str) -> Result<Value, String> {
        let resp = with_worker(|w| {
            w.request(WorkerRequest {
                id: 0,
                cmd: "contact".into(),
                resource_root: None,
                account_dir: None,
                key: None,
                wxid: None,
                session_id: None,
                username: Some(username.into()),
                usernames: None,
                limit: None,
                offset: None,
            })
        })?;
        if !resp.ok {
            return Err(resp.error.unwrap_or_else(|| "contact failed".into()));
        }
        Ok(resp.data.unwrap_or(Value::Null))
    }

    /// Batch display names: remark → nickName → alias → username (WeFlow order).
    pub fn display_names(
        &self,
        usernames: &[String],
    ) -> Result<std::collections::HashMap<String, String>, String> {
        if usernames.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let resp = with_worker(|w| {
            w.request(WorkerRequest {
                id: 0,
                cmd: "display_names".into(),
                resource_root: None,
                account_dir: None,
                key: None,
                wxid: None,
                session_id: None,
                username: None,
                usernames: Some(usernames.to_vec()),
                limit: None,
                offset: None,
            })
        })?;
        if !resp.ok {
            return Err(resp.error.unwrap_or_else(|| "display_names failed".into()));
        }
        let mut map = std::collections::HashMap::new();
        if let Some(Value::Object(obj)) = resp.data {
            for (k, v) in obj {
                if let Some(s) = v.as_str() {
                    if !s.is_empty() {
                        map.insert(k, s.to_string());
                    }
                }
            }
        }
        Ok(map)
    }
}

impl Drop for WcdbHandle {
    fn drop(&mut self) {
        let _ = with_worker(|w| {
            w.request(WorkerRequest {
                id: 0,
                cmd: "close".into(),
                resource_root: None,
                account_dir: None,
                key: None,
                wxid: None,
                session_id: None,
                username: None,
                usernames: None,
                limit: None,
                offset: None,
            })
        });
    }
}
