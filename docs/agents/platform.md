# 平台打包、TUI、连接器与参考仓库

> 从 `AGENTS.md` 拆出：这里是模块与历史说明，不是动手前必读的不变量。

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

## Linux Notifications (D-Bus first)

- On Linux the app-internal popup's live glass needs `desktopCapturer`, which on
  Wayland raises the xdg-desktop-portal "share screen" dialog for **every
  message**. Linux therefore delivers through the desktop notification daemon
  (`electron/services/linuxNotify.ts` → `notify-send`; mako/dunst/swaync) and
  only falls back to the Electron popup when no daemon is present.
- `linuxNotificationMode` (`auto` | `force-dbus` | `off`, default `auto`) is read
  live; `WEPORT_LINUX_NOTIFY` overrides it. A send failure invalidates the daemon
  detection cache and still falls back to the popup — a message must never be lost.
- **The fallback popup must not capture the desktop on Linux**: guards live in
  `runBackdropStream`, `prewarmDesktopSourceId`, `refreshDesktopSourceId`, and the
  `notification:show` backdrop payload sends `sourceId: null` (the renderer only
  calls `getUserMedia` when a source id exists). Do not remove them; that is what
  resurrects the portal dialog.
- `WEPORT_SCREENSHOT_POPUP=1` deliberately bypasses the D-Bus route (the QA harness
  captures the app's own popup).
- Chat notifications carry a `default` action (`notify-send --print-id
  --action=default=打开微信`); clicking runs `wechatLinux.openWeChat()` — launches
  WeChat when absent, focuses the window when present. WeBot/AI notifications have
  no action (there is no "back to WeChat" meaning).
- **Match the WeChat window by `app_id` (`wechat`), never by pid.** Flatpak/bwrap
  sandboxes have their own PID namespace, so niri reports the sandbox-local pid
  (under XWayland it even resolves to `xwayland-satellite`), which can never equal
  the host pid from `pgrep`. Pid and exact title are only fallbacks.
- Focus is best-effort: niri IPC (`NIRI_SOCKET`, else `niri.wayland-*.sock` in the
  runtime dir) then `xdotool` on X11. If WeChat is running but no window is found,
  do **not** relaunch — that risks a second instance.
- The process detection/launch logic is shared with key capture
  (`electron/services/wechatLinux.ts`, imported by `keyServiceLinux.ts`). Keep it
  one implementation; the Linux key path must still attach to exactly one process.

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

---

<!-- 从 AGENTS.md 拆出（v1.0.1）：原文未改，只换了位置 -->

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

---

<!-- 从 AGENTS.md 拆出（v1.0.1）：原文未改，只换了位置 -->

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

---

<!-- 从 AGENTS.md 拆出（v1.0.1）：原文未改，只换了位置 -->

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
