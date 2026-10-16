// Verify the actual distributable bytes, not only electron-builder's unpacked tree.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const { resolveLayout } = createRequire(import.meta.url)('./verify-packaged-native.cjs')
const layout = resolveLayout(resolve('release'))
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const scratch = mkdtempSync(join(tmpdir(), 'weport-container-'))
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const expected = hash(join(layout.appResources, 'app.asar'))
const verifyAsar = root => {
  const matches = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile() && entry.name === 'app.asar') matches.push(file)
    }
  }
  walk(root)
  assert.equal(matches.length, 1, 'Distribution must contain exactly one app.asar')
  assert.equal(hash(matches[0]), expected, 'Distributed app.asar must match the tested build')
}
try {
  if (process.platform === 'darwin') {
    const dmg = resolve(`release/Weport-${version}-arm64.dmg`), mount = join(scratch, 'mounted')
    mkdirSync(mount)
    execFileSync('hdiutil', ['verify', dmg], { stdio: 'inherit', timeout: 120000 })
    execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { stdio: 'inherit', timeout: 120000 })
    try {
      const app = join(mount, 'Weport.app')
      assert(existsSync(app))
      execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
      verifyAsar(app)
    } finally { execFileSync('hdiutil', ['detach', mount], { stdio: 'inherit', timeout: 60000 }) }
  } else {
    const tar = join(scratch, 'tar'), deb = join(scratch, 'deb'), image = join(scratch, 'image')
    for (const dir of [tar, deb, image]) mkdirSync(dir)
    execFileSync('tar', ['-xzf', resolve(`release/Weport-${version}-x64.tar.gz`), '-C', tar])
    verifyAsar(tar)
    execFileSync('dpkg-deb', ['-x', resolve(`release/Weport-${version}-amd64.deb`), deb])
    verifyAsar(deb)
    execFileSync(resolve(`release/Weport-${version}-x86_64.AppImage`), ['--appimage-extract'],
      { cwd: image, stdio: 'ignore', timeout: 120000 })
    verifyAsar(image)
  }
  console.log('PASS: distribution containers preserve the tested application bytes')
} finally { rmSync(scratch, { recursive: true, force: true }) }
