# Windows per-database keys and read-only connection

## Key semantics

The Windows scanner returns a separate 32-byte SQLCipher page key for each database. It does not return the account passphrase consumed by the current `wcdb_open_account(session.db, key, ...)` API. A scanned key must be validated against its database's page-1 HMAC; a shape check or a successful scan alone is not sufficient.

SQLCipher distinguishes raw key bytes from a passphrase string. A string key is passed through PBKDF2; the `x'…'` blob form supplies exact key bytes without that derivation. A 64-character hex value can also be decoded to 32 bytes and then passed as the passphrase bytes. These are three distinct modes and must be verified by page-1 HMAC, not inferred from string shape. On Oct 3, raw and UTF-8 hex-text modes failed the private mirror control; decoded-hex-byte passphrase mode matched. See [SQLCipher's key API](https://www.zetetic.net/sqlcipher/sqlcipher-api/#setting-the-key).

For the supported page format, page 1 contains a 16-byte salt, encrypted payload, a 16-byte IV, and a 64-byte HMAC-SHA512. The HMAC covers the authenticated page bytes and the little-endian page number; page 1 excludes its salt from the authenticated range. The page key is accepted only when the HMAC matches. Cipher compatibility parameters and layouts are version-dependent, so unsupported or ambiguous formats must fail closed.

## Connection path

The existing WCDB account API accepts one account-level key and does not provide a complete per-database key setter for sessions, contacts, messages, media, and social data. Passing one scanned page key directly to that API is not a supported connection strategy.

The Windows scan path therefore prepares a disposable, private mirror:

1. Resolve the current database files and verify the supplied per-database keys against their page-1 HMACs.
2. Open source database and WAL files read-only. Decrypt and authenticate database pages, include the valid committed WAL frames, then encrypt the snapshot with a new transient mirror key.
3. Require `session/session.db` and every discovered message and business-message shard before reporting complete text-history readiness. Media and auxiliary coverage remains a separate status.
4. Open the mirror through the existing account-level WCDB API so current readers and exporters keep their existing behavior.
5. Reject all write operations while connected to the mirror. Remove the mirror after close or any failed open; cancellation and source-file change detection must also remove partial output.

Diagnostics quick/full checks and KeyHealth validation share `verifyHexKeyForPage` and use the same mode order: raw bytes, decoded-hex-byte passphrase, then UTF-8 hex-text passphrase. Stop on the first HMAC match; do not repeat PBKDF2 work in a separate parser. If a stored per-database key is absent, `getVerifiedDbKeyMaterial` may derive it from the account passphrase, but it must authenticate each derived key with that database's page-1 HMAC. A required shard without a verified derived key still keeps the account not-ready. Regression tests cover quick/full agreement, all four fixture keys, an uncovered required shard, and secret-free diagnostics.

This is linear work in the total database and WAL size. It consumes disk bandwidth and CPU, yields between bounded page batches, and can take noticeable time for large accounts. Because WeChat can keep writing while the snapshot is created, the implementation checks source metadata and retries a detected change once; it must report failure rather than claim a consistent snapshot if the source keeps changing. The original database files are never a mirror destination.

## Current verification status (2026-10-04)

The corrected Windows native asset initializes successfully; its approved SHA-256 is `1536606b1b1b2a0dc9de631a7f45504f5d466de0979e50b3f94548ae124993d0`. The local six-byte correction removes the expired-date branches, preserves the host-name guard, and is not an official upstream release.

Existing-account-key proofs open stable private copies of all 7 required databases and exercise the production TXT/JSON exporters. Full source identities distinguish legitimate repeated server IDs from export duplicates. Current counts, transcript checks, package receipts and remaining acceptance gates live in [the verification report](../v1.2-verification.md); avoid treating historical partial/date-filtered counts as current acceptance.

The independent RAM-scan path remains incomplete: stored verified material covers 6/7 required databases and fresh coverage varies with WeChat state. It must fail closed when a required shard is missing. Successful existing-account-key export does not prove complete login-free extraction. The user-requested extraction-method chooser is queued separately.

### Historical synthetic fixture result

Synthetic tests cover per-page rekeying, committed WAL frames, source-file immutability, missing-shard rejection, and tampered-page rejection. A standard SQLCipher synthetic mirror also reopens through the SQLCipher test binding. The bundled WCDB wrapper returned `-3` for the initial minimal synthetic schema; that fixture did not model the real account schema sufficiently. The later native proof on a stable real-data copy supersedes the inference that no native query/export had been demonstrated, with its current acceptance results tracked in the verification report.

### Historical native Windows failures (2026-10-01)

The authorized read-only scan found 7 required session/message databases. Fresh process-memory scanning verified 6 database keys; the persisted-key store contained 18 HMAC-verified keys. Their combined coverage was 5 of 7 required databases, leaving one message shard and one business-message shard without a verified key. The complete account connection and actual export were therefore not attempted. A separate incomplete-coverage export refusal check produced no artifacts.

The packaged v1.2 host and a pinned v1.1 `WeFlow.exe` were each tested privately in `ELECTRON_RUN_AS_NODE` mode against the packaged resource tree. Both returned `InitProtection -101` for all 6 candidate roots before a database was opened. A second bootstrap-only control used a clean private profile, no configured account/database, and set the host working directory to the directory containing its `WeFlow.exe`; both binaries still returned `-101`. This isolates the result from the earlier working-directory difference, but it does not prove that every installed-machine configuration fails.

At that time, the checked v1.1 and current Windows WCDB native/resource files were identical, and no newer official vendor DLL was available in the checked upstream resource tree. Native account queries had not run, so mirror target-key interpretation and SafeStorage key availability were still unknown. The current verification report supersedes those conclusions.

### Expired-DLL no-account controls (2026-10-02)

An unmodified Electron 43.3.0 executable, hardlinked as `WeFlow.exe` in a disposable private directory, also returned native `-101` using the current packaged host/resources, Node IPC and pure-Node mode. The requested account path did not exist; no real database was accessed. This control does not support packaged executable branding as the cause. The private executable links, profile and native logs were removed after the child exited.

The existing standalone Node 24.14.0 host from the removed Tauri installation also returned `-101` with the current packaged host/resources and a nonexistent private account path. This further weakens an Electron-specific runtime explanation. Its disposable executable copy, profile and logs were removed.

GitHub history subsequently identified [WeFlow #1220](https://github.com/hicccc77/WeFlow/issues/1220#issuecomment-5922890213): community analysis reports a native protection time gate expiring on 2026-09-30 at 23:59:59 UTC, returning `-101` before database initialization. The date/stage match is strong but not maintainer-confirmed. Issue closure was by the reporter, not evidence of a fixed official release. No official replacement asset was found; the Oct 3 six-byte source correction is a local fix, not an upstream release. No system clock change or protection bypass was used. See the [verification report](../v1.2-verification.md) for installation status and citations.

New proof runs must emit aggregate counts/statuses only, preserve source DB/WAL fingerprints, and remove all private copies, keys, exports and profiles. They must never restart/focus WeChat or modify its source files.

Keep keys and account-specific details out of source control, logs, test output, and documentation. Test outputs should report pass/fail and aggregate counts only.
