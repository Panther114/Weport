const { execFileSync } = require('child_process')
const { existsSync, readdirSync, rmSync, statSync } = require('fs')
const { dirname, join } = require('path')

// libwcdb_api.dylib is built against the private WCDB framework name used by
// WeFlow.  Weport ships the companion libWCDB.dylib next to it instead of the
// framework bundle, so rewrite that dependency after electron-builder has
// assembled the app.  This is intentionally a packaging-time operation: the
// source binaries remain untouched and the hook is a no-op on non-macOS builds.
const WCDB_FRAMEWORK_ID = '@rpath/WCDB.framework/Versions/2.1.15/WCDB'
const WCDB_DYLIB_ID = '@loader_path/libWCDB.dylib'

function walk(dir, matches = []) {
  if (!existsSync(dir)) return matches

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      walk(fullPath, matches)
    } else if (entry === 'libwcdb_api.dylib') {
      matches.push(fullPath)
    }
  }

  return matches
}

/**
 * `install_name_tool` REWRITES THE MACH-O, WHICH INVALIDATES THE EXISTING SIGNATURE.
 *
 * Apple's own macOS 11 release notes name this trap (quoted in electron-builder's
 * ad-hoc-signing PR #9007): the toolchain signs binaries at link time, and that
 * signature "doesn't cover any resource other than the executable" — so
 * "if you use a custom workflow involving tools that modify a binary after linking
 * (e.g. strip or install_name_tool) you might need to manually call codesign(1) as
 * an additional build phase to properly ad-hoc sign your binary."
 *
 * This hook runs at electron-builder's `afterPack`, which is emitted BEFORE
 * `doSignAfterPack` (app-builder-lib/out/macPackager.js:209 → :217), and the signing
 * step walks every file under `Contents/` (osx-sign sign.js:172, 189) — so on a build
 * that really signs, our rewrite is covered and this re-sign is redundant.
 *
 * It is NOT redundant when signing is skipped, which is exactly what shipped
 * v0.9.11 (issue #18): `build.mac` had no `identity` and CI set
 * CSC_IDENTITY_AUTO_DISCOVERY=false, so `findIdentity()` returned null
 * (app-builder-lib/out/codeSign/macCodeSign.js:261-269), `sign()` returned early
 * (macPackager.js:304-306), and the app went out unsigned — while this hook had
 * already invalidated the signature of a shipped dylib. Re-signing here means the
 * artifact is coherent whether or not the later signing step runs.
 */
function resignAdHocAfterRewrite(dylibPath) {
  try {
    execFileSync('codesign', ['--force', '--sign', '-', dylibPath], { stdio: 'pipe' })
    execFileSync('codesign', ['--verify', '--strict', dylibPath], { stdio: 'pipe' })
    console.log(`[afterPack] re-signed (ad-hoc) ${dylibPath} after install_name_tool rewrite`)
    return true
  } catch (error) {
    // Not fatal on its own: electron-builder's own signing step re-signs every file
    // under Contents/ afterwards. Reported loudly because if that step is also
    // skipped, this dylib carries an invalid signature into the shipped artifact.
    console.warn(
      `[afterPack] could not re-sign ${dylibPath} after install_name_tool rewrite: ` +
        `${error && error.message ? error.message : error}`,
    )
    return false
  }
}

function patchWcdbDylib(dylibPath) {
  const linkedLibraries = execFileSync('otool', ['-L', dylibPath], { encoding: 'utf8' })
  const needsPatch = linkedLibraries.includes(WCDB_FRAMEWORK_ID)
  if (needsPatch) {
    execFileSync('install_name_tool', [
      '-change',
      WCDB_FRAMEWORK_ID,
      WCDB_DYLIB_ID,
      dylibPath,
    ])
    resignAdHocAfterRewrite(dylibPath)
  }

  const rewrittenLibraries = execFileSync('otool', ['-L', dylibPath], { encoding: 'utf8' })
  if (rewrittenLibraries.includes(WCDB_FRAMEWORK_ID)) {
    throw new Error(`[afterPack] WCDB framework dependency remains in ${dylibPath}`)
  }
  if (!rewrittenLibraries.includes(WCDB_DYLIB_ID)) {
    throw new Error(`[afterPack] ${dylibPath} does not reference ${WCDB_DYLIB_ID}`)
  }
  const siblingDylib = join(dirname(dylibPath), 'libWCDB.dylib')
  if (!existsSync(siblingDylib)) {
    throw new Error(`[afterPack] Missing sibling WCDB runtime ${siblingDylib}`)
  }
  return needsPatch
}

