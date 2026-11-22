import { describe, expect, it } from 'vitest'
import {
  WECLONE_STYLES,
  WECLONE_STYLE_NOTE_MAX_CHARS,
  normalizeWeCloneStyle,
  normalizeWeCloneStyleNote,
  weCloneStyleAnchor,
  weCloneStyleInstruction,
  weCloneStyleOption,
} from './weCloneStyle'

describe('WeClone style presets', () => {
  it('keeps the six requested presets and a stable label for each', () => {
    expect(WECLONE_STYLES.map((item) => item.id)).toEqual([
      'original', 'relaxed', 'gentle', 'humorous', 'concise', 'earnest',
    ])
    expect(WECLONE_STYLES.map((item) => item.label)).toEqual([
      '保持原样', '自然轻松', '温柔', '幽默', '简洁', '认真',
    ])
  })

  it('falls back to 保持原样 for unknown values', () => {
    expect(normalizeWeCloneStyle(undefined)).toBe('original')
    expect(normalizeWeCloneStyle('')).toBe('original')
    expect(normalizeWeCloneStyle('angry')).toBe('original')
    expect(normalizeWeCloneStyle('gentle')).toBe('gentle')
  })

  it('produces no section when the style is original and there is no note', () => {
    expect(weCloneStyleInstruction('original', '')).toBe('')
    expect(weCloneStyleInstruction('original', '   ')).toBe('')
  })

  it('includes a note even for the original preset', () => {
    const text = weCloneStyleInstruction('original', '少用感叹号')
    expect(text).toContain('少用感叹号')
    expect(text).toContain('只改怎么说')
    expect(text).toContain('不要复读要求里的原话')
  })

  it('writes every style as criteria, never as an example line to copy', () => {
    for (const option of WECLONE_STYLES) {
      const text = weCloneStyleInstruction(option.id, '')
      if (option.id === 'original') {
        expect(text).toBe('')
        continue
      }
      expect(text).toContain(option.instruction)
      // 项目红线：不能出现带引号的预设台词 / 示例句。
      expect(text).not.toMatch(/例如[:：]/)
      expect(text).not.toContain('“')
    }
  })

  it('truncates the free-form note and normalises newlines', () => {
    const note = normalizeWeCloneStyleNote(`a\r\nb${'x'.repeat(400)}`)
    expect(note.startsWith('a\nb')).toBe(true)
    expect(note.length).toBe(WECLONE_STYLE_NOTE_MAX_CHARS)
  })

  it('exposes a short anchor only for styles that change delivery', () => {
    expect(weCloneStyleAnchor('original')).toBe('')
    expect(weCloneStyleAnchor('gentle')).toContain('温柔')
    expect(weCloneStyleAnchor('humorous')).toContain('玩笑')
    expect(weCloneStyleOption('missing').id).toBe('original')
  })
})
