// Paired Electron v1.1 vs current V1.2 performance run. All runs use fresh profiles,
// no copied user data, off-screen windows, and synthetic glass pixels.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const root = resolve(process.cwd())
const v11Exe = join(root, '.ui-probe', 'v110', 'Weport.exe')
const currentExe = join(root, 'release', 'win-unpacked', 'Weport.exe')
const uiBench = join(root, 'scripts', 'bench-perf.mjs')
const backgroundBench = join(root, 'scripts', 'bench-background.mjs')
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}
const requested = Math.max(1, Math.min(3, Number(arg('--repeats') || 2)))
const prepareOnly = process.argv.includes('--prepare-v11-only')
const v11Installer = arg('--v11-installer') ? resolve(arg('--v11-installer')) : null
const v12Installer = arg('--v12-installer') ? resolve(arg('--v12-installer')) : null
if (!existsSync(v11Exe)) throw new Error(`Pinned v1.1 baseline is missing: ${v11Exe}`)
if (!prepareOnly && !existsSync(currentExe)) throw new Error(`Current unpacked Electron build is missing: ${currentExe}; run npm run build:dir first`)

const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputDir = join(root, '.ui-probe', `v12-ab-${runId}`)
mkdirSync(outputDir, { recursive: true })
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const registryGuardMarker = '/* WEPORT_PROBE_OFFSCREEN_REGISTRY_WRITE_GUARD */'

