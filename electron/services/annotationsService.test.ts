import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AnnotationsService, annotationsAccountHash } from './annotationsService'

/**
 * 标注存储（标签 / 收藏 / 标记 / 保存搜索）。
 *
 * 这里守的是三类真实故障：
 *   1. 文件坏了以后整个功能不可用（用户连"删掉重来"都做不到）；
 *   2. 重复操作把数据写胖（界面重试、连点两下都会走同一条 op）；
 *   3. 写一半崩掉留下半个文件（下次启动读出一半的标签）。
 */

let dir = ''
let now = 1_700_000_000_000

function createService(): AnnotationsService {
  return new AnnotationsService({ userDataDir: dir, now: () => now, log: () => undefined })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weport-annotations-'))
  now = 1_700_000_000_000
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响断言 */
  }
})

describe('损坏文件容忍', () => {
  it('坏 JSON 不抛异常，备份坏文件后从空库起步', () => {
    const storageDir = join(dir, 'annotations')
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(join(storageDir, 'unbound.json'), '{"v":1,"data":{"tags":', 'utf8')
    const service = createService()
    const store = service.list()
    expect(store.tags).toEqual({})
    expect(store.favorites).toEqual([])
    expect(store.error).toContain('损坏')

    const backups = readdirSync(storageDir).filter((name) => name.includes('.corrupt-'))
    expect(backups.length).toBe(1)
    // 备份内容是原始坏文件（有机会手工抢救）
    expect(readFileSync(join(storageDir, backups[0]), 'utf8')).toContain('"tags":')
  })

  it('空文件也算损坏（写到一半掉电的典型产物）', () => {
    const storageDir = join(dir, 'annotations')
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(join(storageDir, 'unbound.json'), '   ', 'utf8')
    const service = createService()
    expect(service.list().tags).toEqual({})
    expect(readdirSync(storageDir).some((name) => name.includes('.corrupt-'))).toBe(true)
  })

  it('文件不存在是首次运行，不是损坏（不留备份）', () => {
    const service = createService()
    expect(service.list().tags).toEqual({})
    expect(service.list().error).toBeUndefined()
    expect(readdirSync(dir).filter((name) => name.includes('.corrupt-')).length).toBe(0)
  })
})

describe('标签', () => {
  it('重复打同一个标签是幂等的', () => {
    const service = createService()
    service.mutate({ op: 'tag.add', payload: { tag: '重要', sessionIds: ['wxid_a'] } })
    const first = service.list()
    service.mutate({ op: 'tag.add', payload: { tag: '重要', sessionIds: ['wxid_a'] } })
    const second = service.list()
    expect(second.tags).toEqual(first.tags)
    expect(second.tags.wxid_a).toEqual(['重要'])
  })

  it('批量打标 + 标签排序稳定', () => {
    const service = createService()
    service.mutate({ op: 'tag.add', payload: { tag: 'b', sessionIds: ['wxid_a', 'wxid_b'] } })
    service.mutate({ op: 'tag.add', payload: { tag: 'a', sessionIds: ['wxid_a'] } })
    const store = service.list()
    expect(store.tags.wxid_a).toEqual(['a', 'b'])
    expect(store.tags.wxid_b).toEqual(['b'])
  })

  it('tag.add 带 from 是重命名：全量生效、不留旧名', () => {
    const service = createService()
    service.mutate({ op: 'tag.add', payload: { tag: '工作', sessionIds: ['wxid_a', 'wxid_b', 'wxid_c'] } })
    service.mutate({ op: 'tag.add', payload: { tag: '客户', from: '工作' } })
    const store = service.list()
    expect(store.tags.wxid_a).toEqual(['客户'])
    expect(store.tags.wxid_b).toEqual(['客户'])
    expect(JSON.stringify(store.tags)).not.toContain('工作')
  })

  it('tag.remove 不给 sessionIds 时全库摘掉，不留残留引用', () => {
    const service = createService()
    service.mutate({ op: 'tag.add', payload: { tag: '临时', sessionIds: ['wxid_a', 'wxid_b'] } })
    service.mutate({ op: 'tag.add', payload: { tag: '保留', sessionIds: ['wxid_a'] } })
    const store = service.mutate({ op: 'tag.remove', payload: { tag: '临时' } })
    expect(store.tags.wxid_b).toBeUndefined()
    expect(store.tags.wxid_a).toEqual(['保留'])
    expect(store.tagIndex).toEqual({ 保留: ['wxid_a'] })
  })

  it('tagIndex 是派生视图（tag → 会话），随标签增删一起变', () => {
    const service = createService()
    service.mutate({ op: 'tag.add', payload: { tag: '客户', sessionIds: ['wxid_b', 'wxid_a'] } })
    let store = service.list()
    expect(store.tagIndex).toEqual({ 客户: ['wxid_a', 'wxid_b'] })
    store = service.mutate({ op: 'tag.add', payload: { tag: '重点', from: '客户' } })
    expect(store.tagIndex).toEqual({ 重点: ['wxid_a', 'wxid_b'] })
  })
})

