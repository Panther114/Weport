# 浮层、通知玻璃与性能基准 — v1.0.1

> 从 `AGENTS.md` 拆出（那个文件已经超出指令预算，尾部会被截断）。
> 这里是"动手前该知道的事"，不是历史说明。

## 浮层：任何弹层都必须渲染到 body 下

**症状**（用户报的）：在 WeBot 里按 `@`，选择器在顶部被切掉，"因为它不在最上层"。

**成因**：选择器挂在文档流里（`.webot-picker-anchor { position: absolute; bottom: calc(100% + 6px) }`），
而 `.webot { overflow-y: auto }`。向上展开时只要越过容器上边缘就被整块裁掉。
同一类问题在设置页（正文是 `overflow-y: auto`）与朋友圈侧栏（`overflow: hidden`）各有一份。

**规则**：

- 凡是"贴着某个触发元素弹出"的东西，一律走 `src/components/ui/FloatingLayer.tsx`：
  它渲染到 `<body>` 下的浮层根，用视口坐标定位，空间不足时翻面、贴边时夹回视口内
  （算术在 `src/utils/floatingPosition.ts`，有单测）。**不要再写 `position: absolute`
  的内联下拉** —— 那等于把"会不会被裁掉"交给祖先的 overflow 决定。
- 层级只用 `styles.css` `:root` 里那一组：`--z-sticky 20` / `--z-popover 40` /
  `--z-modal 1000` / `--z-float 1200` / `--z-toast 1400`。浮层必须高于模态
  （模态里也会开取色器），提示必须高于浮层。
- **浮层渲染到 body 之后，所有"点外面就关"的判断都要改**：`ref.current.contains(target)`
  对 portal 里的内容永远为 false —— 菜单会在被点中的那一刻关掉，点击落空。
  两个地方都要看：`rootRef.contains(target) || target.closest('.xxx-layer')`。
- 验证：`.ui-probe/verify-popup-layer.mjs` 打开**每一个**浮层（WeBot `@`、WeportAI `@`、
  快捷动作菜单、设置页取色器、朋友圈日历），对每个断言四件事：挂在 body 下、
  没有祖先裁剪它（逐个祖先比 overflow 与矩形）、完整落在视口内、z-index 高于其余定位元素。

## `@` 引用：文本与引用列表各只有一个来源

- **引用只以 chip 形式存在，输入框里不留 `@名称`。** 旧实现把 `@显示名 ` 写回文本，
  于是同一个引用出现两次（输入框一次、chip 区一次）—— 用户原话是
  "only have it show up in the space outside the input box and no longer display it
  two times"。`stripMention()` 负责把用户敲的 `@查询` 摘掉，光标停在原处。
- **弹层的搜索框是真输入框，不是 `readOnly` 的展示框。** 旧版是 readOnly：点它会把焦点
  从输入框抢走，之后一个字符也打不进去（用户看到的就是"搜索不能用"）；在 WeBot 里
  它还会触发 textarea 的 `onBlur`，120ms 后把整个选择器收走。
  现在查询串仍然只有一个来源（输入框的文本），搜索框通过 `onQueryChange` +
  `rewriteMentionQuery()` 改写那段 `@查询`，自己**不新存一份状态**（两份必然跑偏）。
- **不要在弹层打开时自动聚焦搜索框**：打出一个 `@` 就把焦点抢走会让正常打字断掉。
- 父级输入框的 `onBlur` 必须放行"焦点落进选择器"的情况：
  `if (e.relatedTarget?.closest?.('.ref-picker')) return`。
- 光标只有在 `document.activeElement === 输入框` 时才可信。用户在弹层搜索框里打过字之后，
  `textarea.selectionStart` 是旧值，拿它去切文本会切错位置。

## 通知玻璃：三个"拖了没反应"的滑块

三个滑块各自断在不同的地方，修的时候要一起看：

