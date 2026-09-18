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
  (explicitly gated on `process.platform === 'win32'`); macOS uses the Chromium
  desktop-stream fallback. Linux delivers through the desktop notification
  daemon (D-Bus via `electron/services/linuxNotify.ts`) and its popup fallback
  must never call `desktopCapturer` — on Wayland that raises the portal dialog
  for every message. Clicking a chat notification opens WeChat via
  `electron/services/wechatLinux.ts` (window matched by `app_id`, not pid).
  See [`docs/agents/platform.md`](docs/agents/platform.md).
- WeChat data dir: Linux 微信 4.x lives at `~/xwechat_files`
  (`dbPathService.autoDetect/getDefaultPath` linux branches).

## Linux Packaging (v0.9.10)

已移至 [`docs/agents/platform.md`](docs/agents/platform.md)。

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

已移至 [`docs/agents/platform.md`](docs/agents/platform.md)。

## Connectors (`electron/services/connectors/`) — v1.0

已移至 [`docs/agents/platform.md`](docs/agents/platform.md)。

## WeClone (`electron/services/weCloneService.ts`) — v1.0 (local-only)

已移至 [`docs/agents/weclone.md`](docs/agents/weclone.md)。

## Video Background (`electron/services/backgroundVideoService.ts`) — v1.0

A video wallpaper is decoded on every frame for as long as the window is visible. A 4K
source on a ~1280 px-wide layer decodes ~9× the pixels anything can show, which reads as
"laggy while a video background is selected".

- `config:get('appearanceBackgroundPath')` is intercepted in `appMain.ts` and routed through
  `backgroundVideoService.resolve()`. The renderer stays ignorant of this: it asks for a
  path and gets the path it should play.
- First call returns the **original** file and starts a background `ffmpeg` transcode to
  `{cache}/background-video/<sha1>.mp4`. Later calls return the cache. Startup must never
  wait for ffmpeg.
- **Quality tiers (v1.0.4).** `resolve(source, { quality, blurPx })` takes the user's tier
  (`native` | `balanced` | `compact`, default `balanced`) and the background blur radius.
  Each tier carries **both** a long-edge target and encoder settings — resolution alone was
  never the whole story:
  `native` 3840 cap / crf 18 / medium · `balanced` 1920 cap / crf 26 / veryfast (the old
  behaviour) · `compact` ≈⅔ of the display width, ≤1280 / crf 30. Measured on the author's
  3840×2160 / 17.7 s source (1920×1080 display at 150 %): native 28.8 MB in 41 s,
  balanced 3.4 MB in 7.1 s, compact 1.1 MB in 5.4 s.
- **Blur ≥ 4 px forces at most `balanced`** (`BLUR_FORCES_BALANCED_PX`,
  `resolveEffectiveQuality()`). Blur destroys the detail that the extra pixels carry, so a
  higher tier is pure waste — the user asked for exactly this rule. Only *higher* tiers are
  demoted: an explicit `compact` stays `compact`. `resolve()` returns
  `{ selectedQuality, quality, demoted, longEdge }` and the settings page **must** state the
  demotion, or the user just sees "I picked 原生 and nothing happened".
  The renderer mirrors the threshold in `src/utils/appearance.ts` — the two constants must
  stay in step, and the *effective* tier is always read back from the main process
  (`appearanceBackgroundVideoInfo`, a synthetic read-only config key, deliberately not
  persisted) because only the main process knows the display's device width.
- **The cache key must cover the whole encode signature, not just the resolution.**
  It hashes `size|mtime|quality|edge|crf|preset`. This is not defensive: `native` and
  `balanced` compute the **same** edge on a 1080p display (1920), so an edge-only key makes
  the two tiers collide and the first one transcoded silently wins. The old edge-only key
  also meant a settings change never invalidated existing caches — the author's machine was
  still playing a ~1.0 Mbps transcode (≈crf 29) long after the code said crf 26, which is
  what "you reduced the quality of the background video" actually was. Changing the key
  format fixes that class of bug for good.
