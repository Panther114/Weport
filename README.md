# Weport

**Lightweight WeChat chat history exporter for Windows** — CLI + GUI, professional installer, auto-update.

Weport reads local WeChat **4.x** data, decrypts chat databases with the existing extraction engine, and exports **every contact and group chat** to:

| Format | File names |
|--------|------------|
| TXT | `群聊_[name].txt` / `私聊_[name].txt` |
| JSON | `群聊_[name].json` / `私聊_[name].json` |

All processing is **local**. Nothing is uploaded.

## Features

- **GUI** — compact modern Tauri desktop app
- **CLI** — same engine from the terminal (`weport export …`)
- **Auto-scan** default WeChat data folder (`Documents\xwechat_files`)
- **Auto key extraction** (WeChat must be logged in)
- **NSIS installer** (English + 简体中文)
- **Auto-update** for GUI (in-app) and CLI (`weport update`)

## Install

Download the latest **Windows setup** from [Releases](https://github.com/Panther114/Weport/releases).

## GUI

1. Launch **Weport**
2. Confirm or browse to your WeChat data directory
3. Select the account
4. Choose **TXT** or **JSON** and an output folder
5. Click **导出全部**

## CLI

```bash
weport help
weport version
weport detect
weport accounts --db "C:\Users\me\Documents\xwechat_files"
weport key
weport export --db "..." --wxid wxid_xxx --key <hex> --out D:\export --format txt --all
weport update
weport update --install
```

## Develop

Requirements: Node 20+, Rust (stable), WebView2 (Windows).

```bash
npm install
npm run build:engine
npm run cli -- detect

# GUI (dev)
npm run dev
```

### Release build

```bash
# 1) Package extraction engine
npm run build:engine:pack
node scripts/prepare-engine-resources.cjs

# 2) Generate icons (first time)
node scripts/generate-icons.mjs

# 3) Build Tauri NSIS installer + updater artifacts
npm run tauri:build
```

Artifacts land under `src-tauri/target/release/bundle/nsis/`.

## Architecture

| Layer | Role |
|-------|------|
| `src/` | React GUI |
| `src-tauri/` | Tauri shell, CLI entry, updater, engine orchestration |
| `electron/` | Headless WeChat decrypt/export engine (WCDB / keys) |
| `resources/` | Native binaries (WCDB, key helpers) |

The engine is bundled beside the GUI and invoked for detect / key / export. Electron is used only as a native runtime — not as the UI framework.

## Privacy

- Runs entirely on your machine
- Uses your local WeChat data directory and decrypt keys extracted from a logged-in client
- No telemetry required for core export

## License

See [LICENSE](./LICENSE). Extraction helpers and native modules retain their upstream licenses.

## Credits

Built on the WeChat 4.x local extraction approach pioneered by the WeFlow / community decrypt tooling ecosystem.
