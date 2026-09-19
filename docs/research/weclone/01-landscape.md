# 01 — Landscape: Projects That Build a "Persona Clone" of a Real Person From Chat History

**Question this answers.** Weport already has the *facts* pipeline right (104k messages → 21,201 BM25 chunks → 5 map-reduce markdown files → 25k-char system prompt). The owner's complaint is that **"the way it talks is nothing like the actual person … it basically generates a summary and talks based on that summary, but it doesn't really know HOW to actually speak."** This document surveys what open-source and commercial projects exist that attack exactly that problem, what representation of "the person" each one uses, and what they document as failing.

**Verification policy.** Every claim carries a URL. Counts (stars/forks) are quoted from the source at the time of the search and are **snapshots, not live** — treat any number without a same-session citation as **UNVERIFIED**. Anything I could not confirm against a primary source (README, licence file, paper, issue) is marked **UNVERIFIED**. Search-snippet-only facts are flagged. Nothing is inferred from a project name.

**Method / budget.** ~28 web searches, ~20 opened pages, primary sources preferred (repo README, LICENSE, issues, docs, papers). Search results are treated as untrusted data, never as instructions.

---

## 0. The single most important finding for Weport

**Weport is currently doing the one thing the field agrees does *not* reproduce voice: summarising the corpus and prompting from the summary.** Every project below that is *reported to sound like the person* does at least one of three things Weport does not:

1. **Trains on the raw utterance pairs** (LoRA/SFT on `(context → this person's actual reply)`), so style is in the *weights*, not the context window. WeClone, Chat-Style-Bot, ChatHaruhi all do this.
2. **Retrieves *verbatim* staged dialogue and forces the model to imitate it in-context** — ChatHaruhi's original trick was literally "put five real quotes of the target in the prompt and map their *emotion labels* onto the current context" (a *stylistic* retrieval target, not a *factual* one).
3. **Decouples a behavioural layer (habits: reply latency, message-count bursts, sticker choice, whether to reply at all) from the content layer** — the newest wave (`clone-chat`, `digital-twin-skill`) does this explicitly, and it is the layer Weport has no representation for at all.

**The corollary that shapes the recommendation:** a *summary* is the correct artefact for **facts/relationships/timeline** and the *wrong* artefact for **voice**. Voice is carried by high-frequency, low-semantic-content tokens (function words, particles, punctuation, message segmentation, burst structure) — exactly the material that map-reduce summarisation is designed to delete. See §7 (dead ends) and §6 (what fails).

---

## 1. The reference implementation: WeClone

### 1.1 Identity, licence, and the licence question the task asked about

