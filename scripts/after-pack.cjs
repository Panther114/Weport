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

module.exports = async function afterPack(context) {
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
