import { describe, expect, it } from 'vitest'
import { splitReplyBubbles } from './weCloneBubbles'

/**
 * 用户报的「v6 老是写成多行长诗、还莫名多了两个 \n」的根因就在这里：
 * 主进程按"连发短消息"把回复切成 N 段并用 `\n\n` 连接，而抽屉以前把整段塞进
 * 一个气泡里渲染 —— 段落变成了空行。这些用例钉住"空行 = 一条独立气泡"。
 */
describe('splitReplyBubbles — 空行是气泡边界', () => {
  it('整形过的回复（\\n\\n 连接）切成多条气泡', () => {
    expect(splitReplyBubbles('在的\n\n怎么了\n\n刚下课')).toEqual(['在的', '怎么了', '刚下课'])
  })

  it('单个换行留在气泡内部（微信里一条消息本来就能是多行）', () => {
    expect(splitReplyBubbles('第一行\n第二行')).toEqual(['第一行\n第二行'])
  })

  it('连续空行与行尾空格不会产生空气泡', () => {
    expect(splitReplyBubbles('a\n\n\n\n   \n\nb')).toEqual(['a', 'b'])
    expect(splitReplyBubbles('  a  \n\n  b  ')).toEqual(['a', 'b'])
  })

  it('空内容返回空数组，调用方负责兜底', () => {
    expect(splitReplyBubbles('')).toEqual([])
    expect(splitReplyBubbles('   \n\n  ')).toEqual([])
  })

  it('undefined / null 不抛异常（历史对话里可能有残缺轮次）', () => {
    expect(splitReplyBubbles(undefined as unknown as string)).toEqual([])
    expect(splitReplyBubbles(null as unknown as string)).toEqual([])
  })
})
