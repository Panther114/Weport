import { describe, expect, it, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findFfmpeg } from './ffmpegLocator'

const originalOverride = process.env.WEPORT_FFMPEG

afterEach(() => {
  if (originalOverride === undefined) delete process.env.WEPORT_FFMPEG
  else process.env.WEPORT_FFMPEG = originalOverride
})

describe('findFfmpeg', () => {
  it('WEPORT_FFMPEG 命中时直接采用（覆盖 PATH）', () => {
    // process.execPath 一定存在，用它冒充 ffmpeg 只为验证"覆盖优先"。
    process.env.WEPORT_FFMPEG = process.execPath
    expect(findFfmpeg()).toBe(process.execPath)
  })

  it('WEPORT_FFMPEG 指向不存在的文件时忽略它，不返回该路径', () => {
    const missing = join(tmpdir(), 'weport-ffmpeg-does-not-exist.exe')
    expect(existsSync(missing)).toBe(false)
    process.env.WEPORT_FFMPEG = missing
    expect(findFfmpeg()).not.toBe(missing)
  })

  it('没有覆盖时只返回真实存在的可执行文件或 null', () => {
    delete process.env.WEPORT_FFMPEG
    const found = findFfmpeg()
    if (found !== null) expect(existsSync(found)).toBe(true)
  })
})
