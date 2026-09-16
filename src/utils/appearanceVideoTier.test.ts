import { describe, expect, it } from 'vitest'
import { BLUR_FORCES_BALANCED_PX, VIDEO_QUALITY_OPTIONS, APPEARANCE_DEFAULT } from './appearance'

/**
 * 渲染层这一份"背景视频档位"契约。
 *
 * 为什么单独一个文件：只有**主进程**知道显示器的设备像素宽度与真实生效的档位，
 * 所以阈值规则实现了两遍 —— 主进程在
 * `electron/services/backgroundVideoService.ts`（权威），渲染层在这里镜像一份
 * 好让界面立刻给出反馈。两份一旦漂移，设置页的说明就会与实际行为矛盾。
 *
 * 两边**不能互相 import**：`tsconfig.node.json` 只覆盖 `vite.config.mts` +
 * `electron/**`，并且 `lib: ["ES2022"]` 刻意不含 DOM（这样主进程代码里出现
 * `window`/`document` 会直接编译失败）。electron 侧那份测试 import 这个文件会
 * 报 17 条 "Cannot find name 'window'"。所以两侧各自把同一个字面量钉死：
 * 任何一边改了而另一边没改，都会有一边的测试变红。
 *
 * 权威实现在 electron 侧；改这个数必须同时改 `electron/services/backgroundVideoService.ts`
 * 的 `BLUR_FORCES_BALANCED_PX` 以及它的测试。
 */
describe('背景视频档位：渲染层镜像的契约', () => {
  it('阈值与主进程一致（同为 4px）', () => {
    expect(BLUR_FORCES_BALANCED_PX).toBe(4)
  })

  it('恰好三档，id 与主进程的 BackgroundVideoQuality 同名', () => {
    expect(VIDEO_QUALITY_OPTIONS.map((o) => o.id)).toEqual(['native', 'balanced', 'compact'])
  })

  it('默认档是 balanced —— 用户明确要求"默认保持当前这一档"', () => {
    expect(APPEARANCE_DEFAULT.videoQuality).toBe('balanced')
    // 新装/读不到配置时的显示值也必须自洽，否则设置页会显示成"已降级"
    expect(APPEARANCE_DEFAULT.videoQualityEffective).toBe('balanced')
    expect(APPEARANCE_DEFAULT.videoQualityDemoted).toBe(false)
    expect(APPEARANCE_DEFAULT.videoDecodeEdge).toBe(0)
  })

  it('默认背景模糊是 4px —— 正好落在阈值上，且非零（用户要求默认有模糊）', () => {
    expect(APPEARANCE_DEFAULT.backgroundBlur).toBe(4)
    expect(APPEARANCE_DEFAULT.backgroundBlur).toBeGreaterThanOrEqual(BLUR_FORCES_BALANCED_PX)
  })

  it('每档都有中文名与非空说明（设置页要直接展示）', () => {
    for (const option of VIDEO_QUALITY_OPTIONS) {
      expect(option.label, option.id).toBeTruthy()
      expect(option.hint.length, option.id).toBeGreaterThan(10)
    }
  })
})
