# v1.2.1 cross-platform verification

`Verify v1.2.1 macOS and Linux` is a verification-only workflow. It uses a
read-only repository token and builds with `--publish never`. It never creates
tags/releases, edits updater feeds, or backfills the Windows-only v1.2.1 release.
Mac installers are temporary Actions artifacts, not a Mac release.

The workflow runs on macOS 15/26 ARM64 and Ubuntu 22.04/24.04 x64, with independent
matrix failures. Every runner installs dependencies, typechecks both TypeScript
projects, runs the full unit/native regression suites, checks version/release
notes, and builds native distribution packages. `verify-cross-platform.mjs`
then runs independent packaged gates and records every outcome, including failures.

## Packaged acceptance

- Native payload architectures, protection/init/shutdown and wrong-host rejection.
- An actual encrypted synthetic database through the deployed IPC WCDB host:
  session/message identities, paging, reconnect, indexed search, Reader fallback,
  ten export formats independently parsed with Python, incremental repeat, and
  deliberately corrupted output repair. Input database hashes must stay unchanged.
- Packaged dependency/WASM/image smoke, responsive UI/navigation, feedback dialogs,
  intercepted clipboard/browser handoff, and anti-delete success/failure feedback.
- HTTP/MCP authentication, malformed requests, concurrent clients, Origin policy,
  account-scoped annotations, CLI IPC and credential privacy.
- Narrow/wide TUI dumps and repeated route navigation with actual renderer
  destruction/recreation, task-status IPC recovery, runtime errors and metrics.
- macOS signatures/linkage/minimum OS, ZIP round trip, read-only DMG mount and seal,
  and bundle seal before/after the encrypted fixture run.
- Linux DEB installation, root-owned sandbox permissions, sandbox-enabled installed
  MCP acceptance, encrypted-fixture/export acceptance through the installed app's
  read-only host deployment fallback, and matching app.asar bytes in DEB, tar.gz
  and AppImage payloads.
- Linux startup/page/filter/idle performance sampling without a cross-machine
  baseline or desktop capture. macOS route-cycle process metrics are descriptive.

Each runner retains JSON receipts, per-gate logs and synthetic screenshots for
14 days. Successful package artifacts are retained for seven days. The receipt
identifies the exact checked-out SHA; a branch or version label alone is not proof.

## Limits

These checks do not establish live WeChat key acquisition, real-account permission
prompts, macOS notarization/Gatekeeper acceptance, native message_fts.db search,
live notification glass, Wayland compositor behavior, every media format, or
day-long stability. The encrypted fixture contains two text messages and a known
key; media/package smoke and the full regression suite provide separate coverage.
No real profile, database, credential, external model, connector delivery, or
GitHub issue submission is used by the packaged acceptance scripts.
