/**
 * WeClone Voice DNA（gen3 架构）—— 对全部本人消息做确定性统计，
 * 生成注入生成端与聊天端的「语音硬指标」表。
 *
 * 动机：此前语气只靠 LLM 从 ≤250 个抽样块里"悟"，导致克隆话痨、乱加标点、
 * 口癖滥用。现在长度分位 / 句末标点分布 / 小写率 / 口头禅频次 / 表情谱全部由
 * 代码精确计算，作为 ground truth 写进：
 *   1. 每次 MD 生成的 prompt 头部（LLM 必须与数字一致）；
 *   2. language.md 的机器前置段（聊天时随语音书进入 system prompt）；
 *   3. staging 目录 voice.json（诊断/复算用）。
 *
 * 隐私：输入是已经过 redactSensitiveText 的行，输出只含频次与短语本身，
 * 不引入新的敏感数据。
 */

import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import type { WeCloneChunk } from './weCloneService'

export interface WeCloneVoiceDna {
  /** 本人消息总数 */
  sampleCount: number
  /** 长度（UTF-16 code unit）：均值与分位 */
  length: { mean: number; p25: number; p50: number; p75: number; p90: number }
  /** 句末标点分布：none/?/!/。/~… */
  endings: Record<string, number>
  /** 英文词首小写占比 0..1 */
  enLowerRate: number
  /** 含疑问的消息占比 0..1 */
  questionRate: number
  /** 表情（[xxx]）计数 top N */
  emoticons: Array<[string, number]>
  /** 反应词/口癖计数（区分大小写的受控词表 + 语料内高频补充） */
  reactions: Array<[string, number]>
  /** 高频整句口头禅（freq ≥ minPhraseFreq）top N */
  phrases: Array<[string, number]>
}

const REACTION_TOKENS = [
  'gay', 'Gay', 'GAY', 'wtf', 'Wtf', 'WTF', 'tf', 'Tf', 'lol', 'Lol', 'LOL', 'lmao',
  'bruh', 'omg', 'Omg', 'fr', 'ic', 'icic', 'ez', 'EZ', 'nb', 'gg', 'ops', 'btw',
  'nvm', 'ikr', 'hmm', 'ye', 'yes', 'yeah', 'nah', 'nope', 'ok', 'Ok', 'OK', 'okk',
  'okok', 'hi', 'hello', 'bro', 'broo', 'dawg', 'sehr gut', '666', '233', 'sb',
  '难绷', '绷不住了', '笑死', '寄', '麻了', '牛', '牛逼', '卧槽', '草',
]

/** 整句口头禅最低出现次数（低于此不进表） */
const MIN_PHRASE_FREQ = 4
/** 表情/反应词表大小上限 */
const TOP_N = 14

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0
}

function classifyEnding(text: string): string {
  const s = text.trim()
  const ch = [...s].pop() ?? ''
  if (/^[。．]$/.test(ch)) return '。'
  if (/^[？?]$/.test(ch)) return '?'
  if (/^[！!]$/.test(ch)) return '!'
  if (/^~+$/.test(ch)) return '~'
  if (/^…+$/.test(ch)) return '…'
  if (/^[,，]$/.test(ch)) return ','
  return 'none'
}

const QUESTION_START_RE = /^(为什么|怎么|咋|啥|什么|哪|难道|是不是|有没有|which|what|how|why|who|where|when|is |are |do |does |did |can |could |will |would |r u)/i

