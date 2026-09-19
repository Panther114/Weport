# WeClone（人格克隆）与它的服务解析

> 从 `AGENTS.md` 拆出：这里是模块与历史说明，不是动手前必读的不变量。

## WeClone (`electron/services/weCloneService.ts`) — v1.0 (local-only)

Cloning yourself and talking to the clone. **Data never leaves the device.** There is no
server, no upload, and no cloud path — the boundary is hard. The only outbound call is the
user's own configured model API.

- `chatWithClone()` is the one entry point, reached from the card's 开始对话 button
  (`weCloneService` → IPC `weclone:chat` → the chat drawer) and from `weclone.chat` in the
  CLI/TUI. Do not add a second chat path.
- Retrieval is **local BM25** over `chunks.jsonl` (`ai/localRetrieval.ts`) — no embedding
  model, no vector service. The persona MDs plus the retrieved snippets become the system
  prompt (measured: 24.7 k characters for the real clone).
- Failure has to carry a next step: `chatWithClone` returns `hint` alongside `error`. A bare
  "failed" leaves the user with no idea what to do.
- Generation is transactional: write to `${dir}.building`, rename the old clone to
  `${dir}.previous`, move the staged one in, delete the backup. A crash never leaves a
  half-written clone in place.
- **Deleting a clone judges the *clone*, not the directory** (v1.0.1). The user's report was
  "it says 删除失败 but the clone is gone — 目录不为空". `rmSync(dir, {recursive:true})` had
  deleted `meta.json` and every MD and then thrown on one of the two big JSONL files
  (23 MB `chunks.jsonl` / 3.8 MB `voice.jsonl` — a real-time AV scan holding the file for a
  moment), after which the parent `rmdir` failed with **ENOTEMPTY**. `rmSync` defaults to
  `maxRetries: 0`, so a single transient lock is fatal. Two fixes, both needed:
  `electron/services/rmTree.ts` (retries + clears read-only + re-checks existence, so
  "threw but it's actually gone" reports success), and `deleteClone` re-asks
  `findCloneDir(id)` after the attempt — `meta.json` is what makes a clone visible, so a
  leftover fragment must not turn a successful delete into a failure report.
- Generation used to run a second, 5 %-sampled corpus pass (~800 model calls) whose output
  was only consumed by the deleted upload path. There is no such pass; generation is minutes,
  not hours.
- `weclone-server/` is **not part of the product** any more. Do not reintroduce a client
  path, a server-status surface, or a visibility/share concept.

### WeClone Chat History & Language — v1.0.1

- **Chats are persisted, one JSON file per clone** (`{userData}/weclone-chats/<cloneId>.json`,
  whole-file atomic write; the id is sanitised for the filename). The drawer writes the
  *entire* turn list after every answer — a turn list is tens of messages, and "write it all"
  cannot leave half a message behind. `deleteClone()` deletes the file too: history without
  its clone is orphan data. Renaming keeps the user's title; a chat with no title gets the
  first user message (truncated to 24 chars), same habit as WeChat.
- **Every history assertion goes to disk, not to the screen.** "The list looks right" cannot
  distinguish an in-memory array from a file, and rename/delete are exactly the operations
  that get implemented as React state only. `.ui-probe/verify-weclone-history.mjs` re-reads
  the JSON after each step (new chat / revisit / rename / delete / reopen) — 14 assertions.
- **The clone now mirrors the other side's language.** The system prompt was entirely Chinese,
  so the model answered in Chinese no matter what the corpus looked like. Three parts to the
  fix, and all three matter: a hard rule in `WECLONE_CHAT_SYSTEM_PROMPT` ("回复语言 = 对方这条
  消息的语言"), a **default** derived from `language.md` (the person's *verbatim* lines —
  `profile.md` etc. are model-written Chinese and always detect as 中文), and transcript
  labels that follow the message (`Them:`/`Me:` in English instead of `对方：`, which by itself
  pulls the model back to Chinese). `detectLanguage()` is a character-composition check
  (`zh`/`en`/`mixed`) — no dictionary.
- Verification split on purpose: `verify-weclone-e2e.mjs` (local OpenAI-compatible mock)
  asserts **what is fed to the model** — prompt rule present, corpus language injected,
  `Them:` label for an English turn, `meta.replyLanguage` — and
  `.ui-probe/check-clone-language-live.mjs` asserts **what the model answers** against the
  real corpus (measured: English in → `yo, mostly grinding on gonopoly …` out, cjkRatio 0.00;
  Chinese in → cjkRatio 0.51, i.e. Chinese with English tech words, exactly the user's own
  register).