- **Never upscale.** The scale filter is
  `scale='if(gt(iw,ih),trunc(min(iw,EDGE)/2)*2,-2)':'if(gt(iw,ih),-2,trunc(min(ih,EDGE)/2)*2)'`.
  The previous `if(gt(iw,ih),EDGE,-2)` **upscaled** a source narrower than the target
  (1280 → 1920): 1.25× the decode for pixels that are pure interpolation.
  `trunc(x/2)*2` keeps the width even when the source is used as-is (odd width makes x264
  fail outright). Verified by running all three tiers against the real 4K source.
- **ffmpeg is not bundled** (40–100 MB for an optional nicety). It is looked up on `PATH`,
  then common install dirs, then `WEPORT_FFMPEG`. Missing ffmpeg is not an error: the
  original file is used unchanged.
- A source above `MAX_SOURCE_BYTES` (50 MB) is neither transcoded nor played; the settings
  page says why. Non-video files bypass the transcoder entirely (transcoding a PNG produced
  a 17 KB single-frame mp4).
- **The GPU pool is released when the window is destroyed, not when it is hidden.** Measured
  over 2 minutes on the author's machine (`.ui-probe/measure-idle-states.mjs`): with the
  window showing a video wallpaper the GPU process sat at **170 MB** and the app total at
  **582 MB (3.61 %)**; after the tray reclaim destroyed the window the GPU process fell to
  **165 MB** and the total to **462 MB (2.87 %)**. The earlier note that "having ever decoded
  a video permanently enlarges the GPU process" overstates it: the pool survives *hiding*,
  but window destruction does hand it back. Releasing the decoder without destroying the
  window (`removeAttribute('src')` + `load()` on `visibilitychange`) still does nothing.
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
- **Check the page shell, not just the panels.** WeportAI had *three* stacked opaque plates
  (`.ai-shell` and `.ai-main` / `.ai-topbar` all `var(--bg)`); the left/right panes were
  translucent glass, so the wallpaper only showed in two narrow gaps and the page read as
  "no glass at all". `:root[data-has-bg='true']` now clears all three. Verify by walking the
  ancestor chain of the page container and printing `backgroundColor` for each level —
  computed style, not source lines.
- Transparent does not mean unreadable: with the middle column transparent, the WeportAI
  hero and the assistant bubbles sit directly on the wallpaper, and white text on a bright
  photo disappears. Those two carry a **local** scrim (`color-mix(in srgb, var(--bg) 62%,
  transparent)`), which keeps the page glass while giving the text something to stand on.
  Same rule as the settings panel: glass for the surface, a plate for the content.

Popup glass (`NotificationToast.scss` + `useNotificationAdaptiveTheme.ts`):

- **v1.0.3 — the "almost fully transparent" rule is SUPERSEDED, and the
  text-only scrim is gone for good.** The earlier requirement (v1.0.1) was
  "the card must be (almost) fully transparent" because a previous build showed
  a black plate. The user's v1.0.3 instruction replaces it with three rules:
  1. **There must never be a background behind the text only.** If a fill is
     applied it covers the **whole card**, or there is no fill at all. The old
     `.notification-text::before` (`--noti-text-scrim`) was exactly such a
     layer — a solid rounded block visible as a pale square on a dark desktop.
     It and its engine variable (`--noti-text-scrim`, `--noti-text-scrim-strong`)
     were deleted. Do not reintroduce a per-band scrim; readability comes from
     the whole-card fill plus the text's own dual-polarity halo.
  2. **The default is NOT fully transparent** — a light fill (16 % white) so
     dark text has something to sit on.
  3. **The default border is a hairline** (0.5 px at 22 %), not the old 1.5 px
     white ring + 0.5 px white inset shadow, which read as "a white outline, so
     it does not look like glass".
