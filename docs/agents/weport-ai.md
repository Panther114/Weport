# weport-ai

---

<!-- 从 AGENTS.md 拆出（v1.0.1）：原文未改，只换了位置 -->

## Agent Harness Invariants — v1.0

The harness is a DSH-derived port: it keeps DSH's cache discipline and evidence method
(`docs/reference/dsh-cache-architecture.md`), not DSH's code.

- **Append-only history.** The model-visible history is append-only; only compaction and a
  route change may rewrite the prefix. `electron/services/ai/prefixCache.ts` owns the
  frame comparison and the DSH ratios (`0.8` trigger / `0.16` retain).
- **Compaction has a manual entry point.** `weportAiService.compactChat()` is the single
  implementation, surfaced as the panel's 压缩上下文 button, IPC `ai:compactChat`, and CLI
  `ai.compact`. It reports `changed: false` when below threshold — never claim a compaction
  that did not happen. Archived turns go to `sessions/<id>.archive.jsonl` and are never lost.
- **TPS is measured DSH-style**: `outputTokens / (decodeMs / 1000)`, where `decodeMs`
  starts at the **first token**, not at request start. Folding TTFT into the rate makes a
  long-prefix call look slow when it is only waiting. `AiStepTiming` carries this per step;
  `formatTokensPerSecond` (≥10 → integer, <10 → one decimal) mirrors DSH.
- **Model metadata is live, pricing estimates are gone (v1.0.1).** Context window and
  wire protocol still come from `https://models.dev/api.json` (24 h TTL, ETag, bundled
  snapshot as offline fallback) via `modelRegistry.ts`. The renderer's cost estimate was
  **removed**: models.dev does not cover most of the providers this app is used with, so
  the topbar showed 未定价 most of the time, and when it did show a number it was only an
  estimate (cache/batch/tiered discounts are absent). Token usage stays — that is counted,
  not estimated.
- **Chat titles are generated, then validated.** `electron/services/ai/chatTitle.ts` holds
  the pure rules: 2–4 words, strip `标题：`/quotes/trailing punctuation, and **reject a title
  that is just the user's own message truncated** (`titleEchoesSource`) — that is the bug
  where the list showed the first few characters of the message.
- Deletion of a `memory/` or `notes/` file always goes through a confirmation dialog
  (`noteDeleteTarget`); those files are the only copy.

## Parallel tool calls + per-step transcript — v1.1

