// 在探针的 userData 里造一个「长对话」，用来验证上下文压缩。
//
// 为什么需要：`ai.compact` 只有超过阈值（0.75 × 窗口）才会真的动手，真实会话
// 未必够长，而当场攒一个够长的会话要几十轮 API 调用。直接写会话文件是最快的
// 办法，而且它验证的正是压缩真正读的那份数据。
//
// 只写 `.ui-probe/userData`（探针自己的目录），不碰任何真实用户数据。
//
// 用法：node scripts/fixture-long-chat.mjs [--kb 400]

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = join(root, '.ui-probe', 'userData', 'weport-ai')
const sessionsDir = join(dataDir, 'sessions')

const argv = process.argv.slice(2)
const kbIndex = argv.indexOf('--kb')
const targetKb = kbIndex === -1 ? 400 : Number(argv[kbIndex + 1]) || 400

mkdirSync(sessionsDir, { recursive: true })

const chatId = randomUUID()
const now = Date.now()

// 每轮塞一段够长的正文，凑到目标体量。内容刻意是"可被摘要掉的历史"：
// 压缩应当把前面的归档、保留最近的。
const paragraph =
  '这是第 %N% 轮的对话内容。用户询问了当天的聊天时间线，助手读取了若干会话并给出结论：' +
  '活跃时间集中在 21:00 到 24:00，主要往来对象是三到五个群聊。' +
  '除此之外还讨论了朋友圈的可见范围、导出格式的选择以及缓存命中率的变化趋势。' +
  '结论部分需要保留的要点是：时间线、主要联系人、活跃时段分布。'

const messages = []
let bytes = 0
let turn = 0
const targetBytes = targetKb * 1024
while (bytes < targetBytes) {
  turn += 1
  const userContent = `第 ${turn} 轮提问：帮我梳理一下最近这一段时间的聊天情况，重点看时间线和主要联系人。`
  const assistantContent = paragraph.replace(/%N%/g, String(turn)).repeat(6)
  messages.push({ id: randomUUID(), role: 'user', content: userContent, createdAt: now + turn * 1000 })
  messages.push({
    id: randomUUID(),
    role: 'assistant',
    content: assistantContent,
    reasoning: `第 ${turn} 轮思考：先取样再核对，避免重复读取。`,
    toolCalls: [
      {
        id: randomUUID(),
        name: 'list_sessions',
        args: { limit: 50 },
        friendly: `读取会话列表（第 ${turn} 轮）`,
        ok: true,
        result: `第 ${turn} 轮结果：返回 50 个会话，其中 12 个有近期消息。`.repeat(4),
      },
    ],
    createdAt: now + turn * 1000 + 500,
  })
  bytes += userContent.length + assistantContent.length + 800
}

writeFileSync(
  join(sessionsDir, `${chatId}.json`),
  JSON.stringify({ chatId, messages, compressed: '', lastRun: undefined }, null, 2),
  'utf8'
)

const indexPath = join(dataDir, 'index.json')
const index = existsSync(indexPath)
  ? JSON.parse(readFileSync(indexPath, 'utf8'))
  : { chats: [] }
index.chats = Array.isArray(index.chats) ? index.chats : []
index.chats.unshift({
  id: chatId,
  title: '压缩验证用长对话',
  createdAt: now,
  updatedAt: now,
  sortOrder: -1,
  titleVersion: 2,
})
writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')

console.log(`chatId=${chatId}`)
console.log(`messages=${messages.length} approxChars=${bytes} (~${Math.round(bytes / 1024)}KB)`)
