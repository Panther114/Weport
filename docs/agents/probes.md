# probes

---

<!-- 从 AGENTS.md 拆出（v1.0.1）：原文未改，只换了位置 -->

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
- **一个用真实 userData 的探针，跑之前必须确认没有实例在跑** —— 否则新进程启动后
  **以 exitCode 0 立刻退出**，Playwright 报的是
  `electron.launch: WebSocket error: read ECONNRESET`，日志里只有 DevTools 的 ws 断开，
  **完全看不出是单实例**。实测症状（这一条花了十几分钟才定下来）：
  ```
  <ws connected> ws://127.0.0.1:14306/...
  [err] DevTools listening on ws://127.0.0.1:14308/...
  <ws error> ... read ECONNRESET
  <process did exit: exitCode=0, signal=null>
  ```
  判据：`Get-Process Weport` 有货 → 先关掉再跑（`verify-clone-delete.mjs`、
  `verify-v101.mjs` 这类用真实 userData 的都算）。**exitCode 0 不是崩溃**，
  是"我已经在跑了，你退下"。
  反向也成立：想确认单实例还活着，就 `Start-Process` 一次安装版，看它是不是几秒内
  以 0 退出 —— 这条比读代码快。
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
