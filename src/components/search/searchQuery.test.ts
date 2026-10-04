import { describe, expect, it } from 'vitest'
import {
  EMPTY_SCOPE,
  activeScopeCount,
  buildEngineQuery,
  dateToEpoch,
  epochToDate,
  formatHitTime,
  hasAnyCondition,
  paramsFromQuery,
  paramsFromSavedSearch,
  queryFromParams,
  scopeParamsFromSearchScope,
  segmentsFromHighlights,
  tsToSeconds,
  normalizeResultPage,
  entryKey,
  tagTone,
} from './searchQuery'

const scope0 = () => ({ ...EMPTY_SCOPE })

describe('查询串 <-> 条件', () => {
  it('解析中文前缀操作符与关键词', () => {
    const params = paramsFromQuery('标签:重要 会话:wxid_a 发送者:张三 从:2026-01-01 到:2026-03-31 类型:图片 合同')
    expect(params.text).toBe('合同')
    expect(params.scope.tags).toEqual(['重要'])
    expect(params.scope.sessionIds).toEqual(['wxid_a'])
    expect(params.scope.senders).toEqual(['张三'])
    expect(params.scope.from).toBe('2026-01-01')
    expect(params.scope.to).toBe('2026-03-31')
    expect(params.scope.kinds).toEqual(['image'])
  })

  it('带空格的会话名用引号包住', () => {
    const params = paramsFromQuery('会话:"产品 群" 合同')
    expect(params.scope.sessionIds).toEqual(['产品 群'])
    expect(params.text).toBe('合同')
  })

  it('未知前缀不吞用户输入', () => {
    const params = paramsFromQuery('网址:https://example.com 备注:随便')
    expect(params.scope.sessionIds).toEqual([])
    expect(params.text).toContain('网址:https://example.com')
    expect(params.text).toContain('备注:随便')
  })

  it('非法日期回落成关键词（含全角数字：\\d 会误吞，必须用 ASCII 范围）', () => {
    const params = paramsFromQuery('从:2026-13-99 x')
    expect(params.scope.from).toBe('')
    expect(params.text).toBe('2026-13-99 x')
    // 能被正则放过、但会在 Date 里进位成 3 月 3 日的假日期同样要挡掉
    expect(paramsFromQuery('从:2026-02-31 x').scope.from).toBe('')
    const wide = paramsFromQuery('从:2026-１３-９９ y')
    expect(wide.scope.from).toBe('')
  })

  it('未知类型回落成关键词，已知类型归一成引擎取值', () => {
    const known = paramsFromQuery('类型:图片')
    expect(known.scope.kinds).toEqual(['image'])
    expect(known.text).toBe('')
    // 手打英文取值也认
    expect(paramsFromQuery('类型:image').scope.kinds).toEqual(['image'])
    const unknown = paramsFromQuery('类型:不存在的类型')
    expect(unknown.scope.kinds).toEqual([])
    expect(unknown.text).toBe('不存在的类型')
  })

  it('往返：条件 -> 查询串 -> 条件 不丢信息', () => {
    const params = {
      text: '合同 报价',
      scope: {
        tags: ['重要', '客户 A'],
        sessionIds: ['wxid_a', '产品 群'],
        senders: ['张三'],
        from: '2026-01-01',
        to: '2026-02-28',
        kinds: ['image', 'file'],
      },
    }
    const round = paramsFromQuery(queryFromParams(params))
    expect(round).toEqual(params)
    // 序列化出来的是给人读的中文，不是引擎取值
    expect(queryFromParams(params)).toContain('类型:图片')
    expect(queryFromParams(params)).not.toContain('类型:image')
  })

  it('空条件不产出半截串', () => {
    expect(queryFromParams({ text: '', scope: scope0() })).toBe('')
    expect(queryFromParams({ text: '  x  ', scope: scope0() })).toBe('x')
  })

  it('去重：同一个前缀出现两次只留一个', () => {
    expect(paramsFromQuery('标签:a 标签:a').scope.tags).toEqual(['a'])
  })

  it('条件计数与"是否有条件"', () => {
    expect(activeScopeCount(scope0())).toBe(0)
    expect(activeScopeCount({ ...scope0(), from: '2026-01-01' })).toBe(1)
    expect(hasAnyCondition({ text: '', scope: scope0() })).toBe(false)
    expect(hasAnyCondition({ text: 'x', scope: scope0() })).toBe(true)
    expect(hasAnyCondition({ text: '', scope: { ...scope0(), kinds: ['text'] } })).toBe(true)
  })
})

