import { describe, expect, it } from 'vitest'
import { checkGeneratedMds, checkTimeline } from './mdQualityGate'

/** 真实事故：830 字节、把指纹统计原样抄了一遍、一条日期都没有 */
const HOLLOW_TIMELINE = `# timeline.md

## 统计口径（与本地统计事实一致）
- 样本：本人发出的 32,227 条纯文本消息，来自 184 个会话。
- 单条长度：平均 23.7 字，中位数 14 字，最长 1990 字；1-3 字占 16%、4-8 字占 19%。
- 标点：82% 的消息完全不带标点；3% 以句末标点收尾。
- 每 100 条里出现次数最多的标记：u 30.7、k 20.5、ok 6.6、ur 5.2。
- 反复出现的中文片段：谢谢老师、老师好，、好的老师、我感觉、是不是。`

const GOOD_TIMELINE = `# timeline.md

## 2026-03
3 月主要在赶 PA website，2026-03-16 问过 monthly mock 安排。3 月底开始备考。
## 2026-04
2026-04-01 约饭（老盛昌）。2026-04-12 评价 IDX 项目。2026-04-24 群里给模型起名。
## 2026-05
2026-05-02 成绩出来 6.0/6.0。2026-05-09 私聊降价。2026-05-11 汇报 gchat v1.2 进度。
## 2026-06
2026-06-01 讨论周末安排。2026-06-22 找老师查成绩。
## 2026-07
2026-07-11 周末不能打游戏的硬约束。2026-07-22 让工具只选 opencode go。
## 2026-08
2026-08-02 跑四小时 /goal。2026-08-13 给 filehelper 发需求。2026-08-26 开学考。
## 2026-09
2026-09-04 反复吐槽 led comp。2026-09-14 只剩卧槽、绷不住了。
`.padEnd(900, '（细节略）')

describe('checkTimeline —— 拦住"没有时间线的时间线"', () => {
  it('真实事故（830 字节的统计回声）必须被拦住', () => {
    const r = checkTimeline(HOLLOW_TIMELINE)
    expect(r.ok).toBe(false)
    expect(String(r.reason)).toMatch(/空壳|日期|回升|回声/)
  })

  it('正常的大事记要放行', () => {
    expect(checkTimeline(GOOD_TIMELINE).ok).toBe(true)
  })

  it('有日期但整篇复述统计量 → 仍然拦住', () => {
    const echo = `${HOLLOW_TIMELINE}\n再补几个日期：2026-05、2026-06、2026-07。`
    expect(checkTimeline(echo).ok).toBe(false)
  })

  it('够长但没有日期线索 → 拦住', () => {
    expect(checkTimeline('正文'.repeat(400)).ok).toBe(false)
  })

  it('空内容拦住而不是抛错', () => {
    expect(checkTimeline('').ok).toBe(false)
  })
})

describe('checkGeneratedMds —— 整体门禁', () => {
  const good = {
    profile: '画像'.repeat(200),
    relationships: '关系'.repeat(200),
    knowledge: '知识'.repeat(200),
    timeline: GOOD_TIMELINE,
    language: '语气'.repeat(200),
  }

  it('五份都正常 → 放行', () => {
    const r = checkGeneratedMds(good)
    expect(r.ok).toBe(true)
    expect(r.failed).toHaveLength(0)
  })

  it('时间线是空壳 → 必须中止（否则会把旧克隆覆盖掉）', () => {
    const r = checkGeneratedMds({ ...good, timeline: HOLLOW_TIMELINE })
    expect(r.ok).toBe(false)
    expect(r.failed.map((f) => f.key)).toEqual(['timeline'])
  })

  it('任意一份过短（<200 字）→ 中止', () => {
    const r = checkGeneratedMds({ ...good, knowledge: '太短了' })
    expect(r.ok).toBe(false)
    expect(r.failed.map((f) => f.key)).toContain('knowledge')
  })

  it('漏出脱敏占位符只警告、不拦截（避免误挡用户生成）', () => {
    const r = checkGeneratedMds({ ...good, profile: `${'画像'.repeat(200)}[已脱敏:住址证件]` })
    expect(r.ok).toBe(true)
    expect(r.warned.map((w) => w.key)).toContain('profile')
  })

  it('空对象不炸（缺文件由调用方处理）', () => {
    expect(checkGeneratedMds({}).ok).toBe(true)
  })
})
