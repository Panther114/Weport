/**
 * 弹窗延迟追踪（`WEPORT_POPUP_TRACE=1`）。
 *
 * 为什么需要它：用户反馈「弹窗卡顿」，而「卡」有两种完全不同的原因 ——
 * **出现得晚**（延迟）和**画得不匀**（掉帧）。`npm run bench` 只量到弹窗的
 * 帧间隔（p95 17.7ms，不掉帧）与「窗口创建 / 首帧卡片」两个总数，看不出
 * 那一秒花在哪一段。这条追踪把路径上的每一步都打上单调时间戳，
 * `.ui-probe/probe-popup-latency.mjs` 直接把差值列成表。
 *
 * 只在显式打开环境变量时输出，默认零成本（一次布尔判断）。
 */

const startAt = Date.now()
let lastAt = startAt

export function popupTraceEnabled(): boolean {
  return process.env.WEPORT_POPUP_TRACE === '1'
}

/**
 * 打一个带「距上次标记」的时间戳。
 *
 * 相对上次而不是相对进程启动：弹窗路径上真正要看的是相邻两步之间的间隙
 * （例如 payload 发出 → 渲染层收到），绝对时间在几百毫秒的量级上没有意义。
 */
export function popupMark(label: string, detail?: Record<string, unknown>): void {
  if (!popupTraceEnabled()) return
  const now = Date.now()
  const delta = now - lastAt
  lastAt = now
  const suffix = detail && Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : ''
  console.log(`[popup-trace] +${String(delta).padStart(4)}ms  ${label}${suffix}  (t=${now - startAt}ms)`)
}