### WeClone Chat History & Language — v1.0.1

- **Chats are persisted, one JSON file per clone** (`{userData}/weclone-chats/<cloneId>.json`,
  whole-file atomic write; the id is sanitised for the filename). The drawer writes the
  *entire* turn list after every answer — a turn list is tens of messages, and "write it all"
  cannot leave half a message behind. `deleteClone()` deletes the file too: history without
  its clone is orphan data. Renaming keeps the user's title; a chat with no title gets the
  first user message (truncated to 24 chars), same habit as WeChat.
- **Every history assertion goes to disk, not to the screen.** "The list looks right" cannot
  distinguish an in-memory array from a file, and rename/delete are exactly the operations
  that get implemented as React state only. `.ui-probe/verify-weclone-history.mjs` re-reads
  the JSON after each step (new chat / revisit / rename / delete / reopen) — 14 assertions.
- **The clone now mirrors the other side's language.** The system prompt was entirely Chinese,
  so the model answered in Chinese no matter what the corpus looked like. Three parts to the
  fix, and all three matter: a hard rule in `WECLONE_CHAT_SYSTEM_PROMPT` ("回复语言 = 对方这条
  消息的语言"), a **default** derived from `language.md` (the person's *verbatim* lines —
  `profile.md` etc. are model-written Chinese and always detect as 中文), and transcript
  labels that follow the message (`Them:`/`Me:` in English instead of `对方：`, which by itself
  pulls the model back to Chinese). `detectLanguage()` is a character-composition check
  (`zh`/`en`/`mixed`) — no dictionary.
- Verification split on purpose: `verify-weclone-e2e.mjs` (local OpenAI-compatible mock)
  asserts **what is fed to the model** — prompt rule present, corpus language injected,
  `Them:` label for an English turn, `meta.replyLanguage` — and
  `.ui-probe/check-clone-language-live.mjs` asserts **what the model answers** against the
  real corpus (measured: English in → `yo, mostly grinding on gonopoly …` out, cjkRatio 0.00;
  Chinese in → cjkRatio 0.51, i.e. Chinese with English tech words, exactly the user's own
  register).

## WeClone Provider — v1.0.1 (local-only, no forced service)

- **WeClone has no service of its own.** It resolves through
  `ProviderProfileService.getForConsumer('weclone')`, which falls back to the default, so it
  uses whatever the user configured (DeepSeek on this machine). The old
  `ensureForcedProvider()` locked it to `opencode-go / muse-spark-1.2-contributor` and created
  a profile the user never asked for; that gateway is geo-blocked here, so WeClone could only
  ever answer "Internal server error" while a working service sat configured next to it.
  Removed end to end: IPC channels, `src/components/weclone/WeCloneForcedKey.tsx`, the
  `WECLONE_FORCED_*` constants in `config.ts`. `LEGACY_FORCED_PROVIDER_ID` /
  `LEGACY_FORCED_MODEL` still exist in `weCloneService.ts` **for the one-time cleanup only**
  (`purgeLegacyForcedProfile()` deletes that profile and the consumer assignment on startup).
  `muse-spark` still appears in `electron/assets/models/models-dev-snapshot.json` — that is
  the models.dev catalog (the provider really serves it), not a forced choice.
- **A profile can exist with no API key, forever.** `migrateLegacyProfile()` writes a profile
  even when `weportAiApiKey` is empty at that moment, and once a valid store exists `read()`
  never migrates again — so a key added later never reached the profile. On this machine that
  produced a keyless DeepSeek profile and "未配置 AI API Key" with a perfectly decryptable
  35-character key sitting in the legacy field. `healKeylessProfile()` repairs exactly that
  state (only when exactly one profile lacks a key, and provider/baseUrl agree).
- A request sent without a key comes back as `Authentication Fails`, which reads like "your key
  is wrong". Filter candidates by `apiKey` (or `apiKeyOptional`) **before** calling, and say
  "this service has no API key" instead.
- `chatWithClone` returns the answering `model` / `providerId` in `meta`; the drawer prints it.
  Verification: `.ui-probe/verify-weclone-e2e.mjs` drives the real UI against a local
  OpenAI-compatible mock (SSE), so the chain is proven independently of the user's key.

## WeClone 生成管线 — v1.0.1（分段提炼 / map-reduce）

v1.0 的做法是**从全语料里随机抽 250 个分块**，拿这一份采样去写五份 MD。对一份
10 万条消息的聊天记录，模型只看到 0.5‰ —— 产出的画像是"性格开朗、喜欢打游戏"
这类放在谁身上都成立的话。用户的原话是**"它根本不了解我"**。

