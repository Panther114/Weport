# performance

---

<!-- 从 AGENTS.md 拆出（v1.0.1）：原文未改，只换了位置 -->

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

### Long-task progress must survive the page (v1.0.1)

- **Progress may never live in a page's `useState`.** Pages are `React.lazy` + conditional
  render, so switching a rail tab unmounts them; tray-hide **destroys the window** and
  minimize unloads the page, so the renderer can be rebuilt entirely while the task keeps
  running in main. The three symptoms the user reported were all this one bug: clone
  generation shows nothing on return, export resets to `准备中 0/0` (losing the cancel
  button), connect finishes with nobody telling you. The fix is two layers and **both are
  required** — data (`src/utils/liveTask.ts` + `liveTaskWiring.ts`, installed from
  `main.tsx` at startup, plus main-process `taskStatusService` / `task:status`) **and**
  visibility (`src/components/BackgroundTasks.tsx`, mounted on `App`, present on every
  tab, with elapsed time and jump/cancel). Data that exists but cannot be seen is not a fix.
- **Export cannot infer its own terminal state.** Its progress payload has exactly six
  phases (`preparing / exporting / exporting-media / exporting-voice / writing / complete`)
  — cancel and failure **emit no event at all**. Local state would sit at `running` forever
  and the corner task strip would show a phantom export. Terminal states come from the main
  process snapshot, which is why the wiring polls (1.2 s) instead of trusting events.
- **A stale terminal snapshot must not hydrate.** `TERMINAL_SNAPSHOT_TTL_MS` (3 min) exists
  because a rebuilt window would otherwise surface a "生成完成" card from three days ago.
  Running snapshots always hydrate; terminal ones only while fresh.
- **The WeClone page's own section is page state too.** Moving progress into a store is not
  enough: returning to the tab landed on the hub, so the panel was still invisible.
  `WeClonePage` keeps a module-level `lastSection` and **forces `create` whenever a
  generation is running**. This one was found by the probe, not by reading code — the first
  run's `back.panel` was `false`.
- **Every new long-running action gets a `LIVE_TASK` key** and is added to both
  `liveTaskWiring.ts` and `BackgroundTasks.tsx`. A long action with no key is invisible the
  moment the user looks away.

---

<!-- 从 AGENTS.md 拆出（v1.0.1）：原文未改，只换了位置 -->

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
- **WeClone retrieval is a prefilter pass, not a full tokenize (v1.0.1).** `retrieveLocalChunks`
  used to `JSON.parse` + tokenize all 21,201 chunks on every chat turn: **1.4–2.8 s** before the
  model was even called (measured on the author's 22.4 MB corpus). The正文 is a substring of the
  JSON line, so a `includes` prefilter lets only the 1–5 % of lines that can match be parsed.
  Measured: 1411 → **334 ms** (`最近在忙什么`), 1582 → **929 ms** (an English query that really
  matched 1543 docs), 2777 → **736 ms** (`the`). Candidate set and `df` stay exact; only the
  non-candidate document lengths use a character-scan estimate (`estimateTokenCount`) — BM25's
  length term only needs a consistent monotone unit. Do not "simplify" this back to one pass.
- `transition-property` defaults to `all`. `transition-duration: 0.15s` alone therefore
  transitions every animatable property — name the properties explicitly.
- Images: `loading="lazy"` does not move decode off the critical path; `decoding="async"`
  does. Applied to avatars, SNS media thumbnails, link-card thumbnails and the lightbox.
- Splitting the bundle is only safe because dynamic `import()` works under `file://` in
  packaged Electron. It does — `.ui-probe/check-dynamic-import.mjs` asserts it against the
  installed `app.asar` (13 exports resolved). A blocked dynamic import shows up as a
  permanent Suspense fallback, not as a build error.
