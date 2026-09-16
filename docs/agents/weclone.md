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
