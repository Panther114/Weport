// Run independent packaged gates even after a failure; preserve exact-SHA receipts.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { platform, arch, release } from 'node:os'

const { resolveLayout } = createRequire(import.meta.url)('./verify-packaged-native.cjs')
assert(['darwin', 'linux'].includes(platform()))
assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).version, '1.2.1')
const layout = resolveLayout(resolve('release'))
const tuiExe = platform() === 'linux' ? '/opt/Weport/weport' : layout.appExe
const output = resolve('.ui-probe/cross-platform')
mkdirSync(output, { recursive: true })
const receipt = { sha: process.env.GITHUB_SHA, platform: platform(), arch: arch(), osRelease: release(),
  version: '1.2.1', startedAt: new Date().toISOString(), checks: [],
  limitations: ['Live WeChat key acquisition/OS permission prompts require a real account/device.',
    'Ad-hoc macOS signatures do not establish notarization or Gatekeeper acceptance.',
    'Synthetic fixture lacks native message_fts.db; indexed search and loaded-only fallback are separate.',
    'Short stress samples do not establish day-long stability or performance improvement.'] }
const gates = [
  ...(platform() === 'darwin' ? [['macos-seal-linkage', 'bash', ['scripts/verify-mac-pack.sh', 'release']]] : []),
  ['native-host-and-wrong-name-rejection', process.execPath, ['scripts/verify-packaged-native.cjs', 'release']],
  ['encrypted-fixture-ten-formats-and-recovery', process.execPath, ['scripts/verify-encrypted-fixture.mjs', 'release']],
  ...(platform() === 'linux' ? [['installed-encrypted-fixture-readonly-host-fallback', process.execPath,
    ['scripts/verify-encrypted-fixture.mjs', 'release', '/opt/Weport/weport']]] : []),
  ['packaged-ui-responsive-navigation', process.execPath, ['scripts/verify-v12-ui.mjs']],
  ['feedback-dialog-clipboard-browser-interception', process.execPath, ['scripts/verify-bug-report-ui.mjs']],
  ['moments-anti-delete-success-and-failures', process.execPath, ['scripts/verify-sns-anti-delete-ui.mjs']],
  ['mcp-http-auth-concurrency-origin-policy', process.execPath, ['scripts/verify-mcp-http.mjs']],
  ['cli-ipc-and-credential-privacy', process.execPath, ['scripts/verify-cli-protocol.mjs']],
  ['tui-narrow-terminal', process.execPath, ['scripts/qa-tui.mjs', '--exe', tuiExe, '--width', '100']],
  ['tui-wide-terminal', process.execPath, ['scripts/qa-tui.mjs', '--exe', tuiExe, '--width', '160']],
  ['renderer-recreation-and-route-stress', process.execPath, ['scripts/verify-native-lifecycle.mjs']],
  ['distribution-container-integrity', process.execPath, ['scripts/verify-distribution-containers.mjs']],
  ...(platform() === 'linux' ? [['performance-sampling', process.execPath,
    ['scripts/bench-perf.mjs', '--exe', layout.appExe, '--skip-popup', '--no-baseline', '--out', join(output, 'performance.json')]]] : []),
]
for (const [name, command, args] of gates) {
  console.log(`\nRunning ${name}`)
  const started = Date.now(), log = join(output, `${name}.log`)
  writeFileSync(log, '')
  const record = await new Promise(resolveResult => {
    const child = spawn(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let timedOut = false, error
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 480000)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
      appendFileSync(log, data); process.stdout.write(data)
    })
    child.on('error', cause => { error = cause.message })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolveResult({ name, code, signal, timedOut, error, durationMs: Date.now() - started,
        passed: code === 0 && !timedOut && !error })
    })
  })
  receipt.checks.push(record)
  writeFileSync(join(output, 'result.json'), JSON.stringify(receipt, null, 2))
}
receipt.finishedAt = new Date().toISOString()
receipt.passed = receipt.checks.every(check => check.passed)
writeFileSync(join(output, 'result.json'), JSON.stringify(receipt, null, 2))
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `## ${platform()} ${arch()} v1.2.1 verification\nCommit: ${receipt.sha}\n\n| Gate | Result |\n|---|---|\n` +
  receipt.checks.map(check => `| ${check.name} | ${check.passed ? 'PASS' : 'FAIL'} |`).join('\n') +
  '\n\n' + receipt.limitations.map(limit => `- ${limit}`).join('\n') + '\n')
console.log(JSON.stringify(receipt, null, 2))
if (!receipt.passed) process.exitCode = 1