- **投影**：`notificationGlassVars()` 一直在写 `--glass-shadow`，而
  `NotificationToast.scss` 读的是 `--noti-shadow` —— **没有任何 CSS 读它**。
  现在读作 `var(--glass-shadow, var(--noti-shadow, …))`：用户没开投影时落回自适应引擎
  解出的 1px 边界环（关掉填充的用户仍然看得见卡片），开了才用用户的投影。
  第二个断点更隐蔽：**窗口尺寸 = 卡片 + 2×留白**，留白原本写死 8px，
  而满档投影要甩出 30 多像素 —— 多出来的部分被窗口边界切掉。
  所以留白由 `notificationCardPadding(shadow)` 内联下发，主进程
  `notificationWindowWidth()` 必须用**同一组数**算弹出前的宽度（两边各有一份常量，
  注释里互相点名；改一处必须改另一处）。
- **折射强度 / 玻璃模糊**：弹窗是 `transparent: true` 的 Electron 窗口，
  Chromium 在那里**不生效 `backdrop-filter`**（见 LiquidGlass 顶部注释）。
  这两个滑块唯一能作用的对象是主进程推上来的桌面帧，而 `NotificationWindow` 收了帧
  却从来没把它当 `backdropImage` 传给卡片 —— 于是两个滑块都是死控件。
  现在按 `notificationGlassRenderParams().needsBackdrop` 接：`blur > 0 || frost > 0`
  才把帧接进玻璃。**默认（0/0）不接**：默认观感与改动前逐像素一致，也不为一项
  没人用的效果每帧合成一张整屏截图。
- **时间小字**：与正文同色（`--glass-text-color → --noti-body-color`），层级只由字号
  （12px vs 13px）承担。旧版走 `--noti-title-tertiary`，在浅色卡片上明显发灰。

## 消息通知设置的默认值 = 用户当前那一套

用户要求："我的当前设置就是默认值，一按恢复默认不该有任何变化"。
`NOTIFICATION_GLASS_DEFAULT` 是逐项抄自 `%APPDATA%\Weport\Weport-config.json` 的
`notificationGlass*`，其中两个值最容易被顺手改回去：

- `textColor: ''` —— 空串是**有意义**的状态（按填充色极性自动），不是"没配过"；
- `radius: 25` —— 与 28 只差 3px，但按一次「恢复默认」用户就会看见卡片变圆。

`src/utils/notificationGlass.test.ts` 里有一条用例把他盘上那一串喂进
`normalizeNotificationGlass`，断言结果**逐键等于**默认值 —— 改默认值就会红。

## 性能基准：`.ui-probe/bench-perf.mjs`（`npm run bench`）

**每个大改动收尾都跑一次。** ~50 秒，有 baseline 对比和 PASS/FAIL，退出码即结论。

- 量五类：启动（rail/FCP/DCL/RSS）、切页（700ms 窗内的帧间隔与 long task）、
  弹窗（冷启动窗口创建 → 卡片首帧 → 弹窗渲染进程内的帧间隔与 CPU）、
  **玻璃增量**（磨砂/折射 0 → 100 再弹一条，差值就是这块玻璃的真实代价）、
  纯函数微基准（5000 条候选筛选）。
- `--update` 把本次结果接受为新基线；`--skip-popup` 跳过弹通知（纯应用基线）；
  `--installed` 量安装版。
- 容差按"人眼能感觉到的变化"给，不按测量噪声：本机三个会话共享 CPU，同一份代码
  连跑两次的帧指标能差 30%，所以帧类指标只做宽松门限，真正卡死的是
  "多了几百毫秒 / 多了几个百分点"。
- 它**会真实弹出两条通知**（右上角各约 1.6 秒）——弹窗必须真的弹出来才能量。
  除此之外主窗口一律移到屏幕外。

---

<!-- 从 AGENTS.md 拆出（v1.0.1）：原文未改，只换了位置 -->

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
  2. **The default is NOT fully transparent**, and it is the user's own config:
     晴空 `#d8ecff → #6aa9ea` gradient at 60 %, radius 25, text colour automatic,
     no border/refraction/frost/shadow. Do not "restore" a conservative
     white/hairline default — it is pinned by `src/utils/notificationGlass.test.ts`.
  3. **The old default border (0.5 px at 22 %) is gone** — the shipped default
     has no border at all; a hairline is still what the *radius/border* controls
     do when the user dials one in.
  4. **The gradient's two ends must differ visibly.** The user asked for "a much
     much more significant difference" between the stops, then (v1.0.1-final)
     that the whole palette was "way too subtle" and that he wanted more of them.
     Every preset now asserts **Δluma ≥ 0.20** (`GRADIENT_PRESET_MIN_LUMA_DELTA`),
     so a future list cannot quietly drift back to two near-identical pastels.
