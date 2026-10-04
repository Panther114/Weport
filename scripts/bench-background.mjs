// Private Electron tray/background sampler used by bench-perf-ab.mjs.
// It never copies the user's profile and starts with --background, so it creates no app window.
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright-core')
const root = resolve(process.cwd())
const value = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const exe = resolve(value('--exe') || '')
const label = value('--label') || 'unknown'
const output = resolve(value('--out') || join(root, '.ui-probe', `background-${label}.json`))
if (label === 'v1.1' && process.env.WEPORT_BENCH_V11_SANITIZED !== '1') {
  throw new Error('Refusing to launch v1.1 without its private app.asar migration guard')
}
if (!existsSync(exe)) throw new Error(`Executable not found: ${exe}`)

const userDataDir = mkdtempSync(join(tmpdir(), 'weport-background-bench-'))
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const app = await electron.launch({
  executablePath: exe,
  args: ['--background', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: { ...process.env, WEPORT_PROBE_OFFSCREEN: '1', WEPORT_NATIVE_GLASS: '0' },
  timeout: 90000,
})

const sample = async () => app.evaluate(async ({ app: electronApp, BrowserWindow }) => {
  const metrics = electronApp.getAppMetrics()
  return {
    totalMb: metrics.reduce((sum, process) => sum + (process.memory?.workingSetSize ?? 0), 0) / 1024,
    cpuPercent: metrics.reduce((sum, process) => sum + (process.cpu?.percentCPUUsage ?? 0), 0),
    byType: metrics.map((process) => ({
      type: process.type,
      mb: Math.round((process.memory?.workingSetSize ?? 0) / 1024),
      cpu: Math.round((process.cpu?.percentCPUUsage ?? 0) * 100) / 100,
    })),
    windows: BrowserWindow.getAllWindows().map((win) => ({ position: win.getPosition(), visible: win.isVisible() })),
  }
})

try {
  await app.evaluate(({ BrowserWindow }) => {
    if (BrowserWindow.getAllWindows().length) throw new Error('--background unexpectedly created a window during startup')
    const prototype = BrowserWindow.prototype
    const position = prototype.setPosition, bounds = prototype.setBounds, inactive = prototype.showInactive
    prototype.show = function () { position.call(this, -4000, 0); return inactive.call(this) }
    prototype.showInactive = function () { position.call(this, -4000, 0); return inactive.call(this) }
    prototype.focus = function () {}
    prototype.maximize = function () { position.call(this, -4000, 0) }
    prototype.setPosition = function (_x, _y, animate) { return position.call(this, -4000, 0, animate) }
    prototype.setBounds = function (value, animate) { return bounds.call(this, { ...value, x: -4000, y: 0 }, animate) }
  })
  // Start-up settles MCP / tray and any default background services before the sample window.
  await sleep(5000)
  const rows = []
  for (let i = 0; i < 12; i += 1) {
    rows.push(await sample())
    await sleep(1000)
  }
  if (rows.some((row) => row.windows.length > 0)) {
    throw new Error(`--background created a BrowserWindow: ${JSON.stringify(rows.find((row) => row.windows.length > 0)?.windows)}`)
  }
  const rss = rows.map((row) => row.totalMb)
  const cpu = rows.map((row) => row.cpuPercent)
  const result = {
    at: new Date().toISOString(),
    target: label,
    exe,
    state: 'tray-only, no BrowserWindow, fresh profile, no WeChat data',
    samples: rows.length,
    idleAvgRssMb: Math.round(rss.reduce((sum, x) => sum + x, 0) / rss.length),
    idlePeakRssMb: Math.round(Math.max(...rss)),
    idleRssSpreadMb: Math.round(Math.max(...rss) - Math.min(...rss)),
    idleAvgCpuPercent: Math.round((cpu.reduce((sum, x) => sum + x, 0) / cpu.length) * 100) / 100,
    idlePeakCpuPercent: Math.round(Math.max(...cpu) * 100) / 100,
    byType: rows[rows.length - 1].byType,
    windows: rows[rows.length - 1].windows,
  }
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(result, null, 2), 'utf8')
  console.log(JSON.stringify(result, null, 2))
} finally {
  await app.close().catch(() => {})
  try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 }) } catch { /* noop */ }
}