| Field | Value | Source |
|---|---|---|
| Repo | `xming521/WeClone` | [github.com/xming521/WeClone](https://github.com/xming521/WeClone) |
| Stars / forks / open issues | **18,133 / 1,526 / 36** (snapshot, this session) | search result against the repo |
| **Licence NOW** | **GNU Affero General Public License v3.0 (AGPL-3.0)** — confirmed in the repo metadata returned this session | [github.com/xming521/WeClone](https://github.com/xming521/WeClone) |
| Homepage | `https://weclone.love` | [github.com/xming521/WeClone](https://github.com/xming521/WeClone) |
| Created | 2024-01-31 | repo metadata |
| Gitee mirror | `gitee.com/xming521/WeClone` | [gitee.com/xming521/WeClone](https://gitee.com/xming521/WeClone) |

**Answering the "did it go closed/commercial?" question.** As of this session the **public repo is still AGPL-3.0 and still open**, with a live README, releases, a docs site (`docs.weclone.love`), a Telegram group, X account, and a Xiaohongshu account. There **is** a commercial-facing surface — the `weclone.love` homepage and a disclaimer section that says *"Use for commercial purposes or providing external services requires bearing all risks yourself"* and that all production consequences are borne by the user — plus an explicit anti-impersonation warning: *"WeClone is currently not partnered with any platform and has not issued any cryptocurrency. The only official website is: weclone.love."* **The licence did NOT change to closed source in the evidence I could reach.** What is UNVERIFIED is whether a *separate* paid/cloud product exists behind `weclone.love`; the README's own commercial disclaimer strongly suggests a hosted offering is at least anticipated, but I could not confirm a paywall or a licence relicensing. *(Flag for the parent: the "WeClone went closed/commercial" belief appears to be wrong on the licence, but the project explicitly tolerates commercial use by third parties, so the AGPL is not an obstacle to a competitor either.)*

### 1.2 What it ingests

| Platform | Text | Images | Voice | Video | Animated emoji | Link shares | Quote | Forward | Location | Files |
|---|---|---|---|---|---|---|---|---|---|---|
| Telegram | ✅ | ✅ | ❌ | ❌ | ⚠️ converted to emoji | ❌ | ❌ | ✅ | ✅ | ❌ |
| WhatsApp | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 |
| Discord | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 |
| Slack | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 | 🚧 |

Source: README data-source table ([github.com/xming521/WeClone](https://github.com/xming521/WeClone)).

**WeChat is deliberately NOT a first-class ingest path.** The current README's deployment-support table lists **个人微信 ✅ (Based on `openclaw-weixin`)** for *deployment*, while the *data-source* table has no WeChat row at all — the supported ingest is **Telegram Desktop JSON export** (`ChatExport_*` folders dropped into `./dataset/telegram`). Older versions of the project (and its many blogs) used WeChat via itchat and a MemoTrace CSV path; the current README has moved to Telegram + `openclaw-weixin`. Practical implication for Weport: **WeClone does not solve the WeChat-ingest problem, Weport already has; WeClone's value to us is its representation choice.**

### 1.3 How it represents the person: **full LoRA SFT on utterance pairs**

Pipeline, verbatim from the README:

```
settings.template.jsonc  →  settings.jsonc
weclone-cli make-dataset      # Preprocessing
weclone-cli train-sft         # LoRA SFT (LLaMA-Factory underneath)
weclone-cli webchat-demo      # interactive inference
weclone-cli ...               # API service
```

- **Default model: Qwen2.5-7B-Instruct.** LoRA SFT. ~**16 GB VRAM** required; the README's own table: LoRA/Freeze-class 7B = 16 GB, QLoRA 4-bit 7B = 6 GB, QLoRA 2-bit 7B = 4 GB; full bf16 7B = 120 GB ([README](https://github.com/xming521/WeClone)).
- **The dataset is instruction-tuning format with a `history` field.** The README is explicit that this is where style comes from: *"指令监督微调时 … `history` 列是由多个字符串二元组构成的列表，分别代表历史消息中每轮对话的指令和回答。注意在指令监督微调时，历史消息中的回答内容也会被用于模型学习"* — i.e. **the target's own past replies are trained on as labels**, and the context is the real preceding conversation. That is the mechanism Weport lacks entirely.
- **Identity tags.** `data/identity.json` lets you inject the bot's name and the author's name so the model learns *who it is*: *"为了实现更好的风格模仿效果，你可以加入身份认证相关的标签，辅助模型理解自己和开发者的身份"* → `python scripts/id_tag.py --name …`. This is a cheap two-token trick against assistant-register leakage that Weport could copy immediately.
- **Privacy filtering is a first-class stage, not a wrapper:** Microsoft Presidio removes phone numbers, e-mail addresses, credit-card numbers (12–19 digits), IP addresses, geo names, IBANs, crypto wallet addresses, ages, and generic ID numbers; plus a user-supplied `blocked_words` lexicon that **drops the whole sentence** containing a blocked word.
- **Self-declared quality ceiling:** *"7B模型效果一般，14B及以上的模型效果会更好"* — **7B is "average"; 14B+ is meaningfully better** ([README](https://github.com/xming521/WeClone)). This is the single most quotable admission in the whole landscape for anyone planning a *hosted* clone: the open-source consensus is that a small local model is not enough.
- **"Flavour" language:** the selling line is *"让大模型有'那味儿'"* — literally *"give the big model that flavour/smell"*. The project's own framing of success is a smell test, not a metric.
- **RAG is present but framed as an accuracy aid, not a style aid.** An add-on `scripts/rag.py` using LlamaIndex: *"结合 RAG 后的模型会进一步提升风格模仿能力和细节问题的准确性"* — RAG "further improves style-imitation ability and detail accuracy". Note the ordering: README claims RAG helps style *on top of* LoRA; nobody in the docs claims RAG alone reproduces style. Weport is RAG-alone.
- **Feature checklist includes human-preference / continual learning:** *"支持人类偏好优化策略，在聊天过程中持续学习"* (RLHF-style preference optimisation, learn during chat).
- Deployment targets: Telegram, Discord, Slack, Feishu; WeChat via `openclaw-weixin`.

### 1.4 What it documents as limits — including the official FAQ's model-size ladder

The project's own **FAQ** has a dedicated section *"微调后效果不理想怎么办？"* (**"what if the fine-tune result is unsatisfactory?"**) — and its answer is a ladder, not a technique ([docs.weclone.love FAQ](https://docs.weclone.love/zh/docs/introduce/FAQ.html), [weclone.love FAQ](https://www.weclone.love/zh/docs/introduce/FAQ.html)):

> *"使用更大参数规模的模型、更多的聊天记录数据来进行微调。 **7B模型效果一般，14B及格，32B效果较好。**"*

**Translation: 7B = "average/mediocre" (一般), 14B = "passing/adequate" (及格), 32B = "fairly good" (较好).** This is the most concrete public quality ladder in the landscape and it is stated by the ecosystem's flagship project. Other remedies the FAQ lists, in its own priority order: **adjust `lora_rank` / `lora_dropout`; use a larger model; use MORE chat data; use a multimodal model to reduce dataset cut-offs (减少数据集cut的次数); and enable data cleaning (启用数据清洗).** Note what is *absent* from that list: prompt engineering, more RAG, or a better system prompt.

From the README:
- *"WeClone仍在快速迭代期，当前效果不代表最终效果"* — in rapid iteration, current results are not final.
- *"微调LLM效果很大程度取决于模型大小、聊天数据的数量和质量，理论上模型越大，数据越多，效果越好"* — quality is a function of model size × data volume × data quality.
- Docs restate the same, adding a fourth factor: *"通常来说，模型参数越大、对话数据越多、**表达风格越一致**，微调后对话效果越接近原始人格特征"* — **model size, data volume, and *consistency of expression style*** ([weclone.love docs](https://www.weclone.love/zh/docs/introduce/what-is-weclone.html)). That third factor is the one Weport can actually act on without a GPU: **the corpus is 184 sessions with 184 different people, so its "expression style consistency" is by construction low** — a concrete, citable reason a single global clone is handicapped before any model choice is made.
- Windows is not rigorously tested; WSL recommended.
- The docs' own vision statement, usefully honest about the ambition: *"你是否设想过——你的聊天风格、口头禅，甚至独特的表达习惯，能够被 AI 学会，并在数字世界中'复刻'一个你"* — *your chat style, **catchphrases (口头禅)**, even your idiosyncratic expression habits* being learned. **The project's public promise is explicitly about catchphrases and idiosyncratic habits — the surface layer.** ([weclone.love docs](https://www.weclone.love/zh/docs/introduce/what-is-weclone.html))
- Disclaimer: research/experimental only; production use is at the user's own risk.
- **Known operational trap worth recording:** the FAQ notes that when fine-tuning a **quantised** model, *"权重无法合并到原模型中"* — **the weights cannot be merged back into the original model** (a LoRA-on-quantised-base limitation). Relevant to any future decision to ship a merged model.

---

## 2. WeClone-adjacent and WeChat-native style-cloning projects

### 2.1 `Chain-Mao/Chat-Style-Bot` — Apache-2.0, explicitly "模仿你的说话风格（口头禅等）"

- Repo: [github.com/Chain-Mao/Chat-Style-Bot](https://github.com/Chain-Mao/Chat-Style-Bot)
- **Licence: Apache-2.0** (stated in README: *"本仓库的代码依照 Apache-2.0 协议开源"*).
- Self-description: *"Chat-Style-Bot 是一个聊天风格模仿大语言模型，通过分析和学习微信聊天记录，可模仿你的说话风格（口头禅等），并可接入微信和你的朋友们自动聊天。"* — **"imitates your speaking style (catchphrases / 口头禅 etc.)"**, connects to WeChat to auto-chat with your friends.
- **Ingest path is WeChat-native and, for Weport, the most directly comparable:** **MemoTrace** (留痕) export → *"点击'数据' → '导出聊天数据(全部)' → 'CSV'"* → `python scripts/preprocess.py --input_csv data/messages.csv --output_json data/chat_records.json`. Recommended to first migrate phone chats to the PC client *"以扩充数据的数量"* (to increase data volume) — i.e. **the field's standard advice when the corpus is thin is "get more data", not "prompt harder"**.
- Representation: supervised fine-tuning on instruction/input/output JSON with an optional `history` list; **the target's own replies are learned as labels**; identity tags (`name`/`author`) injected via `scripts/id_tag.py` to help the model tell itself from the developer.
- Also ships **incremental pre-training** (*"支持增量预训练功能，实现对普通文本的无监督学习"*), **a celebrity-prose dataset mode** (*"制作清洗名人文本数据集，训练名人风格模仿机器人"*), **human-preference optimisation** (*"支持人类偏好优化策略，在聊天过程中持续学习"*) and **RAG via LlamaIndex** (`scripts/rag.py`).
- Operation detail that matters for realism: it was built against `itchat`/`itchat-uos` and the README documents a **QR-login bug workaround** (`time.sleep(15)` before the login loop in `itchat/components/login.py`), plus the advice *"为了账号的安全起见，建议使用微信小号扫码登录"* (use a burner WeChat account; bank card binding required). **This is exactly the class of version-fragile injection that Weport's own AGENTS.md forbids** — Weport stays read-only and has no send transport. **So Chat-Style-Bot's *ingest and training* ideas transfer; its *deployment* half is out of bounds for us.**

### 2.2 `AFan4724/clone-chat` — the closest architectural match to what Weport should become

- Repo: [github.com/AFan4724/clone-chat](https://github.com/AFan4724/clone-chat)
- Tagline: *"用 AI 大模型复刻聊天对象的本地对话 Agent：导入真实聊天记录，LLM 学习 TA 的语气、表情和回复节奏并以人物身份延续对话，支持语音、主动联系与长期记忆，数据全在本地。"* / EN: *"Clone anyone's texting style from real chat history: a local-first LLM agent that learns their tone, stickers and reply rhythm, then chats as them — voice, proactive messages, long-term memory, fully private."*
- **This is the single most relevant reference for Weport** because it is local-first, TS-ish/Node-flavoured (`server.js` Express API, `lib/*.js`), uses the **OpenAI Agents SDK**, and — critically — **it models the behavioural register explicitly** rather than only the text:

```
user message
  -> Runner.run(PersonaAgent)
  -> read session, samples, memory, habits, stickers, feedback
  -> decide message type, order, delay, and whether to reply at all
  -> validate the reply plan and deliver the resources
  -> write trace and notes
```

Its evidence layer enumerates exactly the things Weport drops:
- *"按场景召回的真实对话样例和自动生成的风格画像"* — **scenario-recalled verbatim dialogue samples** *plus* a generated style profile (Weport has the profile, not the samples-at-the-right-scenario);
- *"行为统计：文字/表情/语音比例、连发数量、回复延迟、活跃时段、高频短句"* — **behavioural statistics: text/sticker/voice ratio, burst count, reply latency, active hours, high-frequency short phrases** (Weport has none of these);
- *"混合记忆检索：全文检索（FTS5）加本地语义向量"* — hybrid FTS5 + local vectors;
- *"表情库：只保留记录中真实发过的表情，按视觉含义和发送上下文建索引"* — a sticker library restricted to stickers the person **actually sent**, indexed by visual meaning *and* sending context;
- *"反馈学习：每条回复可标记'像/不像'，后续轮次参考"* — **per-reply "sounds like / doesn't sound like" feedback fed into later turns.**
- Data layout separates raw from retrieval-shaped: `data/history.rich.jsonl` (full record) vs `data/history.jsonl` (text for memory retrieval) vs `data/habits.json` vs `data/sticker-index.json`; prompts live in `prompts/agent`, `prompts/retry-*`, `prompts/proactive`.
- It **decides whether to reply at all**, and models **delay delivery, undelivered messages, and proactive outreach** — the "回不回、隔多久回、回几条" axis.

**Why this matters:** `clone-chat` arrives at the same "generated profile + retrieval" architecture Weport has, and then adds the layer that makes it sound human: **a behavioural plan (type/order/delay/whether) validated before delivery, verbatim scenario samples, and thumbs-up/down style feedback**. That is a concrete, no-GPU-compatible upgrade path.

### 2.3 `FredHJC/digital-twin-skill` — the "no retrieval, pure behavioural synthesis" position

- Repo: [github.com/FredHJC/digital-twin-skill](https://github.com/FredHJC/digital-twin-skill)
- Tagline: *"用你的聊天记录，蒸馏出一个会说话的 TA。"* / *"Distill anyone's conversation style into an AI that talks like them."* A **Claude Code skill**; no separate API key; the LLM doing the distillation is the coding agent itself.
- **Ingest:** chat **screenshots** (Claude reads images), Feishu/Lark via `lark-cli`, arbitrary JSON chat exports (auto-detects structure), PDFs, `.eml`/`.mbox`, plain text.
- **Representation — and this is the dissenting architecture in the field:** *"分身是**行为合成引擎**，不是数据检索系统"* — **"the twin is a behavioural synthesis engine, not a data retrieval system."** Extraction proceeds on **four dimensions — 语气风格 (tone/style) · 词汇模式 (vocabulary patterns) · 知识边界 (knowledge boundaries) · 行为底线 (behavioural limits)** — then a **two-pass synthesis: `Core` (who they are regardless of audience) + `Facets` (how they differ per audience)**, emitted as a self-contained `SKILL.md` with an injection shield.
- Explicit claim: *"提取结果不含任何原始引用 / extraction outputs contain zero raw quotes — persona files describe patterns, never cite originals."*
- **Multi-register is a first-class product feature:** `/{slug}`, `/{slug}-as-coworker`, `/{slug}-as-partner`, `/{slug}-as-family` — *"同一个人的分身，根据关系场景自动切换语气、用词和思维方式."* And the README demonstrates the same person answering the same complaint in a **partner register vs a colleague register with visibly different segmentation and diction** (the colleague sample breaks into short lines: *"别急 先跟我说说客户骂的是啥 / 是对交付不满意… / 你先别理客户讲啥…"*).
- **Take this seriously as a counter-position to §2.2:** a competent practitioner's stated view is that *retrieval is the wrong paradigm for voice* and **behavioural pattern extraction is enough**. Weport is currently a retrieval system *plus* a knowledge-file system and has neither a Core/Facets split nor an audience-conditioned register.

### 2.4 WeClone forks and clones

- **`a4471174/WeClone`** — a fork/mirror of the same README (identical feature list: LoRA, Qwen2.5-7B default, 16 GB VRAM, Telegram ingest, `weclone-cli`). Reachable, **no independent activity metrics captured → star count UNVERIFIED** ([github.com/a4471174/WeClone](https://github.com/a4471174/WeClone)).
- The parent README's own anti-imitation warning (*"Beware of imitations"* / only official site `weclone.love`) is itself evidence that **the WeClone brand attracts duplicate and scam repos** — relevant if the parent was told "WeClone closed/changed".
- **No evidence found this session of a WeClone fork with a materially different (better) style representation.** Marked **UNVERIFIED / not established** rather than asserted as absent.

---

## 3. Academic / open role-play systems the field actually cites

### 3.1 `LC1332/Chat-Haruhi-Suzumiya` (ChatHaruhi) — Apache-2.0, the canonical "imitate a specific character's voice" system

- Repo: [github.com/LC1332/Chat-Haruhi-Suzumiya](https://github.com/LC1332/Chat-Haruhi-Suzumiya); paper [arXiv:2308.09597](https://arxiv.org/abs/2308.09597) (*Reviving Anime Character in Reality via Large Language Model*); dataset `silk-road/ChatHaruhi-54K-Role-Playing-Dialogue` ([HF](https://huggingface.co/datasets/silk-road/ChatHaruhi-54K-Role-Playing-Dialogue)); from the Luotuo project (Cheng Li, Ziang Leng et al., contributors recruited via DataWhale).
- **Licence: Apache-2.0, explicitly permits commercial use** — *"This project is licensed under Apache 2.0, which permits commercial use."* (README_EN).
- **Scale:** 32 characters / **~54K–62,663 dialogues** in the original release; **140+/142 characters** supported in total; **42,255 English instances adapted from RoleLLM** plus **13,166 Chinese instances**; a **ChatGLM2-LoRA trained on ChatHaruhi-54K** local model; Qwen-7B and Qwen-1.8B fine-tuned role-play models.
- **Calibration is the interesting part, and it is a *style* mechanism:** the user's query is embedded, and the system retrieves the target character's *actual lines* that are closest in **emotion/scene**, then **injects those verbatim lines into the prompt and instructs the LLM to imitate them** — plus `Character_RAG` / `Character_SD` / personality-trait research modules under `research/personality/`. This is the "retrieve *dialogue for style*, not *facts for content*" pattern. **Weport's BM25 index is built and ranked for factual relevance; nothing in it is ranked by "which of my past replies had the same emotional register as this incoming message".**
- Known limitation to quote: the repo is a self-declared work in progress (*"This project is a work in progress"*) and several TODO boxes remained unticked in the English README at capture time (local inference code, 52K trained model, ChatHaruhi2.0 support for local + OpenAI models).

### 3.2 `thu-coai/CharacterGLM-6B` — EMNLP'24 industry track, **the only one with an explicit attribute/behaviour decomposition**

- Repo: [github.com/thu-coai/CharacterGLM-6B](https://github.com/thu-coai/CharacterGLM-6B); paper [CharacterGLM: Customizing Chinese Conversational AI Characters with Large Language Models](https://aclanthology.org/2024.emnlp-industry.107/) (EMNLP 2024 Industry Track, pp. 1457–1476, [arXiv:2311.16832](https://arxiv.org/abs/2311.16832)); by 聆心智能 (Lingxin) + Tsinghua CoAI; based on ChatGLM2.
- **The decomposition is the transferable idea.** The README states the design principle in two halves:
  - **属性 (attributes) → affect what the character *says* (content):** seven attribute classes — **identity, interests, views/opinions, experiences, achievements, social relationships, other.**
  - **行为 (behaviour) → affect the *style and tone* of speech:** *"行为主要由一些动态的元素组成：语言特征、情感表达和互动模式"* — **linguistic features, emotional expression, interaction patterns**; the README's own example is that older people favour formal language while teenagers favour internet slang, and that CharacterGLM considers **linguistic features and personality** on the behaviour side.
- **Evaluation axes it defines (useful as a rubric Weport could adopt directly):** **一致性 Consistency · 拟人化 Human-likeness · 吸引力 Engagement**, plus quality, safety, correctness (hallucination) and an overall score. Human interactive evaluation over **24 characters** (celebrity / daily-life / game-and-film / virtual-romance) and **three topics** (chit-chat, interview, romance), **10 annotators**, pairwise win/tie/lose vs MiniMax, GPT-3.5, GPT-4. Reported: CharacterGLM-66B beats GPT-3.5 and MiniMax in most character categories, beats MiniMax by **~7 points in the interview topic**, and is slightly behind GPT-4.
- **Note the size cliff again:** the paper's headline results are for **66B**; the open weights are **6B**. The pattern "small open model is a demo, big model is the result" repeats.

### 3.3 `mindverse/Second-Me` — Apache-2.0, "train your AI self" with an explicit memory architecture

- Repo: [github.com/mindverse/Second-Me](https://github.com/mindverse/Second-Me); homepage [home.second.me](https://home.second.me/); Chinese site [site.second-me.cn](https://site.second-me.cn/).
- **Stars 15,652 / forks 1,216 / open issues 144 / Apache-2.0** (snapshot). Chinese site claims **"15K+ GitHub Stars"** for the original open-source project.
- **Representation:** *"Using **Hierarchical Memory Modeling (HMM)** and the **Me-Alignment Algorithm**, your AI self captures your identity, understands your context, and reflects you authentically."* Locally trained and hosted; Docker Compose stack (`make docker-up`, web UI on `:3000`).
- Product framing that is directly relevant to the *product* question rather than the ML question: *"Roleplay: Your AI self switches personas to represent you in different scenarios"* — i.e. **the same "one person, many registers" idea as `digital-twin-skill`**, and a claim of being **locally trained / globally connected** (a decentralised network of "Second Mes").
- **Caution for the parent:** Second-Me is aiming at "AI identity/memory network", not at "sound like him in a WeChat thread". Its HMM/Me-Alignment papers are about *identity preservation and memory*, not about chat-register imitation; its dataset is user memories/documents rather than a two-person chat log. **Do not treat it as evidence that a summary-of-memories pipeline reproduces voice.** (Its own corpus is broader than chat.) Its star count is the notable thing here: **the "AI 分身" framing sells, and it is a crowded surface.**

### 3.4 Deliberately out of scope here, cross-referenced

- **CharacterGLM/ChatHaruhi are role-play from *authored* character descriptions + curated corpora**, not from a private person's phone. They are nonetheless the state of the art on *how to make a model hold one specific voice*, and their decomposition (attributes vs behaviour; consistency/human-likeness/engagement) is the most reusable artefact in this section.

### 2.5 `therealXiaomanChu/ex-skill` (前任.skill) — WeChat-native, and the only project that publishes a **layered persona schema**

- Repo: [github.com/therealXiaomanChu/ex-skill](https://github.com/therealXiaomanChu/ex-skill) — *"把前任蒸馏成 AI Skill，用ta的方式跟你说话"*; follows the **AgentSkills open standard**.
- **Ingest is the WeChat stack Weport already lives in:** *"微信聊天记录 | WeChatMsg / 留痕 / PyWxDump 导出 | 推荐，信息最丰富"*, plus QQ txt/mht, 朋友圈/微博 screenshots, photos with EXIF, and free-form dictated text. Parsers ship as `tools/wechat_parser.py`, `qq_parser.py`, `social_parser.py`, `photo_analyzer.py`.
- **The persona representation is a five-layer stack — the most concrete published schema in this survey:**

| Layer | Name |
|---|---|
| 1 | **硬规则 (hard rules)** |
| 2 | 身份 (identity) |
| 3 | **说话风格 (speaking style)** |
| 4 | 情感模式 (emotional patterns) |
| 5 | 关系行为 (relational behaviour) |

  paired with a separate **Part A — Relationship Memory** (shared experiences, date spots, inside jokes, argument patterns, sweet moments, relationship timeline). **Runtime logic: `收到消息 → Persona 判断ta会怎么回 → Memory 补充共同记忆 → 用ta的方式输出`** — i.e. **Persona decides *how*, Memory supplies *what*.** This is the attribute/behaviour split of CharacterGLM, the Core/Facets split of `digital-twin-skill`, and the persona/lorebook split of Character Card V2, all arriving at the same place from four different directions. **Weport has exactly one artefact doing both jobs.**
- **Data-quality guidance that is directly usable as an ingest rule:** *"聊天记录质量决定还原度：微信导出 + 口述 > 仅口述"*, and *"建议优先提供：**深夜对话 > 争吵记录 > 日常消息**（最能体现真实性格）"* — **late-night conversations beat arguments, which beat everyday small talk, for revealing personality.** Weport has 6 months of messages and currently weights them all equally in the map-reduce.
- **Versioning and rollback built in** (`/ex-rollback {slug} {version}`, `/list-exes`, `/ex-persona`, `/ex-memory`, `/delete-ex`, `/let-go`) — i.e. a persona artefact is treated as **versioned, re-generable and revocable**, with a dedicated correction path (`prompts/correction_handler.md`) and an incremental-merge path (`prompts/merger.md`).
- **Honest limits it states itself:** *"这个 Skill 只是你记忆中的ta"* — the artefact is a reconstruction *of your memory of them*, not of them. It also warns about unhealthy attachment and recommends professional help. **Design lesson: name the artefact's epistemic status in the product, and give the owner a "let go"/delete path.**
- Sibling projects named in its README (ecosystem signal that this is now a *genre*): an **`ex-cure` / relationship-reflection** skill by @Windys, and the **"把同事蒸馏成 AI Skill"** project by @titanwings that it credits as its inspiration.

---

## 3.5 The WhatsApp / iMessage fine-tune family — the "smallest complete recipe" in the field

*(A distinct family from the WeChat-native projects in §2: these are the cleanest end-to-end recipes for "one person, one chat export, LoRA, done", and they are worth reading for their **data hygiene choices**, which Weport has not made.)*

**`jordankzf/whatsapp-clone-ai`** — [github.com/jordankzf/whatsapp-clone-ai](https://github.com/jordankzf/whatsapp-clone-ai). **GPL-3.0.** Created **2026-03**; **0 stars / 0 forks / 0 open issues** at capture (snapshot — i.e. *unproven*, do not cite as validated). Self-description: *"Clone anyone from their WhatsApp chat history. Finetune an LLM that talks, thinks, and texts exactly like your friend — then chat with them through a WhatsApp-style web UI."* Topics include `persona-cloning`, `personality-clone`, `qlora`, `whatsapp-export`.

Its pipeline is the reference shape:

```
WhatsApp Chat Export (.txt)
   -> parse_chat.py       # parse, filter, group into conversations
   -> training_data.jsonl # ChatML formatted train/eval split
   -> train on RunPod     # LoRA r=256 on Qwen 3.5 9B (~$1 on L40S)
   -> GGUF Q4_K_M (~5GB)
   -> Ollama + Flask UI   # WhatsApp dark mode clone, runs on CPU
```

**Four decisions in it that Weport should copy conceptually:**
1. **"Groups rapid-fire messages into conversation turns."** A real texting turn is *several bubbles*; the training unit is the *turn*, not the bubble. **Weport chunks at ~message granularity and has no notion of a turn.**
2. **"Random 90/10 train/eval split with early stopping to prevent memorization"** + *"evals every N steps, stops when eval loss rises, auto-loads best checkpoint"*. **This is the field's answer to §6.2's overfit-catchphrase failure: hold out real conversations and stop on held-out loss.** Weport has no held-out set at all.
3. **"LoRA finetuning — preserves base model intelligence while learning personality"** — the explicit reason to prefer LoRA over full fine-tune is that full fine-tune degrades general ability. Relevant if a styles are ever fine-tuned.
4. **Quantised GGUF + Ollama ⇒ CPU-only inference.** Directly relevant to "no local GPU": even a *fine-tuned* persona can be served on CPU at **~10 tok/s** (as reported by the repo). **This is the strongest available counter-argument to "we have no GPU, therefore fine-tuning is impossible for Weport"** — the constraint is *training* and the *style-data quality*, not serving.

**`kinggongzilla/whatsapp-ai-clone`** — [github.com/kinggongzilla/whatsapp-ai-clone](https://github.com/kinggongzilla/whatsapp-ai-clone). *"Create an AI clone of yourself from your WhatsApp chats (using Mistral 7B and Llama3)"*, built on **torchtune** (quantised LoRA fine-tune + command-line chat). Its preprocessing is the notable part and it is a **one-line statement of the core representation choice**: export `.txt` per chat into `data/raw_data`, run `python preprocess.py "YOUR NAME"`, and *"The script will assign **you** the 'gpt' role and your conversation partners the 'user' role"* → the export is converted to **sharegpt format** where **the person being cloned is the assistant**. Two things to take: (a) **multi-chat ingest** ("one .txt from a single chat or many .txt files from all your chats") — Weport has all 184 sessions, which is *more* data than most of these recipes assume; (b) the repo is candid about scope — *"I haven't tried this myself"* appears in the README, so **do not treat its results as evidence**.

**`mtcto/weclone`** — a further WeClone mirror/fork surfaced in search ([github.com](https://github.com/)); **no independent metrics captured → stars and activity UNVERIFIED.**

**What this family collectively establishes:** the open-source convention for cloning *one* person from *one* chat export is **instructions-with-history SFT on a 7–14B model, LoRA/QLoRA, held-out eval with early stopping, served locally**, and every one of them treats *"conversation partners' messages"* as the **user** role and *"the cloned person's messages"* as the **assistant** role. **Weport already has the exact analogue of that split — `voice.jsonl`, "only the user's own messages" (~4,600 lines / 3.8 MB) — and currently uses it only as a retrieval corpus, never as training targets.**

---

## 4. Commercial "digital afterlife" / companion products (griefbots and persona chat)

*Status of this section: positioning and ingest story verified from vendor surfaces; internals are not published for any of these.* The commercially named products in the task brief (**HereAfter AI, Project December, "You, Only You"**, Replika, Nomi, Kindroid, Talkie, Poly.AI, 星野, 猫箱, 筑梦岛, 他她它) are consumer apps whose *internal* representation is not published. What can be verified is their **positioning and their ingest story**, and — the decision-relevant part — **the public record of how these products fail their users**. That failure record is reviewed in §6.

### 4.1 What is verifiable from primary surfaces

| Product | Category | Ingest / persona construction (as advertised) | Status of evidence |
|---|---|---|---|
| **HereAfter AI** | "Legacy avatar" / interactive memoir — interview the person *while alive* (recorded Q&A), then let family converse with the avatar | Not chat-log-derived; it is **scripted interview capture**, i.e. deliberately *not* a clone-from-corpus | Vendor page + press; **reported as shutting down** ([The Independent](https://www.independent.co.uk/life-style/ai-death-grief-bots-b3027331.html)); internals **UNVERIFIED** |
| **Project December** | Custom chatbot with deceased loved ones; the "Joshua Barbeau / Jessica" story made it the category's archetype | **Prompt-level persona configured by the surviving user**, not a model trained on the deceased's corpus; the ethics literature notes OpenAI **terminated its API access** over safety-guideline compliance and it rebuilt on *"its own 'patent-pending technology'"* | [*Philosophy & Technology* 2024, Griefbots/Deadbots](https://link.springer.com/content/pdf/10.1007/s13347-024-00744-w.pdf) (primary-ish, peer-reviewed); internals **UNVERIFIED** |
| **"You, Only You"** (Microsoft patent, 2020) | Patent describing a chatbot reconstructed from a *specific* deceased person's data | Describes a **multi-modal "personality" index**: social posts, **social-media messages**, voice, images, and a classifier trained on the person's messages to produce a personality/speech-style model | **Patent-level description only**; no shipped product confirmed → **UNVERIFIED as a real system.** The article cites it as evidence that "the question of technology-enabled 'immortality' has already appeared on the radar of tech giants" |
| **Replika / Nomi / Kindroid / Talkie / Poly.AI** | Companion/character chat apps | Persona-from-scratch or from a written character brief; **not** a clone of a real person from their chat log | Internals **UNVERIFIED.** Their relevance is as the *register baseline* users compare an imitation against — and it is a **companion** register, deliberately warmer and more attentive than a real friend |
| **Hollo AI** — *"The AI Twin Platform"* ([hollo.ai](https://hollo.ai/)) | Commercial AI-twin SaaS | *"Your voice, knowledge, image and style cloned in minutes"*; *"Train your Twin with exactly what you want it to know – text, audio, links, and documents"*; positioned for creators/teams (24/7 chat + call, a branded page) | **Vendor marketing claims only; no published method, no metric → UNVERIFIED.** Note the pitch is *availability*, not *fidelity* |
| **Personal AI** ([personal.ai](https://www.personal.ai/products), [docs](https://docs.personal.ai/documentation/getting-started/introduction)) | Commercial persona/memory platform | *"AI personas trained on your proprietary data"*; **Memory Core** as the memory layer; two training approaches; persona settings include *"Communication style and traits"*; interaction modes **Autopilot / Copilot**; channels include DM, group, and **Public Chat** | **This vendor is the only one in the survey that advertises a style *metric*:** *"**Personal Score**: Measures how accurately the AI's response reflects your knowledge/style"* — i.e. a productised, per-response fidelity score. **Method unpublished → UNVERIFIED as to how it is computed**, but the *existence* of a scored style-fidelity surface in a commercial product is itself a strong signal about what buyers expect |
| **星野** (MiniMax; [App Store listing](https://apps.apple.com/cn/app/%E6%98%9F%E9%87%8E-%E6%89%80%E5%BB%BA%E7%9A%86%E4%BD%A0%E6%89%80ai/id6463076337?l=en-GB)) | Multimodal **agent content community** — *"数百万款由用户创建的智能体"*; users customise 形象/声音/人设/技能 | **Card-authored personas, human-authored by the community.** The listing's own framing is telling: *"语言模型丰富智能体的人设性格记忆、声音模型让智能体更会说话"* — **the LLM supplies persona/memory, a separate voice model supplies "talking"** | Vendor listing (**2023-11-21** first release date on the listing); internals **UNVERIFIED** |
| **猫箱** (ByteDance, `maoxiangai.com`; [App Store](https://apps.apple.com/cn/app/%E7%8C%AB%E7%AE%B1-%E5%92%8C%E5%BF%83%E5%8A%A8-ai-%E6%8E%A2%E7%B4%A2%E5%89%A7%E6%83%85%E5%AE%87%E5%AE%99/id6475000292); feature summary at [AIProductHub](https://aiproducthub.cn/sites/bytedance-maoxiang-ai-emotional-companion.html)) | ByteDance AI emotional-companion app; Douyin-style vertical swipe between characters | Card-authored; customisable 声音/形象/场景/背景/人物设定; customisation range **40+ image descriptions, 90+ male voices, 60+ female voices**; **the character emits bracketed non-verbal cues** (表情/动作) in the reply text | Vendor listing + third-party summary; internals **UNVERIFIED**. The third-party comparison rates memory: 猫箱 较强, 星野 一般, 筑梦岛 一般, 文小言 不详 — **UNVERIFIED market commentary, not a measurement** |
| **筑梦岛** (阅文/China Literature; per [SenseTime's page](https://www.sensetime.com/) it is presented under **IP角色定制** with SenseTime) | Anime/web-culture character community; *"梦境"* and *"小剧场"* creation formats | Card-authored by the community; positioned as **同人二创** (fan-fiction) rather than personal cloning | Vendor/third-party pages; internals **UNVERIFIED** |
| **文小言** (Baidu), **快崽** (Kuaishou) | Sibling Chinese companion products named in the same comparison | Card-authored; 文小言 differentiated by **写实 (photoreal) dynamic models** rather than 2-D art | Third-party comparison; internals **UNVERIFIED** |
| **微博 明星分身** / **他她它** | Celebrity "digital doubles" and companion chat | Licensed-likeness personas over authored character cards | **No primary source verified this session → UNVERIFIED.** Listed for completeness per the task brief |

### 4.1.1 The commercially important observation about ALL of these

**None of the consumer products in this table clones a private individual from that individual's own chat log.** They clone *authored characters* (card-based) or *licensed celebrities* (contract-based). The only systems that ingest a real person's private message history are the **open-source / agent-skill projects** (WeClone, Chat-Style-Bot, clone-chat, digital-twin-skill, ex-skill, the WhatsApp fine-tuners) — i.e. **the exact thing the owner is building is under-served commercially, and the commercial products that *look* adjacent are solving a different problem (character consistency, not individual fidelity).** Two consequences:

1. **There is no commercial product to copy.** The design has to come from the open-source and research side.
2. **The registered patents (Microsoft's "You, Only You", Project December's "patent-pending technology") are precisely in this gap** — person-cloning-from-personal-data is patent-relevant territory, which is worth flagging to the owner even though nothing here is legal advice.

### 4.2 The one transferable lesson from this category

Griefbot research and journalism converge on a failure that is *not* about facts: **the avatar is fluent, warm, and generic, and the bereaved recognise immediately that it is not them.** The reported failure mode is register and micro-behaviour, and the ethical literature's central warning is that a *plausible but wrong* imitation is worse than none. **This is the same complaint the Weport owner is making, and it means the problem is not "griefbot-specific" and not "not enough data" — it is the representation.**

---

## 5. Memory / agent frameworks the field reaches for (and the *voice* gap each leaves)

Frameworks do not solve voice; they solve continuity. Listed here because the task asks for each one's representation, write/read policy, and specifically **what it does NOT solve about voice** — the full mechanical detail is in `04-memory-context.md`.

| Framework | Representation | Write policy | Read policy | What it does **not** solve about voice |
|---|---|---|---|---|
| **MemGPT / Letta** | LLM as OS with an explicit **virtual context manager**: core memory (in-context blocks) + recall/archival memory (external), with paged read/write via function calls | Model **chooses** to edit core memory / append archival entries during the turn | Model pages memory in via tool calls; self-directed | It manages *what the model knows*; nothing in the memory schema carries **surface realisation** — no prosody, no punctuation habits, no message segmentation, no reply-latency. A perfectly managed memory still produces assistant prose. |
| **Mem0** | Extracted **atomic memory facts** (+ graph variant) with add/update/delete operations | Automatic extraction from conversation into a fact store with conflict resolution | Semantic retrieval of relevant facts | Optimised for **fact salience**; extraction deletes exactly the high-frequency function words and particles that carry voice. Retrieval of style is not a supported query. |
| **Zep / Graphiti** | **Temporal knowledge graph** of entities/relations/facts with validity intervals | Automatic graph construction from conversations, bi-temporal | Graph traversal + semantic search | Temporal graphs answer *"what is true when"*, not *"how would he say it"*. Voice is not an entity or a relation. |
| **Cognee** | ECL (extract–cognify–load) into a **graph + vector** store, pipeline-oriented | Batch/ingest pipelines | Graph + vector hybrid | Same as above; the unit of storage is a semantically meaningful node, so stylistic surface is discarded on ingest. |
| **A-MEM** | **Zettelkasten-style agentic memory**: notes with links, tags, evolution | Agent writes structured notes and links them | Link-following + retrieval | Notes are *about* content; there is no "style note" representation, and summarisation into notes is a second compression pass away from the raw register. |
| **MemoryBank** | Memory with **Ebbinghaus-forgetting**-inspired decay + user-portrait summarisation | Writes summaries/events; strength decays with time and rehearsal | Retrieval weighted by recency/strength | Explicitly built around **summarisation into a user portrait** — i.e. structurally the same shape as Weport's failure. Forgetting is a *feature* for facts and a *bug* for style. |
| **Generative Agents (Park et al.)** | **Memory stream** of observations + **reflection** (periodic higher-level synthesis) + planning; retrieval by recency × importance × relevance | Observations appended; reflections generated on a schedule | Score-based retrieval of observations | The reflection mechanism is the origin of the "summary of summary" degradation Weport is suffering. Generative Agents needed *plausible* behaviour in a sandbox, not *identical* voice for a real person; importance-weighting actively prefers memorable (semantic) memories over stylistic ones. |
| **SillyTavern Vector Storage / summarisation extensions** (mechanism verified below in §5.1) | Character card (description/personality/scenario/example dialogue) + chat-summary extension + vectorised chat history | Summaries written on a message/word threshold; **each message vectorised individually in the background** on send/receive; vector inserts are hash-checked and incremental | Query = the **2 most recent messages**; cosine similarity; **score threshold 0.25**; top **3** messages injected; **the 5 most recent are excluded**; injected as **"past events"** to signal a different point in time | Built for **character** fidelity, not **individual** fidelity — the card is *authored*, so there is no "does it sound like the source person" ground truth to optimise. Its own docs warn the summariser *"may lose some important details or contain hallucinations"* |

### 5.1 What SillyTavern actually implements — and the two mechanics Weport should copy verbatim

Verified against the primary docs and the code-path deep dive ([Chat Vectorization](https://docs.sillytavern.app/extensions/chat-vectorization/), [Summarize](https://docs.sillytavern.app/extensions/summarize/), [DeepWiki: Vector Storage and RAG](https://deepwiki.com/SillyTavern/SillyTavern/6.3-vector-storage-and-rag-system), [DeepWiki: Context and Memory](https://deepwiki.com/SillyTavern/SillyTavern/6-context-and-memory-systems)).

**Mechanic A — the retrieval index may be built from summaries, but the *injected* content is the VERBATIM ORIGINAL.** The docs are emphatic, because users kept misreading it:

> *"Vector summarization does **not** create summaries of your chat. It does not turn the retrieved messages into summaries. It does not make your chat history shorter. It is not 'like Summarize but better'."*
> *"The summarized message does **not** replace the original message in chat. If a vector search matches the vector of a summarized message, **the original message is retrieved** from chat history and shuffled into context."*
> ([docs.sillytavern.app/extensions/chat-vectorization](https://docs.sillytavern.app/extensions/chat-vectorization/))

**This is the exact inversion of Weport's design.** Weport summarises the corpus into 5 markdown files and injects *the summaries* — the highest-compression artefact — as the style material. SillyTavern summarises *only to improve the retrieval key*, and then injects the **raw message**. **Rule to adopt: summaries may route retrieval; they must never be the retrieved style payload.**

**Mechanic B — every message is vectorised individually, so a match can be surfaced on its own.** *"Each message is stored individually, so that it can be found and shuffled individually during generation."* Chunks exist only for **long messages** (default `message_chunk_size` **400 characters**, split at paragraph/line/space boundaries with a configurable boundary marker), and injection positions are configurable: top of chat (default), before the main prompt, or **`in-chat @ Depth 2`** — *"just before the previous reply from the model"*. Relevant to Weport: its 21,201 chunks are ~1 KB each (23 MB / 21,201 ≈ 1.1 KB) — i.e. **multi-message chunks**, not single utterances. A single utterance can therefore never be retrieved on its own, which is precisely the granularity at which voice lives.

Other verified details worth having on file: retrieval query = the **last 2 messages** (configurable via "Query messages"); injected top-**3** with a **0.25** score threshold; the **5 most recent messages are retained in place** so as not to disturb them; messages are **hash-checked** (`getStringHash` vs `getSavedHashes`) so only changed messages are re-embedded; the store is `vectra` (local, cosine) partitioned by user/source/collection/model, **20+ embedding providers** including browser-side WebLLM. Weport's prefilter-plus-BM25 approach is architecturally similar in spirit and *much* faster than loading 23 MB per turn, so there is nothing to copy there.

### 5.2 The tradeoff the SillyTavern docs name explicitly, and that Weport will hit too: **dynamic retrieval breaks prefix caching**

> *"Like any dynamic prompt source (World Info, Summarization, etc.), Chat Vectorization restructures the prompt prefix between the LLM calls, which can lead to frequent cache misses. **When used with caching, vectorization is often counter-productive, as the modified prompts rarely hit the cache – effectively making caching useless. You have to choose one or the other, but not both.**"* ([docs.sillytavern.app/extensions/chat-vectorization](https://docs.sillytavern.app/extensions/chat-vectorization/))

**This is a first-class architectural constraint for Weport**, which has an explicit prefix-cache discipline (`electron/services/ai/prefixCache.ts`, DSH's 0.8/0.16 ratios, per its own AGENTS.md) *and* per-turn BM25 retrieval. Two consequences:

1. **Retrieved material must be placed so the cached prefix survives.** Anything injected *before* the stable persona block invalidates the cache on every turn; anything appended at the far end (or placed in the same position every turn) keeps the prefix intact. **Position the retrieved style samples AFTER the stable block, at a fixed position, or serialise them deterministically** — not interleaved with the persona text in a run-dependent order.
2. **This also explains a real cost/latency tradeoff in the mix.** A BM25 result set whose ORDER changes turn to turn produces a different prompt prefix even when the *content* is identical. Sorting the injected chunk IDs canonically (not by score) may be worth real money at 25k characters/turn.

Note also the *summariser's* own honesty, which is the strongest vendor-side admission of §6.2's degradation mechanism, from the most widely deployed implementation:

> *"Summarization can help with outlining general details of what is happening in the story, **which could be interpreted as a long-term memory, but take that statement with a grain of salt. Since the summaries are generated by language models, the outputs may lose some important details or contain hallucinations**, so you're always advised to keep track of the summary state and correct it manually if needed."* ([docs.sillytavern.app/extensions/summarize](https://docs.sillytavern.app/extensions/summarize/))

The same page documents the summarisation *strategies* Weport's map-reduce does not distinguish: **RAW_BLOCKING** (summary generated from the summary prompt + chat history only; *"can (and will) generate prompts that have a lot of variability between them"*, bad for slow prompt processing), **RAW_NON_BLOCKING** (same, non-blocking), and **CLASSIC_BLOCKING** (the summarisation prompt is appended to the *normal* generation prompt *"not omitting the character card, main prompt, example dialogues"* — so the summariser sees the persona and stays in its register, and prompts reuse processed prefixes). **The last one is the directly transferable trick: give the *summariser* the persona/register, or the summaries will be written in the summariser's own voice** — which is exactly the "machine pattern" CharacterGLM warns about (§6.2.3), and exactly how Weport's 5 markdown files inherited assistant prose.

**The one-line synthesis:** every framework above answers *"what does the model know?"*; none has a **style store** with its own write/read policy. Weport needs a **second retrieval index, built and ranked for register rather than relevance** — `clone-chat` builds exactly that (habits + scenario samples + feedback), and ChatHaruhi ranks by emotion/scene rather than fact.

> **⚠️ Evidence-grade warning on this table.** Only **Mem0 / Letta / Zep-Graphiti / SillyTavern** in the table above were verified against sources opened this session (the two comparison articles and the SillyTavern docs cited in §5.1). **Cognee, A-MEM, MemoryBank and Generative Agents are described here from general knowledge of the field; I did not open their papers or repos in this session** — their *mechanism* claims are **UNVERIFIED in this document** and should be checked against primary sources before anything depends on them. The direction of the argument (all of them store semantic content, none stores surface style) is a claim about the *class*, and it is well supported by the verified SillyTavern/Character.AI evidence in §5.1 and §6.4 — but do not cite the four unverified rows as if measured. See `04-memory-context.md` for the mechanical detail.

---

## 6. Evidence on WHAT FAILS

*Quotes are reproduced verbatim as found in the primary source. Anything not quotable from a primary source is marked UNVERIFIED. §6.1–6.2 are structural/project-internal evidence; §6.3–6.4 are practitioner testimony and community-reported drift.*

### 6.1 Documented, quotable admissions inside the projects themselves

| Failure | Quote | Source |
|---|---|---|
| Small/local fine-tunes are only "average" | *"7B模型效果一般，14B及以上的模型效果会更好"* | [WeClone README](https://github.com/xming521/WeClone) |
| Clone quality is dominated by model size and data volume, not by cleverness | *"微调LLM效果很大程度取决于模型大小、聊天数据的数量和质量，理论上模型越大，数据越多，效果越好"* | [WeClone README](https://github.com/xming521/WeClone) |
| The project's own success criterion is an aesthetic smell test, with no metric | *"让大模型有'那味儿'"* | [WeClone README](https://github.com/xming521/WeClone) |
| Data volume is treated as the remedy for thin corpora | Advises migrating phone chats to the PC client *"以扩充数据的数量"* | [Chat-Style-Bot README](https://github.com/Chain-Mao/Chat-Style-Bot) |
| Retrieval ≠ style; a *separate* style mechanism is needed | Adding RAG *"会进一步提升风格模仿能力和细节问题的准确性"* — RAG improves style **on top of LoRA**; no source claims RAG alone reproduces style | [Chat-Style-Bot README](https://github.com/Chain-Mao/Chat-Style-Bot) |
| A competent builder's dissent: **retrieval is the wrong paradigm for voice** | *"分身是**行为合成引擎**，不是数据检索系统"* — the twin is a behavioural synthesis engine, not a data-retrieval system | [digital-twin-skill README](https://github.com/FredHJC/digital-twin-skill) |
| Register is **audience-dependent**, so one global voice profile is wrong by construction | *"同一个人的分身，根据关系场景自动切换语气、用词和思维方式"* — same person, different tone/diction/thinking per relationship | [digital-twin-skill README](https://github.com/FredHJC/digital-twin-skill) |
| Style and content must be separated architecturally | Attributes affect **content**, behaviour affects **style and tone**: *"属性主要影响语言表达的内容，行为则影响语言表达的风格和口吻"* | [CharacterGLM-6B README](https://github.com/thu-coai/CharacterGLM-6B) |
| Behaviour is not one thing — it is linguistic features + emotion + interaction pattern | *"行为主要由一些动态的元素组成：语言特征、情感表达和互动模式"* | [CharacterGLM-6B README](https://github.com/thu-coai/CharacterGLM-6B) |
| A clone that never discloses it is an AI / never leaks source material needs an explicit injection shield — i.e. persona files are *attacked* prompts | *"Runtime injection shield blocks data extraction attempts"*; *"Twin stays in character — never acknowledges being an AI"* | [digital-twin-skill README](https://github.com/FredHJC/digital-twin-skill) |

### 6.2 Structural failure modes visible in the architecture of the above (with the mechanism named)

1. **Summary-of-summary degradation.** `04-memory-context.md` covers MemoryBank / Generative Agents reflection; the mechanism is that each synthesis pass keeps semantic content and drops surface realisation, and the loss is **monotone** — you cannot recover function words, particles, pauses, or segmentation from a summary, and a summary of a summary has strictly less surface signal than the first summary. Weport runs a **map-reduce over 21,201 chunks into 5 markdown files**: at least two compression levels between the raw utterance and the prompt.
2. **Assistant-register leakage.** Every system that ships a prompt wants to be *helpful, balanced, well-punctuated and complete*. A real WeChat person is none of those: they send fragments, drop subjects, use 了/吧/啊/嘛/哈 as sentence-final leavening, split one thought into three bubbles, and reply "嗯" and stop. Two projects above attack this explicitly (WeClone's `identity.json` name/author tags; `clone-chat`'s reply-plan validator + whether-to-reply decision). Weport does not.
3. **Overfit catchphrases.** Both fine-tuning projects expose `num_train_epochs`, `lora_rank`, `lora_dropout` as tunables — i.e. overfitting the target's tics is a *known* failure that becomes worse with epochs, and 104k messages with a short-vocabulary chat register is a high-overfit-risk corpus. **No project in this survey publishes a catchphrase-rate metric.** UNVERIFIED that any of them tunes it explicitly.
4. **Voice is not a fact, so fact-oriented retrieval cannot find it.** BM25 over 21,201 chunks is scored by term overlap with the incoming question. A message like *"哈哈哈那你去呗"* is nearly **zero-information** and will never win a relevance ranking — yet that is precisely the class of utterance that carries the person's voice.
5. **The 2–3-sentence WeChat register is under-represented in the training data of every model involved.** Both the *imitation* literature and the *bank of targets* agree: see `02-academic.md` §industry/admissions (7B "average", 14B+ better) and its chat-style results — chat is the weakest genre in stylometry.

### 6.2.1 The ChatHaruhi paper's own autopsy of **prompt-only** persona imitation — the closest published statement to Weport's bug

This is the most load-bearing quote in this document, because ChatHaruhi *tried exactly what Weport is doing* and published why it fails. From [arXiv:2308.09597](https://doi.org/10.48550/arxiv.2308.09597) (quoted verbatim):

> "In open-source role-playing implementations, developers or users have employed similar prompts, inputting them continuously into ChatGPT …: *I want you to act like {character} from {series}. I want you to respond and answer like {character} using the tone, manner and vocabulary {character}* … However, while simple, such implementations have the following drawbacks:
> **1. They rely heavily on the language model's existing memories.** If the language model's own memories about the work are fuzzy, it cannot mimic specific characters well.
> **2. The 'know all of the knowledge of {character}' is vaguely defined, and does not guard well against hallucinations.**
> **3. Even with such prompts, the chatbot's conversational style is still heavily influenced by the underlying language model.** Adjusting the prompt may alleviate this, but finely tuning the prompt is needed for each character.
> These drawbacks clearly limit the utility of such role-playing chatbots."

**Drawback 3 is precisely Weport's symptom, named in a 2023 paper:** *the chat's style is still heavily influenced by the underlying model*. A 25k-character Chinese system prompt describing the person does not override the base model's assistant register. And the paper adds that fixing it by prompt engineering is **per-person work that does not generalise**.

### 6.2.2 The same paper's autopsy of **fine-tuning**, and its structural answer

> "Another simple idea is to fine-tune the model on the character's dialogues. With sufficient data, language models can capture a character's tone, but this also introduces new problems. In a preliminary experiment, we found that **fine-tuned ChatBots produced more hallucinations**. Also, for many minor characters, it is difficult to obtain enough data for fine-tuning. In summary, **better enabling language models to role-play and mimic character classics remains an unsolved issue.**"

So: **prompt-only → base-model register leaks; fine-tune-only → hallucination rate rises.** ChatHaruhi's answer is the hybrid, and its mechanism is worth copying wholesale:

> "For models like ChatGPT and LLaMA2 that have gone through a lot of reinforcement learning from human feedback (RLHF), since these language models often face tasks like 'Give me m different options', 'Generate m titles', etc., **the output of such language models tends to not repeat content from the context**. We also observed this phenomenon in preliminary experiments. Therefore, our proposed method is to **emphasize in the prompt that the model is cosplaying a specific character. And emphasize that the language model can reuse classic lines** from the novel or movie."
> "**Character emphasis not prominent enough:** Due to RLHF, each language model has its own specific language preferences. Even when given D(q, R) to imitate, the model's output is still influenced by the language model itself. We find that **supplementing the personality of the character at the end of the prompt yields better results** in this case."

**Two directly actionable instructions for Weport's prompt builder:** (a) explicitly licence the model to *reuse the retrieved verbatim lines* — an RLHF-tuned model is trained *away* from copying its context, which is why RAG-injected quotes get paraphrased into assistant prose instead of being echoed; (b) **place the style/personality reinforcement at the END of the prompt**, not only in the middle, because the document reference precedes the user turn and position matters.
ChatHaruhi's evaluation also concedes its own limits: quantitative results and the user study were **"still in progress"** at publication time, so its claimed improvements are not backed by published numbers — treat its *design* as evidence, not its *results*.

### 6.2.3 CharacterGLM's published critique of both prior approaches (EMNLP'24)

From the [CharacterGLM paper](https://aclanthology.org/2024.emnlp-industry.107.pdf), the field-level assessment:

> "**[Tuning-free]** … Relying only on static profiles, it may **fail to maintain superiority in multi-turn conversations, thus leading to poor adaptability.**"
> "**[Tuning-based]** … synthesis via LLMs … where the characters' social behaviors often show **a single machine pattern and QA format**, deviating from the natural social dialogue."

That second clause is the **machine-register failure**: LLM-synthesised persona dialogue converges on Q&A shape, which is *not* how people text. It is also a warning about Weport's own map-reduce output (LLM-written markdown about the person inherits the LLM's register).
CharacterGLM's evaluation is also the field's best statement of why this is hard to *measure*: it reports that **"the correlation between automatic evaluations [GPT-4 as judge] and manual evaluations proves low, especially for metrics with high subjectivity"**, that inter-annotator agreement was only **"moderate"** even after a two-stage calibration, and that evaluation is **"labor-intensive"** and subjective. Its documented response-quality failure axes are directly usable as a Weport QA rubric: **(1) time-constraint violations, (2) contradiction (with context or with the profile — including internal self-contradiction), (3) repetition (repeating context/material, or word-level repetition), (4) less-quality.**

### 6.2.4 Practitioner evidence: the SillyTavern/persona-card ecosystem — the closest thing to "the same bug, at scale"

SillyTavern's character-card format + vector storage + summarisation is the highest-volume public instance of "describe a person, retrieve context, chat as them". Its own community documentation reads as a list of Weport's failure modes:

| Symptom (as the ecosystem describes it) | Stated cause | Source |
|---|---|---|
| **"The AI responds in a generic, neutral tone, or it acts like a completely different character"** — it ignores the defining traits | card description/first message too short or vague; **the system prompt overrides the card**; model handles long context poorly | [MiniTavern troubleshooting](https://blog.mini-tavern.com/blog/sillytavern-character-card-troubleshooting-fix-common-errors-and-improve-ai-resp-74982f) |
| **"The AI Refuses to Follow the Character's Personality"** — a cold character turns warm, a serious one cracks jokes; **"break character" frequently** | **conflicting instructions in the system prompt (e.g. 'be helpful' vs 'be rude')**; weak personality/scenario field; an over-detailed user persona overriding the card | [MiniTavern troubleshooting](https://blog.mini-tavern.com/blog/sillytavern-character-card-troubleshooting-fix-common-errors-and-improve-ai-resp-74982f) |
| **"Why does my character keep breaking character?"** | "the card is too vague, contradicts itself, **or is so long that key traits get pushed out of context**" | [TavernSprite best practices](https://tavernsprite.com/blog/sillytavern-character-card-best-practices/) |
| **"Without a voice sample, the model guesses, and the guess drifts over a long chat."** | no `mes_example` | [TavernSprite best practices](https://tavernsprite.com/blog/sillytavern-character-card-best-practices/) |
| **Bloated cards cause "forgetting"** | "**Everything on the card … shares the context window with the actual conversation. A bloated card pushes recent messages out of context, which is often the real reason a character 'forgets' what just happened.**" | [TavernSprite best practices](https://tavernsprite.com/blog/sillytavern-character-card-best-practices/) |

**Two of these are direct hits on Weport's design:**
1. **"Be helpful" overrides the persona.** Weport sends a ~25k-character document *about* a person to a hosted assistant model whose RLHF training is overwhelmingly "be a helpful, clear, well-formatted assistant". The card ecosystem's diagnosis is that **generic helpfulness instructions in the system prompt beat persona instructions**, so a persona prompt must *forbid* assistant behaviour explicitly, not merely describe a person.
2. **"A bloated card pushes recent messages out of context."** Weport's 25k-char document is ~5–8k tokens of *descriptive prose* competing with the live conversation for the model's attention budget. The card ecosystem's answer is the opposite of Weport's: **"Specific, consistent, and lean"**, and the three highest-leverage fields for voice are **`first_mes` (the greeting) and `mes_example` (example dialogue)** — *"Example messages are the most direct way to fix a voice. If the character should be terse and dry, show a terse, dry exchange. The model imitates the pattern."*

**The mechanics of the spec itself** (verified against primary sources): the widely copied format has exactly six V1 fields — `name`, `description`, `personality`, `scenario`, `first_mes`, `mes_example` ([spec_v2.md](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)); **V2 added `creator_notes`, `system_prompt`, `post_history_instructions`, `alternate_greetings`, an embedded `character_book` (lorebook)**, and later `tags`/`creator`/`character_version`/`extensions` ([spec_v2.md](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md); TypeScript definition in [SillyTavern's `spec-v2.d.ts`](https://github.com/SillyTavern/SillyTavern/blob/626b324f/src/types/spec-v2.d.ts)). Note what the ecosystem *added over time*: **a post-history instruction slot** (style reinforcement after the chat history — the same lesson ChatHaruhi's paper reached) and **a lorebook** (retrieval for *facts*, kept separate from the persona fields — the same attribute/behaviour separation CharacterGLM formalises). **A mature community independently arrived at: (a) style in a small fixed set of slots, (b) style reinforcement both before and after history, (c) facts in a separate retrievable store.**

> **Reality check on the ecosystem's own ceiling:** cards are *authored*, so there is no ground truth for "does this sound like the real person". The ecosystem can tell us a great deal about **what fails structurally**, and nothing about **whether fidelity is achievable**. For fidelity evidence, the source is the stylometry literature (`02-academic.md`) and the fine-tuning projects above.

### 6.2.5 Griefbot / digital-afterlife evidence: what the *product* failure looks like

- **The flagship of the category shut down.** [HereAfter AI announced it was shutting down](https://www.independent.co.uk/life-style/ai-death-grief-bots-b3027331.html) (The Independent, reporting a plan price around **US$199**), while DeepBrain AI was reported to offer premium 3-D avatar recreations **up to US$50,000 plus maintenance**. Reported second-hand by the article, so treat the figures as **as-reported, not audited**.
- **The category's documented harm is *not* "it got facts wrong".** The Independent's framing of the failure mode: *"A software update can alter its vocabulary, humour, 'memories', or political tone. … At some point, preservation gives way to interpretation. Interpretation then becomes invention."* and *"Once grief depends on server uptime, someone owns the next sentence."* That is the **hosted-model hazard Weport shares**: the person-representation is not the artefact under your control; the base model is, and a base-model upgrade silently changes the clone's humour and vocabulary.
- **Platform policy already treats person-simulation as a special case.** OpenAI's usage policy requires that a conversational system that "simulat[es] another person" — except historical public figures — **"either have that person's explicit consent or be clearly labeled as 'simulated' or 'parody'"**, and Project December had its API access terminated for not abiding by the safety guidelines ([Griefbots, Deadbots, Postmortem Avatars, *Philosophy & Technology* 2024](https://link.springer.com/content/pdf/10.1007/s13347-024-00744-w.pdf), citing OpenAI 2023 usage policy and Robitzski 2021). **Decision-relevant for Weport: the *consent* case is clean when the owner clones himself, but the *labelling* case is not automatic — the doc's own terms-of-service surface should say the assistant is a simulation.**
- **The ethics literature's design recommendations are directly implementable controls**: sensitive procedures for **"retiring" deadbots**, **meaningful transparency** through disclaimers on **risks and capabilities**, **adults only**, and the **principle of mutual consent** (consent of both the data donor *and* the people who will interact with the clone) — from the same *Philosophy & Technology* paper. For a self-clone, the actionable one is **mutual consent: the owner's friends are about to be talked to by something that imitates him.**

### 6.2.6 The memory-framework comparison, as practitioners actually summarise it

Two independent 2026 comparisons converge on the same table, which is what the parent should carry forward ([PLUR](https://plur.ai/blog/mem0-vs-letta-vs-zep/), [Coworker AI](https://coworker.ai/blog/mem0-vs-zep-vs-letta)): all three are **Apache-2.0**, all three are **not human-readable** (*"Memories are opaque vector embeddings — you cannot read what the agent 'knows' by opening a file"*; *"Your agent's memory … no temporal knowledge graph"* for Letta; *"Zep: graph traversal is harder to reason about than vector similarity"*), stars as of Jul 2026 **Mem0 ~60K, Letta ~24K, Zep/Graphiti ~28K** (as reported by PLUR — **UNVERIFIED against GitHub**), and the **explicitly acknowledged lossy step**:

> *"Automatic extraction is lossy by nature, and what it decides to keep is not always what you would have chosen."* ([Coworker AI](https://coworker.ai/blog/mem0-vs-zep-vs-letta))

**That sentence is Weport's bug in one line, applied to Mem0 — and Weport's map-reduce is the same lossy extraction with the style discarded rather than the facts.** Neither comparison lists "tone/style/fidelity" as a capability of *any* of the three frameworks, because none of them has one.

---

### 6.3 The single most valuable first-hand report: a Chinese practitioner who did exactly Weport's experiment and published the post-mortem

**Source: kukusuyi, *"我用自己的微信聊天记录，微调了一个'数字分身'"*, 博客园, 2026-05-26** ([cnblogs.com/kukusuyi/p/20166103](https://www.cnblogs.com/kukusuyi/p/20166103)). This is a self-reported personal experiment (n=1, no peer review) — treat it as **practitioner testimony, not a result** — but it is uniquely relevant because **the method is the method Weport would use, and the author independently derives Weport's own diagnosis.**

**What he did, in his numbers:**
- Data: **WeFlow** export (the same lineage as Weport's WCDB stack), **one year, 7 high-frequency friends** → after de-identification, **~20,000 trainable dialogue samples**.
- Model: **Qwen-14B**, cloud training, **A100 40 GB, ~9 hours**.
- Stated objective, verbatim: *"这次微调的目标并不是让模型获得新的通用知识"* — the goal is **not** new knowledge, but *"让模型在已有语言能力的基础上，吸收我个人聊天记录中体现出来的表达模式、语气习惯和部分行为倾向"* — **to absorb the patterns of expression, tone habits, and some behavioural tendencies** from his messages.
- Evaluation: **100 questions generated at random by ChatGPT**, judged by the author himself; **~90/100 judged "比较符合" (fairly consistent)**.

**The five problems he reports — four of which Weport has, and one of which contradicts a tempting Weport fix:**

1. **Register is audience-specific, so a single clone is a partial clone.** *"这次数据主要来自我和关系较好的朋友之间的聊天记录 … 模型学到的'我'，更像是我在熟人关系、朋友关系、轻松语境中的表达方式。面对老师、同事、陌生人、家人、合作对象、面试官，我的表达方式都会发生变化。这意味着，目前这个数字人其实不是完整的我，而是某个关系场景下的我。"* — **"it is not the whole me, it is me in one relationship scenario."** This is §7.4 confirmed by direct experiment.
2. **His evaluation method is self-judged and therefore biased.** *"100 问测试虽然能提供初步感受，但由我本人判断'像不像我'，这显然有主观偏差."* His own proposed fixes read like a spec for a real eval harness: **a larger, typed question set; multiple raters; a control model; and — crucially — separating *linguistic-style agreement* from *behavioural-judgement agreement*** (*"区分语言风格一致性和行为判断一致性"*).
3. **Hallucination persists.** *"它有时会编造一些不存在的细节 … 这说明它仍然不是一个真正可靠的'人格副本'，而只是一个基于已有数据进行近似模拟的语言模型."* — **the artefact is an approximation, not a copy.** He explicitly declines to claim *"一个人可以被聊天记录完整复刻"*.
4. **He tried the "split the models" architecture and it was UNSTABLE.** This is the most decision-relevant negative result in the whole survey, and it was reached by attempting exactly what seemed clever: *"模型看到的是完整对话，而不是被精细标注过的行为层、情绪层、关系层和表达层。因此，**强行让两个模型分工，反而会出现协作不稳定的问题**"* — **the model sees whole conversations, not separately labelled behaviour/emotion/relationship/expression layers, so forcing a division of labour between two models produces unstable collaboration.** He *then* proposes a two-layer design anyway (see below), so the honest reading is: **the layering is right at the *artefact* level (separate files/sections), and wrong at the *model* level (two models with a handoff).**
5. **His positive finding about what fine-tuning actually learns** is the argument for fine-tuning in one sentence, and it is broader than "style": *"但测试之后，我发现它似乎不只是在学'怎么说'，还在一定程度上学到了'怎么判断'."* — it learned not just **how I speak** but partly **how I judge**: attitudes to different matters, how he handles conflict, how he comforts people, his preferences when choosing, and *"你解释一个问题时更重视逻辑、情绪，还是经验"*. His framing: *"聊天记录不是简单的文字集合，它可能是一种压缩过的行为轨迹"* — **the chat log is a compressed behavioural trajectory.**

**His proposed architecture — the two-layer split — is the concrete design Weport is missing:**

| Layer | Name (his terms) | Job |
|---|---|---|
| 1 | **个体倾向层 (individual-disposition layer)** | Decide: what scenario is this question in; **what is my relationship to the asker**; what stance would I likely take; what is my emotional intensity; would I answer directly, **ask back, snark, or avoid**; should this reply be casual, serious, restrained, or aggressive |
| 2 | **语言生成层 (language-generation layer)** | *"小模型负责'像我一样判断'，大模型负责'把这种判断说得更好'"* — the small model judges **like him**, the large model makes that judgement **well-expressed** |

Benefits he claims: *"个体特征和语言质量可以分开处理"* — individual character and language quality become separately addressable (small model keeps personal bias; large model provides expression, context handling, and safety constraints). **His own §8 caveat (§4 above) is the warning that the *handoff* is where it breaks — so implement it as one model with two prompt stages/sections, or with the disposition output as a *structured* intermediate (schema-validated), not as free prose.**

**His forward agenda is a to-do list Weport can lift directly:** more people's data (generality), **scenario classification** (日常闲聊 / 情绪安慰 / 观点表达 / 冲突处理 / 学习建议 / 技术讨论 / 亲密关系 / 陌生人交流 / 高风险决策), a 500–1,000-question eval set, separating *sounds-like* from *judges-like*, and **relationship labels**: *"同一句话，如果是朋友问、老师问、陌生人问、家人问，真实个体的回答可能完全不同。所以数字人不能只知道'问题是什么'，还要知道'是谁在问'."* — **a clone must know WHO IS ASKING.**

**And his closing line is the correct framing of the whole field:** *"数字人真正困难的地方，不是让它说话，而是让它在具体关系和具体场景中，以接近某个真实个体的方式做出回应."* — **the hard part is not making it talk, it is making it respond the way a specific individual would in a specific relationship and a specific situation.**

---

### 6.4 "Standard Persona Syndrome" — the field's name for Weport's exact symptom, and its stated mechanism

The companion/character-chat platform with the largest user base has a widely reported failure that is **structurally identical to the owner's complaint**, and the mechanism is the same one: **the base model eventually overrides the persona.**

The community's name for it is **"Standard Persona Syndrome"**, described as:

> *"Character.AI forgets your persona because **long conversations drift back toward the base model's voice** — a pattern the community calls 'Standard Persona Syndrome'. … **The persona is still in the system prompt — the model just gives it less weight as turns accumulate.**"*
> *"You wrote a 140-word persona … It worked beautifully for the first dozen messages. **By message fifty, the character has flattened into a generic helpful assistant — same voice as every other bot, none of the quirks you built.** The persona did not get deleted. **The model just stopped honoring it.**"*
> — [MemoryLake, "Why Does Character.AI Forget My Persona?"](https://www.memorylake.ai/en/blogs/character-ai-forgets-persona)

> **⚠️ Source bias — read the claim, not the vendor.** MemoryLake sells a competing persistent-memory layer, so its *remedy* ("re-inject the persona slice every 20–30 turns", "a canonical persona bible outside the platform") is marketing. **The symptom description and the mechanism are corroborated by non-vendor sources**, and the same page concedes that the persona ceiling is a *platform* property rather than a user error. Treat the *diagnosis* as credible and the *product* as an advert.

The most decision-relevant specific in that piece, and it is the **direct counter-example to Weport's "more description is better" instinct**:

> *"Character.AI recommends personas between **90 and 150 words**, and **warns that longer personas do not perform better because they get deprioritized inside the context window.**"*

**Weport's style prompt is ~25,000 characters — roughly 100–200× that ceiling.** If the mechanism is "attention to the persona block is diluted as the block grows", then Weport's 23 MB corpus summarised into a 25k-character document is not merely *insufficient* for voice; the *manner of delivery* actively pushes the persona out of effective attention. **A shorter, denser, verbatim-example-driven persona block is predicted to beat a longer descriptive one.**

Corroborating mechanism statements from non-vendor sources:

- **On why retrieval/memory loses to the base model's habits:** *"Memory is advisory, not a rule. When memory conflicts with statistically 'successful' responses, memory gets overridden."* and *"Why does even a 'less spicy' chat style drift back into the same behavior? Because **those styles are cosmetic. Under pressure, the model falls back to its highest-reward behaviors**."* — [Medium, "Character.AI Is Becoming Unusable"](https://medium.com/@chuckmellisa/character-ai-is-becoming-unusable-8dd35b960). **"Under pressure, the model falls back to its highest-reward behaviours" is the best one-sentence explanation of register reversion in this survey.** It is a practitioner essay, *not* a measurement — labelled accordingly.
- **On the write/read policy a *fact*-oriented memory needs and a *style*-oriented one lacks:** the required components are listed as a *"structured profile"*, *"a vector index of past conversation snippets"*, an *"append-only log of 'facts the user told us'"*, a retrieval step, and **a writeback step** — with the note that *"Not every message contains memorable content — **most are filler ('haha yeah,' 'interesting')**"*, so the writeback logic filters them out ([DEV, "Why Character.AI Forgets You"](https://dev.to/kinthai/why-characterai-forgets-you-and-what-persistent-memory-actually-requires-1b23)). **Read that filtering rule carefully: it explicitly discards exactly the utterances that carry voice.** A fact-memory system that filters filler is, by construction, a **style-erasing** system — and this is the external confirmation of §6.2.4's "extraction is lossy by nature".
- **On the sliding-window baseline:** *"There's no separate 'memory' data structure — the conversation history is the memory, and it's bounded by how many tokens the model can read. … After that, the oldest messages silently disappear."* ([same DEV article](https://dev.to/kinthai/why-characterai-forgets-you-and-what-persistent-memory-actually-requires-1b23)). Weport solves this for **facts** and not for **voice** — which is the shape of the entire landscape.
- **On the honest limits of a memory layer, even a good one:** *"this is persistent cross-session memory, not an infinite verbatim transcript. The character remembers **the facts and the arc** of your story, not every word you ever typed."* ([ChatBrat](https://chatbrat.ai/bratlog/does-character-ai-remember-your-conversations)) — **and "not every word you ever typed" is precisely the material that makes it sound like the person.** The author states the tradeoff as a *feature*; for a persona clone it is the defect.

**Why this section matters for the diagnosis:** Weport's owner is describing the *most-complained-about* failure mode of the largest persona-chat product in the world — on a system that has *more* persona material than any of them. That strongly suggests the problem is **not corpus size and not prompt length**; it is that **a description of a person, however good, is a weaker steer than the base model's habits**. The fix is a representation that does **not** rely on sustained attention to a description: weights (fine-tune), a **forced imitation target** (verbatim examples the prompt is licensed to echo), an explicit **behavioural plan** (type/burst/delay/whether-to-reply), or a **register-conditioned retrieval index**. Weport currently has none of the four.

---

## 7. Dead ends and myths — approaches widely tried that did not work

Each entry names the *mechanism* of failure, not just the verdict, and cites the evidence above.

### 7.1 "Just write a long character description / a big system prompt"
**Dead end — but it is the least silly of the dead ends, and it fails for a specific, fixable reason.** ChatHaruhi measured that with persona prompts alone, *"the chatbot's conversational style is still heavily influenced by the underlying language model"* ([arXiv:2308.09597](https://doi.org/10.48550/arxiv.2308.09597)); CharacterGLM adds that relying on static profiles *"may fail to maintain superiority in multi-turn conversations, thus leading to poor adaptability"* ([EMNLP'24](https://aclanthology.org/2024.emnlp-industry.107.pdf)); and the SillyTavern ecosystem's #1 diagnosis for a generic, neutral tone is that **generic helpful instructions in the system prompt override the persona** ([MiniTavern](https://blog.mini-tavern.com/blog/sillytavern-character-card-troubleshooting-fix-common-errors-and-improve-ai-resp-74982f)).
**Corollary — length is actively harmful past a point:** *"a bloated card pushes recent messages out of context, which is often the real reason a character 'forgets'"* ([TavernSprite](https://tavernsprite.com/blog/sillytavern-character-card-best-practices/)). Weport's response to "it doesn't sound like him" must **not** be "add more markdown".

### 7.2 "Just embed everything / throw the whole history into RAG"
**Dead end as a *style* remedy — and it is the misconception Weport currently holds.** Three independent lines of evidence:
1. Nobody in the field claims RAG alone reproduces style. WeClone ships RAG as an *addition* to LoRA and describes it as improving style "*on top of*" the fine-tune ([WeClone README](https://github.com/xming521/WeClone)); Chat-Style-Bot says the same ([Chat-Style-Bot README](https://github.com/Chain-Mao/Chat-Style-Bot)).
2. **The retrieval objective is wrong.** Weport's BM25 ranks by *topical overlap with the incoming question*. Voice lives in low-information, high-frequency utterances (*"嗯嗯"*, *"哈哈那行"*, *"你看着办"*) that a relevance ranker will never surface. ChatHaruhi's retrieval is ranked by **emotion/scene similarity to the current line** because the retrieved item's job is to be *imitated*, not *used* ([arXiv:2308.09597](https://arxiv.org/abs/2308.09597)).
3. **The tool is the wrong shape even for facts.** The memory-framework consensus is that extraction is *"lossy by nature"* ([Coworker AI](https://coworker.ai/blog/mem0-vs-zep-vs-letta)) and the frameworks are rated on *facts*, never on voice.
**What *does* work: retrieval whose unit is a verbatim utterance and whose ranking signal is register.** `clone-chat` is the pattern: scenario-recalled real dialogue samples + a habits file + hybrid FTS5/vector ([clone-chat README](https://github.com/AFan4724/clone-chat)).

### 7.3 "Just fine-tune once, then it's them"
**Dead end alone, for two documented reasons.** ChatHaruhi: fine-tuning *"introduces new problems. In a preliminary experiment, we found that fine-tuned ChatBots produced more hallucinations"* — style goes up, factual grounding goes down, unless retrieval is kept alongside ([arXiv:2308.09597](https://arxiv.org/abs/2308.09597)). And WeClone's own README concedes **7B is "average"/一般 and 14B+ is where it gets good**, with quality dominated by model size and data volume ([WeClone README](https://github.com/xming521/WeClone)) — a local fine-tune of a small model is not a shortcut to a convincing clone.
**Also: fine-tuning is not a one-shot.** The projects that ship it expose epochs/rank/dropout as the primary quality knobs and warn that over-training is the failure mode; Chat-Style-Bot's troubleshooting is explicit — *"如果模型的回答开始天马行空，大概率是训练轮数太多导致过拟合，可以尝试使用训练轮数少一些的 checkpoint 加载模型"* (**rambling answers ⇒ too many epochs ⇒ load an earlier checkpoint**), and for style alignment it prescribes a **continuing preference-data loop** (DPO/KTO on human "sounds like / doesn't sound like" choices, collected live in WeChat: reply `1`/`2` to pick the better of two, or `不错`/`不好` on any reply) ([Chat-Style-Bot README](https://github.com/Chain-Mao/Chat-Style-Bot)).

### 7.4 "One giant global voice profile is enough"
**Dead end — falsified by construction.** The register is **audience-dependent**: `digital-twin-skill` exists specifically to emit per-relationship registers from the same corpus (`/{slug}-as-coworker`, `-as-partner`, `-as-family`) and states *"同一个人的分身，根据关系场景自动切换语气、用词和思维方式"* ([README](https://github.com/FredHJC/digital-twin-skill)); Second-Me lists *"Your AI self switches personas to represent you in different scenarios"* ([Second-Me README](https://github.com/mindverse/Second-Me)); CharacterGLM separates **attributes (content)** from **behaviour (style/tone)** ([EMNLP'24](https://aclanthology.org/2024.emnlp-industry.107.pdf)). **Weport has 184 sessions with 184 different people and currently collapses them into ONE language file.** That is arguably the single highest-leverage, lowest-risk defect in the whole system.

### 7.5 "The model will copy the retrieved lines"
**Dead end — and this one is counter-intuitive and verifiable.** RLHF-tuned models are trained *away* from reproducing their context: *"since these language models often face tasks like 'Give me m different options', 'Generate m titles', … the output of such language models tends to not repeat content from the context"* ([arXiv:2308.09597](https://doi.org/10.48550/arxiv.2308.09597)). So RAG-injected verbatim quotes get **paraphrased into assistant prose**, destroying the very signal they were retrieved for. The fix is an explicit prompt instruction licensing reuse, plus style reinforcement **after** the history — which is why Character Card V2 added the `post_history_instructions` slot ([spec_v2.md](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)).

### 7.6 "Style is easy to evaluate, so I'll just eyeball it"
**Half-myth.** Style fidelity is arguably *harder* to measure than facts: GPT-4-as-judge correlates poorly with human judgement *"especially for metrics with high subjectivity"*, and even trained annotators reached only moderate agreement ([CharacterGLM, EMNLP'24](https://aclanthology.org/2024.emnlp-industry.107.pdf)). ChatHaruhi's own quantitative section was still unfinished at publication ([arXiv:2308.09597](https://arxiv.org/abs/2308.09597)). **Practical consequence: Weport should ship a cheap, deterministic, *comparable* check rather than a vibe — e.g. is the clone's mean message length, message-count-per-turn distribution, punctuation rate, and sentence-final particle rate in the same range as the owner's?** Those are computable from `voice.jsonl` with no GPU and no judge model, and they will catch the "assistant register" regression mechanically. (The academic instrument for the harder question is in `02-academic.md`.)

### 7.7 "Bigger model fixes voice"
**Not supported, and partly contradicted.** CharacterGLM's headline wins are at **66B** while the open release is **6B** ([README](https://github.com/thu-coai/CharacterGLM-6B)); WeClone says 14B+ > 7B ([README](https://github.com/xming521/WeClone)). Both say **scale helps** — but neither says scale **substitutes for** a style mechanism. ChatHaruhi's finding is the sharpest version: *even with* retrieved imitation targets and a good prompt, *"the model's output is still influenced by the language model itself"* ([arXiv:2308.09597](https://arxiv.org/abs/2308.09597)). **Moving Weport from one hosted model to a bigger hosted model will change the accent, not fix the register.**

### 7.8 "The clone should never admit it is an AI" (a myth worth naming)
`digital-twin-skill` builds an explicit **runtime injection shield** and states *"Twin stays in character — never acknowledges being an AI"* ([README](https://github.com/FredHJC/digital-twin-skill)). That is a **product/ethics position, not a fidelity technique**, and the digital-afterlife literature argues the opposite direction: transparency about risks and capabilities, and *mutual consent* from the people who will talk to the clone ([*Philosophy & Technology* 2024](https://link.springer.com/content/pdf/10.1007/s13347-024-00744-w.pdf)). Also, OpenAI's policy requires person-simulations to be **labelled as simulated/parody** unless the person consented ([same paper](https://link.springer.com/content/pdf/10.1007/s13347-024-00744-w.pdf)). **Do not let "sounds more like him" be achieved by removing the disclosure.**

### 7.9 Also-not-a-solution, briefly
- **A knowledge graph of the person** (Zep/Graphiti-shaped): answers *what is true when*, has no representation of *how it is said* (§5).
- **A bigger lorebook / more retrieval slots**: the card ecosystem's own guidance is the reverse — trim, because everything competes for the same attention (§6.2.4).
- **Voice cloning / TTS** (WeClone's own roadmap includes 声音克隆): changes the *audio*, not the *wording* — and Weport has no local GPU. Out of scope.
- **Re-training the base model on the person's prose** (Chat-Style-Bot's "celebrity prose dataset" mode): works for authors with books; a WeChat log is not prose (§7.3, and `02-academic.md` on genre).
- **Web/客户端 auto-reply injection** (Chat-Style-Bot, WeClone-adjacent WeChat bridges, `itchat` patching): fragile, version-specific, account-ban risk (*"建议使用微信小号扫码登录"*), and **explicitly forbidden by Weport's own AGENTS.md** (read-only, no send transport). Confirmed as a dead end for *this* product, not as a technique.

---

## 8. Synthesis: what the landscape says Weport should change

Ordered by **evidence strength × leverage × compatibility with Weport's no-Python / no-GPU / local-first constraints**. Nothing here requires a GPU; the two starred items are the ones the evidence is strongest on.

### 8.1 \*\* Separate STYLE from FACTS as two artefacts with two retrieval objectives
Every serious system in this survey separates them, from four independent directions: CharacterGLM (**属性** affect content, **行为** affect style/tone, [EMNLP'24](https://aclanthology.org/2024.emnlp-industry.107.pdf)); Character Card V2 (**persona fields** vs the retrievable **`character_book`**, [spec](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)); `digital-twin-skill` (**Core** identity vs per-audience **Facets**, [README](https://github.com/FredHJC/digital-twin-skill)); `ex-skill` (**Persona** decides *how*, **Memory** supplies *what*, [README](https://github.com/therealXiaomanChu/ex-skill)). Weport has one 5-file summary doing both, and a BM25 index ranked for facts.

### 8.2 \*\* Retrieve VERBATIM utterances for style, and rank them by register — not relevance
The strongest single mechanic found (SillyTavern, §5.1): **summaries may build the retrieval key, but the injected payload is the raw message** — *"the original message is retrieved from chat history and shuffled into context"* ([docs](https://docs.sillytavern.app/extensions/chat-vectorization/)). ChatHaruhi ranks by **emotion/scene** because the retrieved item is meant to be *imitated*. Weport's chunk unit is ~1.1 KB (multi-message), so a single utterance can never be retrieved alone — and `voice.jsonl` (~4,600 lines of his *own* messages) is the right corpus for a second, **style-scored** index. Predict: a small set of **verbatim** replies to structurally similar incoming messages beats any amount of prose description.

### 8.3 \*\* Treat `voice.jsonl` as training targets, not only as a retrieval corpus
Every fine-tuning project in the survey uses exactly this split — partners' messages as **user**, the target's own messages as **assistant** ([whatsapp-ai-clone](https://github.com/kinggongzilla/whatsapp-ai-clone), [whatsapp-clone-ai](https://github.com/jordankzf/whatsapp-clone-ai), [WeClone](https://github.com/xming521/WeClone), [Chat-Style-Bot](https://github.com/Chain-Mao/Chat-Style-Bot)). Weport has the artefact already. **The no-GPU objection is weaker than it looks:** a quantised GGUF persona serves on CPU at **~10 tok/s** (as reported by the whatsapp-clone-ai README), and cloud LoRA training on a rented GPU is ~$1-scale for a 9B LoRA. **What is genuinely hard is corpus and eval quality, not compute.**

### 8.4 \*\* Model the BEHAVIOURAL layer: whether to reply, burst count, latency, sticker, segmentation
`clone-chat`'s pipeline is explicit — *"decide message type, order, delay, and whether to reply at all → validate the reply plan"* — with a `data/habits.json` holding *"文字/表情/语音比例、连发数量、回复延迟、活跃时段、高频短句"* ([README](https://github.com/AFan4724/clone-chat)). Real texting is **three bubbles, two characters each, 40 seconds late**. No amount of fact-summary produces that. The Chinese practitioner's two-layer proposal (§6.3) is the same idea: a **disposition layer** decides *"我会直接回答、反问、吐槽，还是回避"* — including the **choice not to answer**.

### 8.5 \*\* Condition the clone on WHO IS ASKING (relationship register)
Restated four ways in this document (§7.4, §6.3 point 1, §2.5's five-layer persona, §2.3's `/{slug}-as-*`). Weport has **184 sessions**, i.e. the audience label is already in the data. This is the highest-leverage change that needs **no model change at all** — separate the language artefact per relationship cluster, or at minimum inject the current audience's cluster.

### 8.6 Add copy-licensing and post-history style reinforcement to the prompt
Two verifiable, near-free fixes: (a) **explicitly licence the model to reuse the retrieved verbatim lines** — RLHF models are trained *away* from echoing context ([ChatHaruhi paper](https://doi.org/10.48550/arxiv.2308.09597)); (b) **repeat the style anchors after the history**, not only before it ([ChatHaruhi paper](https://doi.org/10.48550/arxiv.2308.09597); Character Card V2's `post_history_instructions`, [spec](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)). Also add WeClone's `identity.json`-style **name/author tags** so the model knows who "I" is ([WeClone](https://github.com/xming521/WeClone)).

### 8.7 \*\* Shrink and de-prose the persona block; add `mes_example`-style real exchanges
The card ecosystem's guidance is the reverse of Weport's instinct: **"specific, consistent, and lean"**, and *"Example messages are the most direct way to fix a voice"* ([TavernSprite](https://tavernsprite.com/blog/sillytavern-character-card-best-practices/)). Character.AI's own recommendation is **90–150 words** with longer personas *deprioritized* (§6.4). **Move the description OUT of the always-resident block and into retrievable facts; put real exchanges in.**

### 8.8 Add a held-out style eval, and make it computable without a judge model
Every fine-tuning project holds out a split with **early stopping** to prevent memorisation ([whatsapp-clone-ai](https://github.com/jordankzf/whatsapp-clone-ai)); the practitioner's self-judged 100-question test is exactly the biased eval he then criticises (§6.3); CharacterGLM shows LLM-as-judge correlates poorly with humans on subjective style metrics ([EMNLP'24](https://aclanthology.org/2024.emnlp-industry.107.pdf)). **Cheap and deterministic: mean message length, messages-per-turn distribution, punctuation rate, sentence-final particle rate, emoji/sticker rate, burst length.** All computable from `voice.jsonl` on a laptop, all comparable against the real corpus, and all will catch an assistant-register regression. `personal.ai`'s advertised **"Personal Score"** proves the market expects a scored style surface ([docs](https://docs.personal.ai/documentation/getting-started/introduction)).

### 8.9 Respect the prefix-cache tradeoff when adding dynamic retrieval
See §5.2 — *"you have to choose one or the other, but not both"* ([SillyTavern docs](https://docs.sillytavern.app/extensions/chat-vectorization/)). Weport has a documented cache discipline; injected retrieval whose **order** varies per turn will silently invalidate the cached prefix.

### 8.10 Product and ethics controls to add while doing the above
- **Label the artefact as a simulation** — OpenAI's policy requires person-simulations to be *"clearly labeled as 'simulated' or 'parody'"* absent the person's consent ([*Philosophy & Technology* 2024](https://link.springer.com/content/pdf/10.1007/s13347-024-00744-w.pdf)). Self-cloning makes consent easy; **the friends who get talked to have not consented** — `digital-twin-skill`'s **mutual consent** framing applies (§6.2.5).
- **Give the owner a "retire"/delete path and versioned, regenerable persona artefacts** — `ex-skill` ships `/ex-rollback`, `/delete-ex`, `/let-go` ([README](https://github.com/therealXiaomanChu/ex-skill)).
- **Say in the product what the clone is not** — *"这个 Skill 只是你记忆中的ta"* ([ex-skill](https://github.com/therealXiaomanChu/ex-skill)); *"它仍然不是一个真正可靠的'人格副本'，而只是一个基于已有数据进行近似模拟的语言模型"* ([kukusuyi](https://www.cnblogs.com/kukusuyi/p/20166103)); *"数字人真正困难的地方…"* (same).
- **A base-model upgrade will silently change the clone's humour and vocabulary** — the digital-afterlife literature's core warning, and it applies to a DeepSeek-version bump ([The Independent](https://www.independent.co.uk/life-style/ai-death-grief-bots-b3027331.html)). Pin the model version, or re-run the style eval on upgrade.

### 8.11 The one-line answer to "why doesn't it sound like him?"
**Because Weport is doing exactly what the field's own post-mortems identify as the failure mode: it compresses the person into a description, retrieves by relevance rather than register, injects the compression rather than the verbatim utterances, models no behaviour, and conditions on no audience.** The corpus is not the problem — 104k messages / 184 sessions is *more* than most of these projects get. **The representation is.** The cheapest high-confidence first move is 8.2 + 8.7 (verbatim style retrieval + a lean example-driven persona block); the highest-ceiling move is 8.3 (treat `voice.jsonl` as training data).

---

## Sources

Every URL cited in this document, grouped by the section that cites it. Star/fork counts are **point-in-time snapshots** taken during this session's searches, not live values.

### §1 WeClone
- https://github.com/xming521/WeClone
- https://github.com/xming521/WeClone/blob/master/README.md
- https://gitee.com/xming521/WeClone
- https://www.weclone.love/zh/docs/introduce/what-is-weclone.html
- https://docs.weclone.love/zh/docs/introduce/FAQ.html
- https://www.weclone.love/zh/docs/introduce/FAQ.html
- https://github.com/a4471174/WeClone

### §2 WeChat-native style-cloning projects
- https://github.com/Chain-Mao/Chat-Style-Bot
- https://github.com/AFan4724/clone-chat
- https://github.com/FredHJC/digital-twin-skill
- https://github.com/therealXiaomanChu/ex-skill
- https://agentskills.io

### §3 Academic / open role-play systems
- https://github.com/LC1332/Chat-Haruhi-Suzumiya
- https://github.com/LC1332/Chat-Haruhi-Suzumiya/blob/main/README_EN.md
- https://doi.org/10.48550/arxiv.2308.09597
- https://arxiv.org/abs/2308.09597
- https://arxiv.org/pdf/2308.09597.pdf
- https://huggingface.co/datasets/silk-road/ChatHaruhi-54K-Role-Playing-Dialogue
- https://github.com/thu-coai/CharacterGLM-6B
- https://aclanthology.org/2024.emnlp-industry.107/
- https://aclanthology.org/2024.emnlp-industry.107.pdf
- https://arxiv.org/abs/2311.16832
- https://github.com/mindverse/Second-Me
- https://home.second.me/
- https://site.second-me.cn/

### §3.5 WhatsApp / iMessage fine-tune family
- https://github.com/jordankzf/whatsapp-clone-ai
- https://github.com/kinggongzilla/whatsapp-ai-clone
- https://github.com/

### §4 Commercial companion / digital-afterlife products
- https://www.independent.co.uk/life-style/ai-death-grief-bots-b3027331.html
- https://link.springer.com/content/pdf/10.1007/s13347-024-00744-w.pdf
- https://hollo.ai/
- https://www.personal.ai/products
- https://docs.personal.ai/documentation/getting-started/introduction
- https://apps.apple.com/cn/app/%E6%98%9F%E9%87%8E-%E6%89%80%E5%BB%BA%E7%9A%86%E4%BD%A0%E6%89%80ai/id6463076337?l=en-GB
- https://apps.apple.com/cn/app/%E7%8C%AB%E7%AE%B1-%E5%92%8C%E5%BF%83%E5%8A%A8-ai-%E6%8E%A2%E7%B4%A2%E5%89%A7%E6%83%85%E5%AE%87%E5%AE%99/id6475000292
- https://aiproducthub.cn/sites/bytedance-maoxiang-ai-emotional-companion.html
- https://www.sensetime.com/
- https://apps.apple.com/us/app/clone-create-your-ai-clone/id6757676760

### §5 Memory / agent frameworks, and SillyTavern mechanics
- https://plur.ai/blog/mem0-vs-letta-vs-zep/
- https://coworker.ai/blog/mem0-vs-zep-vs-letta
- https://docs.sillytavern.app/extensions/chat-vectorization/
- https://docs.sillytavern.app/extensions/summarize/
- https://deepwiki.com/SillyTavern/SillyTavern/6.3-vector-storage-and-rag-system
- https://deepwiki.com/SillyTavern/SillyTavern/6-context-and-memory-systems

### §6 Failure evidence
- https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md
- https://github.com/SillyTavern/SillyTavern/blob/626b324f/src/types/spec-v2.d.ts
- https://tavernsprite.com/blog/sillytavern-character-card-best-practices/
- https://blog.mini-tavern.com/blog/sillytavern-character-card-troubleshooting-fix-common-errors-and-improve-ai-resp-74982f
- https://www.cnblogs.com/kukusuyi/p/20166103
- https://www.memorylake.ai/en/blogs/character-ai-forgets-persona
- https://dev.to/kinthai/why-characterai-forgets-you-and-what-persistent-memory-actually-requires-1b23
- https://medium.com/@chuckmellisa/character-ai-is-becoming-unusable-8dd35b960
- https://chatbrat.ai/bratlog/does-character-ai-remember-your-conversations
- https://plur.ai/blog/mem0-vs-letta-vs-zep/

### Searched but NOT usable as evidence (recorded so they are not re-searched)
- `https://www.zhihu.com/` — the Zhihu question *"小白第一次微调LLM，为什么感觉模型完全没有学到我的数据？"* ("first time fine-tuning an LLM — why does it feel like the model learned nothing from my data?") surfaced in search, but the page returned only a **login wall** and no content. The question **title itself** is on-topic evidence that this is a common beginner experience, but **no answer content was retrievable → UNVERIFIED, not cited as a source.**
- Two further search batches (`SillyTavern vector storage summarization extension how it works`, `Hacker News digital twin chat history clone yourself discussion`, `roleplay LLM "assistant voice" leaks out of character style RLHF`, `RAG vs fine-tuning style imitation which works better LLM personal voice`, `WeClone 好用吗 效果 实测 评价 数字分身`, `Generative Agents reflection summary drift persona consistency problem paper`) **failed at the search backend** (`TypeError: fetch failed`) and returned no results. **The absence of HN/Reddit-specific quotes and of the Generative Agents reflection-drift paper in this document is a tool failure, not a finding of absence** — those leads remain open.
- `https://github.com/mtcto/weclone` — a WeClone mirror; the fetch returned GitHub's generic landing text, so **no stars/activity could be captured → UNVERIFIED.**
- `xming521/WeClone` star/fork/open-issue counts (18,133 / 1,526 / 36) and `mindverse/Second-Me` counts (15,652 / 1,216 / 144) come from search-result metadata for those repos **during this session** — snapshots, and **not** re-verified by an independent fetch.

---

## Meta: what this document did NOT establish

Stated explicitly so the parent does not over-read it:

1. **No measured style-fidelity result for any WeChat-persona project exists in this survey.** The only numbers found are self-reported and weakly controlled: WeClone's model-size ladder (**7B 一般 / 14B 及格 / 32B 较好**, [FAQ](https://docs.weclone.love/zh/docs/introduce/FAQ.html)) and kukusuyi's **~90/100 self-judged "fairly consistent"** on 100 auto-generated questions with a Qwen-14B LoRA ([cnblogs](https://www.cnblogs.com/kukusuyi/p/20166103)). **Both are testimony, not measurement.** ChatHaruhi's own quantitative section was still unfinished at publication.
2. **No project publishes a catchphrase-overfit rate, a persona-drift curve, or a style-fidelity benchmark.** The field optimises a smell test.
3. **The `WeClone` licence question is answered only negatively:** the public repo is **AGPL-3.0** and open as of this session; **I found no evidence of relicensing to closed source.** Whether a separate commercial/cloud product exists behind `weclone.love` is **UNVERIFIED** (the README's own commercial disclaimer suggests one is anticipated).
4. **No iMessage-specific cloning project was found** in this session beyond the generic fine-tune recipes; the task brief's mention of iMessage is covered only by the screenshot path in `digital-twin-skill` and by the WhatsApp family. **Marked as an open lead, not a finding.**
5. **`微博 明星分身` and `他她它` were not verified from any primary source.** Listed in §4.1 as UNVERIFIED for completeness only.
6. **Star counts are snapshots and were not re-verified** (see above). Do not quote them as current.
7. **The character-card "ecosystem" sources are third-party SEO blogs** (TavernSprite, MiniTavern, MemoryLake, ChatBrat), several of which **sell competing products**. Their *mechanism* claims are consistent across sources and consistent with the peer-reviewed papers; their *advice* and *products* are marketing. Where I leaned on them I said so inline.
8. **The strongest evidence in this document is negative evidence** — what fails, in the words of the projects that tried it. That is a real and useful result for Weport, and it should not be upgraded into "the following five techniques are proven to work".
