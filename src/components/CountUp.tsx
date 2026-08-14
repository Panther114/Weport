import { useEffect, useRef, useState } from 'react'

interface CountUpProps {
  value: number
  duration?: number
  format?: (n: number) => string
  className?: string
}

/**
 * 数字滚动动画：首次进入视口时从 0 计数到目标值。
 * - 已在视口内 → 立即开始（不依赖 IntersectionObserver 回调时机）
 * - 数据后到 → 直接呈现新值，不重播（先取消旧动画帧，避免被旧循环覆盖）
 * - 尊重 prefers-reduced-motion（直接呈现终值）
 */
export const CountUp: React.FC<CountUpProps> = ({ value, duration = 700, format, className }) => {
  const [display, setDisplay] = useState(value)
  const ref = useRef<HTMLSpanElement>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(value)
      return
    }
    if (startedRef.current) {
      // 旧动画循环已由 cleanup 取消，直接呈现最新值
      setDisplay(value)
      return
    }

    let rafId = 0
    const run = (from: number) => {
      startedRef.current = true
      const start = performance.now()
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration)
        const eased = 1 - Math.pow(1 - t, 3)
        setDisplay(from + (value - from) * eased)
        if (t < 1) rafId = requestAnimationFrame(tick)
        else setDisplay(value)
      }
      rafId = requestAnimationFrame(tick)
    }

    // 已在视口内：立即播放；否则等进入视口再播
    const rect = node.getBoundingClientRect()
    const inViewport = rect.top < window.innerHeight && rect.bottom > 0 && rect.width > 0
    if (inViewport) {
      run(0)
    } else {
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) {
            run(0)
            observer.disconnect()
          }
        },
        { threshold: 0.2 },
      )
      observer.observe(node)
      return () => {
        cancelAnimationFrame(rafId)
        observer.disconnect()
      }
    }
    return () => cancelAnimationFrame(rafId)
  }, [value, duration])

  return (
    <span ref={ref} className={className}>
      {format ? format(Math.round(display)) : Math.round(display).toLocaleString('zh-CN')}
    </span>
  )
}
