# DSH prompt-cache architecture — how ~99% steady-state prefix-cache hit rate is achieved

**Scope**: read-only investigation of (1) the installed DSH checkout `C:\Users\admin\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\` (`@deepseek-ai/*` packages, each shipping `README.md` + bundled `lib/*.js` + `lib/types/*.d.ts`), (2) the user home `C:\Users\admin\.dsh\` (settings, profile patch, 500+ session logs), (3) `reference-projects/Reasonix` (Go agent), (4) vendor cache documentation.

**Evidence classes**: `[V]` = verified on disk / from a primary source with `path:line`; `[M]` = measured from real session logs by scripts I wrote (kept at `.scratch-cache-report/`); `[I]` = my inference.

---

## TL;DR

DSH does **not** use cache breakpoints, cache keys, or any request-side cache knob. It achieves ~99% on `deepseek-*` routes by a single structural invariant:

> **The model-visible history is append-only. Nothing already sent is ever rewritten; everything volatile is appended at the tail; and the few things that must stay in the prefix are forced to be byte-identical and deterministic.**

Measured over 443 real model calls in the largest audited session: **442 of 442 consecutive request pairs differ only by pure suffix append** (first changed message index == length of the previous list, every time). `[M]`

The only things that ever rewrite the prefix are (a) compaction and (b) a provider/model route change — and both are treated as deliberate, costed, low-frequency "cache reset points". `[V]`

| session | steps | model route | measured hit | note |
|---|---|---|---|---|
| `session-0b231f98…` | 134 | ocv41/deepseek-v4.1-flash | **99.261%** | no compaction at all |
| `session-32823e0c…` | 271 | ocv41/deepseek-flash → gpt-6-astra | **99.019%** | one mid-session model switch |
| `session-2f813c3d…` / `session-32823e0c…` | 271 | ocv41/deepseek-flash | **99.02%** | same |
| `session-13f18531…` | 304 | ocv41/deepseek-flash | **98.73%** | |
| `session-82cb48c5…` | 443 | opencode-zen/x-preview-f-free | **96.78%** | 5 compaction attempts, 2 succeeded |
| per-turn best | — | — | **99.70%** turn 2, **99.23%** turn 6 | same session |

`[M]` Files: `C:\Users\admin\.dsh\sessions\--D-Devs-temp--\…\session.v3.jsonl.zstd`, `C:\Users\admin\.dsh\sessions\--D-Devs-Weflow-weport--\session-82cb48c5-…\session.jsonl.zstd`. Extraction scripts: `.scratch-cache-report/read-session.mjs` + `analyze3.mjs`.

---

## A. THE INVARIANTS

### A.1 Vendor-side rules the invariants must satisfy

**DeepSeek** (the primary target of DSH's design): `[V]`
- Caching is automatic; **no request-side configuration exists** (`cache_control` is not in the chat-completions schema). "The DeepSeek API Context Caching on Disk Technology is enabled by default for all users, allowing them to benefit without needing to modify their code." — <https://api-docs.deepseek.com/guides/kv_cache>
- **Prefix-exact from token 0**: "only requests with identical prefixes (starting from the 0th token) will be considered duplicates. Partial matches in the middle of the input will not trigger a cache hit." — <https://api-docs.deepseek.com/news/news0802>
- **Unit-level matching, 64-token storage unit**: "The cache system uses 64 tokens as a storage unit; content less than 64 tokens will not be cached." (same URL); "Each cached prefix is an independent, complete unit. A subsequent request can only hit the cache if it fully matches a cache prefix unit." — <https://api-docs.deepseek.com/guides/kv_cache>
- Reporting: `usage.prompt_cache_hit_tokens` + `prompt_cache_miss_tokens`; "prompt_tokens … equals prompt_cache_hit_tokens + prompt_cache_miss_tokens" — <https://api-docs.deepseek.com/api/create-chat-completion>. Cache-hit input is ~1/50 of miss price (`deepseek-flash`: $0.003/MTok hit vs $0.15 miss off-peak; `deepseek-v4-pro`: $0.022 vs $0.66) — <https://api-docs.deepseek.com/quick_start/pricing>.
- Lifetime: "Once the cache is no longer in use, it will be automatically cleared, usually within a few hours to a few days." And the escape hatch the harness design must absorb: "The cache system works on a 'best-effort' basis and **does not guarantee a 100% cache hit rate**." — <https://api-docs.deepseek.com/guides/kv_cache>

**Anthropic** (contrast — explicit breakpoints): ≤4 `cache_control: {type:"ephemeral"}` breakpoints; **creation order is `tools` → `system` → `messages`**, and "Changes at each level invalidate that level and all subsequent levels"; 5-minute TTL (1h at 2× write cost); writes 1.25×, reads 0.1×; minimum cacheable length is model-dependent (512 / 1024 / 2048 / 4096); cumulative hashing means "changing any block at or before the breakpoint produces a different hash on the next request"; reads walk back over a 20-block lookback window. — <https://platform.claude.com/docs/en/build-with-claude/prompt-caching> `[V]`

**OpenAI** (contrast): automatic; ≥1024 tokens (2048 pre-GPT-5.6), hits in 128-token increments; explicit "**place static content like instructions and examples at the beginning of your prompt, and put variable content … at the end**"; "Summarization, compaction, or context truncation can change the prefix and reset cache reuse"; the documented failure mode "We've seen customers accidentally invalidate their cache by including a timestamp early in their request … Move that to `metadata`"; ~15 RPM per prefix/machine before overflow routing causes misses. — <https://platform.openai.com/docs/guides/prompt-caching>, <https://cookbook.openai.com/examples/prompt_caching_201> `[V]`

### A.2 What must be byte-identical, in stable order (DSH's enforced shape)

Wire request = `tools[]` + `messages[]`. `request/header` (logged) holds exactly `{config, tools}` — and in the current format the prompt is **not** a header field, it is a surface node. `[V]` `session-32823e0c…\session.v3.jsonl.zstd` header keys `["config","tools"]`; `dsh-system-prompt/README.md:135` ("neither the loop request nor `request/header` carries a separate `system` field").

1. **Tools** — a frozen array, stable across the whole session. `[V]` `session-82cb48c5…` logged 25 tools in this exact order, unchanged for all 443 calls:
   `ask_user_question, create_goal, edit, exit_plan_mode, get_goal, glob, grep, interrupt_agent, job_kill, job_list, job_output, list_agents, pwsh, ralph, read, read_image, send_message, skill, subagent, subagent_fork, todo_write, update_goal, web_search, workflow, write` (= lexicographic; DSH's default when no `toolOrder` config is set). Fixed by `dsh-system-prompt/README.md:155` ("ordered by configuration or lexicographically after restrictions and assembly interception") and `:105` ("`toolOrder` canonicalizes the collected tools before the waterfall — **registration order is a plugin-load artifact**"). One `request/header` per session with `reason: "initial"`; the loop writes a new header only on a changed envelope / series start / surface replacement / resume (`dsh-agent-loop/README.md:93`).
2. **System prompt** — one `system/message` surface node at **index 0**, byte-identical for the session. Its text is assembled deterministically: sections concatenated in ascending numeric `order`, ties broken by code-unit name order, `{{variables}}` interpolated against registered values, empty sections dropped, joined with blank lines (`dsh-system-prompt/README.md:56,105`). The *variable* values that would otherwise drift (model name, cwd) are re-resolved per assembly but are stable for a session.
3. **Message history** — append-only, in log order. Verified: node `i` of request *n* is byte-identical to node `i` of request *n−1* for every `i` that exists in both; 442/442 consecutive pairs `[M]`.
4. **Tool results** — appended as their own surface nodes, one per call, in call order; each projects to a wire `{role:"tool", tool_call_id, content}` message.
5. **Everything per-turn volatile is a tail append** — DSH never puts it in the prefix. Verified source kinds that arrive as *appended user-role messages*: `{kind:"user", rpcId, clientTimeZone}`; `{kind:"agent-instructions", form:"instructions"}` (AGENTS.md loads and **updates**); `{kind:"plugin", plugin:"@deepseek-ai/dsh-system-prompt", form:"snapshot", sections:[sandbox:policy, approval:policy]}`; `{kind:"skill-catalog", form:"catalog", update:true}`; `{kind:"plugin", plugin:"compact", compactionId}`; `{kind:"plugin", plugin:"tool-jobs"|"repeat-tool-reminder", form:"notice"}`; `{kind:"subagent-report"|"subagent-settled", form:"relay"|"notice", senderSessionId}`. `[V]` `session-82cb48c5…` user/message source inventory, all with `"surfaceOp":"append"`.

### A.3 What is *not* on the wire (the wasted-volatility DSH avoids)

- **No wall-clock timestamp anywhere in the prefix.** The log envelope carries `time` per event, but `serializeMessages()` builds only `{role, content}` / `{role:"tool", tool_call_id, content}` / the assistant object — session `seq`, `time`, and `surfaceOp` are structurally absent from the serializer's output, and the source's identity fields (`rpcId`, message `id`) are likewise not copied into those literals. `[V]` `dsh-llm-deepseek/lib/index.js:134–162` (text path) and `:171–225` (image path) — the full serializer, both branches, constructs every emitted object from an explicit field list; no spread of the internal message.
- **No per-turn UUID.** `user/message.source.rpcId` and `assistant/message.data.message.id` are session-level artifacts and are not among the fields the serializer emits; the assistant wire object comes from `serializeAssistant(message)` (role/content/tool-calls only). `[I]` — strong, from the same full-serializer read.
- **No `Current date/time` line.** The clock plugin `dsh-time-context` is **opt-in and off in default compositions** ("default compositions leave it disabled, and the Schedule Web overlay mounts it", `dsh-time-context/README.md:12`), and even when mounted it injects an *appended user-role message*, explicitly "Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries" (`:126–128`).
- **No directory listing / environment facts in the prefix.** DSH has no `<env>`-style block; `cwd` enters only through `{{cwd}}`-style prompt variables, and even the harness-checkout path in the current prompt is a fixed template string.

### A.4 Cache-breaking anti-patterns (DSH's own documentation names them)

| # | Anti-pattern | Consequence | DSH source |
|---|---|---|---|
| 1 | Timestamp / clock / "current time" early in the prompt | invalidates from that token every turn | `dsh-time-context/README.md:80,126` (deliberately tail-appended); OpenAI cookbook names it explicitly `[V]` |
| 2 | Reordering tools, or registration-order-dependent tool lists | first changed schema token onward is recomputed | `dsh-system-prompt/README.md:105,163`; `dsh-tools/README.md:167` |
| 3 | Adding/removing/restricting a tool mid-session (instead of on a new session) | whole schema block changes | `dsh-agent-presets/README.md:164,174` ("A session cannot change preset once it has produced anything"); `dsh-tool-subagent/README.md:174` |
| 4 | Rewriting the system prompt **in place** | "makes the request differ from that node's first token — in full when the node is node 0" | `dsh-agent-loop/README.md:160` |
| 5 | Inserting a message in the middle / editing earlier history | "A surface replacement or compaction invalidates reuse from the first shadowed history token" | `dsh-agent-loop/README.md:174`; `dsh-session/README.md` (KV Cache) |
| 6 | Compaction that mutates the range it retains, or that runs often | each checkpoint resets from the first replaced token | `dsh-compaction-basic/README.md:178`; measured `[M]` §D |
| 7 | Changing provider/model mid-session | new cache domain | `dsh-llm-deepseek/README.md:177`; measured `[M]` §D |
| 8 | Routing the summarizer to a different provider/model than the conversation | summarization stops being a prefix of the conversation | `dsh-compaction-basic/README.md:231` |
| 9 | Non-deterministic JSON key order / schema serialization | changes the schema block bytes | `[I]` — DSH emits detached, frozen, ordered schema objects (`dsh-system-prompt/README.md:94` "detaches tool parameters") |
| 10 | Injecting an updated AGENTS.md/memory **into** the prefix | invalidates from the injection point | DSH appends a `system-reminder` message instead: measured `[M]` (`kind:"agent-instructions", form:"instructions", changes:[{action:"replace"…}]` appears as an *appended* message 3× in `session-82cb48c5…`) |
| 11 | Removing a tool to disable it instead of keeping it and refusing | tool-definition change invalidates everything after | OpenAI guidance (`tool_choice:"none"` / `allowed_tools`) `[V]`; DSH keeps the set frozen per session |
| 12 | Mutating an image representation across turns (`file_id` refresh, base64 fallback, execution-world path) | "may prevent reuse from the first affected token" | `dsh-llm-deepseek/README.md:163` |

---

## B. THE DSH PIPELINE, STEP BY STEP

### B.1 The event-sourced surface (the mechanism that makes append-only provable)

A session is an append-only log of typed events. A **derived surface projection** is the model-visible view. Four event types are surface events and must carry `surfaceOp`: `system/message`, `user/message`, `assistant/message`, `tool/result`. Every other event is log-only. `[V]` `dsh-session/README.md` ("Design concept", "Append and derive", "The surface contract").

`deriveMessages()` projects the log into the `Message[]` the model sees, incrementally and cached per node; a `replace` rewrite (`{op:'replace', startSeq, endSeq}`) removes shadowed nodes from future inputs **without deleting their raw log records**, so replay is deterministic. `[V]` same source; measured: in `session-82cb48c5…` there were exactly 474 `tool/result` events of which 14 were `replace` (pruner), and 28 `user/message` of which 2 were `replace` (compaction checkpoints). `[M]`

### B.2 One step, in order

1. **Turn opens**; at a turn boundary the loop claims pending next-step input + one queued prompt; between steps it claims only next-step input. `[V]` `dsh-agent-loop/README.md:119`.
2. **`agent/pre-step`** waterfall — this is where compaction and time-context listeners live. `[V]` (`dsh-compaction-basic/README.md:112`; `dsh-time-context/README.md:67`).
3. **Prompt + tools assembled**; runtime contexts projected. `[V]` `dsh-agent-loop/README.md:119`.
4. **Prompt reconciliation** against surviving `system/message` nodes, using the *prepared call's* declared capability. `[V]` `dsh-agent-loop/README.md:121`.
5. **Accepted `user/message` batch appended** (first attempt only). `[V]` same.
6. **`request/header` logged** if the envelope (config or tools) changed, on series start, after surface replacement, or on resume; otherwise inherited. `[V]` `dsh-agent-loop/README.md:93`.
7. **`request/context` logged** only when provider/model/contextWindow/`systemPromptUpdate` differs. `[V]` same; measured: a 271-step session logged **1** `request/context` then a 2nd when the model changed. `[M]`
8. **Request derived and frozen**, then streamed through the bound prepared call; retries reuse the same rendered assembly and the same frozen request. `[V]` `dsh-agent-loop/README.md:93,119`.
9. **Every accepted fact appended** — assistant message, then one `tool/result` node per call — before the next step derives from it. `[V]` `dsh-agent-loop/README.md:75`.

The request is literally `header.config` + `deriveMessages()` + `header.tools`; it carries no `system` field. `[V]` same, `:119`.

### B.3 Prompt admission rules (the exact byte-identical-or-append decision)

Two modes, selected by the prepared call's declared capability `systemPromptUpdate` (`dsh-llm/types.d.ts:319`: the only value is `'in-history'`; absent = "only a leading system message is read"). **It is declared selectively.** In the shipped catalog only `deepseek-flash` carries it: `dsh-llm-deepseek/lib/index.js:1841–1856` lists `{id:"deepseek-flash", …, systemPromptUpdate:"in-history"}` followed by `deepseek-v4-flash` and `deepseek-v4-pro` with **no** flag; `:1932` validates that any other value throws at load. So on most routes DSH's *default* behaviour is head consolidation (mode 1 below), and `in-history` is an opt-in escape hatch chosen per model. `[V]`

- **Incapable route / new request series** — a non-empty rendering is **consolidated at the first system node**: each later non-empty system node gets a logged per-node empty replacement, then the head is rewritten. **Consolidation applies even when the latest effective text is unchanged.** `[V]` `dsh-agent-loop/README.md:121`.
- **Continuing `in-history` series** — an unchanged effective prompt produces **no event**; a non-empty change is **appended after the cached history**, "so the prefix through that history stays reusable". `[V]` same; `dsh-llm-deepseek/README.md:163`; `dsh-system-prompt/README.md:149`.
- A **step starts a new series** when the pre-step decision declares `startsRequestSeries`, when the surface `replaceGeneration` changed (compaction or any replacement), or **when the visible tool schemas changed**. Resume and a provider/model swap alone continue the series. `[V]` `dsh-agent-loop/README.md:121`.

Measured consequence: in the 271-step session the system node was appended once (`seq 7`, `surfaceOp:"append"`) and replaced exactly once (`seq 1618`, `{"op":"replace","startSeq":7,"endSeq":7}`) at the model change — a **head rewrite**, i.e. a full-prefix miss. `[M]` See §D.

### B.4 "minimal" mode — what it is and what it removes

`minimal` is a **shipped agent preset** (`dsh-agent-presets/presets/minimal/preset.yml` = display name `极简模式`, "仅提供持久 shell 的单工具编码 Agent"); the user's active preset is `standard` (`~/.dsh/settings.yaml:83–84 agent-presets: default: standard`). `[V]`

`dsh-agent-presets/presets/minimal/agent.cordis.yml` (69 lines, read in full) mounts:
- `dsh-persona` with `prefix: You are a helpful software engineer assistant.`, **`complete: true`**, **`includeRuntimeContext: false`**;
- one persistent shell stack (`dsh-terminal` + `dsh-terminal-bash` / `dsh-tool-pwsh-persistent`, `platform`-gated, 300 s timeout), with the tool description inlined in the row.

Header comment (`agent.cordis.yml:1–7`): "The persona is the complete system prompt, so global identity, Web orientation, tool guidance, and later assembly listeners cannot add prompt text. Runtime context snapshots are suppressed for this preset, and the model receives only the persistent shell. **Context compaction is absent.**" `[V]`

Semantics of the two flags: `complete:true` ⇒ "The prompt registry restores this exact prefix as the sole section; no identity, suffix, tool guidance, or listener can append prompt text." `includeRuntimeContext:false` ⇒ "calls `ctx.systemPrompt.suppressRuntimeContext()` … a fresh agent receives no runtime-context snapshot from sandbox policy, approval policy, delegation, or another system-prompt context provider." `[V]` `dsh-persona/README.md:49,65,100`.

So minimal removes, relative to `standard`, **every per-turn-varying prefix input**: the harness identity opener, the model-name introduction, the environment-bearing prompt sections (harness source `order 10000`, Web surface `10100`, persona suffix `10200`), the per-tool guidance sections, and all runtime-context user snapshots — leaving a one-line persona and one tool schema. Its own KV-Cache note: "Prefix-stable for a fixed persona, platform, provider, model, and bundle patch stack." `[V]` `dsh-sdk-minimal/README.md:80–88`; section-order facts from `dsh-system-prompt/README.md:46–50,135`.

**Important, verified nuance**: two things *still* vary per turn even in minimal mode on this deployment —
- the **skill catalog** (appended user message, re-sent whole when it changes — measured 2 catalog messages of ~14 KB each in a 416-step portion of `session-82cb48c5…`) `[M]`;
- **workspace instructions** (`AGENTS.md` is a load **and** an update message; updates appended). `[M]`
Neither is in the *prefix* (both are tail appends), so neither costs a prefix miss — but both are ~2–5 k tokens of new suffix per occurrence.

### B.5 Sub-agents

A child agent **joins its parent's preset composition** and therefore sees the same tools and prompt sections (`dsh-agent-presets/README.md:34`). Shipping fork tools deliberately **cannot select a child LLM route**: "they inherit the parent's provider and model **to keep the copied conversation prefix eligible for KV Cache reuse**. Re-enable selection only when route changes preserve reuse or expose a bounded recomputation cost." `[V]` `dsh-tool-subagent/README.md:213`. Child results reaching the parent are appended (`:188`, `:202`), and continuable children's output never returns through the tool at all — settlement arrives as an independent appended notice (`:194`), which is why starting a subagent does not cost the parent a prefix rewrite.

---

## C. COMPACTION / LONG-TASK ALGORITHM

### C.1 Policy surface (`dsh-compaction-basic`) `[V]`

`dsh-compaction-basic/README.md:66–77`, implementation `lib/index.js:111–117`:

```
thresholdTokens = floor(routedContextWindow * thresholdRatio)   # default 0.8
retainTokens    = retainTokens ?? floor(routedContextWindow * retainRatio)  # default 0.16
auto            = true     # automatic condensation + overflow recovery
compactionRetries = 1      # extra condensation attempts after the first
maxOverflowRetries = 1
maxTokens       = 8192     # summarizer output cap
modelPolicies   = []       # exact {provider, model, ...partialPolicy} overrides
```
Load-time validation rejects `retainRatio >= thresholdRatio`, both retention forms together, duplicate per-model overrides, unknown fields. `compactRegion` requires an open turn; `/compact` uses `turn: null`. `[V]`

### C.2 Pseudocode

```text
on agent/pre-step  (serial, checks pressure BEFORE request derivation):
    price := tokenMeter.price(latestDurableRoutedRequestEnvelope, currentSurface)
    if price < thresholdTokens(routedModel): return          # no touch; prefix stays reusable
    # cheap path first: no model call
    if pruner mounted:
        rewrite oversized tool results > thresholdChars      # one surface `replace` per result
        if re-measured < thresholdTokens: return             # NO summarizer call at all
    # expensive path
    for attempt in 0..compactionRetries:
        start := firstSurfaceNodeThatIsNot system/message    # system prompt at node 0 is NEVER shadowed
        end   := snapBackOffToolPairBoundary(len(surface) - retainTokens)   # balanced tool pairs
        if end - start < minimumFoldable: return
        append compaction/start {compactionId, turn}         # log-only; this IS the durable lock
        prefix := [ system/message@node0 ] ++ header.tools ++ surface[start..end]   # BYTE-IDENTICAL replay
        summary := llm.stream(prefix ++ [compactionInstruction], purpose="compaction")
        revalidate (whole-surface for automatic; selected-span for manual)
        reject a summary that does not shrink its source
        append compaction/summary {compactionId, summary}     # log-only
        surface.replace(start..end) -> ONE user/message:
            "This is an automatically generated checkpoint condensing an earlier span of
             the conversation to free up context. Treat the captured context as established
             background and build on it without restating it. Continue the task directly
             from the messages that follow, without acknowledging this checkpoint."
            + "<compacted-summary>" + summary + "</compacted-summary>"
        append compaction/end {compactionId, turn}            # releases the lock
        if still above threshold: continue loop
    # exactly one closing attempt is made; a failed close leaves an orphan start = intentional busy lock

on agent/request-error CONTEXT_WINDOW_EXCEEDED:
    bypass threshold + retention policy; ONE maximal balanced head reduction; retry only
    after the surface replace generation advances

on /compact (human command):
    same bracket, turn: null, span revalidated instead of whole-surface equality
```

Sources: `dsh-compaction-basic/README.md:106–126,164–170,186–231`; `buildSummarizationInput` at `lib/index.js:654–675`; `dsh-compaction/README.md:86–95,110`. `[V]`

### C.3 What stays immutable and what gets rewritten

- **Immutable, always**: the system prompt at surface node 0. "Every selected range starts at the first surface node that is not a `system/message`, so a system prompt at surface node 0 is never shadowed." `[V]` `dsh-compaction-basic/README.md:112`. A *later* `system/message` (from an in-history prompt update) is ordinary history the range may shadow. `[V]` same.
- **Immutable**: the canonical log. Compaction never deletes; the replacement is one `user/message` with `surfaceOp:{op:'replace',startSeq,endSeq}`; the raw events remain for replay. `[V]` `dsh-compaction/README.md:93–95`.
- **Immutable**: `request/header.tools` — the summarizer call carries "the header's tools verbatim". `[V]` `dsh-compaction-basic/README.md:118`.
- **Rewritten, once**: the oldest balanced span → one checkpoint message.
- **How much at once**: everything from the first non-system node up to the retained-tail budget (`retainRatio` ≈ 16% of the window by default) — i.e. one large, rare rewrite, not incremental churn. `[V]` §C.1.

### C.4 Why compaction does not destroy the cache (the key trick)

> "**Summarization reuses the provider's warm prefix.** Replaying the system prompt held by the `system/message` at surface node 0, the last routed request's tools, and the shadowed-region messages byte-for-byte makes the auxiliary call a genuine prefix of the conversation, so only the trailing instruction and the summary output are uncached." `[V]` `dsh-compaction-basic/README.md:107`

And: "The replayed system prompt, tools, and shadowed-region messages match the conversation's last routed request byte-for-byte, so the provider's warm prefix cache is reused up to the trailing instruction … Routing the summarizer to a different provider/model, or compacting a non-head range, forgoes this reuse." `[V]` `:231`

So compaction costs exactly **one** prefix invalidation for the conversation (from the first shadowed message) and **almost nothing** for the summarizer call itself.

### C.5 The pruner-first path (free, model-call-free reduction)

`dsh-compaction-tool-result-pruner`: trims oversized tool results to ≤ `thresholdChars` code points, no model call, and "when the trimmed conversation fits within the threshold, condensation **skips the summary**". "Trimming only runs after a condensation trigger qualifies — a below-pressure conversation is never touched." Its cache note: "Replacing an earlier result invalidates reuse from the first changed token. The pruned prefix is eligible for reuse while its route, envelope, and preceding history remain identical." `[V]` `dsh-compaction-tool-result-pruner/README.md`.

---

## D. MEASUREMENT

### D.1 Where the hit rate is computed

**Wire → harness mapping** `[V]` `dsh-llm-deepseek/lib/index.js:1145–1166`:
```js
// DeepSeek's prompt_tokens INCLUDES cache hits
// (prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens);
// the harness TokenUsage convention is DISJOINT counts, so cache reads are
// subtracted out of inputTokens.
const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
return { inputTokens: usage.prompt_tokens - (cacheRead ?? 0), outputTokens: usage.completion_tokens,
         totalTokens: combined, ...(cacheRead !== undefined && { cacheReadTokens: cacheRead }) };
```

**Session aggregate** `[V]` `dsh-token-meter/README.md` ("Session projections"): the `tokenUsage` projection carries the whole durable log's `uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`; a final assistant-message sample replaces streaming usage from the same attempt; `llm/retry-started` ends that replacement scope so a retry contributes another billed attempt. `contextPressure` carries `pressureTokens` / `projectedTokens` / `contextWindow`; `contextBreakdown` carries heuristic `systemTokens` / `toolsTokens` / `messageTokens`.

**Displayed formula** `[V]` `dsh-client-ui-chat/lib/client.js:3932–3942` and `:3332–3365`:
```js
function cacheHitPercent(usage) { … return formatCacheHitPercent(usage.cacheReadTokens, …); }
function billedInputTokens(usage) { return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens; }
// formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces) with
// roundedPercentUnits(...) that refuses to round a partial hit up to 100%
```
i.e. **hit% = cacheReadTokens / (uncachedInputTokens + cacheReadTokens + cacheWriteTokens)**, with a deliberate "never round a partial hit to 100%" guard (`dsh-client-ui-chat/lib/types/client/chat/token-format.d.ts:16–24`). UI strings: `client.js:2736` `"stats.cacheHit": "Cache hit {percent}%"`, and per-call `"message.turnUsage.cacheRead"` / `"message.turnUsage.cacheHit"` (`client.js:2811–2813`). Per-attempt numbers ride `assistant/message.data.usage`.

### D.2 Real numbers (my own measurement, not the UI)

Script `analyze2.mjs` sums every `assistant/message.data.usage` in a log.

**`session-82cb48c5-011c-4a94-96fe-28c0450152aa`** (443 calls, 6 turns, model `opencode-zen/x-preview-f-free`, 25 tools):
```
sum uncached input tokens : 1,837,319
sum cache-read tokens     : 55,278,080
sum output tokens         :   179,740
billed input              : 57,115,399
OVERALL cache hit rate    : 96.7831%
weighted input cost vs no-cache: 5.15%  (at the 50x hit discount)
```
per turn: t1 98.99% (149 steps) · t2 99.70% · t3 95.45% (190 steps) · t4 96.25% · t5 90.68% · t6 99.23%.
Steady-state residue per step (`uncached` tokens): distribution over 443 steps = `1–199`: 66, `200–999`: 250, `1k–5k`: 106, `5k–20k`: 11, `20k+`: 10; **zero** steps with exactly 0. Last 15 steps: 137–479 uncached each (99.50–99.87%). `[M]`

**`session-32823e0c-14dc-4047-94a5-a43645ec2215`** (271 calls, `ocv41/deepseek-flash`, 31 tools): overall **99.019%** (700,738 uncached / 70,730,112 cache-read); **zero** compaction events; steps with uncached > 3000: only 19, of which the decisive one is index 247 = **406,537 uncached / 10,368 cache-read** — this is exactly the step at which the logged `system/message` node was replaced (`seq 1618`) for the model switch to `openai-codex/gpt-6-astra`. `[M]`

**`session-0b231f98-…`**: 134 steps, `ocv41/deepseek-v4.1-flash`, **99.261%** (174,770 uncached / 23,490,560 cache-read), zero compaction. Last 60 steps: 129–1218 uncached each. `[M]`

### D.3 Prefix-stability proof (the invariant, measured)

`analyze3.mjs` rebuilds the surface projection from the raw event log (honoring `append` and `{op:'replace',startSeq,endSeq}`), materializes the message array immediately before each `assistant/message`, and compares consecutive arrays node by node:

```
=== first-changed-node distribution across 442 consecutive request pairs ===
{ "4+": 442 }
pure append-only growth pairs: 442 / 442
```
and in verbose mode the "anomalous" rows are only the ones where the tail identity changed — printed `firstChangedNode` values equal **the previous array's length** in every case (e.g. `turn 3 step 136: msgs 628, firstChangedNode 626` = append of exactly the new assistant+tool pair). `[M]`

Interpretation `[I]`: the residual non-zero uncached count per step (~100–1000 tokens) is a composite of (a) DeepSeek's 64-token storage-unit rounding at the end of the prefix, (b) the genuinely new suffix content of the step itself (assistant reasoning + tool call + tool result), and (c) route-specific framing. It is *not* prefix loss, because the measured uncached count is small and stable while the prefix grows into the tens of thousands of tokens.

### D.4 The "cache reset points" measurement

Compaction and model change are the only visible resets:
- `session-82cb48c5…`: 5 `compaction/start`, 5 `compaction/end`, 2 `compaction/summary` (i.e. **3 failed attempts**: two `"503 … Endpoint is unavailable"` and one `"summarization produced no text summary content"`), plus 14 `compaction/prune` replacements. The 2 successful checkpoints replaced `seq 8..20807` and `seq 33491..54593` and are visible in `user/message` events with `surfaceOp:{"op":"replace",…}` and `source:{kind:"plugin", plugin:"compact", compactionId}`. Every checkpoint corresponds to a multi-100k-token uncached spike and a collapsed turn-level hit rate (t3 95.45%, t5 90.68%). `[M]`
- `session-32823e0c…`: exactly one reset, at the model change (406,537 uncached). `[M]`

This is the quantitative form of the design claim: **a long session with no compaction sits at 99.0–99.3%; each compaction or route change costs one prefix's worth of misses.**

---

## E. TRANSFER CHECKLIST for Weport AI

Ordered, concrete, implementable. Steps 1–6 get you to the 99% steady state; 7–12 keep it there.

**1. Make the model-visible history an append-only projection of a log.**
Store messages as an append-only event log. Derive the request array from the log per call. Add exactly one mutation primitive: `replace(startRef, endRef, newMessage)` that *shadows* log records without deleting them. Never mutate a message in place. (DSH: `dsh-session/README.md` "Append and derive"; Reasonix: `internal/agent/projection.go:51–67` `ContextProjection` with `CoveredCount` + `CoveredPrefixHash`.)

**2. Split the request into a stable head and a volatile tail; put everything volatile in the tail.**
Wire layout, in this order: `tools[]` → system message at index 0 → message history. Tail-appended user-role messages are the only channel for: current time/clock, sandbox/approval policy, delegation policy, refreshed memory/instructions, job notices, subagent settlements, skill catalogs. **Never** put any of them in the system prompt or in an early message.
- Reasonix does this explicitly: `internal/control/input.go:174–210` (memory updates, background-job notes, hook context, retrieval all prepend to *the user turn*, "never the cached system prefix"); `internal/control/memory.go:35–37` ("so a fresh memory takes effect this session without busting the prompt cache; it joins the prefix naturally on the next session"); `internal/agent/agent.go:534` ("without touching the cache-stable prefix").
- DSH does this structurally: runtime context becomes sourced **user-role snapshots** (`dsh-system-prompt/README.md:94`); measured source kinds in §A.2.5.

**3. Freeze the tool array for the life of a session.**
Sort deterministically (DSH: lexicographic, or an explicit `toolOrder` with exactly one rest entry; Reasonix: `normalizeToolSchemas` sorts by name → description → params, `internal/agent/cache_shape.go:51–64`). Serialize schemas once, deep-freeze, and reuse the identical object/bytes for every request. Changes to the tool set are allowed **only** on a new session. Do not remove a tool to disable it — keep the definition and refuse the call (or use `tool_choice`/an allow-list that does not change the definitions).
- DSH: `dsh-agent-presets/README.md:174` ("A session cannot change preset once it has produced anything — swapping tools mid-conversation would strand tools the model has called"); `dsh-persona/README.md` / `dsh-tool-subagent/README.md:174`; Reasonix: `internal/agent/agent.go:349–350` ("The system prompt and tool list never change with the toggle, preserving the provider-cache prefix").

**4. Make the system prompt a deterministic rendering with no volatile facts.**
Assemble from ordered sections; sort by `(order, name)`; interpolate variables from registered values; drop empties; join with a fixed separator. Enforce *at least*: no timestamp, no UUID, no request id, no environment dump, no "you are in directory X" unless X is fixed for the session. Make the assembly injectable so tests can assert byte-equality of the rendered prompt across turns.
- DSH: `dsh-system-prompt/README.md:56,105`. Reasonix marks its own project-memory file as "part of the system prompt (the cache-stable prefix)" and treats its literal text as cache-frozen (`REASONIX.md:3–20`; `internal/agent/agent.go:59–60` "its text is cache-frozen — changing it breaks … the prefix stability of every live delivery session").

**5. Strip every non-wire field in the serializer, and never emit "debug metadata" on the wire.**
Write the serializer to construct wire messages field-by-field from `{role, content, tool_call_id}`, never by spreading the internal message object. DSH's text path is exactly 28 lines and hard-codes those fields (`dsh-llm-deepseek/lib/index.js:134–162`). Assert in a test that no `time`/`seq`/`id`/`uuid` field exists on the wire body. (The OpenAI-cookbook timestamp anti-pattern is precisely this.)

**6. Verify the invariant with a test that measures the *bytes*.**
Reasonix's e2e test asserts, per request *i*, `hitChars[i] == reqChars[i-1]` — "on request i the cached prefix should be the ENTIRE request i-1" (`internal/agent/cachehit_e2e_test.go:150–173`). Its release guard runs 9 scenarios (plain dialogue, long dialogue, mixed message sizes, tool loop, long tool loop, with/without reasoning round-trip) and requires the **tail average** to be ≥ threshold 90% (`:378–470`). DSH-equivalent: recompute `deriveMessages()` at each step and assert `messages_n[0..len(messages_{n-1})) === messages_{n-1}` byte-for-byte. I did this against 443 real calls (§D.3) — do the same in CI.

**7. Keep the tool-call loop inside one request series so the prefix is re-sent, not rebuilt.**
The critical shape: **one HTTP request per model step, always re-sending the whole history from token 0.** In the measured DSH session, 443 model calls carried 57.1 M billed input tokens of which 55.3 M were cache reads — a 124× amplification factor over a single-request design. Do not "continue" a conversation via any server-side handle (`previous_response_id`, chat sessions) whose semantics change the effective prefix, and do not fall back to a client-side "delta only" mode: DeepSeek's cache is prefix-matched, so re-sending the identical prefix is what *earns* the discount. One step = one request, retries replay the *same frozen payload*.
- DSH: `dsh-agent-loop/README.md:119` (frozen request; retries reuse the assembly); Reasonix: `internal/agent/sampling_request.go:10–13` ("All stream retries replay this exact payload — no synthetic recovery messages, no schema reorder, no previous_response_id drift from failed attempts"), freezes deep copies at `:66–104`.

**8. Handle multi-turn / continuation / resume by *not* touching history on resume.**
On resume, decide the cache state (`warm`/`cold`/`unknown`) for cost reporting only — never compact because the cache might be cold. Reasonix: `internal/agent/preflight.go:193–217` (`SetCacheState`) and `docs/research/cache-aware-compaction-design.md:43–45` ("Resume 只记录缓存状态 … Resume 路径不会调用 `Compact`, `SnapshotRewrite` 或 `PruneStaleToolResults`，也不会修改 canonical transcript"); test `internal/control/resume_prune_test.go:46–64` asserts a cold resume performs **no** rewrite and **no** network call. When a new user turn arrives, append it; if a system-prompt *change* is genuinely required mid-session, prefer appending an in-history prompt update over rewriting node 0 (DSH's `systemPromptUpdate: 'in-history'` contract, `dsh-llm/types.d.ts:319`).

**9. Make compaction rare, large, and prefix-preserving.**
Trigger at a high ratio (DSH 0.8 of the routed window; Reasonix 0.8 with a 0.5 "just warn, keep the cache" band — `internal/agent/compact.go:26–31,123–137`). Retain 15–20% verbatim. Always exclude the system message at index 0 from the rewritten range. Replay the summarizer prompt **byte-for-byte** from the last routed request's head (`system + tools + shadowed region`) and append only the instruction, so the auxiliary call hits the same warm prefix. Rewrite the whole span in **one** `replace`. Never re-summarize an existing summary in a lossless-compaction path; carry it or merge it, but do not let digests chain.
- DSH: `dsh-compaction-basic/README.md:107,112,118,231`; `buildSummarizationInput` `lib/index.js:654–675`.
- Reasonix adds two guards worth stealing: a **stuck latch** (if compaction can't get under the trigger twice in a row, pause auto-compaction and keep growing append-only rather than cratering the cache every turn: `internal/agent/compact.go:141–177`) and **economics** (`foldEconomics`, min ~400 tokens of foldable region — `:184–187`).

**10. Order the projection deterministically so re-compactions don't shuffle the prefix.**
When a projection is rebuilt, assemble it in a fixed order (`system → hoisted early user turns → one rolling summary → protected messages → recent tail`) and make the hoist/keep decisions depend only on stable per-message data, never on the latest provider usage. "Identity decisions must not use the latest provider usage: after projection activates, that usage describes the projection while the canonical transcript remains larger, which would make the same turn drift in or out across compactions." Reserve dynamic calibration for tail sizing only. `[V]` `internal/agent/compact.go:323–337,438–467,559–581`; `docs/research/cache-aware-compaction-design.md:59–69`.

**11. Validate projection reuse fail-closed against a fingerprint of the provider-visible prefix.**
Store the projection in a sidecar that records `coveredCount`, a hash of the provider-visible prefix `canonical[:coveredCount]`, the tool-schema identity, a `promptCacheKey = workspace | sessionLineage | model`, and the cache state. Reuse only if the hash matches and the key matches. This makes "append-only growth" mechanically distinguishable from "someone edited history", and it makes a lineage change (rewind/fork/branch/model swap) drop the projection instead of silently reusing a prefix that no longer exists.
`[V]` `internal/agent/projection.go:53–67,224–315`, `internal/agent/preflight.go:102–159,284–293`.

**12. Sub-agent delegation must inherit the parent's route and composition.**
A forked child that shares the parent's conversation prefix must use the parent's provider+model, or the inherited prefix is worthless. DSH states this as a hard limitation and cites exactly this reason (`dsh-tool-subagent/README.md:213`). Children join the parent's preset composition (`dsh-agent-presets/README.md:34`), so their tool array and prompt sections match. Results come back as *appended* messages (`:188`, `:202`), and background children report via an independent settlement notice rather than a tool return (`:194`).
**Keeping the prefix stable when tools are conditionally enabled**: don't. Either the tool is in the session's frozen set or it isn't — decide at session creation. DSH enforces this by refusing preset switches after the first message (`dsh-agent-presets/README.md:174`) and by making per-scope registration a *composition* fact, mounted once before the agent is published ("a composition is installed once, before the agent is published and therefore before its first request, and is never re-read while the agent runs", `dsh-agent-presets/README.md:164`). If a deployment truly needs optional capabilities, model them as *always-present* tools whose behaviour is gated by a policy flag (DSH: `dsh-tool-subagent` "An enabled Session policy adds `provider`, `model`, and `reasoning_effort` … The provider must support `agentOptions`"; the schema stays in place, `README.md:132,140`), or add the tool only on a **new** request series and accept one reset.

**13. Instrument, and treat cache-hit regressions as test failures.**
Log per request: hit tokens, miss tokens, cache-write tokens, the tool-array hash, the system-text hash, and a monotonic "content-rewrite counter" with *why* it moved. Alert when the tail average drops. `[V]` Reasonix `internal/agent/cache_shape.go:13–99` (`PrefixShape{SystemHash, ToolsHash, PrefixHash, LogRewriteVersion, ToolSchemaTokens}` + `CompareShape` producing `PrefixChangeReasons`), `internal/cli/run_metrics.go:32,203`, `scripts/check-cache-impact.sh` (a CI guard that *requires* a PR body line `Cache-impact: <none|low|medium|high> - <reason>` and `Cache-guard: <test>` whenever a cache-sensitive file changes), `REASONIX.md:97–109`. DSH: `dsh-client-ui-chat` `cacheHitPercent` / `billedInputTokens` / per-turn `turnUsage` rows.

**14. Do not trust "best effort" — budget for resets.**
DeepSeek explicitly does not guarantee hits. Design the steady state at ≥99% and treat each compaction/route change as a known, bounded miss whose cost you can estimate (one prompt's worth of uncached input). Report cost, not just percentage: at the 1/50 hit ratio a 99% session costs ~5% of the uncached-input price.

---

## F. THE ANTI-RECOMMENDATIONS — what DSH deliberately does NOT do

1. **No cache breakpoints / no `cache_control` / no cache keys.** The DeepSeek adapter sends none, because DeepSeek has no such field. Where the harness *does* touch cache semantics it is only through the `systemPromptUpdate: 'in-history'` catalog declaration (`dsh-llm/types.d.ts:319`) — a *routing capability*, not a request parameter. Explicit block-level cache hints were deliberately pruned from the vocabulary: "Producer-gated variants stay out until produced — `prefill`, per-tool `strict`, **block `cache` hints**, and the `agent` message-source variant have no producer" `[V]` `dsh-llm/README.md`.
2. **No timestamp / clock in the system prompt.** The clock plugin exists, is off by default, and when on injects *appended* user messages with a `refreshIntervalMs` throttle so readings don't accumulate every step. `[V]` `dsh-time-context/README.md:12,36,47,126–128`.
3. **No whole-history rewrite to "freshen" context.** Runtime-context snapshots, refreshed AGENTS.md, changed skill catalogs, and job notices are all tail *appends* — the superseded copies stay in the log and are only removed by a later compaction. `[V]` §A.2.5; a "supersedes earlier snapshots" message is appended rather than replacing the earlier one. `[M]`
4. **No mid-session tool-set or preset change.** Refused by design, with the stated reason being stranded tool calls and prefix stability. `[V]` `dsh-agent-presets/README.md:174`.
5. **No compaction on resume and no compaction on cache-state change.** Cold/warm/unknown is cost telemetry only; it never triggers a rewrite. `[V]` Reasonix `docs/research/cache-aware-compaction-design.md:43–45,99–101`; DSH derives compaction only from token pressure or a provider-confirmed `CONTEXT_WINDOW_EXCEEDED`.
6. **No head-shrinking as a context strategy.** "An envelope that alone approaches the window is not surface-compaction work — compaction shrinks derived history, never the system prompt, tools, or session prefix." `[V]` `dsh-compaction/README.md:160`.
7. **No model-facing compaction tool.** Condensation is a human command (`/compact`) plus automatic pressure; "no model-facing compaction tool is registered" — deliberately, because a tool call that rewrites history mid-turn would both break tool-pairing and re-earn the whole prefix. `[V]` `dsh-compaction/README.md:158,170`.
8. **No per-node prompt edits at the tail.** "Per-node empty replacements preserve intervening history without a surface delete operation" — the loop refuses to splice the middle. `[V]` `dsh-agent-loop/README.md:121`.
9. **No compaction that cannot shrink.** A summary that does not reduce its source is rejected and nothing is written; a failed summarization "preserves the latest durable surface" and continues with full over-budget history rather than leaving a half-written projection. `[V]` `dsh-compaction-basic/README.md:244`, `dsh-compaction/README.md:93`.
10. **No unbounded summary chains.** A compaction's replacement is preceded by the retained tail, not by a growing stack of summaries; the shadowed region is rewritten in one `replace` so the model sees exactly one summary plus the retained nodes. `[V]` `dsh-compaction/README.md:95`; Reasonix "provider-visible projection 始终只保留一条 summary，不会形成无限摘要链" `docs/research/cache-aware-compaction-design.md:71`.
11. **No "keep the first user turn pinned forever" beyond a budget** (Reasonix pins it only when it is below `maxPinnedFirstUserTokens` 1500 and ≤15% of the window). `[V]` Reasonix `internal/agent/compact.go:35–36,312–337`. `[I]` DSH has no equivalent pinning; it relies on compaction starting after node 0.
12. **No cross-machine / cross-user prefix sharing assumptions.** DeepSeek's cache is per-user and best-effort; DSH treats each `(provider, model)` as a distinct cache domain and a route change as a reset point rather than trying to preserve it. `[V]` `dsh-llm-deepseek/README.md:177`; vendor page `[V]`.

---

## Appendix — reproduction

Scratch scripts (created for this report, safe to delete): `.scratch-cache-report/`
- `read-session.mjs <*.jsonl.zstd> [out.jsonl]` — frame-wise zstd decompression (each appended write is its own frame; `zstdDecompressSync` alone only yields frame 1). `[V]` a 4.2 MB / 20 200-event log decompresses to 9.2 MB.
- `analyze2.mjs <out.jsonl>` — per-step and per-turn cache accounting, distribution, worst steps.
- `analyze3.mjs <out.jsonl>` — surface-projection reconstruction + consecutive-request prefix-divergence test (`firstChangedNode`).
- `analyze4.mjs <out.jsonl>` — `request/header` structure, tool order, `user/message` source inventory.
- `survey.mjs <sessionDir...>` — hit rate, tool count, system-prompt length and route, across every session in a workspace.

**Caveat on absolute numbers**: several large sessions in the same workspace logged `sys=null` (older format where the prompt lived in `request/header.system`), and the route `ocv41/deepseek-*` is a third-party gateway, so its cache accounting is the gateway's, not `api.deepseek.com`'s. The hit figures are computed from the `cacheReadTokens`/`inputTokens` the adapter returned, using the same disjoint convention DSH itself uses. The *prefix-stability* result (442/442 pure appends) is independent of the provider.
