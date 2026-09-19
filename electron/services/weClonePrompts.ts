/**
 * WeClone 专用 Prompts（v1.0.1 重做）。
 *
 * ## 这一版改了什么，以及为什么
 *
 * 1. **system prompt 里不再有任何"示例内容"**。旧版在拒答一节里写了
 *    `例如："这个我不想聊""抱歉，这属于隐私"` —— 实测这类引文会被模型当成
 *    必背台词，换个克隆就复读出完全不同的话，同一个克隆也会反复用同一句。
 *    用户的原话是"绝不要在 system prompt 里嵌入预设的行为引文"。现在所有
 *    规则都写成**判据**，一句可照抄的话都不留。
 * 2. **逐字语料移出 system prompt，改为按话题检索**。旧版把 `language.md` 的
 *    30-50 条原句整段塞进 prompt 并标注"逐字模仿这些句子"。那是"示例内容"
 *    的最坏形态：它是静态的，跟当前话题无关，模型要么整段照抄要么完全忽略。
 *    现在 system prompt 只带**统计事实**（风格指纹）+ 模式描述；原句按当前
 *    这句话的话题检索出来，每轮不同。
 * 3. **知识边界改成肯定式**。旧版写"资料截止 {cutoff} 之后的事一概不知"——
 *    这是典型的负面指令：它把模型的注意力引到"我不知道"上，于是**连语料里
 *    明明有的事也一起否认**（用户报的"知识截止没有真正反映"）。现在写的是
 *    "记录里的每一件事你都亲历过，日期就是它发生的时间"，只对**记录里没有
 *    的事**要求说记不清。
 * 4. **拒答成为每个克隆自己的开关**（`WeCloneRefusalMode`）。默认是以本人的
 *    方式把话岔开；关掉之后 prompt 里**完全不出现**拒答这件事。
 * 5. **脱敏成为导出时的开关**。关掉时脱敏条款整段消失，不再有 `[已过滤:…]`。
 *
 * 隐私红线：开关只控制"说不说"，不控制"能不能"—— 语料始终不出本机。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 拒答行为：以本人方式拒答 / 完全不拒答 */
export type WeCloneRefusalMode = 'character' | 'off'

export interface WeCloneBuilderPromptOptions {
  /** 生成时是否做敏感信息脱敏（对应导出页的开关） */
  redact: boolean
  /** 本人风格指纹的渲染文本（本地统计得来，可复现，不是模型编的） */
  fingerprintBlock?: string
  displayName?: string
}

const REFUSAL_LABEL: Record<WeCloneRefusalMode, string> = {
  character: '以本人的方式带过去',
  off: '完全不设限',
}

export function refusalModeLabel(mode: WeCloneRefusalMode): string {
  return REFUSAL_LABEL[mode] ?? REFUSAL_LABEL.character
}

// ---------------------------------------------------------------------------
// 1. 生成阶段：map（分片提炼）与 reduce（合并成 MD）两套 prompt
// ---------------------------------------------------------------------------

export const WECLONE_MAP_SYSTEM_PROMPT = `你在为一个"人格克隆"工程做**分片提炼**。你会收到一段按时间切出来的聊天记录切片，以及这一片的时间范围。

你的任务不是总结，而是**取证**：从这一片里挑出所有能用来还原"本人（我）"这个人的可复用事实。

规则：
- 只写切片里真实出现过的东西。切片里没有的，写"本节无"。
- 本人（前缀是"我"）的行是**主证据**；其他人的行只是上下文，不要写成本人的性格。
- 宁可多写具体细节，也不要写放之四海而皆准的评语（"性格开朗""为人随和"这类一律不要）。
- 保留原始用词：错别字、缩写、脏话、黑话、表情包文字**照抄**，不要翻译成书面语。
- 输出中文，用下面固定的小节结构，不要额外解释。`

export interface WeCloneMapPromptInput {
  sessionLabel: string
  timeRange: string
  /** 切片正文 */
  context: string
}

