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
**no Rust, no Tauri** anymore — the v0.6.x Rust/egui stack was removed in 0.7.0.
(The v1.0 `weport` TUI in `packages/weport-tui` is a *client* of the app, not a
second engine; see "Weport TUI" below before touching it.)

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

## v0.9.11 Notification / Platform Constraints

- Chat notifications respect WeChat `isMuted` by default. Muted messages must
  still advance the push baseline so unmuting never replays old messages.
- The `mentions` filter mode uses structured message-source `atuserlist`
  metadata and the account identity set. Never infer mentions from visible
  `@name` text, and do not treat `@所有人` as a direct mention.
- Notification filter session lists are newest-first by session timestamp;
  contact-name enrichment must not reorder them.
- Notification duration is stored in milliseconds, edited as a numeric seconds
  field (1-60), and defaults to 3000 ms for new installs.
- macOS packaging must run `scripts/after-pack.cjs` to rewrite the WCDB
  framework install name to the colocated `libWCDB.dylib`. Do not remove the
  `afterPack` hook without replacing and verifying this dependency repair.
- Shipped macOS native WCDB/key artifacts require macOS 15+ and Apple Silicon;
  Linux artifacts require glibc 2.34+, GLIBCXX 3.4.30+, and OpenSSL 3.
- Linux key capture must discover/attach to one WeChat process. Never restore
  kill-all or concurrent multi-candidate launching. Linux autostart is an XDG
  desktop entry; Electron `setLoginItemSettings` is not a Linux API.
- Weport remains read-only with no personal-account send transport. Do not add
  auto-reply by writing WCDB rows or importing version-specific injection/RPA.

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

## Weport TUI (`packages/weport-tui`) — v1.0

`weport` in a terminal opens a full TUI; `weport <command>` runs one command.
**The TUI is a client of the main process, not a port of the renderer**: it spawns
`Weport.exe --cli` (dev: `release/win-unpacked/Weport.exe`) and speaks JSON-RPC over
the **Node IPC channel** — never over stdin/stdout, because Windows reads EOF on the
main process's stdin immediately (same trap as the WCDB host transport). The engine
side is `appMain.ts::runCliHost` + `services/weportCommands.ts` (registry) +
`services/cliCommands.ts` (the command set, delegating to the same services the IPC
handlers use). Add a command there and it reaches the terminal, the command palette
and (later) MCP at once; do not add a parallel code path.

Rules:

- The handshake is a one-shot token (`--weport-token` + `WEPORT_CLI_TOKEN`); a client
  that fails it gets an error and the engine exits. Do not weaken this to make a
  debugging client work.
- The engine exits on `process.on('disconnect')` and stops MCP/HTTP/WCDB on shutdown.
  Keep that: an orphaned engine holds the WeChat database and keeps pushing popups.
- `--dump <dir>` renders one frame per section to text files. It is the only way to
  verify layout outside a real terminal, so it is a product feature, not debug
  residue: `npm run qa:tui` asserts frame width, non-blankness and key content, and
  `scripts/verify-tui-engine.mjs` asserts the protocol against real data. `build`,
  `build:dir`, `build:mac` and `build:linux` run `build:tui` first so the shipped app
  and the TUI never disagree about the command surface.

## Connectors (`electron/services/connectors/`) — v1.0

Third-party tools Weport writes to (Todoist first). A connector is a transport + capability
list; `connectorsService` owns credentials and is the only thing that may hand a token to a
connector.

- Credentials live in **one** safeStorage-encrypted config value (`weportConnectorsBlob`), like
  provider profiles. The renderer only ever receives a mask (`····9f2c`) — never add an IPC
  path that returns the token.
- `connect` verifies before it stores: a saved-but-unverified credential shows a green
  "connected" badge on a broken integration, so a failed check must store nothing.
- Todoist specifics that cost real debugging time: `POST /api/v1/tasks` answers **308** to a
  newer API version and Node's `fetch` will not replay a body across it (the connector follows
  the `Location` header itself — without that the live call reports a bare "fetch failed");
  priority is **inverted** between the REST body (1 = normal … 4 = urgent) and Todoist's own
  Quick Add syntax (`p1` = urgent); an omitted `project_id` means the Inbox, so "no target" is
  a valid request. Chunked uploads to `weclone-server` cap at 1200 chars per chunk.
