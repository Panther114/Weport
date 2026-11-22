import { describe, expect, it } from 'vitest'
import { FONT_MODE_OPTIONS, normalizeFontFamily } from './appearance'

describe('page font settings', () => {
  it('offers the bundled default, system fonts and custom files', () => {
    expect(FONT_MODE_OPTIONS.map((option) => option.id)).toEqual(['default', 'system', 'custom'])
    expect(FONT_MODE_OPTIONS[0].hint).toContain('仓耳今楷')
  })

  it('sanitises a system font family before it is put into --font', () => {
    expect(normalizeFontFamily('  PingFang   SC  ')).toBe('PingFang SC')
    expect(normalizeFontFamily('"Microsoft YaHei"; color: red')).toBe('Microsoft YaHei color: red')
    expect(normalizeFontFamily('A\\B{C},D')).toBe('ABCD')
    expect(normalizeFontFamily('x'.repeat(200))).toHaveLength(80)
    expect(normalizeFontFamily(undefined)).toBe('')
  })
})