describe('收藏与标记', () => {
  it('重复收藏同一条消息不产生重复项，也不刷新 at', () => {
    const service = createService()
    service.mutate({ op: 'fav.add', payload: { sessionId: 'wxid_a', localId: 12, ts: 100 } })
    now += 60_000
    const store = service.mutate({ op: 'fav.add', payload: { sessionId: 'wxid_a', localId: 12, ts: 100 } })
    expect(store.favorites.length).toBe(1)
    expect(store.favorites[0].at).toBe(1_700_000_000_000)
  })

  it('备注更新走同一条 fav.add（只有显式给新备注才改）', () => {
    const service = createService()
    service.mutate({ op: 'fav.add', payload: { sessionId: 'wxid_a', localId: 12, ts: 100, note: '旧' } })
    service.mutate({ op: 'fav.add', payload: { sessionId: 'wxid_a', localId: 12, ts: 100, note: '新' } })
    expect(service.list().favorites[0].note).toBe('新')
  })

  it('会话级收藏用 localId=0 表达，取消整个会话收藏会连消息收藏一起清掉', () => {
    const service = createService()
    service.mutate({ op: 'fav.add', payload: { sessionId: 'wxid_a', localId: 0, ts: 1 } })
    service.mutate({ op: 'fav.add', payload: { sessionId: 'wxid_a', localId: 9, ts: 2 } })
    expect(service.list().favorites.length).toBe(2)
    const store = service.mutate({ op: 'fav.remove', payload: { sessionId: 'wxid_a' } })
    expect(store.favorites.length).toBe(0)
  })

  it('标记需要 localId（会话级标记没有意义）', () => {
    const service = createService()
    const result = service.mutate({ op: 'mark.add', payload: { sessionId: 'wxid_a' } })
    expect(result.success).toBe(false)
    expect(result.marks).toEqual([])
  })

  it('标记幂等 + 按 localId 删除', () => {
    const service = createService()
    service.mutate({ op: 'mark.add', payload: { sessionId: 'wxid_a', localId: 5, ts: 10 } })
    service.mutate({ op: 'mark.add', payload: { sessionId: 'wxid_a', localId: 5, ts: 10 } })
    expect(service.list().marks.length).toBe(1)
    service.mutate({ op: 'mark.remove', payload: { sessionId: 'wxid_a', localId: 5 } })
    expect(service.list().marks.length).toBe(0)
  })

  it('same local id in different database tables creates separate exact marks and removals', () => {
    const service = createService()
    const first = { sessionId: 'wxid_a', localId: '42', messageId: '42', idKind: 'local', ts: 100, db: 'message_2.db', table: 'Msg_A' }
    const second = { ...first, db: 'message_3.db', table: 'Msg_B' }
    service.mutate({ op: 'mark.add', payload: { ...first, note: 'A' } })
    service.mutate({ op: 'mark.add', payload: { ...first, note: 'A' } })
    service.mutate({ op: 'mark.add', payload: { ...second, note: 'B' } })
    expect(service.list().marks).toHaveLength(2)
    expect(service.list().marks.map((entry) => entry.note).sort()).toEqual(['A', 'B'])

    service.mutate({ op: 'mark.remove', payload: first })
    expect(service.list().marks).toMatchObject([{ messageId: '42', db: 'message_3.db', table: 'Msg_B', note: 'B' }])
  })

  it('preserves large server IDs as strings and rejects unsafe numeric IDs', () => {
    const service = createService()
    const firstId = '9007199254740993'
    const secondId = '9007199254740994'
    service.mutate({ op: 'fav.add', payload: { sessionId: 'wxid_a', localId: '', messageId: firstId, idKind: 'server', ts: 100, db: 'message_2.db', table: 'Msg_A' } })
    service.mutate({ op: 'fav.add', payload: { sessionId: 'wxid_a', localId: '', messageId: secondId, idKind: 'server', ts: 100, db: 'message_2.db', table: 'Msg_A' } })
    const favorites = service.list().favorites
    expect(favorites.map((entry) => entry.messageId)).toEqual([firstId, secondId])
    expect(favorites.every((entry) => entry.localId === 0 && entry.idKind === 'server')).toBe(true)

    const unsafe = service.mutate({ op: 'fav.add', payload: { sessionId: 'wxid_a', localId: firstId, ts: 100 } })
    expect(unsafe.success).toBe(false)
    expect(unsafe.error).toContain('安全整数')
    expect(service.list().favorites).toHaveLength(2)
  })

  it('accepts exact string IDs even when a rounded numeric companion is present', () => {
    const service = createService()
    const exactId = '9007199254740993'
    const result = service.mutate({ op: 'fav.add', payload: {
      sessionId: 'wxid_a',
      localId: Number(exactId),
      messageId: exactId,
      idKind: 'server',
      ts: 100,
      db: 'message_2.db',
      table: 'Msg_A',
    } })
    expect(result.success).toBe(true)
    expect(service.list().favorites).toMatchObject([{ localId: 0, messageId: exactId, idKind: 'server' }])
  })

  it('preserves an exact large local ID through persisted-store normalization', () => {
    const service = createService()
    const exactId = '9007199254740993'
    service.mutate({ op: 'mark.add', payload: {
      sessionId: 'wxid_a', localId: exactId, messageId: exactId, idKind: 'local', ts: 100,
      db: 'message_2.db', table: 'Msg_A', note: 'keep exact ID',
    } })
    expect(createService().list().marks).toMatchObject([{ localId: 0, messageId: exactId, idKind: 'local', note: 'keep exact ID' }])
  })
})

