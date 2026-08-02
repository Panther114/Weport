# Weport DESIGN

## Mode
Operate — task-first export console for Windows WeChat history.

## Thesis
A precise dual-column instrument: locate local WeChat data on the left, dump every chat on the right. No marketing chrome — only control, status, and progress.

## Visual world
- Near-black graphite (`#07080b` base) with soft amber + cool-blue atmospheric glows
- Single amber signal accent (`#e6a23c` → `#f3c06a`) for primary actions and selection
- Glass-like panels: translucent fills, 16px radius, hairline borders, soft inset highlight
- System UI type (Segoe UI Variable) + Cascadia Mono for paths
- Subtle film grain overlay; restrained motion (enter, press scale 0.96)

## Signature
Amber progress meter with live session name while exporting; segmented TXT/JSON format switch.

## Layout
Two columns (~1080×720): data / account / key left; export library right. Primary export CTA pinned at bottom of right column; secondary “clear library” as danger action.

## Export library layout (filesystem)
```
{output}/
  TXT/           # text exports (overwrite on re-run)
  JSON/          # json exports
  export_log.txt # last run times for TXT and JSON
```