function registryWriteVerb(file, args) {
  const commandName = (value) => String(value ?? '').replace(/^.*[\\/]/, '').toLowerCase()
  const unquote = (value) => String(value ?? '').trim().replace(/^['"]|['"]$/g, '')
  const executable = commandName(unquote(file))
  const values = Array.isArray(args) ? args.map((value) => String(value)) : []
  let verb = null

  if (executable === 'reg' || executable === 'reg.exe') {
    verb = unquote(values[0])
  } else if (executable === 'cmd' || executable === 'cmd.exe') {
    const commandIndex = values.findIndex((value) => /^\/c$/i.test(unquote(value)))
    if (commandIndex < 0) return null
    const commandParts = values.slice(commandIndex + 1)
    if (commandParts.length >= 2) {
      if (!/^reg(?:\.exe)?$/i.test(commandName(unquote(commandParts[0])))) return null
      verb = unquote(commandParts[1])
    } else if (commandParts.length === 1) {
      const match = commandParts[0].trim().match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)
      const nestedExecutable = match?.[1] || match?.[2] || match?.[3]
      if (!match || !/^reg(?:\.exe)?$/i.test(commandName(nestedExecutable))) return null
      verb = match[4] || match[5] || match[6]
    }
  }

  return /^(?:add|delete)$/i.test(String(verb ?? '')) ? String(verb).toLowerCase() : null
}

const registryGuardCases = [
  { file: 'cmd.exe', args: ['/c', 'reg', 'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], expected: 'add' },
  { file: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'reg.exe', 'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], expected: 'delete' },
  { file: 'C:\\Windows\\System32\\reg.exe', args: ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], expected: 'add' },
  { file: 'cmd.exe', args: ['/c', '"C:\\Windows\\System32\\reg.exe" add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], expected: 'add' },
  { file: 'cmd.exe', args: ['/c', 'reg', 'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], expected: null },
  { file: 'reg.exe', args: ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], expected: null },
  { file: 'cmd.exe', args: ['/c', 'echo', 'reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], expected: null },
  { file: 'node.exe', args: ['--version'], expected: null },
]
for (const testCase of registryGuardCases) {
  const actual = registryWriteVerb(testCase.file, testCase.args)
  if (actual !== testCase.expected) {
    throw new Error(`Registry write guard classifier failed for ${testCase.file}: expected ${testCase.expected}, got ${actual}`)
  }
}

const registryGuardPrelude = `${registryGuardMarker}\n;(() => {\n  if (process.env.WEPORT_PROBE_OFFSCREEN !== '1') return\n  const childProcess = require('node:child_process')\n  const originalExecFileSync = childProcess.execFileSync\n  const registryWriteVerb = ${registryWriteVerb.toString()}\n  childProcess.execFileSync = function (...callArgs) {\n    const verb = registryWriteVerb(callArgs[0], callArgs[1])\n    if (verb) {\n      const error = new Error('Registry writes are disabled in off-screen Weport probes')\n      error.code = 'EPERM'\n      throw error\n    }\n    return Reflect.apply(originalExecFileSync, this, callArgs)\n  }\n})()\n`
const registryGuardMetadata = {
  enabledWhen: 'WEPORT_PROBE_OFFSCREEN=1',
  inserted: 'before the pinned CommonJS main bundle imports',
  intercepted: 'node:child_process.execFileSync (also covers child_process alias)',
  blocked: ['reg add', 'reg delete', 'cmd /c reg add', 'cmd /c reg delete'],
  allowed: ['reg query', 'all other execFileSync calls'],
  classifierSelfChecks: registryGuardCases.length,
}

/**
 * The pinned v1.1 binary predates V1.2's custom-profile migration guard. Its
 * migration reads %APPDATA%\Weport\settings.json even with --user-data-dir, so
 * benchmark a hard-linked private copy whose one appData lookup is redirected
 * to its fresh userData profile. Its Windows autostart sync and legacy cleanup
 * use cmd /c reg query/add/delete via child_process.execFileSync; block only add
 * and delete in the private probe copy. The pinned fixture and original app.asar
 * remain byte-for-byte untouched. No profile/config/database file is read or copied.
 */
function linkTree(source, destination) {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) {
      linkTree(from, to)
    } else if (entry.isFile()) {
      try { linkSync(from, to) } catch { copyFileSync(from, to) }
    } else {
      throw new Error(`Refusing to clone an unexpected link/special file: ${from}`)
    }
  }
}

function assertOwnedProbePath(path) {
  const probeRoot = resolve(root, '.ui-probe') + sep
  const absolute = resolve(path)
  if (!absolute.startsWith(probeRoot)) throw new Error(`Refusing to mutate outside .ui-probe: ${absolute}`)
  return absolute
}

async function makeIsolatedV11Fixture(sourceExe, destination) {
  const safeDestination = assertOwnedProbePath(destination)
  linkTree(dirname(sourceExe), safeDestination)
  const sourceArchive = join(dirname(sourceExe), 'resources', 'app.asar')
  const destinationArchive = join(safeDestination, 'resources', 'app.asar')
  const sourceHashBefore = sha256(sourceArchive)
  const workRoot = assertOwnedProbePath(join(outputDir, '.v11-asar-work'))
  const packedArchive = join(workRoot, 'app.asar')
  mkdirSync(workRoot, { recursive: true })

  asar.extractAll(sourceArchive, join(workRoot, 'tree'))
  const mainBundle = join(workRoot, 'tree', 'dist-electron', 'main.js')
  let source = readFileSync(mainBundle, 'utf8')
  const find = 'i.app.getPath(`appData`)'
  const replace = 'i.app.getPath(process.env.WEPORT_PROBE_OFFSCREEN===`1`?`userData`:`appData`)'
  const matches = source.split(find).length - 1
  if (matches !== 1) throw new Error(`Expected exactly one legacy migration appData lookup in pinned v1.1 bundle; found ${matches}`)
  source = `${registryGuardPrelude}${source.replace(find, replace)}`
  writeFileSync(mainBundle, source, 'utf8')
  execFileSync(process.execPath, ['--check', mainBundle], { stdio: 'pipe' })

  await asar.createPackageWithOptions(join(workRoot, 'tree'), packedArchive, {
    unpackDir: '{node_modules/@hicccc77/electron-liquid-glass,node_modules/koffi,node_modules/@koromix,node_modules/silk-wasm}',
  })
  const packedUnpacked = `${packedArchive}.unpacked`
  const importantNative = asar.listPackage(packedArchive).filter((path) => {
    try {
      const entry = asar.statFile(packedArchive, path.replace(/^[\\/]+/, ''))
      return entry.unpacked === true && /(?:koffi|electron-liquid-glass)/i.test(path)
    } catch { return false }
  })
  if (importantNative.length === 0 || !existsSync(packedUnpacked)) {
    throw new Error('Sanitized v1.1 ASAR did not preserve its unpacked native runtime files')
  }
  const patchedBundle = asar.extractFile(packedArchive, 'dist-electron/main.js').toString('utf8')
  const bundleEntryAnchor = 'const e=require("./wcdbService-BMTi7ozm.js")'
  const guardOffset = patchedBundle.indexOf(registryGuardMarker)
  const bundleEntryOffset = patchedBundle.indexOf(bundleEntryAnchor)
  if (
    !patchedBundle.includes(replace) ||
    patchedBundle.includes(find) ||
    guardOffset !== 0 ||
    bundleEntryOffset <= guardOffset ||
    !patchedBundle.includes("process.env.WEPORT_PROBE_OFFSCREEN !== '1'") ||
    !patchedBundle.includes("childProcess.execFileSync = function (...callArgs)")
  ) {
    throw new Error('Sanitized v1.1 ASAR migration guard failed archive read-back verification')
  }

  const destinationUnpacked = join(safeDestination, 'resources', 'app.asar.unpacked')
  rmSync(destinationArchive, { force: true })
  rmSync(destinationUnpacked, { recursive: true, force: true })
  linkTree(packedUnpacked, destinationUnpacked)
  // Preserve the original archive hash and move only this private copy to the probe fixture.
  copyFileSync(packedArchive, destinationArchive)
  const sourceHashAfter = sha256(sourceArchive)
  if (sourceHashAfter !== sourceHashBefore) throw new Error('Pinned v1.1 app.asar changed while creating its private probe copy')
  const patchedHash = sha256(destinationArchive)
  if (patchedHash === sourceHashBefore) throw new Error('Sanitized probe archive unexpectedly matches the pinned source hash')
  rmSync(workRoot, { recursive: true, force: true, maxRetries: 5 })

  return {
    exe: join(safeDestination, basename(sourceExe)),
    archive: relative(root, destinationArchive),
    sourceArchive: relative(root, sourceArchive),
    sourceSha256: sourceHashBefore,
    sanitizedSha256: patchedHash,
    patch: { file: 'dist-electron/main.js', find, replace, occurrences: matches },
    registryGuard: registryGuardMetadata,
    sourceAsarHashUnchanged: sourceHashAfter === sourceHashBefore,
    preservedUnpackedRuntimeEntries: importantNative.length,
  }
}

const v11Safe = await makeIsolatedV11Fixture(v11Exe, join(outputDir, 'v110-private-probe'))
if (prepareOnly) {
  console.log(JSON.stringify(v11Safe, null, 2))
  process.exit(0)
}
const builds = [
  { key: 'v1.1', exe: v11Safe.exe, sourceExe: v11Exe },
  { key: 'v1.2', exe: currentExe, sourceExe: currentExe },
]
const orders = requested === 1 ? [builds] : Array.from({ length: requested }, (_, i) => i % 2 ? [...builds].reverse() : builds)
const runs = []
const safeEnv = { ...process.env, WEPORT_PROBE_OFFSCREEN: '1', WEPORT_NATIVE_GLASS: '0' }

function runNode(script, args, envExtra = {}) {
  execFileSync(process.execPath, [script, ...args], { cwd: root, env: { ...safeEnv, ...envExtra }, stdio: 'inherit' })
}

for (let round = 0; round < orders.length; round += 1) {
  for (const build of orders[round]) {
    const suffix = `${round + 1}-${build.key}`
    const uiPath = join(outputDir, `${suffix}-ui.json`)
    const backgroundPath = join(outputDir, `${suffix}-background.json`)
    console.log(`\n===== ${build.key} paired run ${round + 1}/${orders.length}: off-screen UI + glass =====`)
    runNode(uiBench, ['--exe', build.exe, '--label', build.key, '--no-baseline', '--out', uiPath], {
      WEPORT_BENCH_V11_SANITIZED: build.key === 'v1.1' ? '1' : '0',
    })
    console.log(`\n===== ${build.key} paired run ${round + 1}/${orders.length}: tray-only background =====`)
    runNode(backgroundBench, ['--exe', build.exe, '--label', build.key, '--out', backgroundPath], {
      WEPORT_BENCH_V11_SANITIZED: build.key === 'v1.1' ? '1' : '0',
    })
    runs.push({ round: round + 1, target: build.key, uiPath, backgroundPath })
  }
}

const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const pick = (obj, path) => path.split('.').reduce((acc, key) => acc == null ? acc : acc[key], obj)
const metricPaths = [
  ['startup RSS, window present', 'ui', 'start.rssMb'],
  ['FCP, window present', 'ui', 'start.fcpMs'],
  ['idle CPU, window present', 'ui', 'processes.idleAvgCpuPercent'],
  ['peak sampled CPU, window present', 'ui', 'stability.sampledPeakCpuPercent'],
  ['idle RSS, window present', 'ui', 'processes.idleAvgRssMb'],
  ['peak sampled RSS, window present', 'ui', 'stability.sampledPeakRssMb'],
  ['popup CPU peak', 'ui', 'glass.cpuDuringPopup'],
  ['popup RSS peak', 'ui', 'glass.rssDuringPopupMb'],
  ['popup frame p95', 'ui', 'glass.frames.p95Delta'],
  ['popup synthetic backdrop FPS', 'ui', 'glass.frames.backdropFps'],
  ['popup creation', 'ui', 'glass.windowMs'],
  ['tray-only idle CPU', 'background', 'idleAvgCpuPercent'],
  ['tray-only peak CPU', 'background', 'idlePeakCpuPercent'],
  ['tray-only idle RSS', 'background', 'idleAvgRssMb'],
  ['tray-only peak RSS', 'background', 'idlePeakRssMb'],
  ['tray-only RSS spread', 'background', 'idleRssSpreadMb'],
]

const grouped = Object.fromEntries(builds.map((build) => [build.key, runs.filter((run) => run.target === build.key).map((run) => ({
  ui: read(run.uiPath),
  background: read(run.backgroundPath),
}))]))
const summary = { at: new Date().toISOString(), runs, results: {} }
console.log('\n===== Paired v1.1 → v1.2 summary (negative delta means v1.2 is lower) =====')
for (const [label, scope, path] of metricPaths) {
  const oldValues = grouped['v1.1'].map((row) => pick(row[scope], path)).filter(Number.isFinite)
  const newValues = grouped['v1.2'].map((row) => pick(row[scope], path)).filter(Number.isFinite)
  const oldMean = mean(oldValues)
  const newMean = mean(newValues)
  if (oldMean === null || newMean === null) {
    console.log(`${label.padEnd(30)} unavailable`)
    continue
  }
  const delta = newMean - oldMean
  const percent = oldMean === 0 ? null : (delta / oldMean) * 100
  summary.results[label] = { v11Mean: oldMean, v12Mean: newMean, delta, deltaPercent: percent }
  console.log(`${label.padEnd(30)} v1.1 ${oldMean.toFixed(2)}  v1.2 ${newMean.toFixed(2)}  Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}${percent === null ? '' : ` (${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%)`}`)
}

function treeBytes(path) {
  if (!existsSync(path)) return null
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += treeBytes(child) || 0
    else total += statSync(child).size
  }
  return total
}
summary.package = {
  v11ExeBytes: statSync(v11Exe).size,
  v12ExeBytes: statSync(currentExe).size,
  v11UnpackedBytes: treeBytes(join(root, '.ui-probe', 'v110')),
  v12UnpackedBytes: treeBytes(join(root, 'release', 'win-unpacked')),
  v11InstallerBytes: v11Installer && existsSync(v11Installer) ? statSync(v11Installer).size : null,
  v12InstallerBytes: v12Installer && existsSync(v12Installer) ? statSync(v12Installer).size : null,
  note: 'The pinned v1.1 fixture is unpacked. For exact installer size, pass both --v11-installer and --v12-installer; size is never inferred from an unpacked directory.',
}
summary.baselineSanitization = v11Safe
const summaryPath = join(outputDir, 'summary.json')
writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
console.log(`\nElectron exe: v1.1 ${summary.package.v11ExeBytes} B → v1.2 ${summary.package.v12ExeBytes} B`)
console.log(`Unpacked tree: v1.1 ${summary.package.v11UnpackedBytes} B → v1.2 ${summary.package.v12UnpackedBytes} B`)
console.log(`Raw paired results: ${summaryPath}`)
