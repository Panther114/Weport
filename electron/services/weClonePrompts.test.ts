import { describe, expect, it } from 'vitest'
import {
  WECLONE_MD_SYSTEM_PROMPT,
  WECLONE_MAP_SYSTEM_PROMPT,
  WECLONE_SYSTEM_PROMPT_CHAR_BUDGET,
  assemblePromptSections,
  buildWeCloneChatSystemPrompt,
  buildWeCloneMapPrompt,
  buildWeCloneMdPrompt,
  buildWeCloneReducePrompt,
  buildWeCloneTurnAnchor,
  refusalModeLabel,
} from './weClonePrompts'

/**
 * WeClone 提示词契约（v1.0.1）。
 *
 * 这个文件守的是用户提出的三条硬要求，每一条都对应一次真实的抱怨：
 *
 * 1. **system prompt 里不能有预设的示例内容**（"不要嵌入预设的行为引文"）。
 *    旧版在拒答一节里写了 `例如："这个我不想聊"` —— 那是会被复读的台词，
 *    而且换个克隆复读出来的东西完全不同（不可复现）。
 * 2. **知识边界不能写成"我不知道"的负面指令**。旧版写"资料截止 X 之后的事
 *    一概不知"，结果模型连语料里明明有的事也一起否认 —— 用户报的"知识截止
 *    没有真正反映"就是这个。
 * 3. **拒答必须是每个克隆自己的开关**，关掉之后 prompt 里完全不出现这件事。
 */

const baseInput = {
  displayName: '我',
  knowledgeCutoff: '2026-08-01',
  corpusRange: '2019-03-04 ~ 2026-08-01',
  corpusLanguage: '中文',
  mds: {
    profile: '# profile.md\n性格：做事前先查资料。',
    relationships: '# relationships.md\n和 A 说话很短。',
    knowledge: '# knowledge.md\n词条：草 — 表示无语。',
    timeline: '# timeline.md\n2024 年换了工作。',
  },
  fingerprintBlock: '- 单条长度：平均 8.4 字',
}

describe('拒答行为是每个克隆自己的开关', () => {
  it('默认（character）包含"有些事你不往外说"这一节', () => {
    const prompt = buildWeCloneChatSystemPrompt({ ...baseInput, refusal: 'character' })
    expect(prompt).toContain('有些事你不往外说')
  })

  it('关掉之后这一段**完全不出现**（不是弱化，是消失）', () => {
    const prompt = buildWeCloneChatSystemPrompt({ ...baseInput, refusal: 'off' })
    expect(prompt).not.toContain('有些事你不往外说')
    expect(prompt).not.toContain('把话岔')
    // 取而代之的是一句正向的话，而不是留一片空白
    expect(prompt).toContain('没有你需要绕开的话题')
  })

  it('缺省视为 character（不能因为字段漏传就变成不设限）', () => {
    const prompt = buildWeCloneChatSystemPrompt({ ...baseInput })
    expect(prompt).toContain('有些事你不往外说')
  })

  it('标签文案说的是会发生什么，不是「开/关」', () => {
    expect(refusalModeLabel('character')).toContain('本人的方式')
    expect(refusalModeLabel('off')).toContain('不设限')
  })
})

describe('知识边界：肯定式而非"我不知道"', () => {
  const prompt = buildWeCloneChatSystemPrompt({ ...baseInput })

  it('明确写出语料覆盖的时间范围', () => {
    expect(prompt).toContain('2019-03-04 ~ 2026-08-01')
  })

  it('断言记录里的事都亲历过 —— 而不是"截止之后一概不知"', () => {
    expect(prompt).toContain('都是你亲历的')
    expect(prompt).toContain('不要否认它发生过')
    // 旧实现的那句负面指令必须彻底消失
    expect(prompt).not.toContain('一概不知')
  })

  it('写下今天的日期，避免模型拿训练时的旧日期当"现在"', () => {
    const today = new Date().toISOString().slice(0, 10)
    expect(prompt).toContain(today)
  })

  it('只在材料确实没有时才允许说记不清（并要求不要编）', () => {
    expect(prompt).toContain('记不清')
    expect(prompt).toContain('不要编')
  })
})

