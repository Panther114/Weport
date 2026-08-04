# Weport

**Lightweight WeChat chat history exporter for Windows** — pure **native Rust + egui** (no Electron, no WebView2).

Exports every contact and group chat from local WeChat **4.x** data to:

| Format | Location | File names |
|--------|----------|------------|
| TXT | `{out}/TXT/` | `群聊_[name].txt` / `私聊_[name].txt` |
| JSON | `{out}/JSON/` | `群聊_[name].json` / `私聊_[name].json` |

Root also gets `export_log.txt` (last TXT / JSON run times). Re-export **overwrites** same filenames.

All processing is **local**. Nothing is uploaded.

## Installer size

Native stack only (~14 MB DLLs + Tauri binary). No Chromium, no Electron.

## Features

- **GUI** — compact native egui UI (no WebView, no Electron)
- **CLI** — same binary: `weport export …`, `weport antirecall …`
- Auto-scan default data folder (`Documents\xwechat_files`)
- Auto key extraction via `wx_key.dll` (WeChat must be logged in)
- WCDB access via `wcdb_api.dll` (pure Rust FFI)
- NSIS installer (English + 简体中文)
- Auto-update (GUI + `weport update`)
- **Anti-recall (WeChat 4)** — patch `Weixin.dll` so recalled messages stay visible inside WeChat (mechanism from [RevokeMsgPatcher](https://github.com/huiyadanli/RevokeMsgPatcher), GPLv3)
- **Message popup** — top-right always-on-top toast for incoming messages and recalls (requires the decrypt key; logic adapted from WeFlow)
- **Tray + background** — close to tray, silent startup, launch at Windows login (Settings → 设置)

## Getting the database key (important)

Same model as WeFlow: the key is captured **during WeChat login**, not from a fully auto-logged-in session.

1. Disable WeChat **auto-login**
2. Click **提取密钥** (or `weport key`)
3. When status says **已准备就绪**, log in / re-login WeChat (confirm on phone if asked)
4. Key fills in (or paste a known 64-char hex key manually)

## Anti-recall & popup (v0.6.1)

- **首页 → 安装防撤回**: patch WeChat's `Weixin.dll` so recalled messages stay visible inside WeChat. Requires WeChat 4 (Weixin.exe), admin elevation (UAC) and a fully closed WeChat. Re-apply after each WeChat update; restore via 还原补丁.
- **首页 → 消息提醒**: with the decrypt key available, Weport watches the account's local databases and shows a top-right, always-on-top, non-focusing toast for new incoming messages and recalls. Recalled-message detection works independently of the patch (reads the `revokemsg` rows WeChat writes).
- **设置**: launch at Windows login (HKCU Run key), silent background start, close-to-tray, and GitHub release update checks. Tray menu: 显示主窗口 / 退出.

## CLI

```bash
weport help
weport version
weport detect
weport accounts --db "C:\Users\me\Documents\xwechat_files"
weport key
weport antirecall status
weport antirecall apply
weport antirecall remove
weport export --db "..." --wxid wxid_xxx --key <hex> --out D:\export --format txt
weport update
weport update --install
```

## Develop

Requirements: Node 20+, Rust stable, WebView2 (Windows).

```bash
npm install
npm run dev          # Tauri dev shell (vestigial; the app runs native egui)
cargo run --manifest-path src-tauri/Cargo.toml -- detect
```

### Release build

```bash
npm run icons                     # regenerate the white icon set
cargo build --release --manifest-path src-tauri/Cargo.toml
# ensure src-tauri/resources/native/win32/x64 has WCDB + wx_key DLLs
powershell -File scripts/package-release.ps1   # NSIS installer + signed latest.json
```

Artifacts: `src-tauri/target/release/bundle/nsis/` (`Weport_<version>_x64-setup.exe` + `latest.json`).

## Architecture

| Layer | Role |
|-------|------|
| `src-tauri/src/gui.rs` | Native egui GUI (main window, settings, toast viewport) |
| `src-tauri/src/` | CLI + WCDB worker + export engine + anti-recall + notify watcher + tray |
| `src-tauri/resources/` | WCDB + key DLLs + anti-recall patch data |
| `scripts/generate-icons.mjs` | White icon generator (single source of truth) |
| `assets/icons/icon.png` | App window icon (embedded) |

No Node/Electron/WebView2 runtime is shipped in the product binary.

## Privacy

Runs entirely on your machine. Uses your local WeChat data directory and a decrypt key extracted from a logged-in client.

## License

See [LICENSE](./LICENSE).