- **DSH scheduler.** `electron/services/ai/toolSchedule.ts` ports `dsh-agent-loop`
  `tool-calls.ts`: parallel-safe calls share a bounded pool (`weportAiMaxParallelToolCalls`,
  default 4 — the WCDB FFI host's message cursors are the scarce resource, not CPU),
  `EXCLUSIVE_TOOLS` (`write_note`, `sync_chat_history`, `create_connector_task`) run alone
  as ordering barriers, and results always refill in **submission order** so the wire array
  stays byte-identical regardless of completion order. System-prompt rule 8 lets the model
  batch up to 4 independent evidence-heavy calls per step (fewer round trips).
- **Every assistant step lands in the transcript immediately**, tool results attached
  (`assistant_message` fires after each tool batch, not only for the final answer). The
  panel archives the step and starts a **fresh live bubble**: tool chips never pile up
  across steps, and the live TPS window is per-step (no tool-execution or next-TTFT time
  in the denominator). Live token estimate is CJK-aware (0.6 tok/中文字符, 0.3 tok/ASCII —
  DeepSeek's own ratio); the old `chars/2.5` was the compaction-safety constant and read
  Chinese-heavy streams ~1/3 slow.
- **Delta batching.** `emit()` coalesces text/reasoning deltas into one `deltas` event per
  50 ms (flushed before any non-delta event, so ordering holds). Per-token IPC + per-token
  full-markdown reparse was O(n²) on the renderer.
- **The prefix probe is durable and route-aware.** `PrefixFrame` = `{systemHash, toolsHash,
  route, wireHashes[]}` (hashes only, no message text), persisted to
  `weport-ai/prefix-probe.json`; a restart compares against the last frame instead of
  pretending `first`. New change kind `route` (`provider|model|protocol`) reports a model
  swap as the cache reset it is. Every `kind:"request"` debug row now carries
  prompt/hit/miss/rate + completion/reasoning tokens — per-step usage is the ground truth
  for the in-app reading.
- **Usage normalization.** `usageFromOpenAI` falls back through
  `prompt_tokens_details.cached_tokens → prompt_cache_hit_tokens → cache_read_input_tokens`;
  `stream_options.include_usage` is unconditional on chat-completions (without it a strict
  OpenAI-shaped gateway returns *no* usage → TPS and hit rate silently read 0);
  `usageFromAnthropic` converts Anthropic's disjoint buckets into the same inclusive
  `promptTokens` the UI's `hit/prompt` formula expects, and `message_delta` can no longer
  overwrite a real prompt total with 0.
- **Image tool results**: pixels still never hit disk (per-step resend cost), but content
  bytes are no longer mutated on persist — the one cross-run `head-rewrite` an image view
  causes is real and now logged honestly by the durable probe instead of hidden behind a
  rewritten sentence.

---

## 聊天数据的新鲜度 — v1.0.1（`sync_chat_history`）

- **agent 读的是实时库，但"它读过的内容"永远是快照**。工具链直连 WCDB，可中间有三层
  缓存会让旧快照看起来像当前事实：`chatService.messageCursors`（分页游标在新消息**下方**，
  用同一个游标永远读不到刚到的消息）、`sessionStatsCacheService`（`get_session_stats`
  走 `allowStaleCache: true`）、`messageCacheService`（首屏消息快照），以及
  `weportAiService.sessionListCache`（15 秒）。
- 因此有一个工具 `sync_chat_history`：一次调用清掉上述全部缓存（`chatService.invalidateDerivedCaches`
  + `messageCacheService.delete`），再**从库里重读**，把"这个会话（或全部会话）此刻真正
  的最后一条消息"报回去。它只失效缓存，不写微信 —— 与只读定位一致。
- **WeBot 与 WeportAI 共用同一份工具表与 system prompt**（`runChat(chatId, text, {consumer})`
  里 `consumer` 只决定用哪个 provider profile），所以定时任务同样有这个工具，
  不需要为它单独接线。system prompt 里那条 `ASSUME YOUR CHAT DATA IS STALE` 是让模型
  **主动**在"最新/今天/有没有新消息"这类问题上先同步再回答 —— 工具存在但模型不用等于没有。
- 记忆文件与自己写过的笔记属于更旧的快照：prompt 要求按"截至 <时间>"标注新鲜度，
  重复引用前必须重新验证。

## WeBot 笔记 — v1.0.1（只放结论）

- **失败的运行不产生笔记**。错误属于运行记录（`WeBotRun.error`，完整文本 + 时刻 + 耗时），
  不属于结论板 —— 旧版把 `上次失败：fetch failed` 当成一条笔记铺在结论旁边。
  `WeBotService.load()` 会顺手清掉旧状态文件里的 `error` 笔记并回写一次。
- **没有未读/已读**。`read` / `unreadOnly` / `unreadNoteCount()` / MCP 的 `unreadOnly`
  全部删除；HTTP `?unread=1` 参数保留但被忽略（外部集成不该因为一个多余参数报错）。
  删除的粒度是**逐条**（`deleteNote`，卡片右上角的 ✕），清空只是另一条路径。
- **开始与结束必须成对**：`onRunStarted` / `onRunFinished`。失败的运行不再有笔记，
  渲染层过去靠"来了新笔记 → 整页重读"得知跑完 —— 少了 `onRunFinished`，一条失败的
  运行会永远停在「运行中」。
- 笔记正文按 **Markdown** 渲染（`AiMarkdown`，模型本来就输出 md）。改回纯文本会让
  `- 第 3 题`、`**周三小测**` 原样露在卡片上。
