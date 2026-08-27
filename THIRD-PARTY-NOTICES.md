# Third-Party Notices

Weport is an adapted work distributed under the Creative Commons
Attribution-NonCommercial-ShareAlike 4.0 International license. The root
`LICENSE` and `NOTICE.md` apply to the combined WeFlow/Weport work except where
a component is identified below as carrying its own license.

## WeFlow — cc / hicccc77 and contributors (CC BY-NC-SA 4.0)

- Project: https://github.com/hicccc77/WeFlow
- Historical source/license:
  https://github.com/hicccc77/WeFlow/tree/fa4edebed63843f6383233a678bf27f327445c79
- Snapshot used by Weport:
  https://github.com/Panther114/WeFlow/commit/642b0e21c62b5c93a3785bd2c6f2349d3470e47a

Weport incorporates and modifies substantial portions of WeFlow, including:

- Electron database, key, media, export, notification, SNS, analytics and
  supporting service code;
- notification-window and Chromium LiquidGlass fallback code;
- native helpers and libraries imported through `resources/key`,
  `resources/wedecrypt`, `resources/welive` and the custom `wcdb_api` wrapper;
- the macOS application icon and the WeFlow media-decoding WASM assets.

The work has been renamed and materially modified. `NOTICE.md` describes the
adaptation and identifies both the original authors and Weport contributors.

## @hicccc77/electron-liquid-glass (MIT)

- Project: https://github.com/hicccc77/electron-liquid-glass
- Copyright (c) 2026 hicccc77
- Packaged dependency: `node_modules/@hicccc77/electron-liquid-glass`
- License copy: `LICENSES/electron-liquid-glass-MIT.txt`

This npm dependency is independently MIT-licensed. Its use is separate from the
CC-licensed LiquidGlass fallback source adapted from WeFlow.

## Tencent WCDB and bundled components

- Project: https://github.com/Tencent/wcdb
- Copyright (c) 2017 THL A29 Limited, a Tencent company
- Primary license: BSD 3-Clause; WCDB also documents bundled Apache-2.0,
  OpenSSL/SSLeay, ICU, SQLite/public-domain and SQLCipher components.
- Affected artifacts include `WCDB.dll`, `libWCDB.dylib` and WCDB copies inside
  `resources/welive`.
- Complete upstream notice: `LICENSES/WCDB.txt`

The custom `wcdb_api` libraries are WeFlow-derived wrappers and are covered by
the WeFlow attribution above; they should not be represented as Tencent WCDB
official binaries.

## SDL2 (zlib license)

- Project: https://github.com/libsdl-org/SDL
- Copyright (c) 1997-2026 Sam Lantinga
- Artifact: `resources/wcdb/win32/x64/SDL2.dll`
- License copy: `LICENSES/SDL-zlib.txt`

## Koffi (MIT)

- Project: https://github.com/Koromix/koffi
- Copyright (c) 2026 Niels Martignene
- Packaged copies: the `koffi` npm dependency and `resources/host/libs/koffi`
- License copy: `LICENSES/koffi-MIT.txt`

## Microsoft Visual C++ runtime

`resources/runtime/win32` contains Microsoft Visual C++ runtime files
(`msvcp140*.dll` and `vcruntime140*.dll`). They are Microsoft redistributable
components, not CC-licensed Weport or WeFlow code. Redistribution is subject to
the applicable Microsoft Visual Studio license terms:
https://visualstudio.microsoft.com/license-terms/

## Other npm dependencies

Other production dependencies retain their own license metadata and license
files in their packaged modules. Exact resolved packages and declared SPDX
identifiers are recorded in `package-lock.json`. This project license does not
replace or narrow those third-party licenses.
