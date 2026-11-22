/**
 * WeClone「说话复盘」—— 纯本地统计，不调用模型。
 *
 * ## 为什么不用模型分析
 *
 * 这和风格指纹是同一条原则：**能算的东西不要问模型**。回复是否偏长、是否出现
 * "希望对你有帮助"这类助手腔、是否每轮都用同一个开场、对方说英文却回中文——
 * 这些都是可数的事实。让模型再写一段"我觉得你有点啰嗦"，既花钱又不可复现。
 *
 * ## 分析的两组材料
 *
 * 1. **本人原话**（`voice.jsonl` / 风格指纹）：说明"本人平时怎么说"；
 * 2. **分身回复**（`weclone-chats/<cloneId>.json` 里的 assistant 轮次）：
 *    说明"分身实际说成了什么样"。
 *
 * 没有第二组时仍然输出第一组的统计，但明确写"回复样本不足"，不假装分析过。
 * 复盘只输出聚合指标与极短证据，不复制整段聊天。
 */

import {
  computeFingerprint,
  type WeCloneFingerprint,
} from '../weCloneFingerprint'
import { profileFromVoice, type VoiceShapeProfile } from './voiceShape'
import type {
  WeCloneVoiceIssue,
  WeCloneVoiceReview,
} from '../../../src/utils/weCloneReview'

export interface VoiceReviewReply {
  content: string
  /** 触发这条回复的对方消息（用于判断语言是否跟随、是否复读） */
  prompt?: string
}

export interface VoiceReviewInput {
  voiceTexts: readonly string[]
  replies?: readonly VoiceReviewReply[]
  fingerprint?: WeCloneFingerprint
  shape?: VoiceShapeProfile
  now?: number
}

/**
 * 助手腔的强标记。
 *
 * 只收在正常微信聊天里**很少自然出现**的说法。"首先/最后/抱歉/感谢"这类词
 * 在日常对话里也会出现，单独命中不算问题；它们会被 `WEAK_MARKERS` 按比例统计，
 * 只有密集出现才提示。
 */
const STRONG_MARKERS: readonly string[] = [
  '希望对你有帮助',
  '希望这能帮',
  '如果你需要',
  '如果你愿意',
  '我可以帮你',
  '我可以为你',
  '需要我帮你',
  '还有什么可以',
  '随时告诉',
  '作为一个',
  '作为AI',
  '作为 AI',
  '我理解你的',
  '听起来你',
  '需要注意的是',
  '建议你',
  '你可以尝试',
  '首先',
  '其次',
  '总的来说',
  '综上所述',
  '总结一下',
  '以下是我',
  '抱抱你',
  '请记住',
  '这很正常',
]

/** 只有密集出现才提示的弱标记。 */
const WEAK_MARKERS: readonly string[] = [
  '确实',
  '理解',
  '当然',
  '其实',
  '不过',
  '没关系',
  '抱歉',
  '感谢',
  '支持',
  '帮助',
]

const STRUCTURE_RE = /(^|\n)\s*(?:[-*•]|\d+[.)、]|#{1,6}\s)|\*\*[^*\n]+\*\*/
const QUESTION_END_RE = /[?？]\s*$/

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))
  return sorted[index]
}

function charLength(text: string): number {
  return [...text].length
}

function languageOf(text: string): 'zh' | 'en' | 'mixed' | 'none' {
  let cjk = 0
  let latin = 0
  for (const ch of String(text || '')) {
    const code = ch.codePointAt(0) || 0
    if ((code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)) cjk += 1
    else if (/[A-Za-z]/.test(ch)) latin += 1
  }
  if (cjk === 0 && latin === 0) return 'none'
  if (cjk === 0) return 'en'
  if (latin === 0) return 'zh'
  const ratio = cjk / (cjk + latin)
  if (ratio >= 0.65) return 'zh'
  if (ratio <= 0.15) return 'en'
  return 'mixed'
}

/** 一句话里是否出现了与对方消息相同的 8 字以上片段（复读的廉价检测）。 */
function sharedRun(reply: string, prompt: string, min = 8): string | null {
  const a = String(prompt || '')
  const b = String(reply || '')
  if (a.length < min || b.length < min) return null
  const haystack = a.replace(/\s+/g, '')
  for (let i = 0; i + min <= b.length; i += 1) {
    const slice = b.slice(i, i + min).replace(/\s+/g, '')
    if (slice.length >= min && haystack.includes(slice)) return slice
  }
  return null
}

