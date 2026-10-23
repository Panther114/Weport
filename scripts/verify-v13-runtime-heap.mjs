import { _electron } from 'playwright-core'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import assert from 'node:assert/strict'
const profile = mkdtempSync(join(tmpdir(), 'weport-v13-runtime-heap-'))
let app
try {
  app = await _electron.launch({ executablePath: resolve('release/win-unpacked/Weport.exe'), args: ['--background', `--user-data-dir=${profile}`],
    env: { ...process.env, WEPORT_UI_DEMO: '1', WEPORT_PROBE_OFFSCREEN: '1', WEPORT_NATIVE_GLASS: '0' }, timeout: 90000 })
  const receipt = await app.evaluate(async ({ app }) => {
    await app.whenReady()
    return { version: app.getVersion(), platform: process.platform, heapLimitMiB: Math.round(process.getBuiltinModule('v8').getHeapStatistics().heap_size_limit / 1048576),
      jsFlags: app.commandLine.getSwitchValue('js-flags'), execArgv: process.execArgv }
  })
  mkdirSync('.ui-probe', { recursive: true })
  writeFileSync('.ui-probe/v13-runtime-heap.json', JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt))
} finally {
  await app?.close().catch(() => {})
  assert.equal(dirname(resolve(profile)), resolve(tmpdir()))
  assert(basename(profile).startsWith('weport-v13-runtime-heap-'))
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 })
}
