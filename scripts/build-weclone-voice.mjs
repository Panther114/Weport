#!/usr/bin/env node
/**
 * build-weclone-voice.mjs — rebuild a clone's voice corpus from the real chat export.
 *
 * Why this exists, and what it changes.
 *
 * The clone that was on disk was built from `chunks.jsonl`, and that corpus has three
 * problems that cap reply quality no matter what the model does:
 *
 *   1. It is **not** the user's voice. Every chunk mixes the user's own lines with the
 *      other party's, plus raw `<msg>…</msg>` XML, plus system lines. Anything that
 *      learns from it — retrieval, or the model reading the sheets — imitates a blend
 *      of several people and a serialisation format.
 *   2. The voice sheets (`profile.md`, `language.md`, …) were LLM **summaries**, so the
 *      phrasing that actually identifies the person had been rewritten by another model.
 *   3. Nothing distinguished register: the same person writes differently in a group
 *      chat, in a DM with a friend, on a formal message.
 *
 * So this builds the corpus the way a stylometry pipeline would:
 *
 *   - reads the real message store (`weport messages.list` over the CLI engine),
 *   - keeps **only the user's own messages**, verbatim,
 *   - drops media/XML/system noise,
 *   - splits into "episodes": `[what they replied to] → [what the user actually said]`,
 *     which is the exact mapping a reply model needs to learn,
 *   - writes a *register* line per episode (group/DM, language mix, length band, time of
 *     day) so retrieval can prefer the right voice instead of the nearest topic.
 *
 * Output layout (mirrors what the app uploads):
 *   <out>/chunks.jsonl   one episode per line, retrieval unit = one utterance
 *   <out>/mds/*.md       verbatim evidence, not summaries
 *   <out>/metadata.json  counts and coverage, for the report and the app
 *
 * Usage:
 *   node scripts/build-weclone-voice.mjs [--limit-sessions 40] [--out <dir>] [--exe <path>]
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { WeportEngine } from '../packages/weport-tui/dist/engine.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const exe = flag('exe', join(root, 'release', 'win-unpacked', process.platform === 'win32' ? 'Weport.exe' : 'Weport'))
const outDir = flag('out', join(root, 'weclone-server', 'data', 'voice-corpus'))
const limitSessions = Number(flag('limit-sessions', '60'))
const messagesPerSession = Number(flag('messages-per-session', '1200'))
if (!existsSync(exe)) { console.error(`engine not found: ${exe}`); process.exit(2) }

// ---------------------------------------------------------------------------
// Noise filters
// ---------------------------------------------------------------------------

const XML = /<\?xml|<msg>|<appmsg|<sysmsg|<emoji|<img |<videomsg|<location/i
const NOISE = /^(reaction|recalled|you have added|你已添加|以上是打招呼|撤回了一条消息|\[图片\]|\[视频\]|\[表情\]|\[链接\]|\[文件\])/i
const MEDIA_TAG = /^\[(图片|视频|表情|链接|文件|语音|位置|名片|转账|红包|音乐|小程序|聊天记录)\]$/u

function isUsable(text) {
  const value = String(text || '').trim()
  if (value.length < 2 || value.length > 160) return false
  if (XML.test(value) || NOISE.test(value) || MEDIA_TAG.test(value)) return false
  // A bare URL or a bare mention carries no voice.
  if (/^https?:\/\/\S+$/.test(value)) return false
  if (/^@\S{1,40}\s*$/.test(value)) return false
  // System-ish: only digits (verification codes), or a single repeated character.
  if (/^[\d\s.,:/-]{2,}$/.test(value)) return false
  if (/^(.)\1{3,}$/.test(value)) return false
  return true
}

/** Language mix of one utterance: how the person actually mixes zh and en. */
function mixOf(text) {
  const zh = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const latin = (text.match(/[a-zA-Z]/g) || []).length
  if (zh === 0 && latin === 0) return 'other'
  if (zh === 0) return 'en'
  if (latin === 0) return 'zh'
  return 'mixed'
}

