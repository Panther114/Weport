import { describe, expect, it } from 'vitest'
import { describeScope, filterCandidates, type SessionCandidate } from './searchData'
import { EMPTY_SCOPE } from './searchQuery'

const list: SessionCandidate[] = [
  { username: 'wxid_a', displayName: '张三' },
  { username: 'wxid_b', displayName: '李四' },
  { username: 'wxid_c', displayName: '产品群' },
  { username: 'wxid_d', displayName: 'Alice' },
]

describe('会话候选筛选', () => {
  it('关键词命中名称或 id（大小写不敏感）', () => {
    expect(filterCandidates(list, { keyword: '张', selected: [] }).map((i) => i.username)).toEqual(['wxid_a'])
    expect(filterCandidates(list, { keyword: 'alic', selected: [] }).map((i) => i.username)).toEqual(['wxid_d'])
    expect(filterCandidates(list, { keyword: 'wxid_c', selected: [] }).map((i) => i.username)).toEqual(['wxid_c'])
  })

  it('已选中的会话永远留下并置顶，哪怕不匹配关键词', () => {
    const rows = filterCandidates(list, { keyword: '张', selected: ['wxid_b'] })
    expect(rows.map((i) => i.username)).toEqual(['wxid_b', 'wxid_a'])
  })

  it('最近使用的排在同优先级前面', () => {
    const rows = filterCandidates(list, { keyword: '', selected: [], recent: ['wxid_c', 'wxid_b'] })
    expect(rows.slice(0, 2).map((i) => i.username)).toEqual(['wxid_c', 'wxid_b'])
  })

  it('按标签收窄，但选中的不受影响', () => {
    const rows = filterCandidates(list, { keyword: '', selected: ['wxid_d'], tagged: new Set(['wxid_a']) })
    expect(rows.map((i) => i.username).sort()).toEqual(['wxid_a', 'wxid_d'])
  })

  it('limit 生效', () => {
    expect(filterCandidates(list, { keyword: '', selected: [], limit: 2 })).toHaveLength(2)
  })
})

describe('筛选摘要', () => {
  it('把 id 换成显示名，缺名字时回落成 id', () => {
    const names = new Map([['wxid_a', '张三']])
    expect(describeScope({ ...EMPTY_SCOPE, sessionIds: ['wxid_a', 'wxid_b'] }, names)).toEqual(['会话 张三、wxid_b'])
  })

  it('空条件产出空数组', () => {
    expect(describeScope(EMPTY_SCOPE, new Map())).toEqual([])
  })
})