- **Glass appearance is user-configurable** via `src/utils/notificationGlass.ts`
  (fill on/off + colour + opacity, text colour, border width/colour/opacity,
  radius, refraction strength, shadow), surfaced as 设置 → 消息通知 → 通知玻璃
  (`NotificationGlassPanel.tsx`, which previews with the **real** toast
  component so preview and popup cannot drift). Everything is CSS-variable
  driven (`--glass-fill`, `--glass-text-color`, `--glass-border-rgb`,
  `--glass-border-alpha`, `--glass-border-width`, `--glass-ring`,
  `--glass-shadow`), applied on the **card container** — never on
  `document.documentElement` — so the same variables serve the popup and the
  settings preview. User values take precedence over the adaptive engine via
  `var(--glass-x, var(--noti-x, fallback))`; `--glass-text-color` is *removed*
  when the user wants automatic text colour. Both the Chromium path and the
  native D3D11 panel derive their parameters from the same
  `notificationGlassRenderParams()`.
- **The adaptive engine still owns the halo, not the fill.** `--noti-*` continue
  to carry the halo/tertiary and the veil; the fill is now overridable.
- **The text colour is NOT adaptive any more (v1.0.4).** `--noti-title-color` /
  `--noti-body-color` used to be solved per backdrop sample, which produced the user's
  "sometimes the popup text is white, make sure it doesn't auto-adjust". The judgement was
  wrong in kind, not in threshold: the text polarity was decided against `glassBg`
  (the sample composited with the engine veil), but the card on screen also carries the
  user's fill, the desktop capture and the blur — so the common outcome was a *light* card
  with *white* text, and the colour changed from wallpaper to wallpaper.
  Polarity now comes from `glassTextPolarity(glass)` — a pure function of the user's fill
  colour (white glass → dark text, dark glass → light text, no fill → dark text) —
  passed into `resolveNotificationTheme(raw, { textPolarity })` and threaded through both
  hooks. Use **contrast**, not a 0.5 luma threshold, to decide it: `#80c0ff` is a light
  blue with relative luma 0.495 and a threshold rule gets it wrong (found by the test).
  Within a fixed polarity the tone still moves slightly with contrast (dark greys 44→10),
  which is what keeps it readable; the *polarity* must never flip. Gradients use the
  midpoint of the two stops as the representative colour.
  Pinned by `src/pages/notificationFixedText.test.ts` (16 assertions, pure functions,
  no screen capture): with a fixed polarity the text must stay on one side across the whole
  backdrop range from `#000000` to `#ffffff`. The empty-state string in the WeClone chat
  drawer deliberately does **not** mention language switching any more.
- **Gradient fill (v1.0.4).** `fillMode: 'solid' | 'gradient'` plus `fillGradientFrom/To`,
  with 8 presets in `GRADIENT_PRESETS`. **Left-to-right only** (`90deg`) — the user asked for
  that explicitly, and a card 344×114 px has no room for an angled gradient that does not
  read as a rendering fault. `notificationGlassFillValue()` returns either
  `rgba(...)` or `linear-gradient(90deg, rgba(a,α), rgba(b,α))` and it is safe because
  LiquidGlass paints the tint layer with the `background` **shorthand**
  (`index.tsx`, `background: 'var(--liquid-glass-tint)'`), so no new variable and no second
  element is needed — which also keeps the "the fill covers the whole card or does not
  exist" rule intact. An `alpha: 0` gradient deliberately collapses to a transparent solid.
- `MIN_SAMPLE_GAP_MS` is 100 ms and each sample is a `getImageData()` — a
  **synchronous GPU→CPU readback**; it only decides text colour.
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
- **Measured cost, live glass:** avg **1.7 %** total CPU, peak **4.3 %**, 767 MB RSS
  on the installed build (v1.0.3; was 2.2 % / 5.3 % before the text-scrim removal —
  the scrim was the most expensive property in the adaptive set because both of its
  gradient stops were rewritten per sample). Anything that pushes this past ~12 %
  breaks the "lightweight + adapts in real time" requirement — re-measure before
  adding per-frame work. `.ui-probe/measure-glass-cost.mjs`.
