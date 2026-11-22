# 阅读器自动回复草稿（v1.3.3）

> 从 `AGENTS.md` 索引进来。这里是"动手前必须知道"的条款；改阅读器草稿、
> WeClone 风格或按会话提示词之前先读。

## 它是什么

阅读器里，对方发来新消息后，自动用当前会话的聊天记录 + WeClone 分身**同时生成
多个风格的回复草稿**。**只生成、供审核、手动复制，不发送、不写入微信。**

## 分层（缺一不可）

```
src/components/reader/ReaderReplyDraft.tsx    手动选取片段（单条草稿）
src/components/reader/ReaderAutoDraftPanel.tsx 自动草稿设置 + 聊天区底部草稿卡片
  ↓ IPC readerDraft:*
electron/services/readerAutoDraftService.ts  主进程监听 + 去抖 + 3 路风格生成
  ↓
electron/services/chatService.ts             getMessagesForReaderDraft（区间读取）
  ↓
WeClone.chatWithClone                        人格档案 + 本地 BM25 + styleOverride
```

- **监听必须在主进程**。页面是 `React.lazy` + 条件渲染，切页会卸载；托盘隐藏
  会销毁窗口。监听如果活在 `useEffect` 里，"新消息到达"只在用户盯着这一页时
  成立 —— 这正是铁律 3 的反例。
- 轮询用 `chatService.getNewMessages`（它开自己的游标），**不要**复用
  `getMessages` 的共享游标：自动草稿的 start/end 与阅读器的分页范围不同，
  会反复关闭/重建阅读器游标，翻页位置会抖。
- 区间上下文用 `chatService.getMessagesForReaderDraft`：直接 offset 读取
  （offset 0 = 最新），不碰 `messageCursors`；最多扫描 2,000 条。

## 聊天自动刷新（同版本）

- 当前会话每 **4 秒** 用 `chat:getNewMessages` 追加一次新消息；不重建列表、
  不改 `firstItemIndex`，虚拟列表只在用户已经贴底时 `followOutput` 跟随。
- 左列会话栏每 **30 秒** 静默刷新（不切 `sessionsLoading`），更新 lastAt /
  unreadCount / summary。
- 用户正在看某一天（`timeWindow`）、正在加载或消息通道报错时暂停，避免把别的
  日期的新消息混进当前窗口。

## 触发与限流

- 一次监听一个会话；**切换阅读器里的会话不会停止它**，监听状态与草稿保留。
  在另一个会话点「开始监听」才会替换当前监听。账号 / 数据库切换、退出应用会停止。
- 只对 `isSend !== 1` 的真实消息触发；系统消息（10000/10002）跳过。
- 用户在微信里手动回复后，待生成草稿取消，已有草稿标记 `stale`。
- 消息突发时去抖 6 秒（首条最多等 30 秒）；两次生成至少间隔 12 秒；
  同时最多一条；**失败不自动重试**（避免持续花钱），用户可手动"再生成一次"。
- 草稿只存在主进程内存里，不落盘；应用退出即消失。

## 按会话保存的设置

`{userData}/reader-draft-settings.json`（`readerDraftSettingsService`）：

- 键 = 账号 + 会话；值 = `cloneId`、`range`（今日 / 7 天 / 30 天 / 全部）、
  用户手写的 `note`（**不设字数上限**，只做换行归一化与首尾空白清理）、
  `updatedAt`。
- 原子写；最多 500 个会话，按更新时间淘汰。
- 界面输入停下 700ms 自动保存，失焦 / 卸载时补写；下次打开同一会话自动带出。
- `note` 会**随每次自动草稿发送给模型服务**，界面上必须明确说明；它不是
  新的角色设定，也不能覆盖身份、记忆、安全规则与长度约束。
- 手动草稿同样使用 `note`，并计入 12,000 字符的既有上限。

## 上下文与提示词

- 最近消息完整保留，更早消息按时间均匀取样；字符预算 24,000、条数 240。
  超出时从最早开始舍弃，**目标消息永远保留**，并在界面显示"已截断"。
- "全部"只在最近可扫描的 2,000 条内取样；更长历史由 WeClone 自己的本地
  BM25 检索补充（`retrievalQuery` 只传"对方最后说了什么"，不要把整段 prompt
  丢给检索，否则意图会被稀释）。
- 回复语言由 `replyLanguageText` 决定（目标是图片/语音时退回最近一条对方
  文字），不要用整段上下文做语言检测。
- 自动草稿的 Reader 上限是 32,000 字符；手动草稿仍是 12,000。`chatWithClone`
  通过 `readerDraftMaxChars` 区分，不要在渲染层传一个大值绕过。
- **草稿正文必须是单段文本**：写入前经过 `normalizeDraftText`（`src/utils/readerDraftFormat.ts`），
  去掉空行/换行、列表符号与重复标点，并补齐句末标点。WeClone 对话抽屉的多气泡
  排版不受影响 —— 只整理阅读器草稿。
- **草稿从设置面板里摘出来**：生成结果作为独立卡片直接显示在聊天区底部
  （`.reader-auto-shelf`），设置栏退到它下面并默认折叠。三版横向并列、各自带
  复制按钮，另有「复制选中草稿」。
- 本会话补充提示词**不设字数上限**；它仍计入生成时的 prompt 上限（自动 32k /
  手动 12k），超出会明确报错，不会静默截断。

## 一次生成多个风格（生成后选择）

- 每条新消息、同一段上下文，**并行生成 3 个风格版本**：
  `relaxed` 自然轻松 / `gentle` 温柔 / `humorous` 幽默
  （`READER_AUTO_DRAFT_STYLES`）。生成前不需要选择风格。
- 这是 **3 次模型调用**；开启同意的文案必须写明，避免用户以为只花一次钱。
- 三版各自独立：某一版失败只在该卡片下列出错误，其余版本照常显示。
- 生成结果按风格顺序排列；用户点卡片选中，再复制选中版本，或直接点某一版的
  复制按钮。选中状态只影响「复制选中草稿」与高亮，不触发重新生成。
- 不要把它改回"先选风格再生成"：用户的明确要求是同时拿到多个版本再挑。

## WeClone 说话调整（同一版本）

- 每个克隆的 `settings.json` 增加 `style`（`original` / `relaxed` / `gentle` /
  `humorous` / `concise` / `earnest`）与 `styleNote`。
- 风格只改"怎么说"，不改档案与语料；注入 system prompt 的 `style` 节
  （优先级 96，低于硬规则），并在本轮锚点里放一行短提醒。
- 风格写成判据，**不许写示例句**（与 `weClonePrompts.ts` 的红线一致）。
- 「说话复盘」是纯本地统计：本人 `voice.jsonl` + 分身历史 assistant 轮次，
  查长度、助手腔、结构化、语言不跟随、复读、开场重复；不调用模型、不上传。
  证据只截几十个字，不复制整段聊天。

## 验证

- `src/utils/weCloneStyle.test.ts`
- `electron/services/ai/voiceReview.test.ts`
- `src/utils/readerAutoDraft.test.ts`（取样 / 字符预算 / 目标保留；范围与备注归一化）
- `src/utils/readerDraftFormat.test.ts`（无换行 / 补标点 / 中英文标点 / 列表清理）
- `electron/services/readerDraftSettingsService.test.ts`（落盘 / 合并 / 克隆删除 / 备注不截断）
- `src/components/reader/readerDraftContext.test.ts`（按会话备注计入上限）

UI 探针不在默认单测里；需要真机验证时，用私有 `--user-data-dir` 离屏启动，
不要让窗口出现在用户屏幕上（见 `probes.md`）。
