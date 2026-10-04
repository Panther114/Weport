import { describe, expect, it } from 'vitest'
import { formatBytes, parentDirOf } from './diagnosticsFormat'

/**
 * 诊断页的展示层小工具。
 *
 * 这两个函数看起来"简单到不需要测"，但它们都在**用户唯一能看到结果的地方**：
 * 包大小显示成 `0 B` 会让人以为导出失败，父目录算错会让「在文件夹中显示」打开
 * 一个不存在的位置。用几个真实形态（Windows 路径、UNC、根、POSIX）钉住。
 */

describe('parentDirOf', () => {
  it('Windows 路径', () => {
    expect(parentDirOf('C:\\Users\\admin\\AppData\\Roaming\\Weport\\diagnostics\\a.zip')).toBe(
      'C:\\Users\\admin\\AppData\\Roaming\\Weport\\diagnostics',
    )
    expect(parentDirOf('C:\\file.zip')).toBe('C:\\')
  })

  it('POSIX 路径与根', () => {
    expect(parentDirOf('/home/x/.config/Weport/diagnostics/a.zip')).toBe('/home/x/.config/Weport/diagnostics')
    expect(parentDirOf('/a.zip')).toBe('/')
  })

  it('尾部分隔符与混合分隔符都能收敛', () => {
    expect(parentDirOf('C:\\a\\b\\')).toBe('C:\\a')
    expect(parentDirOf('/home/x/dir/')).toBe('/home/x')
    expect(parentDirOf('C:\\a/b\\c.zip')).toBe('C:\\a/b')
  })

  it('没有分隔符时返回空串（调用方据此跳过打开动作）', () => {
    expect(parentDirOf('a.zip')).toBe('')
    expect(parentDirOf('')).toBe('')
  })
})

describe('formatBytes', () => {
  it('按人类可读单位四舍五入', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(undefined)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(1536 * 1024)).toBe('1.5 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })
})
