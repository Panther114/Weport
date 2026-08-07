# AGENTS.md — Weport Project Constraints

> **Read this before making any UI, popup, or WCDB-related changes.**
> These constraints encode hard-won debugging sessions (the -1006 host check,
> Electron stdin EOF, zero-window quit). Violating them produces subtly broken
> builds that pass typecheck.

## Tech Stack (Permanent)

Weport is an **Electron + React + Vite + TypeScript** desktop app for Windows.
The engine (`electron/services/`) is a TypeScript port of WeFlow's WCDB stack
(koffi FFI + native `wcdb_api.dll`). There is **no Rust, no Tauri, no CLI**
anymore — the v0.6.x Rust/egui stack and the headless engine CLI were removed
in 0.7.0.

## WCDB Host Process (Permanent — Do Not Change)

`wcdb_api.dll` refuses to initialize (`-1006`) unless the host executable is
named **`WeFlow.exe`**. Empirically verified: any other name fails, a renamed
copy/hardlink passes. The app therefore runs the DLL in a **subprocess**:

- `electron/wcdbHostClient.ts` creates a hardlink `WeFlow.exe` next to the
  current exe (NTFS, zero disk cost, same dir so `electron.dll`/resources
  resolve), then spawns it with `--wcdb-host`.
- `electron/main.ts` detects `--wcdb-host` and loads `wcdbHost.js`
  (separate vite entry); that process runs `wcdbHost.ts` — a stdio-free WCDB
  loop speaking the worker_threads-style message protocol over the **Node IPC
  channel** (`process.send` / `process.on('message')`).
- `electron/services/wcdbService.ts` proxies to it exactly like WeFlow's
  `wcdbService` proxied to `wcdbWorker`.

**Do not reintroduce:**

- `worker_threads` for WCDB — the DLL check fails inside `weport.exe`.
- stdio JSON-lines transport — **Electron's main-process stdin hits EOF
  immediately on Windows even with a real pipe** (verified). IPC channel only.
- A zero-window Electron process without a `window-all-closed` listener and a
  hidden 1×1 keep-alive `BrowserWindow` — Electron quits at `ready` otherwise.

## Notification Popup (Permanent — Do Not Change)

The popup is `electron/windows/notificationWindow.ts` (WeFlow port): a separate
frameless transparent `BrowserWindow` (344×114, top-right of work area,
`alwaysOnTop "screen-saver"`, `focusable: false`, `skipTaskbar`, click-through
when hidden). Renderer: `src/pages/NotificationWindow.tsx` +
`src/components/NotificationToast.tsx` + `LiquidGlass` (native
`@hicccc77/electron-liquid-glass` panel with Chromium desktop-stream fallback).

Pipeline: `chatService` monitor pipe → `messagePushService.handleDbMonitorChange`
→ `emitPush` → `appMain.ts` `buildPopupData` → `showNotification`.

**Do not reintroduce:**

- Any GDI/native Win32 popup renderer (the v0.6.x `toast_win` failure mode).
- `setContentProtection` removal — it exists to stop the glass filming itself.
  **QA harness note:** content protection blanks `webContents.capturePage` on
  Windows; `appMain.ts::runScreenshotMode` temporarily disables it before
  capturing (test-only path).

## Tray / Hidden-Window Behavior

- Closing the window hides it (tray mode, default); quit only via tray menu.
- `--background` starts hidden (auto-start Run key with silent startup).
- Unlike winit, `BrowserWindow.hide()` does **not** stop the event loop, so the
  popup keeps working while tray-hidden — this is why the v0.6.x
  "minimize + hide-from-taskbar" workaround is obsolete.

## Self-sent Message Filtering

`messagePushService.ts` (WeFlow logic) filters on `message.isSend === 1`
in `pushSessionMessages`/`buildPayload`. Keep that intact.

## Export Layout

GUI export (`appMain.ts` `export:exportSessions`) writes to `{out}/TXT/` or
`{out}/JSON/` with `群聊_`/`私聊_` prefixes (engine formatters, writeLayout C,
overwrite strategy), then updates `{out}/export_log.txt` in the legacy
v0.6.x format (`TXT: <time> · success=N fail=N` lines).

## Build & Test

```sh
npm install                                   # postinstall: electron-builder install-app-deps + runtime DLL sync
npm run dev                                   # vite dev + electron (vite-plugin-electron)
npm run typecheck                             # renderer + electron typecheck
npm run build                                 # clean → tsc → vite build → electron-builder (NSIS)
npm run build:dir                             # unpacked build (faster iteration)
powershell -ExecutionPolicy Bypass -File scripts/capture-ui.ps1
```

`capture-ui.ps1` launches the app in `WEPORT_SCREENSHOT_POPUP` mode (the app
captures its own main window + popup via `capturePage`), then asserts both
captures are non-blank (`Assert-ImageHasContent`, stddev ≥ 12). A broken or
unwired popup fails the harness.

## CI

- `.github/workflows/release.yml` — builds + publishes on tag push
- `.github/workflows/visual-smoke.yml` — runs the capture harness on push/PR

## Reference Repos (on-disk only, never shipped)

- `WeFlow/` — the upstream Electron app (source of the notification stack)
- `RevokeMsgPatcher/` — reference for the old v0.6.x Weixin.dll patching
  (superseded by per-session WCDB anti-revoke triggers)