/**
 * Windows: prune Electron runtime binaries Weport never loads.
 *
 * `dxcompiler.dll` + `dxil.dll` are DXC — the DirectX Shader Compiler, used by
 * **WebGPU (Dawn)** and D3D12 shader compilation. Weport uses neither: its GPU
 * path is ANGLE/D3D11 (which compiles through `d3dcompiler_47.dll` — kept), it
 * never enables WebGPU, and it does not force Vulkan. Together they are
 * **25.8 MB** of the shipped runtime (24.4 + 1.4) for a code path that never runs.
 *
 * Deliberately NOT pruned, and why each one stays:
 *  - `d3dcompiler_47.dll` — D3D11 shader compilation; removing it costs hardware
 *    acceleration, which is the single biggest CPU win this project has.
 *  - `ffmpeg.dll` — `<video>` decode; the video wallpaper depends on it.
 *  - `vk_swiftshader.dll` — the software-WebGL fallback used when there is no GPU.
 *  - `LICENSES.chromium.html` (19.4 MB) — licence compliance, not ours to drop.
 *
 * Verified after pruning: the window renders, the glass refracts, the video
 * background plays and the GPU process stays hardware-accelerated.
 */
const WINDOWS_UNUSED_RUNTIME = ['dxcompiler.dll', 'dxil.dll']

function pruneWindowsRuntime(appOutDir) {
  let removedBytes = 0
  for (const name of WINDOWS_UNUSED_RUNTIME) {
    const target = join(appOutDir, name)
    if (!existsSync(target)) continue
    try {
      removedBytes += statSync(target).size
      rmSync(target, { force: true })
      console.log(`[afterPack] removed unused runtime ${name}`)
    } catch (error) {
      console.warn(`[afterPack] could not remove ${target}: ${error && error.message ? error.message : error}`)
    }
  }
  if (removedBytes > 0) {
    console.log(`[afterPack] pruned ${(removedBytes / 1024 / 1024).toFixed(1)} MB of unused Electron runtime`)
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    pruneWindowsRuntime(context.appOutDir)
    return
  }
  if (context.electronPlatformName !== 'darwin') return

  const resourcesDir = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
  )

  const dylibs = walk(resourcesDir)
  if (dylibs.length === 0) {
    throw new Error(`[afterPack] No libwcdb_api.dylib found under ${resourcesDir}`)
  }

  for (const dylibPath of dylibs) {
    if (patchWcdbDylib(dylibPath)) {
      console.log(`[afterPack] Rewired WCDB dependency for ${dylibPath}`)
    }
  }

  // Older resource layouts could include a nested framework copy.  Once the
  // dependency points at the sibling dylib it is dead weight and can contain
  // an invalid nested bundle, so remove only those known paths if present.
  const frameworkRoots = [
    join(resourcesDir, 'resources', 'welive', 'macos', 'arm64', 'resources', 'macos', 'universal', 'WCDB.framework'),
    join(resourcesDir, 'resources', 'welive', 'macos', 'x64', 'resources', 'macos', 'universal', 'WCDB.framework'),
  ]
  for (const frameworkPath of frameworkRoots) {
    if (!existsSync(frameworkPath)) continue
    rmSync(frameworkPath, { recursive: true, force: true })
    console.log(`[afterPack] Removed invalid framework bundle ${frameworkPath}`)
  }
}
