import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { copyFileOptimized } from './fileCopy'

const roots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-copy-test-'))
  roots.push(root)
  return { root, source: path.join(root, 'source.pdf'), destination: path.join(root, 'export.pdf') }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (!fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'weport-copy-test-')) throw new Error('Temporary fixture boundary rejected')
    for (const name of fs.readdirSync(root)) fs.chmodSync(path.join(root, name), 0o600)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('export media copies', () => {
  it('exports and rebuilds read-only attachments without changing source bytes or permissions', async () => {
    const f = fixture()
    fs.writeFileSync(f.source, 'actual attachment payload')
    fs.chmodSync(f.source, 0o444)
    const mode = fs.statSync(f.source).mode
    expect((await copyFileOptimized(f.source, f.destination)).success).toBe(true)
    expect(fs.statSync(f.destination).mode & 0o200).not.toBe(0)
    expect((await copyFileOptimized(f.source, f.destination)).success).toBe(true)
    expect(fs.readFileSync(f.destination, 'utf8')).toBe('actual attachment payload')
    expect(fs.readFileSync(f.source, 'utf8')).toBe('actual attachment payload')
    expect(fs.statSync(f.source).mode).toBe(mode)
    expect(fs.readdirSync(f.root).sort()).toEqual(['export.pdf', 'source.pdf'])
  })
  it('repairs a different legacy read-only copy atomically', async () => {
    const f = fixture()
    fs.writeFileSync(f.source, 'correct current payload')
    fs.writeFileSync(f.destination, 'corrupt old payload')
    fs.chmodSync(f.destination, 0o444)
    expect((await copyFileOptimized(f.source, f.destination)).success).toBe(true)
    expect(fs.readFileSync(f.destination, 'utf8')).toBe('correct current payload')
    expect(fs.readdirSync(f.root).sort()).toEqual(['export.pdf', 'source.pdf'])
  })
  it('leaves a prior export intact when the source cannot be read', async () => {
    const f = fixture()
    fs.writeFileSync(f.destination, 'prior successful export')
    expect((await copyFileOptimized(f.source, f.destination)).success).toBe(false)
    expect(fs.readFileSync(f.destination, 'utf8')).toBe('prior successful export')
    expect(fs.readdirSync(f.root)).toEqual(['export.pdf'])
  })
  it('does not modify a source when the destination is the same path', async () => {
    const f = fixture()
    fs.writeFileSync(f.source, 'original')
    fs.chmodSync(f.source, 0o444)
    const mode = fs.statSync(f.source).mode
    expect((await copyFileOptimized(f.source, f.source)).success).toBe(true)
    expect(fs.statSync(f.source).mode).toBe(mode)
    expect((await copyFileOptimized(f.destination, f.destination)).success).toBe(false)
  })
  it('restores legacy permissions and retains prior bytes if replacement is denied', async () => {
    const f = fixture()
    fs.writeFileSync(f.source, 'new payload')
    fs.writeFileSync(f.destination, 'previous payload')
    fs.chmodSync(f.destination, 0o444)
    const mode = fs.statSync(f.destination).mode
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('locked destination'), { code: 'EPERM' }))
    expect(await copyFileOptimized(f.source, f.destination)).toEqual({ success: false, code: 'EPERM' })
    expect(fs.readFileSync(f.destination, 'utf8')).toBe('previous payload')
    expect(fs.statSync(f.destination).mode).toBe(mode)
    expect(fs.readdirSync(f.root).sort()).toEqual(['export.pdf', 'source.pdf'])
  })
  it('never clears permissions on a read-only target shared by another hardlink', async () => {
    const f = fixture()
    fs.writeFileSync(f.source, 'new payload')
    fs.writeFileSync(f.destination, 'shared prior payload')
    const alias = path.join(f.root, 'other.pdf')
    fs.linkSync(f.destination, alias)
    fs.chmodSync(f.destination, 0o444)
    const mode = fs.statSync(alias).mode
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('read-only destination'), { code: 'EPERM' }))
    expect((await copyFileOptimized(f.source, f.destination)).success).toBe(false)
    expect(fs.readFileSync(alias, 'utf8')).toBe('shared prior payload')
    expect(fs.statSync(alias).mode).toBe(mode)
    expect(fs.readdirSync(f.root).sort()).toEqual(['export.pdf', 'other.pdf', 'source.pdf'])
  })
})
