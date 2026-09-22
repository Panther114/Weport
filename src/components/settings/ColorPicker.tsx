import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, Pipette } from 'lucide-react'
import FloatingLayer from '../ui/FloatingLayer'
import { COLOR_PALETTE, normalizeGlassHex } from '../../utils/notificationGlass'
import { contrastTextOn, hexToHsv, hsvToHex, type Hsv } from '../../utils/colorPicker'

/**
 * 通知玻璃设置面板里的取色器（v1.0.1）。
 *
 * 替代 `<input type="color">`。原来那个是系统模态色板：30×24 的小方块、点开是一个
 * 与页面毫无关系的 Windows 对话框、没有 hex 输入、没有预设、没有取色管 —— 用户说
 * "the color selection menu is also very cheap"。用户要的是"能用的色板选择器"，
 * 所以这里给全四样：
 *
 *   1. **大的触发行**：48×28 的色块 + 十六进制文本，一眼看出当前是什么颜色；
 *   2. **面板内浮层**：SV 区（拖拽选饱和度/明度）+ 色相条 + hex 输入 + 取色管；
 *   3. **快捷色板**：24 个按"浅/中/深"三行排好的色块，点一下即用；
 *   4. 触发按钮本身足够大（32px 高），不再是一颗几乎点不到的方块。
 *
 * 数值路径：交互期间以 HSV 为准（色相不会因为饱和度归零而丢失），对外只抛
 * `#rrggbb`。外部传入的值变化时会回灌（比如"渐变左右互换"按钮）。
 */

interface ColorPickerProps {
    value: string
    onChange: (hex: string) => void
    /** 无障碍标签，同时作为浮层标题 */
    label: string
    disabled?: boolean
    /** 紧凑模式：只显示色块（渐变的两个端点并排时用） */
    compact?: boolean
}

interface EyeDropperCtor {
    new (): { open: () => Promise<{ sRGBHex: string }> }
}

function eyeDropperCtor(): EyeDropperCtor | null {
    const ctor = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper
    return typeof ctor === 'function' ? ctor : null
}

