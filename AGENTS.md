# AGENTS.md — Weport Project Constraints

> **Read this before making any UI, popup, or WCDB-related changes.**
> These constraints encode hard-won debugging sessions (the -1006 host check,
> Electron stdin EOF, zero-window quit). Violating them produces subtly broken
> builds that pass typecheck.

## Tech Stack (Permanent)

Wexport is an **Electron + React + Vite + TypeScript** desktop app for
**Windows and macOS (Apple Silicon, arm64)**. The engine
(`electron/services/`) is a TypeScript port of WeFlow's WCDB stack (koffi FFI
+ native `wcdb_api.dll` / `libwcdb_api.dylib`). There is **no Rust, no Tauri,
no CLI** anymore — the v0.6.x Rust/egui stack and the headless engine CLI were
removed in 0.7.0.

Platform split lives in `process.platform` branches (same tree, no fork):
- Key service: Windows `keyService.ts` vs macOS `keyServiceMac.ts`
  (selected in `appMain.ts` `key:autoGetDbKey`; Linux not supported).
- Autostart: Windows HKCU Run key vs macOS `app.setLoginItemSettings`
  (see `appMain.ts` `setSystemLaunchAtStartup`).
- Notification glass: `@hicccc77/electron-liquid-glass` is Windows-only;
  macOS uses the Chromium desktop-stream fallback (already the default).

## WCDB Host Process (Permanent — Do Not Change)

`wcdb_api.dll` / `libwcdb_api.dylib` refuses to initialize (`-1006`) unless
the host executable is named **`WeFlow.exe`** (Windows) / **`WeFlow`**
(macOS, same-name rule). Empirically verified on Windows: any other name
fails, a renamed copy/hardlink passes. The app therefore runs the WCDB
engine in a **subprocess**:

- `electron/wcdbHostClient.ts` creates a hardlink `WeFlow[.exe]` next to the
  current exe (NTFS / APFS, zero disk cost, same dir so
  `electron.dll`/`Electron.framework`/resources resolve), then spawns it with
  `--wcdb-host`.
- `electron/main.ts` detects `--wcdb-host` and loads `wcdbHost.js`
  (separate vite entry); that process runs `wcdbHost.ts` — a stdio-free WCDB
  loop speaking the worker_threads-style message protocol over the **Node IPC
  channel** (`process.send` / `process.on('message')`).
- `electron/services/wcdbService.ts` proxies to it exactly like WeFlow's
  `wcdbService` proxied to `wcdbWorker`.

**Do not reintroduce:**

- `worker_threads` for WCDB — the name check fails inside `Wexport`'s own
  binary (any platform).
- stdio JSON-lines transport — **Electron's main-process stdin hits EOF
  immediately on Windows even with a real pipe** (verified). IPC channel only.
- A zero-window Electron process without a `window-all-closed` listener and a
  hidden 1×1 keep-alive `BrowserWindow` — Electron quits at `ready` otherwise.

## Notification Popup (Permanent — Do Not Change)

The popup is `electron/windows/notificationWindow.ts` (WeFlow port): a separate
frameless transparent `BrowserWindow` (344×114, top-right of work area,
`alwaysOnTop`, `focusable: false`, `skipTaskbar`, click-through
when hidden). Renderer: `src/pages/NotificationWindow.tsx` +
`src/components/NotificationToast.tsx` + `LiquidGlass` (native
`@hicccc77/electron-liquid-glass` panel with Chromium desktop-stream fallback;
the native glass panel is **Windows-only** — on macOS only the Chromium
fallback path runs).

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

## v0.9 Modules — 朋友圈 (SNS) / 分析 (Analytics)

The engine layer (native FFI in `wcdbCore.ts` + `wcdbHost.ts` commands +
`wcdbService.ts` proxies) was already present for SNS/analytics/group/annual
report before v0.9; the v0.9 work added the service + IPC + UI layers.

**Main process (near-verbatim WeFlow ports, adapted to WePort):**
- `electron/services/snsService.ts` (timeline parse, media fetch/decrypt via
  ISAAC64 keystream, exports, anti-delete triggers, cache migration),
  `analyticsService.ts`, `groupAnalyticsService.ts`,
  `annualReportService.ts` + `electron/annualReportWorker.ts`,
  `electron/services/isaac64.ts` + `wasmService.ts` (SNS video/image keystream
  XOR; pure-TS fallback if wasm missing).