现在改成 map-reduce：

```
会话列表 → 游标扫描 → chunks.jsonl + voice.jsonl + 风格指纹（本地统计）
  → 按时间等宽切 N 片（4 ≤ N ≤ 60）
  → 每片一次模型调用，输出结构化取证摘要（map，并发 3）
  → 分层归并（reduce）
  → 五份 MD（每份独立一次调用）
  → 敏感信息二审（脱敏开启时）
  → 原子换上去
```

**每一片覆盖一个不同的时间段**，所以整段历史里每一段都至少有一次被看到的机会 ——
这是"历史不能被截断"在采样层面的兑现，和"随机抽 250 块"有本质区别。

### 数字与它们的来历

| 常量 | 值 | 为什么 |
|---|---|---|
| `MAP_CHARS_PER_SHARD` | 90_000 | 10 万条消息（≈3.3M 字符）→ 约 37 片。第一次真机跑用的是 260k（13 片、4.3 分钟），用户明确说过"可以十分钟或再长一点，要尽可能多花 token"，4 分钟是明显没吃够 |
| `MAP_SHARD_CONTEXT_CHARS` | 24_000 | 每片给模型的正文量，≈1.7 万 token |
| `MAP_MAX_SHARDS` | 60 | 调用次数上限，防止病态语料把一次生成拖成几百次调用 |
| `MAP_CONCURRENCY` | 3 | DeepSeek 侧实测 3 路稳定，再高容易限流 |
| 桶内保留分块 | 70 | 桶内不足 70 块时**全收**（几千条消息的常见规模不是抽样）；大语料下给 `buildShardContext` 留出等间隔取舍的余地 |
| `PER_SESSION_MESSAGE_CAP` | 12_000_000 | 旧值 15 万会在长群聊上悄悄触发，卡片上冒出「数据量过大已截断」—— 用户原话 "This should never happen" |
| `MD_CHAR_LIMIT` | 120_000 | 旧值 12_000 会在**模型还在写**的时候把结果从中间切掉 |

### 实测结果（本机真实语料，用于对照"改动到底有没有效果"）

语料：103,970 条消息 / 184 个会话 / 21,201 个分块 / 22.4 MB，时间跨度 2026-03 ~ 2026-09。
经 `.ui-probe/verify-v101.mjs` 在**安装版**上真机跑过多次，取稳定值：

| 指标 | v1.0（随机抽 250 块） | v1.0.1（37 段 map-reduce） |
|---|---|---|
| 模型看到的语料 | 250 块 ≈ 0.5‰ | 37 段 × 每段约 24k 字（等间隔覆盖全时段） |
| profile.md | 9.6 KB | **32–57 KB** |
| knowledge.md / timeline.md | 14.1 / 13.3 KB | 30–43 / 35–48 KB |
| token 用量 | 未记录 | 输入 55–73 万 / 输出 37–43 万 |
| 耗时 | ~2 分钟 | **17–20 分钟** |
| 空话（"性格开朗"之类） | 命中 | 未命中 |

**档案质量上最直观的差别是"多面性"真的写出来了。** 现在 `profile.md` 有
「多面性总表（本文件最重要的一节）」，按对象分面孔（对同学/群友 = 默认态、
对老师 = 语域硬切、对合作方 = 英文办事流、对项目队友 = 派活态、正式写作文体 = 稀有），
每一副面孔都带**原文对照**与时间锚点；另有口癖黑话词典（按时间波次分组）、
标点/大小写习惯、表情时间线、错别字处理规则。这些都是"随机抽 250 块"写不出来的 ——
那种采样下模型只能给出"性格开朗、喜欢打游戏"这类谁都成立的话。

对话侧同样有可对账的读数（抽屉底部的统计行）：
`deepseek-v4.1-flash · 历史片段 24 段 · 语气样本 14 条 · 敏感话题：以本人方式带过 · 用时 ~2.0s`。
"语气样本 14 条"就是按话题检索到的本人原话条数 —— 它是 0 的时候，回复一定会滑回助手腔。

### 三个必须记住的坑

1. **`buildWeCloneMapPrompt` 必须真的贴出语料。** 它曾经漏掉 `${input.context}` ——
   prompt 里只有时间范围和会话名。13 个分片于是全部老实回复"本节无"，最终
   `profile.md` 开头写着"13 段分片的正文全部缺失"。管线跑得又稳又久，产物是一份空壳。
   原来的单测只断言"有小节标题"（那些是模板里的固定文本，当然在）——
   **能通过那种断言的实现，恰恰就是坏掉的那一版**。现在 `weClonePrompts.test.ts`
   断言的是 `expect(prompt).toContain(corpus)`。
