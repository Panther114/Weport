# AGENTS.md — Weport Project Constraints

> **Read this before making any UI, popup, or WCDB-related changes.**
> These constraints encode hard-won debugging sessions (the -1006 host check,
> Electron stdin EOF, zero-window quit). Violating them produces subtly broken
> builds that pass typecheck.

## Tech Stack (Permanent)

Weport is an **Electron + React + Vite + TypeScript** desktop app for
**Windows, macOS (Apple Silicon, arm64) and Linux (x64, v0.9.10+)**. The engine
(`electron/services/`) is a TypeScript port of WeFlow's WCDB stack (koffi FFI
+ native `wcdb_api.dll` / `libwcdb_api.dylib` / `libwcdb_api.so`). There is
**no Rust, no Tauri, no CLI** anymore — the v0.6.x Rust/egui stack and the
headless engine CLI were removed in 0.7.0.

Platform split lives in `process.platform` branches (same tree, no fork):
- Key service: Windows `keyService.ts` vs macOS `keyServiceMac.ts` vs Linux
  `keyServiceLinux.ts` (selected in `appMain.ts` `key:autoGetDbKey`; Linux
  wired in v0.9.10 — helper `resources/key/linux/x64/xkey_helper_linux`,
  sudo via `@vscode/sudo-prompt`, prompt name **Weport**).
- Autostart: Windows HKCU Run key vs macOS/Linux `app.setLoginItemSettings`
  (Linux → XDG autostart; see `appMain.ts` `setSystemLaunchAtStartup`).
- Notification glass: `@hicccc77/electron-liquid-glass` is Windows-only
  (explicitly gated on `process.platform === 'win32'`);
  macOS/Linux use the Chromium desktop-stream fallback (already the default).
- WeChat data dir: Linux 微信 4.x lives at `~/xwechat_files`
  (`dbPathService.autoDetect/getDefaultPath` linux branches).

## Linux Packaging (v0.9.10)

- `npm run build:linux` → AppImage + tar.gz x64 (`build.linux` in
  package.json; artifactName `Weport-${version}-${arch}.${ext}` — do NOT let
  it inherit the top-level `-Setup.` name). CI: `release.yml` `build-linux`
  job on ubuntu-latest; must `chmod +x resources/key/linux/x64/xkey_helper_linux`
  before packaging (Git-on-Windows loses the exec bit).
- Native artifacts ship from `resources/{wcdb,key,wedecrypt}/linux/x64/`
  via per-platform `extraResources`. `welive` is NOT shipped on Linux
  (no runtime consumer). koffi's platform binary comes from the optional dep
  `@koromix/koffi-linux-x64`, installed automatically when npm runs ON Linux;
  `asarUnpack` includes `node_modules/@koromix/**/*`.
- Read-only install dirs (AppImage squashfs, `/opt`, `/usr/bin`): hardlink
  creation next to the exe fails, so `wcdbHostClient.resolveHostExe()` falls
  back to COPYING the Electron binary to `{userData}/wcdb-host/WeFlow`
  (mtime-aligned for reuse detection) and adds both the copy dir and the real
  Electron dist dir to `LD_LIBRARY_PATH`. Escape hatch: `WEPORT_WCDB_HOST_EXE`.
- The `-1006` name check for `libwcdb_api.so` under a host named `WeFlow` is
  unverified on real Linux hardware (upstream ships its own exe as lowercase
  `weflow`, suggesting the check may be looser there); treat first-boot DB
  connect on Linux as the acceptance test.
- safeStorage on headless Linux often has no backend: config falls back to
  plaintext secrets (existing graceful degradation, unchanged).

## WCDB Host Process (Permanent — Do Not Change)

`wcdb_api.dll` / `libwcdb_api.dylib` refuses to initialize (`-1006`) unless
the host executable is named **`WeFlow.exe`** (Windows) / **`WeFlow`**
(macOS, same-name rule). Empirically verified on Windows: any other name
fails, a renamed copy/hardlink passes. The app therefore runs the WCDB
engine in a **subprocess**:

- `electron/wcdbHostClient.ts` creates a hardlink `WeFlow[.exe]` next to the
  current exe (NTFS / APFS, zero disk cost, same dir so
  `electron.dll`/`Electron.framework`/resources resolve), then spawns it with
  **`ELECTRON_RUN_AS_NODE=1`** (v0.9.3+) so the same binary runs as pure
  Node.js — no Chromium browser process, no network utility child
  (host RSS ≈ 45 MB vs ≈ 105 MB + 50 MB child in Electron mode). The `-1006`
  check only inspects the exe filename, not the runtime.
- Host script path: dev `dist-electron/wcdbHost.js` (koffi resolves from the
  project `node_modules`); packaged `resources/host/wcdbHost.js` — plain Node
  cannot read `app.asar`, so `scripts/prepare-host-bundle.cjs` copies the
  script + `koffi` + `@koromix/koffi-*` platform binaries into
  `resources/host/libs/` (NOT `node_modules/` — electron-builder's
  extraResources copy filter hard-excludes root-level `node_modules`), and
  `wcdbHostClient` sets `NODE_PATH=<resources>/host/libs` for resolution.
- `electron/wcdbHost.ts` runs the stdio-free WCDB loop speaking the
  worker_threads-style message protocol over the **Node IPC channel**
  (`process.send` / `process.on('message')`). The `require('electron')`
  block is try/catch-guarded and skipped in Node mode; `--wcdb-host` in
  `main.ts` still works for manual Electron-mode launches.
- `electron/services/wcdbService.ts` proxies to it exactly like WeFlow's
  `wcdbService` proxied to `wcdbWorker`.

**Do not reintroduce:**

- `worker_threads` for WCDB — the name check fails inside Weport's own
  binary (any platform).
- stdio JSON-lines transport — **Electron's main-process stdin hits EOF
  immediately on Windows even with a real pipe** (verified). IPC channel only.
- Spawning the host without `ELECTRON_RUN_AS_NODE=1` — that resurrects the
  full second Chromium instance (~155 MB with its utility child).
- Root-level `node_modules` inside any `extraResources` copy — electron-builder
  silently drops it (use `libs/` + `NODE_PATH`).
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

**v0.9.3+: slim entry.** The popup loads `dist/popup.html` →
`src/popup-main.tsx` (a dedicated vite input), NOT `index.html#/notification-window`
— it renders only `NotificationWindow` and its deps (no App/ECharts parse in the
popup renderer, ~50 MB less heap). Global font comes from
`src/styles/popupBase.css` (`@font-face` "Weport" + body font stack — keep it
in sync with `src/styles.css` `--font`). Never reintroduce loading the full
app bundle into the popup, and never drop `popupBase.css` (the popup falls
back to the system default font).

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
- **v0.9.3+: hidden-window memory reclamation.** When the main window stays
  hidden to the tray for `WEPORT_DISCARD_DELAY_MS` (default 5 min), the
  renderer is unloaded (`loadURL('about:blank')`); tray click / second
  instance reloads the app page and shows it again (`appMain.ts`
  `scheduleMainWindowDiscard` / `showMainWindow`). Skips while an export task
  is running (`exportTaskControlService.hasActiveTasks`) and in all QA modes.
  The restore path relies on `webContents` `did-finish-load` (not just
  `ready-to-show`, which may not re-fire on hidden-window navigation). `about:blank`
  is allowed by the `will-navigate` guard. State lives in the main process /
  config, so nothing is lost on discard.
- **v0.9.3+: Chromium memory tuning (appMain.ts `startApp`, before ready):**
  `js-flags --max-old-space-size=384 --max-semi-space-size=4`, `disk-cache-size
  16MB`, `spellcheck: false` on both windows. Do NOT use
  `appendSwitch('disable-features', …)` — it *replaces* Electron's default
  disable-features list (incl. `SpareRendererForSitePerProcess`) and can spawn
  an extra spare renderer. `--background` also calls
  `app.disableHardwareAcceleration()` (no GPU process, ~130 MB); the native
  glass panel is unaffected (D3D11 on the native side).

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
- **Keystream wasm packaging (do not regress):** `electron/assets/wasm/` MUST
  ship on Windows too — `package.json` `files` includes it (asar) AND
  `win.extraResources` copies it to `resources/assets/wasm` (macOS has the
  extraResources entry). `wasmService` resolves resources first, asar second.
  The pure-TS `isaac64.ts` output is byte-different from the wasm (verified)
  — never "fall back" to it for decryption (garbage → 加载失败); `snsService`
  fails fast with a clear message instead.