- IPC registration lives in `appMain.ts::registerIpcHandlers` (channels
  `sns:*`, `analytics:*`, `groupAnalytics:*`, `annualReport:*`), plus helpers
  `collectLegacySnsCacheMigrationPlan` / `runLegacySnsCacheMigration` and a
  lean in-memory years-load task book (no disk snapshot persistence, unlike
  WeFlow). Preload namespaces: `src` side typed in `src/vite-env.d.ts`
  (`ElectronApi`) — **keep preload.ts and vite-env.d.ts in sync**.
- WeFlow never typechecks its electron folder; its code carries latent strict
  errors. When copying WeFlow services, run `npm run typecheck` and fix
  strict-mode issues (e.g. filter predicates, `configService.get` casts).

**Renderer (original WePort design, not a copy):**
- 朋友圈: `src/pages/SnsPage.tsx` + `src/components/sns/*` — B/W theme,
  sidebar author/keyword/date filters (hero block merges page header + stats +
  actions), media grid with in-app lightbox (`SnsPreviewLightbox`), author
  timeline dialog, export dialog (`SnsExportDialog`), anti-delete toggle,
  legacy-cache migration banner. Media loads as 720px grid thumbnails
  (main-process `nativeImage` resize in `snsService.makeGridThumbnail`); the
  lightbox/download read the full cached file via `weport-media://`.
- 分析: `src/pages/analytics/AnalyticsModule.tsx` (hub with two always
  side-by-side cards 全局分析 / 群聊分析 — light blue vs deep blue),
  `GlobalAnalytics.tsx`, `GroupAnalytics.tsx`, `AnnualReportView.tsx`. Charts
  via ECharts (`echarts-for-react`) with the shared theme in
  `src/utils/echartsTheme.ts` (blue stack `blueRamp()` colors bars by value;
  `blueVerticalGradient()` for areas). Annual report image export uses
  `html2canvas` (added dep; do not remove without replacing it).
- New styles live in `src/styles/v09.scss` (imported once from `App.tsx`).

**Color themes:** `src/utils/colorMode.ts` — `colorful` (default; single
light-blue accent family, numbers stay white, icons/charts/outlines
colored) / `mono` (gray fallback). Config key `colorMode`, applied via
`document.documentElement.dataset.theme`, charts rebuild via `useColorMode`.
ECharts palettes and ramps switch with the theme.

**Media protocol:** `weport-media://local/<encodeURIComponent(绝对路径)>` serves
decrypted local media + cached avatars to the renderer (`appMain.ts`,
registered via `registerSchemesAsPrivileged` before ready + `protocol.handle`
after ready). Renderer helper: `snsMediaProtocolUrl()` in
`src/utils/snsParse.ts`. **Never put the drive letter in the host**
(`weport-media://C:/…` breaks — Chromium normalizes `C:` to host `c` by
treating the colon as a port separator). Do not switch to `webSecurity: false`.

**Avatar pipeline (do not regress):** `electron/services/avatarCacheService.ts`
persists all avatars to `{cacheBasePath}/avatars/{sha1(url)}.jpg` and returns
`weport-media://` URLs. `chatService` prefers `head_image.db` buffers over CDN
URLs (local, offline, never expires) and persists the protocol URL into the
contact cache; cache hits validate file existence (`isResolvable`) and
re-resolve when the file is gone. `snsService` / `groupAnalyticsService` /
`messagePushService` / `analyticsService.getContactRankings` (via
`chatService.enrichSessionsContactInfo`) localize avatar URLs through the same
service. The head-image batch size is 60 (larger IPC responses truncate →
silent CDN fallback). Renderer `AvatarLoadQueue` is 8-concurrent with a 2ms
gap; local protocol URLs skip the queue entirely (`Avatar.tsx`).