/** 流式扫描 chunks.jsonl，抽取本人消息并统计。 */
export async function computeVoiceDna(jsonlPath: string): Promise<WeCloneVoiceDna> {
  const lens: number[] = []
  const endingCounts = new Map<string, number>()
  const emoticonCounts = new Map<string, number>()
  const reactionCounts = new Map<string, number>()
  const phraseCounts = new Map<string, number>()
  let enWords = 0
  let enLowerStart = 0
  let questions = 0
  let total = 0

  const bump = (map: Map<string, number>, key: string, by = 1) => map.set(key, (map.get(key) ?? 0) + by)

  const rl = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const raw of rl) {
    const t = raw.trim()
    if (!t) continue
    let chunk: WeCloneChunk
    try { chunk = JSON.parse(t) as WeCloneChunk } catch { continue }
    if (!chunk || typeof chunk.text !== 'string') continue
    for (const lineRaw of chunk.text.split('\n')) {
      const line = lineRaw.trim()
      if (!line.startsWith('我:')) continue
      const text = line.slice(2).trim()
      if (!text || text.startsWith('<?xml') || text.startsWith('<msg')) continue
      total += 1
      lens.push([...text].length)
      bump(endingCounts, classifyEnding(text))
      if (/\?\s*$/.test(text) || QUESTION_START_RE.test(text)) questions += 1
      for (const m of text.match(/\[[^\[\]]{1,12}\]/g) ?? []) {
        // 跳过脱敏占位符（形如 [已脱敏:xx]，不是表情）
        if (/^\[(已脱敏|已过滤|脱敏|REDACTED)/.test(m)) continue
        bump(emoticonCounts, m)
      }
      // 受控词表按独立 token 计数（前后非字母数字，避免 gay 匹配到 gayacademy）
      for (const tok of REACTION_TOKENS) {
        const re = new RegExp(`(^|[^A-Za-z\\u4e00-\\u9fff])${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z\\u4e00-\\u9fff])`)
        if (re.test(text)) bump(reactionCounts, tok)
      }
      for (const w of text.match(/[A-Za-z]+/g) ?? []) {
        enWords += 1
        if (/^[a-z]/.test(w)) enLowerStart += 1
      }
      const trimmed = text.trim()
      if (trimmed.length >= 1 && trimmed.length <= 30 && !/^@/.test(trimmed) && !trimmed.includes('http')) {
        bump(phraseCounts, trimmed)
      }
    }
  }
  rl.close()

  lens.sort((a, b) => a - b)
  const sum = lens.reduce((a, b) => a + b, 0)
  const top = (map: Map<string, number>) =>
    [...map.entries()].filter(([k, c]) => k && c >= 2).sort((a, b) => b[1] - a[1]).slice(0, TOP_N)

  const endings: Record<string, number> = {}
  for (const [k, v] of endingCounts) endings[k] = v

  return {
    sampleCount: total,
    length: {
      mean: +(sum / Math.max(1, lens.length)).toFixed(1),
      p25: percentile(lens, 0.25),
      p50: percentile(lens, 0.5),
      p75: percentile(lens, 0.75),
      p90: percentile(lens, 0.9),
    },
    endings,
    enLowerRate: +(enLowerStart / Math.max(1, enWords)).toFixed(2),
    questionRate: +(questions / Math.max(1, total)).toFixed(2),
    emoticons: top(emoticonCounts),
    reactions: top(reactionCounts),
    phrases: [...phraseCounts.entries()]
      .filter(([, c]) => c >= MIN_PHRASE_FREQ)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40),
  }
}

/**
 * 渲染为注入 prompt 的紧凑 markdown 表（目标 ≤ 2200 字符）。
 * 同一渲染同时用于：MD 生成 prompt 头、language.md 机器前置段。
 */
export function renderVoiceSheet(dna: WeCloneVoiceDna): string {
  const endTotal = Math.max(1, Object.values(dna.endings).reduce((a, b) => a + b, 0))
  const nonePct = Math.round(((dna.endings['none'] ?? 0) / endTotal) * 100)
  const qPct = Math.round(((dna.endings['?'] ?? 0) / endTotal) * 100)
  const periodPct = Math.round(((dna.endings['。'] ?? 0) / endTotal) * 100)
  const lines: string[] = []
  lines.push('## Voice DNA 硬指标（机器对全部本人消息的确定性统计，ground truth，禁止编造或忽略）')
  lines.push(`- 样本量：${dna.sampleCount.toLocaleString()} 条本人消息`)
  lines.push(
    `- 消息长度（字符）：中位 ${dna.length.p50} / 均值 ${dna.length.mean} / P75 ${dna.length.p75} / P90 ${dna.length.p90} —— 大多数消息是几个字的短句，不是段落`
  )
  lines.push(`- 句末标点：${nonePct}% 的消息结尾没有任何标点；问号 ? 仅 ${qPct}%；句号仅 ${periodPct}%。默认不加句末标点。`)
  lines.push(`- 英文词首小写率：${Math.round(dna.enLowerRate * 100)}%（写 ok yes wtf lol，不写 Ok Yes WTF LOL）`)
  lines.push(`- 提问率：${Math.round(dna.questionRate * 100)}%（大部分消息不是提问，少反问用户）`)
  if (dna.reactions.length > 0) {
    lines.push(`- 高频反应词（次数）：${dna.reactions.map(([k, c]) => `${k}×${c}`).join('、')}`)
  }
  if (dna.emoticons.length > 0) {
    lines.push(`- 高频表情（次数）：${dna.emoticons.map(([k, c]) => `${k}×${c}`).join('、')}`)
  }
  if (dna.phrases.length > 0) {
    lines.push(
      `- 最高频整句口头禅（次数）：${dna.phrases.slice(0, 20).map(([k, c]) => `${JSON.stringify(k)}(${c})`).join(' ')}`
    )
  }
  return lines.join('\n')
}