- **Verified appearance, both polarities** (v1.0.3, installed build): over a dark
  desktop the card is a light frosted plate with white text; over a bright desktop it
  is a *darker* frosted plate with dark text (card centre composited `189,187,185`,
  Δluma 28 — up from 15.1 before, so the new fill made the bright case *more*
  visible, not less). `verify-popup-transparency.mjs` now asserts the **effective**
  fill (`--glass-fill` on the card container) rather than `--noti-tint`: the engine's
  veil is subordinate to the user's fill, so reading the veil alone would let "the card
  became a solid plate" pass. It also asserts the text-only `::before` layer is gone
  and the border stays a hairline.
- **The default fill is white (16 %) on both polarities** — a deliberate
  simplification. It reads correctly on a bright desktop because the desktop capture
  composited *inside* the card and the engine's dark scrim dominate the result; the
  measurement above is the evidence. If a future change makes the bright case wash
  out, make the fill colour polarity-aware (compose it from the engine's veil colour
  in `resolveNotificationTheme`, where both the polarity and the user's opacity are
  known) rather than lowering the default.
- Settings/probe for the panel: `.ui-probe/verify-glass-settings.mjs` (10 assertions
  incl. computed `--glass-fill` = `rgba(255,255,255,0.16)`, border 0.5px @ 0.22, no
  text scrim, and a **live** check that dragging fill opacity changes the card).
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

**Memory: always quote the state, never a single number (v1.0.4).** The user reported
"5.5–5.7 % idle" against an earlier "2.35 %" claim and asked what the difference was. Neither
number was wrong, and that was exactly the problem: both were true of *different states*.
Measured on the author's machine, 16 108 MB total RAM, Intel Iris Xe (**integrated** — the
GPU process's memory is system RAM, not VRAM), 1920×1080 at 150 %, 4K-source video wallpaper
(sampled over 2 minutes):

| state | main | GPU | renderer(s) | utility | WCDB host | total | % |
|---|---|---|---|---|---|---|---|
| tray idle (window destroyed) | 161 | 165 | 0 | 44 | 92 | **462 MB** | **2.87 %** |
| window shown + video wallpaper | 161 | 170 | 111 | 45 | 95 | **582 MB** | **3.61 %** |
| + a notification popup alive | 161 | 258 | 111 + 131 | 45 | 95 | **~911 MB** | **5.66 %** |

The third row is the reported 5.7 %, and it is the honest peak: the popup renderer is a whole
separate Chromium renderer (~130 MB) and the GPU process grows by ~90 MB while a video is
decoding and the popup's glass pipeline is up. "Idle" for the user meant "the app is open and
I am looking at Task Manager", not "tray, window destroyed".
**Rules this produced:** (1) when measuring memory, always name the state and say whether the
window exists; (2) the four `Weport.exe` processes in Task Manager are main + GPU + renderer
+ network utility — plus a fifth `WeFlow.exe` (the WCDB host) and a sixth popup renderer when
a notification is on screen; that is the architecture, not four copies of the app;
(3) reductions must be aimed at a state the user actually sees.
Reductions made in v1.0.4: the popup renderer's idle-destroy went 3 min → 45 s
(`notificationWindow.ts`, the popup being the single largest avoidable block), and the MCP
service became lazily imported (`mcpServiceRef` + `getMcpService()`) so
`@modelcontextprotocol/sdk` + zod is not loaded unless MCP is actually used — note this only
helps installs that **disable** MCP, because `mcpEnabled` defaults to `true` and a running
service needs its SDK. Teardown paths read `mcpServiceRef` directly on purpose — calling the
getter to stop a service that never started would load the SDK just to shut it down.

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
  the **author sidebar**, not the feed. It is now virtualized too (229 rows → 18 rendered,
  `.ui-probe/diagnose-sns-sidebar.mjs`).