- The agent reaches a connector only through `list_connector_targets` /
  `create_connector_task`, which appear **only when a connector is connected** and are gated by
  `connectorsAllowAgent`. The tool table is frozen per run, so connecting or disconnecting in
  settings takes effect on the next turn — never mid-epoch.

## WeClone (`electron/services/weCloneService.ts`) — v1.0 (local-only)

Cloning yourself and talking to the clone. **Data never leaves the device.** There is no
server, no upload, and no cloud path — the boundary is hard. The only outbound call is the
user's own configured model API.

- `chatWithClone()` is the one entry point, reached from the card's 开始对话 button
  (`weCloneService` → IPC `weclone:chat` → the chat drawer) and from `weclone.chat` in the
  CLI/TUI. Do not add a second chat path.
- Retrieval is **local BM25** over `chunks.jsonl` (`ai/localRetrieval.ts`) — no embedding
  model, no vector service. The persona MDs plus the retrieved snippets become the system
  prompt (measured: 24.7 k characters for the real clone).
- Failure has to carry a next step: `chatWithClone` returns `hint` alongside `error`. A bare
  "failed" leaves the user with no idea what to do.
- Generation is transactional: write to `${dir}.building`, rename the old clone to
  `${dir}.previous`, move the staged one in, delete the backup. A crash never leaves a
  half-written clone in place.
- Generation used to run a second, 5 %-sampled corpus pass (~800 model calls) whose output
  was only consumed by the deleted upload path. There is no such pass; generation is minutes,
  not hours.
- `weclone-server/` is **not part of the product** any more. Do not reintroduce a client
  path, a server-status surface, or a visibility/share concept.

## Video Background (`electron/services/backgroundVideoService.ts`) — v1.0

A video wallpaper is decoded on every frame for as long as the window is visible. A 4K
source on a ~1280 px-wide layer decodes ~9× the pixels anything can show, which reads as
"laggy while a video background is selected".

- `config:get('appearanceBackgroundPath')` is intercepted in `appMain.ts` and routed through
  `backgroundVideoService.resolve()`. The renderer stays ignorant of this: it asks for a
  path and gets the path it should play.
- First call returns the **original** file and starts a background `ffmpeg` transcode to
  `{cache}/background-video/<sha1>.mp4` (1920 long edge, `crf 26`, `-an`, `+faststart`).
  Later calls return the cache. Startup must never wait for ffmpeg.
- **ffmpeg is not bundled** (40–100 MB for an optional nicety). It is looked up on `PATH`,
  then common install dirs, then `WEPORT_FFMPEG`. Missing ffmpeg is not an error: the
  original file is used unchanged.
- The cache key includes size + mtime, so editing the file at the same path re-encodes.
- Measured on a 3840×2160 source at 1280×650: 48 frames >33 ms → 0, avg 17.2 → 16.7 ms.

## Agent Harness Invariants — v1.0

The harness is a DSH-derived port: it keeps DSH's cache discipline and evidence method
(`docs/reference/dsh-cache-architecture.md`), not DSH's code.

- **Append-only history.** The model-visible history is append-only; only compaction and a
  route change may rewrite the prefix. `electron/services/ai/prefixCache.ts` owns the
  frame comparison and the DSH ratios (`0.8` trigger / `0.16` retain).
- **Compaction has a manual entry point.** `weportAiService.compactChat()` is the single
  implementation, surfaced as the panel's 压缩上下文 button, IPC `ai:compactChat`, and CLI
  `ai.compact`. It reports `changed: false` when below threshold — never claim a compaction
  that did not happen. Archived turns go to `sessions/<id>.archive.jsonl` and are never lost.
- **TPS is measured DSH-style**: `outputTokens / (decodeMs / 1000)`, where `decodeMs`
  starts at the **first token**, not at request start. Folding TTFT into the rate makes a
  long-prefix call look slow when it is only waiting. `AiStepTiming` carries this per step;
  `formatTokensPerSecond` (≥10 → integer, <10 → one decimal) mirrors DSH.
- **Model pricing is live, not hard-coded.** Prices come from `https://models.dev/api.json`
  (USD per 1M tokens, 24 h TTL, ETag, bundled snapshot as offline fallback) via
  `modelRegistry.ts`. `getSetup()` resolves them into `modelCosts` for the renderer, which
  prices the model dropdown and the topbar. Missing price renders as 未定价 — never `$0.00`,
  because unpriced and free are different things.
