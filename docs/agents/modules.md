# 模块说明（SNS / 分析 / MCP / 导出 / 联系人预热）

> 从 `AGENTS.md` 拆出：这里是模块与历史说明，不是动手前必读的不变量。

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