- **A virtualized list needs a definite height — and this sidebar is content-hugging.**
  `.sns-sidebar { align-self: start; max-height: 100% }` is deliberate (v09.scss: with five
  authors a full-height card looks like it is still loading), but Virtuoso collapsed to
  **4 px** inside it: absolutely-positioned items give the scroller no intrinsic content
  height, so the grow block fell from 292 px to 83 px and the list was invisible. The fix is
  to compute the height from the data (`rows × 38 px + 4`) and cap it with the space actually
  available (measured against `.sns-main`'s row height minus the other blocks): short lists
  still hug, long ones cap and scroll. `smoke-installed.mjs` now asserts the list height is
  > 120 px and that scrolling changes the first rendered row — the old build fails both.
- **Frame numbers from this machine are not A/B evidence.** Three sessions share the CPU;
  the same build measured 朋友圈 long tasks of 217 ms and 303 ms on consecutive runs, which
  is larger than the effect being measured. Claim DOM/geometry facts (row counts, element
  positions, CLS) or nothing.
- `transition-property` defaults to `all`. `transition-duration: 0.15s` alone therefore
  transitions every animatable property — name the properties explicitly.
- Images: `loading="lazy"` does not move decode off the critical path; `decoding="async"`
  does. Applied to avatars, SNS media thumbnails, link-card thumbnails and the lightbox.
- Splitting the bundle is only safe because dynamic `import()` works under `file://` in
  packaged Electron. It does — `.ui-probe/check-dynamic-import.mjs` asserts it against the
  installed `app.asar` (13 exports resolved). A blocked dynamic import shows up as a
  permanent Suspense fallback, not as a build error.

## WeClone Provider — v1.0.1 (local-only, no forced service)

已移至 [`docs/agents/weclone.md`](docs/agents/weclone.md)。

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

- **NEVER put a window on the user's screen. This is the first rule of every probe.**
  The agent runs on the same machine the human is working on. Probes that call
  `win.show()` / `focus()` / `setSize(1280, 800)` (and `verify-popup-transparency.mjs`,
  which additionally creates a **synthetic full-screen backdrop window**) throw a big
  black/maximized rectangle over whatever the user was doing. The user has asked for
  this to stop, explicitly and angrily. Do not do it again.
  - **Default: run hidden.** Launch with a private `--user-data-dir` and **do not**
    call `show()`/`focus()`. Most assertions (DOM, computed style, IPC, process
    metrics) work fine without it.
  - If an assertion genuinely needs layout, **move the window off-screen** rather
    than showing it (e.g. `win.setPosition(-4000, 0)`), or `showInactive()` at a small
    size — do not let it cover the work area and do not focus it.
  - Never create a simulated full-desktop backdrop window for a probe.
  - **Ask the user before any run that must be visible.** If you cannot verify
    something invisibly, say so and ask; do not "just quickly" cover their screen.
  - Prefer the self-capturing modes that already exist (`WEPORT_SCREENSHOT_*`,
    `capture-ui.ps1`) over driving a real visible window.
- **A visible/backdrop-window probe is also bad evidence** — that is not only a
  manners problem. The synthetic desktop window changes what is on screen, so the
  capture it measures is not the real desktop: `verify-popup-transparency.mjs`
  measured `avgAlpha` of **2.2 / 22.8 / 1.2 / 57 / 66 / 77 / 102** across consecutive
  runs of **identical code**, entirely depending on whether the desktop grab returned
  anything. The probe now prints `SKIP` when the composite is degenerate
  (`avgAlpha < 5`) instead of reporting a false FAIL — a false FAIL from that noise is
  exactly what produced the bogus "the specular highlight raised CPU to 3.0 %"
  conclusion in this session (same code re-measured 1.7–1.8 %).
  **Only the invariants that reproduce every run are gates**: `html`/`body`
  transparent, hairline border, no text-only scrim, zero opaque dark fills.
  Anything derived from a screen capture needs repeated samples before it is a claim.
- **A CSS file imported by only one of two lazy chunks is missing for the other.** `react`
  `lazy()` splits CSS per chunk: `providerProfiles.css` was imported **only** by
  `WeportAiPanel.tsx`, so opening 设置 → AI 服务 without ever visiting the WeportAI page
  rendered the provider panel with **no styles at all** (the user's "AI 提供商 UI 是坏的").
  A grid layout with no grid, and — the giveaway — a `position: fixed` dialog that ends up
  laid out in normal flow *below the viewport* (measured: a 780×906 dialog at `y=650` in a
  650 px-tall viewport). Each component that uses those class names imports the file itself;
  the bundler dedupes.
- **A probe that verifies the *shipped product* takes `--installed`** and resolves
  `%LOCALAPPDATA%\Programs\Weport\Weport.exe`; the default target is
  `release/win-unpacked/Weport.exe`. Passing the flag from PowerShell needs an explicit
  array — `function Run($name, $args)` **swallows the flag** (`$args` is an automatic
  variable), so a run that "included `--installed`" silently measured the dev build. Check
  the probe's own `target:` line before believing the result.
- **Copy `Local State` when you copy a config into a probe `--user-data-dir`.** On Windows
  Chromium keeps its Safe Storage AES key (DPAPI-wrapped) in `Local State`; without it
  Electron generates a **new** key, the copied `safe:` values cannot be decrypted, and the
  provider list renders empty ("还没有配置任何 AI 提供商") even though the blob is right
  there.
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
- **`capture-ui.ps1` has one known, pre-existing gap: `settings-ai`.** The sweep drives
  10 pages + 8 settings sections and asserts all captures non-blank (plus placeholder
  scan, contrast audit and a narrow/wide viewport matrix), but the `settings-ai` step
  asserts `.ai-profile-list`, which renders only when `ai:getAssignments` returns at
  least one profile — and **the demo handlers never fake that channel**
  (`installScreenshotDemoHandlers` overrides `ai:getSetup` / `ai:listProviders` /
  `ai:saveProfile` …, but not `ai:getAssignments`), so in a fresh demo userData the
  服务分配 block has nothing to list and the capture fails. Verified not a product bug:
  `.ui-probe/shot-ai-settings.mjs --installed` renders the real panel with the real
  profile. Fix by faking `ai:getAssignments` with `demoAiSetup().profiles`
  (`{ success, consumers, profiles, activeProfileId }` — the shape `setAiAssignments`
  expects).
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

**The card's default look is a light glass fill, not a fully transparent card
(revised in v1.0.3 — see "Glass Surfaces → Popup glass" for the current rules and
the configurable `--glass-*` variables).** The "almost fully transparent"
requirement below is the v1.0.1 state that fixed an all-black card; it was
superseded because a fully transparent card leaves dark text with nothing to sit
on, and because the 1.5px white ring that came with it read as "a white outline,
so it does not look like glass". What still holds from that work is everything
about *not painting an opaque plate*: no opaque backdrop snapshot, no GDI
renderer, no near-opaque fill, `html`/`body` transparent.

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
- **A bright backdrop is the mirror case, and it is *not* a white veil.** The engine starts
  from a white veil on `luma >= 110`, then the `MIN_CARD_DELTA_LUMA` rule flips it: white on a
  bright desktop cannot make the card visible, so you get **dark text + a very thin dark
  scrim**. Measured on the installed build (`WEPORT_PROBE_BACKDROP=bright`, backdrop
  `#d9d7d5`): `--noti-tint: rgba(22, 20, 18, 0.07)`, `--noti-title-color: rgb(10, 10, 10)`,
  card centre composited `202,200,198` → **Δluma 15.1** (visible, still nearly transparent).
  Assert the *result* (dark text, veil ≤ 0.25, `4 ≤ Δluma ≤ 45`), not the direction you
  assumed — the first version of this probe asserted "white veil on a bright backdrop" and
  failed against a correct implementation.

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
- **v1.0.3: hidden-window reclamation destroys the window (tray) or unloads the
  page (minimized).** The v0.9.3 design unloaded the renderer with
  `loadURL('about:blank')` after `WEPORT_DISCARD_DELAY_MS` (default 5 min) — but
  measured, that returned only ~29 MB (738 → 738 MB total; the renderer process
  itself did not shrink), because Chromium does not hand a renderer's
  infrastructure back. Tray-hide now **destroys** the `BrowserWindow` (freeing
  the whole renderer + its GPU resources: measured 767 → 456 MB, i.e. 4.8 % → 2.8 %
  of a 16 GB machine, `.ui-probe/measure-idle-states.mjs`). Two traps this must
  keep honouring:
  - `mainWindowReclaimInProgress` **must** guard the `win.on('closed')` handler.
    Without it the reclaim trips the "zero windows → `app.quit()`" fallback and
    silently kills the app. (`window-all-closed` is already safe: it returns
    early while a tray exists.)
  - **Minimize must not destroy the window** — that removes the taskbar button
    and the user can no longer restore. Minimize keeps the `about:blank` unload
    path; tray-hide destroys. Restore is `showMainWindow()`'s existing
    `!mainWindow` branch (rebuild the window), which is also the `--background`
    startup path, plus `restoreDiscardedMainWindow()` for the minimize case —
    the `restore`/`show` handlers call it, otherwise restoring from the taskbar
    shows a blank `about:blank` window.
  - Scheduling is wired to `hide`, `minimize`, `close→tray` **and** after the
    window is (re)created. Only `close→tray` used to schedule, so a merely
    **minimized** window kept its full renderer forever.
- **v0.9.3+: Chromium memory tuning (appMain.ts `startApp`, before ready):**
  `js-flags --max-old-space-size=384 --max-semi-space-size=4`, `disk-cache-size
  16MB`, `spellcheck: false` on both windows. Do NOT use
  `appendSwitch('disable-features', …)` — it *replaces* Electron's default
  disable-features list (incl. `SpareRendererForSitePerProcess`) and can spawn
  an extra spare renderer.
- **Hardware acceleration is NOT disabled for `--background` (reversed in v1.0.3).**
  The old rule ("silent start needs no rendering → drop the GPU process, ~130 MB")
  is wrong, because `disableHardwareAcceleration()` applies to the **whole process
  lifetime** while the user does open the window. Measured on a 16-core machine
  with a 1080p video background (`.ui-probe/measure-video-cpu.mjs`):

  | configuration | CPU (of machine) | working set | main renderer |
  |---|---|---|---|
  | software + original 4K | **1.16 %** | **1232 MB** | 684 MB |
  | hardware + original 4K | 0.24 % | 870 MB | 146 MB |
  | software + 1080p cache | 0.41 % | 720 MB | 218 MB |
  | hardware + 1080p cache | 0.31 % | 866 MB | 124 MB |

  Software rasterisation costs ~+560 MB in the renderer to save ~200 MB of GPU
  process — a net loss in every state, including purely hidden (801 MB hardware
  vs 941 MB software). Keep the explicit escape hatch instead:
  `WEPORT_FORCE_SOFTWARE_RENDER=1`.

## Self-sent Message Filtering

`messagePushService.ts` (WeFlow logic) filters on `message.isSend === 1`
in `pushSessionMessages`/`buildPayload`. Keep that intact.

## v0.9 Modules — 朋友圈 (SNS) / 分析 (Analytics)

已移至 [`docs/agents/modules.md`](docs/agents/modules.md)。

## v0.9.5 Modules — MCP 服务 / 分析新图表

已移至 [`docs/agents/modules.md`](docs/agents/modules.md)。

## Export Layout

已移至 [`docs/agents/modules.md`](docs/agents/modules.md)。

## Contact Name Warmup

已移至 [`docs/agents/modules.md`](docs/agents/modules.md)。

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

**When GitHub is unreachable, electron-builder still fails with a warm cache.** It
verifies the cached Electron zip against `SHASUMS256.txt` on github.com, so a blocked
network kills `npm run build` (`⨯ connect ETIMEDOUT 20.205.243.166:443`) *after* vite
has already written `dist/`. Point it at the locally installed Electron instead:

```sh
npx electron-builder --publish never "--config.electronDist=node_modules/electron/dist"
```

Use the long `--config.electronDist=…` form: `-c.electronDist=…` is parsed as the
config-file short flag and dies with `ENOENT …/.electronDist=…`. This is a CLI
workaround, not a `package.json` change — CI has network and must keep the default.

**`electron-builder --dir` does not run vite.** Repackaging after a source edit without
`vite build` first silently ships the previous bundle (this cost a round trip: the
`.ai-shell` transparency rule was "verified" against a stale `dist/`).

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
- **The release MUST be published as the latest NON-draft, NON-prerelease
  release with `latest.yml` attached.** The updater's feed is
  `https://github.com/Panther114/Weport/releases/latest/download`
  (`appMain.ts` `getUpdaterFeedUrl`), and `/releases/latest/` **skips
  pre-releases**. If a version ships as a pre-release (or without `latest.yml`),
  every installed copy silently stays where it is — the user sees no error and
  no update. `release.yml` uploads `latest.yml`, but
  `fail_on_unmatched_files: false` means a missing one does not fail the build,
  so check the release page rather than trusting a green CI run.

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

### Release notes ARE the in-app changelog (v1.0.3)
The same bullets are shown **inside the app** when the updater detects a new
version, so they are a user-facing surface, not just a GitHub page. The chain is:

```
RELEASE_NOTES.md → scripts/extract-release-notes.mjs → release-notes-current.md
  → electron-builder (build.releaseInfo.releaseNotesFile) → latest.yml `releaseNotes`
  → autoUpdater updateInfo.releaseNotes → IPC app:updateAvailable
  → App.tsx update card, rendered as markdown by <AiMarkdown>
```

Consequences — requirements, not style preferences:

- **Write the bullets in natural, very concise technical Chinese.** One change
  per bullet, one line each. No English filler ("This release introduces…"), no
  marketing language, no emoji, no greeting, no closing paragraph.
- **The update card is narrow.** Keep each bullet to roughly one rendered line,
  put *what changed* first and *why* only when it is short. Never nest bullets,
  and do not put tables, headings or code fences inside a version section — they
  render badly in the card even though they look fine on GitHub.
- **A version must have its `# Weport vX.Y.Z` section in `RELEASE_NOTES.md`
  BEFORE packaging.** `latest.yml` is built from `release-notes-current.md`; with
  no section the card shows a placeholder instead of real notes.
  `scripts/extract-release-notes.mjs` therefore fails hard in CI, while the local
  `build*` scripts pass `--allow-missing` so a work-in-progress version number
  cannot block packaging — that mode writes an explicit "尚未填写更新说明"
  placeholder rather than leaving a **stale previous-version** file behind, since
  stale notes in the update card are worse than none.
- Verify before releasing: `node scripts/extract-release-notes.mjs` (no argument
  = the `package.json` version) must report exactly one version heading, and the
  `latest.yml` produced by the build must contain a non-empty `releaseNotes`.
  The strict invocation (`… <version>`, used by CI) still works.


## Reference Repos (on-disk only, never shipped)

已移至 [`docs/agents/platform.md`](docs/agents/platform.md)。

## v0.9.6 Reference-Study Policy

已移至 [`docs/agents/platform.md`](docs/agents/platform.md)。
