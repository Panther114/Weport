// Real packaged CLI IPC acceptance on a private profile with synthetic credentials.
// No real account, connector, provider or external endpoint is used.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(process.cwd())
const require = createRequire(join(root, 'package.json'))
const { resolveLayout } = require(join(root, 'scripts/verify-packaged-native.cjs'))
const layout = resolveLayout(join(root, 'release'))
const profile = mkdtempSync(join(tmpdir(), 'weport-cli-protocol-'))
const out = resolve(process.argv[2] || '.ui-probe/cli-protocol')
mkdirSync(out, { recursive: true })
const synthetic = 'qa-private-credential-do-not-echo'
const secretKeys = ['aiModelApiKey', 'aiInsightApiKey', 'aiInsightWeiboCookie', 'aiInsightTelegramToken', 'imageXorKey', 'wxidConfigs']
writeFileSync(join(profile, 'Weport-config.json'), JSON.stringify({
  dbPath: '', myWxid: '', mcpEnabled: false, httpApiEnabled: false,
  messagePushEnabled: false, launchAtStartup: false,
  ...Object.fromEntries(secretKeys.map(key => [key, key === 'wxidConfigs' ? { qa_account: { decryptKey: synthetic, imageAesKey: synthetic } } : key === 'imageXorKey' ? 123 : synthetic])),
}))
const token = randomUUID()
// User-owned archive permissions do not configure Linux's setuid helper. Secure
// root-owned installation acceptance is recorded separately from this IPC gate.
const child = spawn(layout.appExe, ['--cli', '--disable-gpu', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), `--user-data-dir=${profile}`, '--weport-token', token], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, WEPORT_CLI_TOKEN: token, WEPORT_PROBE_OFFSCREEN: '1' },
})
child.stdout.resume()
child.stderr.resume()
const waiters = new Map()
let readyResolve, readyReject
const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
const startupTimer = setTimeout(() => readyReject(new Error('CLI handshake timed out')), 60000)
child.on('message', message => {
  if (message.kind === 'ready') { clearTimeout(startupTimer); readyResolve(message); return }
  if (message.kind === 'error') { clearTimeout(startupTimer); readyReject(new Error(message.error)); return }
  const waiter = waiters.get(message.id)
  if (waiter) { waiters.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message) }
})
const fail = error => {
  clearTimeout(startupTimer)
  readyReject(error)
  for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(error) }
  waiters.clear()
}
child.on('error', fail)
child.on('exit', code => fail(new Error(`CLI exited with code ${code}`)))
const call = (command, args = {}) => new Promise((resolve, reject) => {
  const id = randomUUID()
  const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`${command} timed out`)) }, 15000)
  waiters.set(id, { resolve, reject, timer })
  child.send({ kind: 'call', id, command, args }, error => {
    if (!error || !waiters.delete(id)) return
    clearTimeout(timer)
    reject(error)
  })
})
const cases = []
const check = (name, ok, detail) => {
  cases.push({ name, ok, detail })
  if (!ok) throw new Error(`${name} failed`)
}
try {
  child.send({ kind: 'hello', token })
  const info = await ready
  check('token handshake', !!info.version && info.pid === child.pid, { version: info.version })
  check('ping', (await call('cli.ping')).success === true)
  const commands = await call('cli.commands')
  check('command inventory', commands.success && Array.isArray(commands.data) && commands.data.length >= 20, { count: commands.data?.length })
  const privacy = await call('config.get', { keys: secretKeys.join(',') })
  check('credential reads expose only presence', privacy.success && secretKeys.every(key => privacy.data?.[key] === true) && !JSON.stringify(privacy).includes(synthetic))
  const write = await call('config.set', { key: 'mcpToken', value: synthetic })
  check('credential write acknowledgement does not echo value', write.success && write.data?.value === true && !JSON.stringify(write).includes(synthetic))
  const read = await call('config.get', { keys: 'mcpToken' })
  check('written credential remains available as presence', read.success && read.data?.mcpToken === true)
  const unknown = await call('does.not.exist')
  check('unknown command rejected', unknown.success === false && typeof unknown.error === 'string')
  check('engine survives rejected command', (await call('cli.ping')).success === true)
  console.log(JSON.stringify({ cases }))
} finally {
  clearTimeout(startupTimer)
  const exited = new Promise(resolve => child.once('exit', resolve))
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try { child.send({ kind: 'bye' }, () => {}) } catch {}
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
    await exited
    clearTimeout(timer)
  }
  writeFileSync(join(out, 'results.json'), JSON.stringify({ cases }, null, 2))
}