describe('保存搜索往返', () => {
  it('保存 → 读取 → 重命名 → 更新运行结果 → 删除', () => {
    const service = createService()
    const saved = service.mutate({
      op: 'search.save',
      payload: { name: '找合同', query: '合同', scope: { kinds: ['file'] } },
    })
    const first = saved.savedSearches[0]
    expect(first.name).toBe('找合同')
    expect(first.query).toBe('合同')
    expect(first.scope).toEqual({ kinds: ['file'] })

    const renamed = service.mutate({ op: 'search.rename', payload: { id: first.id, name: '合同附件' } })
    expect(renamed.savedSearches[0].name).toBe('合同附件')

    const ran = service.mutate({
      op: 'search.save',
      payload: { id: first.id, name: '合同附件', query: '合同', lastRunAt: now, lastCount: 7 },
    })
    expect(ran.savedSearches[0].lastCount).toBe(7)
    expect(ran.savedSearches.length).toBe(1)

    const removed = service.mutate({ op: 'search.remove', payload: { id: first.id } })
    expect(removed.savedSearches).toEqual([])
  })

  it('重启后仍在（落盘 + 重新读取）', () => {
    const service = createService()
    service.mutate({ op: 'search.save', payload: { name: '常搜', query: '发票' } })
    service.mutate({ op: 'tag.add', payload: { tag: '客户', sessionIds: ['wxid_a'] } })
    const reopened = createService().list()
    expect(reopened.savedSearches.length).toBe(1)
    expect(reopened.savedSearches[0].query).toBe('发票')
    expect(reopened.tags.wxid_a).toEqual(['客户'])
  })

  it('未知 op 不改数据并说明原因', () => {
    const service = createService()
    service.mutate({ op: 'tag.add', payload: { tag: 'x', sessionIds: ['wxid_a'] } })
    const result = service.mutate({ op: 'nope' as never, payload: {} })
    expect(result.success).toBe(false)
    expect(result.error).toContain('未知操作')
    expect(result.tags.wxid_a).toEqual(['x'])
  })
})

