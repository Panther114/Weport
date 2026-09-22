/**
 * 把一条克隆回复切成它**真正要显示的多条气泡**。
 *
 * 起因是用户报的「它老是换行、写成一首多行的诗，而且不知道为什么用了两个 \n，
 * 看起来像空了两行」。查下来是真实 bug，而且和"模型话太多"是两件事：
 *
 *   1. 主进程的**形态整形**（`weCloneService` 里的 `shapeReply(...).join('\n\n')`）
 *      本来是按本人"连发几条短消息"的习惯把一条回复切成 4~5 段 —— 它假设界面
 *      会把这些段落渲染成 4~5 条独立消息（离线夹具 `scripts/weclone-eval/bubbles.mjs`
 *      的口径正是"空行 = 真气泡"）。
 *   2. 但聊天抽屉当时把整段文本塞进**一个** `.weclone-bubble`，配上
 *      `white-space: pre-wrap` —— 于是那 4~5 段在视觉上变成"一张卡片里隔空行"，
 *      也就是用户看到的"多行长诗 + 莫名多出来的换行"。
 *
 * 所以这里按空行切分，一段一条气泡。**单个换行不切**：微信里一条消息本来就可以
 * 是多行的，模型自己排的版应当保留在气泡内部。
 */
export function splitReplyBubbles(text: string): string[] {
  return String(text ?? '')
    .split(/\n\s*\n+/)
    .map((part) => part.replace(/^[\s]+|[\s]+$/g, ''))
    .filter((part) => part.length > 0)
}