describe('system prompt 里没有任何预设示例内容', () => {
  const prompt = buildWeCloneChatSystemPrompt({
    ...baseInput,
    retrievedChunks: ['--- 「项目群」 2024-05-06 ---\n我: 这个我来吧'],
    voiceSamples: ['行吧那就这样', '我先看看'],
  })

  /**
   * 判据不是"没有引号"（检索到的原话本身就在引号/破折号里），而是
   * **没有以"例如"开头的示范台词**。旧版的两处示范：
   *   `例如："这个我不想聊""抱歉，这属于隐私""问这个干嘛，换一个"`
   * 与
   *   `### 语言样例（逐字模仿这些句子）`
   */
  it('没有"例如：…"形式的示范台词', () => {
    expect(prompt).not.toMatch(/例如[：:]\s*[“"]/)
  })

  it('没有"逐字模仿这些句子"这类把静态清单当台词的标注', () => {
    expect(prompt).not.toContain('逐字模仿')
    expect(prompt).not.toContain('口头禅照抄')
  })

  it('检索到的原话标成"不要整句照搬"（他们那边是证据，不是台词）', () => {
    expect(prompt).toContain('不要整句照搬')
  })

  it('所有规则都是判据式（"不要…" "先判断…"），而不是可复制的整句', () => {
    // 抽查几条规则语句存在，说明规则没有被示例挤掉
    expect(prompt).toContain('先判断对方是谁')
    expect(prompt).toContain('不要把某一个特征当成全部的你')
  })
})

describe('多面性与反过拟合', () => {
  const prompt = buildWeCloneChatSystemPrompt({ ...baseInput })

  it('明确要求不要抓着某一个特征反复用', () => {
    expect(prompt).toContain('不要把某一个特征当成全部的你')
    expect(prompt).toContain('不要每句都塞同一句口头禅')
  })

  it('要求按对象/场合切换那一面，而不是所有场合一个样', () => {
    expect(prompt).toContain('工作群里')
    expect(prompt).toContain('家人面前')
    expect(prompt).toContain('对应的那一面')
  })

  it('接受人物是矛盾/会变的（不要抹平成一个人设）', () => {
    expect(prompt).toContain('矛盾过')
    expect(prompt).toContain('正常的')
  })
})

describe('本轮锚点', () => {
  it('放在 user 消息末尾、极短，并重申身份与长度', () => {
    const anchor = buildWeCloneTurnAnchor({ displayName: '我', language: 'zh' })
    expect(anchor).toContain('你是 我，不是助手')
    expect(anchor).toContain('不要分点')
    expect(anchor.length).toBeLessThan(200)
  })

  it('英文提问时锚点也切成英文（否则标签本身会把模型拉回中文）', () => {
    const anchor = buildWeCloneTurnAnchor({ displayName: 'me', language: 'en' })
    expect(anchor).toContain('Answer in English')
    expect(anchor).not.toContain('用中文回')
  })

  it('拒答关闭时锚点里不提拒答', () => {
    expect(buildWeCloneTurnAnchor({ displayName: '我', refusal: 'off' })).not.toContain('岔开')
    expect(buildWeCloneTurnAnchor({ displayName: '我', refusal: 'character' })).toContain('岔开')
  })
})

describe('按优先级拼装：超预算时整节丢弃并说明', () => {
  const sections = [
    { id: 'rules' as const, priority: 100, text: 'R'.repeat(100) },
    { id: 'retrieved' as const, priority: 90, text: 'V'.repeat(100) },
    { id: 'relationships' as const, priority: 35, text: 'X'.repeat(100) },
  ]

  it('预算充足时全部保留', () => {
    const out = assemblePromptSections(sections, 1000)
    expect(out).toContain('RRR')
    expect(out).toContain('VVV')
    expect(out).toContain('XXX')
  })

  it('超预算时丢弃**低优先级整节**，而不是把某一节切一半', () => {
    const out = assemblePromptSections(sections, 250)
    expect(out).toContain('RRR')
    expect(out).toContain('VVV')
    // 关系图谱整节被丢掉 —— 不会留下半截 'XXXXX'
    expect(out).not.toContain('XXX')
  })

  it('被丢弃的节会明确告知模型，避免它对缺失部分凭空编造', () => {
    const out = assemblePromptSections(sections, 250)
    expect(out).toContain('relationships')
    expect(out).toContain('省略不代表这个人没有这些内容')
  })

  it('预算比第一节还小时仍然保留第一节（否则 prompt 会空成一片）', () => {
    const out = assemblePromptSections(sections, 10)
    expect(out).toContain('RRR')
  })

  it('预算远大于旧实现的 24000 —— 旧值会把一份真实语料切掉大半', () => {
    expect(WECLONE_SYSTEM_PROMPT_CHAR_BUDGET).toBeGreaterThan(100_000)
  })
})

describe('生成阶段的 prompt', () => {
  /**
   * 这条断言是拿一次**真实的生成**换来的。
   *
   * `buildWeCloneMapPrompt` 曾经完全没把 `input.context` 插进模板 —— prompt 里
   * 只有时间范围和会话名。13 个分片于是全部回复"本节无"，最终 profile.md 开头
   * 写着"13 段分片的正文全部缺失"。管线跑得又稳又久，产物是一份空壳。
   *
   * 原来的断言只检查"有小节标题"（`## 说话方式` 之类），标题当然在 —— 它们是
   * 模板里的固定文本。**能通过那种断言的实现，恰恰就是坏掉的那一版。**
   * 所以这里改成检查真正要紧的东西：模板里有没有那块语料。
   */
  it('分片 prompt 里必须**真的带上语料正文**（漏掉它等于白跑一整套管线）', () => {
    const corpus = '我: 今天先把导出那块收掉\n老王: 行，你先弄'
    const prompt = buildWeCloneMapPrompt({ sessionLabel: '项目群', timeRange: '2024-01 ~ 2024-06', context: corpus })
    expect(prompt).toContain(corpus)
    // 两个占位位置都要能一眼认出来：模型需要知道正文从哪开始、到哪结束
    expect(prompt).toContain('===== 聊天记录 =====')
    expect(prompt).toContain('===== 聊天记录结束 =====')
  })

  it('语料为空时也贴出分隔标记（模型能看出"这一段没内容"而不是"你没给我"）', () => {
    const prompt = buildWeCloneMapPrompt({ sessionLabel: '项目群', timeRange: '2024-01', context: '' })
    expect(prompt).toContain('===== 聊天记录 =====')
    expect(prompt).toContain('本节无')
  })

  it('分片提炼要求结构化取证，并要求"本节无"而不是留空', () => {
    const prompt = buildWeCloneMapPrompt({ sessionLabel: '项目群', timeRange: '2024-01 ~ 2024-06', context: '语料' })
    expect(prompt).toContain('## 说话方式')
    expect(prompt).toContain('## 生活与经历')
    expect(prompt).toContain('## 人与关系')
    expect(prompt).toContain('本节无')
    expect(prompt).toContain('2024-01 ~ 2024-06')
  })

  it('分片提炼明确禁止把"放之四海而皆准的评语"写进来', () => {
    expect(WECLONE_MAP_SYSTEM_PROMPT).toContain('放之四海而皆准')
  })

  it('MD prompt 里也必须带上整体材料（同一个坑的另一半）', () => {
    const material = '【分片 1｜2024-01 ~ 2024-06】\n## 说话方式\n爱用「草」'
    const prompt = buildWeCloneMdPrompt('profile', material, { redact: true })
    expect(prompt).toContain(material)
  })

  it('脱敏开启时带敏感信息条款与 [已过滤:…] 要求', () => {
    const prompt = buildWeCloneMdPrompt('profile', '材料', { redact: true })
    expect(prompt).toContain('敏感信息（硬要求）')
    expect(prompt).toContain('[已过滤:敏感信息]')
  })

  it('脱敏关闭时那一节整段消失，并明确要求不要输出占位符', () => {
    const prompt = buildWeCloneMdPrompt('profile', '材料', { redact: false })
    expect(prompt).not.toContain('敏感信息（硬要求）')
    expect(prompt).toContain('不要删减')
    expect(prompt).toContain('不要输出 [已脱敏')
  })

  it('风格指纹作为"算出来的事实"注入，并要求不得与它矛盾', () => {
    const prompt = buildWeCloneMdPrompt('profile', '材料', { redact: true, fingerprintBlock: '- 平均 8.4 字' })
    expect(prompt).toContain('本地统计事实')
    expect(prompt).toContain('平均 8.4 字')
    expect(prompt).toContain('不要和它们矛盾')
  })

  it('撰写指令要求多面性（这是反过拟合在生成侧的对应要求）', () => {
    const prompt = buildWeCloneMdPrompt('profile', '材料', { redact: true })
    expect(prompt).toContain('多面性')
  })

  it('撰写 system prompt 明确禁止空话', () => {
    expect(WECLONE_MD_SYSTEM_PROMPT).toContain('禁止')
    expect(WECLONE_MD_SYSTEM_PROMPT).toContain('性格开朗')
  })
})

describe('buildWeCloneReducePrompt 的篇幅要求', () => {
  it('带目标篇幅时把要求写进 prompt（否则材料会顶穿 MD 调用的上下文窗口）', () => {
    const prompt = buildWeCloneReducePrompt(['a', 'b'], 50_000)
    expect(prompt).toContain('篇幅要求')
    expect(prompt).toContain('5 万字')
    // 压缩的方向必须是"丢空话、留细节"，不是随便删
    expect(prompt).toContain('保留具体的人、事、时间、用词')
  })

  it('不带目标篇幅时不出现篇幅要求（中间层归并不需要它）', () => {
    expect(buildWeCloneReducePrompt(['a', 'b'])).not.toContain('篇幅要求')
  })

  it('分片正文照旧全部带进 prompt', () => {
    const prompt = buildWeCloneReducePrompt(['片段甲', '片段乙'])
    expect(prompt).toContain('片段甲')
    expect(prompt).toContain('片段乙')
    expect(prompt).toContain('分片 2/2')
  })
})