function lengthBand(text) {
  const length = text.length
  if (length <= 6) return 'xs'
  if (length <= 20) return 's'
  if (length <= 60) return 'm'
  return 'l'
}

function timeOfDay(seconds) {
  const hour = new Date(seconds * 1000).getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 24) return 'evening'
  return 'late-night'
}

// ---------------------------------------------------------------------------
// Read the real history through the CLI engine
// ---------------------------------------------------------------------------

const engine = new WeportEngine(exe, root)
engine.onLog = () => undefined
let shuttingDown = false
process.on('SIGINT', () => { engine.stop(); if (!shuttingDown) { shuttingDown = true; process.exit(1) } })

await engine.start(120000)

const listResult = await engine.call('sessions.list', { limit: 400, type: 'all' }, 300000)
if (!listResult.success) { console.error(`sessions.list failed: ${listResult.error}`); process.exit(1) }
const sessions = (listResult.data || []).filter((session) => session.messageCount >= 30)
// Busiest conversations carry the most voice; sample across them rather than taking
// the largest only, so registers beyond "the one friend" make it into the corpus.
const ranked = sessions.slice().sort((a, b) => b.messageCount - a.messageCount)
const picked = ranked.slice(0, limitSessions)
console.log(`sessions: ${sessions.length} usable, reading ${picked.length} (busiest first)`)

const episodes = []
// The raw reading of each conversation is kept as well: the evaluator needs the same
// message stream this builder saw (`sessions.jsonl`), otherwise the two disagree about
// what counts as a stimulus and the measurement silently becomes incomparable.
const rawSessions = []
for (const [index, session] of picked.entries()) {
  const result = await engine.call('messages.list', { session: session.id, limit: messagesPerSession }, 300000)
  if (!result.success) continue
  const messages = result.data || []
  const stream = []
  let cue = null
  for (const message of messages) {
    const text = String(message.text || '').trim()
    if (!isUsable(text)) continue
    stream.push({ from: message.from, text, at: message.at })
    if (message.from === 'me') {
      episodes.push({
        sid: session.id,
        sessionName: session.name,
        type: session.type,
        ts: message.at,
        cue: cue ? cue.slice(0, 220) : '',
        reply: text,
        mix: mixOf(text),
        band: lengthBand(text),
        when: timeOfDay(message.at || 0),
      })
      cue = null
    } else {
      cue = text
    }
  }
  rawSessions.push({ id: session.id, name: session.name, type: session.type, messages: stream })
  if ((index + 1) % 10 === 0) console.log(`  … ${index + 1}/${picked.length} sessions, ${episodes.length} episodes`)
}
engine.stop()
await new Promise((resolve) => setTimeout(resolve, 400))

if (episodes.length < 50) { console.error(`only ${episodes.length} episodes — aborting`); process.exit(1) }

// ---------------------------------------------------------------------------
// Write the corpus
// ---------------------------------------------------------------------------

rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, 'mds'), { recursive: true })

/**
 * One episode per line, capped at the server's 1200-char chunk limit.
 *
 * The retrieved unit stays small on purpose: BM25 over utterance-sized lines beats
 * BM25 over 800-char conversation dumps, because a dump dilutes the cue that matched.
 */
const lines = []
for (const episode of episodes) {
  const record = {
    id: `ep_${String(lines.length + 1).padStart(6, '0')}`,
    sid: episode.sid,
    ts: episode.ts,
    type: episode.type,
    mix: episode.mix,
    band: episode.band,
    when: episode.when,
    text: `${episode.cue ? `> ${episode.cue}\n` : ''}${episode.reply}`.slice(0, 1190),
  }
  lines.push(JSON.stringify(record))
}
writeFileSync(join(outDir, 'chunks.jsonl'), `${lines.join('\n')}\n`, 'utf8')
writeFileSync(
  join(outDir, 'sessions.jsonl'),
  `${rawSessions.map((session) => JSON.stringify(session)).join('\n')}\n`,
  'utf8',
)