- **Chat titles are generated, then validated.** `electron/services/ai/chatTitle.ts` holds
  the pure rules: 2–4 words, strip `标题：`/quotes/trailing punctuation, and **reject a title
  that is just the user's own message truncated** (`titleEchoesSource`) — that is the bug
  where the list showed the first few characters of the message.
- Deletion of a `memory/` or `notes/` file always goes through a confirmation dialog
  (`noteDeleteTarget`); those files are the only copy.

## Glass Surfaces — v1.0

Two separate "the background is white" bugs, both from getting the *layer* wrong:

- **`背景遮罩` must never be tinted with `var(--bg)`.** It was, and in light mode
  `--bg` is `#f4f5f9` — so the "dim" layer painted a **white film** over the wallpaper,
  and turning it up made the picture greyer rather than darker. The colour now comes from
  `--app-bg-scrim`, which flips with `data-mode` (see "Background Mask — v1.0.1" below): a
  scrim is a *contrast* layer, so it must move away from the theme, not use a theme colour.
- **`data-has-bg` shell.** `.shell` carries two blue radial glows which used to stay on
  top of the wallpaper in image mode (the old override only handled `data-bg-kind`), so
  `遮罩 0%` was never actually clear. They are dropped whenever a background exists.
  Panel translucency lives in **theme.scss** (`data-has-bg`, plus a `data-mode='light'`
  variant) as literal `rgba()` — **not** `color-mix(… calc(…))`, whose percentage slot
  resolves inconsistently across Chromium versions and silently invalidates the whole
  declaration, leaving every panel fully transparent.

Popup glass (`NotificationToast.scss` + `useNotificationAdaptiveTheme.ts`):

- **The card veil is thin on purpose** (`[0.06, 0.24]` white / `[0.1, 0.3]` dark) and is
  solved against `VEIL_CONTRAST_BUDGET` (2.0), not 4.5. Letting the veil solve for 4.5
  drives it to its cap and the card becomes frosted plastic — that was the `0.42–0.58`
  era. The 4.5 budget lives on the **text colour + solved text scrim**
  (`--noti-text-scrim` / `--noti-text-scrim-strong`).
- Both scrim gradient stops are emitted by the engine. Do not derive one from the other
  with `color-mix(in srgb, var(--x) 118%, transparent)` — that nests `color-mix` inside
  `color-mix`, which Chromium rejects, and the declaration dies.
- Each sample is a `getImageData()` — a **synchronous GPU→CPU readback**. It only
  decides text colour, so `MIN_SAMPLE_GAP_MS` is 100 ms (was 33 ms / ~30 Hz).
- `BACKDROP_CAPTURE_SCALE` is 0.25 (was 0.5). Capture cost is dominated by output pixels
  and the frame gets blurred to nothing anyway; this is what lets the backdrop loop run
  fast enough for the glass to track the desktop (measured frame delta 1.64 → 3.60).
- **Measuring the glass needs the main window moved away.** `capturePage` on a transparent
  popup only returns the popup's own composite — it cannot see what is *behind* it, so a
  transmission measurement through it is meaningless. And a GDI desktop grab reads whatever
  window is under the popup: with the main window parked there, the "card" pixels are the
  main window's, and swapping the wallpaper changes nothing because the wallpaper is not
  exposed. Move the main window out of the popup's rect first (`.ui-probe/capture-glass-over-desktop.mjs`),
  then the card reads the desktop (measured 36.6 over a 30.1 desktop).
- **Measured cost, live glass on a 1280×720 desktop:** avg **2.2%** total CPU, peak 5.3%
  (`.ui-probe/measure-glass-cost.mjs`). Anything that pushes this past ~12% breaks the
  "lightweight + adapts in real time" requirement — re-measure before adding per-frame work.
- The GL stream path needs a `MediaStream`; when `srcObject` fails (software rendering,
  no GPU) the pipeline reports `frames` but the canvas is **absent** and the static
  snapshot `<img>` is what you see. `data-glass` alone does not prove the WebGL path is live.

## Progress & Status Surfaces — v1.0

Two failure modes, both seen in the export page:

- **High-frequency progress must never land in `App` state.** The main process emits
  `export:progress` every ~400 ms; `App` is 4,000+ lines and renders every page, so each
  event re-rendered the whole tree. That is the "everything gets pushed and pulled while
  exporting" glitch — it is a **re-render** problem, not a CSS one, and no amount of
  `position: sticky` fixes it. `src/components/export/ExportProgressBar.tsx` owns the
  subscription (including the `taskId` it needs for cancel); `App` touches progress only
  through a ref, to freeze the bar at the end.
