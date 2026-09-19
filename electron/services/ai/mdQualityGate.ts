/**
 * 生成产物的**质量门禁**（纯函数，零依赖）。
 *
 * ## 它挡的是哪一个真实事故
 *
 * 第一份成功的克隆里，`timeline.md` 是 **830 字节**，内容是**把指纹统计原样抄了一遍**
 * —— 一条日期都没有。模型被要求写"按年份→月份的大事记"，结果交了一份统计表；
 * 而管线只检查"文件非空"，于是照样原子换名上线，界面上写的是"生成完成"。
 * 用户拿到的是一份**没有时间轴的记忆**：任何"什么时候发生的事"都只能靠编。
 *
 * 同一个文件在另一次生成里是 **48 KB**、内容正常 —— 也就是说这是**采样运气**，
 * 不是代码 bug，但它的后果是静默的。凡是"静默失败"都该有一道门禁。
 *
 * ## 判定尺度（宁可漏报，不要误报）
 *
 * 门禁误报会直接挡住用户生成，代价比放过一次坏产物更高。所以：
 *  - `fail` 只用于**能确凿识别**的空壳（无日期的"时间线"、纯统计回声、过短的档案）；
 *  - 其余一律 `warn`，只记录不拦截（比如漏出 `[已脱敏:` 占位符）。
 */

export interface MdCheck {
  key: string
  ok: boolean
  reason?: string
}

export interface MdGateResult {
  ok: boolean
  /** 确凿的空壳：必须中止（不要把旧克隆覆盖掉） */
  failed: MdCheck[]
  /** 可疑但不确凿：只记录 */
  warned: MdCheck[]
}

/** 日期线索：`2026-05` / `2026年5月` / `5月` / `2026/05` */
const DATE_RE = /(20\d{2}\s*[-/年]\s*\d{1,2}\s*月?|\d{1,2}\s*月)/g
/** "统计回声"的特征词（那份 830 字节的时间线里全是这些） */
const STATS_ECHO_RE = /统计口径|中位数\s*\d+|每 100 条|长度分布：/
/** 脱敏占位符漏进成品（只警告） */
const PLACEHOLDER_RE = /\[已(脱敏|过滤):/

export function checkTimeline(content: string): MdCheck {
  const text = String(content || '')
  const key = 'timeline'
  if (text.trim().length < 300) {
    return { key, ok: false, reason: `时间线只有 ${text.trim().length} 字（疑似空壳）` }
  }
  const dates = new Set((text.match(DATE_RE) || []).map((d) => d.replace(/\s+/g, '')))
  if (dates.size < 3) {
    return { key, ok: false, reason: `时间线里只有 ${dates.size} 个日期线索（少于 3 个，且长度 ${text.length} 字）` }
  }
  // 有日期但整篇都在复述统计量 → 仍然是回声而不是大事记
  if (STATS_ECHO_RE.test(text) && dates.size < 5) {
    return { key, ok: false, reason: '时间线看起来是统计回声（命中统计特征词且日期很少）' }
  }
  return { key, ok: true }
}

export function checkMd(key: string, content: string): MdCheck {
  const text = String(content || '')
  if (text.trim().length < 200) {
    return { key, ok: false, reason: `${key}.md 只有 ${text.trim().length} 字（疑似空壳）` }
  }
  return { key, ok: true }
}

/**
 * 检查五份档案。`fail` 表示该次生成必须中止（旧克隆保持可用），
 * `warn` 只写日志。
 */
export function checkGeneratedMds(mds: Record<string, string>): MdGateResult {
  const failed: MdCheck[] = []
  const warned: MdCheck[] = []
  for (const [key, content] of Object.entries(mds || {})) {
    const check = key === 'timeline' ? checkTimeline(content) : checkMd(key, content)
    if (!check.ok) failed.push(check)
    if (PLACEHOLDER_RE.test(String(content || ''))) {
      warned.push({ key, ok: true, reason: `${key}.md 里漏出了脱敏占位符（表现层问题，不拦截）` })
    }
  }
  return { ok: failed.length === 0, failed, warned }
}
