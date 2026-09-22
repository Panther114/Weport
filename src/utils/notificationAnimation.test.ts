import { describe, expect, it } from 'vitest'
import {
  NOTIFICATION_CLASSIC_OUT_MS,
  NOTIFICATION_REVEAL_FALLBACK_MS,
  NOTIFICATION_SLIDE_IN_MS,
  NOTIFICATION_SLIDE_OUT_MS,
  notificationExitMs,
  normalizeNotificationAnimationStyle,
  slideFromPosition,
} from './notificationAnimation'

/**
 * 起因是用户的要求：「滑进来的方向要按弹窗在屏幕上的位置来 —— 左上角就往右滑进来，
 * 居中在顶部就往下滑」。方向算错 = 卡片从错误的一侧飞进来，而这个错误在
 * "只看右边那两种位置"的手测里完全看不出来。
 */
describe('slideFromPosition — 位置决定从哪条边滑入', () => {
  it('右边的两个角从右边滑入', () => {
    expect(slideFromPosition('top-right')).toBe('right')
    expect(slideFromPosition('bottom-right')).toBe('right')
  })

  it('左边的两个角从左边滑入', () => {
    expect(slideFromPosition('top-left')).toBe('left')
    expect(slideFromPosition('bottom-left')).toBe('left')
  })

  it('顶部居中从上边滑下（这个位置没有"最近的水平边"）', () => {
    expect(slideFromPosition('top-center')).toBe('top')
  })

  it('未知/缺失的值退回默认（右边），绝不让卡片不动', () => {
    expect(slideFromPosition(undefined)).toBe('right')
    expect(slideFromPosition('')).toBe('right')
    expect(slideFromPosition('middle-of-nowhere')).toBe('right')
  })
})

describe('normalizeNotificationAnimationStyle — 只有显式的 classic 才是旧动效', () => {
  it('缺省/未知 → slide（用户要的新动效是默认）', () => {
    expect(normalizeNotificationAnimationStyle(undefined)).toBe('slide')
    expect(normalizeNotificationAnimationStyle(null)).toBe('slide')
    expect(normalizeNotificationAnimationStyle('')).toBe('slide')
    expect(normalizeNotificationAnimationStyle('fancy')).toBe('slide')
  })

  it('显式 classic 保留', () => {
    expect(normalizeNotificationAnimationStyle('classic')).toBe('classic')
  })
})

describe('notificationExitMs — 关窗要等退场动画跑完', () => {
  it('滑动与经典动效各自的退场时长都要等足', () => {
    expect(notificationExitMs('slide', true)).toBe(NOTIFICATION_SLIDE_OUT_MS)
    expect(notificationExitMs('classic', true)).toBe(NOTIFICATION_CLASSIC_OUT_MS)
  })

  it('关掉动效时不必等', () => {
    expect(notificationExitMs('slide', false)).toBe(0)
    expect(notificationExitMs('classic', false)).toBe(0)
  })

  it('入场必须比退场慢，否则看起来像被弹走（用户："应该更慢"）', () => {
    expect(NOTIFICATION_SLIDE_IN_MS).toBeGreaterThan(NOTIFICATION_SLIDE_OUT_MS)
    // 入场要"看得见位移"：至少 0.9s，否则 380px 的行程会糊成一次闪动
    expect(NOTIFICATION_SLIDE_IN_MS).toBeGreaterThanOrEqual(900)
  })

  it('等待"窗口已显示"的兜底不能太久（那是每条通知的额外延迟上限）', () => {
    expect(NOTIFICATION_REVEAL_FALLBACK_MS).toBeGreaterThan(0)
    expect(NOTIFICATION_REVEAL_FALLBACK_MS).toBeLessThanOrEqual(500)
  })
})
