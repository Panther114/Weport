# Legal provenance record

This file records the source and license decisions for material incorporated
into Weport. It is an engineering provenance record, not legal advice.

## WeFlow adaptation

Weport is substantially based on WeFlow by cc (`hicccc77`) and the WeFlow
contributors. The source snapshot used for comparison is commit
`642b0e21c62b5c93a3785bd2c6f2349d3470e47a` in `Panther114/WeFlow`, which
retains WeFlow's CC BY-NC-SA 4.0 license and upstream author metadata.

Weport commit `c2c75dcb2882f18b2f4268fef492b54e85865018` imported the Electron
implementation and native resources on 2026-08-02. Commit
`0cad0aefa1e926012a751f3ab5ba6d5e829af2b3` replaced the inherited CC license
with MIT on 2026-08-04 without a permission record. On 2026-08-27, the project
restored CC BY-NC-SA 4.0 and added explicit attribution and packaged notices.

## Verified file relationship

A same-path SHA-256 comparison against the preserved WeFlow snapshot found:

| Area | Same-path files | Byte-identical files | Treatment |
| --- | ---: | ---: | --- |
| `resources/` | 41 | 41 | WeFlow attribution plus component licenses |
| `electron/` | 81 | 47 | WeFlow adaptation; modified files remain attributed |
| `src/` | 24 | 10 | WeFlow adaptation; modified files remain attributed |

The comparison establishes provenance, not ownership of every embedded binary.

## Native resource classification

| Paths | Recorded origin/license |
| --- | --- |
| `resources/key`, `resources/wedecrypt`, `resources/welive`, `wcdb_api*` | Imported from WeFlow; CC BY-NC-SA attribution to WeFlow to the extent its authors hold the relevant rights |
| `WCDB.dll`, `libWCDB.dylib` | Tencent WCDB; see `LICENSES/WCDB.txt` |
| `SDL2.dll` | SDL zlib license; see `LICENSES/SDL-zlib.txt` |
| `msvcp140*.dll`, `vcruntime140*.dll` | Microsoft Visual C++ redistributable terms |
| `@hicccc77/electron-liquid-glass` | MIT; see `LICENSES/electron-liquid-glass-MIT.txt` |
| `koffi` | MIT; see `LICENSES/koffi-MIT.txt` |

## Remaining provenance limitations

- WeFlow did not provide reproducible source/build records for every custom
  helper binary. Attribution and restoration of the inherited license do not
  independently prove that WeFlow had every right necessary to redistribute
  those binaries.
- Microsoft runtime redistribution depends on the applicable Visual Studio
  license held by the person producing the release.
- Any future request to distribute the combined project under MIT or for a
  commercial purpose requires a separate written grant from every relevant
  rights holder or removal/reimplementation of the CC-licensed material.

Future imports must record the upstream URL, exact commit or released version,
license, files incorporated, modifications made, and any binary build source.

## Windows x64 expiry adaptation (2026-10-03)

- Artifact: `resources/wcdb/win32/x64/wcdb_api.dll`, inherited from WeFlow;
  original SHA-256 `6397760da70de8062829fbe6a2ec01cf0616d6f2b334e6fe54873898f38f7ad7`.
  The original is recorded in Weport commit `3b9e2afd341f0eef56d4be9dafca25c8fe8be533`.
- [Issues #30](https://github.com/Panther114/Weport/issues/30) and
  [#31](https://github.com/Panther114/Weport/issues/31) identify the October 1 expiry.
  Analysis by xkitme and [fork commit cfd3962](https://github.com/xkitme/Weport/commit/cfd3962d5036e009d01315bea0239dce0f83fd26)
  informed the local adaptation. That fork's binary is not shipped: it extends
  one cutoff to 2038 and replaces a later failure return with success.
- The local modification changes six bytes at file offsets 527813 and
  951767–951772. Only the two date-dependent branches in `InitProtection` and
  `wcdb_init` take their existing valid-date paths unconditionally. Remaining
  code, PE layout, 417 imports and 112 exports are byte-for-byte unchanged.
  Modified SHA-256: `1536606b1b1b2a0dc9de631a7f45504f5d466de0979e50b3f94548ae124993d0`.
- `scripts/repair-native-assets.cjs --input <original.dll> --output <fixed.dll>`
  reproduces this binary adaptation offline from the exact original hash.
  It is never invoked at app startup. `verify-native-assets.cjs` rejects the
  expired original, the 2038 extension and unreviewed mutations before packaging
  and checks the copied Windows package in `afterPack`.
- The inherited WeFlow attribution and CC BY-NC-SA treatment above remain.
  This reproduces the adaptation, not the original native compilation; its
  missing source/build records and unsigned provenance limitations remain.