- **The progress row's geometry must be constant.** `flex: 0 1 auto` on the session name
  makes its width follow the text, so the track and the cancel button jump on every event.
  Fixed `flex-basis` + ellipsis, a fixed-width tabular-nums counter, and a fixed
  `min-height` are what keep the sticky block from resizing the page underneath it.
- **A terminal state must be written explicitly.** Reporting completion by setting only a
  phase leaves stale content on screen: the final `export:progress` payload carries
  `currentSession: ''`, so the bar read `准备中…  189 / 189`. Recognise completion from
  *either* `phase === 'complete'` *or* `current >= total`, and replace the session label.
  Same class of bug in WeClone: a failed generation used to leave the panel spinning on
  the last mid-flight step (now `failed` / `aborted` terminal stages).
- **Never put `aria-live` on a container whose text changes every frame.** Screen readers
  announce each update. Put a `.sr-only` `role="status"` node next to it and write to that
  only on phase changes.

## Performance — v1.0 (measured, do not "optimise" by intuition)

Numbers below are from `.ui-probe/measure-app-perf.mjs` and
`.ui-probe/measure-cv-ab.mjs`. Two of them cost a wasted round trip each, so they are
written down rather than rediscovered.

- **The entry bundle was 1751 KB; page-level `React.lazy` took it to 181 KB.** ECharts
  (only 分析), html2canvas (only 年度报告), react-markdown (only AI panel + changelog) and
  every non-core page were in the startup graph. Measured effect: FCP 2312 → 712 ms,
  DCL 1196 → 242 ms. `src/main.tsx` also imported `pages/NotificationWindow` statically for
  a dead `#/notification-window` branch — that pulled the whole popup bundle (glass
  pipeline, 230 KB) into the main window's startup graph; it is a dynamic import now.
- **`content-visibility: auto` made scrolling 3× worse — do not put it back on these
  lists.** Controlled A/B in one process, 192-row 防撤回 list, alternating the property at
  runtime: `auto` p95 **107.8 ms** / 28 of 41 frames dropped / 106 ms long task; `visible`
  p95 **34.8 ms** / 5 of 57 dropped / 0 ms long task; mount cost identical (16.7 vs 16.6 ms
  median). The trade is "skip layout at mount" for "lay out on demand while scrolling", and
  a 192-row list mounts once while scrolling happens every day. Long lists want **virtual
  scrolling** (react-virtuoso, already used by the SNS feed), not this property.
- **Never guess which page is costly — profile it.** `.ui-probe/profile-page-switch.mjs`
  uses the CDP `Profiler` domain and aggregates **self time** per function. Note CDP
  timestamps are **microseconds** (an early version reported 3.6 million "ms").
  Measured 朋友圈: `(program)` (browser internals) dominates, JS ~420 ms in the App chunk,
  229 author rows + 164 avatar images; the virtualized feed holds only 2 posts — the cost is
  the **author sidebar**, not the feed.
- `transition-property` defaults to `all`. `transition-duration: 0.15s` alone therefore
  transitions every animatable property — name the properties explicitly.
- Images: `loading="lazy"` does not move decode off the critical path; `decoding="async"`
  does. Applied to avatars, SNS media thumbnails, link-card thumbnails and the lightbox.
- Splitting the bundle is only safe because dynamic `import()` works under `file://` in
  packaged Electron. It does — `.ui-probe/check-dynamic-import.mjs` asserts it against the
  installed `app.asar` (13 exports resolved). A blocked dynamic import shows up as a
  permanent Suspense fallback, not as a build error.

## WeClone Provider — v1.0.1 (local-only, no forced service)

- **WeClone has no service of its own.** It resolves through
  `ProviderProfileService.getForConsumer('weclone')`, which falls back to the default, so it
  uses whatever the user configured (DeepSeek on this machine). The old
  `ensureForcedProvider()` locked it to `opencode-go / muse-spark-1.2-contributor` and created
  a profile the user never asked for; that gateway is geo-blocked here, so WeClone could only
  ever answer "Internal server error" while a working service sat configured next to it.
  Removed end to end: IPC channels, `src/components/weclone/WeCloneForcedKey.tsx`, the
  `WECLONE_FORCED_*` constants in `config.ts`. `LEGACY_FORCED_PROVIDER_ID` /
  `LEGACY_FORCED_MODEL` still exist in `weCloneService.ts` **for the one-time cleanup only**
  (`purgeLegacyForcedProfile()` deletes that profile and the consumer assignment on startup).
  `muse-spark` still appears in `electron/assets/models/models-dev-snapshot.json` — that is
  the models.dev catalog (the provider really serves it), not a forced choice.