describe('日期', () => {
  it('本地日期 -> 起点/终点毫秒', () => {
    const start = dateToEpoch('2026-03-31', 'start')!
    const end = dateToEpoch('2026-03-31', 'end')!
    expect(new Date(start).getHours()).toBe(0)
    expect(new Date(end).getHours()).toBe(23)
    expect(end - start).toBe(86_399_999)
  })

  it('非法日期返回 undefined（含自动进位的假日期）', () => {
    expect(dateToEpoch('2026-02-31', 'start')).toBeUndefined()
    expect(dateToEpoch('2026-2-1', 'start')).toBeUndefined()
    expect(dateToEpoch('', 'start')).toBeUndefined()
  })

  it('毫秒 -> 本地日期串 与反向一致', () => {
    const ms = dateToEpoch('2026-01-09', 'start')!
    expect(epochToDate(ms)).toBe('2026-01-09')
  })
})

describe('时间戳单位自适应', () => {
  it('秒保持秒，毫秒降成秒；1e12 是分界', () => {
    expect(tsToSeconds(1_700_000_000)).toBe(1_700_000_000)
    expect(tsToSeconds(1_700_000_000_000)).toBe(1_700_000_000)
    expect(tsToSeconds(0)).toBe(0)
    expect(tsToSeconds(undefined)).toBe(0)
  })

  it('两种单位渲染出同一个时间', () => {
    const seconds = 1_700_000_000
    const now = seconds * 1000 + 1000
    expect(formatHitTime(seconds, now)).toBe(formatHitTime(seconds * 1000, now))
    expect(formatHitTime(seconds, now)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('跨年时带年份', () => {
    const seconds = 1_600_000_000
    const now = 1_750_000_000_000
    expect(formatHitTime(seconds, now)).toMatch(/^2020-09-13 /)
  })
})

describe('引擎请求', () => {
  it('空条件不发请求（避免扫全库）', () => {
    expect(buildEngineQuery({ text: '', scope: scope0() })).toBeNull()
    expect(buildEngineQuery({ text: '   ', scope: scope0() })).toBeNull()
  })

  it('日期转成毫秒边界进 scope', () => {
    const query = buildEngineQuery({ text: 'x', scope: { ...scope0(), from: '2026-01-01', to: '2026-01-31' } })!
    expect(query.text).toBe('x')
    expect(typeof query.scope?.from).toBe('number')
    expect(new Date(query.scope!.from!).getHours()).toBe(0)
    expect(new Date(query.scope!.to!).getHours()).toBe(23)
  })

  it('只有筛选没有关键词也能搜（会带 scope）', () => {
    const query = buildEngineQuery({ text: '', scope: { ...scope0(), kinds: ['image'] } })!
    expect(query.text).toBe('')
    expect(query.scope?.kinds).toEqual(['image'])
  })

  it('标签不进引擎 scope（那是本机注解）：只有标签时视为无条件', () => {
    expect(buildEngineQuery({ text: '', scope: { ...scope0(), tags: ['重要'] } })).toBeNull()
    const withKind = buildEngineQuery({ text: '', scope: { ...scope0(), tags: ['重要'], kinds: ['text'] } })!
    expect('tags' in (withKind.scope || {})).toBe(false)
    expect(withKind.scope?.kinds).toEqual(['text'])
  })
})

describe('高亮分段', () => {
  it('正常区间切成三段', () => {
    const segments = segmentsFromHighlights('abcdef', [[2, 4]])
    expect(segments).toEqual([
      { text: 'ab', hit: false },
      { text: 'cd', hit: true },
      { text: 'ef', hit: false },
    ])
  })

  it('乱序、重叠、越界的区间归一化后不丢字不重复', () => {
    const snippet = 'ABCDEFGH'
    const segments = segmentsFromHighlights(snippet, [
      [4, 6],
      [0, 2],
      [1, 3],
      [6, 99],
      [-5, 1],
    ])
    expect(segments.map((s) => s.text).join('')).toBe(snippet)
    // [-5,1] 与 [0,2] 合并成 [0,3]，[1,3] 并进去，[4,6] 与 [6,99] 合并成 [4,8]
    expect(segments.filter((s) => s.hit).map((s) => s.text).join('')).toBe('ABCEFGH')
  })

  it('反转的区间按顺序处理', () => {
    expect(segmentsFromHighlights('abcd', [[3, 1]])).toEqual([
      { text: 'a', hit: false },
      { text: 'bc', hit: true },
      { text: 'd', hit: false },
    ])
  })

  it('没有高亮 / 空片段 / 非法区间都能渲染', () => {
    expect(segmentsFromHighlights('ab', [])).toEqual([{ text: 'ab', hit: false }])
    expect(segmentsFromHighlights('', [[0, 1]])).toEqual([])
    expect(segmentsFromHighlights('ab', [[1, 1], ['x' as unknown as number, 2]])).toEqual([{ text: 'ab', hit: false }])
  })

  it('跨 emoji 的区间用字符串下标切片即可（不做码点合并）', () => {
    const segments = segmentsFromHighlights('你好😀世界', [[2, 4]])
    expect(segments.map((s) => s.text).join('')).toBe('你好😀世界')
  })
})

describe('服务端返回归一化', () => {
  it('坏形状降级成空页而不是 undefined', () => {
    expect(normalizeResultPage(null)).toEqual({ hits: [], total: 0, cursor: null, elapsedMs: 0, truncated: false })
    expect(normalizeResultPage({ hits: [{ nope: 1 }, { sessionId: 'a' }] }).hits).toHaveLength(1)
    expect(normalizeResultPage({ hits: [], total: '12' as unknown as number }).total).toBe(12)
    expect(normalizeResultPage({ cursor: '' }).cursor).toBeNull()
  })

  it('数字游标归一成字符串而不是被丢掉（否则翻页静默停在第一页）', () => {
    expect(normalizeResultPage({ cursor: 50 }).cursor).toBe('50')
    expect(normalizeResultPage({ cursor: 0 }).cursor).toBe('0')
    expect(normalizeResultPage({ cursor: null }).cursor).toBeNull()
    expect(normalizeResultPage({}).cursor).toBeNull()
  })

  it('保留截断标记', () => {
    expect(normalizeResultPage({ hits: [], truncated: true }).truncated).toBe(true)
    expect(normalizeResultPage({ truncated: 'yes' }).truncated).toBe(false)
  })
})

describe('杂项', () => {
  it('会话条目 key 稳定', () => {
    const hit = { sessionId: 'a', localId: '9', idKind: 'local' as const, ts: 100, db: 'message_0.db', table: 'Msg_A' }
    expect(entryKey(hit)).toBe(entryKey({ ...hit, db: 'C:/wx/message_0.db' }))
    expect(entryKey(hit)).not.toBe(entryKey({ ...hit, table: 'Msg_B' }))
    expect(entryKey({ sessionId: 'a' })).toBe(entryKey({ sessionId: 'a', localId: '' }))
  })

  it('标签配色稳定且落在 1..6', () => {
    const tone = tagTone('重要')
    expect(tagTone('重要')).toBe(tone)
    for (const name of ['a', '重要', '客户 A', 'x'.repeat(50)]) {
      const value = tagTone(name)
      expect(value).toBeGreaterThanOrEqual(1)
      expect(value).toBeLessThanOrEqual(6)
    }
  })

  it('保存搜索 -> 当前条件：合并引擎 scope 并转回本地日期', () => {
    const scopeParams = scopeParamsFromSearchScope({ sessionIds: ['wxid_a'], from: Date.UTC(2026, 0, 1) })
    expect(scopeParams.sessionIds).toEqual(['wxid_a'])
    expect(scopeParams.from).toMatch(/^2026-01-0/)
    const merged = paramsFromSavedSearch('合同 标签:重要', { kinds: ['image'] })
    expect(merged.text).toBe('合同')
    expect(merged.scope.tags).toEqual(['重要'])
    expect(merged.scope.kinds).toEqual(['image'])
  })
})
