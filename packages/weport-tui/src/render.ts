/**
 * Rendering helpers shared by every view.
 *
 * The table renderer is width-aware in the CJK sense (a Chinese glyph is two
 * columns), and it decides column widths from the *content* rather than from fixed
 * numbers, so a narrow terminal degrades by truncating the widest column instead of
 * wrapping into an unreadable mess.
 */
import { Paint, displayWidth, padEnd, padStart, truncate, wrapText } from './terminal.js'

export interface Column<T> {
  title: string
  /** Fixed width in columns; omitted means "size from content, up to max". */
  width?: number
  max?: number
  align?: 'left' | 'right'
  value: (row: T) => string
  /** Painted value for display (defaults to `value`). */
  styled?: (row: T, paint: Paint) => string
}

export function renderTable<T>(rows: T[], columns: Column<T>[], width: number, paint: Paint): string[] {
  if (rows.length === 0) return [paint.muted('（没有数据）')]
  const widths = columns.map((column) => {
    if (column.width) return column.width
    const content = rows.reduce((max, row) => Math.max(max, displayWidth(column.value(row))), displayWidth(column.title))
    return Math.min(content, column.max ?? 48)
  })
  // Never let the sum exceed the pane: shrink the widest flexible column first.
  const gap = 2
  let total = widths.reduce((sum, value) => sum + value, 0) + gap * (columns.length - 1)
  while (total > width) {
    let widest = 0
    for (let index = 1; index < widths.length; index += 1) {
      if ((columns[index].max ?? 48) > (columns[widest].max ?? 48) && widths[index] > 8) widest = index
      else if (widths[index] > widths[widest] && widths[index] > 8) widest = index
    }
    if (widths[widest] <= 8) break
    widths[widest] -= 1
    total -= 1
  }

  const header = columns
    .map((column, index) => (column.align === 'right' ? padStart(column.title, widths[index]) : padEnd(column.title, widths[index])))
    .join(' '.repeat(gap))
  const lines = [paint.bold(paint.muted(header))]
  for (const row of rows) {
    const cells = columns.map((column, index) => {
      const text = column.value(row)
      const styled = column.styled ? column.styled(row, paint) : text
      const clipped = truncate(text, widths[index])
      const padding = widths[index] - displayWidth(clipped)
      if (column.align === 'right') return `${' '.repeat(Math.max(0, padding))}${styled}`
      return `${styled}${' '.repeat(Math.max(0, padding))}`
    })
    lines.push(cells.join(' '.repeat(gap)))
  }
  return lines
}

export function section(title: string, paint: Paint): string {
  return paint.bold(paint.accent(`── ${title} `))
}

export function keyValue(pairs: Array<[string, string]>, paint: Paint, indent = 0): string[] {
  const labelWidth = pairs.reduce((max, [label]) => Math.max(max, displayWidth(label)), 0)
  return pairs.map(([label, value]) => `${' '.repeat(indent)}${paint.muted(padEnd(label, labelWidth))}  ${value}`)
}

export function bullets(items: string[], width: number, paint: Paint): string[] {
  const lines: string[] = []
  for (const item of items) {
    const wrapped: string[] = wrapText(item, width - 2)
    wrapped.forEach((line, index) => lines.push(index === 0 ? `${paint.accent('•')} ${line}` : `  ${line}`))
  }
  return lines
}

/** `1699999999` → `2026-11-14 22:13`; 0/undefined → `—`. */
export function formatTime(seconds: number | undefined): string {
  const value = Number(seconds) || 0
  if (value <= 0) return '—'
  const millis = value > 1e12 ? value : value * 1000
  const date = new Date(millis)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatRelative(seconds: number | undefined): string {
  const value = Number(seconds) || 0
  if (value <= 0) return '—'
  const millis = value > 1e12 ? value : value * 1000
  const delta = Date.now() - millis
  const minutes = Math.round(delta / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  return formatTime(seconds).slice(0, 10)
}

export function formatCount(value: number | undefined): string {
  const n = Number(value) || 0
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** A thin box used for the overview's headline numbers. */
export function statCards(cards: Array<{ label: string; value: string; hint?: string }>, width: number, paint: Paint): string[] {
  const count = Math.max(1, Math.min(cards.length, Math.floor((width + 2) / 22)))
  const cardWidth = Math.floor((width - (count - 1) * 2) / count)
  const lines: string[] = []
  for (let start = 0; start < cards.length; start += count) {
    const slice = cards.slice(start, start + count)
    const top = slice.map(() => paint.muted(`┌${'─'.repeat(Math.max(0, cardWidth - 2))}┐`)).join('  ')
    const mid = slice
      .map((card) => `${paint.muted('│')} ${padEnd(paint.bold(card.value), cardWidth - 3)}${paint.muted('│')}`)
      .join('  ')
    const bottom = slice.map((card) => `${paint.muted('│')} ${padEnd(paint.muted(card.label), cardWidth - 3)}${paint.muted('│')}`).join('  ')
    lines.push(top, mid, bottom)
    if (slice.some((card) => card.hint)) {
      lines.push(slice.map((card) => `  ${padEnd(paint.muted(card.hint || ''), cardWidth - 2)}`).join('  '))
    }
  }
  return lines
}
