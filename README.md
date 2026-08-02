# Weport

**Lightweight WeChat chat history exporter for Windows** — pure **Tauri** (no Electron).

Exports every contact and group chat from local WeChat **4.x** data to:

| Format | File names |
|--------|------------|
| TXT | `群聊_[name].txt` / `私聊_[name].txt` |
| JSON | `群聊_[name].json` / `私聊_[name].json` |

All processing is **local**. Nothing is uploaded.

## Installer size

Native stack only (~14 MB DLLs + Tauri binary). No Chromium, no Electron.

## Features

- **GUI** — compact modern Tauri app
- **CLI** — same binary: `weport export …`
- Auto-scan default data folder (`Documents\xwechat_files`)
- Auto key extraction via `wx_key.dll` (WeChat must be logged in)
- WCDB access via `wcdb_api.dll` (pure Rust FFI)
- NSIS installer (English + 简体中文)
- Auto-update (GUI + `weport update`)

## CLI

```bash
weport help
weport version
weport detect
weport accounts --db "C:\Users\me\Documents\xwechat_files"
weport key
weport export --db "..." --wxid wxid_xxx --key <hex> --out D:\export --format txt
weport update
weport update --install
```

## Develop

Requirements: Node 20+, Rust stable, WebView2 (Windows).

```bash
npm install
npm run dev          # Tauri GUI
cargo run --manifest-path src-tauri/Cargo.toml -- detect
```

### Release build

```bash
npm run icons
# ensure src-tauri/resources/native/win32/x64 has WCDB + wx_key DLLs
npm run tauri:build
```

Artifacts: `src-tauri/target/release/bundle/nsis/`.

## Architecture

| Layer | Role |
|-------|------|
| `src/` | React GUI |
| `src-tauri/` | Tauri shell, CLI, Rust export engine |
| `src-tauri/resources/native/win32/x64/` | WCDB + key DLLs only |

No Node/Electron runtime is shipped.

## Privacy

Runs entirely on your machine. Uses your local WeChat data directory and a decrypt key extracted from a logged-in client.

## License

See [LICENSE](./LICENSE).
