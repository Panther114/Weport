# AGENTS.md — Weport Project Constraints

> **Read this before making any UI, popup, or WCDB-related changes.**
> These constraints encode hard-won debugging sessions (the -1006 host check,
> Electron stdin EOF, zero-window quit). Violating them produces subtly broken
> builds that pass typecheck.
>
> With a few exceptions this file is an **index**: the subject matter lives in
> `docs/agents/*.md` (see the table right below). Keep it that way — this file has
> a hard size budget and anything past it is silently truncated when loaded.

## 先读哪个文件（按你要动的东西）

| 要动的东西 | 先读 |
|---|---|
| 弹层 / 弹窗 / 通知玻璃 / 通知卡片 | [`docs/agents/ui-surfaces.md`](docs/agents/ui-surfaces.md) |
| 性能、进度条、状态面、`npm run bench` | [`docs/agents/performance.md`](docs/agents/performance.md) |
| 写或改**探针**（`.ui-probe/`、`capture-ui.ps1`） | [`docs/agents/probes.md`](docs/agents/probes.md) |
| WeClone 人格克隆及其生成管线 | [`docs/agents/weclone.md`](docs/agents/weclone.md) |
| WeportAI 对话内核（历史、压缩、工具、计费） | [`docs/agents/weport-ai.md`](docs/agents/weport-ai.md) |
| 打包 / 平台差异 / TUI / 连接器 / 视频背景 / 托盘 | [`docs/agents/platform.md`](docs/agents/platform.md) |
| 朋友圈、分析、防撤回、导出、MCP | [`docs/agents/modules.md`](docs/agents/modules.md) |

**这个文件只放"动手前必须知道、违反了会做出静默坏掉的东西"的条款。**
上面那些文档是同一份约束的正文 —— 需要细节时打开它们，不要把内容再抄回来。

## 四条跨模块铁律（展开见上面的文档）

1. **浮层一律渲染到 `<body>` 下**（`components/ui/FloatingLayer`）。写 `position: absolute`
   的内联下拉 = 把"会不会被祖先的 overflow 裁掉"交给运气。浮层改到 body 之后，
   所有"点外面就关"的 `ref.contains(target)` 判断都会失效，必须一并改。
2. **探针绝不许出现在用户的屏幕上。** 默认私有 `--user-data-dir` + 移到屏幕外
   （`setPosition(-4000, 0)`）；必须可见的验证先问人。详见 `docs/agents/probes.md`。
3. **长任务的进度不许存在页面的 `useState` 里**：切页会卸载、托盘隐藏会销毁窗口。
   数据（`utils/liveTask.ts` + `taskStatusService`）与可见性（`BackgroundTasks`）两层都要有。
4. **通知弹窗窗口必须正好等于卡片**（含用户投影所需的留白）。多出来的每一个像素都在
   拦截桌面点击。改尺寸就要同时改主进程那份重复的换算常量。

## Tech Stack (Permanent)

Weport is an **Electron + React + Vite + TypeScript** desktop app for
**Windows, macOS (Apple Silicon, arm64) and Linux (x64, v0.9.10+)**. The engine
(`electron/services/`) is a TypeScript port of WeFlow's WCDB stack (koffi FFI
+ native `wcdb_api.dll` / `libwcdb_api.dylib` / `libwcdb_api.so`). There is
**no Rust, no Tauri** anymore — the v0.6.x Rust/egui stack was removed in 0.7.0.
(The v1.0 `weport` TUI in `packages/weport-tui` is a *client* of the app, not a
second engine; read [`docs/agents/platform.md`](docs/agents/platform.md) before touching it.)

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

## WCDB Host Process (Permanent — Do Not Change)

`wcdb_api.dll` / `libwcdb_api.dylib` refuses to initialize (`-1006`) unless
the host executable is named **`WeFlow.exe`** (Windows) / **`WeFlow`**
(macOS, same-name rule). Empirically verified on Windows: any other name
fails, a renamed copy/hardlink passes. The app therefore runs the WCDB
engine in a **subprocess**:

- `electron/wcdbHostClient.ts` deploys a `WeFlow[.exe]` host for the `-1006`
  filename check, then spawns it with
  **`ELECTRON_RUN_AS_NODE=1`** (v0.9.3+) so the same binary runs as pure
  Node.js — no Chromium browser process, no network utility child
  (host RSS ≈ 45 MB vs ≈ 105 MB + 50 MB child in Electron mode). The `-1006`
  check only inspects the exe filename, not the runtime.
  Platform rule (v1.0.1): **Windows/Linux hardlink next to the exe; macOS
  NEVER writes inside the bundle.** A `Contents/MacOS/WeFlow` hardlink breaks
  the bundle seal (`codesign --verify --deep --strict` → `file added`,
  measured on a real v1.0.0 install), and the CI seal gate runs before first
  launch so it cannot catch a runtime self-modification. darwin therefore
  always deploys to `{userData}/wcdb-host/Contents/MacOS/WeFlow` (bundle
  structure + symlinked `Frameworks`) and deletes a legacy in-bundle link on
  startup to self-heal the seal.
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

## Self-sent Message Filtering

`messagePushService.ts` (WeFlow logic) filters on `message.isSend === 1`
in `pushSessionMessages`/`buildPayload`. Keep that intact.

## Build & Test

```sh
npm install                                   # postinstall: electron-builder install-app-deps + runtime DLL sync
npm run dev                                   # vite dev + electron (vite-plugin-electron)
npm run typecheck                             # renderer + electron typecheck
npm run build                                 # clean → tsc → vite build → prepare-host-bundle → electron-builder (NSIS, Windows)
npm run build:dir                             # unpacked build (faster iteration; same chain)
npm run build:mac                             # macOS DMG + ZIP (arm64, 需在 macOS 上执行)
npm run build:linux                           # Linux AppImage + tar.gz (x64, 需在 Linux 上执行)
npm run bench                                 # 性能基准（~50s，带基线对比与回归门限；--update 接受为新基线）
powershell -ExecutionPolicy Bypass -File scripts/capture-ui.ps1
```

**每次大改动收尾跑一次 `npm run bench`。** 它量启动 / 切页 / 弹窗 / 满档玻璃 / 候选筛选
五类指标，对着 `.ui-probe/bench-baseline.json` 判 PASS/FAIL，退出码即结论；详细的
方法论与容差理由见 [`docs/agents/ui-surfaces.md`](docs/agents/ui-surfaces.md)。

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
