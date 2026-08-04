# Weport DESIGN

## Mode
Operate — desktop WeChat export console.

## Stack (v0.5+)
Native **egui / eframe** (no WebView2, no Electron). Rust engine + WCDB worker unchanged.

## Thesis
Mission-control dual rail: locate & unlock left, export right. Dense layout, larger type, rounded controls.

## Visual world
- Black ground / white signal (SpaceX monochrome)
- Rounded corners (~10px) on panels and buttons
- Custom face `src/assets/fonts/weport.ttf`
- App icon sole source: `assets/branding/weport-icon.jpg` (build.rs derives ico/png/tray for exe, task manager, tray, installer, window)

## Signature
White primary export bar + progress line; inverted account selection chips.