**QA harness:** `WEPORT_V09_DUMP=1` drives all v0.9 pages with demo data
(see `installV09DemoHandlers` + `runV09DumpMode` in appMain.ts), asserts key
DOM nodes per page, counts renderer console errors, resizes the window to
probe responsive layouts (`.sns-main` must keep 2 columns down to the window
min width), exits non-zero on failure. Demo data is deterministic and never
persisted (config:set is swallowed) — keep it personal-info free.
`WEPORT_SCREENSHOT_POPUP` (capture-ui.ps1) now also captures the 6 v0.9
screens (sns / analytics-hub / analytics-global / annual-report /
analytics-group / settings) — 12 captures total, all asserted non-blank.

## Export Layout

GUI export (`appMain.ts` `export:exportSessions`) writes to `{out}/{FMT}/`
(FMT = TXT / JSON / HTML / XLSX / MARKDOWN / CHATLAB / CHATLAB-JSONL /
ARKME-JSON / WECLONE / SQL) with `群聊_`/`私聊_` prefixes. Defaults: 目录结构 A
(exportWriteLayout A + sessionLayout `shared`, text flat at root), conflict
`overwrite`, `sessionNameWithTypePrefix: true`; layout C maps to
`sessionLayout: per-session` (text-only exports honor it too —
`ExportOrchestrator` respects an explicit sessionLayout). Media export
auto-switches to per-session dirs. `export_log.txt` is only updated for TXT
and JSON runs (legacy v0.6.x format: `TXT: <time> · success=N fail=N` lines);
清空导出库 clears every format folder + the log.

## Contact Name Warmup

`appMain.ts::warmupContactNames()` preloads the first 600 sessions' display
names/avatars into the persisted contact cache at startup (and after
dbPath/decryptKey/myWxid config changes). Do not remove it: popups, export
progress, and the 会话过滤 picker all rely on the warmed cache to show real
nicknames instead of raw wxid codes.

## Build & Test

```sh
npm install                                   # postinstall: electron-builder install-app-deps + runtime DLL sync
npm run dev                                   # vite dev + electron (vite-plugin-electron)
npm run typecheck                             # renderer + electron typecheck
npm run build                                 # clean → tsc → vite build → electron-builder (NSIS, Windows)
npm run build:dir                             # unpacked build (faster iteration)
npm run build:mac                             # macOS DMG + ZIP (arm64, 需在 macOS 上执行)
powershell -ExecutionPolicy Bypass -File scripts/capture-ui.ps1
```

macOS packaging requires restoring the exec bit on the key helpers first
(Git does not track file modes): `chmod +x resources/key/macos/universal/*`
and `resources/welive/macos/arm64/welive` — CI workflows already do this.

`capture-ui.ps1` launches the app in `WEPORT_SCREENSHOT_POPUP` mode (the app
captures its own window via `capturePage`), then asserts all captures are
non-blank (`Assert-ImageHasContent`, stddev ≥ 12). A broken or unwired popup
fails the harness.

Screenshot mode is fully **demo-data driven**: `appMain.ts::installScreenshotDemoHandlers`
overrides `config:get`/`config:set`/`dbpath:scanWxids`/`ai:*` IPC with fake
values (fake dbPath/key/account, demo AI conversation, notes). `config:set` is
swallowed so demo values never pollute the real config, and `capture-ui.ps1
-PublishToDocs` regenerates `docs/screenshots/*.png` for the README. Never
capture real user data in screenshot mode — README shots must be personal-info
free. Popup captures use `persistent: true` (toast never auto-fades) plus a
two-frame-identical settle check, so README popup.png can't be a fading frame.

## CI

- `.github/workflows/release.yml` — builds Windows (NSIS) + macOS (DMG/ZIP,
  arm64) and publishes on tag push
- `.github/workflows/mac-attach-release.yml` — manual: builds the macOS
  installer from a branch and attaches it to the **existing** latest release
  (used to backfill a mac installer onto an already-published version)
- `.github/workflows/visual-smoke.yml` — runs the capture harness on push/PR

## Reference Repos (on-disk only, never shipped)

- `WeFlow/` — the upstream Electron app (source of the notification stack)
- `RevokeMsgPatcher/` — reference for the old v0.6.x Weixin.dll patching
  (superseded by per-session WCDB anti-revoke triggers)
- `wechattweak/` — reference for macOS WeChat binary patching (sunnyyoung,
  AGPL-3.0); not merged — the WCDB trigger approach covers macOS too
  (`libwcdb_api.dylib` exports the anti-revoke API)