- **A profile can exist with no API key, forever.** `migrateLegacyProfile()` writes a profile
  even when `weportAiApiKey` is empty at that moment, and once a valid store exists `read()`
  never migrates again — so a key added later never reached the profile. On this machine that
  produced a keyless DeepSeek profile and "未配置 AI API Key" with a perfectly decryptable
  35-character key sitting in the legacy field. `healKeylessProfile()` repairs exactly that
  state (only when exactly one profile lacks a key, and provider/baseUrl agree).
- A request sent without a key comes back as `Authentication Fails`, which reads like "your key
  is wrong". Filter candidates by `apiKey` (or `apiKeyOptional`) **before** calling, and say
  "this service has no API key" instead.
- `chatWithClone` returns the answering `model` / `providerId` in `meta`; the drawer prints it.
  Verification: `.ui-probe/verify-weclone-e2e.mjs` drives the real UI against a local
  OpenAI-compatible mock (SSE), so the chain is proven independently of the user's key.

## Background Mask — v1.0.1 (polarity)

- **The scrim must follow the theme's polarity**, not a fixed dark colour. Its job is to push
  the backdrop away from the body text: light theme → white scrim, dark theme → near-black.
  A fixed dark scrim at 100 % in light mode is dark text on black — nothing readable. This is
  the opposite complaint from the v1.0 note above (that one was `var(--bg)` making a light
  theme *grey*); both were "the scrim is the wrong colour", and the fix now names the
  mechanism: `--app-bg-scrim` flips with `data-mode`.
- Image and video share one composited layer (`.app-bg`, `contain: strict`, `z-index: -1`)
  with the scrim inside it. Before, the image was `.shell`'s `background-image`, which meant
  `filter: blur()` never applied — the 背景模糊 slider did nothing in image mode while being
  shown for it.
- `:root[data-mode='light'] .shell { background: var(--bg) }` was a **shorthand**: it reset
  `background-image` to `none`. `theme.scss` loads after `v1.scss` and both selectors have the
  same specificity, so in light mode the wallpaper was erased entirely. One `.shell` rule now
  owns the background; the glow is a variable (`--app-glow`) that either mode can turn off.
- Verification: `.ui-probe/verify-bg-mask.mjs` captures the **main** window (not the popup —
  picking the first `window` webContents measures a 516×171 transparent toast and reports
  pure black) and asserts average luma moves the right way: dark 0.221 → 0.076, light
  0.460 → **0.944**. Both endpoints are asserted, not just the direction.

## Renderer Probes — Test Hygiene

- **Always pass a private `--user-data-dir`.** `app.requestSingleInstanceLock()` is keyed
  on it, so a probe that reuses the default collides with the Weport already running in the
  tray and exits immediately (`firstWindow` times out). `.ui-probe/userData` and
  `scripts/ui-probe.mjs` do this; the ad-hoc probes under `.ui-probe/` must too.
- **`app.evaluate` runs in the main process and receives Electron's modules as its
  argument** — `async ({ webContents }) => …`. `require('electron')` is undefined there and
  a dynamic `import()` throws "A dynamic import callback was not specified". Use it to push
  *real* IPC events (`webContents.send('export:progress', …)`); do not fake them in the page.
- **`contextBridge` objects are frozen.** Monkey-patching `window.electronAPI.…` in the page
  fails silently — that is how a probe ends up asserting on zero subscribers.
- CSS-nesting blocks (`:root[data-x] { :is(...) { … } }`) are dropped wholesale by the
  engine when malformed, and neither `tsc` nor `vite build` complains. Assert **computed
  styles** (`.ui-probe/verify-accent-strength.mjs`), not the presence of source lines.
- **`npx @electron/asar extract-file <asar> <path>` writes the extracted file into the
  current working directory.** Running it from the repo root to inspect the packaged
  `package.json` silently **overwrote the real one** with electron-builder's stripped stub
  (scripts, devDependencies and the whole `build` block gone). Extract into a temp directory,
  or just read the asar as bytes/strings.

## Notification Popup (Permanent — Do Not Change)