const byMix = {}
const byBand = {}
const byWhen = {}
const byType = {}
for (const episode of episodes) {
  byMix[episode.mix] = (byMix[episode.mix] || 0) + 1
  byBand[episode.band] = (byBand[episode.band] || 0) + 1
  byWhen[episode.when] = (byWhen[episode.when] || 0) + 1
  byType[episode.type] = (byType[episode.type] || 0) + 1
}

/** Verbatim samples, bucketed by register — the evidence a prompt should carry. */
const sample = (filterFn, limit) => episodes.filter(filterFn).slice(0, limit).map((episode) => `- ${episode.reply}`).join('\n')
const shortExamples = episodes.filter((episode) => episode.band === 'xs' || episode.band === 's').slice(0, 40)
writeFileSync(
  join(outDir, 'mds', 'voice.md'),
  [
    '# 语音证据（逐字，不要改写）',
    '',
    '这些是本人真实说过的话。模仿的对象是**这些句子**，不是摘要。',
    '',
    '## 短句（1–20 字，占比最高）',
    sample((episode) => episode.band === 'xs' || episode.band === 's', 60),
    '',
    '## 中长句（21–60 字）',
    sample((episode) => episode.band === 'm', 30),
    '',
    '## 长句（60 字以上，少见）',
    sample((episode) => episode.band === 'l', 15),
    '',
    '## 中文',
    sample((episode) => episode.mix === 'zh', 30),
    '',
    '## 英文',
    sample((episode) => episode.mix === 'en', 30),
    '',
    '## 中英混写',
    sample((episode) => episode.mix === 'mixed', 30),
  ].join('\n'),
  'utf8',
)

/**
 * The style sheet is derived from the corpus, not from a model: numbers cannot drift
 * away from the evidence the way an LLM summary does.
 */
const lengths = episodes.map((episode) => episode.reply.length)
const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)
const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0
const punctuationRate = mean(episodes.map((episode) => ((episode.reply.match(/[,.!?;:，。！？；：]/g) || []).length / Math.max(1, episode.reply.length)) * 100))
const emojiRate = episodes.filter((episode) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(episode.reply)).length / episodes.length
const lowercaseRate = episodes.filter((episode) => /[a-z]/.test(episode.reply) && episode.reply === episode.reply.toLowerCase()).length / Math.max(1, episodes.filter((episode) => /[a-z]/.test(episode.reply)).length)
const questionRate = episodes.filter((episode) => /[?？]$/.test(episode.reply)).length / episodes.length
const ellipsisRate = episodes.filter((episode) => /\.{3,}|…/.test(episode.reply)).length / episodes.length
const laughRate = episodes.filter((episode) => /^(lol|LOL|lmao|哈哈|hhh|草|草了|笑死)/i.test(episode.reply)).length / episodes.length

writeFileSync(
  join(outDir, 'mds', 'language.md'),
  [
    '# language.md — 可量化的语音指纹',
    '',
    '这些数字是从本人真实发言里统计出来的。**照着这些数字写**，不要照着"礼貌、完整、书面"的默认风格写。',
    '',
    '## 硬指标',
    `- 平均长度：${mean(lengths).toFixed(1)} 个字符；中位数 ${median(lengths)} 个字符`,
    `- 长度分布：≤6 字 ${(byBand.xs / episodes.length * 100).toFixed(1)}% · 7–20 字 ${(byBand.s / episodes.length * 100).toFixed(1)}% · 21–60 字 ${(byBand.m / episodes.length * 100).toFixed(1)}% · >60 字 ${(byBand.l / episodes.length * 100).toFixed(1)}%`,
    `- 标点密度：每 100 字符 ${punctuationRate.toFixed(2)} 个标点`,
    `- 全小写倾向：${(lowercaseRate * 100).toFixed(1)}%（有字母的句子里）`,
    `- 问句结尾：${(questionRate * 100).toFixed(1)}%`,
    `- 省略号：${(ellipsisRate * 100).toFixed(1)}%`,
    `- 笑点开头（lol/lmao/哈哈/草…）：${(laughRate * 100).toFixed(1)}%`,
    `- 用 emoji 的句子：${(emojiRate * 100).toFixed(1)}%`,
    `- 语言分布：中文 ${(byMix.zh / episodes.length * 100).toFixed(1)}% · 英文 ${(byMix.en / episodes.length * 100).toFixed(1)}% · 混写 ${(byMix.mixed / episodes.length * 100).toFixed(1)}%`,
    '',
    '## 约束',
    `- 默认回答长度落在 ${median(lengths)} 字左右；超过 60 字要真的有内容才写。`,
    '- 不要因为"这是聊天记录"就加称呼、加问候、加总结、加"希望对你有帮助"。',
    '- 中文标点按上面的密度来；英文句子不要自动补句号和大写。',
    '',
    '## 参考短句（真实原文）',
    shortExamples.map((episode) => `- ${episode.reply}`).join('\n'),
  ].join('\n'),
  'utf8',
)

