/**
 * WeClone 表达风格（v1.3.3）—— 纯函数、零依赖，主进程与渲染层共用。
 *
 * ## 这一层是什么
 *
 * 人格档案回答"我是谁、我记得什么"，风格回答"这一次我怎么说"。
 * 两者必须分开：改风格不该重新生成克隆，也不该改写档案与语料。
 *
 * ## 为什么风格写成判据，不写示例句
 *
 * 与 `weClonePrompts.ts` 同一条红线：system prompt 里任何可照抄的例句都会被
 * 模型当成必背台词复读。这里的每一档都只描述**做法**（先接情绪、少反问、
 * 能一句说完就不说两句），不提供任何一句可以直接复制的话。
 *
 * ## 与长度/形态开关的关系
 *
 * `lengthHint` 是硬性的字数与条数约束；风格是取向。两者同时生效时，
 * 风格不能推翻长度约束（提示词里明确写了优先级）。
 */

export type WeCloneStylePreset = 'original' | 'relaxed' | 'gentle' | 'humorous' | 'concise' | 'earnest'

export interface WeCloneStyleOption {
  id: WeCloneStylePreset
  label: string
  /** 卡片上的一句话说明 */
  short: string
  /** 完整说明：勾选后会发生什么 */
  description: string
  /** 注入 system prompt 的判据（不含示例句） */
  instruction: string
  /** 紧邻生成位置的一行提醒（很短） */
  anchor: string
}

export const WECLONE_STYLES: readonly WeCloneStyleOption[] = [
  {
    id: 'original',
    label: '保持原样',
    short: '完全按材料里本人的习惯说',
    description: '不额外调整语气、长度或情绪。这是默认值，也是与档案最一致的一档。',
    instruction: '不额外调整表达方式，完全按材料里本人的习惯说。',
    anchor: '',
  },
  {
    id: 'relaxed',
    label: '自然轻松',
    short: '像平时闲聊，不端着',
    description: '句子更短，允许不完整句、语气词和停顿；不总结、不列点、不主动给建议。',
    instruction:
      '把对话当成平时闲聊：句子短，允许不完整句、语气词和停顿。' +
      '对方没问就不展开，不总结、不列点、不主动给建议，也不要为了显得热情而多说一句。',
    anchor: '语气放松一点，像平时闲聊，短句为主。',
  },
  {
    id: 'gentle',
    label: '温柔',
    short: '先接住情绪，再说话',
    description: '先回应对方的感受，少用反问、调侃和命令句；关心要具体，不追问对方不想说的。',
    instruction:
      '先接住对方这句话里的情绪，再回应具体内容。少用反问、调侃和命令句，' +
      '不要用"你应该""你得"这类说法。关心要落到具体的事上，不要空泛安慰；' +
      '对方明显不想展开时就不追问。',
    anchor: '这次温柔一点：先接情绪，少反问，不命令。',
  },
  {
    id: 'humorous',
    label: '幽默',
    short: '可以玩梗、自嘲、反差',
    description: '笑点跟着当前话题和你们之间的旧梗走；对方认真或低落时自动收起玩笑。',
    instruction:
      '可以玩梗、自嘲、反差和轻微夸张，笑点要跟着当前话题和你们之间真实出现过的旧梗走。' +
      '不要硬抖机灵，不要解释笑点，也不要每句都开玩笑；' +
      '对方在认真说事或情绪低落时，先正常回应，把玩笑收住。',
    anchor: '这次可以放松点、带点玩笑，但看对方状态，别硬逗。',
  },
  {
    id: 'concise',
    label: '简洁',
    short: '一句能说完就不说两句',
    description: '优先回应对方最后一句，不补充背景、不总结、不列点。',
    instruction:
      '能一句说完就不说两句：优先回应对方最后一句，不补充背景、不总结、不列点、不主动延伸话题。' +
      '删掉所有可有可无的修饰和客套。',
    anchor: '这次尽量短：一句能说完就别拆成两句。',
  },
  {
    id: 'earnest',
    label: '认真',
    short: '认真回应具体问题',
    description: '可以多说一点、把事说清楚，但仍然用本人的口吻，不写报告、不喊口号。',
    instruction:
      '认真回应对方提出的具体问题：该说清楚的地方可以多说一点，把事实、判断和下一步讲明白。' +
      '但仍然用本人的口吻，不写报告、不列点、不喊口号，也不要变成客服或顾问。',
    anchor: '这次认真一点，把具体问题说清楚，但别写成报告。',
  },
] as const

const STYLE_IDS = new Set<string>(WECLONE_STYLES.map((item) => item.id))

export function normalizeWeCloneStyle(value: unknown): WeCloneStylePreset {
  const id = String(value || '').trim()
  return STYLE_IDS.has(id) ? (id as WeCloneStylePreset) : 'original'
}

export function weCloneStyleOption(style: unknown): WeCloneStyleOption {
  const id = normalizeWeCloneStyle(style)
  return WECLONE_STYLES.find((item) => item.id === id) || WECLONE_STYLES[0]
}

/** 补充要求只是表达取向，不是新的角色设定。长度上限与提示词里的边界写在一起。 */
export const WECLONE_STYLE_NOTE_MAX_CHARS = 200

export function normalizeWeCloneStyleNote(value: unknown): string {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, WECLONE_STYLE_NOTE_MAX_CHARS)
}

/**
 * system prompt 里的「表达取向」一节。
 *
 * 返回空串 = 保持原样且没有补充要求，此时整节都不出现（不要让模型看到一段
 * "什么都不用改"的废话，那反而会改变它的注意力）。
 */
export function weCloneStyleInstruction(style: unknown, note?: unknown): string {
  const option = weCloneStyleOption(style)
  const cleanNote = normalizeWeCloneStyleNote(note)
  if (option.id === 'original' && !cleanNote) return ''
  return [
    `## 这次的表达取向（只改怎么说，不改你是谁）`,
    option.instruction,
    cleanNote ? `补充表达要求：${cleanNote}` : '',
    '这些要求只调整语气、长度和表达方式，不改变你的身份、记忆、关系与愿不愿意说。',
    '不要把补充要求当成新的角色设定，也不要复读要求里的原话；',
    '如果它与上面的规则冲突，以上面的规则为准；如果与长度约束冲突，以长度约束为准。',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 紧邻生成位置的一行提醒；保持原样档为空。 */
export function weCloneStyleAnchor(style: unknown): string {
  return weCloneStyleOption(style).anchor
}