- **Avatar head-image locator (do not regress):** `avatarCacheService` keeps a
  persistent `headImages.json` (username → local avatar file, negative-cache
  24h TTL). Group member panels / rankings / SNS authors / session lists all
  resolve avatars through it FIRST (zero host calls on hit); only misses query
  `getHeadImageBuffers` (batch ≤ 60) and record back via `recordHeadAvatar`.
  Without it, every group open re-reads head_image.db for every member.
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

## v0.9.5 Modules — MCP 服务 / 分析新图表

**MCP server (`electron/services/mcpService.ts`, do not regress):**
- Streamable HTTP on `127.0.0.1:{mcpPort}` (default 5032, HTTP API is 5031),
  Bearer auth via `mcpToken` (auto-generated 32-hex, safeStorage-encrypted,
  fallback `httpApiToken`). 13 read-only tools proxying existing read-only
  services (`chatService` / `snsService` / `analyticsService` /
  `groupAnalyticsService`); no write/send/delete capability.
- **Per-session `McpServer` instance is mandatory** — `Protocol.connect()`
  throws "Already connected" after the first transport, so a single shared
  server cannot serve two sessions. `createSession()` builds a fresh
  `McpServer` + `StreamableHTTPServerTransport` per session and registers it in
  the sessions map from the transport's `onsessioninitialized` callback (the
  session id is generated lazily inside the first `handleRequest` — inserting
  into the map earlier stores key `undefined` and silently loses the session).
- `transport.handleRequest(req, res, body)` expects `parsedBody` to be an
  **already-JSON-parsed object** (body-parser semantics), not a raw string —
  passing a string yields `-32700 Parse error` from the SDK.
- `client.request(request, resultSchema)` (bridge side) requires a real
  `resultSchema` — undefined crashes with `Cannot read properties of undefined
  (reading '_zod')` inside the SDK's response validation. The bridge passes
  `z.any()` to forward arbitrary methods transparently.
- Config keys (in `ConfigSchema` + defaults + `ENCRYPTED_STRING_KEYS` for
  token): `mcpEnabled` (default true), `mcpPort` 5032, `mcpHost` 127.0.0.1,
  `mcpToken` (''). IPC `mcp:getStatus`; `mcpService.stop()` in
  `shutdownAppServices`; auto-start next to the httpService block in
  `startApp`.
- **stdio bridge packaging (do not regress):** `scripts/mcp-stdio-bridge.mjs`
  (dev) is bundled by `scripts/prepare-mcp-bundle.cjs` (esbuild, CJS,
  `--target=node18`) to `resources/mcp/mcp-stdio-bridge.cjs` — the AI host runs
  it under its **own system Node**, so the SDK/zod deps must be inside the
  single-file bundle, no NODE_PATH/ESM reliance. The prep script runs in
  `build` / `build:dir` / `build:mac` / `package` before electron-builder, and
  `resources/mcp → mcp` must stay in BOTH win and mac `extraResources`. The
  shebang is prepended manually after the build (`--banner:js` puts it on line
  2 → SyntaxError).
- Claude Desktop config: `{"mcpServers": {"weport": {"command": "<install>/resources/mcp/mcp-stdio-bridge.cjs", "args": ["--port", "5032", "--token", "<mcpToken>"]}}}`; token is in the settings store (safeStorage-encrypted on disk) or via the settings UI when exposed.

**v0.9.5 analytics charts (do not regress):**
- Global: 交流画像 radar (6 dims incl. 深夜活跃 23:00–05:59), 活跃日历 calendar
  (rolling ≤12 months, visualMap), 高频词云 wordCloud (`echarts-wordcloud@2.1.0`
  — verified compatible with ECharts 6.1.0, registers on `echarts/lib/echarts`).
- Group: 画像 tab (member radar + 24×7 heatmap), member dialog word cloud
  (Top 40). Data: `analyticsService.getDailyActivity(force)` /
  `getWordFrequency(limit, force)` (150k scanned-text cap, 10-min cache) /
  `groupAnalyticsService.getGroupActivityHeatmap(...)` (7×24, 5-min cache +
  in-flight dedup); tokenizer/stopwords shared in
  `electron/services/wordFrequency.ts`.
