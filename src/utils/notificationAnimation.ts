/**
 * 通知弹窗的动效风格与方向（纯逻辑，有单测）。
 *
 * 用户要的是"从离它最近的那条屏幕边滑进来，再沿原路滑出去"，而不是旧版那种
 * "原地淡入 + 轻微缩小"（读起来像是卡了一下）。方向不能写死成"从右边"：
 * 弹窗位置有五个（四个角 + 顶部居中），卡片在左上角却从右边滑进来会非常违和。
 *
 * 映射规则（唯一真源）：
 *   top-right / bottom-right → 从**右**边滑入（水平）
 *   top-left / bottom-left   → 从**左**边滑入（水平）
 *   top-center               → 从**上**边滑下（垂直）
 *
 * 退场方向 = 入场方向的逆向。用户举的例子是"左上角 → 向右滑进来、再向左滑出去"，
 * 逆向正是这条规则；顶部居中则"向下滑入、向上滑出"。
 *
 * ## 为什么需要 `room`（弹窗窗口要比卡片大）
 *
 * 卡片是画在弹窗窗口里的，而窗口会裁掉自己外面的内容。窗口如果只有卡片那么大、
 * 又贴在离屏幕边 20px 的位置，卡片就只能从**屏幕内 20px 那条线**钻出来 ——
 * 用户看到的是"凭空冒出一小块"，而不是"从屏幕外面滑进来"（用户原话）。
 *
 * 所以滑动风格下窗口要按方向多留一段 `room`，那一段落在**屏幕之外**：
 * 卡片从屏幕外面开始，逐帧进入视野，整段位移都看得见。位移量固定是
 * `100% + NOTIFICATION_SLIDE_ROOM_PX`（100% = 卡片自身尺寸），刚好让卡片在起点
 * 完全落在屏幕外。主进程按同一个 `room` 放大窗口、并在动画结束后**收回**
 * （见 electron/windows/notificationWindow.ts 的 anchorPopup）。
 */

export type NotificationAnimationStyle = 'slide' | 'classic'

/** 卡片从哪条边进来（退场沿同一条边离开）。 */
export type NotificationSlideFrom = 'left' | 'right' | 'top'

export function normalizeNotificationAnimationStyle(value: unknown): NotificationAnimationStyle {
  return value === 'classic' ? 'classic' : 'slide'
}

export function slideFromPosition(position: unknown): NotificationSlideFrom {
  const value = String(position || '')
  if (value === 'top-left' || value === 'bottom-left') return 'left'
  if (value === 'top-center') return 'top'
  // top-right / bottom-right / 任何未知值：默认右边（也是默认位置）。
  return 'right'
}

/**
 * 时长（毫秒）。**必须与 NotificationWindow.scss / NotificationToast.scss 里写的
 * 数值一致** —— 这里的数字决定三件事：何时把窗口收回到卡片大小、退场动画跑完后
 * 多久真的关窗、原生玻璃面板何时上报几何。两边对不上的表现是"最后一帧被切掉"
 * 或者"卡片滑到一半窗口就缩了"。
 *
 * 用户的反馈是"要更慢、要从屏幕外慢慢出现"，所以入场比旧版慢了 2.5 倍：
 * 位移 ≈ 卡片宽 + 20px，用 1050ms 走完（约 360px/s），肉眼能看清它整段是从屏幕
 * 外面滑进来的，而不是"闪一下到位"。
 */
export const NOTIFICATION_SLIDE_IN_MS = 1050
export const NOTIFICATION_SLIDE_OUT_MS = 620
export const NOTIFICATION_CLASSIC_OUT_MS = 300

/**
 * 起点相对静止位置多出来的那一截 = 屏幕留白（主进程锚定弹窗用的 20px）。
 * 位移 = 卡片自身尺寸 + 它，正好让卡片在动画开始时完全在屏幕外。
 */
export const NOTIFICATION_SLIDE_ROOM_PX = 20

/**
 * 退场动画时长（`NotificationToast.dismiss()` 等它跑完再请求关窗）。
 * 关掉动效时是 0：没有动画就没有什么可等的。
 */
export function notificationExitMs(style: NotificationAnimationStyle, animationEnabled: boolean): number {
  if (!animationEnabled) return 0
  return style === 'slide' ? NOTIFICATION_SLIDE_OUT_MS : NOTIFICATION_CLASSIC_OUT_MS
}

/**
 * 等主进程「窗口已显示」信号的最长时间。
 *
 * 主进程在 `showInactive()` 之后立刻发这个信号，入场动画从那一刻才起跑。
 * 信号万一没到（旧版主进程 / 渲染进程重建），通知不能因此不动：超时后自己起跑。
 */
export const NOTIFICATION_REVEAL_FALLBACK_MS = 400