- **Glass appearance is user-configurable** via `src/utils/notificationGlass.ts`
  (fill on/off + mode + colours + opacity 0-100, text colour, border
  width/colour/opacity, radius, refraction strength, **frost/blur**, shadow,
  **card width**, **body line limit**), surfaced as 设置 → **消息通知设置** →
  通知玻璃 (`NotificationGlassPanel.tsx`, which previews with the **real** toast
  component so preview and popup cannot drift). The nav entry was renamed from
  消息通知 to 消息通知设置 in v1.0.1 — the popup's whole appearance lives on that
  page and nowhere near 系统设置, and the user asked for the name to say so.
  Everything is CSS-variable
  driven (`--glass-fill`, `--glass-text-color`, `--glass-border-rgb`,
  `--glass-border-alpha`, `--glass-border-width`, `--glass-ring`,
  `--glass-shadow`, `--glass-card-width`, `--glass-max-lines`), applied on the
  **card container** — never on `document.documentElement`
  — so the same variables serve the popup and the settings preview. User values
  take precedence over the adaptive engine via
  `var(--glass-x, var(--noti-x, fallback))`; `--glass-text-color` is *removed*
  when the user wants automatic text colour. Both the Chromium path and the
  native D3D11 panel derive their parameters from the same
  `notificationGlassRenderParams()`.
- **Refraction and blur are separate controls (v1.0.1).** `blur` drives
  `displacementScale`/aberration (the lens bend) plus a 2-4.24 px baseline blur;
  `frost` (0-100 → 0-18 px) is pure blur and changes no geometry. `LiquidGlass`
  takes the final number as the `blurPx` prop instead of re-deriving it from
  `blurAmount`, and its two fallback pipelines keep their old 1:2 ratio
  (snapshot/video = `blurPx`, `backdrop-filter` = `2 × blurPx`).
- **The colour picker is a real one (v1.0.1).** `<input type="color">` (the OS
  modal palette, 30×24, no hex, no presets, no eyedropper) is gone — the panel
  uses `ColorPicker.tsx`: 48×28 trigger with the hex printed **inside** the
  swatch, a popover with an SV area, a hue slider, a hex field, an eyedropper
  (`window.EyeDropper`) and a 24-swatch palette. `hexToHsv` deliberately keeps
  **fractional** s/v — rounding them breaks hex → HSV → hex identity (measured:
  `#b98cf0` came back as `#b88bf0`, i.e. the colour jumped one step when the
  user let go of the pointer).
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
- **Gradient fill (v1.0.0; presets and default redone in v1.0.1).** `fillMode: 'solid' | 'gradient'`
  plus `fillGradientFrom/To`, with **51 presets** in `GRADIENT_PRESETS` (the **first one is the
  shipped default: 晴空 `#d8ecff → #6aa9ea`**). The list is no longer hand-picked: the stops come
  from public curated libraries (uiGradients, WebGradients, Tailwind) so the colours are ones real
  products actually ship, and the panel renders them in a **scrolling box** (`max-height`)
  or 51 presets push the rest of the settings page off screen. **Left-to-right only** (`90deg`) — the user asked
  for that explicitly, and a notification card has no room for an angled gradient that does
  not read as a rendering fault. `notificationGlassFillValue()` returns either
  `rgba(...)` or `linear-gradient(90deg, rgba(a,α), rgba(b,α))` and it is safe because
  LiquidGlass paints the tint layer with the `background` **shorthand**
  (`index.tsx`, `background: 'var(--liquid-glass-tint)'`), so no new variable and no second
  element is needed — which also keeps the "the fill covers the whole card or does not
  exist" rule intact. An `alpha: 0` gradient deliberately collapses to a transparent solid.
  Every preset declares the text polarity it expects (`expect: 'dark' | 'light'`) and the
  test compares that against `glassTextPolarity`; do not go back to a hard-coded
  "everything except graphite is dark" list.
