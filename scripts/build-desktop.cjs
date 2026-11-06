'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

// Keep the native preflight identical for installers and unpacked local builds.
function buildSteps(platform, arch, unpacked = false) {
  if (!['darwin', 'win32', 'linux'].includes(platform)) {
    throw new Error(`Unsupported build platform: ${platform}`)
  }
  if (platform === 'darwin' && arch !== 'arm64') {
    throw new Error('macOS builds require Apple Silicon (arm64); Intel Mac is not supported.')
  }
  const steps = []
  if (platform === 'darwin') steps.push(['bash', 'scripts/build-mac-image-helper.sh'])
  steps.push(['node', 'node_modules/typescript/bin/tsc', '-p', 'packages/weport-tui/tsconfig.json'])
  steps.push(['node', 'scripts/extract-release-notes.mjs', '--allow-missing'])
  if (platform !== 'win32') {
    steps.push(['node', `scripts/verify-${platform === 'darwin' ? 'mac' : 'linux'}-native.cjs`])
    steps.push(['node', 'scripts/prepare-native-modes.cjs'])
  }
  steps.push(
    ['node', 'scripts/verify-native-assets.cjs'],
    ['node', 'scripts/verify-wasm-assets.cjs'],
    ['node', 'scripts/clean-dist-electron.cjs'],
    ['node', 'node_modules/typescript/bin/tsc', '--noEmit'],
    ['node', 'node_modules/vite/bin/vite.js', 'build', '--config', 'vite.config.mts'],
    ['node', 'scripts/prepare-host-bundle.cjs'],
    ['node', 'scripts/prepare-mcp-bundle.cjs'],
  )
  if (platform === 'win32') steps.push(['node', 'scripts/prepare-flash-ui.cjs'])
  const target = platform === 'darwin' ? ['--mac'] : platform === 'linux' ? ['--linux'] : ['--win']
  if (unpacked) target.push('--dir')
  else if (platform === 'darwin') target.push('dmg', 'zip')
  else if (platform === 'linux') target.push('deb', 'appimage', 'tar.gz')
  if (platform === 'darwin') target.push('--arm64')
  if (platform === 'linux') target.push('--x64')
  steps.push(['node', 'node_modules/electron-builder/cli.js', ...target, '--publish', 'never'])
  return steps
}

function main(args = process.argv.slice(2)) {
  const requested = { '--mac': 'darwin', '--win': 'win32', '--linux': 'linux' }
  for (const arg of args) {
    if (!(arg in requested) && arg !== '--dir') throw new Error(`Unknown build option: ${arg}`)
    if (arg in requested && requested[arg] !== process.platform) {
      throw new Error(`${arg} must be built on its native operating system.`)
    }
  }
  const steps = buildSteps(process.platform, process.arch, args.includes('--dir'))
  for (const [command, ...commandArgs] of steps) {
    console.log(`[build] ${command} ${commandArgs.join(' ')}`)
    const result = spawnSync(command === 'node' ? process.execPath : command, commandArgs, {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    })
    if (result.error) throw result.error
    if (result.status !== 0) return result.status || 1
  }
  return 0
}

if (require.main === module) {
  try { process.exitCode = main() } catch (error) {
    console.error(`[build] ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { buildSteps }
