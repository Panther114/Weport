import { describe, expect, it } from 'vitest'
import { renderTable, statCards } from '../../packages/weport-tui/src/render'
import { composeFrame, displayWidth, Paint, stripAnsi, truncate } from '../../packages/weport-tui/src/terminal'

describe('TUI rendered column widths', () => {
  it.each([false, true])('clips table values with colors enabled=%s', enabled => {
    const paint = new Paint(enabled)
    const lines = renderTable([{ name: 'A long contact name with 中文文字', count: '123' }], [
      { title: '名称', width: 12, value: row => row.name, styled: (row, p) => p.accent(row.name) },
      { title: '消息', width: 6, align: 'right', value: row => row.count },
    ], 20, paint)
    for (const line of lines) expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(20)
    expect(stripAnsi(lines[1])).toMatch(/123$/)
  })

  it('keeps colored card rows aligned to their borders', () => {
    const lines = statCards([{ label: '会话', value: '123' }, { label: '消息', value: '456' }], 50, new Paint(true))
    expect(lines.map(line => displayWidth(stripAnsi(line)))).toEqual([50, 50, 50])
  })

  it('measures and truncates ANSI text without breaking its visible content', () => {
    const text = new Paint(true).accent('中文abcdef')
    expect(displayWidth(text)).toBe(10)
    expect(stripAnsi(truncate(text, 6))).toBe('中文ab')
    expect(displayWidth(stripAnsi(truncate(text, 6)))).toBe(6)
  })

  it('fits a narrow pane even when every column is shorter than eight cells', () => {
    const lines = renderTable([{ value: 'abcdef' }], Array.from({ length: 3 }, () => ({
      title: '标题', width: 6, value: (row: { value: string }) => row.value,
    })), 15, new Paint(true))
    for (const line of lines) expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(15)
  })

  it('produces a plain-text dump without cursor-control bytes', () => {
    const plain = stripAnsi(composeFrame(['中文 frame'], 40, 8))
    expect(plain).not.toContain('\u001b')
    expect(plain.split('\r\n').map(displayWidth)).toEqual(Array(8).fill(40))
  })
})
