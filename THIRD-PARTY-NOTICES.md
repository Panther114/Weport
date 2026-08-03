# Third-Party Notices

Weport (MIT) incorporates or adapts code and data from the following projects.
Respective licenses apply to the portions described below; Weport itself
remains MIT licensed.

## RevokeMsgPatcher — huiyadanli (GPLv3)

https://github.com/huiyadanli/RevokeMsgPatcher — GPLv3

- `src-tauri/src/antirecall.rs` ports the patch mechanism (wildcard byte
  matcher, backup/restore, patch-data model, install-path discovery) from the
  RevokeMsgPatcher codebase.
- `src-tauri/resources/antirecall/patch.json` is a Weixin-only (WeChat 4)
  extract of RevokeMsgPatcher's patch data (防撤回 category), which itself
  collects community-discovered feature bytes (WeChat 4.0+ patterns per
  BetterWX and contributors).

## WeFlow — pptfz / WeFlow team (MIT)

https://github.com/pptfz/WeFlow — MIT

- `src-tauri/src/notify.rs` adapts WeFlow's session-diff message push logic
  (GlobalSessionMonitor / messagePushService) to Rust.
- Weport's key-extraction flow (`wx_key.dll` hook + PID/window checks in
  `src-tauri/src/key.rs`) was originally ported from WeFlow's keyService.

## BetterWX — zetaloop

https://github.com/zetaloop/BetterWX — WeChat 4.0+ anti-recall feature bytes
(via RevokeMsgPatcher).

---

Full license texts: see `LICENSE` (Weport), and the upstream repositories
above for their respective license terms.
