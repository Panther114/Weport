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
