# Weport DESIGN

## Mode
Operate — desktop WeChat export console.

## Stack (v0.7+)
Electron + React + Vite + TypeScript (WeFlow-derived). Native engine in
`electron/services/` (koffi FFI + wcdb_api.dll via WeFlow.exe host subprocess).

## Thesis
Mission-control dual rail: locate & unlock left, export right. Dense layout,
larger type, rounded controls.

## Visual world
- Black ground / white signal (SpaceX monochrome)
- Rounded corners (~10px) on panels and buttons
- Custom face `src/assets/fonts/weport.ttf`
- App icon sole source: `assets/branding/weport-icon.jpg` →
  `assets/icons/icon.png` (rounded corners + transparent background, used by
  installer / tray / taskbar / window / navbar; `public/icon.png` mirrors it
  for the renderer)

## Signature
White primary export bar + progress line; inverted account selection chips.
Export page: numbered sections (输出设置 / 导出格式 / 内容 / 高级选项) with
format icons, A/B/C directory-layout cards showing mini trees, blue preview
path, reset-to-defaults button in the panel head.

## v0.9 additions
- New top-bar tabs 朋友圈 (Images icon) and 分析 (LineChart icon), same
  monochrome language; all v0.9 styles live in `src/styles/v09.scss`.
- 朋友圈: left author/keyword/date filter rail + dense post feed; white-on-black
  chips for 防删除/导出; media grid with dark overlay badges; fullscreen
  lightbox preview; per-author timeline dialog.
- 分析 hub: two big tappable cards (全局分析 / 群聊分析) with large icons,
  hover lift + icon tilt; B/W ECharts theme (`src/utils/echartsTheme.ts`):
  white bars, gray secondary, dashed gridlines, dark tooltips.
- 年度报告: full-viewport overlay with a big-type hero year, 3-card core
  friends, monochrome 7×24 heatmap (white→black ramp), section capture export.
- Density: stat cards, ranking rows and member rows put numbers first with
  thin progress bars — more information per panel than WeFlow equivalents.
