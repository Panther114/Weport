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
