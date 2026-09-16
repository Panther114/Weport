import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { describeInitFailure, extractErrorCode } from './chatService'
import { WcdbCore } from './wcdbCore'

/**
 * issue #17 —— 「错误码: -3999 什么意思？」
 *
 * 用户看到的曾经就是字面上的 `错误码: -3999`：-3999 / -3998 是**客户端哨兵**
 * （open() 失败但没解析出具体码 / 连接时抛了未预期异常），不是 WCDB 或微信的
 * 错误码。既然哨兵本身没有信息量，文案就必须自带「这是什么 + 下一步做什么」。
 *
 * 这些断言全部打在**真实函数产物**上：`describeInitFailure` 是 chatService 里
 * 真正被 connect() 调用的那个导出（实例方法只是它的转发），`formatInitProtectionError`
 * 是 wcdbCore 里真正组装 `getLastInitError()` 的那个方法。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const wcdbCore = Object.create(WcdbCore.prototype) as unknown as {
  formatInitProtectionError: (code: number) => string
}

/** 一个「自带下一步」的失败文案必须能指出用户接下来干什么。 */
function hasNextStep(message: string): boolean {
  return /下一步/.test(message)
}

describe('describeInitFailure — 哨兵值不再以裸数字示人 (issue #17)', () => {
  it('returns a bare code today only if this test is deleted — guard the exact old bug', () => {
    const message = describeInitFailure(null)
    expect(message).not.toBe('错误码: -3999')
    expect(/^错误码\s*[:：]\s*-?\d+\s*$/.test(message)).toBe(false)
  })

  it('-3999 说明它是客户端哨兵，并给出下一步', () => {
    const message = describeInitFailure(null)
    expect(message).toContain('-3999')
    expect(message).toContain('未能解析出具体错误码')
    expect(hasNextStep(message)).toBe(true)
    expect(message).toContain('wcdb.log')
  })

  it('原始原因本身就是「错误码: -3999」时不再复读，也不丢下一步', () => {
    const message = describeInitFailure('错误码: -3999')
    expect(message).toContain('未能解析出具体错误码')
    expect(hasNextStep(message)).toBe(true)
    expect(message.match(/-3999/g)?.length).toBe(1)
  })

  it('有原始原因时把原因一起带上', () => {
    const reason = 'open() failed: file is not a database'
    const message = describeInitFailure(reason)
    expect(message).toContain(reason)
    expect(message).toContain('-3999')
    expect(hasNextStep(message)).toBe(true)
  })

  it('-3998（未预期异常）走同一套解释 + 下一步', () => {
    const message = describeInitFailure(null, -3998)
    expect(message).toContain('-3998')
    expect(message).toContain('未预期异常')
    expect(hasNextStep(message)).toBe(true)
    expect(/^错误码\s*[:：]\s*-?\d+\s*$/.test(message)).toBe(false)
  })

  it('具体错误码（-3002）保留 wcdbCore 写好的解决步骤，不重复拼错误码', () => {
    const message = describeInitFailure('未找到 session.db 文件，请确认微信已登录并且数据目录完整 (错误码: -3002)')
    expect(message).toContain('-3002')
    expect(message).toContain('session.db')
    // 旧实现会拼成 `错误码: -3002 — 未找到 session.db … (错误码: -3002)`，复读错误码。
    expect(message.startsWith('错误码: -3002 —')).toBe(false)
    expect(message.match(/-3002/g)?.length).toBe(1)
  })

  it('extractErrorCode 认得出两种书写形式，且不会把普通文本当错误码', () => {
    expect(extractErrorCode('错误码: -3999')).toBe(-3999)
    expect(extractErrorCode('未找到数据库目录 (错误码: -3001)')).toBe(-3001)
    expect(extractErrorCode('错误码：-2301')).toBe(-2301)
    expect(extractErrorCode('一切正常')).toBe(null)
    expect(extractErrorCode('')).toBe(null)
  })
})

describe('formatInitProtectionError — 未收录的错误码也带下一步 (issue #17)', () => {
  it('-3999/-3998 在 wcdbCore 侧同样是哨兵而不是裸码', () => {
    const sentinel = wcdbCore.formatInitProtectionError(-3999)
    expect(sentinel).toContain('未能解析出具体错误码')
    expect(sentinel).toContain('-3999')
    const unexpected = wcdbCore.formatInitProtectionError(-3998)
    expect(unexpected).toContain('未预期异常')
  })

  it('未收录的码给出下一步与日志路径，而不是「操作失败，错误码: X」', () => {
    const message = wcdbCore.formatInitProtectionError(-1234)
    expect(message).toContain('-1234')
    expect(message).not.toBe('操作失败，错误码: -1234')
    expect(hasNextStep(message) || /请确认/.test(message)).toBe(true)
    expect(message).toContain('wcdb.log')
  })

  it('已收录的码保持原有的可操作说明', () => {
    const message = wcdbCore.formatInitProtectionError(-3001)
    expect(message).toContain('db_storage')
    expect(message).toContain('-3001')
  })
})

describe('没有别的路径会把裸错误码送到用户面前 (issue #17)', () => {
  const sourceFiles: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      if (entry.name.endsWith('.test.ts')) continue
      if (full.includes(`${join('electron', 'services', 'export')}`)) continue
      sourceFiles.push(full)
    }
  }
  for (const base of ['electron', 'src']) walk(join(root, base))

  it('只有 chatService / wcdbCore 会把错误码拼进用户可见文案', () => {
    const formatters = new Set<string>()
    for (const file of sourceFiles) {
      let source = ''
      try { source = readFileSync(file, 'utf8') } catch { continue }
      for (const line of source.split(/\r?\n/)) {
        // 只看真正会产出字符串的行：同时出现「错误码」和模板插值。
        if (!line.includes('错误码')) continue
        if (!line.includes('${')) continue
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue
        formatters.add(file.slice(root.length + 1).replace(/\\/g, '/'))
      }
    }
    expect([...formatters].sort()).toEqual(['electron/services/chatService.ts', 'electron/services/wcdbCore.ts'])
  })

  it('两个格式化点产出的文案都自带解决方案或下一步', () => {
    const samples = [
      describeInitFailure(null),
      describeInitFailure(null, -3998),
      describeInitFailure('boom'),
      describeInitFailure('动态库加载失败，请检查安装是否完整 (错误码: -2301)'),
      wcdbCore.formatInitProtectionError(-3001),
      wcdbCore.formatInitProtectionError(-2301),
      wcdbCore.formatInitProtectionError(-1234),
      wcdbCore.formatInitProtectionError(-3999),
    ]
    for (const message of samples) {
      expect(message.length).toBeGreaterThan(8)
      expect(/^错误码\s*[:：]\s*-?\d+\s*$/.test(message)).toBe(false)
      expect(message).toMatch(/请|下一步|确认/)
    }
  })

  it('源码扫描本身有效（能找到这两个文件）', () => {
    expect(sourceFiles.length).toBeGreaterThan(50)
    expect(statSync(join(root, 'electron/services/chatService.ts')).isFile()).toBe(true)
  })
})
