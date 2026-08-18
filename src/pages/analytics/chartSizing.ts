import { useLayoutEffect, useRef, useState } from 'react'

export const fixedGapBarWidth = (
  containerWidth: number,
  itemCount: number,
  gap = 10,
  minWidth = 6,
  maxWidth = 96,
) => {
  const count = Math.max(1, itemCount)
  const usableWidth = Math.max(0, containerWidth - gap * Math.max(0, count - 1))
  return Math.max(minWidth, Math.min(maxWidth, Math.floor(usableWidth / count)))
}

export const useMeasuredBarWidth = (itemCount: number, gap = 10, minWidth = 6, maxWidth = 96) => {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return

    const measure = () => setWidth(node.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [itemCount])

  return {
    ref,
    barWidth: fixedGapBarWidth(width, itemCount, gap, minWidth, maxWidth),
    barCategoryGap: gap,
  }
}