describe('原子写与导出', () => {
  it('写入后目录里没有临时文件残留', () => {
    const service = createService()
    service.mutate({ op: 'tag.add', payload: { tag: 'x', sessionIds: ['wxid_a'] } })
    service.mutate({ op: 'fav.add', payload: { sessionId: 'wxid_a', localId: 1, ts: 1 } })
    const leftovers = readdirSync(join(dir, 'annotations')).filter((name) => name.includes('.tmp-'))
    expect(leftovers).toEqual([])
    expect(existsSync(service.storagePath)).toBe(true)
    expect(service.storagePath).toBe(join(dir, 'annotations', 'unbound.json'))
  })

  it('json / csv / md 三种导出都真的写出来了', () => {
    const service = createService()
    service.mutate({ op: 'tag.add', payload: { tag: '含,逗号', sessionIds: ['wxid_a'] } })
    service.mutate({ op: 'mark.add', payload: { sessionId: 'wxid_a', localId: 3, ts: 1, note: '备注"引号"' } })
    service.mutate({ op: 'search.save', payload: { name: '搜索', query: 'hello world' } })

    const json = service.export('json', join(dir, 'out.json'))
    expect(json.success).toBe(true)
    const parsed = JSON.parse(readFileSync(json.path as string, 'utf8'))
    expect(parsed.tags.wxid_a).toEqual(['含,逗号'])

    const csv = service.export('csv', join(dir, 'out.csv'))
    expect(csv.success).toBe(true)
    const csvText = readFileSync(csv.path as string, 'utf8')
    expect(csvText.split('\r\n')[0]).toContain('kind,sessionId')
    expect(csvText).toContain('"含,逗号"')
    expect(csvText).toContain('""引号""')

    const md = service.export('md', join(dir, 'out.md'))
    expect(md.success).toBe(true)
    const mdText = readFileSync(md.path as string, 'utf8')
    expect(mdText).toContain('# Weport 标注导出')
    expect(mdText).toContain('含,逗号')
  })

  it('导出路径给目录时落到 <dir>/annotations.<ext>', () => {
    const service = createService()
    const exportDir = join(dir, 'exports')
    mkdirSync(exportDir, { recursive: true })
    const result = service.export('json', exportDir)
    expect(result.success).toBe(true)
    expect(result.path).toBe(join(exportDir, 'annotations.json'))
  })

  it('导出路径为空时报错而不是写到一个奇怪的地方', () => {
    const service = createService()
    expect(service.export('json', '').success).toBe(false)
  })
})