export function ColorPicker({ value, onChange, label, disabled, compact }: ColorPickerProps) {
    const current = normalizeGlassHex(value) || '#ffffff'
    const [open, setOpen] = useState(false)
    const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(current))
    const [draft, setDraft] = useState(current)
    const rootRef = useRef<HTMLDivElement>(null)
    const popRef = useRef<HTMLDivElement>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const svRef = useRef<HTMLDivElement>(null)
    const dialogId = useId()

    // 外部值变化（互换渐变两端、预设、恢复默认）时回灌内部 HSV
    useEffect(() => {
        if (hsvToHex(hsv) === current) return
        setHsv(hexToHsv(current))
        setDraft(current)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [current])

    useEffect(() => {
        if (!open) return
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as Node
            // 浮层渲染在 body 下，**不在** rootRef 里：只检查 rootRef 会让面板
            // 在第一次点击自己的色板时就被关掉。
            if (rootRef.current?.contains(target) || popRef.current?.contains(target)) return
            setOpen(false)
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open])

    const openPopover = useCallback(() => {
        setDraft(current)
        setOpen((prev) => !prev)
    }, [current])

    const commit = useCallback(
        (next: Hsv, opts?: { keepDraft?: boolean }) => {
            setHsv(next)
            const hex = hsvToHex(next)
            // 输入框正在被编辑时不要回写它的文本：用户打第 4 个字符时被整段替换成
            // 规范化后的值，光标会跳、后面的字符会接到错误的位置。
            if (!opts?.keepDraft) setDraft(hex)
            onChange(hex)
        },
        [onChange]
    )

    const pickFromPointer = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            const el = svRef.current
            if (!el) return
            const rect = el.getBoundingClientRect()
            const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
            const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
            commit({ h: hsv.h, s: Math.round(x * 100), v: Math.round((1 - y) * 100) })
        },
        [commit, hsv.h]
    )

    const onSvKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? 10 : 2
        const map: Record<string, [number, number]> = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, step],
            ArrowDown: [0, -step],
        }
        const delta = map[event.key]
        if (!delta) return
        event.preventDefault()
        commit({
            h: hsv.h,
            s: Math.min(100, Math.max(0, hsv.s + delta[0])),
            v: Math.min(100, Math.max(0, hsv.v + delta[1])),
        })
    }

    /** 输入框里只认 6 位；3 位简写在失焦/回车时补全，避免打字打到一半就被改写。 */
    const applyHexDraft = (text: string) => {
        const raw = text.replace(/^#/, '').slice(0, 6)
        setDraft(raw)
        if (/^[0-9a-f]{6}$/i.test(raw)) commit(hexToHsv(raw), { keepDraft: true })
    }

    const flushHexDraft = () => {
        const hex = normalizeGlassHex(draft)
        if (hex) {
            commit(hexToHsv(hex), { keepDraft: true })
            setDraft(hex)
        } else {
            setDraft(current)
        }
    }

    const useEyedropper = async () => {
        const Ctor = eyeDropperCtor()
        if (!Ctor) return
        try {
            const result = await new Ctor().open()
            const hex = normalizeGlassHex(result?.sRGBHex)
            if (hex) commit(hexToHsv(hex))
        } catch {
            /* 用户按 Esc 取消 —— 不是错误 */
        }
    }

    const solid = hsvToHex({ h: hsv.h, s: 100, v: 100 })
    const swatchText = contrastTextOn(current)

    return (
        <div className="ng-color" ref={rootRef}>
            <button
                ref={triggerRef}
                type="button"
                className="ng-color-trigger"
                data-compact={compact ? 'true' : undefined}
                disabled={disabled}
                aria-label={`${label}：${current}`}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? dialogId : undefined}
                onClick={openPopover}
            >
                <span className="ng-color-chip" style={{ background: current }}>
                    {/* 色块上的小字：浅色块配深字、深色块配浅字，色值本身永远读得出来 */}
                    {compact ? null : <span style={{ color: swatchText }}>{current.toUpperCase()}</span>}
                </span>
                {/* 紧凑模式也要有"可点"的样子：只有一个色块的话，它看起来像静态色板 */}
                <ChevronDown size={compact ? 11 : 14} aria-hidden />
            </button>

            {open && !disabled ? (
                /* 浮层渲染到 body 下（components/ui/FloatingLayer）：设置页的正文是
                   一个 overflow-y: auto 的滚动容器，挂在文档流里的浮层在最下面一行
                   会被整块裁掉，而且永远盖不过页面底部的东西。宽度与 `.ng-color-pop`
                   一致（236px），方向交给统一的翻转/夹边逻辑。 */
                <FloatingLayer
                    anchor={triggerRef}
                    open
                    placement="bottom-start"
                    gap={6}
                    width={236}
                    minHeight={200}
                    className="ng-color-layer"
                >
                    <div className="ng-color-pop" id={dialogId} ref={popRef} role="dialog" aria-label={`${label}取色器`}>
                    <div
                        ref={svRef}
                        className="ng-color-sv"
                        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${solid})` }}
                        role="slider"
                        tabIndex={0}
                        aria-label={`${label} 饱和度与明度`}
                        aria-valuetext={`饱和度 ${Math.round(hsv.s)}%，明度 ${Math.round(hsv.v)}%`}
                        onPointerDown={(event) => {
                            event.currentTarget.setPointerCapture(event.pointerId)
                            pickFromPointer(event)
                        }}
                        onPointerMove={(event) => {
                            if (event.currentTarget.hasPointerCapture(event.pointerId)) pickFromPointer(event)
                        }}
                        onKeyDown={onSvKeyDown}
                    >
                        <span
                            className="ng-color-sv-thumb"
                            style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, background: current }}
                        />
                    </div>

                    <div className="ng-color-hue-row">
                        <span className="ng-color-preview" style={{ background: current }} aria-hidden />
                        <input
                            className="ng-color-hue"
                            type="range"
                            min={0}
                            max={359}
                            value={hsv.h}
                            aria-label={`${label} 色相`}
                            onChange={(event) => commit({ ...hsv, h: Number(event.target.value) })}
                        />
                    </div>

                    <div className="ng-color-hex-row">
                        <span className="ng-color-hash" aria-hidden>#</span>
                        <input
                            className="ng-color-hex-input"
                            type="text"
                            spellCheck={false}
                            value={draft.replace(/^#/, '')}
                            aria-label={`${label} 十六进制色值`}
                            onChange={(event) => applyHexDraft(event.target.value)}
                            onBlur={flushHexDraft}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') event.currentTarget.blur()
                            }}
                        />
                        {eyeDropperCtor() ? (
                            <button type="button" className="ng-color-tool" title="从屏幕上取色" onClick={() => void useEyedropper()}>
                                <Pipette size={14} />
                            </button>
                        ) : null}
                    </div>

                    <div className="ng-color-palette" role="group" aria-label={`${label} 快捷色板`}>
                        {COLOR_PALETTE.map((row, rowIndex) => (
                            <div className="ng-color-palette-row" key={rowIndex}>
                                {row.map((hex) => (
                                    <button
                                        key={hex}
                                        type="button"
                                        className="ng-color-swatch"
                                        style={{ background: hex }}
                                        data-active={hex.toLowerCase() === current}
                                        title={hex.toUpperCase()}
                                        aria-label={hex.toUpperCase()}
                                        aria-pressed={hex.toLowerCase() === current}
                                        onClick={() => commit(hexToHsv(hex))}
                                    />
                                ))}
                            </div>
                        ))}
                    </div>
                    </div>
                </FloatingLayer>
            ) : null}
        </div>
    )
}
