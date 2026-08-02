const { execFileSync } = require('child_process')
const { existsSync, readdirSync, rmSync, statSync } = require('fs')
const { join } = require('path')

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
  const linkedLibraries = execFileSync('otool', ['-L', dylibPath], {
    encoding: 'utf8',
  })

  if (!linkedLibraries.includes(WCDB_FRAMEWORK_ID)) {
    return false
  }

  execFileSync('install_name_tool', [
    '-change',
    WCDB_FRAMEWORK_ID,
    WCDB_DYLIB_ID,
    dylibPath,
  ])

  return true
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const resourcesDir = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
  const dylibs = walk(resourcesDir)

  for (const dylibPath of dylibs) {
    const patched = patchWcdbDylib(dylibPath)
    if (patched) {
      console.log(`[afterPack] Rewired WCDB dependency for ${dylibPath}`)
    }
  }

  const frameworkRoots = [
    join(resourcesDir, 'resources', 'welive', 'macos', 'arm64', 'resources', 'macos', 'universal', 'WCDB.framework'),
    join(resourcesDir, 'resources', 'welive', 'macos', 'x64', 'resources', 'macos', 'universal', 'WCDB.framework'),
  ]

  for (const frameworkPath of frameworkRoots) {
    if (existsSync(frameworkPath)) {
      rmSync(frameworkPath, { recursive: true, force: true })
      console.log(`[afterPack] Removed invalid framework bundle ${frameworkPath}`)
    }
  }
}
