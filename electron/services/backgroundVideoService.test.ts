import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_VIDEO_QUALITY_DEFAULT,
  BACKGROUND_VIDEO_QUALITY_OPTIONS,
  BLUR_FORCES_BALANCED_PX,
  isBackgroundVideoQuality,
  longEdgeForQuality,
  resolveEffectiveQuality,
  type BackgroundVideoQuality
} from './backgroundVideoService'

/**
 * 背景视频画质档位。
 *
 * 用户的要求（逐字）：三档分辨率（原生 / 当前默认 / 更省），**默认是当前那一档**；
 * 并且"如果背景模糊至少 4 像素，就总是自动降到较低的档位 —— 更高的模糊下
 * 高分辨率没有意义，纯属浪费"。
 *
 * 这些是纯函数断言：不启动 Electron、不碰屏幕捕获、不看时序，每次跑都必须成立。
 *
 * **不要从这个文件 import `src/**`。** `tsconfig.node.json` 只覆盖
 * `vite.config.mts` + `electron/**`，且 `lib: ["ES2022"]` **刻意不含 DOM** ——
 * 那是为了让主进程代码里出现 `document`/`window` 时直接编译失败。一旦这里
 * import 一个渲染层模块，就会把 DOM 依赖拖进这个工程，报出 17 条
 * "Cannot find name 'window'"。渲染层镜像的那份常量由
 * `src/utils/appearanceVideoTier.test.ts` 独立断言同一个字面量 ——
 * 两侧各自钉住 4，任何一边改了而另一边没改，都会有一边红。
 */

describe('背景视频档位：模糊 ≥4px 自动降级', () => {
  it('阈值就是 4px（源文件里写死；渲染层那份由 appearanceVideoTier.test.ts 独立断言同一个数）', () => {
    expect(BLUR_FORCES_BALANCED_PX).toBe(4)
  })

  it('模糊 <4px 时尊重用户选择，不降级', () => {
    for (const blur of [0, 1, 2, 3]) {
      for (const quality of ['native', 'balanced', 'compact'] as BackgroundVideoQuality[]) {
        const result = resolveEffectiveQuality(quality, blur)
        expect(result.quality, `${quality}@${blur}px`).toBe(quality)
        expect(result.demoted, `${quality}@${blur}px`).toBe(false)
      }
    }
  })

  it('模糊 ≥4px 时 native 被压回 balanced，并如实报告 demoted', () => {
    for (const blur of [4, 5, 12, 40]) {
      const result = resolveEffectiveQuality('native', blur)
      expect(result.quality, `@${blur}px`).toBe('balanced')
      expect(result.demoted, `@${blur}px`).toBe(true)
    }
  })

  it('只降不升：balanced / compact 在任意模糊下都不动', () => {
    for (const blob of [0, 4, 40]) {
      expect(resolveEffectiveQuality('balanced', blob)).toEqual({ quality: 'balanced', demoted: false })
      // compact 本来就更低，模糊再大也没有"降到"它的理由 —— 更不该被升到 balanced
      expect(resolveEffectiveQuality('compact', blob)).toEqual({ quality: 'compact', demoted: false })
    }
  })

  it('脏输入一律按"没有模糊"处理：不抛错、也不误降级', () => {
    // 只有有限数才参与比较（Number.isFinite 守卫）。NaN / Infinity / 负数 / 非数
    // 都当成"没有模糊信息"—— 对垃圾输入保持用户的选择，比猜一个降级更安全。
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5, undefined as unknown as number, 'x' as unknown as number]) {
      const result = resolveEffectiveQuality('native', bad)
      expect(result.quality, String(bad)).toBe('native')
      expect(result.demoted, String(bad)).toBe(false)
    }
  })
})

describe('背景视频档位：取值与说明', () => {
  it('默认档是 balanced（＝改动前的旧行为，用户明确要求保持默认）', () => {
    expect(BACKGROUND_VIDEO_QUALITY_DEFAULT).toBe('balanced')
  })

  it('恰好三档，且每档都有中文名与说明', () => {
    expect(BACKGROUND_VIDEO_QUALITY_OPTIONS).toHaveLength(3)
    expect(BACKGROUND_VIDEO_QUALITY_OPTIONS.map((o) => o.id)).toEqual(['native', 'balanced', 'compact'])
    for (const option of BACKGROUND_VIDEO_QUALITY_OPTIONS) {
      expect(option.label, option.id).toBeTruthy()
      expect(option.hint.length, option.id).toBeGreaterThan(10)
    }
  })

  it('isBackgroundVideoQuality 只认真实档位', () => {
    for (const good of ['native', 'balanced', 'compact']) {
      expect(isBackgroundVideoQuality(good)).toBe(true)
    }
    for (const bad of ['', 'high', 'Native', 0, null, undefined, {}, []]) {
      expect(isBackgroundVideoQuality(bad), String(bad)).toBe(false)
    }
  })

  it('长边目标单调：compact < balanced ≤ native，且都落在合理范围', () => {
    // 在 vitest 里没有 Electron 的 screen，longEdgeForQuality 会走"取不到屏幕信息"
    // 的兜底分支 —— 那正是这里要固定的行为（旧版也是这么兜底的）。
    const native = longEdgeForQuality('native')
    const balanced = longEdgeForQuality('balanced')
    const compact = longEdgeForQuality('compact')
    expect(compact).toBeLessThan(balanced)
    expect(balanced).toBeLessThanOrEqual(native)
    // 下限：再低就会在模糊/遮罩下看出软化
    expect(compact).toBeGreaterThanOrEqual(854)
    expect(balanced).toBeGreaterThanOrEqual(1280)
    expect(native).toBeGreaterThanOrEqual(1280)
    // 上限：native 允许到 4K，balanced 封在 1920
    expect(native).toBeLessThanOrEqual(3840)
    expect(balanced).toBeLessThanOrEqual(1920)
    expect(compact).toBeLessThanOrEqual(1280)
  })
})
