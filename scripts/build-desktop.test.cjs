const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSteps } = require('./build-desktop.cjs')

test('Mac installers and unpacked apps use the same native preparation before packaging', () => {
  const installer = buildSteps('darwin', 'arm64')
  const unpacked = buildSteps('darwin', 'arm64', true)
  assert.deepEqual(installer.slice(0, -1), unpacked.slice(0, -1))
  const commands = installer.map(step => step.join(' '))
  assert.ok(commands[0].includes('build-mac-image-helper.sh'))
  assert.ok(commands.some(step => step.includes('verify-mac-native.cjs')))
  assert.ok(commands.some(step => step.includes('prepare-native-modes.cjs')))
  assert.ok(commands.some(step => step.includes('prepare-host-bundle.cjs')))
  assert.ok(!commands.some(step => step.includes('prepare-flash-ui.cjs')))
  assert.deepEqual(installer.at(-1).slice(2), ['--mac', 'dmg', 'zip', '--arm64', '--publish', 'never'])
  assert.deepEqual(unpacked.at(-1).slice(2), ['--mac', '--dir', '--arm64', '--publish', 'never'])
})

test('Windows keeps Flash preparation and Linux keeps its native preflight and x64 artifacts', () => {
  const windows = buildSteps('win32', 'x64')
  assert.ok(windows.some(step => step.includes('scripts/prepare-flash-ui.cjs')))
  assert.deepEqual(windows.at(-1).slice(2), ['--win', '--publish', 'never'])
  const linux = buildSteps('linux', 'x64')
  assert.ok(linux.some(step => step.includes('scripts/verify-linux-native.cjs')))
  assert.deepEqual(linux.at(-1).slice(2), ['--linux', 'deb', 'appimage', 'tar.gz', '--x64', '--publish', 'never'])
})

test('unsupported hosts fail before starting a build', () => {
  assert.throws(() => buildSteps('darwin', 'x64'), /Apple Silicon/)
  assert.throws(() => buildSteps('freebsd', 'x64'), /Unsupported/)
})
