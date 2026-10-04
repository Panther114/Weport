import { _electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'weport-flash-smoke-'))
const out = resolve(process.argv[2] || '.ui-probe/flash-smoke')
mkdirSync(out, { recursive: true })
const startedAt = Date.now()
const app = await _electron.launch({ executablePath: resolve('release/flash/win-unpacked/WeportFlash.exe'),
  env: { ...process.env, PORTABLE_EXECUTABLE_DIR: root, WEPORT_PROBE_OFFSCREEN: '1' }, timeout: 90000 })
try {
  // The window must appear before engine initialization finishes. Keep the
  // harness timeout aligned with launch's cold-start budget, then record the
  // window and workflow-ready timings separately.
  const page = await app.firstWindow({ timeout: 90000 })
  const windowStartupMs = Date.now() - startedAt
  await page.locator('#run').waitFor({ timeout: 90000 })
  const info = await page.evaluate(() => window.flash.invoke('flash_info'))
  const workflowStartedAt = Date.now()
  const accounts = await page.evaluate(() => window.flash.invoke('flash_accounts'))
  const workflowReadyMs = Date.now() - workflowStartedAt
  if (resolve(info.dataDir) !== join(root, 'data') || info.version !== '1.2.0') throw new Error('Portable profile/version mismatch')
  await page.evaluate(() => {
    const select = document.querySelector('#account')
    select.replaceChildren(Object.assign(document.createElement('option'), { textContent: '演示账号', value: 'fixture' }))
  })
  await page.screenshot({ path: join(out, 'flash.png') })
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ position: win.getPosition(), focused: win.isFocused() })))
  if (windows.some(win => win.position[0] > -3000 || win.focused)) throw new Error('Flash probe was not offscreen/inactive')
  writeFileSync(join(out, 'results.json'), JSON.stringify({ version: info.version, portableProfile: true, windowStartupMs, workflowReadyMs, detectedAccounts: accounts.length, windows }, null, 2))
  console.log(`Flash startup and portable profile passed (window ${windowStartupMs} ms, workflow ${workflowReadyMs} ms); export is verified separately`)
} finally {
  await app.close().catch(() => {})
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}
