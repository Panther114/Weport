import { describe, expect, it } from 'vitest'
import { computeFingerprint, isPipelineArtifact, matchesMarker, renderFingerprint } from './weCloneFingerprint'

describe('matchesMarker —— 短英文标记必须整词匹配', () => {
  it('`k` 不该被 like / work / ok 里的那个字母触发', () => {
    expect(matchesMarker('i like to work', 'k')).toBe(false)
    expect(matchesMarker('ok', 'k')).toBe(false)
    expect(matchesMarker('yea k', 'k')).toBe(true)
    expect(matchesMarker('k', 'k')).toBe(true)
  })

  it('`u` 不该被 use / you 触发', () => {
    expect(matchesMarker('i use it', 'u')).toBe(false)
    expect(matchesMarker('you there', 'u')).toBe(false)
    expect(matchesMarker('r u up', 'u')).toBe(true)
  })

  it('多字标记仍然按子串（`lmao` 在 `lmaoo` 里也该算）', () => {
    expect(matchesMarker('lmaooo', 'lmao')).toBe(true)
    expect(matchesMarker('笑死我了', '笑死')).toBe(true)
  })
})

describe('isPipelineArtifact —— 区分"他的习惯"与"我们管线的痕迹"', () => {
  it('脱敏占位符不算口癖', () => {
    expect(isPipelineArtifact('已脱敏')).toBe(true)
    expect(isPipelineArtifact('脱敏:住址')).toBe(true)
    expect(isPipelineArtifact('住址证件')).toBe(true)
    expect(isPipelineArtifact('已过滤')).toBe(true)
  })

  it('表情名与跨方括号的 n-gram 不算口癖', () => {
    expect(isPipelineArtifact('破涕为笑]')).toBe(true)
    expect(isPipelineArtifact('涕为笑][')).toBe(true)
    expect(isPipelineArtifact('笑][破涕')).toBe(true)
  })

  it('系统提示不算口癖', () => {
    expect(isPipelineArtifact('违规昵称f')).toBe(true)
  })

  it('真正属于他的片段要留下', () => {
    for (const good of ['嘿嘿嘿嘿嘿', '谢谢老师', '我已极苦我', '绷不住了', 'sehr gut']) {
      expect(isPipelineArtifact(good), good).toBe(false)
    }
  })
})

describe('computeFingerprint —— 在真实形状的小语料上的行为', () => {
  const corpus = [
    'i like to work on this',
    'ok',
    'yea k',
    'r u up',
    '嘿嘿嘿嘿嘿',
    '已脱敏:住址证件',
    '破涕为笑][破涕为笑]',
    '[Sob][Sob]',
    '绷不住了',
  ]

  it('不再把 like/work 算成 `k`，也不再把 `u` 算成 use/you', () => {
    const markers = computeFingerprint(corpus).markers.map((m) => m.token)
    // 标记表里可能出现 k / u（它们确实是他的用法），但计数必须只来自整词出现
    const f = computeFingerprint(corpus)
    const k = f.markers.find((m) => m.token === 'k')
    const u = f.markers.find((m) => m.token === 'u')
    // 9 条消息里整词 `k` 只有 1 次、`u` 只有 1 次 → 每百条 ≈ 11 次，而不是被 like/use 顶到几十次
    expect(k ? k.per100 : 0).toBeLessThanOrEqual(12)
    expect(u ? u.per100 : 0).toBeLessThanOrEqual(12)
    expect(markers).not.toContain('已脱敏')
  })

  it('高频片段里不再出现脱敏占位符与表情名', () => {
    const phrases = computeFingerprint(corpus).phrases.map((p) => p.text)
    for (const bad of ['已脱敏', '脱敏:住', '住址证件', '破涕为笑', '涕为笑']) {
      expect(phrases.some((p) => p.includes(bad)), bad).toBe(false)
    }
  })

  it('英文方括号表情现在计入表情比例（原来只认中文名，实测漏计）', () => {
    const f = computeFingerprint(['[Sob][Sob]', 'ok', 'ok', 'ok'])
    expect(f.emojiRatio).toBeGreaterThan(0)
  })

  it('渲染出的文本里不出现占位符', () => {
    const text = renderFingerprint(computeFingerprint(corpus))
    expect(text).not.toContain('已脱敏')
    expect(text).not.toContain('住址证件')
  })
})
