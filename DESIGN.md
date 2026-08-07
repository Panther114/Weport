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
- App icon sole source: `assets/branding/weport-icon.jpg` (installer / tray /
  taskbar / window)

## Signature
White primary export bar + progress line; inverted account selection chips.