describe('账号隔离与旧版迁移', () => {
  it('账号未选定时使用独立存储，保留旧版全局数据给第一个真实账号迁移', () => {
    writeFileSync(join(dir, 'annotations.json'), JSON.stringify({
      v: 1,
      data: { tags: { session_legacy: ['旧标签'] }, favorites: [], marks: [], savedSearches: [] },
    }), 'utf8')

    const unbound = createService()
    expect(unbound.list().tags).toEqual({})
    unbound.mutate({ op: 'tag.add', payload: { tag: '临时', sessionIds: ['session_unbound'] } })
    expect(unbound.storagePath).toBe(join(dir, 'annotations', 'unbound.json'))
    expect(JSON.parse(readFileSync(join(dir, 'annotations.json'), 'utf8')).data.tags.session_legacy).toEqual(['旧标签'])

    const firstAccount = new AnnotationsService({ userDataDir: dir, resolveAccountId: () => 'wxid_first', log: () => undefined })
    expect(firstAccount.list().tags).toEqual({ session_legacy: ['旧标签'] })
  })

  it('按账号隔离数据，切换后再切回可恢复并落盘', () => {
    let account = 'wxid_a'
    const service = new AnnotationsService({ userDataDir: dir, resolveAccountId: () => account, now: () => now, log: () => undefined })
    service.mutate({ op: 'tag.add', payload: { tag: 'A', sessionIds: ['session_a'] } })
    const accountPath = service.storagePath
    expect(accountPath).toContain(annotationsAccountHash('wxid_a'))
    expect(accountPath).not.toContain('wxid_a')

    account = 'wxid_b'
    expect(service.list().tags).toEqual({})
    service.mutate({ op: 'tag.add', payload: { tag: 'B', sessionIds: ['session_b'] } })
    expect(service.list().tags).toEqual({ session_b: ['B'] })

    account = 'wxid_a'
    expect(service.list().tags).toEqual({ session_a: ['A'] })
    const reopened = new AnnotationsService({ userDataDir: dir, resolveAccountId: () => 'wxid_a', log: () => undefined })
    expect(reopened.list().tags).toEqual({ session_a: ['A'] })
  })

  it('assigns legacy global annotations to exactly the first account and records an owner marker', () => {
    writeFileSync(join(dir, 'annotations.json'), JSON.stringify({
      v: 1,
      data: { tags: { session_legacy: ['旧标签'] }, favorites: [], marks: [], savedSearches: [] },
    }), 'utf8')
    let account = 'wxid_first'
    const service = new AnnotationsService({ userDataDir: dir, resolveAccountId: () => account, log: () => undefined })
    expect(service.list().tags).toEqual({ session_legacy: ['旧标签'] })
    const owner = JSON.parse(readFileSync(join(dir, 'annotations-legacy-owner.json'), 'utf8'))
    expect(owner.ownerHash).toBe(annotationsAccountHash('wxid_first'))

    account = 'wxid_second'
    expect(service.list().tags).toEqual({})
    expect(JSON.parse(readFileSync(join(dir, 'annotations.json'), 'utf8')).data.tags.session_legacy).toEqual(['旧标签'])
  })

  it('does not let another account claim legacy data when the owner marker is malformed', () => {
    writeFileSync(join(dir, 'annotations.json'), JSON.stringify({
      v: 1,
      data: { tags: { session_legacy: ['旧标签'] }, favorites: [], marks: [], savedSearches: [] },
    }), 'utf8')
    writeFileSync(join(dir, 'annotations-legacy-owner.json'), JSON.stringify({ v: 1 }), 'utf8')

    const first = new AnnotationsService({ userDataDir: dir, resolveAccountId: () => 'wxid_first', log: () => undefined })
    expect(first.list().tags).toEqual({})
    expect(first.list().error).toContain('归属标记无效')
    expect(existsSync(first.storagePath)).toBe(false)

    const second = new AnnotationsService({ userDataDir: dir, resolveAccountId: () => 'wxid_second', log: () => undefined })
    expect(second.list().tags).toEqual({})
    expect(second.list().error).toContain('归属标记无效')
    expect(existsSync(second.storagePath)).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'annotations.json'), 'utf8')).data.tags.session_legacy).toEqual(['旧标签'])
  })
})
