# 04 — Context Engineering & Long-Term Memory Architectures for a Large Personal Corpus

**Scope.** This document surveys the best-known ways to retain faithful, queryable, high-fidelity
memory of a ~1M-token personal chat corpus (`~104,000` messages, `21,201` chunks, `184` partners,
6 months) on a **local-first Electron + TypeScript app with no GPU and one hosted LLM API**, and
specifies a concrete replacement for the current "LLM-summarise the whole corpus into 5 markdown
files, prepend them to the system prompt, plus BM25 over a handful of chunks" design.

**Method.** ~64 distinct search queries were run and 25+ primary sources were opened (papers,
repos, vendor docs, engineering posts). Every factual claim below carries a URL. Where a number
comes from a secondary source, an unrefereed preprint server, or a vendor's own marketing
benchmark, it is labelled. Nothing is presented as verified when it is not: uncontrolled claims
are marked **UNVERIFIED**.

**Scope limits that matter for reading the rest.** Almost none of the systems below were built for
"clone one person's voice from their own chat history". They were built for *task memory* (what
does the user want, what did we already do, what is true now). Voice fidelity is a different
objective with a different evidence base (stylometry + in-context demonstration selection), and
§6.4 argues it is the part the current design gets most wrong. Keep that distinction in mind: a
memory architecture that maximises LongMemEval accuracy can still produce a generic voice.

---

## 0. The current Weport/WeClone design, stated precisely

From the repository docs and code these are the measured facts this document is written against
(local evidence, cited by file path — no URL):

| Fact | Value | Source |
|---|---|---|
| Corpus size | ~104,000 messages, ~1M tokens, 21,201 chunks, 184 partners, 6 months | task brief + `AGENTS.md` (WeClone retrieval section) |
| Corpus on disk | 22.4 MB JSONL (`chunks.jsonl`) | `AGENTS.md` |
| Persona artefact | 5 markdown files (profile / relationships / knowledge / timeline / language) | `AGENTS.md` ("WeClone 生成管线") |
| Persona artefact size | **24.7k characters** measured for the real clone | `AGENTS.md` ("Retrieval is **local BM25** … measured: 24.7 k characters") |
| Hard prompt budget | 180,000 characters | task brief |
| Retrieval | local BM25 over `chunks.jsonl`, no embeddings | `electron/services/ai/localRetrieval.ts`, `AGENTS.md` |
| Retrieval latency (before the includes-prefilter) | 1.4–2.8 s per turn; after prefilter 334–929 ms | `AGENTS.md` ("WeClone retrieval is a prefilter pass") |
| Generation pipeline | map-reduce over segments (v1.0.1); v1.0 was a random 250-chunk sample (0.5‰ of corpus) | `docs/agents/weclone.md` |
| Prefix cache discipline | append-only history; `prefixCache.ts` owns frame comparison with DSH ratios 0.8 trigger / 0.16 retain | `AGENTS.md` ("Agent Harness Invariants") |

### 0.1 Four independent failure modes, only one of which is "summarisation is lossy"

The owner's complaint — *"this is a summary, and the agent talks based on that summary"* — is
correct but under-specified. There are four separable defects, and they need different fixes:

1. **Irreversible compression at write time.** The corpus is transformed *once*, by an LLM, into
   prose, and the raw text is then only reachable through a keyword search that returns a handful
   of chunks. Nothing in the pipeline can recover a detail that the summariser judged unimportant.
   This is the defect the literature calls out directly: "summary based methods … fall behind
   turn-level or session-level baselines … likely due to the loss of crucial details during the
   process of converting dialogues into summaries" ([SECOM, ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/file/e56f394bbd4f0ec81393d767caa5a31b-Paper-Conference.pdf),
   [arXiv:2502.05589](https://arxiv.org/html/2502.05589)).
2. **Cascade (summary-of-summary).** Map-reduce over ~1800 segments, then 5 MDs written *from*
   those intermediate summaries, is exactly the multi-pass roll-up that loses precision
   monotonically — "precision degrades toward approximation … after three cycles the constraint has
   semantically reversed" ([tianpan.co, "Context Compression Artifacts"](https://tianpan.co/blog/2026/05/05/context-compression-artifacts-summarization-information-loss))
   — and "the published tells are familiar: … over very long conversations the summary might drift
   from the original intent or lose important foundational context" ([tianpan.co, "The Summary Tax"](https://tianpan.co/blog/2026-05-09-summary-tax-compaction-eats-more-tokens-than-it-saves)).
   *(Both are unrefereed engineering blog posts; treat as practitioner testimony, not measurement.)*
3. **No provenance.** A sentence like "性格开朗、喜欢打游戏" (the owner's own quoted complaint about
   the v1.0 output, `docs/agents/weclone.md`) cannot be traced to the 12 messages that produced it,
   cannot be contradicted, and cannot be re-derived when the model improves.
4. **A static, prose-only prefix.** Persona is asserted as *description* rather than demonstrated as
   *behaviour*. §6.4 is the evidence that this is the specific reason a clone sounds generic.

A fix that only addresses (1) — e.g. better summarisation prompts — will still produce a generic
voice, because (4) is not a compression problem at all.

---

## 1. Memory architectures for LLM agents

### 1.1 Comparison table

| System | Representation | Ingestion cost | Retrieval | Strength | Main failure mode | Licence | TS + local files only? |
|---|---|---|---|---|---|---|---|
| **MemGPT / Letta** | OS paging: *main context* (system instructions + working context + FIFO queue) vs *external context* (recall = message DB, archival = vector DB) | 1 LLM call per memory edit (self-directed function calls) | LLM issues `search` function calls → paged results | Self-editing memory, multi-session coherence; the origin of "memory blocks" | Memory edits compete with the actual task in one agent; incremental edits "become messy and disorganized over time" (Letta) | Apache-2.0 ([letta](https://github.com/letta-ai/letta)) | Partially — the *data model* yes (SQLite + a local index), the *agent loop* no (needs tool calling every turn) |
| **Mem0** | Extracted salient facts from user↔assistant **message pairs**, stored as text + embedding + metadata | 1 LLM extraction + 1 update/consolidation per pair | dense retrieval over memories (top-k) | Cheap, low latency; 91% lower p95 latency and >90% token savings vs full context on LoCoMo ([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)) | Extraction LLM decides what matters — the *same* lossy judgement, just at fact granularity; benchmark numbers disputed (§1.11) | Apache-2.0 ([mem0](https://github.com/mem0ai/mem0)) | Yes for storage/read; the extraction needs an LLM |
| **Mem0ᵍ** | directed labelled graph `G=(V,E,L)`, entities as nodes, relations as edges; entity similarity threshold `t` for merge | +1 LLM call per triplet extraction + node resolution | entity-centric subgraph walk **or** semantic triplet similarity | relational/temporal questions; ~2% overall over base Mem0 | graph build cost and drift; edge extraction hallucinations | Apache-2.0 | Yes with SQLite as the graph store |
| **Zep / Graphiti** | **bi-temporal** property graph, 3 tiers: episode subgraph → semantic entity subgraph → community subgraph | LLM entity/edge extraction per episode, plus contradiction resolution | hybrid semantic + BM25 + graph traversal; returns top-20 edges + entity summaries | non-lossy history: contradicting facts are *invalidated*, never deleted; DMR 94.8% vs MemGPT 93.4%; LongMemEval up to +18.5% accuracy, −90% latency ([arXiv:2501.13956](https://arxiv.org/pdf/2501.13956)) | heavyweight; needs a graph DB in the standard deployment; LLM cost per episode | Apache-2.0 ([graphiti](https://github.com/getzep/graphiti)) | Yes, if you accept SQLite tables + recursive CTEs instead of Neo4j/FalkorDB |
| **Cognee** | graph-vector hybrid: relational store (docs/chunks/provenance) + graph store + vector store; ECL pipeline (`extract → cognify → load`), 6-stage cognify, plus `memify` refinement | 6-stage batch pipeline; "only new or updated files are processed on re-runs" | 14 retrieval modes (graph completion, CoT graph traversal, chunks, chunks-lexical, summaries, temporal, …) | defaults are all embedded/file-based (SQLite + LanceDB + Ladybug) — a genuinely local-first shape | pipeline complexity; LLM extraction at scale | open source ([cognee](https://github.com/topoteretes/cognee/)) | Yes for the storage shape; the pipeline is Python |
| **A-MEM** | Zettelkasten atomic notes `m_i = (c_i, t_i, K_i, G_i, e_i, L_i)` — context description, timestamp, keywords, tags, embedding, links | per note: 1 LLM note-construction + 1 embedding + 1 LLM link decision over nearest neighbours + *memory evolution* edits to neighbours | embedding similarity, then **linked notes are pulled in too** ("box") | closest published model to "atomic, addressable, linked memory"; explicitly anti-summary | "heavy, multi-step link generation inflates latency and error accumulation" (MemoryOS's own critique, [arXiv:2506.06326](https://arxiv.org/html/2506.06326)); O(N) LLM calls | MIT-style open source ([arXiv:2502.12110](https://arxiv.org/html/2502.12110)) | Yes as a schema; the LLM link step is the cost |
| **MemoryBank** | memory storage + retriever + updater; Ebbinghaus decay `R = e^{-t/S}`, `S` init 1, `+1` and `t→0` on recall | 1 summary + 1 importance/emotion per event | similarity search over the surviving store | forgetting curve makes storage self-pruning | deliberately forgets; bad for a *personal archive* whose whole point is recall | open source ([MemoryBank-SiliconFriend](https://github.com/zhongwanjun/MemoryBank-SiliconFriend)) | Yes, trivially (it is arithmetic) |
| **Generative Agents (Stanford)** | memory *stream* of observation objects `(description, creation_ts, last_access_ts)` + reflections + plans | 1 importance score per observation (`1..10`), periodic reflection over the 100 most recent records | `score = α1·recency + α2·importance + α3·relevance`, all `α=1`; recency = exponential decay **0.995**; relevance = cosine sim | the cleanest published *retrieval policy*; reflection creates higher-level memory | flat stream; reflection is itself LLM summarisation | open research code | Yes — fully implementable in TS with local files |
| **MemoryOS** | 3 tiers: Short-Term (STM) / Mid-Term (MTM) / Long-Term Personal (LPM); STM→MTM by dialogue-chain FIFO, MTM→LPM by segmented paging + **heat** | segmentation + summarisation per segment; heat updates | two-stage: segment-level then page-level, plus persona from LPM | hierarchical + persona in one design; +49.11% F1 / +46.18% BLEU-1 over baselines on LoCoMo with GPT-4o-mini | requires the LLM to summarise each segment (lossy layer by construction) | open source ([BAI-LAB/MemoryOS](https://github.com/BAI-LAB/MemoryOS)) | Yes |
| **Sleep-time compute (Letta)** | a second agent that rewrites the primary agent's memory blocks *offline* | offline LLM passes, amortised | primary agent reads the pre-rewritten memory | ~5× less test-time compute at equal accuracy; up to +13%/+18% accuracy from scaling sleep-time; 2.5× cheaper per query when amortised over ~10 queries/context ([arXiv:2504.13171](https://arxiv.org/html/2504.13171v1), [Letta blog](https://www.letta.com/blog/sleep-time-compute/)) | useless when queries are unpredictable (they measure exactly that correlation) | Apache-2.0 (Letta) | Yes — it is "do the expensive pass nightly" |

### 1.2 MemGPT / Letta — the paging model, in its own terms

MemGPT's contribution is not "memory", it is **virtual context management**: `main context`
(prompt tokens: read-only system instructions, a read-write *working context*, and a FIFO queue of
messages) versus `external context` (`archival storage` and `recall storage`), with the LLM moving
data between tiers through function calls. Working context is "a fixed-size read/write block of
unstructured text, writeable only via MemGPT function calls … intended to be used to store key
facts, preferences, and other important information about the user **and the persona the agent is
adopting**", and the FIFO queue holds a rolling window of the conversation. Memory edits are
entirely self-directed: "MemGPT autonomously updates and searches through its own memory based on
the current context", driven by a system prompt that documents the hierarchy plus function schemas
([MemGPT, arXiv:2310.08560](https://arxiv.org/abs/2310.08560)).

Two implementation details matter for us:

* **Token-pressure awareness is load-bearing.** MemGPT "prompts the processor with warnings
  regarding token limitations" and paginates retrieval results so a search cannot overflow the
  window. Any read path we build needs the same: a hard character budget per retrieval call, not a
  `topK` that happens to fit.
* **The design has an admitted weakness.** Letta's own successor design says memory management,
  conversation and tools bundled into one agent makes it "slower (if it has to call memory
  operations during conversation) and potentially less reliable"; the fix is a separate *sleep-time*
  agent that owns the core-memory blocks. Memory formation in MemGPT "is incremental, so memories
  may become messy and disorganized over time" ([Letta, sleep-time compute](https://www.letta.com/blog/sleep-time-compute/)).
  **This is the single most transferable idea in this whole survey for our use case:** the expensive
  memory-writing pass belongs offline, not in the chat turn.
* Letta ships core memory as **memory blocks** with an explicit API surface
  (`/agents/{id}/blocks`, attach/detach, per-block update) and a documented `context hierarchy`
  (memory blocks → archival memory → recall), i.e. a concrete schema we can copy
  ([Letta memory blocks docs](https://docs.letta.com/v1-sdk/memory/memory-blocks/),
  [Letta docs index](https://docs.letta.com/)).

### 1.3 Mem0 / Mem0ᵍ

Mem0 processes "a pair of messages between either two user participants or a user and an assistant"
through dedicated extraction and update modules; Mem0ᵍ stores "directed labeled graphs with entities
as nodes and relationships as edges", with relationship labels like `lives_in`, `prefers`, `owns`,
`happened_on`. Node resolution uses embedding similarity above a threshold `t` to decide
create/create-one/reuse. Retrieval in Mem0ᵍ is dual: an **entity-centric** path (find anchor nodes
by similarity, walk in/out edges, build a subgraph) and a **semantic triplet** path (encode the
query, match against text encodings of triplets, threshold on similarity)
([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)).

Reported wins: 26% relative improvement over OpenAI's memory on an LLM-as-judge metric; Mem0ᵍ ~2%
higher overall than base Mem0; 5% / 11% / 7% relative over the best prior method on single-hop,
temporal, and multi-hop respectively; 91% lower p95 latency and >90% token savings vs full-context.
**Treat all of these as vendor-authored and contested** — see §1.11.

**Applicability judgement.** Mem0's *unit of memory* is a fact about the user, extracted by an LLM
from a two-message window. For a persona clone, that is exactly the transformation that flattens
voice: "他喜欢打游戏" is a Mem0-style fact; `"gonopoly 肝到现在"` is the memory that carries
personality. Mem0's extraction step is the wrong primitive for us; its **retrieval and dedup
machinery** (fact store + embedding + metadata + consolidation) is the right shape.

### 1.4 Zep / Graphiti — bi-temporal edges and non-destructive contradiction handling

This is the architecture to steal from, because it is the only widely-documented one whose stated
design goal is *never losing history*. Graphiti models **valid time** (when a fact was true in the
world) separately from **transaction time** (when the system learned it):

```python
class EntityEdge(Edge):
    valid_at:   datetime | None   # when the fact became true
    invalid_at: datetime | None   # when it stopped being true
    created_at: datetime          # when the edge was created
    expired_at: datetime | None   # when it was superseded/invalidated
```

When new information contradicts an existing edge, the LLM resolves it during edge operations:
the old edge gets `invalid_at ← new fact's valid_at` and `expired_at ← now`, and a **new** edge is
created — "temporal edge invalidation rather than deletion, preserving the complete history of what
the system knew and when". A point-in-time query is then
`valid_at <= T AND (invalid_at > T OR invalid_at IS NULL)`
([Graphiti bi-temporal model](https://getzep-graphiti.mintlify.app/concepts/temporal-model),
[mirror](https://mintlify.wiki/getzep/graphiti/concepts/temporal-model)).

Zep's own evaluation: DMR 94.8% vs MemGPT's 93.4%; on LongMemEval (average conversation context
**115,000 tokens**) "accuracy improvements of up to 18.5% while simultaneously reducing response
latency by 90%". Their retrieval uses the **20 most relevant edges** plus entity nodes, reformatted
into a context string ([arXiv:2501.13956](https://arxiv.org/pdf/2501.13956)). Note the shape of that
number: the whole 115k-token history collapses into ~20 facts *for a factual question*. That is
correct for "what did the user say their job was" and wrong for "say something the way they would".

### 1.5 Cognee — the local-first storage shape

Cognee's pipeline is `add → cognify → memify → search`; `cognify` is a six-stage pass (classify
documents, check permissions, extract chunks, LLM entity/relationship extraction, generate
summaries, embed + commit edges), and only new or updated files are processed on re-runs. `memify`
refines the graph afterwards — "prunes stale nodes, strengthens frequent connections, reweights
edges based on usage signals, and adds derived facts". Storage layers and defaults are directly
relevant: **relational = SQLite** (documents, chunks, **provenance tracking**), **vector = LanceDB**,
**graph = Ladybug (embedded)**. It ships 14 retrieval modes including `CHUNKS` (raw passage
retrieval) and `CHUNKS_LEXICAL` (token-based lexical search), `SUMMARIES`, and `TEMPORAL`
([cognee architecture](https://www.cognee.ai/how-cognee-builds-ai-memory),
[repo](https://github.com/topoteretes/cognee/)).

Its self-reported benchmark (BEAM long-context benchmark: 0.79 at 100K tokens vs 0.735 previous SOTA;
0.67 vs 0.641 at 10M) is explicitly caveated by the authors as "a directional signal rather than a
definitive measure" — quote it as vendor-reported, not as evidence.

The **provenance column in the relational store** is the part to copy: every derived artefact must
carry a pointer to the rows it came from.

### 1.6 A-MEM — atomic, addressable, linked notes

Each memory note is `m_i = (c_i, t_i, K_i, G_i, e_i, L_i)`: LLM-generated contextual description,
timestamp, keywords, tags, embedding, and links. Link generation is two-stage — embedding similarity
retrieval as a filter, then an LLM deciding whether a connection exists — and, crucially, **memory
evolution**: adding a note "can trigger updates to the contextual representations and attributes of
existing historical memories" ([arXiv:2502.12110](https://arxiv.org/html/2502.12110)).

Directly relevant properties: notes are **individually addressable and atomic**, so nothing is
destroyed by linking; the link set gives "boxes" that are retrieved transitively; and the evolution
step is what makes the store improve over time rather than merely grow. The cost is the reason
MemoryOS criticises it — per-note LLM calls for link generation and an error term that accumulates.
**For us, take the schema and drop the per-note LLM call**: use FTS5/dense similarity for links,
and make the LLM link pass an optional nightly pass over *new* nodes only (the same amortisation
Cognee uses with `memify`).

### 1.7 MemoryBank — the forgetting curve, and why we should not use it

`R = e^{-t/S}` with `S` initialised to 1 and incremented by 1 (with `t` reset to 0) each time the
memory is recalled; the paper spells out the three modelled rules as rate-of-forgetting, time and
memory decay, and the spacing effect ([MemoryBank, arXiv:2305.10250](https://arxiv.org/abs/2305.10250v3),
[AAAI 2024](https://ojs.aaai.org/index.php/AAAI/article/view/29946)).

For a *companion* this is defensible. For an *archive of a person's own messages* it is the exact
opposite of the requirement: the owner's complaint is that too much has been forgotten, not too
little. Use the decay function only as a **ranking prior** (a mild recency term inside retrieval
scoring, as Generative Agents does), never as an eviction policy on the raw layer.

### 1.8 Generative Agents — the retrieval formula to copy verbatim

The memory stream is "a list of memory objects, where each object contains a natural language
description, a creation timestamp, and a most recent access timestamp". Retrieval combines three
normalised terms:

```
retrieval_score = α1 · recency + α2 · importance + α3 · relevance     (all α = 1 in the paper)
recency      = exponential decay over hours since last retrieval, decay factor 0.995
importance   = LLM integer 1..10 emitted at creation time
relevance    = cosine similarity between embeddings of memory and query
```

Everything is min-max normalised to `[0,1]` before weighting, and the top-ranked memories that fit
the context window are included (the paper is explicit that the budget is a *window-fit* test, not a
fixed `k`). The authors also give the reason we should not just concatenate a summary: "Summarizing
all of Isabella's experiences to fit in the limited context window … produces an uninformative
response … Instead of summarizing, the memory stream … surfaces relevant memories, resulting in a
more informative and specific response that mentions her passion for making people feel welcome"
([Generative Agents](https://3dvar.com/Park2023Generative.pdf),
[Stanford CS222 lecture slides](https://joonspk-research.github.io/cs222-fall24/static_dir/pdf/StanfordCS222_Lecture5.pdf)).

**That paragraph is, word for word, a description of the owner's complaint.** The 2023 Stanford
paper already contains the diagnosis and the fix: *stop summarising, start surfacing*.

### 1.9 MemoryOS — hierarchical tiers with heat-based paging

Four modules (Storage / Updating / Retrieval / Generation) over three tiers. STM→MTM promotion is
dialogue-chain FIFO; MTM→LPM promotion uses "a segmented page organization strategy" with
**heat-based replacement**; retrieval is two-stage in MTM (semantic segment selection, then page
retrieval) and adds LPM persona attributes plus STM context into the final prompt
([arXiv:2506.06326](https://arxiv.org/html/2506.06326), [repo](https://github.com/BAI-LAB/MemoryOS)).
Reported: +49.11% F1 / +46.18% BLEU-1 on LoCoMo with GPT-4o-mini.

For us the useful parts are (a) **heat** as a ranking signal (a memory that keeps being useful
should rank higher — the same idea as A-MEM's link reinforcement and Cognee's `memify`), and (b) the
**two-stage segment→page retrieval**, which is the memory analogue of SECOM's segment granularity
(§3.3).

### 1.10 Sleep-time compute — the amortisation argument, with numbers

Letta + Berkeley measured a Pareto improvement: "sleep-time compute can reduce the amount of
test-time compute needed to achieve the same accuracy by ~5× on Stateful GSM-Symbolic and Stateful
AIME", scaling sleep-time compute raises accuracy by up to 13% and 18% respectively, and amortising
across ~10 queries per context cuts the average cost per query by 2.5×. The effect is strongest
"in settings where the query is more easily predictable from the context"
([arXiv:2504.13171](https://arxiv.org/html/2504.13171v1),
[code](https://github.com/letta-ai/sleep-time-compute)).

Query predictability is high for a persona clone's corpus: the user will ask about the same 184
people, the same recurring topics, the same six months of events. **This is a rare case where the
"unpredictable query" caveat does not bite.** A nightly pass that pre-computes per-partner dossiers
and per-topic timelines is exactly the amortisation the paper is describing.

### 1.11 Benchmarks: what they actually measure, with numbers and caveats

**LongMemEval** ([arXiv:2410.10813](https://arxiv.org/abs/2410.10813),
[ICLR 2025 PDF](https://proceedings.iclr.cc/paper_files/paper/2025/file/d813d324dbf0598bbdc9c8e79740ed01-Paper-Conference.pdf),
[code](https://github.com/xiaowu0162/LongMemEval)) — 500 hand-written questions across five
abilities: information extraction, multi-session reasoning, temporal reasoning, knowledge updates,
abstention. Two settings: `LongMemEval_S` ≈ **115k tokens/problem**, `LongMemEval_M` = 500 sessions
≈ **1.5M tokens/problem**. Headline results: long-context LLMs show a **30%–60% performance drop**
on `LongMemEval_S`; state-of-the-art commercial systems reached only **30%–70%** accuracy in a
setting *simpler* than `LongMemEval_S`. Three design findings that transfer directly to us:

* **Session decomposition for value granularity** — finer value units help.
* **Fact-augmented key expansion** — concatenating condensed facts *with* the original value as the
  index key gave **+9.4% recall@k and +5.4% final accuracy** on average across models. Using the
  condensed form *alone* did **not** help: "despite their more focused semantics, using these
  condensed forms alone does not enhance the memory recall performance". **This is the strongest
  single piece of published evidence against replacing raw text with summaries in the index.**
* **Time-aware indexing + query expansion** — index values by event dates, and have an LLM extract a
  time range for time-sensitive queries: **+11.3% recall** with rounds as the value, **+6.8%** with
  sessions; effectiveness depends on a strong LLM doing the time extraction (Llama-8B was
  insufficient).

**LoCoMo** ([ACL 2024](https://aclanthology.org/2024.acl-long.747/),
[arXiv:2402.17753](https://arxiv.org/abs/2402.17753)) — very long-term conversations over up to
32–35 sessions, grounded in personas and temporal event graphs, with QA split into single-hop,
multi-hop, temporal, open-domain, and **adversarial**. Reported findings: long-context LLMs and RAG
improve QA by **22–66%** but still lag human performance by **56%**, and lag by **73%** on temporal
reasoning; long-context LLMs score **83% worse than the base model on adversarial questions** and
lag the base model by **14%** on event-graph summarisation, "indicating that they may grasp the
factual elements within the entire conversation but do not accurately comprehend the context".
*(Note: the ACL abstract and the arXiv v1 disagree on dataset scale — 600 turns / 16K tokens /
32 sessions vs 300 turns / 9K tokens / 35 sessions. Treat the exact figures as unstable.)*

**MSC / Multi-Session Chat** ([ACL 2022](https://doi.org/10.18653/v1/2022.acl-long.356),
[PDF](https://arxiv.org/pdf/2107.07567)) — 5 sessions, ≤14 utterances each, human-human, with
per-session annotations of "important personal points". Human evaluation: `SumMem-MSC 2.7B (RAG)`
reached **62.1% engaging response rate / 3.65 final rating** vs BlenderBot **53.0% / 3.14** and a
1,024-token-context truncation baseline **54.2% / 3.47**; partner-topic referencing rose to **33.8%**
vs BlenderBot's **14.5%**. The paper's own framing of the dataset is important for us: "when
reengaging, conversationalists often address existing knowledge about their partner to continue the
conversation in a way that focuses and deepens the discussions on their **known shared interests**".
That is the retrieval objective for a clone — *shared, ongoing, partner-specific* material — not
"whatever maximises answer accuracy".

**DMR (Deep Memory Retrieval)** — the MemGPT-team task built on a 500-conversation subset of MSC,
used as Zep's headline comparison (94.8% vs 93.4%).

**A caveat that should change how much you trust any of these numbers.** Mem0 and Zep publicly
disputed each other's LoCoMo results. Zep reported 84% on LoCoMo; Mem0 re-ran Zep under what it
argues are the benchmark's own rules (categories 1–4 only, matching system prompt, 10 runs) and
reported **58.44% ± 0.20**, attributing a ~25.56-point inflation to including the adversarial
category in the numerator but not the denominator. Zep replied acknowledging a calculation error and
stating the corrected figure is **75.14% ± 0.17 over 10 runs** — while standing by its critique of
the setup — and both sides recommend LongMemEval instead
([getzep/zep-papers issue #5](https://github.com/getzep/zep-papers/issues/5)). **Conclusion: for
this project, do not select an architecture on published benchmark deltas.** Build a local,
corpus-specific eval set (§8.7) and measure on that.

### 1.12 Structured-retrieval family: RAPTOR, HippoRAG, GraphRAG, LightRAG, MemWalker, ReadAgent

**RAPTOR** ([arXiv:2401.18059](https://arxiv.org/html/2401.18059v1)) — recursively embed, cluster,
and summarise chunks bottom-up into a tree, then retrieve from *all* levels. Controlled results with
UnifiedQA-3B: QuALITY accuracy RAPTOR 62.4% vs DPR 60.4% vs BM25 57.3%; QASPER F1 36.6% vs 31.7%
(DPR) vs 26.5% (BM25); with GPT-4, RAPTOR + GPT-4 reached **82.6%** on QuALITY (hard subset 76.2%)
vs CoLISA 62.3%. The authors' own diagnostic of *why* the tree helps is the useful part: "RAPTOR
benefits from its intermediate layers and clustering approaches, which allows it to capture a range
of information, from general themes to specific details" — and they beat a "recursively summarizing"
baseline that "rely solely on the summary in the top root node of the tree structure".

> **Design rule extractable from RAPTOR.** Recursion is not the problem; *using only the root* is.
> A summary tree is safe as long as the leaves remain retrievable and the top node is one of many
> candidates rather than the only context. This is precisely the property the current 5-MD design
> violates — the MDs are the root node, and the leaves are only reachable by a weak BM25 pass.

**HippoRAG** ([arXiv:2405.14831](https://arxiv.org/abs/2405.14831),
[code](https://github.com/OSU-NLP-Group/HippoRAG)) — LLM-built schemaless KG as a hippocampal index;
query concepts become seeds for **Personalized PageRank** over the graph; passage scores come from
multiplying the PPR distribution by the passage-node incidence matrix. Results: up to **+20%** over
SOTA RAG on multi-hop QA; R@2/R@5 improvements of ~3 points on MuSiQue and ~11/20 points on
2WikiMultiHopQA; single-step retrieval "comparable or better than iterative retrieval like IRCoT
while being 10–20× cheaper and 6–13× faster".

**GraphRAG** ([MSR dynamic community selection](https://www.microsoft.com/en-us/research/blog/graphrag-improving-global-search-via-dynamic-community-selection/),
[repo](https://github.com/microsoft/graphrag)) — hierarchical communities of entities/relations with
LLM-generated **community reports** per level; "global" queries are answered by map-reduce over a
level's reports. The published optimisation is directly relevant to cost control: replacing static
level-1 search with LLM-rated **dynamic community selection** cut total token cost by an average of
**77%** at equal judged quality (static processes ~1,500 level-1 reports; dynamic selects ~470 on
average), using `gpt-4o-mini` as the cheap rater and `gpt-4o` only for the final map-reduce. Going
deeper (level 3) *increased* cost by 34% while improving comprehensiveness/empowerment win rates to
~58.8%/60.0%.

**LightRAG** ([arXiv:2410.05779](https://arxiv.org/abs/2410.05779v3),
[ACL Findings 2025](https://aclanthology.org/2025.findings-emnlp.568/)) — dual-level retrieval:
*low-level* keywords match specific entities/edges, *high-level* keywords match broader themes and
relations; both matched against a vector store, then one-hop neighbourhoods are pulled in, and an
incremental update algorithm avoids full re-indexing. The **incrementality** is the transferable
property: GraphRAG's original design needed a full rebuild, LightRAG does not.

**MemWalker** ([arXiv:2310.05029](https://arxiv.org/abs/2310.05029),
[ar5iv](https://ar5iv.labs.arxiv.org/html/2310.05029)) — build a summary tree **offline**, then treat
reading as an agentic navigation: at each non-leaf the model sees the child summaries and chooses
"descend / revert"; at a leaf it either answers or reverts. Claims superiority over long-context,
recurrence, and retrieval baselines, plus explainability ("pinpointing the relevant text segments").
ReadAgent's critique of it is worth keeping: "the hierarchical summary structure makes it difficult
to reason over related but distant information at the same granularity".

**ReadAgent** ([arXiv:2402.09727](https://arxiv.org/html/2402.09727v3)) — pagination → *gist memory*
(each gist tagged with its page: `⟨Page 2⟩\n{GIST}`) → interactive look-up where the model names the
pages it wants to re-read, and "the selected raw pages replace the gist(s) at the corresponding
positions in memory, preserving the overall narrative flow". Claims up to **20× effective context**
and outperforms conventional retrieval. Two ideas to steal: **(a) gists are addressable and
reversible** (a gist can be swapped back out for the raw page), and **(b) page tags act as
provenance** that the model can cite.

**Synthesis for our problem.** Every one of these systems converges on the same invariant:
*derived text is a navigation aid over an intact raw layer, never a substitute for it.* The
current Weport pipeline inverts that.

### 1.13 Query-time self-correction: Self-RAG, CRAG, Chain-of-Note

**Self-RAG** ([arXiv:2310.11511](https://arxiv.org/html/2310.11511v1),
[ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/hash/25f7be9694d7b32d5cc670927b8091e1-Abstract-Conference.html))
trains the LM to emit **reflection tokens** that decide *whether to retrieve at all*, and to critique
retrieved passages and its own generations. A 7B/13B Self-RAG "significantly outperforms
state-of-the-art LLMs and retrieval-augmented models", including beating retrieval-augmented ChatGPT
on four tasks.

**CRAG** ([arXiv:2401.15884](https://arxiv.org/abs/2401.15884),
[code](https://github.com/HuskyInSalt/CRAG)) — a **0.77B** retrieval evaluator scores retrieved
documents, maps the score to {Correct, Incorrect, Ambiguous} via empirically-set thresholds (e.g.
`(0.59, -0.99)` on PopQA), and then either decomposes-then-recomposes the retrieved context into
"knowledge strips" (keeping only relevant strips), discards it and falls back to web search, or does
both. The paper notes prompting ChatGPT to do the relevance judgement "underperforms" the tiny
fine-tuned evaluator.

**Chain-of-Note** — cited as related work in CRAG's line of research; the mechanism (make the model
write a note about each retrieved document before answering) is a cheap, implemented-in-prompt way
to make the model actually read evidence rather than skim it. *(I did not open the Chain-of-Note
paper directly in this pass; treat its specific numbers as **UNVERIFIED** here.)*

**Applicability.** We cannot fine-tune (one hosted API, no GPU), so Self-RAG's reflection tokens are
out of reach. CRAG's *pattern* is reachable with a single cheap LLM call: score the top candidates,
and if the best score is below a floor, **rewrite the query and retrieve again** rather than feeding
weak evidence. Self-RAG's most valuable lesson is the *first* decision — **decide whether to
retrieve**. For `"hi"`, `"lol"`, `"在吗"` the correct retrieval action is frequently *no retrieval at
all* (§3.7).

### 1.14 Prompt compression: LLMLingua and the denoising reinterpretation

**LLMLingua** ([arXiv:2310.05736](https://arxiv.org/html/2310.05736),
[MSR page](https://www.microsoft.com/en-us/research/publication/llmlingua-compressing-prompts-for-accelerated-inference-of-large-language-models/))
is a coarse-to-fine compression: a budget controller, token-level iterative compression driven by a
small LM's perplexity, and instruction-tuning-based distribution alignment. Headline: "up to **20×**
compression with only a 1.5 point performance drop". Concrete numbers: on GSM8K, even 14×/20×
compression cost only 1.44/1.52 EM; on BBH it cost **8.5 and 13.2 points** at 5×/7× — i.e. **the
loss is highly task-dependent and much worse for multi-step reasoning than for recall**. Its own
case study attributes Selective-Context's failures to losing "critical reasoning information during
the chain-of-thought process".

The **SECOM** paper reframes compression in a way that is much more useful to us: "prompt
compression methods, such as **LLMLingua-2**, can effectively serve as a **denoising mechanism**,
enhancing memory retrieval accuracy across different granularities" ([SECOM](https://proceedings.iclr.cc/paper_files/paper/2025/file/e56f394bbd4f0ec81393d767caa5a31b-Paper-Conference.pdf)).

> **Design rule.** Compression is a *query-time denoiser* applied to retrieved evidence, not a
> *write-time replacement* for the corpus. Compressing what you are about to send is fine;
> compressing what you store is the failure mode we are trying to eliminate.

### 1.15 Infrastructure-level methods that are NOT applicable here

These are frequently proposed in the same breath as the systems above and should be explicitly ruled
out for an API-based, GPU-less Electron app:

* **Infini-attention / StreamingLLM / sliding-window attention with attention sinks** — these change
  the *inference kernel*: they keep a compressed state (linear attention with a bounded memory) or
  preserve a few initial "sink" tokens so a fixed-size KV window can stream indefinitely. They
  require control of the model's forward pass, i.e. self-hosting or a provider exposing the feature.
  With one hosted chat-completions API, the only lever we have is *what we put in the messages
  array*, so these techniques are irrelevant **by construction, not by preference**. (The
  architectural claim that these are kernel-level is stated in the LLMLingua paper's own remark that
  prompt compression "holds substantial practical implications, as it … improve[s] the LLMs's
  inference efficiency by compressing the KV cache" — a property of self-hosted stacks.)
* **Fine-tuning / LoRA persona adapters** — ruled out by "one hosted LLM API".
* **Local embedding *generation* on GPU** — ruled out by "no GPU"; see §7.5 for the CPU/WASM
  fallback and the hosted-embedding alternative.
* **Multi-agent memory writer swarms** — Cognition's write-up argues the decision-making "ends up
  too dispersed and context isn't able to be shared thoroughly enough"; their working pattern keeps
  "writes single-threaded" and uses extra agents only for *intelligence* ([Don't Build
  Multi-Agents](https://cognition.com/blog/dont-build-multi-agents),
  [Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working)). Our
  write path should be one deterministic pipeline with at most one LLM call per unit of work.

### 1.16 Implementability matrix — TypeScript, local files only, one hosted LLM API

| Capability | Verdict | How |
|---|---|---|
| Raw verbatim layer | **Yes, trivial** | SQLite table or JSONL; append-only |
| Atomic addressable records (A-MEM-style) | **Yes** | SQLite rows with stable ids + FTS5/dense index |
| Bi-temporal facts (Graphiti-style) | **Yes** | 4 timestamp columns + a partial index; no graph DB needed |
| Generative-Agents retrieval policy | **Yes** | 15 lines of arithmetic + a normaliser |
| Hybrid retrieval (BM25 + dense + RRF) | **Yes** | FTS5 + sqlite-vec/hnswlib; RRF is a 5-line reducer |
| Summary tree (RAPTOR) | **Yes, cost-limited** | LLM calls; do it nightly, leaves preserved |
| KG + PPR (HippoRAG) | **Yes** | Power-iteration PPR on a sparse adjacency in SQLite; the LLM extraction is the cost |
| Community reports (GraphRAG) | **Marginal** | ~1,500 reports for 21k chunks is a large bill for a personal corpus |
| Sleep-time pass | **Yes, and recommended** | Nightly, resumable, idempotent; see §8.5 |
| Self-editing memory per turn (MemGPT) | **No** | Costs a tool-calling round trip per turn and pollutes the voice |
| Benchmark-proven accuracy claims | **Do not rely** | §1.11 — the published deltas are contested |

---

## 2. Retrieval quality for a personal corpus

### 2.1 Lexical retrieval (BM25) — why it is not a legacy choice for *this* corpus

Okapi BM25 scores a document `d` for query `Q` as

```
score(d, Q) = Σ_{t∈Q} IDF(t) · [ f(t,d)·(k1+1) ] / [ f(t,d) + k1·(1 − b + b·|d|/avgdl) ]

IDF(t) = ln( 1 + (N − n_t + 0.5)/(n_t + 0.5) )      # Lucene/FTS5 form; stays ≥ 0
k1 ∈ [1.2, 2.0]    b ≈ 0.75 (FTS5 default 1.2/0.75; Anserini used k1=0.9, b=0.4 in BEIR)
```

SQLite FTS5 exposes it as `bm25(fts_table, w1, w2, …)` with per-column weights, and DuckDB's FTS
extension exposes `match_bm25(id, query, k := 1.2, b := 0.75, conjunctive := 0)`
([SQLite FTS5](https://www.sqlite.org/fts5.html), [DuckDB FTS](https://duckdb.org/docs/current/core_extensions/full_text_search)).

The BEIR study is the most important citation here because our corpus is precisely an
*out-of-distribution* retrieval problem (colloquial Chinese chat), not a Wikipedia QA problem:

| System | Avg. performance vs BM25 (18 datasets) |
|---|---|
| DeepCT | −27.9% |
| SPARTA | −20.3% |
| docT5query | **+1.6%** |
| DPR | **−47.7%** |
| ANCE | −7.4% |
| TAS-B | −2.8% |
| GenQ | −3.6% |
| ColBERT (late interaction) | +2.5% |
| BM25 + cross-encoder reranker | **+11%** |

([BEIR, arXiv:2104.08663](https://arxiv.org/abs/2104.08663))

BEIR's own conclusions: "BM25 remains a strong baseline for zero-shot text retrieval"; "BM25 heavily
underperforms neural approaches by 7-18 points on in-domain MS MARCO. However, BEIR reveals it to be
a strong baseline for generalization"; "dense retrieval models … underperform on datasets with a
large domain shift from what they have been trained on". **A 6-month WeChat history is a large
domain shift, and the corpus is tiny by IR standards (21k units).** The current lexical-first choice
is defensible; the deficiency is not "BM25 instead of embeddings", it is *what is indexed and how it
is queried*.

> **One BM25 caveat specific to Chinese.** BM25 quality is dominated by the tokenizer, and neither
> FTS5's `unicode61` nor a whitespace split is adequate for Chinese (§6.3). Any conclusion about
> "BM25 works/doesn't work on our corpus" is really a conclusion about the tokenizer.

### 2.2 Dense, learned-sparse, and late-interaction retrieval

**Dense bi-encoders.** Fast, compact, and the standard modern default — but the weakest BEIR
generalizers (DPR −47.7%, ANCE −7.4%, TAS-B −2.8% vs BM25). They also require embedding every unit
at ingest and at query time. Options in a no-GPU Electron app: hosted embedding API (a second vendor
and a privacy boundary — which this product explicitly forbids, see §0's "data never leaves the
device" invariant in `docs/agents/weclone.md`) or a local CPU ONNX model (§6.5).

**SPLADE** ([arXiv:2107.05720](https://ar5iv.labs.arxiv.org/html/2107.05720),
[SIGIR 2021](https://dl.acm.org/doi/10.1145/3404835.3463098)) — learned sparse retrieval with log
saturation and FLOPS/L1 sparsity regularisation. MS MARCO dev MRR@10:

| Model | MRR@10 | R@1000 (dev) | nDCG@10 (TREC DL19) | FLOPS |
|---|---|---|---|---|
| BM25 | 0.184 | 0.853 | 0.506 | 0.13 |
| doc2query-T5 | 0.277 | 0.947 | 0.642 | 0.81 |
| **SPLADE-FLOPS** | **0.322** | 0.955 | 0.665 | **0.73** |
| ANCE (dense) | 0.330 | 0.959 | 0.648 | — |
| TCT-ColBERT (dense) | 0.335 | 0.964 | 0.670 | — |

i.e. learned sparse reaches dense-model quality **at inverted-index cost** (0.73 vs 0.13 FLOPS, i.e.
~5.6× BM25 but ~4× cheaper than the sparse-expansion baseline). Its mechanism is *document
expansion*: at `FLOPS` regularisation the model drops ~20 terms/doc and adds ~32 expansion terms,
and a strongly-regularised variant (FLOPS=0.05) still reached MRR@10 0.296. SPLADE itself needs a
BERT-class encoder (not viable locally), **but its mechanism is viable via the LLM** and is exactly
what LongMemEval measured as **key expansion: +9.4% recall@k** (§1.11).

**ColBERTv2** ([NAACL 2022](https://aclanthology.org/2022.naacl-main.272/)) — late interaction
(MaxSim over per-token embeddings) with residual compression: best quality on **22 of 28**
out-of-domain tests, outperforming the next best retriever by up to 8% relative, with **6–10×**
smaller indexes than ColBERT (MS MARCO index 154 GiB → 16 GiB at 1 bit/dim, 25 GiB at 2 bits). Not
implementable locally (token-level encoder + multi-vector index), but the finding that *token-level
matching generalises better out-of-domain* is a direct argument for **character n-gram / trigram
matching** as a cheap local approximation of the same property.

### 2.3 Hybrid retrieval and Reciprocal Rank Fusion

RRF needs only ranks, which is why it is the right fusion primitive for heterogeneous local indexes:

```
RRFscore(d) = Σ_{r ∈ R} 1 / (k + r(d))        k = 60 (fixed in the original pilot, "not critical")
```

Cormack et al. found RRF "almost invariably improved on the best of the combined results",
outperforming Condorcet Fuse in all 7 experiments (p ≈ 0.008), CombMNZ in 6 of 7 (p ≈ 0.04), and the
best individual ranking in 6–7 (0.008 ≤ p ≤ 0.04), by "4% to 5% on average"
([RRF, SIGIR 2009](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf),
[DOI](https://doi.org/10.1145/1571941.1572114)).

Anthropic's contextual-retrieval post gives the modern, task-level version of the same result, as
top-20 retrieval failure rate on their corpus:

| Configuration | Failure rate | Change |
|---|---|---|
| Baseline (embedding only) | 5.7% | — |
| + Contextual Embeddings | 3.7% | **−35%** |
| + Contextual Embeddings + Contextual BM25 | 2.9% | **−49%** |
| + Reranking (of the hybrid) | 1.9% | **−67%** |

([Anthropic, Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval))

**Reading of the numbers:** lexical+dense fusion buys ~14 points of the 49; reranking buys the last
18. Fusion is cheap and index-local; reranking costs a model call. Do them in that order.

### 2.4 Chunking for chat: message / exchange / topic-segment / session

This is the single highest-leverage decision for this corpus, and the published evidence is
unusually clear.

**The controlled study.** SECOM ("On Memory Construction and Retrieval for Personalized
Conversational Agents", ICLR 2025) explicitly compares memory-unit granularities:

* **Turn-level** — "too fine-grained, leading to fragmentary and incomplete context"; relevant
  information is "dispersed across multiple interactions" and "some of the history conversation
  turns may not explicitly contain or relate to keywords mentioned in the current request".
* **Session-level** — "too coarse-grained, containing too much irrelevant information"; "a single
  conversation session may cover multiple topics, especially when users do not initiate a new chat
  session upon switching topics".
* **Summarisation-based** — "suffer from information loss that occurs during summarization".
* **Segment-level (proposed)** — "topically coherent segments … striking a balance between including
  more relevant, coherent information while excluding irrelevant content".

Two further measured results from that paper:

1. **Summary baselines lost to both raw granularities.** "summary based methods, such as SumMem and
   RecurSum fall behind turn-level or session-level baselines … likely due to the loss of crucial
   details during the process of converting dialogues into summaries."
2. **Segment granularity is also more robust to a weak retriever.** "Switching from the MPNet-based
   retriever to the BM25-based retriever results in performance improvements up to **11.98 and 7.89
   points** in terms of GPT4Score on LOCOMO and Long-MT-Bench+, respectively" for turn/session
   baselines, while SECOM "demonstrates greater robustness".

([SECOM, ICLR 2025 PDF](https://proceedings.iclr.cc/paper_files/paper/2025/file/e56f394bbd4f0ec81393d767caa5a31b-Paper-Conference.pdf),
[arXiv:2502.05589](https://arxiv.org/html/2502.05589))

**The counterweight: finer can be better if the unit is self-contained.** "Dense X Retrieval"
([arXiv:2312.06648](https://arxiv.org/html/2312.06648v1)) indexes Wikipedia at **proposition**
granularity (atomic, self-contained factoids) and beats both passages and sentences:

* average Recall@20 improvement over passage-level: **+10.1** (unsupervised retrievers) and
  **+2.2 to +2.7** (supervised retrievers), despite none being trained on propositions;
* EM@100 improvements of **+5.8 / +4.9 / +5.9 / +6.9** for DPR / ANCE / TAS-B / GTR;
* the advantage is largest "with questions targeting less common entities" and on datasets the
  retriever had never seen, and it is concentrated in the **100–200-word retrieved budget** range
  ("roughly 10 propositions, 5 sentences, or 2 passages").

**Reconciling the two.** SECOM's turn-level failure is a *coreference and completeness* failure —
a turn like "哈哈哈哈" or "那你要不要来" is not self-contained. Dense X's proposition win is because
a proposition **is** self-contained by construction. So the operative rule is not "coarse beats
fine" but:

> **The retrieval unit must be self-contained, topically coherent, and small enough to pack
> densely.** In a chat corpus that unit is neither the message nor the session: it is the
> *exchange-with-context* or the *topic segment*, and the fix for too-fine units is to *de-reference*
> them (attach the conversational context in which they occurred) rather than to enlarge them.

**Arithmetic for this specific corpus** (derived, showing the working):

| Quantity | Value | Source / derivation |
|---|---|---|
| Messages | ~104,000 | task brief |
| Tokens | ~1M | task brief |
| Characters (mostly Chinese, DeepSeek ratio 1 Chinese char ≈ 0.6 token) | ≈ **1.6–1.7M chars** | ratio from [DeepSeek Token & Token Usage](https://api-docs.deepseek.com/quick_start/token_usage); **derived estimate, UNVERIFIED against the actual byte count** (the repo measures 22.4 MB of JSONL, which includes metadata) |
| **Characters per message** | ≈ **16** | 1.67M / 104k |
| Existing chunks | 21,201 ⇒ **≈79 chars / chunk ≈ 4.9 messages** | 21,201 rows, `AGENTS.md` |
| A 25-message topic segment | ≈ **400 chars** | 16 chars × 25 |
| Number of such segments | ≈ **4,200** | 104k / 25 |
| Evidence budget for 20 retrieved segments | ≈ **8,000 chars** | |
| Share of the 180,000-char budget | **≈ 4.4%** | |

**Two conclusions fall straight out of that table.**

1. **The existing chunker is already at the "too fine" end** (≈5 messages/chunk), which is exactly
   the granularity SECOM measures as worst for retrieval; and it is far from Dense-X-style
   self-containment.
2. **Prompt budget is not the binding constraint — recall is.** Twenty topic segments cost ~4.4% of
   the hard budget. The current design spends ~13.7% of the budget (24.7k chars) on prose *about*
   the person and retrieves a handful of 79-char fragments. It is not "too much context"; it is
   **the wrong context, in the wrong units, at the wrong time.**

Recommended unit set for Weport (all indexed, all verbatim):

| Level | Definition | Typical size | Role in retrieval |
|---|---|---|---|
| `msg` | one WeChat row | ~16 chars | provenance target only; never retrieved alone |
| `exchange` | consecutive messages from one side + the replies that answer them (reply-chain aware) | ~2–6 msgs, 30–120 chars | **style exemplar unit** and answer-anchor |
| `segment` | topically coherent run, seeded by time-gap boundaries, refined by a cheap topic-shift signal (optionally LLM-confirmed nightly) | ~15–40 msgs, 250–800 chars | **primary retrieval unit** (SECOM) |
| `session` | a WeChat session/thread (natural gaps ≥ N minutes) | 100s of msgs | navigation only; expands to segments |
| `partner_dossier` | derived per-partner derived doc | 2–6k chars | semi-stable context frame (§7.4) |

The **expansion rule** matters as much as the units: retrieve at `segment` granularity, then
*expand* the winning segment with its 2–3 best `exchange` children (ReadAgent's "the selected raw
pages replace the gist(s) at the corresponding positions in memory, preserving the overall
narrative flow" — [arXiv:2402.09727](https://arxiv.org/html/2402.09727v3)). This gives both breadth
and verbatim texture from one retrieval call.

### 2.5 Contextual retrieval and late chunking

**Contextual retrieval** ([Anthropic](https://www.anthropic.com/engineering/contextual-retrieval),
[cookbook](https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide)): before
indexing a chunk, prepend a short LLM-written context sentence situating it in its parent document,
then index **(context + chunk)** with both embeddings and BM25. Measured effects are in §2.3's table;
the cookbook adds that "Contextual embeddings alone improved our Pass@10 from 87% to 92%" and that
"contextual embeddings provided the largest single improvement (+5-7 percentage points) … This
technique alone gets you 90% of the way to optimal performance", with full hybrid+rerank reaching
**95.26% Pass@10** (a 47% reduction in failures from 12.85% → 4.74%).

**Cost mechanics** (important for a one-time ingest): contextualisation is a *one-time* cost at
ingestion, not per query, and prompt caching makes it cheap. Their worked example: 737 chunks across
9 files, **61.83% of input tokens read from cache**, cost dropping from ~$9.20 to ~$2.85 (**69%
savings**). The blog computes the general figure as **$1.02 per million document tokens** for the
contextualisation pass under stated assumptions (800-token chunks, 8k-token documents, 50-token
context instruction, 100 tokens of context per chunk).

**Cross-check with LongMemEval.** Anthropic's "prefix the chunk with a situating sentence" and
LongMemEval's "concatenate compressed facts with the original value to form the index key (+9.4%
recall)" are the same intervention measured on two different corpora. Both also report the negative
control: **using the compressed form *alone* does not help** ("using these condensed forms alone does
not enhance the memory recall performance"). Treat that as the load-bearing rule of this whole
document.

**Late chunking** ([arXiv:2409.04701](https://arxiv.org/pdf/2409.04701v1),
[code](https://github.com/jina-ai/late-chunking)): embed the whole long text with a long-context
encoder first, *then* mean-pool per chunk span, so each chunk embedding is "conditioned on" the
whole document. nDCG@10:

| Dataset | Avg doc length (chars) | Naive chunking | Late chunking | No chunking |
|---|---|---|---|---|
| NFCorpus | 1589.8 | 23.46% | **29.98%** | 30.40% |
| SciFact | 1498.4 | 64.20% | **66.10%** | 63.89% |
| TRECCOV | 1116.7 | 63.36% | **64.70%** | 65.18% |
| FiQA2018 | 767.2 | 33.25% | **33.84%** | 33.43% |
| Quora | 62.2 | 87.19% | 87.19% | 87.19% |

"Late chunking always outperforms naive chunking … a higher average length of the documents
correlates with a larger improvement." Requires a long-context *local* embedding model → not viable
without GPU. **But the same conditioning is achievable with the API-only trick above** (index the
segment key as `[partner | date | topic | parent-context] + segment text`), which is contextual
retrieval viewed as a key-construction problem.

### 2.6 Query understanding: rewriting, HyDE, decomposition

**The problem for this corpus is acute**: the "query" is one WeChat message, ~16 characters, with
pronouns, ellipsis, and no shared vocabulary with the memory it should retrieve.

**Conversational query rewriting is the highest-value technique here, with the strongest evidence.**
CONQRR rewrites an in-context question into a standalone one and is RL-trained *directly against the
retriever*. On the QReCC updated evaluation (54M-passage corpus, three conversation sources, one of
them out-of-domain):

| Rewriter × Retriever | MRR | R@10 | R@100 |
|---|---|---|---|
| T5QR (supervised) + BM25 | 0.328 | 52.5 | 84.7 |
| **CONQRR (RL) + BM25** | **0.383** | **60.1** | 88.9 |
| Human rewrite + BM25 | 0.398 | 62.6 | 98.5 |
| T5QR + dual-encoder | 0.361 | 56.2 | 75.9 |
| **CONQRR (RL) + dual-encoder** | **0.418** | **65.1** | 84.7 |
| Human rewrite + dual-encoder | 0.422 | 64.8 | 84.0 |

([CONQRR, EMNLP 2022](https://aclanthology.org/2022.emnlp-main.679/),
[PDF](https://aclanthology.org/2022.emnlp-main.679.pdf)) — "CONQRR achieves state-of-the-art results
… over 12% and 14% for BM25 and a neural dual encoder retriever respectively". **An automatic rewriter
gets within 0.004–0.022 MRR of human rewriting on MRR for a dual encoder.** For a chat clone this is
a mandatory component, not an optimisation.

**Clarification rounds carry the missing terms.** In mixed-initiative conversational search, using
the *entire* clarification round (initial query `Q0` interpolated at weight 0.5 with question `Q` +
answer `A`) beat using `Q0+Q` or `Q0+A` alone; "the value of the clarification does not exist in
isolation in questions or answers, but in their combination"; even *negative* answers helped,
because "while asking clarifying questions, a number of contextually relevant words appear" which act
like query expansion; and a simple polarity/length-aware heuristic ranker beat all baselines at
p < 0.001 ([arXiv:2008.03717](https://arxiv.org/pdf/2008.03717),
[arXiv:2112.07308](https://ar5iv.labs.arxiv.org/html/2112.07308)).

> **Operational translation for Weport.** Never retrieve on the bare incoming message. Build the
> query as `last K turns of this thread + current message`, with the current message weighted higher
> (the interpolation result above), and let a cheap LLM rewrite it into a standalone query **only
> when the thread-concatenated query retrieves nothing above the score floor**.

**HyDE** ([ACL 2023](https://aclanthology.org/2023.acl-long.99.pdf)) — generate a hypothetical
answer document, embed it, search with that vector; the encoder's "dense bottleneck" filters
hallucinated details. "HyDE significantly outperforms the state-of-the-art unsupervised dense
retriever Contriever and shows strong performance comparable to fine-tuned retrievers across various
tasks (web search, QA, fact verification) and in non-English languages"; it beats BM25 by large
margins on TREC DL19/20 and loses to BM25 on only one BEIR dataset (TREC-COVID, by a tiny nDCG@10
margin). Requires a dense index → **only worth building if you add embeddings**, at which point HyDE
is the natural query-side companion. For a *lexical-only* pipeline there is a cheap analogue:
generate the hypothetical reply **in the user's own register** and BM25 *that* — which doubles as the
style-retrieval query (§2.8).

**Multi-query decomposition** ([ACL SRW 2025](https://aclanthology.org/2025.acl-srw.32.pdf)) —
decompose `q` into sub-questions, retrieve for each, merge, rerank against the *original* question.
On MultiHop-RAG: decomposition alone +4.4 Hits@4 / +2.9 Hits@10; reranking alone +7.6 Hits@4;
**combined 87.2% Hits@10 and 0.635 MRR@10**, versus 74.7% / 0.586 for the strongest configuration in
the original MultiHop-RAG paper (**+16.5% Hits@10, +8.4% MRR@10**). On HotpotQA, answer F1 35.0 /
EM 28.1 for QD+RR vs 31.3 / 25.4 naive. Two caveats: the LLM emitted exactly five sub-queries in
93.3% (MultiHop-RAG) and 98.6% (HotpotQA) of cases regardless of need, with ~zero correlation between
sub-query count and gold evidence count; and the bandit framing of sub-query selection reported +35%
document-level precision and +15% α-nDCG ([Petcu & Duh](https://www.cs.jhu.edu/~kevinduh/papers/petcu26query.pdf)).
**Decomposition is for multi-hop questions only.** In a chat clone, multi-hop questions are rare
("上次说的那个游戏叫什么来着" is refinement, not multi-hop). Treat decomposition as a conditional
upgrade triggered by question complexity.

### 2.7 Reranking: measured cost/benefit

| Evidence | Number | Source |
|---|---|---|
| Cross-encoder reranking over BM25 is the best BEIR configuration | BM25+CE beats BM25 on **16/18** datasets; **+11%** average | [BEIR](https://arxiv.org/abs/2104.08663) |
| Reranking the hybrid recovers 18 more points of failure rate | 2.9% → 1.9% top-20 failure | [Anthropic](https://www.anthropic.com/engineering/contextual-retrieval) |
| LLM reranker latency | "Reranking 50 documents can take up to **1 minute** using GPT-4 and/or Llama-70B on an H100" | [arXiv:2403.10407](https://doi.org/10.48550/arxiv.2403.10407) |
| Cross-encoder vs LLM reranker quality | "traditional cross-encoders remain very competitive" and are "way more efficient"; DeBERTa-v3 reranking **200** docs was best out-of-domain; GPT-4 was competitive with only top-**25** and the sliding-window mechanism "does not seem necessary" | same |
| Cross-encoder per-pair latency on one CPU core | 23.1 ms (ms-marco-MiniLM, 33M params) to ~330 ms (stsb-roberta-large, bge-reranker-large) — 4× to 57× a bi-encoder | [clawRxiv preprint](https://clawrxiv.io/abs/2604.01082) — **non-peer-reviewed, single-author-style preprint server; treat as low confidence** |
| Same source's failure-mode finding | ms-marco-MiniLM assigned 0.9996/1.0 to *negated* pairs — "reranking makes quality WORSE than bi-encoder alone" on negation | same, **low confidence** |

**Decision for Weport.** A cross-encoder needs a local model (out of scope without GPU/ONNX
engineering) and an LLM reranker costs one full extra call per turn with ~1-minute latency at
top-50. The correct day-one reranker is therefore a **deterministic multi-signal rescorer** over the
50 fused candidates, using the Generative Agents formula plus chat-specific signals:

```
final = w_rrf · RRF_norm
      + w_rec · 0.995^(hours_since_last_access)
      + w_imp · importance_norm            # LLM 1..10 assigned once at ingest
      + w_time· time_window_match          # 1.0 if the query has a time constraint and it matches
      + w_part· partner_match              # 1.0 if the unit belongs to the active partner
      + w_hit · exact_token_overlap        # cheap string match on named entities
```

Keep an **optional** LLM rerank for question-type queries only, behind a config flag, and measure it
before shipping it.

### 2.8 Short, pragmatic, and contentless queries — the "hi / lol / 在吗" problem

This is the case that breaks lexical retrieval, and it is **the majority of real WeChat traffic**.
The published evidence and its implications:

| Evidence | Implication |
|---|---|
| Lexical ranking on a conversational query improves when the *clarification round* is added, because it "reduce[s] the term mismatch", and the improvement correlates with the length of the answer ([arXiv:2008.03717](https://arxiv.org/pdf/2008.03717)) | For short queries, retrieve on **thread context**, not on the query |
| BEIR's own leaderboard note: they tested "Anserini + RM3 expansion, but found Anserini BM25 to perform the best" ([BEIR](https://arxiv.org/abs/2104.08663)) | Pseudo-relevance feedback on the *corpus* is not a reliable fix; the expansion must come from the *dialogue* |
| Turn-level units "may not explicitly contain or relate to keywords mentioned in the current request" ([SECOM](https://arxiv.org/html/2502.05589)) | Even with a good tokenizer, the target unit may be lexically disjoint from the query |
| Self-RAG "adaptively retrieves passages **on-demand**" and beats always-retrieve baselines ([arXiv:2310.11511](https://arxiv.org/html/2310.11511v1)) | For contentless queries the right action is often **retrieve nothing by content** |
| CRAG's evaluator gates on retrieval confidence (`{Correct, Incorrect, Ambiguous}`) ([arXiv:2401.15884](https://arxiv.org/abs/2401.15884)) | Implement a score floor; below it, change the policy instead of shipping bad evidence |
| In persona-based dialogue ICL, **randomly retrieved demonstrations achieved the best results**, while "retrieving demos with a context identical to the query performs the worst" — attributed to greater diversity and more unique tokens ([arXiv:2402.09954](https://doi.org/10.48550/arxiv.2402.09954)) | When the query carries no content, **diversity beats similarity** — deliberately sample the person's own messages from elsewhere |

**Proposed query-class policy** (classification is local and cheap: length in tokens, presence of
content words, exact match against a corpus-derived greeting/laughter/agreement lexicon):

| Class | Detector | Retrieval policy | Style policy |
|---|---|---|---|
| **Pragmatic** (`hi`, `lol`, `在吗`, `?`, emoji-only) | ≤ 3 content tokens AND (matches high-frequency lexicon OR zero IDF mass) | (a) last k exchanges with *this partner* by `(partner, ts DESC)`; (b) 3 random style exemplars of the same *cue type*; (c) no corpus-wide BM25 | Highest style weight; the reply is almost entirely register |
| **Continuation** | thread has ≥3 prior turns | query = last K turns + current, current weighted higher; retrieve segments restricted to this partner first | Medium |
| **Recall / question** | contains an interrogative or a named entity | BM25 + optional dense + RRF; optional decomposition if multi-hop; optional LLM rewrite on low score | Low style weight; evidence weight high |
| **Time-anchored** (`上周`, `上次`, `三月份`) | temporal lexicon; LLM extracts the range (LongMemEval's time-aware expansion gave **+11.3% / +6.8% recall**) | hard time filter, then lexical | Medium |
| **New topic / long message** | long, low thread overlap | full hybrid retrieval across all partners; diversify results | Medium |

**Pragmatic queries are where the "voice is lost" complaint actually lives.** When the user types
`lol`, the ideal clone output is a specific, recognisable habit — a particular laugh token, a
particular way of pivoting. No fact retrieval produces that. Only **verbatim style exemplars selected
by cue type** do. That is the concrete sense in which the current design cannot work: its memory is
a set of true statements about a person, and the request is for a *behaviour*.

---

## 3. Hierarchical / multi-resolution memory done properly

### 3.1 The invariant

Every system surveyed in §1 that survives contact with a real corpus satisfies:

> **The raw layer is authoritative and retrievable. Derived layers are indexes that point back to it.
> No derived artefact is ever the only copy of a fact.**

Stated in the literature, in four independent places:

* RAPTOR beats a recursively-summarising baseline *because* the baseline "rel[ies] solely on the
  summary in the top root node of the tree structure" while RAPTOR "benefits from its intermediate
  layers" ([arXiv:2401.18059](https://arxiv.org/html/2401.18059v1)).
* ReadAgent's gists are *addressable and reversible*: "the selected raw pages replace the gist(s) at
  the corresponding positions in memory, preserving the overall narrative flow"
  ([arXiv:2402.09727](https://arxiv.org/html/2402.09727v3)).
* Graphiti never deletes a contradicted edge; it sets `invalid_at`/`expired_at`
  ([bi-temporal model](https://getzep-graphiti.mintlify.app/concepts/temporal-model)).
* LongMemEval: condensed keys must be concatenated **with** the original value, because condensed
  forms alone did not improve recall ([arXiv:2410.10813](https://arxiv.org/abs/2410.10813)).

Cognee implements the same invariant structurally by keeping a **relational store for documents,
chunks, and provenance** alongside the graph and vector stores
([cognee architecture](https://www.cognee.ai/how-cognee-builds-ai-memory)).

### 3.2 Recursive summarisation: the failure analyses

Three named failure modes, with evidence:

**(a) Cascaded loss in summary-of-summary.** The clearest published statement is practitioner
testimony, not measurement, and should be read as such: "Roll up 10 turns into a summary, then roll
that summary into another summary a dozen turns later, and you're not running one lossy transform —
you're running a cascade of them. Precision degrades toward approximation. 'Exactly 512 records'
becomes 'about 500 records' becomes 'several hundred records.' **Negations don't just degrade — they
invert.** … Exact numerical values: approximation is the default loss." The named mechanisms are
salience bias against low-frequency content (a constraint stated once), loss of conditional
structure ("if the API returns a 429, retry …, then escalate" becomes three independent
suggestions), and positional bias ("content at the beginning of context receives more attention
weight … information buried in the middle … drops first")
([tianpan.co, Context Compression Artifacts](https://tianpan.co/blog/2026/05/05/context-compression-artifacts-summarization-information-loss), **unrefereed blog**).

The complementary cost analysis makes the same point with the economics attached: naive "summarise
everything before the cutoff" has a span that grows with each trigger, so "summarization cost and
latency increase linearly with conversation length, and the cumulative summarization spend across a
session grows like a triangular sum"; hierarchical re-summarisation bounds the cost but "bleeds
fidelity on every iteration, and the bleeding is asymmetric. Each pass throws away detail. A small
fact dropped on pass three cannot be recovered on pass seven" — "a memory system that's cheap but
slowly lying" ([tianpan.co, The Summary Tax](https://tianpan.co/blog/2026-05-09-summary-tax-compaction-eats-more-tokens-than-it-saves), **unrefereed blog**).

The peer-reviewed version of the same finding is SECOM's result that summary-based memory baselines
**lost to raw turn-level and session-level baselines** on LoCoMo and Long-MT-Bench+ (§2.4).

**(b) Long-context degradation on the summary itself ("context rot").** Chroma evaluated 18 models
including GPT-4.1, Claude 4, Gemini 2.5 and Qwen3 with task complexity held constant and only input
length varied: "across all experiments, model performance consistently degrades with increasing input
length"; "lower similarity needle-question pairs increases the rate of performance degradation"; "even
a single distractor reduces performance relative to the baseline … adding four distractors compounds
this degradation further"; and "the structural pattern of the haystack consistently shows an impact".
Their concluding sentence is the thesis of this document: "Whether relevant information is present in
a model's context is not all that matters; **what matters more is how that information is
presented**." ([Chroma, Context Rot](https://www.trychroma.com/research/context-rot),
[code](https://github.com/chroma-core/context-rot)).

**(c) Positional degradation inside the prompt.** §4.1 and §4.4.

**The engineering consequence: never compact the corpus.** Compaction is a legitimate *conversation*
technique — Anthropic recommends it for context-window management in long agent runs and advises
"start by maximizing recall to ensure your compaction prompt captures every relevant piece of
information from the trace, then iterate to improve precision"
([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
But compaction of a *memory store* is what the current Weport pipeline does, and it is what destroys
the voice. The correct architecture is: **compact the conversation, never compact the corpus.**

### 3.3 A concrete layered schema with provenance (SQLite DDL)

This is the schema the recommendation in §7 is built on. Everything derived carries
`(source_ids, source_hash, derived_by, derived_at)`; the raw layer is `INSERT`-only.

```sql
-- L0: raw, append-only, authoritative -------------------------------------
CREATE TABLE msg (
  msg_id      INTEGER PRIMARY KEY,       -- WCDB localId, stable
  session_id  TEXT    NOT NULL,
  partner_id  TEXT    NOT NULL,          -- wxid of the other side
  is_send     INTEGER NOT NULL,          -- 1 = me, 0 = them  (mirrors messagePushService's filter)
  ts          INTEGER NOT NULL,          -- epoch seconds, the ONLY authoritative time
  type        INTEGER NOT NULL,          -- text / image / voice / system / ...
  text        TEXT,                      -- verbatim; NULL only for non-text
  quote_id    INTEGER,                   -- reply target, when present
  atuserlist  TEXT                       -- structured mentions, never parsed from text
);
CREATE INDEX msg_partner_ts ON msg(partner_id, ts);
CREATE INDEX msg_session_ts ON msg(session_id, ts);

-- L1: derived units (rebuildable at any time from L0) ---------------------
CREATE TABLE segment (
  segment_id   INTEGER PRIMARY KEY,
  session_id   TEXT NOT NULL,
  partner_id   TEXT NOT NULL,
  first_msg_id INTEGER NOT NULL, last_msg_id INTEGER NOT NULL,
  start_ts     INTEGER NOT NULL, end_ts INTEGER NOT NULL,
  msg_count    INTEGER NOT NULL,
  topic_label  TEXT,                      -- short; derived
  text         TEXT NOT NULL,             -- VERBATIM concatenation of the messages
  key_text     TEXT NOT NULL,             -- contextual-retrieval key: [partner|date|topic|context] + text
  importance   INTEGER,                   -- 1..10, Generative-Agents style, derived once
  source_hash  TEXT NOT NULL              -- hash of the L0 rows; lets us invalidate + re-derive
);

CREATE TABLE exchange (                   -- style exemplar unit; VERBATIM, never paraphrased
  exchange_id  INTEGER PRIMARY KEY,
  segment_id   INTEGER NOT NULL,
  partner_id   TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  cue_type     TEXT,                      -- greeting | laughter | agreement | question | banter | ...
  me_text      TEXT NOT NULL,             -- my side, verbatim
  them_text    TEXT,                      -- their side, verbatim
  char_len     INTEGER NOT NULL,
  src_msg_ids  TEXT NOT NULL              -- JSON array of msg_id
);

-- L2: indexes ------------------------------------------------------------
-- Chinese-safe tokenizer; see §6.3. External-content pattern keeps one copy of the text.
CREATE VIRTUAL TABLE segment_fts USING fts5(
  key_text, topic_label,
  content='segment', content_rowid='segment_id',
  tokenize='trigram'                       -- or unicode61 + a bigram-augmented column
);
CREATE VIRTUAL TABLE exchange_fts USING fts5(
  me_text, them_text, cue_type,
  content='exchange', content_rowid='exchange_id',
  tokenize='trigram'
);

-- L2b: optional dense index (see §6.2) -----------------------------------
CREATE VIRTUAL TABLE segment_vec USING vec0(
  segment_id INTEGER PRIMARY KEY,
  embedding  float[1024]
);

-- L3: bi-temporal facts (Graphiti-shaped, but only for recall-worthy facts)
CREATE TABLE fact (
  fact_id     INTEGER PRIMARY KEY,
  subject     TEXT NOT NULL,              -- canonical entity id
  predicate   TEXT NOT NULL,              -- lives_in | works_at | prefers | owns | happened_on | ...
  object      TEXT NOT NULL,
  valid_from  INTEGER, valid_to INTEGER,  -- VALID time (when it was true in the world / chat)
  learned_at  INTEGER NOT NULL,           -- TRANSACTION time (when Weport learned it)
  expired_at  INTEGER,                    -- when it was superseded
  confidence  REAL,
  quote       TEXT NOT NULL,              -- verbatim supporting span  <-- enforced non-empty
  src_msg_ids TEXT NOT NULL               -- JSON array  <-- enforced non-empty
);
CREATE INDEX fact_entity ON fact(subject, predicate);
CREATE INDEX fact_validity ON fact(valid_from, valid_to);

-- L4: derived prose. POINTERS, not replacements. -------------------------
CREATE TABLE note (                       -- A-MEM-shaped atomic note, one level only
  note_id     INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,             -- 'segment_summary' | 'partner_dossier' | 'topic_timeline'
  scope_id    TEXT NOT NULL,             -- segment_id / partner_id / topic
  body        TEXT NOT NULL,
  quotes      TEXT NOT NULL,             -- JSON array of verbatim quotes
  source_ids  TEXT NOT NULL,             -- JSON array; NEVER empty
  source_hash TEXT NOT NULL,
  model       TEXT NOT NULL, derived_at INTEGER NOT NULL,
  superseded_by INTEGER                   -- notes are versioned, never overwritten
);
CREATE TABLE note_link (                  -- A-MEM links, cheap version
  from_note INTEGER NOT NULL, to_note INTEGER NOT NULL,
  score REAL NOT NULL, kind TEXT, PRIMARY KEY(from_note, to_note)
);
```

Six properties this schema enforces that the markdown design cannot:

1. **Reversibility.** Every note and every segment can be traced to `msg_id`s.
2. **Invalidation.** A `source_hash` change marks a derived row stale; re-derivation is local.
3. **Supersession instead of overwriting.** `note.superseded_by` keeps the history of what the system
   believed (§3.4).
4. **Verbatim enforcement.** `fact.quote` and `exchange.me_text` are non-null; the ingestion gate
   (§3.5) verifies they literally occur in L0.
5. **Two time axes.** "What was true then" is distinct from "what we knew then" — essential for a
   6-month corpus where a relationship or a job changed mid-way.
6. **One level of prose.** There is exactly one summary layer above raw. No summary-of-summary.

### 3.4 Contradiction handling and temporal validity

Graphiti's algorithm, restated as an implementable procedure on the `fact` table
([source](https://getzep-graphiti.mintlify.app/concepts/temporal-model)):

```
on_new_fact(subject, predicate, object, valid_at, learned_at, quote, src):
    existing = SELECT * FROM fact
               WHERE subject=? AND predicate=? AND expired_at IS NULL
                 AND (valid_to IS NULL OR valid_to > :valid_at)
    if existing and contradicts(existing.object, object):
        UPDATE fact SET invalid_at = :valid_at, expired_at = :learned_at
        WHERE fact_id = existing.fact_id
        INSERT INTO fact(..., valid_from=:valid_at, learned_at=:learned_at, quote=..., src_msg_ids=...)
    elif existing and agrees(existing.object, object):
        # reinforcement, not duplication: extend validity, keep the earliest quote
        UPDATE fact SET valid_to = MAX(COALESCE(valid_to, 0), :valid_to) WHERE fact_id = existing.fact_id
    else:
        INSERT INTO fact(...)
```

`contradicts()` is the one place an LLM is genuinely needed (Graphiti uses the LLM "during edge
resolution"). The point-in-time read is the same predicate Graphiti documents:

```sql
SELECT * FROM fact
WHERE subject = :entity
  AND (valid_from IS NULL OR valid_from <= :T)
  AND (invalid_at IS NULL OR invalid_at > :T)
```

**Why this matters for a personal corpus specifically.** Over six months, a person's own statements
contradict each other constantly — tastes change, plans change, a job ends, a friendship cools. A
prose summary must *choose* one version, and the choice is invisible and unreviewable. A bi-temporal
fact table shows both, with dates, and the clone can say "那阵子他还在说要去 X，后来就没提了" — which
is what a person actually sounds like.

### 3.5 Verification gates you can actually run (and the ones you cannot)

These are cheap, deterministic, and catch the failure modes above. Each is a few lines of TypeScript:

| Gate | Rule | Catches |
|---|---|---|
| **Verbatim quote gate** | every `fact.quote` and every quoted span in `note.quotes` must satisfy `segment.text.includes(quote)` after whitespace normalisation | the #1 LLM failure in memory extraction: fabricated support |
| **Id-gate** | `src_msg_ids` non-empty and all ids exist in `msg` | orphan memory |
| **Hash gate** | `source_hash == sha1(concat of L0 rows)` before re-deriving | stale derived rows after a re-sync |
| **Length gate** | a derived note must be **shorter** than its sources by ≥ 3× | notes that quietly grow into a second corpus |
| **Coverage gate** | for every segment, at least one surviving verbatim quote | summary-of-nothing |
| **Style-quote gate** | every `exchange` used as a style exemplar has `me_text` byte-identical to `msg.text` | paraphrase leaking into voice exemplars |
| **Eval gate** | §7.7's held-out reply test must not regress | silent quality drift |

**What you cannot verify locally** and must therefore design around: whether an LLM's *summary* is
faithful in the general case. There is no local NLI model, no GPU, and no labelled data. The verbatim
gate is the mitigation — it converts "is this summary true?" (unverifiable) into "does this quoted
span exist?" (a string search).

---

## 4. Long-context facts an implementer must know

### 4.1 "Lost in the middle" — the numbers

Liu et al. evaluated multi-document QA and synthetic key-value retrieval while varying *only* the
position of the relevant document ([TACL 2024](https://aclanthology.org/2024.tacl-1.9/),
[PDF](https://aclanthology.org/2024.tacl-1.9.pdf)):

* Performance follows a **U-shaped curve**: highest at the beginning (primacy) and end (recency),
  "significantly degrades when models must access and use information located in the middle".
* Concretely: "GPT-3.5-Turbo's multi-document QA performance can drop by more than **20%** — in the
  worst case, performance in 20- and 30-document settings is lower than performance without any input
  documents (i.e., closed-book performance; **56.1%**)".
* "Models often have identical performance to their extended-context counterparts, indicating that
  extended-context models are not necessarily better at using their input context."
* The query-aware contextualization experiment matters for us: putting the *question before* the
  documents "significantly improves" robustness to position.

### 4.2 Advertised context length vs effective context length

**RULER** ([repo](https://github.com/nvidia/RULER), [arXiv:2404.06654](https://doi.org/10.48550/arxiv.2404.06654))
evaluated 17 long-context models on 13 tasks across 4 categories: "despite achieving nearly perfect
accuracy in the vanilla NIAH test, almost all models exhibit large performance drops as the context
length increases"; "while all models claim context sizes of 32K tokens or greater, **only half of
them can maintain satisfactory performance at the length of 32K**"; "almost all models fall below the
threshold before reaching the claimed context lengths". The threshold is Llama-2-7B's 4K score
(85.6% averaged over RULER tasks). Examples: GPT-4 (128K claimed) effective **64K**; Llama-3.1-70B
(128K claimed) effective **64K**, dropping to 66.6 at 128K; Qwen2-72B (128K claimed) effective
**32K**, 48.0 at 128K; Mistral-Large-2411 (128K claimed) effective 64K and **48.1 at 128K**;
Command-R-plus effective 32K; several 1M-token models effective 4K–16K.

**NoLiMa** is the stricter test: it removes literal overlap between question and needle so the model
must infer latent associations. On 13 models claiming ≥128K: "at 32K … 11 models drop below 50% of
their strong short-length baselines. Even GPT-4o … experiences a reduction from an almost-perfect
baseline of 99.3% to **69.7%**"
([PMLR v267](https://proceedings.mlr.press/v267/modarressi25a.html),
[repo](https://github.com/adobe-research/nolima)). The repo's table adds the most useful column for
us — **effective length** = the longest context where the model keeps ≥85% of its short-context
score:

| Model | Claimed | Effective | 1K | 4K | 8K | 16K | 32K | 64K | 128K |
|---|---|---|---|---|---|---|---|---|---|
| GPT-4.1 | 1M | 16K | 95.6 | 91.7 | 87.5 | 84.9 | 79.8 | 69.7 | 64.7 |
| GPT-4o | 128K | 8K | 98.1 | 95.7 | 89.2 | 81.6 | 69.7 | 62.4 | 56.0 |
| Llama-3.3-70B | 128K | 2K | 94.2 | 81.5 | 72.1 | 59.5 | 42.7 | — | — |
| Gemini 1.5 Pro | 2M | 2K | 86.4 | 75.4 | 63.9 | 55.5 | 48.2 | — | — |
| Claude 3.5 Sonnet | 200K | 4K | 85.4 | 77.6 | 61.7 | 45.7 | 29.8 | — | — |
| GPT-4o mini | 128K | <1K | 67.7 | 44.1 | 32.6 | 20.6 | 13.7 | — | — |
| Llama-4 Scout | 10M | 1K | 72.3 | 50.8 | 35.5 | 26.9 | 21.6 | — | — |

On the harder NoLiMa-Hard subset, GPT-4o falls 99.9 → 38.5 by 32K, and even reasoning models degrade
(GPT-o3 100.0 → 58.5 at 32K).

**Design consequences.**

1. **Never send 100k+ characters and hope.** The advertised window is not the usable window. For
   retrieval-style tasks, plan on the *effective* length being 8K–32K tokens for most models — i.e.
   **~5k–20k Chinese characters**. This makes the current 180,000-character budget not a target but
   a hazard: at ~0.6 tokens/char (DeepSeek's own published ratio) 180k chars ≈ 108k tokens, well
   past every effective length in the tables above.
2. **Use the window for a small number of high-relevance units, ordered deliberately** (§4.4).
3. **Re-measure per model.** Effective length is model- and task-specific; the tables are those
   papers' tasks, not yours.

### 4.3 Context rot

Beyond position, *amount* alone hurts: see §3.2(b). The operational form of the finding: adding
irrelevant content degrades performance even when the relevant content is present and the task is
trivial, and degradation accelerates as the needle becomes lexically dissimilar to the question —
which is precisely the situation for a chat corpus where the query `"那咋办"` and the target memory
share almost no tokens.

### 4.4 Position engineering for retrieved evidence

"Long-Context LLMs Meet RAG" ([arXiv:2410.05983](https://arxiv.org/html/2410.05983)) measured the
non-monotonic behaviour that everyone hits in practice: with long-context LLMs, "the quality of
generated output initially improves first, but then subsequently declines as the number of retrieved
passages increases", and the cause is identified as retrieved **hard negatives** — "there are
scenarios where the 'hard negatives' from stronger retrievers might confuse the LLM generation even
more than those from weaker retrievers". Their training-free fix is exactly position engineering:
"reordering retrieved documents based on their retrieval scores. By prioritizing documents with
higher scores at the beginning and end of the input sequences … This behavior is attributed to the
interplay of two factors … (1) the amplified 'lost-in-the-middle' phenomenon … and (2) the increased
prevalence of hard negatives."

**Rule for Weport:** sort retrieved evidence by final score, then place it as
`[best, 3rd, 5th, …, 6th, 4th, 2nd]` — highest-scoring units at both ends, weakest in the middle.
A deterministic interleave is enough; do not spend an LLM call on ordering.

**Also relevant:** the RAG-vs-long-context comparison found that "when resourced sufficiently, LC
consistently outperforms RAG in terms of average performance. However, RAG's significantly lower cost
remains a distinct advantage", and their `Self-Route` — let the model decide whether retrieval was
sufficient, and only fall back to full context if not — "reduce[s] the cost by 65% for Gemini-1.5-Pro
and 39% for GPT-4O" while matching long-context quality; "most queries can be solved by the first
RAG-and-Route step (e.g., 82% for Gemini-1.5-Pro)"
([arXiv:2407.16833](https://arxiv.org/pdf/2407.16833)). For a local app this is a cheap and directly
applicable pattern: retrieve, ask the model to answer or to declare "unanswerable from this", and only
then run the expensive path.

### 4.5 Prompt caching: mechanics and the economics of a large stable prefix

**This is the single most important structural constraint on prompt assembly**, because it determines
what may be *stable* and what must be *appended*.

**DeepSeek (the likely provider here).** Context caching on disk is on by default, with a
prefix-matching model that has a hard requirement:

> "Each cached prefix is an independent, complete unit. A subsequent request can only hit the cache
> if it **fully matches** a **cache prefix unit**."

Cache prefix units are persisted at (1) the end of the user input and the end of the model output of
every request, (2) a detected **common prefix across multiple requests**, and (3) at fixed token
intervals for long inputs/outputs. Their worked example 2 is the critical one: request 1 = `A+B`,
request 2 = `A+C` → **no hit**, but the system persists `A` as a unit; request 3 = `A+D` → hits `A`.
Cache status is reported in `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`; caching is
"best-effort" with no guaranteed hit rate; cache construction takes seconds and entries are cleared
"usually within a few hours to a few days"
([DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache)).

**Consequence for the prompt layout:** if any mutable content (retrieved evidence, a timestamp, a
"today is …" line) sits *before* the large persona block, the persona block can never be a cache
unit and every turn pays full input price for it. The stable block must be a true prefix, and every
per-turn byte must come after it. This is the same discipline `prefixCache.ts` already enforces for
chat history (`AGENTS.md`: append-only history, DSH ratios 0.8/0.16) — it must now be extended to the
persona frame.

**Price shape.** DeepSeek's published table lists, per 1M input tokens, cache-**hit** rates of
$0.003–$0.022 and cache-**miss** rates of $0.15–$1.32 depending on model and peak/off-peak tier
([DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing); note: re-fetching that URL
during this survey served the "First API Call" page instead of the price table, so the specific
model→price mapping is **UNVERIFIED** — verify in the app's own model registry, which already pulls
live prices from `models.dev`, per `AGENTS.md`).

**OpenAI.** Caching is automatic; "cache writes cost 1.25× the standard, uncached input-token rate
… subsequent reads cost only 0.1× that rate. Writing a prefix once and fully reusing it once costs
1.35× its ordinary input cost, compared with 2× for processing it twice without caching. … across ten
requests, one write and nine full reads cost 2.15×, compared with 10× without caching." The cookbook
adds a counter-intuitive but important optimisation: "in some cases, making your prompt slightly
longer can reduce overall cost … a slightly longer but stable prefix can be cheaper than a shorter
prompt that never caches", and reports measured discounts from 50% (gpt-4o) to 90% (gpt-5.2) plus a
measured "8.5% increase in cache hit rate … [and] 23% reduction in input token cost" from using
`prompt_cache_key` with flex processing
([OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[cookbook](https://developers.openai.com/cookbook/examples/prompt_caching_201)).

**Anthropic.** The published caching model is a write premium of 1.25× (5-minute TTL) or 2×
(1-hour TTL) and a read rate of 0.1×; break-even is one read at the 5-minute TTL and two reads at the
1-hour TTL; "reads refresh the lifetime at the read price" so steady traffic pays the write once.
([secondary analysis of the official docs](https://technspire.com/en/blog/anthropic-prompt-caching-pricing-mechanics);
official page: [platform.claude.com prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
— the multipliers here are cited from the secondary source, **partially UNVERIFIED**).

**Gemini.** Implicit caching is on by default with a **90%** discount on cached tokens; explicit
caching gives 90% on 2.5+ and 75% on 2.0, and additionally charges storage per 1M tokens per hour
(e.g. $1.00–$8.10/1M tokens/hour depending on model)
([Vertex AI context cache](https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview),
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing.md.txt)).

**Cache arithmetic for a 24.7k-character persona frame.** 24.7k characters of mostly-Chinese text
≈ **14.8k tokens** at DeepSeek's published 0.6 tokens/Chinese-char ratio. Against the cached-vs-
uncached spread above (roughly 10×–50×), the difference between a cacheable and a non-cacheable
persona frame is the difference between paying for 14.8k tokens every turn and paying ~1/10 to ~1/50
of that. Concretely, at the cache-miss price of $0.15/1M input tokens (the lowest tier observed) an
uncached 14.8k-token frame costs ~$0.0022/turn; at a 1/50 hit price, ~$0.00004/turn. Over 1,000
turns that is $2.2 versus $0.04 — small in absolute terms but the *ratio* is what scales if the frame
grows to 60k tokens (a plausible outcome of "just add more persona detail").

### 4.6 What stuffing 100k+ characters on every turn actually costs

Four separate costs, only the first of which is money:

1. **Token cost** — linear in the stuffed size, at the miss rate if the prefix is not stable.
2. **Latency** — prefill time scales with the uncached prefix; prompt caching reduces time-to-first-
   token by "up to 80%" per OpenAI's own documentation ([cookbook](https://developers.openai.com/cookbook/examples/prompt_caching_201)).
   For a local desktop app whose user is waiting mid-conversation, this is the cost that is actually
   felt.
3. **Quality loss** — §4.1–§4.3: more tokens with imperfect relevance measurably *reduce* accuracy,
   and the decline is non-monotonic in `k` (§4.4). "More context" is not a neutral operation.
4. **Cache invalidation** — a large mutable prefix destroys cacheability for the *entire conversation*,
   not just the frame, because everything after the last cached unit is re-billed.

**Therefore: the target is not "how much can we fit" but "what is the smallest set of high-signal
tokens for this turn".** Anthropic's formulation is the cleanest statement of the objective: "find
the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome"
([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

<!-- PART3 -->