The popup is `electron/windows/notificationWindow.ts` (WeFlow port): a separate
frameless transparent `BrowserWindow` (344×114, top-right of work area,
`alwaysOnTop`, `focusable: false`, `skipTaskbar`, click-through
when hidden). Renderer: `src/pages/NotificationWindow.tsx` +
`src/components/NotificationToast.tsx` + `LiquidGlass` (native
`@hicccc77/electron-liquid-glass` panel with Chromium desktop-stream fallback;
the native glass panel is **Windows-only** — on macOS only the Chromium
fallback path runs).

**The card must be (almost) fully transparent.** The user's words were "ensure the
glass is fully (or almost) transparent", after reporting that the notification
background was "all black". Everything below follows from that one requirement.

- **The native D3D11 panel is opt-in: `WEPORT_NATIVE_GLASS=1`.** Default off. It is a
  separate native window *underneath* the popup, and on some GPU/driver combos it paints
  the refraction area as a **black block** (this file warned about exactly that before the
  default was briefly flipped to on — the flip shipped, and the user got a black
  notification background). `isSupported()` cannot tell "this combo works" from "the panel
  has a desktop texture right now", so the default must not bet on it. The Chromium path
  composites the desktop *inside* the card and degrades to "no snapshot at all", never to a
  black plate.
- **The card does not draw an opaque backdrop snapshot.** It used to pass the captured
  desktop image into `LiquidGlass`, which made the composite **76 % opaque** with an opaque
  card fill — over a dark app that is a dark rectangle. The window is `transparent: true`,
  so the real desktop already shows through; the fill stays at `--noti-tint` ≤ 0.05 and the
  boundary is a **1px inset ring** (`CARD_ON_DARK_BACKDROP` / `CARD_ON_LIGHT_BACKDROP`).
  Verified composite after the change: avgAlpha 199 → **49/255**, card centre alpha
  **15/255**, opaque-dark pixels **0 %** (`.ui-probe/verify-popup-transparency.mjs`).
- **Legibility is carried by the text itself**, since a transparent card has no fill to
  help: `--noti-halo-both` (light core + dark edge) is emitted unconditionally, with the
  solved polarity only deciding which layer is stronger. A *wrong or stale* polarity then
  costs a little polish, not readability.
- **Never sample the backdrop under the card.** The capture is the whole screen and the
  popup is on it, so sampling the card's own rect reads **the popup's own pixels** — a
  self-referential loop that locks the theme to whatever it saw first (measured: swapping the
  backdrop, even closing and re-showing the popup, never changed it). Samples are taken
  **outside the window rect** (`offsetSampleOutsideWindow`, needs `winW`/`winH` in the
  backdrop payload).

**Do not reintroduce:**

- Any GDI/native Win32 popup renderer (the v0.6.x `toast_win` failure mode).
- An opaque or near-opaque fill anywhere in the popup: `html`/`body` stay transparent
  (asserted), and no element may have `alpha ≥ 0.12` with `luma < 45` (asserted).
- `setContentProtection` removal — it exists to stop the glass filming itself.
  **QA harness note:** content protection blanks `webContents.capturePage` on
  Windows; `appMain.ts::runScreenshotMode` temporarily disables it before
  capturing (test-only path). Note it does **not** reliably exclude the popup from
  `desktopCapturer` here — that is why the sampler offsets outside the window instead of
  trusting protection.

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

**CRITICAL — never pass the full `RELEASE_NOTES.md` as a release body.**
`softprops/action-gh-release` `body_path` **overwrites an existing release's
body** (observed on v0.9.11: a pre-created, correct release was replaced with
the entire changelog). Therefore:

- `.github/workflows/release.yml` runs
  `node scripts/extract-release-notes.mjs "<package version>"` in **all three
  build jobs** (win/mac/linux) and publishes with
  `body_path: release-notes-current.md` — a per-version extraction that only
  contains this version's section. Do NOT change `body_path` back to
  `RELEASE_NOTES.md`.
- `release-notes-current.md` is gitignored (generated in CI and for local
  checks via the same script).
- Local sanity check before releasing:
  `node scripts/extract-release-notes.mjs <version>` then verify the file
  starts with `# Weport v<version>` and contains no older-version headings.

When releasing a new version on GitHub, write the release body as
**concise, natural Chinese bullet points** — short plain bullets, no English
fluff, no boilerplate. Create the release with `gh release create` BEFORE the
CI publish step finishes (pre-created release wins on assets timing; the
extraction step now also guards the body if CI creates it first). Tag name
must match `package.json` version (`v0.9.9` ↔ `0.9.9`) — the workflow fails
otherwise.

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
