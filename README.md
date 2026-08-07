# Weport

**v0.7.x** — WeChat chat history exporter for Windows · Electron + React +
native engine (TypeScript port of WeFlow's WCDB stack, koffi FFI +
`wcdb_api.dll`).

Exports every contact and group chat from local WeChat **4.x** data to:

| Format | Location | File names |
|--------|----------|------------|
| TXT | `{out}/TXT/` | `群聊_[name].txt` / `私聊_[name].txt` |
| JSON | `{out}/JSON/` | `群聊_[name].json` / `私聊_[name].json` |

Root also gets `export_log.txt` (last TXT / JSON run times). Re-export
**overwrites** same filenames.

All processing is **local**. Nothing is uploaded.

## Features

- **GUI** — 4 tabs: 连接 / 导出 / 防撤回 / 通知
- **Key extraction** — `wx_key.dll` hook captures the DB key during WeChat
  login (same model as WeFlow)
- **WCDB access** — `wcdb_api.dll` via a `WeFlow.exe`-named host subprocess
  (the DLL's `-1006` security check requires that exact process name)
- **Notification popup** — top-right always-on-top liquid-glass toast for
  incoming messages and recalls; independent `BrowserWindow`, works while
  tray-hidden (logic from WeFlow's `messagePushService`). Glass is rendered
  from a single static desktop snapshot (CSS filters, zero live-capture cost)
  with adaptive text contrast — readable on any background. Group avatars are
  fetched with WeChat CDN request headers so they display correctly.
- **Self-filtering** — messages you send, and recalls you perform yourself,
  never trigger a popup.
- **Anti-recall (WeChat 4)** — per-session WCDB triggers so recalled messages
  stay visible (WeFlow mechanism, not the old Weixin.dll patch)
- **Tray + background** — auto-start at login, tray-only by default, close to
  tray
- **NSIS installer** (English + 简体中文), **auto-update** via GitHub Releases
  (electron-updater)

## History

- **v0.7.0** — full migration from the Rust/egui stack to Electron + React
  (engine kept as a TypeScript port), with the v0.6.x user settings (data
  path, decrypt keys) migrated automatically on first run.
- **v0.7.1–v0.7.5** — real-data verified exports, popup fixes (transparent
  window, avatar CDN headers, no hover/click reactions, readability scrim),
  icon/branding fixes, installer and memory size optimizations (locales
  trimmed, media deps removed: installer ~100 MB), updater verified end-to-end.

## Getting the database key (important)

Same model as WeFlow: the key is captured **during WeChat login**, not from a
fully auto-logged-in session.

1. Disable WeChat **auto-login**
2. Click **提取密钥**
3. When status says **已准备就绪**, log in / re-login WeChat (confirm on phone
   if asked)
4. Key fills in (or paste a known 64-char hex key manually)

## Develop

Requirements: Node 20+, Windows (the app is Windows-only).

```sh
npm install
npm run dev          # vite dev + electron
npm run typecheck    # renderer + main process
npm run build        # tsc → vite → electron-builder (NSIS installer in release/)
npm run build:dir    # unpacked build (faster iteration)
powershell -ExecutionPolicy Bypass -File scripts/capture-ui.ps1   # UI smoke test
```

### Release build

```sh
npm run build
```

Artifacts: `release/Weport-<version>-Setup.exe` + `latest.yml` (updater).

## Architecture

| Layer | Role |
|-------|------|
| `electron/appMain.ts` | Main process: window, tray, IPC, updater, export, notifications wiring |
| `electron/services/` | WeFlow engine port: `chatService`, `wcdbCore`, `keyService`, `export/`, `messagePushService` |
| `electron/wcdbHost.ts` | WCDB host subprocess (runs as `WeFlow.exe --wcdb-host`, IPC protocol) |
| `electron/windows/notificationWindow.ts` | Liquid-glass notification popup |
| `src/` | React renderer (Weport GUI + NotificationWindow) |
| `resources/` | Native DLLs: `wcdb`, `key`, `wedecrypt`, `runtime` |
| `assets/branding/weport-icon.jpg` | **Sole** app icon source |

## Privacy

Runs entirely on your machine. Uses your local WeChat data directory and a
decrypt key extracted from a logged-in client.

## Disclaimer

This tool is provided for **personal learning and local data archiving only**.
By using it you agree to:

- Comply with WeChat's Software License and Service Agreement and the laws of
  your jurisdiction.
- Only process the **local data of your own WeChat account**.
- Assume full responsibility for any misuse, including but not limited to
  violating others' privacy, breaching WeChat's terms of service, or using the
  tool for commercial purposes.

The author assumes **no liability** for any consequences arising from improper
or irresponsible use of this tool.

## License

[MIT](./LICENSE) — free to use, modify, and redistribute.
