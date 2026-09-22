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
