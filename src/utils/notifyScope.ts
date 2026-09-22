/**
 * 「接收范围」那句话到底在说什么。
 *
 * 抽成纯函数是因为这里有一个真实的语义 bug：打开「跟随微信消息免打扰」之后，
 * 微信里标了免打扰的会话**确实不再弹窗**，但页面头上那行仍写着
 * 「屏蔽 3 个会话的通知」—— 那 3 个是用户在「会话过滤」里手选的，免打扰的那
 * 几十个一个都没算进去。用户看到的是"这个开关什么也没做"。
 *
 * 免打扰会话的状态是异步查出来的（原生 `wcdb_get_contact_status`），所以
 * `mutedCount` 允许为 `null`（还没查/查不到）：那种情况下宁可只说已选的数字，
 * 也不能把它当成 0 —— 「查不到」与「没有免打扰会话」是两件事。
 */

export type NotifyScopeMode = 'all' | 'whitelist' | 'blacklist' | 'mentions'

export interface NotifyScopeInput {
  mode: NotifyScopeMode
  /** 用户在「会话过滤」里勾选的会话数。 */
  selectedCount: number
  /** 微信里标了免打扰、且**不在**已选列表里的会话数。`null` = 还不知道。 */
  mutedExtraCount: number | null
  /** 「跟随微信消息免打扰」是否开启（默认开启，所以传布尔值而不是可选）。 */
  followMute: boolean
}

export interface NotifyScopeSummary {
  /** 头部主文案。 */
  primary: string
  /** 补一行说明这些数字是怎么来的；不需要时为 undefined。 */
  detail?: string
  /** 真正收不到通知的会话数（算不出来时为 null，不要假装是 0）。 */
  blockedCount: number | null
}

function plural(count: number, unit = '个会话'): string {
  return `${count} ${unit}`
}

export function summarizeNotifyScope(input: NotifyScopeInput): NotifyScopeSummary {
  const selected = Math.max(0, Math.floor(Number(input.selectedCount) || 0))
  const mutedExtra = input.mutedExtraCount === null ? null : Math.max(0, Math.floor(Number(input.mutedExtraCount) || 0))
  const followMute = input.followMute

  if (input.mode === 'mentions') {
    return { primary: '仅提醒群聊中明确 @你的消息（@所有人不触发）', blockedCount: null }
  }

  if (input.mode === 'all') {
    if (followMute && mutedExtra !== null && mutedExtra > 0) {
      return {
        primary: '接收所有会话的通知',
        detail: `其中 ${mutedExtra} 个会话在微信里是「消息免打扰」，跟随设置不会弹窗`,
        blockedCount: mutedExtra,
      }
    }
    return { primary: '接收所有会话的通知', blockedCount: 0 }
  }

  if (input.mode === 'whitelist') {
    if (followMute && mutedExtra !== null && mutedExtra > 0) {
      return {
        primary: `仅通知已选 ${plural(selected)}`,
        // 白名单里的免打扰会话同样不弹：数字不能骗人，说明白"已选 X 个，其中 Y 个没声"。
        detail: `其中 ${mutedExtra} 个会话在微信里是「消息免打扰」，实际不会弹窗`,
        blockedCount: mutedExtra,
      }
    }
    return { primary: `仅通知已选 ${plural(selected)}`, blockedCount: null }
  }

  // blacklist：屏蔽数 = 已选 ∪ 跟随免打扰。
  const blocked = followMute && mutedExtra !== null ? selected + mutedExtra : selected
  const detailParts: string[] = []
  if (selected > 0 || mutedExtra !== null) detailParts.push(`已选 ${selected}`)
  if (followMute && mutedExtra !== null && mutedExtra > 0) detailParts.push(`跟随微信免打扰 ${mutedExtra}`)
  return {
    primary: `屏蔽 ${plural(blocked)}的通知`,
    detail: detailParts.length > 1 ? detailParts.join(' + ') : undefined,
    blockedCount: followMute && mutedExtra === null ? null : blocked,
  }
}