- **Card size is adaptive and the popup window follows it (v1.0.1).** The user's two
  complaints were "a long sender name collides with the time" and "a long message cannot
  fit". Both are fixed by letting the card take the space it needs, not by truncating:
  - `NotificationToast` renders a **hidden measuring span** holding the title text and
    derives `extra = naturalTitleWidth − titleWidthAtBaseWidth`
    (`notificationCardExtraWidth`, pure + unit-tested), bounded by
    `NOTIFICATION_CARD_MAX_EXTRA_WIDTH` (220 px) and `NOTIFICATION_CARD_MAX_WIDTH` (640 px).
    Measuring the live title's `scrollWidth` instead would read "it fits" right after the
    card grew and shrink it back — the hidden span makes the calculation idempotent.
  - The header is a plain flex row (title `flex: 1` + ellipsis, time `flex: none`). The old
    absolutely-positioned time plus `margin-right: 50px` plus `text-overflow: clip` is what
    actually produced the collision; do not bring it back.
  - Body lines come from `--glass-max-lines` (default **4**; it used to be a hard-coded 2).
  - `NotificationToast.onMeasure` → `notification:resize` → main process
    `applyWindowSize` **and reposition**: right-anchored and centred windows must recompute X
    when the width changes, otherwise a grown card runs off screen. The main process reads
    `notificationGlassWidth` only for the *pre-show* position; the final size is always what
    the renderer measured. `top-center` no longer forces a narrower 280 px card.
  - Verified by two probes: `.ui-probe/verify-glass-settings.mjs` (the settings panel —
    switches to the 超长昵称 preview sample and asserts the card grew while title/time still
    do not overlap) and `.ui-probe/verify-popup-adaptive-width.mjs` (the **real** popup —
    shows one notification with a long title and asserts the window got wider, stayed
    right-anchored, and that the card width equals the window width; it does flash a real
    toast for a few seconds, which is why it is a separate, manually run probe).
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
- **The default fill is the user's saved look — 晴空, radius 25, text colour automatic.**
  Pinned item by item in `NOTIFICATION_GLASS_DEFAULT` so 恢复默认 is a no-op; a test feeds the
  user's own config through `normalizeNotificationGlass` and asserts key-for-key equality.
  The 16 %-white simplification above is superseded. If a future change washes out the bright
  case, make the fill polarity-aware in `resolveNotificationTheme` (both the polarity and the
  user's opacity are known there) rather than "restoring" a lighter default.
- Settings/probe for the panel: `.ui-probe/verify-glass-settings.mjs` (asserts the computed
  defaults — 晴空 at 0.6, radius 25, border 0, automatic text colour, width 344, 4 lines,
  ≥ 20 presets each showing ≥ 0.20 Δluma on the rendered swatches, `input[type=color]` gone,
  no text scrim — plus **live** checks: the opacity slider reaches 100 %, a palette click
  changes the card, and **投影/折射/模糊 dragged to 100 really change the rendered glass**
  (`--glass-shadow` appears, the card's padding grows to fit it, `data-glass-disp` 0 → 222).
  It strips the `notificationGlass*` keys from its copied config so it tests the defaults,
  and runs the window **off screen**.
- **The contrast audit knows about the card fill (v1.0.1).** `capture-ui.ps1` walks each
  text node's ancestor chain for a background colour; the notification fill is painted on a
  *descendant* overlay, so black-on-light-glass was reported as black-on-dark-panel
  (measured 1.18, a hard failure). `effectiveBg` now also composites `--glass-fill`
  (gradient stops averaged, same rule as `notificationGlassRepresentativeRgba`) **once** —
  custom properties inherit, so layer it only where the element's value differs from its
  parent's, otherwise the same fill stacks N times and the composite is meaningless.
  Corollary for preview controls that draw the fill themselves: use a **solid
  `background-color`**, never an inline `background: linear-gradient(...)`, or the shorthand
  resets `background-color` to transparent and the audit loses the backdrop again.
- The GL stream path needs a `MediaStream`; when `srcObject` fails (software rendering,
  no GPU) the pipeline reports `frames` but the canvas is **absent** and the static
  snapshot `<img>` is what you see. `data-glass` alone does not prove the WebGL path is live.

---

<!-- 从 AGENTS.md 拆出（v1.0.1）：原文未改，只换了位置 -->

## Notification Popup (Permanent — Do Not Change)

The popup is `electron/windows/notificationWindow.ts` (WeFlow port): a separate
frameless transparent `BrowserWindow` (created 344×114 and then sized to what the
renderer measured — v1.0.1: base width from `notificationGlassWidth` (300-640),
plus up to 220 px of adaptive growth for long sender names, top-right of work area,
`alwaysOnTop`, `focusable: false`, `skipTaskbar`, click-through
when hidden). Renderer: `src/pages/NotificationWindow.tsx` +
`src/components/NotificationToast.tsx` + `LiquidGlass` (native
`@hicccc77/electron-liquid-glass` panel with Chromium desktop-stream fallback;
the native glass panel is **Windows-only** — on macOS only the Chromium
fallback path runs).

**The window must stay exactly the size of the card** (the renderer reports it through
`notification:resize`, and any bigger area swallows desktop clicks), and **every size
change must re-anchor the window**: right/bottom-anchored and centred positions recompute
X/Y from the work area, otherwise an adaptively widened card grows off screen. Sizing rules:
see "Glass Surfaces → Card size is adaptive".

**The window is revealed *after* the renderer reports its first measured size**
(v1.0.1 smoothness fix). The old order was `send(payload) → showInactive()` immediately,
and since only the renderer knows the real size (adaptive width from long sender names,
height from the body line count) the window appeared with the **previous** card's
geometry, then grew/re-anchored 50–370 ms later — the visible "popup pops, then jumps".
Now: `send → renderer measures in the same frame → notification:resize → setSize +
re-anchor → revealPopup()`, so the first visible frame is already final. `revealPopup()`
has a **250 ms fallback** so a wedged renderer delays a notification but never drops it,
and `notification:close` cancels a pending reveal. Consequences for anyone touching this:

- The renderer's first size report is **synchronous** (`report('immediate')` in
  `NotificationWindow.tsx`), not a 50 ms timer. Re-adding a delay re-adds the jump.
- The size dedupe is keyed by **notification id**: the first report of every new message
  must go out even when the size equals the previous one, otherwise the reveal waits for
  the fallback (measured: warm path 1 ms → 138 ms).
- A 0-height report is dropped in the renderer (`rootHeight < 1 && !measured`), because a
  0-height window would be revealed invisible and then "grow open".
- Payloads carry a `payloadId`; the renderer ignores a repeat of the same id. Both
  `notification:show` and the `notification:ready` catch-up can deliver the same
  notification, and a double delivery restarts the entrance animation (a flicker).

**Measure it, don't guess:** `node .ui-probe/probe-popup-latency.mjs` prints the whole
path (window create → load → payload → renderer measure → reveal) with per-step deltas;
`WEPORT_POPUP_TRACE=1` (see `electron/services/popupTrace.ts`) is what feeds it.

**The card's default look is a 晴空 gradient (`#d8ecff → #6aa9ea`) at 60 %, text colour
automatic, radius 25, no border/refraction/frost/shadow — v1.0.1-final, pinned item by item
to the user's own config so 恢复默认 is a no-op. The "light glass fill" of v1.0.0, the
blue→violet v1.0.1-preview default and the fully transparent card before them are all
superseded.** See
"Glass Surfaces → Popup glass" for the current rules and the configurable `--glass-*`
variables. What still holds from the earlier work is everything
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

---

<!-- 从 AGENTS.md 拆出（v1.0.1）：原文未改，只换了位置 -->

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

---

## 通知弹窗动效 — v1.0.1（滑动是默认）

- **两套动效，一个开关**：`notificationAnimationStyle` = `slide`（默认）/ `classic`。
  `classic` 是旧版的"原地淡入 + 轻微缩放"，用户明确要求保留 —— 不要删掉它只留滑动。
- **方向由弹窗位置决定**，映射只有一份实现：`src/utils/notificationAnimation.ts`
  `slideFromPosition()`（右上/右下 → 右，左上/左下 → 左，顶部居中 → 上）；退场沿原路返回。
- **入场从屏幕外开始**。窗口只有卡片那么大时，卡片只能从"屏幕内 20px 那条线"钻出来 ——
  用户看到的是凭空冒出。所以滑动时窗口按方向多留 `travel = 卡片尺寸 + 20px`（`room`），
  那一段落在屏幕**外**；卡片位移恰好等于它（`translateX(calc(100% + 20px))`）。
- **卡片在窗口里用固定偏移贴边，不用 `flex-end` / `bottom: 0`**。偏移是常量
  （左/上滑动时 = 卡片尺寸 + 20px），因为渲染层的布局比窗口的实际变化晚一帧：
  用对齐属性时，窗口一改几何，那一帧里卡片会被画到错误位置（实测：一次 104px 抽动
  + 全程被裁）。
- **只有右侧滑动会"收回"窗口**（`anchorPopupBounds` 里 `trimmable`）。收回是为了让屏幕上
  恰好只剩卡片（AGENTS 第 4 条）；右侧收回只改宽度、窗口原点不动，所以卡片不会动。
  左侧/顶部收回必须**移动窗口原点**，那就会撞上"布局晚一帧"。代价是屏幕上多出 20px 窄带，
  比闪烁划算 —— 这是有意做的取舍，不要"顺手修掉"。
- **入场动画门控在"窗口真的显示了"上**：`showInactive()` → `notification:shown{payloadId}`
  → 渲染层 `data-run=true` 起跑；渲染层另有 400ms 兜底。未起跑时卡片钉在位移起点
  （窗口外，被 `overflow:hidden` 裁掉，不可见也点不到）。**连续两条通知时旧卡片用同一个
  门**，两张一起动。
- **退场前先放开窗口**（`notification:prepare-exit`，渲染层 await 它再开始动画，150ms 兜底）
  —— 否则卡片滑向屏幕外的那一半会被窗口边界切掉（用户原话："退场一顿、还有一段是切断的"）。
  处理器必须注册在 `registerNotificationHandlers` 里**那段提前 return 之前**：关掉消息推送
  的用户走的是提前返回路径，注册在它后面就等于没注册。
- **时长只有一份数字**：入场 1050ms / 退场 620ms（classic 300ms）。`NotificationToast.dismiss()`
  按它决定何时真的关窗，两份 scss 里的 `transition`/`animation` 时长必须一致。
- **位移只用 transform**，退场不做透明度渐变（玻璃变透明会先露出窗口底下的桌面）。
- **几何每一次变化都要通知渲染层**（`notification:geometry`）：主题采样按"窗口在屏幕上的
  位置"把取样点挪到窗口外面，坐标过时就会读到几百像素外的桌面。
- 验证：`.ui-probe/verify-popup-slide.mjs`（起点在屏幕外 / 位移单调且不跳 / 收回窗口时卡片
  不许动 / 退场先放开再滑出 / 替换时两张一起动 / 文字色全程不变），
  `npm run bench` 的 `[C/D] 通知弹窗`（窗口创建 / 首帧卡片 / 帧 p95 / CPU）。

## 通知玻璃 — v1.0.1（按 Aave《Building Glass for the Web》补的三层）

透镜位移贴图早就是那篇文章的做法（`lensDisplacementMap.ts`：圆角矩形 SDF → 球冠斜率 →
斯涅尔弯曲，高光编码在蓝通道，左上象限四重对称）。缺的是**折射全关时**能不能读出玻璃：

- **镜面高光层**（`data-glass-specular`）：由法线算出的高光单独导出成一张"白 + alpha"的图
  （同一次象限循环里多写一个通道），用 `mix-blend-mode: screen` 贴在卡片上。它沿圆角走，
  左上最亮、往下渐隐 —— 折射/模糊全是 0 时，这一层是"这是曲面玻璃"的唯一证据。
  `generateLensDisplacementMap` 因此**在 WebGL 流管线里也要生成**（着色器不用位移贴图，
  但高光层要用）。
- **厚度层**（`data-glass-thickness`）：1.5px 环上叠一条纵向渐变 —— 上缘细亮、下缘细暗。
  玻璃有看得见的厚度，均匀白描边只会读成"塑料贴纸的边"。
- **两段式投影**（`notificationShadowLayers`）：1px/2px 的**接触阴影**（贴着下沿，圆角处
  也是圆的）+ 滑块控制的**环境阴影**。只有一层大模糊时，眼睛读到的是"一块糊在下面的灰"，
  不是"这块玻璃压在桌面上"。
- **兜底投影必须装得进留白**：引擎的兜底曾是 `0 6px 18px`，而滑块 = 0 时窗口只留 8px ——
  影子被窗口边界**切掉**，这就是用户说的"下面那块灰不像真的、不跟圆角走"。现在兜底是
  1px/2px + 2px/5px（合计 7px，正好在留白里），要更大的影子就动「投影」滑块，留白会跟着长。
- 验证：`scripts/capture-ui.ps1`（照 `%TEMP%\weport-electron-screenshots\popup.png` 直接看像素），
  `npm run bench` 的满档玻璃 CPU / 帧 p95（加了这三层后仍是 3.25% / 17.4ms）。

## 实时桌面折射的帧率 — v1.1（koffi BitBlt 快采）

用户报的"玻璃刚出现那一两下会卡"。量出来的是**帧率**，不是弹窗延迟（冷 248ms / 热 5ms
本来就不慢）：两条采集路里 WGC 视频流在这台机器上永远起不来，只剩主进程定帧推送，
而当时"抓一帧"用的是 `desktopCapturer.getSources()`，实测稳态 **0.7fps**。

- **先量成本，别猜分辨率。** 实测 `getSources`：320×180 = 208ms、192×108 = 199ms、
  128×72 = 197ms、90×50 = 168ms —— **与输出像素数几乎无关**，那是 Chromium 采集管线的
  固定开销。所以"把抓帧分辨率再调小"没有意义，必须换实现。只要 source id
  （`thumbnailSize:{0,0}`）也要 150ms。
- **本机 WGC 是硬失败**：`getUserMedia` 与 `getDisplayMedia`（安全上下文 + Electron
  `setDisplayMediaRequestHandler`）都是 `NotReadableError: Could not start video source`，
  Chromium 日志 `wgc_capture_source.cc CreateForMonitor failed with hr: -2147024891`
  （E_ACCESSDENIED，Iris Xe + 该驱动）。渲染层那段 getUserMedia 因此**每条通知都白等
  ~150ms** 才失败回落 —— 它不是罕见路径。
- **快采路径**：`electron/services/glassCapture.ts` 用 koffi（项目已有依赖，WCDB 在用）
  直调 GDI —— 一个 `BitBlt` + 一次 `GetDIBits` 抓**玻璃所在的那一小块**（卡片 + 40px
  模糊边距，约 420×144 物理像素）：实测 5~22ms（中位 ~12ms），比整屏 JPEG 快 10~17 倍
  （整屏 BitBlt 35.6ms，也没必要）。任何一步失败返回 null，调用方回落老路。
- **帧的形态**：快采帧是原始 BGRA（`pixelsBase64` + `frameX/Y/Width/Height` 屏幕矩形），
  渲染层解成 `ImageData` 交给玻璃画进一张内部 canvas（`data-glass-frame`），不走 JPEG
  编解码也不走 dataURL —— 每帧只剩 base64 编解码 + 一次 `putImageData`。`data-glass`
  仍是 `frames`（`stream` 只在 WGC 真的起来时才出现）。
- **帧间隔**：快采路 `max(33, min(100, 成本×3))`（实测稳态 ~14fps，之前 0.7fps）；老路
  沿用 3× 成本、200~1000ms。`WEPORT_GLASS_NOCAPTURE=1` 强制回老路（排查采集问题用）。
- **量它的探针**：`.ui-probe/probe-popup-latency.mjs` 只看弹窗出现延迟；看帧率要读弹窗
  里的 `data-glass-seq` 随时间的变化。注意：主窗口移出屏幕后，Chromium 会让弹窗页的
  DOM 查询返回空（`#root` 长度 0）—— 那是探针假象，不是渲染失败。