- Demo/QA: `demoAnalyticsData`/`demoGroupData` gained `dailyActivity` /
  `wordFrequency` / `activityHeatmap` / member `wordCloud`; dump probes
  `globalV095` (charts ≥ 7), `profileV095` (radar+heatmap), `memberWordCloudV095`.
  Installed with `--legacy-peer-deps` (`echarts-wordcloud` peers `echarts ^5`).

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
npm run build                                 # clean → tsc → vite build → prepare-host-bundle → electron-builder (NSIS, Windows)
npm run build:dir                             # unpacked build (faster iteration; same chain)
npm run build:mac                             # macOS DMG + ZIP (arm64, 需在 macOS 上执行)
npm run build:linux                           # Linux AppImage + tar.gz (x64, 需在 Linux 上执行)
powershell -ExecutionPolicy Bypass -File scripts/capture-ui.ps1
```

macOS packaging requires restoring the exec bit on the key helpers first
(Git does not track file modes): `chmod +x resources/key/macos/universal/*`
and `resources/welive/macos/arm64/welive` — CI workflows already do this.
Linux packaging likewise: `chmod +x resources/key/linux/x64/xkey_helper_linux`.

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
  arm64) + Linux (AppImage/tar.gz, ubuntu-latest) and publishes on tag push
- `.github/workflows/mac-attach-release.yml` — manual: builds the macOS
  installer from a branch and attaches it to the **existing** latest release
  (used to backfill a mac installer onto an already-published version)
- `.github/workflows/visual-smoke.yml` — runs the capture harness on push/PR

## Releases

When releasing a new version on GitHub, write the release body as
**concise, natural Chinese bullet points** — short plain bullets, no English
fluff, no boilerplate. Create the release with `gh release create` BEFORE the
CI publish step finishes: release.yml passes `body_path: RELEASE_NOTES.md` with
default `update_release_body: false`, so a pre-created release keeps its body
and CI only attaches installers. Tag name must match `package.json` version
(`v0.9.9` ↔ `0.9.9`) — the workflow fails otherwise.

- Release title MUST be `Weport vX.X.X` (e.g. `Weport v0.9.9`), never bare `vX.X.X` with `gh release create vX.X.X --title "Weport vX.X.X"`.
- Release body MUST contain ONLY that version's section from `RELEASE_NOTES.md`
  (from `# Weport vX.X.X` until the next `# Weport` heading), never the entire
  changelog file. Example: extract with `sed -n '/^# Weport v0.9.9$/,/^# Weport /p' RELEASE_NOTES.md | sed '$d'`
  or pass only the 5–6 bullets for that version to `gh release create --notes` / `gh release edit --notes`. Pushing the full file is a release-notes regression.

## Reference Repos (on-disk only, never shipped)

All reference clones live under `reference-projects/` (git-ignored, see
`reference-projects/README.md` for the index and per-repo notes):

- `reference-projects/WeFlow/` — the upstream Electron app (source of the
  notification stack; ported service layer)
- `reference-projects/Reasonix/` — DeepSeek-Reasonix (Go coding agent engine;
  source of the cache-aware context maintenance pattern in
  `weportAiService.ts`)
- `reference-projects/RevokeMsgPatcher/` — reference for the old v0.6.x
  Weixin.dll patching (superseded by per-session WCDB anti-revoke triggers)
- `reference-projects/wechattweak/` — reference for macOS WeChat binary
  patching (sunnyyoung, AGPL-3.0); not merged — the WCDB trigger approach
  covers macOS too (`libwcdb_api.dylib` exports the anti-revoke API)
- `reference-projects/<others>/` — third-party WeChat tools cloned for study
  (chat history exporters, moments/朋友圈 analyzers, bots/auto-repliers, …);
  read-only, never shipped, never imported by the build

## v0.9.6 Reference-Study Policy

Every requirement marked `***` in the v0.9.6 implementation brief MUST be
implemented only after carefully studying the relevant read-only projects under
`reference-projects/`. Each implementation handoff must record:

- references studied;
- patterns adopted;
- patterns rejected; and
- Weport-specific deviations and why they are necessary.

Reference code and assets are evidence and design input only. They must never
be copied or shipped blindly, and must not bypass Weport's WCDB host,
packaging, security, or platform constraints.