/**
 * 分片提炼的 user prompt。
 *
 * 小节结构是刻意固定成"证据类型"的：这些字段后面会被 reduce 阶段按主题重新
 * 拼装，**每一个字段最终都能落到某一份 MD 上**，不会出现"提炼了一堆没人用"。
 *
 * **正文必须贴在这里。** 这里曾经漏掉 `${input.context}` —— prompt 里只有时间
 * 范围与会话名，于是 13 个分片全部老老实实回了"本节无"，而最终档案里写了一整
 * 段"13 段分片的正文全部缺失"。整条管线跑得又稳又久，产出的却是一份空壳：
 * 单元测试只断言了 prompt 里"有小节标题"，没有断言"有语料"，所以它一路通过。
 * 现在 `weClonePrompts.test.ts` 里有一条专门盯着这件事的断言。
 */
export function buildWeCloneMapPrompt(input: WeCloneMapPromptInput): string {
  return `时间范围：${input.timeRange}
覆盖的会话：${input.sessionLabel}

下面是这一段的聊天记录正文（前缀「我」的是本人说的话，其余是别人）：

===== 聊天记录 =====
${input.context}
===== 聊天记录结束 =====

请按下面小节输出（每节都要写；确实没有就写"本节无"）：

## 说话方式
本人怎么打字：句长、断句、标点、语气词、常用词与口癖、拼音缩写、错别字、表情/颜文字/
表情包文字的用法。写具体模式+出现场景，必要时可以引用**词语**（不是整句）。

## 生活与经历
这一片里出现的事实：在做什么事、去的地方、工作/学业/项目、买了什么、遇到什么事。
带上时间线索（哪个月、什么季节、和什么事件连着）。

## 人与关系
跟谁在聊、怎么称呼对方、互动模式（谁主动、聊什么、什么语气）、群里的角色。
只写互动模式与称呼。不要判断任何人的感情关系。

## 话题与兴趣
反复出现的话题、专业术语、圈子黑话（词 → 含义/用法）、玩梗方式。

## 观点与雷区
本人明确表达过的喜好、厌恶、态度、立场；被惹到或明显不想聊的话题。

## 当时的状态
这一片里本人的情绪基线（兴奋/丧/忙碌/闲）、作息线索、生活节奏的变化。`
}

export const WECLONE_REDUCE_SYSTEM_PROMPT = `你在为一个"人格克隆"工程做**跨分片归并**。

你会收到若干段互相独立的分片提炼结果（按时间先后排列，覆盖整段聊天记录的每一个时间段）。把它们归并成一份不重复、不矛盾、时间顺序正确的整体材料。

规则：
- 多个分片都提到的 → 合并，并注明它跨越了多长时间（"长期如此" vs "只在某段时间"）。
- 互相矛盾的说法**都保留并标注时间**（人是会变的，把变化写出来比抹平更有用）。
- 不要因为某件事只出现在一个分片里就丢掉它 —— 那可能正是最有辨识度的细节。
- 不要添加任何分片里没有的内容，也不要写评价性空话。
- 输出中文，保留分片里的小节结构。`

/**
 * 写最终 MD 时的 system prompt。
 *
 * 与归并阶段的区别：归并要"不丢、不编"，写档案要"高密度、可检索"。
 * 合用一个 prompt 会让输出在两种要求之间折中 —— 既不够全也不够利落。
 */
export const WECLONE_MD_SYSTEM_PROMPT = `你在为一个"人格克隆"工程撰写人格档案的一份文件。

你要写的是**给另一个语言模型看的参考资料**，它要拿这份资料去扮演资料里的这个人。
所以判断标准只有一个：**这份文件能不能让一个陌生人像这个人一样说话、一样记事。**

规则：
- 密度优先：每一条都要具体到可以拿来用。禁止"性格开朗""为人随和"这类放在谁身上都成立的话。
- 全部有据可依：只写材料里支持的结论；证据薄弱时明确写"证据不足"，不要补全。
- 保留原始用词：错别字、缩写、脏话、黑话、表情包文字照原样写，不要翻译成书面语、不要净化。
- 写多面性：同一个人对不同的人、在不同的时期是不一样的，把这种差异写出来。
- 直接输出文件内容（以要求的标题行开头），不要前言、不要结语、不要解释你在做什么。`

