#!/usr/bin/env bash
# verify-mac-pack.sh — macOS packaging acceptance test (issue #18).
#
# Runs on the macOS CI runner AFTER `npm run build:mac` and BEFORE publishing.
# Fails non-zero on any problem so a broken pack can never reach a release.
# Also reused by .github/workflows/verify-mac-packaging.yml (verify-only, no publish).
#
# Usage: bash scripts/verify-mac-pack.sh [release-dir]
#   release-dir defaults to ./release (electron-builder `directories.output`).
#
# Checks:
#   1. At least one Weport.app exists under <release-dir> (unpacked build output).
#   2. `codesign --verify --deep --strict` passes on the unpacked app.
#   3. The shipped .zip round-trips (unzip -t + unzip to temp dir) and the
#      unzipped copy ALSO passes `codesign --verify --deep --strict`
#      (catches ditto/zip-induced signature damage like issue #18).
#   4. Every shipped libwcdb_api.dylib references @loader_path/libWCDB.dylib
#      and no longer references @rpath/WCDB.framework (after-pack.cjs contract).
#   5. No *.framework bundles remain under Contents/Resources
#      (a malformed nested framework fails --deep --strict, see issue #18).
#   6. The app is actually signed (not silently skipped): `codesign -dvv`
#      must report an Authority (Developer ID) or an ad-hoc signature —
#      never "code object is not signed at all".
set -euo pipefail

RELEASE_DIR="${1:-release}"
ROUNDTRIP_DIR=""
cleanup_roundtrip() {
  if [ -n "${ROUNDTRIP_DIR:-}" ] && [ -d "$ROUNDTRIP_DIR" ]; then
    rm -rf "$ROUNDTRIP_DIR"
  fi
}
trap cleanup_roundtrip EXIT
FAILURES=0

fail() {
  echo "::error::$1"
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "✅ $1"
}

echo "=== verify-mac-pack: release dir = $RELEASE_DIR ==="

# --- 1. locate unpacked app -------------------------------------------------
APP_PATH="$(find "$RELEASE_DIR" -maxdepth 3 -name 'Weport.app' -type d | head -n 1 || true)"
if [ -z "${APP_PATH:-}" ]; then
  fail "no Weport.app found under $RELEASE_DIR (expected unpacked output of electron-builder --mac)"
  echo "--- release dir listing ---"
  ls -la "$RELEASE_DIR" || true
  exit 1
fi
echo "app: $APP_PATH"

# --- 2. strict verify on the unpacked app ------------------------------------
if codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1; then
  pass "codesign --verify --deep --strict passes on unpacked app"
else
  fail "codesign --verify --deep --strict FAILED on unpacked app (issue #18)"
fi

# --- 3. zip round-trip --------------------------------------------------------
ZIP_PATH="$(ls -t "$RELEASE_DIR"/Weport-*.zip 2>/dev/null | head -n 1 || true)"
if [ -z "${ZIP_PATH:-}" ]; then
  fail "no Weport-*.zip found under $RELEASE_DIR"
else
  echo "zip: $ZIP_PATH"
  if unzip -t "$ZIP_PATH" >/dev/null 2>&1; then
    pass "zip integrity ok (unzip -t)"
  else
    fail "zip integrity check failed (unzip -t)"
  fi
  ROUNDTRIP_DIR="$(mktemp -d)"
  unzip -q "$ZIP_PATH" -d "$ROUNDTRIP_DIR"
  ROUNDTRIP_APP="$(find "$ROUNDTRIP_DIR" -maxdepth 3 -name 'Weport.app' -type d | head -n 1 || true)"
  if [ -z "${ROUNDTRIP_APP:-}" ]; then
    fail "unzipped archive contains no Weport.app"
  elif codesign --verify --deep --strict --verbose=2 "$ROUNDTRIP_APP" 2>&1; then
    pass "codesign --verify --deep --strict passes after zip round-trip"
  else
    fail "codesign --verify --deep --strict FAILED after zip round-trip (issue #18)"
  fi
fi

# --- 4. WCDB dylib linkage (after-pack.cjs contract) --------------------------
DYLIBS="$(find "$APP_PATH" -name 'libwcdb_api.dylib' || true)"
if [ -z "$DYLIBS" ]; then
  fail "no libwcdb_api.dylib found inside $APP_PATH"
else
  while IFS= read -r dylib; do
    echo "--- otool -L $dylib"
    otool -L "$dylib" || { fail "otool -L failed on $dylib"; continue; }
    if otool -L "$dylib" | grep -q '@rpath/WCDB.framework'; then
      fail "stale @rpath/WCDB.framework reference remains in $dylib (after-pack.cjs did not rewrite it)"
    else
      pass "no stale framework reference in $dylib"
    fi
    if otool -L "$dylib" | grep -q '@loader_path/libWCDB.dylib'; then
      pass "sibling libWCDB.dylib reference present in $dylib"
    else
      fail "missing @loader_path/libWCDB.dylib reference in $dylib"
    fi
    if [ -f "$(dirname "$dylib")/libWCDB.dylib" ]; then
      pass "sibling libWCDB.dylib exists next to $dylib"
    else
      fail "sibling libWCDB.dylib MISSING next to $dylib"
    fi
  done <<< "$DYLIBS"
fi

# --- 5. no nested framework bundles -------------------------------------------
FRAMEWORKS="$(find "$APP_PATH/Contents/Resources" -name '*.framework' -maxdepth 6 || true)"
if [ -n "$FRAMEWORKS" ]; then
  fail "nested *.framework bundle(s) shipped under Contents/Resources (fail --deep --strict): $FRAMEWORKS"
else
  pass "no nested *.framework under Contents/Resources"
fi

# --- 6. signing was not silently skipped ---------------------------------------
# electron-builder logs "skipped macOS application code signing" and continues
# when no identity is configured (the v0.9.11 failure mode). An unsigned bundle
# must fail this gate even if --verify above were ever loosened.
echo "--- codesign -dvv $APP_PATH ---"
SIGN_INFO="$(codesign -dvv "$APP_PATH" 2>&1 || true)"
echo "$SIGN_INFO"
if echo "$SIGN_INFO" | grep -q 'code object is not signed at all'; then
  fail "app is NOT signed at all (signing was skipped — issue #18 root cause)"
elif echo "$SIGN_INFO" | grep -qE 'Authority=|Signature=adhoc'; then
  pass "app carries a signature (Authority or ad-hoc)"
else
  fail "could not confirm any signature on app; codesign output above"
fi

echo "=== verify-mac-pack: $FAILURES failure(s) ==="
exit $FAILURES