function excerpt(text: string, max = 32): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function openerOf(text: string): string {
  const clean = String(text || '').replace(/^[\s，。！？、,.!?~～…"'“”‘’]+/, '')
  const firstLine = clean.split(/[\n。！？!?]/)[0] || clean
  return [...firstLine].slice(0, 4).join('')
}

function pushIssue(
  issues: WeCloneVoiceIssue[],
  input: Omit<WeCloneVoiceIssue, 'severity'> & { severity?: WeCloneVoiceIssue['severity'] },
): void {
  if (issues.some((item) => item.id === input.id)) return
  issues.push({
    id: input.id,
    title: input.title,
    detail: input.detail,
    severity: input.severity || 'info',
    evidence: input.evidence,
  })
}

/**
 * 生成复盘。纯函数：同一组输入永远得到同一组结论（时间戳除外）。
 */
export function analyzeVoiceReview(input: VoiceReviewInput): WeCloneVoiceReview {
  const now = Number(input.now) || Date.now()
  const voiceTexts = (input.voiceTexts || []).map((text) => String(text || '').trim()).filter(Boolean)
  const replies = (input.replies || [])
    .map((reply) => ({ content: String(reply?.content || '').trim(), prompt: String(reply?.prompt || '').trim() }))
    .filter((reply) => reply.content.length > 0)

  const fingerprint = input.fingerprint || computeFingerprint(voiceTexts)
  const shape = input.shape || (voiceTexts.length > 0 ? profileFromVoice(voiceTexts.map((text, index) => ({ ts: index + 1, sid: 'voice', text }))) : undefined)

  const voiceLengths = voiceTexts.map(charLength).filter((n) => n > 0)
  const replyLengths = replies.map((reply) => charLength(reply.content))
  const voiceMedian = voiceLengths.length ? percentile(voiceLengths, 0.5) : 0
  const voiceP90 = voiceLengths.length ? percentile(voiceLengths, 0.9) : 0
  const replyMedian = replyLengths.length ? percentile(replyLengths, 0.5) : 0
  const replyP90 = replyLengths.length ? percentile(replyLengths, 0.9) : 0

  const issues: WeCloneVoiceIssue[] = []
  const cautions: string[] = []
  const suggestions: string[] = []

  // ---------------------------------------------------------------- 样本量
  if (voiceTexts.length < 50) {
    pushIssue(issues, {
      id: 'voice-sample-small',
      title: '本人语料偏少',
      detail: `只有 ${voiceTexts.length} 条本人原话。长度、标点、口头禅的统计会不稳定，复盘结论只能当参考。`,
      severity: 'info',
    })
    cautions.push('语料少于 50 条时，不要根据复盘去大改风格；先补充样本或重新生成克隆。')
  }

  // ---------------------------------------------------------------- 长度
  if (replies.length > 0 && voiceMedian > 0 && replyMedian > 0) {
    const ratio = replyMedian / voiceMedian
    if (ratio >= 2 && replyMedian >= 24) {
      pushIssue(issues, {
        id: 'reply-too-long',
        title: '分身回复明显比本人长',
        detail: `本人单条中位 ${voiceMedian} 字，分身回复中位 ${replyMedian} 字（约 ${ratio.toFixed(1)} 倍）。长回复最容易滑回助手腔。`,
        severity: 'warn',
        evidence: replies
          .slice()
          .sort((a, b) => charLength(b.content) - charLength(a.content))
          .slice(0, 2)
          .map((reply) => excerpt(reply.content, 40)),
      })
      cautions.push(`对方只发一两句时，回复不要超过 ${Math.max(20, Math.round(voiceMedian * 2))} 字；能一句说完就不拆成两句。`)
      suggestions.push('把「简洁」或「自然轻松」作为默认风格，并打开长度约束；先用 10 轮对话再复盘一次。')
    }
  }
  if (replies.length >= 3 && voiceP90 > 0 && replyP90 > voiceP90 * 2.5) {
    pushIssue(issues, {
      id: 'reply-tail-too-long',
      title: '偶尔会出现特别长的回复',
      detail: `本人 90% 的消息在 ${voiceP90} 字以内，分身回复的 90% 分位是 ${replyP90} 字。长尾回复通常是在总结或列点。`,
      severity: 'info',
    })
    cautions.push('不要在一轮里同时做"总结 + 分点 + 给建议"；对方没有明确要长回答时，删掉最后一段。')
  }

  // ---------------------------------------------------------------- 助手腔
  if (replies.length > 0) {
    const strongHits = replies.map((reply) => STRONG_MARKERS.filter((marker) => reply.content.includes(marker)))
    const strongCount = strongHits.filter((hits) => hits.length > 0).length
    const strongRate = strongCount / replies.length
    if (strongCount > 0 && (strongRate >= 0.15 || strongCount >= 3)) {
      const markers = [...new Set(strongHits.flat())].slice(0, 5)
      pushIssue(issues, {
        id: 'assistant-tone',
        title: '出现助手腔',
        detail: `${strongCount}/${replies.length} 条回复命中助手式说法。常见的是"${markers.join('、')}"。真人聊天很少这样起句或收尾。`,
        severity: 'warn',
        evidence: markers.map((marker) => `命中：${marker}`),
      })
      cautions.push('不要在开头解释自己、不要承诺"随时可以帮你"、不要在结尾加祝福或总结。')
      suggestions.push('用「自然轻松」跑一段时间；如果仍出现，把"不要总结、不要列点、不要给建议"写进补充要求。')
    }

    const weakHits = replies.filter((reply) => WEAK_MARKERS.some((marker) => reply.content.includes(marker))).length
    if (replies.length >= 4 && weakHits / replies.length >= 0.5) {
      pushIssue(issues, {
        id: 'over-agreeable',
        title: '回应过于顺从',
        detail: `${weakHits}/${replies.length} 条回复出现"确实/理解/当然/没关系"这类附和词。密度过高会读成客服，而不是本人。`,
        severity: 'info',
      })
      cautions.push('不要每句都先认同对方；有不同看法时按本人的方式直接说，不要先铺垫"我理解"。')
    }

    const structured = replies.filter((reply) => STRUCTURE_RE.test(reply.content) || (reply.content.match(/\n/g) || []).length >= 3).length
    if (structured > 0 && structured / replies.length >= 0.2) {
      pushIssue(issues, {
        id: 'structured-reply',
        title: '回复结构化',
        detail: `${structured}/${replies.length} 条回复出现分点、标题、加粗或多段排版。微信聊天里这几乎不会自然出现。`,
        severity: 'warn',
      })
      cautions.push('不要用列表、标题、加粗和编号；需要说几件事时，按本人平时的连发习惯拆成短消息。')
      suggestions.push('保留「形态整形」开关，让回复按本人的连发习惯拆成多条短消息。')
    }
  }

  // ---------------------------------------------------------------- 开场重复
  if (replies.length >= 5) {
    const openers = new Map<string, number>()
    for (const reply of replies) {
      const opener = openerOf(reply.content)
      if (opener) openers.set(opener, (openers.get(opener) || 0) + 1)
    }
    const top = [...openers.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top && top[1] >= Math.max(3, Math.ceil(replies.length * 0.2))) {
      pushIssue(issues, {
        id: 'repeated-opener',
        title: '开场重复',
        detail: `有 ${top[1]} 条回复以「${top[0]}…」开头。同一个开场反复出现，会明显读成模板。`,
        severity: 'info',
        evidence: [`重复开场：${top[0]}… ×${top[1]}`],
      })
      cautions.push('不要每轮都用同一个词起句；开场跟着对方这句话的内容走。')
    }
  }

  // ---------------------------------------------------------------- 语言跟随
  if (replies.length > 0) {
    const comparable = replies.filter((reply) => reply.prompt && languageOf(reply.prompt) !== 'none' && languageOf(reply.content) !== 'none')
    const mismatches = comparable.filter((reply) => {
      const a = languageOf(reply.prompt)
      const b = languageOf(reply.content)
      return (a === 'en' && b === 'zh') || (a === 'zh' && b === 'en')
    })
    if (mismatches.length > 0) {
      pushIssue(issues, {
        id: 'language-mismatch',
        title: '回复语言没有跟随对方',
        detail: `${mismatches.length}/${comparable.length} 条回复的语言与对方那条消息不一致。对方用英文时，回复也应当是英文。`,
        severity: 'warn',
        evidence: mismatches.slice(0, 2).map((reply) => excerpt(reply.content, 36)),
      })
      cautions.push('对方换语言时跟着换；对方中英混打时也混打，不要把英文问题翻成中文回答。')
    }
  }

  // ---------------------------------------------------------------- 复读
  if (replies.length > 0) {
    const echoes = replies.filter((reply) => reply.prompt && sharedRun(reply.content, reply.prompt))
    if (echoes.length > 0 && echoes.length / replies.length >= 0.15) {
      pushIssue(issues, {
        id: 'echo-user',
        title: '复读对方原话',
        detail: `${echoes.length}/${replies.length} 条回复里出现了与对方消息相同的 8 字以上片段。真人回复通常不会把对方的话再说一遍。`,
        severity: 'info',
      })
      cautions.push('不要复述对方刚说过的话；直接接内容或情绪，不要用"你是说……"开头。')
    }
  }

  // ---------------------------------------------------------------- 标点与表情
  if (replies.length >= 3 && fingerprint.endsWithPunctuation < 0.2) {
    const assistantEnds = replies.filter((reply) => /[。！？!?…~～]\s*$/.test(reply.content)).length / replies.length
    if (assistantEnds >= 0.5 && assistantEnds > fingerprint.endsWithPunctuation + 0.3) {
      pushIssue(issues, {
        id: 'too-formal-punctuation',
        title: '标点比本人更完整',
        detail: `本人只有 ${(fingerprint.endsWithPunctuation * 100).toFixed(0)}% 的消息以句末标点收尾，分身回复是 ${(assistantEnds * 100).toFixed(0)}%。补全句号会让语气变书面。`,
        severity: 'info',
      })
      cautions.push('回复不要习惯性补句号；本人不发句号的地方就省略。')
    }
  }
  if (replies.length >= 3 && fingerprint.emojiRatio < 0.05) {
    const assistantEmoji = replies.filter((reply) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(reply.content)).length / replies.length
    if (assistantEmoji >= 0.3) {
      pushIssue(issues, {
        id: 'too-many-emoji',
        title: '表情比本人多',
        detail: `本人只有 ${(fingerprint.emojiRatio * 100).toFixed(0)}% 的消息带表情，分身回复是 ${(assistantEmoji * 100).toFixed(0)}%。`,
        severity: 'info',
      })
      cautions.push('表情和颜文字的密度跟本人一致；本人不用表情的场合不要加。')
    }
  }

  // ---------------------------------------------------------------- 样本不足
  if (replies.length === 0) {
    pushIssue(issues, {
      id: 'no-reply-sample',
      title: '还没有分身回复样本',
      detail: '目前只能分析本人原话，无法判断分身实际说成了什么样。先和分身聊几轮，再回来复盘。',
      severity: 'info',
    })
    cautions.push('没有回复样本时，不要仅凭"感觉"调风格；先用默认设置聊 10 轮左右。')
    suggestions.push('先聊几轮，再点「分析之前的说话方式」；样本越分散，结论越可靠。')
  }

  // ---------------------------------------------------------------- 汇总
  const warnings = issues.filter((issue) => issue.severity === 'warn')
  const summaryParts: string[] = []
  summaryParts.push(`分析了 ${voiceTexts.length} 条本人原话、${replies.length} 条分身回复。`)
  if (voiceMedian > 0) summaryParts.push(`本人单条中位 ${voiceMedian} 字。`)
  if (warnings.length > 0) summaryParts.push(`最需要先处理：${warnings.map((issue) => issue.title).join('、')}。`)
  else if (issues.length > 0) summaryParts.push('没有发现严重问题，主要是细节上的偏差。')
  else if (replies.length > 0) summaryParts.push('没有发现明显的助手腔、长度或语言问题。')
  if (suggestions.length === 0) {
    suggestions.push(replies.length > 0 ? '当前表现没有明显问题；保持现有设置，过一段时间再复盘一次。' : '先积累回复样本，再决定要不要调整风格。')
  }

  const metrics: WeCloneVoiceReview['metrics'] = {
    voiceSampleSize: voiceTexts.length,
    replySampleSize: replies.length,
    voiceMedianLength: voiceMedian,
    voiceMeanLength: Math.round(mean(voiceLengths) * 10) / 10,
    voiceBurstMean: shape ? Math.round(shape.burstMean * 100) / 100 : 0,
    replyMedianLength: replyMedian,
    replyMeanLength: Math.round(mean(replyLengths) * 10) / 10,
    replyP90Length: replyP90,
    replyToVoiceRatio: voiceMedian > 0 ? Math.round((replyMedian / voiceMedian) * 100) / 100 : 0,
    assistantToneRate: replies.length ? Math.round((replies.filter((reply) => STRONG_MARKERS.some((marker) => reply.content.includes(marker))).length / replies.length) * 100) / 100 : 0,
    structureRate: replies.length ? Math.round((replies.filter((reply) => STRUCTURE_RE.test(reply.content)).length / replies.length) * 100) / 100 : 0,
    questionRate: replies.length ? Math.round((replies.filter((reply) => QUESTION_END_RE.test(reply.content)).length / replies.length) * 100) / 100 : 0,
    voiceEndsWithPunctuation: Math.round(fingerprint.endsWithPunctuation * 100) / 100,
    voiceEmojiRatio: Math.round(fingerprint.emojiRatio * 100) / 100,
  }

  return {
    generatedAt: now,
    sampleSize: voiceTexts.length,
    replySampleSize: replies.length,
    summary: summaryParts.join(' '),
    issues,
    cautions,
    suggestions,
    metrics,
  }
}