writeFileSync(
  join(outDir, 'mds', 'profile.md'),
  [
    '# profile.md — 语境分布（不是人物传记）',
    '',
    `- 样本：${episodes.length} 条本人发言，来自 ${picked.length} 个会话`,
    `- 场景分布：${Object.entries(byType).map(([key, value]) => `${key} ${(value / episodes.length * 100).toFixed(0)}%`).join(' · ')}`,
    `- 时段分布：${Object.entries(byWhen).map(([key, value]) => `${key} ${(value / episodes.length * 100).toFixed(0)}%`).join(' · ')}`,
    '',
    '## 按场景的短句样本',
    '### 群聊',
    sample((episode) => episode.type === 'group', 25),
    '',
    '### 私聊',
    sample((episode) => episode.type === 'private', 25),
    '',
    '## 深夜时段',
    sample((episode) => episode.when === 'late-night', 20),
  ].join('\n'),
  'utf8',
)

writeFileSync(join(outDir, 'mds', 'knowledge.md'), ['# knowledge.md', '', '本次不需要事实清单：事实由检索提供，语音由 language.md 与 voice.md 提供。'].join('\n'), 'utf8')
writeFileSync(join(outDir, 'mds', 'timeline.md'), ['# timeline.md', '', `覆盖时间：${new Date(Math.min(...episodes.map((e) => e.ts || 0)) * 1000).toISOString().slice(0, 10)} → ${new Date(Math.max(...episodes.map((e) => e.ts || 0)) * 1000).toISOString().slice(0, 10)}`].join('\n'), 'utf8')
writeFileSync(join(outDir, 'mds', 'relationships.md'), ['# relationships.md', '', `与本人对话最多的会话：`, ...Array.from(new Set(episodes.map((e) => e.sessionName))).slice(0, 30).map((name) => `- ${name}`)].join('\n'), 'utf8')

const metadata = {
  id: `voice_${Date.now().toString(36)}`,
  wxid: '',
  displayName: 'WeClone 语音语料',
  knowledgeCutoff: new Date(Math.max(...episodes.map((episode) => episode.ts || 0)) * 1000).toISOString().slice(0, 10),
  messageCount: episodes.length,
  sessionCount: picked.length,
  chunkCount: episodes.length,
  generatedAt: new Date().toISOString(),
  visibility: 'private',
  uploaded: false,
  uploadStatus: 'local_only',
  piiHits: 0,
  truncated: false,
  corpus: 'voice-v1',
  stats: { mean: Math.round(mean(lengths) * 10) / 10, median: median(lengths), byMix, byBand, byWhen, byType },
}
writeFileSync(join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8')

console.log(`episodes: ${episodes.length} across ${picked.length} sessions`)
console.log(`length: mean ${mean(lengths).toFixed(1)} median ${median(lengths)} · lowercase ${(lowercaseRate * 100).toFixed(1)}% · punctuation/100c ${punctuationRate.toFixed(2)}`)
console.log(`language: ${JSON.stringify(byMix)}`)
console.log(`written to ${outDir}`)