2. **归并循环必须收敛，而且"收敛"要能被不花钱地验证。** 第一版 `reduceDigests` 是
   `while (总字符 > 预算) 再压一层`，分组允许"一段超长摘要独占一组"—— 那一组调用只是
   把同一段摘要原样重写一遍，材料大小不变，**循环永远出不去**。实测跑到第 7 层还在继续
   （十几分钟、十几次调用、都在花钱），只能人工掐掉。现在循环由
   `ai/reducePlan.ts` 的纯函数 `planReduceStep` 决定：每组至少两段、只剩两段直接收尾、
   层数上限 3。`reducePlan.test.ts` 用 `simulateReducePath`（不调用模型）断言 7 种规模
   下都在 3 层内收敛 —— 这类循环的 bug 只能在"不花钱地跑一遍"里发现。
3. **分片失败不能静默丢弃。** 失败的那一片会用本地统计拼一条最小摘要并写明
   "这一片未能提炼"，同时计入 `shardFailures` 显示在卡片上。静默丢一片等于把那段
   历史从人格里删掉，而用户无从察觉。
4. **成功与失败必须是两个不同的终态。** `generateClone` 原来两个方向都用
   `report('done', 100, …)` 收尾（失败时消息写成"生成失败：…"），于是任何只看
   `stage` 的消费方都把一次失败读成"完成"—— 实测出现过面板写着「生成完成」而磁盘上的
   `metadata.json` 还是上一版。现在失败发 `stage: 'failed'`，并且 `WeCloneProgress`
   的终态文案以 **store 的 `status`** 为准（那是渲染层与主进程各自显式写入的），
   stage 只作兜底。失败时面板还会把真实原因直接摆出来 —— 原来原因只躺在滚动日志里。
5. **重新生成会换 clone id，界面必须跟着刷新。** 生成完成时 `handleGenerate` 里那句
   `refreshList()` 只在"发起生成的那个组件实例还活着"时跑得掉；用户切走过就刷不到。
   现在 `WeClonePage` 挂在 store 的 `status === 'done'` 上刷新，并且设置面板遇到
   "找不到该克隆"时会把用户拉回列表（那是**过期**信号，不是保存失败）—— 否则界面停在
   一张过期的卡片上，改十次设置十次都被静默回滚。
6. **归并结果要有篇幅上限。** 归并产出要整段塞进**每一份** MD 的 prompt（五份各一次
   调用），不封顶就可能顶穿上下文窗口，而报错在界面上只是一句"生成失败"。最终归并会
   被要求压到 `MD_MATERIAL_TARGET_CHARS`（5 万字），`fitMaterial()` 是模型没听话时的
   兜底 —— 它按**等间隔抽段**而不是掐尾巴（只留前半段等于把近半年的事删掉），
   并把"抽掉了多少"明确写进材料。
7. **风格指纹是算出来的，不是问出来的。** `weCloneFingerprint.ts` 在扫描阶段就统计
   标点习惯、长度分布、表情密度、高频片段 —— 确定性、可复现（同一语料两次结果逐位
   相同），而且**不能**交给模型转述（转述必然引入偏差，而这批数字正是用来对账的）。
   直接追加在 `profile.md` 末尾，同时单独落盘 `fingerprint.json` / `fingerprint.txt`。

### 中英两种语料要分开统计

本机真实语料是 **84% 拉丁字母**。汉字那套 n-gram 滑窗套到英文上只会切出
`the` / `ing ` / `tion` 这类**词缀碎片** —— 实测 40 条"高频片段"全是这种东西，
等于什么都没说。现在英文按**整词 + 二元搭配**统计，并过滤英文停用词；
中文与英文分成两组分别渲染（中英的"高频"不是一个量纲）。

### 每轮聊天的检索分两路

- `chunks.jsonl`（全部消息）→ **相关历史片段**，带日期与说话人；
- `voice.jsonl`（**只有本人说的话**）→ **语气样本**，同一话题下本人说过的原话。

第二路是 v1.0.1 的关键改动：旧版把 `language.md` 的 30-50 条原句整段写进 system
prompt 并标注"逐字模仿" —— 那是一份静态清单，跟当前话题无关，模型要么整段照抄
要么完全忽略，而且每个克隆都不同、不可复现（用户明确反对 system prompt 里出现
预设示例）。改成按话题检索之后，样本每轮不同，而且**不是 prompt 的一部分**，
是本轮输入的一部分。

