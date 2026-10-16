#!/usr/bin/env bash
# Compile the wrapper from its source; never rewrite a prebuilt Mach-O minimum.
set -euo pipefail
test "$(uname -s)" = Darwin
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/resources/key/macos/source"
OUTPUT="$ROOT/resources/key/macos/universal/image_scan_helper"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
xcrun clang -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=15.0 \
  "$SOURCE/image_scan_helper.c" -o "$TEMP/image_scan_helper"
codesign --force --sign - --entitlements "$SOURCE/image_scan_entitlements.plist" "$TEMP/image_scan_helper"
codesign --verify --strict "$TEMP/image_scan_helper"
# Its argument validation must run on this host without touching a target process.
set +e
RESULT="$("$TEMP/image_scan_helper" 2>/dev/null)"
STATUS=$?
set -e
test "$STATUS" = 1
test "$RESULT" = '{"success":false,"error":"invalid arguments"}'
chmod +x "$TEMP/image_scan_helper"
mv "$TEMP/image_scan_helper" "$OUTPUT"
