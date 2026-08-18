import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './AnalyticsWordCloud.scss'

export interface AnalyticsWordCloudItem {
  word: string
  count: number
}

export interface WordCloudLayoutItem extends AnalyticsWordCloudItem {
  left: number
  top: number
  width: number
  height: number
  fontSize: number
  fontWeight: number
  color: string
  opacity: number
}

export interface WordCloudLayout {
  placed: WordCloudLayoutItem[]
  overflow: AnalyticsWordCloudItem[]
}

export interface LayoutWordCloudOptions {
  width: number
  height: number
  maxWords?: number
  minFontSize?: number
  maxFontSize?: number
  palette?: readonly string[]
  padding?: number
  measureText?: (word: string, fontSize: number, fontWeight: number) => number
}

export interface AnalyticsWordCloudProps {
  words: readonly AnalyticsWordCloudItem[]
  maxWords?: number
  minFontSize?: number
  maxFontSize?: number
  palette?: readonly string[]
  label?: string
  listLabel?: string
  formatTooltip?: (item: AnalyticsWordCloudItem) => string
  selectedWord?: string
  onSelect?: (item: AnalyticsWordCloudItem) => void
  className?: string
}

const DEFAULT_PALETTE = ['var(--accent)', 'var(--accent-2)', 'var(--accent-3)', 'var(--accent-4)', 'var(--accent-5)', 'var(--accent-6)']
const DEFAULT_FONT_FAMILY = 'Weport, Segoe UI, Microsoft YaHei UI, Microsoft YaHei, system-ui, sans-serif'
const DEFAULT_SIZE = { width: 560, height: 300 }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function hashWord(word: string): number {
  let hash = 2166136261
  for (const character of word) {
    hash ^= character.codePointAt(0) || 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function fallbackTextWidth(word: string, fontSize: number): number {
  return Array.from(word).reduce((width, character) => {
    if (/\p{Script=Han}/u.test(character)) return width + fontSize
    if (/\s/u.test(character)) return width + fontSize * 0.32
    return width + fontSize * 0.58
  }, 0)
}

function createTextMeasurer(): NonNullable<LayoutWordCloudOptions['measureText']> {
  if (typeof document === 'undefined') return (word, fontSize) => fallbackTextWidth(word, fontSize)
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return (word, fontSize) => fallbackTextWidth(word, fontSize)
  return (word, fontSize, fontWeight) => {
    context.font = `${fontWeight} ${fontSize}px ${DEFAULT_FONT_FAMILY}`
    return context.measureText(word).width
  }
}

function normalizeItems(words: readonly AnalyticsWordCloudItem[], maxWords: number): AnalyticsWordCloudItem[] {
  const counts = new Map<string, number>()
  for (const item of words) {
    const word = String(item.word || '').trim()
    const count = Number(item.count)
    if (!word || !Number.isFinite(count) || count <= 0) continue
    counts.set(word, (counts.get(word) || 0) + count)
  }
  return Array.from(counts, ([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
    .slice(0, Math.max(0, Math.floor(maxWords)))
}

function overlaps(a: { left: number; top: number; width: number; height: number }, b: { left: number; top: number; width: number; height: number }, padding: number): boolean {
  return a.left - padding < b.left + b.width
    && a.left + a.width + padding > b.left
    && a.top - padding < b.top + b.height
    && a.top + a.height + padding > b.top
}

/** Deterministic, measured, collision-aware layout used by the React view. */
export function layoutWordCloud(items: readonly AnalyticsWordCloudItem[], options: LayoutWordCloudOptions): WordCloudLayout {
  const width = Math.max(1, options.width)
  const height = Math.max(1, options.height)
  const padding = Math.max(0, options.padding ?? 10)
  const minFontSize = Math.max(10, options.minFontSize ?? 14)
  const maxFontSize = Math.max(minFontSize, options.maxFontSize ?? 36)
  const palette = options.palette?.length ? options.palette : DEFAULT_PALETTE
  const normalized = normalizeItems(items, options.maxWords ?? 48)
  const maxCount = Math.max(1, ...normalized.map((item) => item.count))
  const measureText = options.measureText || createTextMeasurer()
  const placed: WordCloudLayoutItem[] = []
  const overflow: AnalyticsWordCloudItem[] = []
  const usableWidth = Math.max(1, width - padding * 2)
  const usableHeight = Math.max(1, height - padding * 2)

  for (const [index, item] of normalized.entries()) {
    const ratio = item.count / maxCount
    const fontWeight = ratio > 0.65 ? 700 : ratio > 0.3 ? 650 : 600
    let fontSize = Math.round(minFontSize + Math.pow(ratio, 0.68) * (maxFontSize - minFontSize))
    let textWidth = measureText(item.word, fontSize, fontWeight)
    while (textWidth + 16 > usableWidth && fontSize > minFontSize) {
      fontSize -= 1
      textWidth = measureText(item.word, fontSize, fontWeight)
    }

    const box = {
      left: 0,
      top: 0,
      width: Math.ceil(textWidth + 16),
      height: Math.ceil(fontSize * 1.35 + 8),
    }
    if (box.width > usableWidth || box.height > usableHeight) {
      overflow.push(item)
      continue
    }

    const seed = hashWord(`${item.word}:${index}`)
    const phase = (seed / 0xffffffff) * Math.PI * 2
    const maxRadius = Math.max(1, Math.min(usableWidth, usableHeight) * 0.48)
    let placedAt = false
    const attempts = index === 0 ? 1 : 760
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const radius = index === 0 ? 0 : Math.sqrt(attempt + 1) * 4.4
      const angle = phase + attempt * 2.399963229728653
      const x = width / 2 + Math.cos(angle) * radius * (usableWidth / Math.max(usableHeight, 1))
      const y = height / 2 + Math.sin(angle) * radius
      box.left = x - box.width / 2
      box.top = y - box.height / 2
      if (box.left < padding || box.top < padding || box.left + box.width > width - padding || box.top + box.height > height - padding) {
        if (radius > maxRadius) break
        continue
      }
      if (placed.every((existing) => !overlaps(box, existing, 4))) {
        placedAt = true
        break
      }
      if (radius > maxRadius) break
    }

    if (!placedAt) {
      overflow.push(item)
      continue
    }
    placed.push({
      ...item,
      ...box,
      fontSize,
      fontWeight,
      color: palette[index % palette.length],
      opacity: clamp(0.62 + ratio * 0.38, 0.62, 1),
    })
  }

  return { placed, overflow }
}

export const AnalyticsWordCloud: React.FC<AnalyticsWordCloudProps> = ({
  words,
  maxWords = 48,
  minFontSize = 14,
  maxFontSize = 36,
  palette = DEFAULT_PALETTE,
  label = '词频词云',
  listLabel = '查看词频列表',
  formatTooltip = (item) => `${item.word}，出现 ${item.count} 次`,
  selectedWord,
  onSelect,
  className,
}) => {
  const stageRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(DEFAULT_SIZE)
  const [activeWord, setActiveWord] = useState<string | null>(null)
  const [internalSelectedWord, setInternalSelectedWord] = useState<string | null>(null)
  const cloudId = useId().replace(/:/gu, '')
  const selected = selectedWord ?? internalSelectedWord
  const items = useMemo(() => normalizeItems(words, Number.MAX_SAFE_INTEGER), [words])

  useLayoutEffect(() => {
    const element = stageRef.current
    if (!element) return undefined
    const updateSize = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) setSize({ width: rect.width, height: rect.height })
    }
    updateSize()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(updateSize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const layout = useMemo(() => layoutWordCloud(items, {
    width: size.width,
    height: size.height,
    maxWords,
    minFontSize,
    maxFontSize,
    palette,
  }), [items, maxWords, minFontSize, maxFontSize, palette, size])

  const activeLayoutItem = layout.placed.find((item) => item.word === activeWord) || null
  const handleSelect = (item: AnalyticsWordCloudItem) => {
    if (selectedWord === undefined) setInternalSelectedWord((current) => current === item.word ? null : item.word)
    onSelect?.(item)
  }

  if (items.length === 0) {
    return <div className={`analytics-word-cloud${className ? ` ${className}` : ''}`} role="status">暂无词频数据</div>
  }

  return (
    <section className={`analytics-word-cloud${className ? ` ${className}` : ''}`} aria-label={label}>
      <div ref={stageRef} className="analytics-word-cloud__stage" role="group" aria-label={`${label}，可点击词语查看详情`}>
        {layout.placed.map((item) => {
          const isSelected = selected === item.word
          const isActive = activeWord === item.word
          return (
            <button
              key={item.word}
              type="button"
              className={`analytics-word-cloud__word${isSelected ? ' is-selected' : ''}`}
              style={{ left: item.left, top: item.top, width: item.width, height: item.height, fontSize: item.fontSize, fontWeight: item.fontWeight, color: item.color, opacity: item.opacity }}
              aria-label={formatTooltip(item)}
              aria-pressed={isSelected}
              aria-describedby={isActive ? `${cloudId}-tooltip` : undefined}
              title={formatTooltip(item)}
              onClick={() => handleSelect(item)}
              onFocus={() => setActiveWord(item.word)}
              onBlur={() => setActiveWord(null)}
              onMouseEnter={() => setActiveWord(item.word)}
              onMouseLeave={() => setActiveWord(null)}
            >
              {item.word}
            </button>
          )
        })}
        {activeLayoutItem && (
          <div id={`${cloudId}-tooltip`} className="analytics-word-cloud__tooltip" role="tooltip" style={{ left: activeLayoutItem.left + activeLayoutItem.width / 2, top: Math.max(28, activeLayoutItem.top - 8) }}>
            {formatTooltip(activeLayoutItem)}
          </div>
        )}
        {layout.placed.length === 0 && <div className="analytics-word-cloud__stage-empty">词语较少，暂时无法排布</div>}
      </div>

      <details className="analytics-word-cloud__list">
        <summary>{listLabel}</summary>
        <ol>
          {items.map((item) => (
            <li key={item.word}>
              <button type="button" aria-pressed={selected === item.word} onClick={() => handleSelect(item)}>
                <span>{item.word}</span>
                <span>{item.count}</span>
              </button>
            </li>
          ))}
        </ol>
      </details>
    </section>
  )
}

export default AnalyticsWordCloud