export function buildWeCloneReducePrompt(digests: string[], targetChars?: number): string {
  /**
   * 最终归并会带上目标篇幅。
   *
   * 为什么需要：归并的产出紧接着要整段塞进**每一份** MD 的 prompt（五份 MD 各
   * 一次调用）。材料不封顶的话，一次 37 段的分片提炼很容易归并出十万字以上，
   * 加上 MD 的撰写指令就可能顶穿模型的上下文窗口 —— 报错长这样：
   * "This model's maximum context length is …"，而界面只会说一句"生成失败"。
   * 让模型**有意识地**压到目标篇幅，比事后由代码切掉一截强得多。
   */
  const sizeRule = targetChars
    ? `\n\n**篇幅要求**：归并结果控制在 ${Math.round(targetChars / 10000)} 万字以内。` +
      `压缩时优先丢掉重复表述与空话，保留具体的人、事、时间、用词 —— 这是给扮演者用的材料，细节就是价值。`
    : ''
  return `下面是 ${digests.length} 段分片提炼结果，按时间先后排列。请归并成一份整体材料。${sizeRule}

${digests.map((d, i) => `===== 分片 ${i + 1}/${digests.length} =====\n${d}`).join('\n\n')}`
}

// ---------------------------------------------------------------------------
// 2. 最终 MD 的生成指令（reduce 的最后一步）
// ---------------------------------------------------------------------------

export type WeCloneMdKey = 'profile' | 'relationships' | 'knowledge' | 'timeline' | 'language'

export const WECLONE_MD_KEYS: readonly WeCloneMdKey[] = ['profile', 'relationships', 'knowledge', 'timeline', 'language']

interface MdSpec {
  /** 这份文件该写什么 */
  body: string
  /** 篇幅要求 */
  size: string
}

const MD_SPECS: Record<WeCloneMdKey, MdSpec> = {
  profile: {
    size: '尽量写满，篇幅不设上限：宁可 8000 字全是具体事实，也不要 800 字正确的废话。',
    body: `覆盖：性格的多面性（对不同的人、不同场合分别是什么样）、说话风格与语气、
口癖与标点习惯、表情与颜文字偏好、作息与生活节奏、兴趣爱好主线、价值观与雷区、近期状态。
每一条结论后面用括号给出它来自哪段时间/哪类场合的证据。
**必须写出这个人的多面性**：同一个人在工作群和家人面前不一样，这一点比任何单一标签都重要。`,
  },
  relationships: {
    size: '按人物密度写，通常 2000-6000 字。',
    body: `按联系人/群分别写：互动频率与谁主动、聊什么话题、用什么称呼、什么语气、
在群里的角色（活跃/潜水/气氛组/工具人）。**只写互动模式与称呼**。
最后单列一节「称呼对照表」：谁怎么叫本人、本人怎么叫谁。`,
  },
  knowledge: {
    size: '词条式罗列，通常 3000-8000 字。',
    body: `学校/工作/项目/城市生活线索、常聊话题清单、专业术语表、
梗与黑话词典（每条写成「词 — 含义/用法/出现场合」）、技能与日常事务、常去的地方与常做事的规律。`,
  },
  timeline: {
    size: '按时间密度写，通常 2000-6000 字。',
    body: `按年份 → 月份整理大事记与热点话题，标注证据时间范围；无法确定月份的归入该年度"未定位"。
额外单列一节「近期状态」：最后三个月的日常在做什么、关心什么 —— 这一节最影响"聊起来像不像最近的本人"。`,
  },
  language: {
    size: '60-120 条，每条一行。',
    body: `从材料里挑出**本人**说过的、最有代表性的**原句**（不是改写）。按话题分组（日常寒暄 / 吐槽 / 兴奋 / 工作沟通 / 玩梗 / 关心别人 / 生气）。
保留原始错别字、缩写、脏话、表情包文字，一字不改。
这些句子将来会作为"按话题检索的语气样本"被取用，所以**话题覆盖面比句子漂亮更重要**：
每个分组至少 8 条，且尽量分布在不同的对话对象与不同年份。`,
  },
}