**检索必须是"预筛 + 回读"两遍，不能全量分词。** 旧实现对本机 21,201 个分块
逐条 `JSON.parse` + 分词，实测一次 1.4–2.8 秒 —— 每次聊天都要先等这么久才轮到
模型。关键观察是**正文是那一行 JSON 的子串**，所以先用 `includes` 预筛，
只有可能命中的行（通常占 1–5%）才值得解析与分词。真实语料实测（22.4 MB /
21,201 块）：

| 查询 | 全量分词 | 预筛 | 倍数 |
|---|---|---|---|
| 最近在忙什么 | 1411 ms | **334 ms** | 4.2× |
| what are you working on lately | 1582 ms | **929 ms** | 1.7× |
| the | 2777 ms | **736 ms** | 3.8× |

候选集与 df 都是**精确**的；只有非候选行的文档长度用了一次字符扫描估算
（`estimateTokenCount`，汉字算 1、拉丁词算 1）。BM25 的长度项只要量纲一致、
单调即可 —— 见 `scanRetrievalCandidates` 的注释。

### system prompt 的三条硬规矩（`weClonePrompts.test.ts` 逐条盯着）

1. **没有预设示例内容。** 旧版在拒答一节写了 `例如："这个我不想聊""抱歉，这属于
   隐私"` —— 那是会被复读的台词。现在所有规则都是判据，一句可照抄的话都不留。
2. **知识边界写成肯定式。** 旧版写"资料截止 {cutoff} 之后的事一概不知" ——
   典型的负面指令：它把注意力引到"我不知道"上，于是连语料里明明有的事也一起否认
   （用户报的"知识截止没有真正反映"）。现在写的是"记录里的每一件事你都亲历过，
   日期就是它发生的时间"，只对记录里确实没有的事要求说记不清。
3. **拒答是每个克隆自己的开关**（`{cloneDir}/settings.json` 的 `refusal`）。
   `character`（默认）= 以本人的方式带过去；`off` = prompt 里连这一节都不出现。

### 生成选项

- **脱敏**（`config.wecloneRedact`，默认 `true`）在**导出页**勾选：关掉之后扫描不替换
  占位符、生成 prompt 里的敏感条款整段消失、二审也跳过。语料仍然不出本机 ——
  这个开关控制的是"要不要多做一层遮蔽"。
- **拒答**在**每个克隆的卡片**上改（「行为」按钮），存进克隆目录，跟着档案与语料
  一起生灭。

## 长任务进度（v1.0.1）—— 为什么不能再存在页面 state 里

用户报的是三件事：**生成克隆时切页面看不到进度、导出时切页面进度条归零、
连接微信时切页面不知道连上没有**。根因是同一个：进度只活在它自己那个页面的
`state` 里，而页面是 `React.lazy` + 条件渲染，切走即卸载。更狠的是 v1.0.3 起
托盘隐藏会**销毁窗口**、最小化会 unload 页面 —— 渲染进程可能整个重建。

两层修法，缺一不可：

1. **数据层**：`src/utils/liveTask.ts`（模块级 store）+ `liveTaskWiring.ts`
   （由 `main.tsx` 在**应用启动时**接线，早于任何页面挂载）+ 主进程
   `taskStatusService`（`task:status` 快照）。窗口重建后 `refreshFromMain()`
   把进度、日志、开始时间一起补回来。
2. **可见层**：`src/components/BackgroundTasks.tsx`，挂在 `App` 上、任何标签页都
   显示，带已用时间与"跳转 / 取消"。**数据还在但用户看不见，等于没修。**

三个坑：

- **导出推不出终态。** 导出的进度负载只有 `preparing / exporting / … / complete`
  六种阶段，取消和失败**根本不发事件**。本地状态会永远停在 running，左下角就会
  一直挂着一条不存在的导出。终态只能从主进程快照拿，所以要轮询。
- **过期的终态不能灌。** 窗口重建后如果主进程里躺着一个三天前的"生成完成"，
  界面上就会冒出一张属于上个世纪的完成卡片（`TERMINAL_SNAPSHOT_TTL_MS = 3 分钟`）。
- **WeClone 页自己的分区也是页面 state。** 进度搬进 store 之后，"切回来还在
  hub 入口页"会让进度依然看不见 —— `WeClonePage` 用模块级 `lastSection` 记住
  分区，并且**有任务在跑时直接落到 create**。这一条是探针实测抓出来的：
  第一次跑时 `back.panel` 是 false，因为回来落在 hub 上。

验证：`.ui-probe/verify-v101.mjs`（安装版 + 真实数据 + 真实模型）。
