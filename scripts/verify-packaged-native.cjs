'use strict'

// Runs only in a native build job, after electron-builder has produced its
// unpacked app. It checks the copied platform assets and exercises the exact
// Electron-as-Node host shape used by wcdbHostClient, with no WeChat database or
// key: InitProtection + wcdb_init + wcdb_shutdown must all succeed.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { verifyNativeDllAtResourcePath } = require('./verify-native-assets.cjs')

const EXPECTED_ARCH = {
  win32: 'x64',
  darwin: 'arm64',
  linux: 'x64',
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Missing packaged ${label}: ${filePath}`)
  }
  return filePath
}

function elfArchitecture(buffer, label = 'ELF file') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20 || buffer.subarray(0, 4).toString('hex') !== '7f454c46') {
    throw new Error(`${label}: invalid ELF header`)
  }
  if (buffer[4] !== 2 || buffer[5] !== 1) {
    throw new Error(`${label}: expected ELF64 little-endian`)
  }
  const machine = buffer.readUInt16LE(18)
  if (machine !== 62) throw new Error(`${label}: expected x86_64 ELF, machine=0x${machine.toString(16)}`)
  return 'x64'
}

function machOArchitectures(buffer, label = 'Mach-O file') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw new Error(`${label}: truncated Mach-O header`)
  const cpuName = (cpu) => {
    switch (cpu >>> 0) {
      case 0x01000007: return 'x64'
      case 0x0100000c: return 'arm64'
      default: return `cpu-0x${(cpu >>> 0).toString(16)}`
    }
  }

  const magicBE = buffer.readUInt32BE(0)
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
    const is64 = magicBE === 0xcafebabf
    const count = buffer.readUInt32BE(4)
    const stride = is64 ? 32 : 20
    if (count < 1 || count > 32 || 8 + count * stride > buffer.length) {
      throw new Error(`${label}: malformed universal Mach-O header`)
    }
    return Array.from({ length: count }, (_, index) => cpuName(buffer.readUInt32BE(8 + index * stride)))
  }

  // Thin little-endian Mach-O: MH_MAGIC_64 is `cf fa ed fe` on disk.
  const magicLE = buffer.readUInt32LE(0)
  if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) {
    return [cpuName(buffer.readUInt32LE(4))]
  }
  // Thin big-endian variants are uncommon but cheap to recognize.
  if (magicBE === 0xfeedfacf || magicBE === 0xfeedface) {
    return [cpuName(buffer.readUInt32BE(4))]
  }
  throw new Error(`${label}: invalid Mach-O header (magic 0x${magicBE.toString(16)})`)
}

function assertArchitecture(filePath, platform, expectedArch) {
  assertFile(filePath, platform === 'win32' ? 'PE asset' : `${platform} native asset`)
  const buffer = fs.readFileSync(filePath)
  if (platform === 'linux') elfArchitecture(buffer, filePath)
  else if (platform === 'darwin') {
    const architectures = machOArchitectures(buffer, filePath)
    if (!architectures.includes(expectedArch)) {
      throw new Error(`${filePath}: expected ${expectedArch} Mach-O, found ${architectures.join(', ')}`)
    }
  } else {
    if (buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error(`${filePath}: invalid PE header`)
    }
    const peOffset = buffer.readUInt32LE(0x3c)
    if (peOffset + 6 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
      throw new Error(`${filePath}: invalid PE signature`)
    }
    if (buffer.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error(`${filePath}: expected AMD64 PE`)
  }
  return buffer
}

function findMacApp(releaseDir) {
  const visit = (directory, depth) => {
    if (depth > 4) return null
    let entries
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return null }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory() && entry.name === 'Weport.app') return candidate
      if (entry.isDirectory()) {
        const found = visit(candidate, depth + 1)
        if (found) return found
      }
    }
    return null
  }
  return visit(releaseDir, 0)
}

function resolveLayout(releaseDir) {
  const platform = process.platform
  const expectedArch = EXPECTED_ARCH[platform]
  if (!expectedArch) throw new Error(`Unsupported native smoke platform: ${platform}`)
  if (process.arch !== expectedArch) {
    throw new Error(`Native build runner must be ${expectedArch}; this runner is ${process.arch}`)
  }

  let appOutDir
  let appExe
  let appResources
  let appContents
  if (platform === 'darwin') {
    const appBundle = findMacApp(releaseDir)
    if (!appBundle) throw new Error(`No Weport.app found under ${releaseDir}`)
    appContents = path.join(appBundle, 'Contents')
    appOutDir = path.dirname(appBundle)
    appExe = path.join(appContents, 'MacOS', 'Weport')
    appResources = path.join(appContents, 'Resources')
  } else {
    appOutDir = path.join(releaseDir, platform === 'win32' ? 'win-unpacked' : 'linux-unpacked')
    if (platform === 'win32') {
      appExe = path.join(appOutDir, 'Weport.exe')
    } else {
      const linuxCandidates = ['Weport', 'weport'].map((name) => path.join(appOutDir, name))
      appExe = linuxCandidates.find((candidate) => fs.existsSync(candidate)) || linuxCandidates[0]
    }
    appResources = path.join(appOutDir, 'resources')
  }

  assertFile(appExe, 'application executable')
  assertFile(path.join(appResources, 'host', 'wcdbHost.js'), 'WCDB host script')
  assertFile(path.join(appResources, 'host', 'libs', 'koffi', 'package.json'), 'packaged koffi')

  const nativePackage = `koffi-${platform}-${expectedArch}`
  const nativePackageDir = path.join(appResources, 'host', 'libs', '@koromix', nativePackage)
  assertFile(path.join(nativePackageDir, 'package.json'), `packaged ${nativePackage}`)
  const addonPaths = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.isFile() && entry.name.endsWith('.node')) addonPaths.push(fullPath)
    }
  }
  walk(nativePackageDir)
  if (addonPaths.length === 0) throw new Error(`No native koffi addon found in ${nativePackageDir}`)
  assertArchitecture(addonPaths[0], platform, expectedArch)

  const payloadRoot = path.join(appResources, 'resources')
  const platformDataDir = platform === 'darwin' ? 'macos/universal' : `${platform}/${expectedArch}`
  const wcdbDir = path.join(payloadRoot, 'wcdb', platformDataDir)
  const dllName = platform === 'win32' ? 'wcdb_api.dll' : platform === 'darwin' ? 'libwcdb_api.dylib' : 'libwcdb_api.so'
  const wcdbDll = path.join(wcdbDir, dllName)
  assertArchitecture(wcdbDll, platform, expectedArch)

  const platformAssets = []
  if (platform === 'darwin') {
    platformAssets.push(
      { file: path.join(wcdbDir, 'libWCDB.dylib'), executable: false },
      { file: path.join(payloadRoot, 'key', 'macos', 'universal', 'xkey_helper'), executable: true },
      { file: path.join(payloadRoot, 'key', 'macos', 'universal', 'xkey_helper_macos'), executable: true },
      { file: path.join(payloadRoot, 'key', 'macos', 'universal', 'image_scan_helper'), executable: true },
      { file: path.join(payloadRoot, 'key', 'macos', 'universal', 'libwx_key.dylib'), executable: false },
      { file: path.join(payloadRoot, 'wedecrypt', 'macos', 'arm64', 'weflow-image-native-macos-arm64.node'), executable: false },
    )
  } else if (platform === 'linux') {
    platformAssets.push(
      { file: path.join(payloadRoot, 'key', 'linux', 'x64', 'xkey_helper_linux'), executable: true },
      { file: path.join(payloadRoot, 'wedecrypt', 'linux', 'x64', 'weflow-image-native-linux-x64.node'), executable: false },
    )
  } else if (platform === 'win32') {
    platformAssets.push(
      { file: path.join(wcdbDir, 'WCDB.dll'), executable: false },
      { file: path.join(wcdbDir, 'SDL2.dll'), executable: false },
      { file: path.join(payloadRoot, 'key', 'win32', 'x64', 'wx_key.dll'), executable: false },
      { file: path.join(payloadRoot, 'wedecrypt', 'win32', 'x64', 'weflow-image-native-win32-x64.node'), executable: false },
      ...['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'].map((name) => ({
        file: path.join(payloadRoot, 'runtime', 'win32', name),
        executable: false,
      })),
    )
  }

  for (const asset of platformAssets) {
    assertArchitecture(asset.file, platform, expectedArch)
    if (asset.executable && (fs.statSync(asset.file).mode & 0o111) === 0) {
      throw new Error(`Required native helper is not executable in the package: ${asset.file}`)
    }
  }

  if (platform === 'win32') {
    const verified = verifyNativeDllAtResourcePath(appResources)
    console.log(`[packaged-native] verified packaged WCDB SHA-256 ${verified.sha256}`)
  }

  return { platform, expectedArch, appOutDir, appExe, appContents, appResources, payloadRoot, wcdbDir, wcdbDll }
}

function createHostExecutable(layout, tempRoot) {
  const hostName = layout.platform === 'win32' ? 'WeFlow.exe' : 'WeFlow'
  if (layout.platform === 'win32') {
    const hostExe = path.join(layout.appOutDir, hostName)
    if (fs.existsSync(hostExe)) throw new Error(`Refusing to overwrite unexpected host file: ${hostExe}`)
    try {
      fs.linkSync(layout.appExe, hostExe)
    } catch {
      fs.copyFileSync(layout.appExe, hostExe)
      fs.chmodSync(hostExe, 0o755)
    }
    return { hostExe, cleanup: () => fs.unlinkSync(hostExe) }
  }

  if (layout.platform === 'darwin') {
    const contents = path.join(tempRoot, 'Contents')
    const macOs = path.join(contents, 'MacOS')
    fs.mkdirSync(macOs, { recursive: true })
    const hostExe = path.join(macOs, hostName)
    fs.copyFileSync(layout.appExe, hostExe)
    fs.chmodSync(hostExe, 0o755)
    const frameworks = path.join(contents, 'Frameworks')
    fs.symlinkSync(path.join(layout.appContents, 'Frameworks'), frameworks, 'dir')
    const infoPlist = path.join(layout.appContents, 'Info.plist')
    if (fs.existsSync(infoPlist)) fs.copyFileSync(infoPlist, path.join(contents, 'Info.plist'))
    return { hostExe, cleanup: () => {} }
  }

  const hostExe = path.join(tempRoot, hostName)
  fs.copyFileSync(layout.appExe, hostExe)
  fs.chmodSync(hostExe, 0o755)
  return { hostExe, cleanup: () => {} }
}

function smokeSource() {
  return String.raw`'use strict'
const path = require('node:path')
const koffi = require('koffi')
const expected = process.platform === 'win32' ? 'WeFlow.exe' : 'WeFlow'
if (path.basename(process.execPath).toLowerCase() !== expected.toLowerCase()) {
  throw new Error('WCDB host executable name mismatch: ' + process.execPath)
}
const dllPath = process.env.WEPORT_NATIVE_SMOKE_DLL
const dllDir = path.dirname(dllPath)
const resourcesPath = process.env.WEPORT_RESOURCES_PATH
const resourcePaths = [
  dllDir,
  path.dirname(dllDir),
  process.resourcesPath,
  process.resourcesPath && path.join(process.resourcesPath, 'resources'),
  resourcesPath,
  process.env.WCDB_RESOURCES_PATH,
  path.join(process.cwd(), 'resources'),
].filter((candidate, index, values) => candidate && values.indexOf(candidate) === index)
const lib = koffi.load(dllPath)
const protect = lib.func('int32 InitProtection(const char* resourcePath)')
let protectionCode = -1
let protectionOk = false
for (const resourcePath of resourcePaths) {
  protectionCode = Number(protect(resourcePath))
  console.log('InitProtection=' + protectionCode + ' path=' + resourcePath)
  if (protectionCode === 0) {
    protectionOk = true
    break
  }
}
if (!protectionOk) process.exit(21)
const init = lib.func('int32 wcdb_init()')
const shutdown = lib.func('int32 wcdb_shutdown()')
const initCode = Number(init())
console.log('wcdb_init=' + initCode)
if (initCode !== 0) process.exit(22)
const shutdownCode = Number(shutdown())
console.log('wcdb_shutdown=' + shutdownCode)
if (shutdownCode !== 0) process.exit(23)
console.log('PASS: packaged native host initialized without opening a database or using a key')
`
}

function prependPath(currentValue, paths, delimiter) {
  const parts = paths.filter((candidate) => candidate && fs.existsSync(candidate))
  if (currentValue) parts.push(currentValue)
  return [...new Set(parts)].join(delimiter)
}

function runSmoke(layout, hostExe, tempRoot) {
  const hostLibs = path.join(layout.appResources, 'host', 'libs')
  const testProfile = path.join(tempRoot, 'private-profile')
  fs.mkdirSync(testProfile, { recursive: true })
  const testScript = path.join(tempRoot, 'native-init-smoke.cjs')
  fs.writeFileSync(testScript, smokeSource(), { encoding: 'utf8', mode: 0o600 })

  const executableDir = path.dirname(hostExe)
  const originExeDir = path.dirname(layout.appExe)
  const runtimeDir = path.join(layout.payloadRoot, 'runtime', layout.platform)
  const libraryPaths = [
    executableDir,
    originExeDir,
    layout.wcdbDir,
    runtimeDir,
    path.dirname(layout.wcdbDll),
  ]
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    WEFLOW_WORKER: '1',
    WEFLOW_USER_DATA_PATH: testProfile,
    WEFLOW_CONFIG_CWD: testProfile,
    WEPORT_USER_DATA_PATH: testProfile,
    WEPORT_RESOURCES_PATH: layout.payloadRoot,
    WCDB_RESOURCES_PATH: layout.payloadRoot,
    WEPORT_NATIVE_SMOKE_DLL: layout.wcdbDll,
    NODE_PATH: hostLibs,
    PATH: prependPath(process.env.PATH, libraryPaths, path.delimiter),
    TMPDIR: tempRoot,
  }
  if (layout.platform === 'linux') {
    env.LD_LIBRARY_PATH = prependPath(process.env.LD_LIBRARY_PATH, libraryPaths, path.delimiter)
  }

  const result = spawnSync(hostExe, [testScript], {
    cwd: tempRoot,
    env,
    encoding: 'utf8',
    timeout: 45_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  })
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  if (output) process.stdout.write(`${output}\n`)
  if (result.error) throw new Error(`Native host launch failed: ${result.error.message}`)
  if (result.signal) throw new Error(`Native host terminated by signal ${result.signal}`)
  if (result.status !== 0) throw new Error(`Packaged native host smoke exited ${result.status}`)
}

function main(argv = process.argv.slice(2)) {
  const releaseDir = path.resolve(argv[0] || path.join(__dirname, '..', 'release'))
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-packaged-native-'))
  let host = null
  let failure = null
  try {
    const layout = resolveLayout(releaseDir)
    console.log(`[packaged-native] platform=${layout.platform} arch=${layout.expectedArch} resources=${layout.appResources}`)
    host = createHostExecutable(layout, tempRoot)
    runSmoke(layout, host.hostExe, tempRoot)
  } catch (error) {
    failure = error
  } finally {
    try { host?.cleanup() } catch (error) {
      failure ||= new Error(`failed to remove temporary host link: ${String(error)}`)
    }
    try {
      const resolved = fs.realpathSync(tempRoot)
      const parent = fs.realpathSync(os.tmpdir())
      if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('weport-packaged-native-')) {
        throw new Error('Temporary profile escaped its expected directory')
      }
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 })
    } catch (error) {
      failure ||= new Error(`failed to clean temporary profile: ${String(error)}`)
    }
  }
  if (failure) {
    console.error(`[packaged-native] FAIL: ${failure && failure.message ? failure.message : failure}`)
    return 1
  }
  console.log('[packaged-native] PASS')
  return 0
}

if (require.main === module) process.exitCode = main()

module.exports = {
  EXPECTED_ARCH,
  assertArchitecture,
  elfArchitecture,
  machOArchitectures,
  resolveLayout,
  smokeSource,
}