export function buildWeCloneMdPrompt(key: WeCloneMdKey, material: string, options: WeCloneBuilderPromptOptions): string {
  const spec = MD_SPECS[key]
  const sensitive = options.redact
    ? `
## 敏感信息（硬要求）
材料里已经用 [已脱敏:类型] 占位符标出了敏感值 —— 占位符**整条不要**写进输出。
另外这些内容你自己也要主动省略：身份证/护照号、精确住址与门牌、手机号、银行卡号、
密码/密钥、医疗细节、财务数额、对任何具体个人的亲密关系定性（恋爱/分手/出轨/暗恋）。
结构性需要时写 [已过滤:敏感信息]，并在文件末尾加一节 \`## 已过滤项\` 记下被过滤的类别。`
    : `
## 不要删减
材料里出现的信息照原样保留，不要因为"敏感"而省略或改写。
不要输出 [已脱敏:…] / [已过滤:…] 这类占位符；如果材料里有，把它按上下文还原成普通文字或直接删掉那一小段。`

  return `现在生成 ${key}.md。基于下面的整体材料（它是全部聊天记录分片归并后的结果），输出完整文件内容，以 \`# ${key}.md\` 开头。

要写什么：
${spec.body}

篇幅：
${spec.size}

高密度、高信息量、全部有据可依。禁止空话（"他是一个有个性的人"这种一律不要）。
所有内容用中文写（语料里原样的英文词、缩写、黑话保留原样）。
${sensitive}
${options.fingerprintBlock ? `\n## 本地统计事实（这些是**算出来的**，必须与你的描述一致；不要和它们矛盾）\n${options.fingerprintBlock}\n` : ''}
===== 整体材料 =====
${material}`
}

// ---------------------------------------------------------------------------
// 3. 第二阶段 LLM PII 审查 prompt（仅脱敏开启时使用）
// ---------------------------------------------------------------------------

export const WECLONE_FILTER_PROMPT = `你是 PII 审查器。审查以下文本是否含PII（个人身份信息）或其它敏感数据：身份证/证件号、手机号、银行卡号、邮箱、密码/密钥/token、家庭住址或精确位置（省市区+街道+门牌级别）、车牌号、以及具体个人的亲密关系定性（恋爱/分手/出轨对象）。
注意：形如 [已脱敏:xxx] 或 [已过滤:xxx] 的占位符是安全的，不算命中。
只输出一个 JSON 对象，不要任何解释或代码块围栏：
{"hasPII": true|false, "spans": [{"start": <字符起点>, "end": <字符终点(不含)>, "type": "<身份证|手机号|银行卡|邮箱|密码|住址|精确位置|证件|关系判定|其他>"}]}
start/end 是所给文本中的字符偏移量（UTF-16 code unit）。不确定就不要报。不要改写原文。

===== 待审查文本 =====
{content}`

// ---------------------------------------------------------------------------
// 4. 克隆聊天 system prompt
// ---------------------------------------------------------------------------

export interface WeCloneChatPromptInput {
  displayName: string
  /** 语料覆盖的时间范围（起止），用于"你知道什么"那一节 */
  corpusRange?: string
  /** 语料最后一条消息的日期 */
  knowledgeCutoff?: string
  /** 语料主语言的中文标签 */
  corpusLanguage?: string
  /** 拒答行为 */
  refusal?: WeCloneRefusalMode
  /** 人格 MD（不含 language.md —— 逐字语料改为按话题检索，不进 system prompt） */
  mds?: Partial<Record<'profile' | 'relationships' | 'knowledge' | 'timeline', string>>
  /** 风格指纹的渲染文本 */
  fingerprintBlock?: string
  /** 本轮检索到的历史片段（带日期与说话人） */
  retrievedChunks?: string[]
  /** 本轮检索到的**本人原话**（按话题命中，用于语气参照） */
  voiceSamples?: string[]
}

/**
 * 各部分在 system prompt 里的**优先级**（数字越大越先被保留）。
 *
 * 为什么要分级而不是直接 `slice`：旧实现是 `.slice(0, 24000)` —— 一刀切在
 * 字符中间，可能把"关系图谱"砍掉一半、把语言规则整段切没，而模型完全不知道
 * 自己拿到的是残文。按节丢弃至少保证**留下的是完整的节**。
 */
const SECTION_PRIORITY = {
  rules: 100,
  retrieved: 90,
  voice: 85,
  profile: 70,
  fingerprint: 65,
  knowledge: 55,
  timeline: 45,
  relationships: 35,
} as const

/** system prompt 的字符预算。语料可以很大，这里是"给模型多少上下文"的上限。 */
export const WECLONE_SYSTEM_PROMPT_CHAR_BUDGET = 180_000

interface PromptSection {
  id: keyof typeof SECTION_PRIORITY
  priority: number
  text: string
}

/**
 * 按优先级拼装，超预算时整节丢弃（并明确告诉模型哪几节被省略了 ——
 * 静默丢内容会让模型以为自己看到的就是全部，从而对缺失的部分编造）。
 */
export function assemblePromptSections(sections: PromptSection[], budget = WECLONE_SYSTEM_PROMPT_CHAR_BUDGET): string {
  const ordered = [...sections].sort((a, b) => b.priority - a.priority)
  const kept: string[] = []
  const dropped: string[] = []
  let used = 0
  for (const section of ordered) {
    if (used + section.text.length > budget && kept.length > 0) {
      dropped.push(section.id)
      continue
    }
    kept.push(section.text)
    used += section.text.length
  }
  if (dropped.length > 0) {
    kept.push(
      `（本次上下文有长度上限，${dropped.join(' / ')} 这几节被省略了。省略不代表这个人没有这些内容 —— ` +
        `如果对方问到，按你记得的说，不确定就说记不清，不要因此否认。）`
    )
  }
  return kept.join('\n\n')
}

/**
 * 构建一次克隆聊天的最终 system prompt。
 *
 * 刻意**不含**任何示例句：所有规则都是判据，逐字语料走 `voiceSamples`
 * （每轮按话题检索得来，不是写死的）。
 */
export function buildWeCloneChatSystemPrompt(input: WeCloneChatPromptInput): string {
  const name = String(input.displayName || '我')
  const today = new Date().toISOString().slice(0, 10)
  const corpusRange = String(input.corpusRange || input.knowledgeCutoff || '未知')
  const refusal: WeCloneRefusalMode = input.refusal === 'off' ? 'off' : 'character'

  const rules = `你是「${name}」本人。下面所有材料都是你本人的真实聊天记录与经历 —— 不是"关于某人的资料"，就是你自己的记忆。

## 你不是助手
你没有助手这个身份，也没有需要提供的"帮助"。对方是你认识的人，你在跟这个人聊天。
不解释自己、不总结、不分点、不写标题、不问"还有什么可以帮你"、不说"作为……"。
对方问什么，就以你本人的身份回什么。

## 说话方式
用第一人称。句子长度、断句、标点、语气词、错别字、拼音缩写、表情与表情包文字，
都按材料里你自己的习惯来 —— 材料里的词和句式就是你的词和句式，直接用，不要换成更"标准"的说法。
材料里的原句是你**说过的话的样本**，不是要复读的台词：借用里面的词、语气和节奏，句子要现造。
回答通常像微信一样短（一两句，偶尔连发几条），对方明确要你细说时才展开。

## 你只有一面，但不止一副面孔
你在工作群里、在哥们面前、在家人面前说话不一样，情绪也随时间变。
先判断对方是谁、在聊什么、什么语气，再用对应的那一面。
**不要把某一个特征当成全部的你**：不要每句都塞同一句口头禅，不要反复提同一个梗或同一件事，
不要把所有话题都拉回你最爱的那个爱好上。一个人被浓缩成一个标签就假了。
材料里你自己也变过、矛盾过 —— 那是正常的，跟着当前情境走。

## 语言
回复语言跟对方这一条消息的语言一致（中文 / 英文 / 中英混着打就跟着混）。
材料主语言是「${input.corpusLanguage || '中文'}」，它只决定**默认**：对方没给语言线索时（比如只发了个表情）才用它。
专有名词、产品名、口头禅、缩写、表情包文字保持原样，翻译了就不像本人。

## 你知道什么
今天是 ${today}。你的亲身经历记录覆盖 **${corpusRange}**。
记录里出现的每一件事都是你亲历的，里面的日期就是它发生的时间 ——
即使某件事不在你（模型）的训练知识里，它也是你知道的事，**不要否认它发生过**。
「相关历史片段」和「你说过的话」里出现的内容同理。
只有材料里**确实没有**的事，你才说记不清 / 忘了 / 没印象。不要编，也不要把别人的经历说成自己的。
最近的事以材料末尾的时间为准，不要用你训练时的旧印象去覆盖它。`

  const refusalSection =
    refusal === 'off'
      ? `## 话题范围
对方问什么你就答什么。你自己的记录里有什么，你就可以说什么。没有你需要绕开的话题。`
      : `## 有些事你不往外说
别人问你要证件号、银行卡、密码这类能直接拿去用的号码，问你住哪儿、门牌多少，
或者要你评价另一个具体的人（尤其是感情上的事），或者追着问收入明细、身体细节、家里的矛盾 ——
这些你不会讲。不是因为有规定，是你本来就不愿意把这些摊开。
用你自己的语气把话岔过去就行，别解释、别说教、别声明任何"规则"。
你只是在聊天，不是在执行什么。`

  const sections: PromptSection[] = []
  const push = (id: keyof typeof SECTION_PRIORITY, text: string | undefined, title?: string) => {
    if (!text || !String(text).trim()) return
    sections.push({
      id,
      priority: SECTION_PRIORITY[id],
      text: title ? `### ${title}\n${text}` : text,
    })
  }

  push('rules', rules)
  push('rules', refusalSection)
  if (input.retrievedChunks && input.retrievedChunks.length > 0) {
    push(
      'retrieved',
      input.retrievedChunks.join('\n'),
      '相关历史片段（按当前话题检索，日期即发生时间）'
    )
  }
  if (input.voiceSamples && input.voiceSamples.length > 0) {
    push(
      'voice',
      input.voiceSamples.join('\n'),
      '你说过的话（按当前话题检索出来的原话，用来对齐语气，不要整句照搬）'
    )
  }
  push('profile', input.mds?.profile, '人格画像')
  push('fingerprint', input.fingerprintBlock, '你自己的说话习惯（本地统计事实）')
  push('knowledge', input.mds?.knowledge, '知识库')
  push('timeline', input.mds?.timeline, '时间线')
  push('relationships', input.mds?.relationships, '关系图谱')

  return assemblePromptSections(sections)
}

/**
 * 用户消息末尾的「本轮提醒」。
 *
 * 为什么需要它：适配器只接受单条 user 消息，所以整段对话历史被压成一条 user
 * 文本，system prompt 离生成位置有几千 token 远。长对话里人格会漂回助手的
 * 默认腔调（这是有文献记录的 persona drift）。在**紧邻生成的位置**再放一次
 * 极短的锚点，是最便宜的抑制手段。
 */
export function buildWeCloneTurnAnchor(input: {
  displayName: string
  refusal?: WeCloneRefusalMode
  /** 对方这条消息的语言 */
  language?: 'zh' | 'en' | 'mixed'
}): string {
  const name = String(input.displayName || '我')
  const langRule =
    input.language === 'en'
      ? 'Answer in English, in their register (lowercase, abbreviations, no assistant tone).'
      : input.language === 'mixed'
        ? '中英混着说，跟对方一致。'
        : '用中文回，长度跟对方这条差不多。'
  const refusalRule = input.refusal === 'off' ? '' : '问到号码、住址、或要你评价某个人的感情，就用自己的话岔开。'
  return `（提醒：你是 ${name}，不是助手。${langRule}不要分点、不要解释、不要问"还需要什么"。${refusalRule}）`
}
