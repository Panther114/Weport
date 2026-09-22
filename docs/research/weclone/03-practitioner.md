# WeClone — Practitioner-Grade Techniques for Making an LLM Actually Sound Like One Person

**Research deliverable 03.** Scope: every practitioner-grade technique that measurably improves how much an LLM's
output sounds like *one specific real person*, with emphasis on what a small local-first desktop app
(Electron + TypeScript, one hosted OpenAI-compatible chat API — DeepSeek in this app's case, no local GPU) can
actually implement.

Target system: the WeClone feature in Weport. ~104,000 of the user's own WeChat messages, Chinese–English
code-mixed, informal, 2026-03 → 2026-09, ~1M tokens. Current design: LLM-summarise the corpus into 5 markdown
"persona" files, BM25-retrieve past messages, assemble a ~25k-char system prompt.

Two conventions are used throughout:

- **[UNVERIFIED]** marks a claim I could not confirm from a primary source I actually read. Everything else
  has a URL in `## Sources`.
- **`file:line`** references are to this repository's current code, and are only used where the existing
  project docs (`docs/agents/weclone.md`) state the fact; the exhaustive code recon is in the companion
  inventory and is not duplicated here.

---

## 0. The design premise is wrong, and the literature says exactly why

The user's complaint — "it does not know how to actually speak" — is not a tuning problem. It is the predictable
outcome of the architecture, and there is hard evidence for that:

1. **Prose descriptions of style are the weakest possible conditioning signal.** In a five-model study across
   Llama/Qwen/Mixtral families, *zero-shot* prompting with statistical style summaries produced authorship
   verification accuracy **below 7%** — while the verifier reported **>95% confidence** in its (wrong)
   predictions. The authors' conclusion: "the statistical style summaries provided in prompts were not effective
   anchors for imitation." One-shot jumped to 67.6–94.7%; few-shot improved further; and **text completion**
   (continuing a human-written prefix) reached **≥99.9% agreement** with the original author in 4 of 5 models.
   ([Identity-conditioned style imitation study, arXiv 2509.24930](https://arxiv.org/pdf/2509.24930))
2. **Prompting strategy beats model size for style fidelity.** Same paper: "prompting strategy, not model size,
   primarily governs style imitation." Switching to a better model cannot fix a profile-based prompt.
3. **Few-shot exemplars beat zero-shot by up to 23.5×** on style-matching accuracy in that study, and few-shot
   generations are significantly closer to the target author's style model than zero-shot ones (Wilcoxon
   signed-rank). ([Catch Me If You Can? Not Yet, EMNLP Findings 2025](https://aclanthology.org/2025.findings-emnlp.532.pdf))
4. **The failure is worst exactly in the user's register.** That same EMNLP paper evaluated >40,000 generations
   per model across news, email, forums and blogs, and found LLMs "approximate user styles in structured formats
   like news and email" but "struggle with nuanced, informal writing in blogs and forums." WeChat chat is the
   *most* informal end of that axis.
5. **Retrieval of the author's own past items is the single highest-leverage cheap intervention that exists.**
   LaMP (the standard personalisation benchmark) reports **+12.2% relative in zero-shot** and **+23.5% relative
   with fine-tuning** from retrieval-augmented personalisation. ([LaMP, ACL 2024](https://aclanthology.org/2024.acl-long.399.pdf))
6. **RAG massively outperforms per-user fine-tuning for this job.** The first systematic RAG-vs-PEFT comparison
   on seven personalisation datasets: RAG-based personalisation **+14.92%** over non-personalised, PEFT-based
   **+1.07%**, combined **+15.98%** — and PEFT's effectiveness correlates with how much user data exists, so
   "RAG is a better choice for cold-start users." ([LaMP-Benchmark README](https://github.com/lamp-benchmark/lamp))

**The concrete implication for Weport.** The current design spends its budget on (a) five markdown files that
are *the model's own prose about the user*, and (b) BM25 retrieval keyed on *topic*. Both are the weak channel.
The strong channel is **a small number of the user's own verbatim utterances, selected for the situation at
hand, and placed where the model treats them as text to continue rather than text to obey.**

### 0.1 The single most under-appreciated finding: "show, don't tell" is measurable

The 2509.24930 result is worth restating because it is the strongest empirical argument in this document.
"When the first half of each essay establishes a strong stylistic manifold, both models remain within it during
continuation, rendering their outputs virtually indistinguishable from the original author."

Translated to WeChat: **do not ask the model to write a message in the user's voice. Give it the last few real
turns of the actual conversation (them + the user) and ask it to continue.** Style transfer from a description
requires the model to *guess* what the description implies. Style continuation from real text requires it to
*extrapolate* a distribution it can see.

There is a second, orthogonal lesson in the same paper: **stylistic fidelity and statistical detectability are
separable.** Even at 99.9% authorship agreement, the imitations had mean perplexity **15.2–16.07** vs **29.5**
for human text — at a threshold of 20, ~90% of AI text fell below vs ~15% of human essays. A clone can pass an
authorship test and still be "too smooth." That is a separate knob (see §4.5, §5.3).

---

## 1. Exemplar / observation-based style conditioning ("show, don't tell")

### 1.1 The convention as it exists in the wild

**Character Card V2** (`chara_card_v2`) is the de-facto interchange format across SillyTavern, Agnai, Chub,
Risu and others. The example-dialogue field is `mes_example`:

```ts
type TavernCardV2 = {
  spec: 'chara_card_v2'
  spec_version: '2.0'
  data: {
    name: string
    description: string
    personality: string
    scenario: string
    first_mes: string
    mes_example: string          // <- example dialogue lives here
    creator_notes: string        // MUST NOT be used inside prompts
    system_prompt: string
    post_history_instructions: string
    alternate_greetings: Array<string>
    character_book?: CharacterBook
    tags: Array<string>
    creator: string
    character_version: string
    extensions: Record<string, any>
  }
}
```
([spec_v2.md, malfoyslastname/character-card-spec-v2](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md),
[SillyTavern's own spec-v2.d.ts](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0/src/types/spec-v2.d.ts))

Note `creator_notes`: the spec explicitly says its value **MUST NOT** be used inside prompts — the format
designers already learned that "notes about the character" and "the character speaking" are different channels.

**SillyTavern's rendering of `mes_example`** (this is the load-bearing implementation detail):

- Each example block starts with a literal `<START>` tag.
- `{{char}}:` and `{{user}}:` prefix the turns.
- `<START>` is **not** sent to the model — it is replaced by the "Example Separator" (text-completion APIs) or by
  the contents of the "New Example Chat" utility prompt (chat-completion APIs).
- **Example blocks are only inserted if there is free context space, and they are evicted block by block as the
  chat grows.** ([SillyTavern characterdesign.md](https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Characters/characterdesign.md))
- The docs are blunt about the budget tradeoff: "If you're working with an AI model with a 2048 context token
  limit, a 1000-token character definition cuts the AI's 'memory' in half... a decent response from a good AI can
  easily be around 200-300 tokens. In this case, the AI would only be able to 'remember' about 3 exchanges worth
  of chat history."

**That eviction rule is the design lesson.** SillyTavern treats example dialogue as *discretionary context that
competes with, and loses to, real conversation* — which is correct for roleplay and exactly backwards for a
personal clone, where the exemplars **are** the voice and the "conversation" is 104k messages of the user's own
text. Weport's ~25k-char system prompt currently gives the persona MDs the privileged, non-evictable slot and the
person's actual words the evictable one.

**Character.AI "Dialog Definitions"** — the oldest consumer implementation. Syntax is strict:
`name: something they said` (name, colon, space, text; multiline allowed). The docs recommend placeholders
`{{char}}` and `{{random_user_1}}` so example dialogue does not leak a hard-coded name. Two things the docs say
that matter here:

- "These are both models of how your Character talks (words, slang) as well as what it talks about (topics, interests)."
- "sometimes, for some Characters, less can be more... giving the system just a creative greeting, which then
  causes it to invent the rest of the context itself, may actually produce better results than a carefully
  crafted Definition."
  ([character.ai dialog definitions](https://book.character.ai/character-guide/advanced-creation/dialog-definitions),
  [advanced creation](https://book.character.ai/character-guide/advanced-creation)) — *Note: direct fetch of these
  pages failed from this environment; content is quoted from search-index excerpts of the official pages.*

**Chub** uses the same `<START>` convention and exposes `{{example_dialogue}}` as a reorderable prompt macro
alongside `{{personality}}`, `{{scenario}}`, `{{memory}}`, `{{summary}}`, `{{profile}}`. The documented "Normal"
order is: system prompt → character definitions → chat history → post-history instructions → prompt note →
assistant prefill. ([docs.chub.ai character-creation](https://docs.chub.ai/docs/the-basics/character-creation),
[docs.chub.ai prompting](https://docs.chub.ai/docs/advanced-setups/prompting))

**JanitorAI's official guidance** is the opposite of SillyTavern's and is closer to what Weport needs: it suggests
putting **dialogue examples inside the personality/definition block** (i.e. permanent, non-evictable tokens)
rather than in the evictable example-dialogue field, and caps the whole thing at **~2,500 permanent tokens**,
warning that going past it "can run you the risk of quicker memory degradation."
([JanitorAI character creation overview](https://help.janitorai.com/en/article/the-basics-the-character-creation-page-overview-15xevon/),
[Faylua's bot creation guide](https://help.janitorai.com/en/article/bot-creation-guide-w-images-by-faylua-8jcbw1/))

### 1.2 What the community says actually works (numbers)

The strongest practitioner statements, all converging on "2–3 short exchanges, and *not* adjectives":

- "Add two or three example dialogue lines to lock in the voice... Example messages are the most direct way to fix
  a voice. If the character should be terse and dry, show a terse, dry exchange. The model imitates the pattern."
  ([TavernSprite, SillyTavern card best practices](https://tavernsprite.com/blog/sillytavern-character-card-best-practices/))
- "Two or three sample exchanges... The most powerful and most skipped field on the whole card. Examples teach
  voice by demonstration in a way no adjective ever can — the model literally pattern-matches the rhythm, the word
  choices and the action-to-speech ratio you put here." And the failure mode: "**No example dialogue** — the
  single most common reason a character drifts into a flat, generic assistant voice. Without samples to imitate,
  the model has only adjectives to work from, and adjectives are easy to ignore. You can write 'sardonic' ten
  times and still get a chirpy helper."
  ([RPDATE, How to Write an AI Character Card](https://rpdate.com/en/blog/how-to-write-ai-character-card))
- "Aim for 3-5 exchanges like this to give the AI a clear pattern." ([MiniTavern card-from-scratch guide](https://blog.mini-tavern.com/blog/sillytavern-character-card-creator-how-to-build-a-card-from-scratch-in-2026-488a51))
- Troubleshooting framing: "This often stems from a weak First Message or insufficient Example Messages... One or
  two short exchanges can work wonders." ([MiniTavern troubleshooting](https://blog.mini-tavern.com/blog/sillytavern-character-card-troubleshooting-fix-common-errors-and-improve-ai-resp-8eba3a))

**Synthesis of exemplar count:** the community range is **2–5 exchanges**, i.e. roughly **4–10 turns**. The
research range (see §1.3) is **5 shots** for style transfer tasks, and there is a documented *harm* from going
too far: in the roundtrip-TST study, "when provided with irrelevant examples at inference time, such as one word
long sentence examples for long discourses... the examples can even mislead the model and **lower the generation
quality compared to zero-shot inference**" — while similarity-selected examples "exhibit a much more stable
improvement." ([arXiv 2602.15013](https://www.arxiv.org/pdf/2602.15013))

And there is a hard negative on count from the style-retrieval direction: with **average style embeddings**, going
from **k=1 to k=3 hurt** (ROUGE-1 0.507 → 0.498, ROUGE-L 0.454 → 0.446). The authors' explanation is the one that
matters for Weport: "since we are choosing the document that most represents the author's style, any other
document could confuse the model if it deviates too much from the style of the author."
([RAGs to Style, Neelakanteswara et al.](https://doi.org/10.18653/v1/2024.personalize-1.11))

### 1.3 Exemplar *selection* at inference — the ranking questions

Three independent lines of evidence say: **select by similarity to the incoming turn, and select few.**

| Selection rule | Result | Source |
|---|---|---|
| Random examples | Baseline; "considerable improvements" from similar examples | [arXiv 2602.15013](https://www.arxiv.org/pdf/2602.15013) |
| Similar (cosine) examples | "up to **12.22 increase in BLEU** and **0.191 increase in [style accuracy]**"; also "much more stable" than random | same |
| Style-embedding retrieval (mean author embedding, cosine) | Beat non-personalised **and** BM25 **and** Contriever on LaMP-7U/7T | [RAGs to Style](https://doi.org/10.18653/v1/2024.personalize-1.11) |
| k=1 vs k=3 (style embeddings) | k=1 better | same |
| Author features + contrastive examples | "up to **15% relative** improvement over baseline RAG" | [arXiv 2504.08745](https://arxiv.org/html/2504.08745) |
| TopK retrieval then rerank (TopK+ConE) | Beats TopK; **30 candidates** retrieved then reranked; 4-shot (small models) / 8-shot (large) | [ACL 2024, Revisiting Demonstration Selection](https://doi.org/10.18653/v1/2024.acl-long.492) |
| Retrieval query = *reasoning path*, not the question | "Iterative Demonstration Selection" beats similarity-only and diversity-only; the optimal dimension is task-specific | [arXiv 2310.09881](https://arxiv.org/html/2310.09881v4) |

**Two techniques from 2504.08745 you can implement today, offline, with zero LLM calls:**

1. **Author features** — inject the person's *own statistics* next to their samples. The paper formats them as a
   literal sentence: `{feat_def} for the writer is {feat_value}`. Features used: average sentiment polarity,
   subjectivity, SMOG index, adverbs (`ADVU`), adjectives (`ADJU`), pronouns (`PU`), word frequency (`WF`),
   named entities, dependency patterns (`DPF`). **"We choose the top 10 most frequent elements for frequency
   features, since our experiments showed that more than 10 does not change the performance."**
2. **Contrastive examples** — retrieve samples **from other authors** into the same prompt, "to help LLM identify
   what makes an author's style unique in comparison to others." CE "offers at least a 1% increase regardless of
   the dataset"; **3 samples from different authors beat 5** ("possibly due to increased noise"); and in one task
   CE was the single best feature. Data point that matters for the informal end: "LaMP-7 is about tweets, which
   are highly personal and informal, [so] dependency patterns better highlight individual's styles."

   **Weport translation:** the corpus contains 184 conversations — *other people's messages are already on disk*.
   A "them vs. me" contrastive block costs nothing to build and is the cheapest novel idea in this whole document.

**Why "show, don't tell" wins in practitioner terms** — the mechanism is stated crisply by a prompting guide:
"A model predicts the next word from everything in its context. Style instructions and example text shift those
predictions toward the register you want — they don't change the model, just the local probabilities for this one
response." And the anti-pattern: "single adjectives underspecify. 'Be professional,' 'make it friendly,' 'keep it
casual' — each word covers a huge range, and the model fills the gap with its own average guess."
([AI/TLDR, Prompt for tone and style](https://ai-tldr.dev/learn/prompt-engineering/prompting-basics/prompt-for-tone-and-style/))

**The leakage trap, stated by a practitioner:** "Watch for the example leaking into the content. If your style
sample mentions 'June 30,' the model may copy that date into an unrelated answer. Pick anchor text whose topic
differs from the real task so only the voice transfers, not the facts." (same). This is precisely the risk the
Weport docs already identified when they removed the static `language.md` example list ("模型要么整段照抄要么完全
忽略"). The fix is not fewer exemplars — it is **topic-matched, dynamically selected exemplars**, which is §2.

### 1.4 The "profile → markdown → prompt" critique, with numbers

A published case study of a commercial voice-cloning tool (Noren) on an author **not** in the model's training
data (Gabriel Pickard: 7 blog posts + 100 tweets) produced a **367-line profile with 50+ extracted patterns** and
then measured the generated output per generator:

| Generator | Blog score (/5) | Thread score (/5) |
|---|---|---|
| Opus | 2.8 | 2.4 |
| Sonnet | 4.0 | 3.6 |
| Gemini | 3.2 | 3.6 |

Two findings from that writeup are worth carrying:

- **The same profile produces very different quality per model.** "Opus treated the voice profile as a checklist.
  ... Opus found it in the profile, slotted it into position one. Checkbox ticked." while Sonnet "absorbed the
  voice patterns and deployed them where they belonged." "No single model wins all voices."
- **A pattern is only correct in context.** The profile said the author uses the phrase "Well, I have come to tell
  you" — but "it's a mid-essay move, never an opener."
  ([Noren case study](https://usenoren.ai/blog/gabriel-pickard-case-study))

The productised version of this idea (Syxo) specifies a voice prompt as **500–800 words in five sections**
(voice essence / mechanical rules / banned words / tone by context / signature moves), derived from **10–20 real
samples**, with **8 mechanical rules** (sentence-length range, paragraph-length range, contractions, punctuation
preferences, sentence-opening patterns, list-vs-prose, active/passive ratio, typical word count) and **15–30
banned phrases**. Their diagnosis of the failure mode is the same one Weport hit: "**Abstract nouns instead of
concrete examples**... Fix: 'Always use specific numbers, named scenarios, dollar amounts.'"
([Syxo voice prompt guide](https://www.syxoai.com/guides/ai-voice-prompts-complete-guide))

An independent engineer's writeup of building a personal writing skill makes the same architectural choice:
"instead of describing the voice in the abstract, I had Claude read through five of my published posts and pull
out the actual recurring mechanics... Those patterns got written down as a reference document **with real excerpts
attached**, not just rules, since a rule like 'use self-deprecating humor' is a lot less useful than the actual
sentence that demonstrates it." And the fix for AI tells was a **banned-list**, applied to the skill's own
instructions: "I found it was riddled with em dashes I hadn't asked for and didn't want, and instead of just
fixing that one draft, had the rule baked directly into the skill itself, plus scrubbed the em dashes out of the
skill's own instructions so it wouldn't keep modeling a pattern it was now supposed to avoid."
([Eero Nevaluoto, Teaching Claude to Write Like Me](https://nevaluoto.fi/posts/teaching-claude-to-write-like-me-building-a-blog-post-skill/))

---

## 2. Retrieval design for STYLE rather than FACTS

### 2.1 What to retrieve *from*: the pragmatic-function argument

The user's failure mode is "a greeting gets a fact." That is an IR problem, and the relevant framing already
exists: retrieval-based dialogue systems select a *response* for a *context*, not a document for a query. The
survey framing of the task is "response selection": "aiming at ranking response candidates by calculating
semantic relevance between the dialogue context and response candidates."
([RSM-DCK, Learning to Detect Relevant Contexts](https://arxiv.org/html/2509.22845v1))

The key structural insight from that paper, directly transferable: **"different parts of the context and
knowledge are differentially important for recognizing the proper response candidate, as many utterances are
useless due to the topic shift."** Their fix is two-pass — use the *recent* context as a query to pre-select
relevant context, then post-select with the response candidate.

**And the decisive empirical result for context length** comes from dialogue-act recognition: at the *dialog*
level (4 classes), "XLNet never correctly recognized more than half of the label set (24 dialog act classes)" at
turn level, and context fixed it so decisively that "without it, more than 50% of dialog act classes were never
correctly recognized even once in SWDA. With the inclusion of context, that number decreased to less than 10%."
([What Helps Transformers Recognize Conversational Structure? TACL 2021](https://aclanthology.org/2021.tacl-1.69.pdf))

That paper also contains the single most useful *deterministic* finding for Weport: **punctuation is a first-class
pragmatic signal.** "Removing the capitalization and punctuation has a significant effect on the dialog act
recognition. It suggests a strong correlation between punctuation and dialog acts." Their numbers: MRDA
segmentation error (DSER) 14.2% on original transcripts vs **32.9%** on lowercased, unpunctuated transcripts;
SWDA 8.4% vs **17.5%**. "No other factor influences the results as much."

**Implication for Weport:** the retrieval key should include the *shape* of the incoming message
(length, terminal punctuation, whether it is a question, whether it is an emoji-only turn, whether it is a
greeting) — not only its tokens. Two messages with the same topic but different pragmatic function must retrieve
different exemplars. There is a directly relevant WeChat-specific study proving that punctuation carries speech-act
information in this exact medium: of 543 WeChat messages with sentence-final tildes (~), **89.32%** performed
speech acts rather than implying sounds, with expressives (41.07%) and directives (24.31%) dominating
representatives (15.84%) and commissives (8.10%); interviewees described the tilde as softening directness and
narrowing distance. ([Digital tildes in Chinese WeChat messages, LASS](https://doi.org/10.1515/lass-2023-0009))

**Thread retrieval (retrieve whole exchanges, not isolated lines)** is supported from the conversation-analysis
side for WeChat specifically. WeChat typed talk is "quasi-synchronous," adjacency is frequently broken by inserted
turns, and the platform's own fix is the **quoting/citing affordance** (WeChat 7.0.9, 2019): "it is sometimes
difficult to respond to an earlier utterance without repeating it verbally. Since it has been intervened by
pieces of more recent utterances, understanding based on adjacency or coherent pairing sometimes becomes
difficult or even impossible. With the affordance of the citing function, the earlier utterance... is 'inserted'
in the current context in a marked way... In so doing, adjacency is recovered."
([Naturalness of WeChat typed talk, Frontiers in Communication](https://public-pages-files-2025.frontiersin.org/journals/communication/articles/10.3389/fcomm.2023.994192/pdf))

The same paper documents other WeChat-native phenomena a clone should reproduce and a line-level retriever
destroys: **message recall** (2-minute window, leaves a visible "对方撤回了一条消息" trace), **bracket
annotation** for spontaneous monitoring, **tickling** (拍一拍), and **turn-internal fragmentation**. None of these
exist at the single-message level.

### 2.2 BM25 vs embeddings vs hybrid for short informal utterances

**BM25 is mis-parameterised for short documents, and there is a mathematical result for it.** In microblog
retrieval, Ferguson et al. found "the closer to zero the free parameters were set in BM25, the better the
performance achieved" — and the follow-up analysis shows *why*: "by setting those parameters close to 0, we are
disregarding the document length normalisation component altogether. Thus for all intents and purposes **BM25
becomes IDF**." The paper also flags that in short documents, increasing TF is treated as *more* relevant, which
"would seem counter-intuitive in a document with such a limited length, as users normally struggle to fit their
messages. Additionally, there is a danger of promoting spam messages which may only contain the query terms."
([Microblog retrieval challenges and opportunities](https://exa.ai/library/publication/zyfn6wg5q2l8l5j37s87cnk2))

The same work reports strong gains from **offsetting TF and DL by +20** in language models: "+15.79% Precision@30
over the previous combination and a very substantial **+29.41% over the baseline** (no offsets) configuration."

**Weport's BM25 currently uses full-message chunks (up to 12,000 messages per session) with a length term.** For a
corpus of 2–20-character WeChat lines, the `b` parameter's length normalisation is doing something meaningless at
best and harmful at worst. This is a **measurable, cheap experiment**: sweep `k1 ∈ {0.0, 0.3, 0.9, 1.2}`,
`b ∈ {0.0, 0.3, 0.75}` on the held-out harness (§5) and report the curve.

**Dense retrieval is not automatically better, and the honest ranking is:** for *personalisation*, style
embeddings > BM25 > semantic similarity in the one head-to-head study; but "style proves to be **marginally**
superior." ([RAGs to Style](https://doi.org/10.18653/v1/2024.personalize-1.11)) And even a **random** selection
from the user profile "leads to performance improvements compared to non-personalized prompts."
([LaMP](https://aclanthology.org/2024.acl-long.399.pdf))

**Hybrid fusion: use RRF, tune nothing.** Reciprocal Rank Fusion, `RRF(d) = Σ_r 1/(k + r(d))` with **k = 60
fixed during a pilot investigation and not altered during subsequent validation**, "outperforms Condorcet,
CombMNZ and the best system by 4% to 5% on average," with sign tests at p ≈ 0.008–0.04.
([Cormack, Clarke, Büttcher, SIGIR 2009](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf))

Elastic's measurements: **RRF increases average NDCG@10 by 1.4% over the sparse-encoder model alone and 18% over
BM25 alone**, and is "either better or similar to BM25 alone for all test data sets", requiring "no model tuning,
training data sets, or specific calibration." They contrast this with linear score fusion, which "yields better
average NDCG@10 than RRF" but "the optimal weight is model specific" — "in our view, linear combination is not a
'plug and play' approach." ([Elasticsearch Labs, Hybrid retrieval](https://www.elastic.co/search-labs/blog/improving-information-retrieval-elastic-stack-hybrid))

Weaviate's default for its hybrid is `alpha = 0.75` (toward vector) and its default fusion is
`relativeScoreFusion` (min-max normalise each list, then weighted sum) rather than `rankedFusion` (RRF with
k=60) — with the reasoning that RRF "keeps only the position of a result in each list and discards the scores."
([Weaviate, Hybrid Search Explained](https://weaviate.io/blog/hybrid-search-explained)) That is a real argument
against RRF when your score distribution is informative. For Weport, RRF is still the right default because it
is the only fusion that requires no calibration and no training data.

**Can Weport do embeddings with no GPU?** Yes. `transformers.js` runs ONNX models in Node/Electron on **CPU via
WASM** by default, with int8 quantisation as the WASM default, and there is a maintained Electron example in the
repo. ([transformers.js README](https://github.com/xenova/transformers.js/blob/main/README.md),
[npm @xenova/transformers](https://registry.npmjs.org/@xenova/transformers)) A packaged precedent:
`3p3r/cpu-embeddings` bundles a quantised `all-MiniLM-L6-v2` ONNX model and runs "entirely on CPU without
requiring GPU acceleration" with `numThreads` control. ([3p3r/cpu-embeddings](https://github.com/3p3r/cpu-embeddings))
Cost caveat: the app's existing retrieval budget is ~334–929 ms per turn; an ONNX MiniLM pass over 21,201 chunks
is not free, so the realistic design is **BM25 prefilter → embed only the top ~300 candidates → rerank**, not
embed the whole corpus per query. (Embedding the corpus *once* at scan time is fine — 21k short lines.)

### 2.3 Diversity (MMR), and why it is anti-indicated here

MMR: `MMR = λ·relevance − (1−λ)·max_similarity_to_selected`, iteratively selecting. Elastic's guidance:
"Product Discovery (λ=0.3-0.5): Emphasize diversity... Precision Search (λ=0.7-0.9): Prioritize relevance when
users know what they want... **Start with λ=0.7 for a relevance-leaning approach.**" They also note the cost:
"the algorithm computes similarities between candidates and selected items. For production systems, consider
limiting the reranking depth to a top k."
([Elasticsearch Labs, MMR](https://www.elastic.co/search-labs/blog/maximum-marginal-relevance-diversify-results),
[Elastic diversify retriever docs](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/diversify-retriever))

**The tension with §1.3 must be resolved explicitly.** "Diversity" has two meanings:

- *Redundancy removal within one style class* — good, and what MMR does.
- *Style-class mixing* — **actively harmful** for a style clone: "any other document could confuse the model if
  it deviates too much from the style of the author." ([RAGs to Style](https://doi.org/10.18653/v1/2024.personalize-1.11))

So: apply MMR **inside** the already-selected style stratum (i.e. after conditioning on recipient + pragmatic
function), at λ ≈ 0.7–0.8, and never across strata. And keep k low: style retrieval got **worse** from k=1 to k=3.

### 2.4 Recency weighting

LaMP tested a **Recency** retriever (`select the latest item in the user profile based on time`, available only in
the time-separated setting) against random, BM25, and Contriever. Result: "Contriever demonstrates the best
performance for most classification tasks... **Recency only outperforms Contriever in LaMP-3T**. Note that recency
is considered as a simple yet strong personalization signal in search and recommendation."
([LaMP](https://aclanthology.org/2024.acl-long.399.pdf))

Recency is strong *when the task is time-anchored* and weak when it is not. For Weport's corpus (6 months,
2026-03 → 2026-09) this is a **measurable** question, not a design opinion: hold out the last month and compare
uniform weighting vs exponential decay at several half-lives. Note also the temporally-aware memory line of work
argues strongly against naive dialogue-time recency: "using the dialogue timeline alone can cause the system to
store or retrieve memories under the wrong time context" when users discuss future plans or past events — and
consolidating temporally continuous material into *durative* memories gave up to **12.2% absolute** accuracy gain
in one framework. ([Temporal Semantic Memory, ACL Findings 2026](https://aclanthology.org/2026.findings-acl.1496.pdf))

---

## 3. Deterministic / statistical style capture that does not go through an LLM

This whole section is implementable in TypeScript with zero model calls, is fully reproducible, and — per the
project's own note in `docs/agents/weclone.md` ("风格指纹是算出来的，不是问出来的") — is already the right
instinct. The question is whether the *feature set* is right.

### 3.1 Function words: the oldest and most robust signal

- Mosteller & Wallace's Federalist work established that "a small number of the most frequent words in a language
  ('function words') could usefully serve as indicators of authorial style," and "it has proven quite difficult to
  improve on the general usefulness of function words." The mechanism: "Due to their high frequency in the
  language and highly grammaticalized roles, function words are very unlikely to be subject to **conscious
  control** by the author." ([Measuring the Usefulness of Function Words for Authorship Attribution](https://hcmc.uvic.ca/eol/ach.allc.2005/xhtml.xq%3Fid=162.html))
- The **head-to-head numbers**, which are unusually clean: on 20 novels split by chapter, with the 200 most
  frequent features — **frequent words 99.00% author accuracy** vs frequent pairs 91.60% vs collocations (k=5)
  88.94% vs collocations (k=10) 84.00%. The authors attribute it partly to scale: "using more training texts than
  features seriously reduces the likelihood of overfitting."
  ([same](https://hcmc.uvic.ca/eol/ach.allc.2005/xhtml.xq%3Fid=162.html))
- **Burrows's Delta** and what actually makes it work: "**feature vector normalization**, that is, the
  transformation of the feature vectors to a uniform length of 1 (implicit in the cosine measure), is the decisive
  factor for the improvement of Delta... the information particularly relevant to the identification of the author
  of a text lies in the **profile of deviation across the most frequent words** rather than in the extent of the
  deviation or in the deviation of specific words only."
  ([Understanding and explaining Delta measures](https://doi.org/10.1093/llc/fqx023))
- Hoover's refinement: "removing **personal pronouns** and words for which a **single text supplies most of the
  occurrences** greatly increases the accuracy of Delta tests." And: "much larger numbers of frequent words are
  even more accurate than the 150 that Burrows tested." ([Testing Burrows's Delta](https://doi.org/10.1093/llc/19.4.453))
- Why the whole approach is defensible: "less than **0.04%** of our vocabulary accounts for over half the words we
  actually use in daily speech" (Chung et al. 2007, p. 347, quoted in), and the four methodological advantages of
  function words: all same-language authors use the same set (reliable comparison base), high frequency (many
  observations), **"The use of function words is not strongly affected by a text's topic or genre"**, and
  **"seems less under an author's conscious control."**
  ([Function Words in Authorship Attribution: From Black Magic to Theory?](https://aclanthology.org/anthology-files/anthology-files/pdf/W/W14/W14-0908.pdf))

**This property — topic-independence — is exactly what a style clone needs and what BM25-over-topics cannot give
you.** For Weport, two caveats must be handled:

1. The corpus is **code-mixed**. A function-word list must be built for *both* strata and not merged (the app
   already learned this with n-grams: "中英两种语料要分开统计... 中文与英文分成两组分别渲染").
2. For Chinese, the corresponding result is **function characters**: the CCTAA corpus uses "**819 common function
   character n-grams**... including 262 unigrams, 545 bigrams, ten trigrams, and two quadgrams" transcribed from a
   Chinese function-word dictionary. Notably, on cross-topic Chinese newswire, both an SVM over those features and
   a Chinese RoBERTa baseline "perform below expectations" — "None of the models can be evaluated as 'useful' in
   real-world applications." ([CCTAA, LREC 2022](https://aclanthology.org/2022.lrec-1.633.pdf)) The reassuring
   reading: they deliberately built the corpus so that **only non-topical style information** could help, and got
   a hard task. The warning: **do not expect authorship-grade accuracy from Chinese function characters alone.**

### 3.2 A ready-made feature schema (copy the counts, not the code)

`writeprints-static` (Brennan, Afroz & Greenstadt 2012, adapted from Abbasi & Chen 2008) publishes its feature
inventory with exact cardinalities — a directly implementable checklist:

| Group | Category | No. of features | Description |
|---|---|---|---|
| Lexical | Word level | 3 | Total words, average word length, number of short words |
| | Character level | 3 | Total char, percentage of digits, percentage of uppercase letters |
| | Special characters | 22 | Frequency of each of 22 special characters |
| | Letters | 26 | Letter frequency |
| | Digits | 10 | Digit frequency |
| | Vocabulary richness | 1 | Ratio of hapax and dis legomena |
| Syntactic | Function Words | **153** | Frequency of function words |
| | POS tags | 12 | Frequency of universal POS tags |
| | Punctuation | 9 | Frequency and percentage of colon, semicolon, qmark, period, exclamation, comma, single inverted comma, double inverted comma |

([ashenoy95/writeprints-static](https://github.com/ashenoy95/writeprints-static))

The parent paper (Writeprints, ACM TOIS 2008) is the canonical "style fingerprint" reference and reports
"accuracy as high as **94% when differentiating between 100 authors**" on email / instant messaging / feedback
comments / source code, using lexical, syntactic, structural, content-specific and idiosyncratic features, with
**information gain** for feature selection and **individual-author-level** feature sets (one-against-all) —
"individual-author-level feature sets generally outperformed use of a single group of attributes."
([Writeprints, ACM TOIS 26(2)](https://doi.org/10.1145/1344411.1344413), [PDF](https://ahmedabbasi.com/wp-content/uploads/J/AbbasiChen_Writeprints_ACMTOIS.pdf))

Also worth stealing from Writeprints: **"pattern disruptors"** — "All key attributes in an author's feature set
that the author **never uses** are treated as pattern disruptors, where the occurrence of these features in an
anonymous identity's text decrease the similarity." For a personal clone, the *never-used* set is as
characterising as the used set: the user apparently never uses `~`, never uses `。`, never uses em dashes. Those
are **prompt-ready negative constraints** (§4.5) and they fall straight out of the fingerprint.

### 3.3 Punctuation and casing profiles (the strongest cheap signal for short informal text)

Evidence that this is *the* high-yield axis for messaging:

- Dialog-act recognition: **"No other factor influences the results as much"** as punctuation + original casing
  (DSER 14.2% → 32.9% when removed). ([TACL 2021](https://aclanthology.org/2021.tacl-1.69.pdf))
- A dedicated punctuation-based authorship tool: nine quantitative features "including metrics such as average
  words per sentence and the frequency of specific punctuation marks (e.g., commas, semicolons)" was "able to
  reliably distinguish" Dickens/Hemingway/Poe.
  ([Experimental Modeling of Writing Styles for Authorship Verification via Punctuation Analysis](https://doi.org/10.1016/j.procs.2025.12.122))
- WeChat-specific: sentence-final **~** is overwhelmingly a *pragmatic* marker, not decoration (89.32% speech
  acts; expressives 41.07%, directives 24.31%). ([LASS](https://doi.org/10.1515/lass-2023-0009))

The same paper names the next things to profile in Chinese messaging, which the Weport fingerprint should cover as
a checklist: "other innovative punctuation marks, such as repeated Chinese full stops ('。。。'), left parenthesis
('(') in digital interaction, the combined uses of punctuation (e.g., '∼∼∼!!!')".

*Verified-but-limited*: I confirmed the feature **inventory** recommended by `pystylometry` (50+ metrics across 11
modules including a `stylistic` module with "Contractions, hedges, intensifiers, modals, punctuation, vocabulary
overlap") and `styloscope`'s exact output file set (`punctuation_distribution.csv`,
`function_word_distribution.csv`, `pos_profile.csv`, `length_statistics.csv`, `word_length_distribution.csv`,
`lexical_richness_statistics.csv`, `dependency_profile.csv`) as useful *shapes* for Weport's own output — but I have
not benchmarked either tool and neither is a dependency recommendation for a TS app.
([craigtrim/pystylometry](https://github.com/craigtrim/pystylometry), [clips/styloscope](https://github.com/clips/styloscope))

### 3.4 Catchphrase mining with actual significance testing

The single most valuable methodological finding in this section: **the naive approaches are known to produce
garbage, and the fix is published with parameters.**

From Monroe, Colaresi & Quinn, *Fightin' Words*:

- Naive log-odds with infinite values → "the partisan word list consists of only those spoken by a single party"
  and "the most extreme words are obscure ones."
- "Add a little bit to the zeroes" (0.5) → still bad: "Words with plausible partisan content on abortion
  (*infant*, *church*) are **overwhelmed by oddities** that require quite a bit more investigation to interpret
  (*Chines*, *bankruptci*). ... this measure will be inappropriately dominated by obscure words."
- **The fix: a log-odds-ratio with an informative Dirichlet prior.** "we can use the observed proportion of words
  in the vocabulary in the context of Senate speech, but across multiple Senate topics... **We set α₀ to imply a
  'prior sample' of 500 words per party every day, roughly the average number of words per day used per party on
  each topic in the data set.**" Effect: "For example, the Republican top 20 list has shuffled, with *the, you,
  not, of,* and *be* being replaced by the considerably more evocative *aliv, infant, brutal, brain,* and
  *necessari*."
- The shrinkage is scale-aware: "The prior used in this example has almost no effect on estimates in topics with
  much more speech and strong partisan differences... and overwhelms estimates—as it should—in topics with very
  little speech."
  ([Fightin' Words, Political Analysis](https://doi.org/10.1093/pan/mpn018), [PDF](https://languagelog.ldc.upenn.edu/myl/Monroe.pdf))

And the caution that tells you **not** to use χ² / log-likelihood-ratio as your significance test: Lijffijt et al.
find those tests "anti-conservative, that is, their p-values are excessively low, when we assume that a corpus is
a collection of statistically independent texts," and "the log-likelihood ratio test marks spurious differences as
significant... We recommend the use of the **t-test, Wilcoxon rank-sum test, or bootstrap test** for comparing
word frequencies across corpora," because those "take into account the distribution of the word within the corpus"
(dispersion, `DPnorm`). ([Significance Testing of Word Frequencies in Corpora](http://users.ics.aalto.fi/lijffijt/articles/lijffijt2015a.pdf))

**Applied to Weport's "口癖黑话词典":** the current design groups catchphrases "按时间波次分组" but the docs do
not state a significance criterion. A Dirichlet-smoothed log-odds with a dispersion-aware test converts "high
frequency fragments" from a curiosity into a ranked, defensible list — and it is pure TypeScript, no model call.

Alternative when you want *phraseness* and *informativeness* separated: pointwise KL divergence between a
foreground and background language model, with the explicit note that "pointwise MI... does not assign a high
score to a rare phrase" and that pointwise KL "seems more robust in sparse data situations" than a plain
likelihood ratio, which "has a tendency to pick up rare words as informative."
([A Language Model Approach to Keyphrase Extraction](https://aclanthology.org/W03-1805.pdf))

### 3.5 Emoji and emoticon profiles

Two hard numbers from a study that isolated these features:

- **Frequency of emoji use is strongly influenced by the conversation partner** — participants converged toward
  a conversation leader's emoji behaviour despite similar self-reported habits (self-reported "normal" emoji use:
  non-leaders in the emoji condition 3.4; non-leaders in the non-emoji condition 2.3). So emoji *rate* is partly
  situational, not purely authorial.
- **Despite that, they remain authorship markers of differing strength** in a mock attribution task:
  **emoji functions → ~33% correct; emoji types → 50%; emoticons → 100%** (only three participants "consistently
  used emoticons", but with those, "the authorship attribution yielded the best overall results with a 100%
  correct identification rate"). The authors' conclusion: "the use of emoticons appears to be the most individuating
  in the present dataset, followed by the types of emoji, and with the emoji functions performing the worst,"
  supporting Sousa Silva et al. (2011) where "emoticons outperformed all other investigated measures of authorship."
- Correlations with personality were weak/moderate at best: emoji use vs agreeableness 0.507 and emotional
  stability 0.456 (non-leaders only); emoticon use vs emotional stability 0.305; extraversion 0.208.
  ([“Depends on Who I'm Writing To”, Frontiers in Communication](https://www.frontiersin.org/journals/communication/articles/10.3389/fcomm.2022.840646/full))

**Implication:** profile emoji **types** (and emoticon/kaomoji usage) rather than emoji count, and condition the
*rate* on the recipient (convergence), not on the author alone.

### 3.6 Typo / abbreviation dictionaries mined from the corpus

Two published, directly reusable methods:

1. **Distributional similarity + string re-ranking.** Generate (OOV, IV) candidate pairs by finding "the most
   distributionally-similar IV type for each OOV type," then "re-rank the extracted pairs by string similarity"
   and take the top-n. This handles `tmrw → tomorrow`, `2day → today`, `nite → night`. The decisive detail:
   **ranking by string similarity beats ranking by OOV frequency or by IV-word frequency**, because the frequency
   baselines surface proper nouns (`Facebook`, `Youtube`) rather than variants.
   ([Automatically Constructing a Normalisation Dictionary for Microblogs, EMNLP 2012](https://aclanthology.org/D12-1039.pdf))
2. **Cascaded dictionary lookup + word similarity + context support.** `DL` alone "unsurprisingly achieves the
   best precision, but the recall... is not competitive. Consequently, Twitter normalisation cannot be tackled with
   dictionary lookup alone"; the best F-score comes from combining all three. Features: lexical edit distance,
   phonemic edit distance (double metaphone), prefix/suffix substring, longest common subsequence.
   ([Lexical Normalisation of Short Text Messages, ACL 2011](https://www.cl.uni-heidelberg.de/courses/ws13/twitternlp/han-baldwin-acl11.pdf))

**For Chinese pinyin abbreviations** (`yyds`, `xswl`, `awsl`, `666`, `520`, `内卷`, `躺平`, `破防`): a public,
community-maintained dictionary exists and is the standard practical resource —
[`nbnhhsh` ("能不能好好说话") by itorr, March 2020](https://toolshu.com/en/web/160), "a word-selection translation
tool designed to decode pinyin abbreviations commonly found on social media," with a community-contributed
dictionary and userscripts for Weibo, Tieba and Bilibili. A curated 41-term list with era/origin metadata is also
published ([RECATOOLS netspeak decoder](https://recatools.com/netspeak-decoder/)): `yyds` (永远的神, esports
commentary 2018 → mainstream 2020), `666` from Twitch/GG culture (溜), `awsl` (啊我死了, Bilibili bullet comments),
`内卷` (anthropology term, viral Sep 2020), `破防` (gaming → emotional usage since 2020). Era metadata is useful:
it tells you whether a term was *live* during the corpus window.

**Critical inversion for Weport.** Standard NLP mines abbreviation dictionaries in order to **normalise away**
these forms. A style clone must do the opposite: it needs a **preserve-and-reproduce** dictionary — for each
canonical concept, *which* surface variant does this user choose, at what rate, and with whom. Normalising
`u → you` before fingerprinting would delete the exact signal the user is complaining about.

### 3.7 How the statistics get into the prompt

Practitioner consensus is: **statistics as constraints, not as description.** The concrete, copyable shapes:

- **Syxo's 8 mechanical rules** (quantitative, range-based): "Sentence length range (e.g., '8-22 words, with
  frequent short sentences for emphasis)"; "Paragraph length range (e.g., '1-3 sentences per paragraph,
  one-sentence paragraphs allowed')"; contractions always/never/sometimes "and which contexts"; "Punctuation
  preferences (em dashes yes/no, semicolons yes/no, ellipses yes/no)"; sentence-opening patterns; list vs. prose;
  active/passive ratio; typical word count per format. Plus **15–30 banned phrases**, chosen because "The list
  closes the gap between 'your voice' and 'default AI vocabulary.'"
  ([Syxo](https://www.syxoai.com/guides/ai-voice-prompts-complete-guide))
- **Author-feature sentences** (`{feat_def} for the writer is {feat_value}`), top-10 elements only.
  ([arXiv 2504.08745](https://arxiv.org/html/2504.08745))
- **Negative constraints beat positive instructions for killing AI smell**: "A short banned-list — no em dashes,
  no 'In today's world,' no exclamation marks, don't start with 'Certainly' — removes the tells faster than any
  positive instruction. Models reliably honor concrete prohibitions."
  ([AI/TLDR](https://ai-tldr.dev/learn/prompt-engineering/prompting-basics/prompt-for-tone-and-style/))

**Design rule that reconciles this with the project's existing invariant:** `docs/agents/weclone.md` correctly
bans *preset example content* from the system prompt (it gets recited). It does **not** ban *computed numeric
constraints* in the system prompt. Numbers cannot be recited. The fingerprint's numbers are safe where the old
`language.md` sentence list was not — and the docs' own reasoning ("这批数字正是用来对账的") supports this.

---

## 4. Multi-stage generation pipelines and decoding control

### 4.1 Generate-then-restyle / draft-then-critique

**Self-Refine** is the canonical result: generate → same LLM gives feedback → refine, iteratively, no training.
"Across all evaluated tasks, outputs generated with Self-Refine are preferred by humans and automatic metrics over
those generated with the same LLM using conventional one-step generation, improving by **~20% absolute on average**
in task performance." Task-specific numbers:

- Dialogue Response Generation (GPT-4): preference **25.4% → 74.6%**.
- Code Optimization (GPT-4): **27.3% → 36.0%**.
- Sentiment Reversal: **43.2** (actionable feedback) vs **31.2** (generic feedback) vs **0** (no feedback).

**The load-bearing ablation is the feedback quality:** "specific, actionable feedback yields superior results."
And on iteration count: "on average, the quality of the output improves as the number of iterations increases."
([Self-Refine, NeurIPS 2023](https://arxiv.org/abs/2303.17651), [PDF](https://papers.neurips.cc/paper_files/paper/2023/file/91edff07232fb1b55a505a9e9f6c0ff3-Paper-Conference.pdf))

**Two-pass generation with a restyle pass** has direct support in the style-transfer literature. The
generate-then-refine pattern with a *style classifier* for attribution is used by Diff4TST, which re-masks and
regenerates only the tokens with the highest gradient attribution to the style mismatch — "iteratively improves
style compliance... without reinforcement learning or external reward models."
([Diff4TST, ACL 2026](https://aclanthology.org/2026.acl-long.306.pdf)) Weport cannot do gradient attribution
through a hosted API, but the *shape* — generate, score against style, regenerate — is exactly §4.4.

**The "sketch-first" retrieval trick** is a two-pass pipeline that is cheap and clever: "We first perform few-shot
inference with randomly selected examples to generate a **sketch** output that resembles the in-domain transferred
generation... We then use the sketch as the query to retrieve examples with high similarity from the Faiss vector
bank to enhance the second-round inference that yields the refined output." Reported effect of the retrieval stage:
"**up to 12.22 increase in BLEU** and **0.191 increase in [style accuracy]**"; "5-shot groups tend to have stronger
effects on both BLEU score and Acc. than 3-shot and 0-shot groups."
([arXiv 2602.15013](https://www.arxiv.org/pdf/2602.15013))

**Cost honesty.** This paper also confirms that a two-call pipeline *can* regress: "when provided with irrelevant
examples at inference time... the examples can even mislead the model and lower the generation quality compared
to zero-shot inference."

**Post-editing by a human does not fully fix it.** In a pre-registered study (n=81) where participants post-edited
LLM drafts of personal writing (wedding vows, apology letters), post-editing made text significantly more similar
to their own control writing (p = .0002, g = 0.55) and less similar to LLM text (p = .0002, g = −0.41) — **but
"post-edited text remained measurably closer in style to LLM-generated text than to participants' own fully
human-authored text, and it exhibited reduced stylistic diversity relative to human control writing."** And
participants "did not seem to perceive these residual stylistic markers."
([Can You Make It Sound Like You?, ACL 2026](https://aclanthology.org/2026.acl-long.2030.pdf))

The transferable lesson: **the first draft's style ceiling caps the final result.** "Increasing the creativity and
originality of initial LLM drafts may be a more impactful way to improve the utility of post-editing workflows, as
generic or clichéd drafts could limit their effectiveness, even if they are easy to restyle." A restyle pass on a
generic draft recovers less than getting the first pass right.

### 4.2 Best-of-N with a style scorer

- **BoN is theoretically sound if N is tuned.** "under minimal conditions on the quality of the reference model and
  learned reward model, properly tuned BoN is both computationally and statistically optimal in achieving high
  win-rate, partially explaining its widespread practical success." But naive BoN "is susceptible to
  reward-hacking... as N increases, the algorithm is more likely to select outputs on which r̂ and r* disagree,
  leading to performance that scales **non-monotonically** in N." The proposed fix is an
  E_M-divergence-regularised BoN that is "monotone in N."
  ([Revisiting the (Sub)Optimality of Best-of-N](https://arxiv.org/html/2603.05739v1))
- **TinyStyler's reranking is the concrete recipe for a *style* scorer**, and it is the one to copy: "We rank each
  output per inference using the **geometric mean of all three metrics** (G(G(Away, Towards), Sim)) and select the
  output with the highest score." Away/Towards come from **authorship embeddings**; Sim from **Mutual Implication
  Score**. After filtering, they kept **40K high-quality pairs**. Additional filters: "filter outputs with low
  scores on two meaning preservation metrics, MIS and SimCSE" plus low Away/Towards. TinyStyler (800M params)
  "outperforms strong approaches such as GPT-4" on authorship style transfer, using "**~0.5% the parameters of
  GPT-3.5**".
  ([TinyStyler, EMNLP Findings 2024](https://doi.org/10.18653/v1/2024.findings-emnlp.781),
  [arXiv 2406.15586](https://d6108366.hf-mirror.com/papers/2406.15586))

**Weport-realistic version:** generate N=4–8 candidates **in one API call** (OpenAI-compatible `n`), then pick
with a **deterministic offline scorer** — no second model call, no authorship-embedding model — combining
(a) authorship-verification distance to the user's centroid (char n-gram TF-IDF + cosine, see §5.2), (b) the
fingerprint's constraints (does it violate a banned-pattern or an emoji rate band?), (c) length-band agreement
with the user's distribution for this recipient. That is a fully local, sub-50 ms reranker. Cap N: the
reward-hacking result says monotonicity is not guaranteed, so **verify N=1 vs N=4 vs N=8 on the harness** rather
than assuming more is better.

### 4.3 Temperature, top-p, penalties — what is actually measured

The honest summary: **temperature is a weak creativity knob and a real coherence risk.**

- "We find that temperature is **weakly correlated with novelty**, and unsurprisingly, **moderately correlated with
  incoherence**, but there is **no relationship with either cohesion or typicality**... the influence of temperature
  on creativity is far more nuanced and weak than suggested by the 'creativity parameter' claim." One important
  detail: "Higher temperatures increase the odds of generating that diversity, but the measures indicate that it is
  **not essential**... even at lower temperatures (.334 < t < 1.0), there is an immediate effect on diversity."
  ([Is Temperature the Creativity Parameter of LLMs?](https://doi.org/10.48550/arxiv.2405.00492))
- Temperature is not the way to escape mode collapse. At **temperature 0.7, standard decoding collapsed in 92% of
  1000-token completions** (non-collapse rate **8%**); a geometric-regulation method (`RMR`) raised that to
  **56%**, and at a locked entropy target of 1.0 from **5% → 33%**. "Many studies have observed that lowering
  generation temperature increases the risk of looping." Standard setup in that work: **top-k 50, top-p 0.9**.
  ([Escaping Mode Collapse in LLM Generation via Geometric Regulation](https://arxiv.org/html/2605.00435v3))
- **Provider-specific defaults matter.** DeepSeek publishes its own guidance and it differs from OpenAI's: the
  reference table gives typical `temperature` of **0.0 code/math · 1.0 data analysis · 1.3 chat/translation ·
  1.5 creative**, `top_p` **1.0 (recommended default)**; and for local deployment "temperature = 1.0, top_p = 1.0",
  with the explicit warning "do not copy OpenAI or Claude defaults into DeepSeek without checking."
  ([DeepSeek API V4 reference guide](https://deepseekai.guide/api/deepseek-api-documentation/))
- OpenAI's own doc language, still the clearest statement of the interaction rule: "We generally recommend altering
  this or `top_p` but not both." Range: temperature 0–2, top_p 0–1 for chat completions.
  ([OpenAI chat completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/))

**A temperature/top-p sweep is therefore a required experiment, not an optional one** — and the expected shape
(based on the above) is that most of the gain comes from *exemplars*, with temperature contributing a small,
saturating novelty effect plus a coherence cost.

### 4.4 Repetition control: use the sequence-aware penalty, not the token-count penalties

The three penalties people confuse, with the practical ranges:

| Parameter | Mechanism | Typical usable range | Failure |
|---|---|---|---|
| `frequency_penalty` | subtracts proportional to **count** of prior occurrences | 0.1–1.0 | "high values start deleting legitimately repeated words like 'the'" |
| `presence_penalty` | subtracts fixed amount if token appeared **at all** | 0.1–1.5 | "a topic-diversity control that people reach for as a repetition control" |
| `repetition_penalty` (open-source convention, CTRL 2019) | **divides** the logit of seen tokens | >1.0; **"values above about 1.2 visibly damage fluency"** | asymmetric treatment of positive/negative logits |

All three are **blind to structure**: "a JSON generation with a repeated key, a table with a repeated column
header, or code with a repeated identifier is punished for being correct, and a frequency penalty is a common
undiagnosed cause of malformed structured output. They apply within a single response only, so they do nothing
about a model repeating itself **across turns**."
([Multigrid, Repetition Loops and Degenerate Output](https://multigrid.ai/learn/repetition-loops),
[DRY paper](https://arxiv.org/html/2608.22761))

**The better mechanism is DRY** (Don't Repeat Yourself): penalise a candidate token only when generating it
"would extend the current suffix into an exact continuation of a span seen earlier in the context," with
**sequence breakers** protecting chat templates and formatting, and an exponentially growing penalty
`λ·β^(n−L)`. Measured: **47% relative reduction in suffix-extension rate** vs uncontrolled baseline, "larger than
any other soft method we evaluate"; standard alternatives "barely distinguish themselves from no intervention"
(presence and frequency penalties) or degrade benchmarks; DRY "does not degrade MT-Bench, MMLU, or GSM8k accuracy
on Llama-3-70B, whereas the standard alternatives do"; and **under 3% latency overhead at 128K context**. DRY is
already in llama.cpp, ExLlamaV2 and text-generation-webui. Its four parameters: **allowed repetition threshold L,
multiplier λ, base β, breaker set B.**
([Don't Repeat Yourself: Stopping Verbatim Loops at Sampling Time](https://arxiv.org/html/2608.22761))

**Why this matters for a WeChat clone specifically:** cross-turn repetition is a documented human dislike in
dialogue evaluation ("repetition is a known issue that humans dislike"), and per-response penalties cannot fix it.
([ACUTE-Eval](https://doi.org/10.48550/arxiv.1909.03087)) For Weport, the practical move is a **cross-turn
dedup on the client side**: track the last K outputs and, if a candidate duplicates a prior turn, regenerate —
since a hosted API will not expose DRY's logit hook.

### 4.5 Hard constraints: which ones a hosted API actually gives you

| Technique | Availability on a hosted OpenAI-compatible API | Notes |
|---|---|---|
| `logit_bias` | **OpenAI: yes** — "a JSON object that maps tokens... to an associated bias value from **-100 to 100**... values like -100 or 100 should result in a ban or exclusive selection". Worked example: banning `" time"` (token 640) and `"time"` (2435) after "Once upon a," changes the completion entirely. A usable positive bias example: `{"27000": 5}` for "microwave", with the author's note that "setting logit_bias to 1 often did not result in the word appearing... while higher logit_bias values like 10 resulted in ' microwave' appearing too often." | ([OpenAI reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/), [OpenAI help centre](https://help.openai.com/en/articles/5247780-using-logit-bias-to-alter-token-probability-with-the-openai-api)) **UNVERIFIED for DeepSeek**: DeepSeek's documented parameter set does not list `logit_bias`. Must be probed per provider. |
| Grammar-constrained decoding (GBNF / JSON schema) | **llama.cpp: yes**, and JSON-Schema→GBNF conversion is built in. OpenAI Structured Outputs: yes, `strict: true`, but with a restricted schema subset. **Not available for free-text style constraint.** | ([llama.cpp grammars README](https://github.com/ggml-org/llama.cpp/blob/HEAD/grammars/README.md), [llama.cpp grammar wiki](https://factory.ai/open-source-wikis/llama-cpp?page=systems%2Fgrammar.md), [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)) Notably: "The JSON schema is only used to constrain the model output and is **not injected into the prompt**. The model has no visibility into the schema." |
| Stop sequences | Yes (`stop`, up to 4 on OpenAI) | "typically matched exactly (case-sensitive, including punctuation)"; the stop string is excluded from output; "Only use such a common stop if you [want to cut there]" ([Stop Sequences in LLMs](https://www.rohan-paul.com/p/stop-sequences-in-llms-concept-and)) |
| Post-processing hook (server-side rewrite/redact/suppress) | Only if you run the inference server | TensorRT-LLM's `PostProcessorHook` gives `emit(text)` / `suppress()` / `terminate(reason)` per chunk, and notes `emit` "rewrites the text channel only — it does not rewrite the underlying `token_ids`/`logprobs`" ([TensorRT-LLM post-processing hook](https://nvidia.github.io/TensorRT-LLM/1.3.0rc22.post1/features/post-processor-hook.html)) |
| Client-side post-processing | **Always available** | Lowercasing, punctuation stripping, em-dash removal, interjections, splitting into 2–3 bubbles. Deterministic, testable, zero-cost. |

**The highest-value constraint for this app is not decoding-level — it is the shape of the output.** WeChat
messages are short, fragmented, multi-bubble, and often sent in bursts. Two mechanisms:

1. **Ask for a short message and a stop sequence** (e.g. `<END>`), then split the result into bubbles client-side
   using the user's own **burst histogram** (how many messages in a row, and their length distribution).
2. **Constrain length with the fingerprint**, not with an adjective: if the user's median message to this
   recipient is 7 characters and the 90th percentile is 24, then "under 60 words" (a generic prompt rule) is
   already 10× too generous.

There is also a *hard* provider-level lever worth noting: `logit_bias` is the only mechanism on a hosted API that
can implement a **banned-token list** at the sampler rather than in the prompt — if DeepSeek supports it, the
AI-tell banned list ("delve", "Certainly", "I'd be happy to", em dash) becomes a decode-time guarantee instead of
a request.

---

## 5. Voice/style verification harnesses

Everything in this section is buildable offline in TypeScript and is the prerequisite for claiming any of the
above techniques "worked". **The user's complaint cannot be resolved without a number that moves.**

### 5.1 The multi-metric ensemble (this is the field's consensus, and its warning)

The EMNLP 2025 study deliberately used **four complementary evaluators** rather than one:

1. **Authorship Attribution** `AA(t) → a` — trained on human-authored texts, predicts the most likely author; test
   whether the generated text is attributed to the target author.
2. **Authorship Verification** `AV(t, t′) → {0,1}` — is this generation the same author as the human reference?
3. **Style model distance** — "a style model X_a for each author... built from the distributional and stylistic
   features of their writing samples. We then compute the stylistic distance between a generated text t and each
   author's style model X_a." This is "an **explicit criterion**" unlike AA/AV's implicit fine-tuned features.
4. **AI generation detection** — they used GPTZero, "for its strong performance in AI text detection... to
   complement the other three metrics by assessing human-likeness."

**The finding that justifies the whole harness:** "few-shot generations are significantly closer to the target
style than zero-shot ones, **as confirmed by a Wilcoxon signed-rank test**." And the honest negative result:
"despite improvements from exemplar-based prompting, current LLMs **still struggle to reproduce nuanced personal
styles — especially in informal and stylistically diverse domains**," with prompt design choices ("length
alignment and content similarity") having only "moderate" effect.
([Catch Me If You Can? Not Yet](https://aclanthology.org/2025.findings-emnlp.532.pdf))

### 5.2 The one test that is directly implementable: held-out message prediction

This is the harness the user's own data supports perfectly, and it is the strongest possible evidence:

```
Given a real conversation and a real timestamp t:
  context  = the K messages immediately before t (both sides), verbatim, with the real timing
  target   = the user's actual next message at t     (NEVER shown to the model)
  clone    = generate a reply to `context`
  compare  = does an authorship verifier prefer `clone` or a random other message of the user's?
             - char n-gram TF-IDF centroid cosine to the user's style model  (target vs clone)
             - message length / punctuation / emoji / script-mix deltas
             - the fingerprint's banned-pattern violations
             - AI-detector score (optional; see 5.3)
```

The **verifier itself** has a published, training-free recipe: "TF-IDF character n-grams with transformer
embeddings and classifies text pairs through **empirical distance distributions**, eliminating the need for
supervised training or threshold tuning. It achieves **97.5% accuracy on academic essays and 94.5% in
cross-domain evaluation**, while reducing training time by 91.8% and memory usage by 59% relative to
parameter-based baselines." ([arXiv 2509.24930](https://arxiv.org/pdf/2509.24930))

The **centroid** version is even simpler and is the standard authorship-representation construction: "let
t_i(1), ..., t_i(N) be tweets from user i... we can represent the style of the user as S_i = (1/N) Σ_j s_i(t_i(j))"
— i.e. **the mean of the author's item embeddings**. ([RAGs to Style](https://doi.org/10.18653/v1/2024.personalize-1.11))

Also implementable and free: the PAN-style **toward / away / confusion** framing. Away = similarity to the
*source* style; Toward = similarity to the *target* style; "confusion" is a human-judgement score.
([ASTRAPOP](https://doi.org/10.48550/arxiv.2403.08043)) For Weport, "toward" is the user's centroid.

**Statistical hygiene for the harness.** Use a paired test, because every configuration is evaluated on the same
held-out conversations: the NLP significance-testing guide recommends, when the statistic's distribution is
unknown, sampling-based tests first — **paired bootstrap** or approximate **randomization/permutation** — and for
large test sets the sampling-free **Wilcoxon signed-rank** (more powerful than the sign test; "applicable for most
NLP setups... due to its improved power"). Also relevant: "The test is less effective for **small test sets**."
([The Hitchhiker's Guide to Testing Statistical Significance in NLP](https://aclanthology.org/P18-1128.pdf))

### 5.3 Human evaluation done right (and its disturbing baseline)

- **Humans are ~59% accurate at identifying AI text**, 9164 annotations / 214 participants / 500 texts (half human,
  half LLM), across 10 genres: "the humans accuracy was above chance but far from perfect (**around 59%**), with a
  slight tendency to label texts as 'Human-generated'." Accuracy depended on genre ("structural/factual formats
  easier to identify vs. complex genres"). Automated tools reached **88%** on the same distribution. Self-reported
  descriptors ("monotony, lack of cohesion or coherence") had "very limited effects on accuracy", and a learning
  effect was "practically negligible (0.1-0.2%)".
  ([TURING, LREC 2026](https://lrec.elra.info/lrec2026-main-355))
- **For narrative text, humans were at or below chance.** n=1,682 in Study 1; Studies 2–3 used 905 adults reading
  both human and AI stories: **39.39% correct in Study 2 — significantly *worse* than chance** (p < .001) — and
  **51.97% in Study 3 (no different from chance, p = .41)**. Additional findings: people rated AI stories as
  higher quality *and* more absorbing than human stories when authorship was anonymous, but rated the same story
  better when told it was human. Participants "were significantly more likely to respond **incorrectly** if they
  said that they relied on the story's language (χ²(1) = 9.11, p = .003) or their level of enjoyment (χ²(1) = 9.57,
  p = .002)" — and people who spent *more* time reading were *less* successful.
  ([Bot or not, Cambridge](https://www.cambridge.org/core/services/aop-cambridge-core/content/view/45E6DC0BB90AA648654D5AE243F6C667/S1930297526100424a.pdf/bot-or-not-can-people-tell-the-difference-between-stories-written-by-a-human-or-by-an-ai-system.pdf))

**Implication:** "my friends couldn't tell" is worthless evidence (they may be worse than chance). "You could
tell" — the user's own judgement — is worth capturing *as a ranking task*, not a yes/no, and it must be compared
against a measurable baseline.

- **ACUTE-Eval** is the recommended human protocol for dialogue: show the annotator **two whole conversations**,
  **highlight only one speaker in each**, and ask a **single pairwise question** about a named quality. Its
  motivation is exactly the failure of the alternatives: single-turn pairwise "fail[s] to take into account the
  multi-turn aspect", multi-turn Likert has "differing bias and variance per annotator" and "often yields
  comparisons that are not statistically significant", and anchoring effects make Likert scores "generally not
  comparable across multiple papers".
  ([ACUTE-Eval](https://doi.org/10.48550/arxiv.1909.03087))
- **FFAEval** extends this to free-for-all ranking with a **shared dialogue history** across systems and
  **TrueSkill** to aggregate. Their argument for why shared history matters: it "effectively prunes the unfairness
  introduced when the annotator implicitly replies to one of the dialogue systems", and it "converge[s] faster
  and more fairly" than pairwise. ([FFAEval, EMNLP Findings 2023](https://p.rst.im/q/aclanthology.org/2023.findings-emnlp.1049.pdf))
- **The minimal harness:** 20–30 real held-out contexts, the user ranks 3 anonymous continuations (clone with
  config A / clone with config B / the real message), and you report **TrueSkill or win-rate with a bootstrap CI**.

### 5.4 LLM-as-judge with a style rubric — and its documented weaknesses

**Use it, but know the failure modes and mitigate them.**

- **MT-Bench's numbers.** "strong LLM judges like GPT-4 can match both controlled and crowdsourced human
  preferences well, achieving **over 80% agreement**, the same level of agreement between humans." But the biases:
  **position bias** — "all of them exhibit strong position bias. Most LLM judges favor the first position... Only
  GPT-4 outputs consistent results in more than **60%** of cases"; Claude-v1 also showed a **name bias** favouring
  "Assistant A". **Verbosity bias** — a "repetitive list" attack (rephrase a 5-item list as 10 items with no new
  information, prepend it) defeated *all* LLM judges tested. **Self-enhancement bias** — "GPT-4 favors itself with
  a **10% higher win rate**; Claude-v1 favors itself with a **25% higher win rate**." **Limited grading ability**
  — GPT-4 "makes an incorrect judgment" on an elementary math question it can solve when asked separately, but
  the **reference-guided** method cut failure from **70% to 15%**.
  ([Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/html/2306.05685v4))
- **A newer, larger measurement of self-preference bias**: across 20 mainstream models, "Six models systematically
  favor themselves despite high discriminability", and "a structured multi-dimensional prompting strategy reduces
  SPB by **31.5% on average**". ([Machiavellian Judges](https://arxiv.org/html/2605.04305v1)) **[UNVERIFIED —
  arXiv id inferred from the search snippet; the quoted numbers and title are from the retrieved text.]**
- **The concrete mitigations, all cheap:**
  - **Both-orderings protocol**: run every pair twice with positions swapped; a win requires agreement in both
    orderings; disagreements become ties. "position bias remaining a **40% inconsistency rate** for GPT-4-class
    judges on rubric-based pairwise tasks. The mitigation is non-optional and adds a 2x cost."
  - Track the **position-flipped rate** as a health metric, gated at **~10%** ("If you see 30% position-flipped
    cases, the judge is too noisy for pairwise on this rubric").
  - **Reasoning before score** — "Put the reasoning field BEFORE the score... Reversing this order, score first
    then reasoning, [loses] most of the chain-of-thought benefit. The model commits to a number before thinking
    about it."
  - **Narrow integer scales with anchored endpoints** (1–4 or 1–5) beat vague Likert; the Hugging Face cookbook
    example cited is 0.567 → 0.843 Pearson.
  - **Split criteria** — one judge prompt per property ("faithfulness, relevance, instruction-following, tone"),
    not one prompt scoring four.
  - **Token-probability scoring** where logprobs exist: `score = Σ p(k)·k` over the score tokens, which "reduces
    score quantization noise".
  - Pairwise hits **85%** human agreement on MT-Bench, and pairwise is "the right shape" when the property is "too
    ambiguous for a stable absolute rubric" — which *tone* is: "pairwise comparison is more stable than pointwise
    for tone; consider running pairwise on tone-critical evaluations."
  ([LLM-as-Judge: Pointwise and Pairwise](https://jatinbansal.com/ai-engineering/llm-as-judge/),
  [15 LLM-as-a-judge prompt templates](https://promptassay.ai/blog/llm-as-a-judge-prompt-templates))

**A style rubric that avoids verbosity bias** should score *shape*, not quality: does the reply respect the
recipient's length band; does it use the user's variant for each canonical concept; does it open the way the user
opens; does it contain any banned pattern. Every one of those is computable, so the LLM judge should be reserved
for the one thing it is good at: **"would this person plausibly say this, given the situation?"** as a pairwise
comparison against the real held-out message.

### 5.5 What "self-consistency" and "bootstrapped confidence" mean here

- **Self-consistency** in the original sense (sample N reasoning paths, majority-vote the answer) is a *reasoning*
  technique; for generation there is no answer to vote on. The adaptation that works is **agreement between
  independent generations**: sample the clone's reply 5× at the production temperature and measure pairwise
  authorial-distance variance. A clone whose 5 samples cluster tightly is *reproducing a habit*; one that scatters
  is guessing. Report the within-conversation variance next to the distance-to-centroid.
- **Bootstrapped confidence**: paired bootstrap over held-out conversations, per the NLP significance guide.
  95% CIs on every reported delta. One published paper explicitly contributes a `BootCI` module implementing
  "the bootstrap CI for one sample described in DiCicio and Efron (1996) [adapted] to the comparison of paired
  samples" plus a "Fisher-Pitman test for paired samples". ([arXiv 2502.11266](https://arxiv.org/pdf/2502.11266))
- **A negative control is mandatory.** Report the same metric for (a) the clone, (b) a generic assistant reply,
  and (c) **a different conversation's real message from the same user** — that third one tells you the ceiling
  imposed by your own verifier's noise floor. Without it, a "0.82 style similarity" number is uninterpretable.

### 5.6 Open-source eval harnesses (what exists, and the gap)

| Harness | What it does | Fit for Weport |
|---|---|---|
| [PICON](https://github.com/KAIST-Edlab/PICon-pkg) | Multi-turn persona **interrogation**: questioner/interviewee/extractor/web-search/evaluator chain; metrics for Internal Responsiveness, Internal Consistency, External Coverage, External Non-refutation Rate, Inter-/Intra-session Stability. Runs against **any OpenAI-compatible `/v1/chat/completions` endpoint** — "If you already have a persona agent running (e.g. a wrapping server, fine-tuned model, RAG agent), provide its OpenAI-compatible endpoint URL." Defaults: `num_turns=20, num_sessions=2`. | **Best fit.** It tests *consistency and stability*, not *voice*. Runs Python, but the protocol is trivially portable. |
| [harness/harness-evals](https://github.com/harness/harness-evals) | Five dimensions (Correctness / Groundedness / Safety / Trajectory / Performance); metrics incl. `ConversationCoherence`, `KnowledgeRetention`, **`RoleAdherence`**, `RubricJudge`, `GEval`, `Pairwise`; `ConversationGolden` modes SIMULATE / REPLAY / SCRIPTED / GRAPH. | Right *shape*, wrong vocabulary — nothing style-specific. Useful as a metric taxonomy. |
| [likenneth/persona_drift](https://github.com/likenneth/persona_drift) | The persona-drift benchmark (see §7.4). | Reference for measuring drift. |
| LaMP | The personalisation benchmark + leaderboard. | Academic; not runnable against a desktop app. |

**The gap:** I found **no open-source harness that measures *voice/style* fidelity** — i.e. authorship
verification of a clone's output against the target person. Every style-aware evaluation in the literature is
bespoke (TinyStyler's toward/away, ASTRAPOP's LUAR-based score, the EMNLP 2025 four-metric ensemble). **Weport
would be building something that does not publicly exist**, which is a reason to build it (it is also the only way
to answer the user's complaint) and a reason to keep it small.

---

## 6. Fine-tuning as an alternative

### 6.1 The self-hosted reference implementation already exists — and it is WeClone

[`xming521/WeClone`](https://github.com/xming521/WeClone) is the project this feature is named after:
"One-stop solution for creating your AI twin from chat history... Fine-tune LLMs with your chat logs to capture
your unique style." Concretely:

- **Method:** "Qwen2.5-VL-7B-Instruct model by default with **LoRA** method for **SFT** stage fine-tuning. You can
  also use other models and methods supported by LLaMA Factory."
- **Data:** Telegram Desktop JSON exports of **individual** chats; "you can export multiple contacts (**group chat
  records are not recommended**)."
- **Tunables:** `num_train_epochs`, `lora_rank`, `lora_dropout`, `per_device_train_batch_size`,
  `gradient_accumulation_steps` (VRAM).
- **Platforms:** Telegram ✅, WhatsApp 🚧, Discord ✅, Slack ✅, **WeChat (personal account) ✅ via
  `openclaw-weixin`**.
- **Privacy stance:** "Privacy information filtering with localized fine-tuning and deployment."
  ([repo](https://github.com/xming521/WeClone), [README](https://github.com/xming521/WeClone/blob/master/README.md))

Note the word **localized**: the reference implementation's privacy story *depends on running the training
yourself*.

### 6.2 How much data, and how good is it — the measured answer

**Data volume.** StyleTunedLM (PEFT on 10 Project Gutenberg authors, ~80k tokens per author) is the cleanest
data-size ablation: training on **5% or 35% of 80k tokens "leads to significantly low cosine similarity and
accuracy, signaling inadequate style learning"**; performance improves as data increases. They also anchor to the
stylometry rule of thumb: "Inspired by Eder (2015), who suggest a minimal size of **5,000 to 10,000 words for
stable authorship attribution**." Two further results from the same paper:

- **Masking named entities during training "has a minimal impact on style learning"** but "the masked model shows
  lower linguistic errors, implying enhanced generalization... masking encourages the model to focus on broader
  contextual patterns instead of memorizing specific names." (Directly relevant: for a personal clone you *want*
  the named-entity content, but this shows masking does not cost you style.)
- **Merging LoRA modules works**: merging a style-tuned adapter with an instruction-tuned adapter "not only
  enables the instruction following ability but also maintains overall performance."
  ([Customizing LLM Generation Style using PEFT, INLG 2024](https://aclanthology.org/2024.inlg-main.34.pdf))

**Does fine-tuning beat prompting? Depends on the task, and the honest answer is "not reliably".**

- ASTRAPOP (SFT + policy optimization, DPO/CPO) on **individual authorship style transfer**: it "more effectively
  able to leverage few-shot style transfer than **ICL or SFT methods alone**", with best toward/away/confusion
  scores for ASTRAPOP-DPO/CPO (toward 0.164/0.165, away 0.748/0.752, joint 0.507/0.505), and "PO training harms the
  SBERT score, but the magnitude of the loss is very small." Reference point in the same paper: GPT-3.5-turbo's
  SBERT content-preservation score was **0.738**. **And the human study found no statistically significant
  difference in style confusion for any model pair** — humans could not reliably tell the styles apart, while
  content-preservation differences *were* significant.
  ([ASTRAPOP](https://doi.org/10.48550/arxiv.2403.08043))
- A TST paper using roundtrip-translation to synthesise parallel data reports PEFT "consistently superior... over
  zero-shot prompting and few-shot ICL techniques measured by BLEU scores and style accuracy scores across four
  investigated domains", with 5-shot beating 3-shot and 0-shot, and a highest BLEU **52.35** / highest style
  accuracy **0.865** in the Pre-modern Literary domain.
  ([arXiv 2602.15013](https://www.arxiv.org/pdf/2602.15013))
- **But the headline personalisation comparison says the opposite for the general case**: RAG **+14.92%** vs PEFT
  **+1.07%** over non-personalised, combined **+15.98%**.
  ([LaMP-Benchmark README](https://github.com/lamp-benchmark/lamp))

**Synthesis for Weport:** fine-tuning is *plausible* but not *proven superior* for this use case, requires
infrastructure the app does not have and a privacy posture the app has explicitly rejected, and the measured
ceiling on style transfer quality is not obviously above what good exemplar conditioning reaches (§1.3: few-shot
→ up to 99.9% authorship agreement; completion prompting in particular).

### 6.3 Cost, concretely

A QLoRA run on a single GPU. Published 2026 marketplace rates:

| GPU | RunPod Secure | RunPod Community | Lambda | Vast.ai (listed floor) | Vast.ai (typical) |
|---|---|---|---|---|---|
| RTX 4090 (24 GB) | $0.69/hr | $0.34/hr | — | $0.13/hr | $0.29–$0.50/hr |
| A100 80GB PCIe | $1.39/hr | $1.19/hr | — | — | $0.60–$1.10/hr |
| A100 80GB SXM | $1.49/hr | $1.39/hr | $1.29–$2.79/hr | $0.47/hr | $0.39–$0.90/hr |
| H100 SXM | — | — | $3.99–$4.29/hr | $1.60/hr | $1.49–$2.21/hr |

A worked example (8-hour LoRA job on one A100, ~50,000 training examples): **RunPod Secure $13.12; Vast.ai reliable
host $8.80; AWS p4d equivalent ≈ $24.50**. And the reliability warning: a $0.82/hr Vast.ai host "died 3 hours in —
no warning, no graceful shutdown. I lost 3 hours of compute... That 'cheap' run actually cost me $11.26 and an
extra 3 hours of waiting." Verdict: "For production training jobs that take 8+ hours, I would use RunPod Secure
Cloud every time. For quick experiments under 2 hours? Vast.ai's cheapest options are fine."
([CloudHostReview RunPod vs Vast.ai 2026](https://cloudhostreview.com/article/runpod-vs-vast-ai-2026-comparison),
[tech-insider.org GPU pricing 2026](https://tech-insider.org/runpod-vs-lambda-vs-vast-ai-2026/))

So: **a WeClone-style LoRA run on this corpus is a $10–50 artifact and a few hours of a rented GPU.** The cost is
not the blocker. The blockers are (a) it is an offline batch job, not a feature inside a desktop app; (b) it
requires *uploading 104k private messages* to a rented machine or a fine-tuning provider; (c) no measurement
shows it beating good exemplar conditioning on *this* task.

A worked reference for the "text like you" QLoRA recipe, including the dataset builder and a redaction flag:
[`ahsan37/iMessage-QLoRA`](https://github.com/ahsan37/iMessage-QLoRA) — "Finetune an LLM to text like you using your
iOS Messages", Llama-3.1-8B-Instruct + QLoRA via Unsloth on a rented Lambda GPU, `python scripts/ft_dataset.py
--redact` then `python finetune/train.py --config finetune/config/qlora_llama31_8b.yaml`. The training
hyperparameters in the companion tutorial are unusually explicit and worth copying if this path is ever taken:
**r=16, `num_train_epochs=1`, `optim="paged_adamw_32bit"`, `max_grad_norm=0.3`, `warmup_ratio=0.03`,
`group_by_length=True`, `fp16=False, bf16=False`, `save_total_limit=10`** ("to avoid running out of disk
space!"), and the operational hint "If this runs out of memory, try reducing the LoRA r hyper-parameter (and alpha
by the same factor) and reduce the target modules."
([Edward Donner, Fine-tuning an LLM on your texts, part 4 — QLoRA](https://edwarddonner.com/2024/01/31/fine-tuning-an-llm-on-your-text-messages-using-qlora/))

### 6.4 Privacy: the hard constraint, documented

Weport's `docs/agents/weclone.md` states: "Data never leaves the device. There is no server, no upload, and no
cloud path — the boundary is hard. The only outbound call is the user's own configured model API."

Fine-tuning breaks that boundary unless done on hardware the user controls. If a hosted provider is used, the
relevant facts are provider-specific and must be checked, not assumed:

- **Together AI:** "You may see a privacy toggle on both your personal account profile and your organization
  settings. These control different scopes: The account setting applies only to traffic you send under your
  personal account when it isn't attached to an organization. The organization setting governs all traffic sent
  under that organization's projects and API keys, regardless of which member makes the request." Also: "Together
  does not store inputs or outputs by default, i.e. it supports zero data retention (ZDR)"; "Data sharing for
  training other models is **opt-in and not enabled by default**"; and **passthrough models are a separate toggle**
  — "Some models are offered as passthrough, meaning that Together forwards your prompts and responses directly to
  the upstream provider, and data is handled under that provider's own data policy."
  ([Together privacy and security](https://docs.together.ai/docs/privacy-and-security))
- **OpenAI:** the models.dev-style "enterprise privacy" page was not fetchable in a useful form; **[UNVERIFIED]**
  on current retention/fine-tuning data-use terms. Do not state them in-product without checking.
- Practical guidance from a fine-tuning tutorial: "For those concerned about data sensitivity, practicing **data
  minimization** is key; ensure you strip out PII before uploading your corpus to any fine-tuning provider."
  ([startupgeek.org](https://startupgeek.org/personal-ai-fine-tuning-training-a-model-on-your-own-writing-style/))
  Weport already has `weClonePiiFilter.ts` and a 脱敏 toggle, so this machinery exists — but the app's own promise
  is stronger than "strip PII".

**Recommendation:** keep the hard boundary. Document fine-tuning as an *export* path — the app writes a
ready-to-train JSONL (with the recipient IDs and timestamps it already has) and the user runs the training
somewhere they control — rather than as an in-app feature.

### 6.5 Personality vectors / activation steering: not accessible from here

The science is real and strong, and it is **entirely out of reach for a hosted-API desktop app**. Documented so
the option can be closed explicitly:

- **ActAdd (Activation Addition).** Compute a steering vector by *taking the difference of activations* on a
  contrast prompt pair `(p+, p−)`, then add `c · (h+ − h−)` into the residual stream at layer `l` at inference
  time. "**Absolute values between 3 and 15 are typical**" for the injection coefficient; "intervening at middle
  layers is most effective"; it requires only forward passes, "works with a single pair of data points", and the
  overhead "scales naturally with model size: the relationship between inference time premium and model size is
  decreasing." **Hard requirement stated in the paper: "the model must cache intermediate activations."**
  ([ActAdd, Gwern mirror of the paper](https://gwern.net/doc/www/arxiv.org/e36a6537cc575af8c5ce23817872da48ad21e2c9.pdf),
  [OpenReview](https://openreview.net/notes/edits/attachment?id=91L4QwqDov&name=pdf))
- **Persona vectors.** An automated pipeline: given only a natural-language trait description, generate contrastive
  response pairs with positive/negative system prompts (**10 rollouts each**), filter by trait-expression score
  (keep >50 for positive prompts, <50 for negative), extract residual-stream activations **at every layer**,
  average across **response tokens** ("response tokens yield more effective steering directions than... prompt
  tokens"), compute the vector as the difference of means, and **select the most informative layer** by testing
  steering effectiveness. Traits covered: **evil, sycophancy, hallucination**, plus experiments with
  **politeness, apathy, humor, optimism**. Two interventions: inference-time steering (subtract, but "can degrade
  general capabilities" — MMLU drops) and **preventative steering** (steer *toward* the undesired direction during
  fine-tuning — "analogous to giving the model a vaccine" — which "limits trait shifts while better preserving
  general capabilities").
  ([Persona Vectors, arXiv 2507.21509](https://arxiv.org/pdf/2507.21509),
  [Anthropic blog](https://www.anthropic.com/research/emotion-concepts-function),
  [code](https://github.com/safety-research/persona_vectors))
- **Emotion vectors** (Anthropic, Claude Sonnet 4.5): "We compiled a list of **171 words for emotion concepts**" —
  from "happy"/"afraid" to "brooding"/"proud" — asked the model to write short stories where characters experience
  each, recorded activations, and derived vectors. Key findings: the vectors are "primarily **local**"
  ("they encode the operative emotional content most relevant to the model's current or upcoming output, rather
  than persistently tracking... state over time"), and they "causally influence the LLM's outputs, including
  Claude's preferences and its rate of exhibiting misaligned behaviors". Post-training "led to increased
  activations of emotions like 'broody,' 'gloomy,' and 'reflective,' and decreased activations of high-intensity
  emotions like 'enthusiastic' or 'exasperated'" — i.e. **the assistant persona is baked in and can be measured**.
  ([Emotion concepts and their function in an LLM](https://arxiv.org/html/2604.07729v1),
  [Anthropic](https://www.anthropic.com/research/emotion-concepts-function))
- **Style vectors** exist as a research construct too: "style vectors can be simply computed from recorded layer
  activations for input texts in a specific style in contrast to more complex training-based approaches... to
  influence the style of generated text in a nuanced and parameterisable way, distinguishing it from prompt
  engineering." ([Style Vectors for Steering Generative LLMs, EACL Findings 2024](https://aclanthology.org/2024.findings-eacl.52/))
  There is a 2026 reproducible pipeline writeup for author-style steering via contrastive activation vectors
  across mid-level layers. ([Ionio Research](https://research.ionio.ai/))
- **Closest thing to a usable artifact without owning a model:** `hotwire-vllm` adds **per-request** activation
  steering to vLLM *without* disabling CUDA graphs, via an OpenAI-compatible extension:
  `{"vllm_xargs": {"hotwire": "{\"id\": \"tesla_car\", \"layer\": 20, \"scale\": 1.5}"}}`. Measured overhead:
  vanilla vLLM TTFT 4.9 ms / 1.78 ms per token; **all 8 requests steered: 4.6 ms / 1.78 ms per token** — "Idle and
  fully-steered are both within noise of vanilla", whereas the `enforce_eager` alternative costs 5.0 ms / 1.88.
  ([moudrkat/hotwire-vllm](https://github.com/moudrkat/hotwire-vllm)) This still requires running vLLM on a GPU —
  it is the *server-side* option for someone else's product, not for Weport.
- A browser demo exists that runs a 0.5B model with WebGPU and a steering slider, with the honest note that
  "Push past the usable band and the UI marks the 'incoherence zone' where the output degrades."
  ([millerharry/steerscope](https://github.com/millerharry/steerscope))

**Weight- and hidden-state-level style clone metrics are real and expensive:** TinyStyler conditions a modified T5
on 768-d authorship embeddings projected to 512-d, prepended to word embeddings, and reports "style embedding
interpolation" as a fine-grained control knob. ([TinyStyler](https://doi.org/10.18653/v1/2024.findings-emnlp.781))
That is the state of the art for a *local* style cloner — and it needs a GPU.

**Conclusion for §6.5: closed.** Not because it does not work, but because it requires activation access, which a
hosted chat API does not provide.

---

## 7. Per-recipient register / diaphasic variation

### 7.1 The theory, with numbers

**Audience design** (Bell 1984) and **Communication Accommodation Theory** are the two frameworks. The measured
findings that matter:

- **Smaller audience → more nonstandard language.** In Twitter data: "the frequency of nonstandard lexical
  variables is **inversely related to the size of the intended audience**: as writers target smaller audiences,
  the frequency of lexical variables increases," and "these variables are more often used in messages that are
  addressed to individuals who are known to be geographically local." ([Audience-Modulated Variation in Online Social Media](https://doi.org/10.1215/00031283-3130324))
- **Addressee effect is ~3× the auditor effect.** In a Cypriot-Greek phonological study with three audience
  configurations: the Greek variant [c] was used **15%** with Cypriot addressees + Greek auditors, **43%** with
  both as co-addressees, and shifting reached **99–100%** with Greek addressees. Summary of the design implication:
  "speakers accommodate primarily to their addressees"; the move from audience 1→2 produced 32% average shift and
  2→3 produced 50%. ([Style Shifting from Cypriot towards Greek Phonology](https://doi.org/10.1163/15699846-13130105))
- **This holds in historical written correspondence too** — late-medieval English letters show "both addressee and
  referee-based accommodation patterns", i.e. intra-speaker variation keyed to recipient social rank.
  ([Style-shifting and accommodative competence in Late Middle English written correspondence](https://doi.org/10.1515/flih-2018-0014))
- **Mirroring is perceived as rapport.** In an IM study (n=254 pupils): with **no mirroring, 49%** of respondents
  judged that the interlocutors "get along well"; mirroring only oral markers → **69%** (p<.0001); only emoji →
  **70%** (p<.0001); **both → 78%**. "More accommodation in instant messaging makes more participants perceive the
  interlocutors as getting along (p < .0001)." Also: "there were no significant changes in style among the
  participants" in one interview-based design, while "contextual factors such as personal relationship,
  conversation topic, and social/functional relationship among interlocutors apparently constrain the usage of
  certain IM strategies."
  ([Hilte et al., accommodation in IM](https://repository.uantwerpen.be/docman/irua/629176/2023_hilte_jlsp_prefinaleauteursversie.pdf),
  [StuTS 73 presentation](https://talks.stuts.de/es/stuts73/public/events/1000))
- **Structural variables converge too, not just lexical ones**: "interlocutors have a general tendency toward
  convergence on both the **length and duration** of individual contributions", with differences by relational
  (friends vs strangers) and conversational (task vs social) context.
  ([Communication Accommodation in Instant Messaging: Temporal Convergence](https://journals.sagepub.com/doi/10.1177/0261927X12462695))

### 7.2 The code-mixing-specific evidence (this is the user's corpus)

From the NUS ABC Codemixed Corpus study — 355,641 messages, 166 participants, English/Mandarin/Hokkien/Malay/Tamil
chat, participants contributed conversations with **three partners representing different levels of relational
intimacy**:

- **~30% of all messages contain some code-mixing**, and "shorter messages (0-5 tokens) show the highest mixing
  rates, reaching **36.7% in intimate conversations**", while "even in professional or work-related exchanges,
  short messages show non-trivial levels of code-mixing (about **13%**)". So mixing rate varies by *both*
  relationship type and message length.
- **Speakers accommodate their partner's mixing**, measured with a generalised linear mixed-effects model
  (binomial logit): "speakers were significantly more likely to code-mix when their partner's previous message
  contained more mixing (**b = 0.71, SE = 0.01, z = 100.31, p < .001**) or was longer in length (**b = 0.01,
  SE = 0.004, z = 2.78, p = .005**). Other covariates—including same-gender composition, age difference, trust,
  and self-disclosure—were non-significant." **The mirroring coefficient is enormous.**
- Message **length** also mirrors: partner's length **b = 0.50, SE = 0.002, t = 259.89, p < .001**.
- **What code-mixing correlates with** (LIWC-22 + PCA): function words **r = 0.28**, pronouns **r = 0.17**,
  articles **r = 0.16**, determiners **r = 0.23**, auxiliary verbs **r = 0.19** (all padj < .01).
- Qualitative functions via Systemic Functional Linguistics: "framing messages (e.g., *Actually ah, anyone looking
  for job?*), expressing emotion (e.g., *Wah I really cannot tahan*), managing closeness (*Sayang u so much,
  Paiseh we late*), softening tone (*U da best leh*), and adding humor or emphasis (*Walao I walked the other way
  sia*)."
- And they demonstrate the fine-tuning path: "we demonstrate the dataset's practical utility by fine-tuning a GPT
  model on the corpus to generate more contextually appropriate and authentic code-mixed conversations."
  ([Disentangling Codemixing in Chats: The NUS ABC Codemixed Corpus](https://aclanthology.org/2026.findings-acl.80.pdf),
  [arXiv 2506.00332](https://arxiv.org/pdf/2506.00332))

**The design conclusion is unavoidable:** a single global "persona" cannot represent a person whose code-mixing
rate, message length, emoji rate, punctuation and formality all shift by recipient and mirror the interlocutor.
The current Weport profile has a 「多面性总表」 section that *describes* this in prose — but the retrieval path
does not *use* it, and the docs note the retrieval is topic-keyed. **Per-recipient conditioning is the single
largest structural gap after exemplar placement.**

### 7.3 A concrete per-recipient design

What the literature supports, in the order I would build it:

1. **Partition the corpus by conversation** (Weport already has 184 sessions with wxid + name + group flag).
   Every corpus artifact — fingerprint, n-gram catchphrase list, length histogram, emoji profile, banned list —
   should exist **per conversation** and at least **per conversation *type*** (1:1 vs group, and for 1:1: by
   inferred register cluster).
2. **Derive a register cluster per recipient rather than hand-labelling.** The profile already documents observed
   faces ("对同学/群友 = 默认态、对老师 = 语域硬切、对合作方 = 英文办事流、对项目队友 = 派活态"). Cluster the
   *numeric* fingerprint vectors (function-word rates, punctuation rates, length percentiles, emoji rate, script
   mix ratio) and use the cluster, not the prose label, as the conditioning key. This is a 184-point,
   ~30-dimensional clustering problem — trivial offline, no model call.
3. **At inference, set the register from the interlocutor, then mirror.** Two knobs, both supported: (a) the
   recipient's own profile sets the *base* register; (b) the immediately preceding message from the other side
   sets *convergence* — code-mix coefficient b = 0.71 and length coefficient b = 0.50 are large enough that
   mirroring the incoming message's script mix and length is a well-founded heuristic, not a guess.
4. **Retrieve exemplars from the recipient's conversation first**, then fall back to the register cluster, then to
   the global corpus. A greeting to a professor must never retrieve the friend-group register.
5. **Weight examples by recipient-specific recency**, which is a *different* question from global recency.

### 7.4 Temporal drift

- **The idiolect drifts, measurably, and the drift is largely monotonic.** On the CIDRE corpus (11 prolific 19th-century
  French authors, dated works): "**Ten out of 11 corpora showed a higher than chance chronological signal**, leading
  us to conclude that the evolution of the idiolect is in a mathematical sense monotonic, supporting the
  rectilinearity hypothesis." They then trained regressions predicting the year of writing from stylistic
  features: "For the majority of the authors in our corpus, the accuracy and the amount of variance that is
  explained by the model were high." Conclusion: "We thus dismiss the proposal that idiolects are stable over time,
  even though it is true that **not all linguistic features evolve**."
  ([The Evolution of the Idiolect over the Lifetime, Journal of Cultural Analytics](https://culturalanalytics.org/article/id/749/))
- **Drift includes abrupt change points attributable to life events.** Dirichlet–multinomial change-point
  regression on Terry Pratchett found "evidence of **both gradual changes in style over his lifetime, and an abrupt
  change which corresponds to his Alzheimer's diagnosis**"; Agatha Christie showed "gradual drift, but no
  corresponding abrupt change." ([Tracking the evolution of literary style via Dirichlet–multinomial change point regression](https://ideas.repec.org/a/bla/jorssa/v183y2020i1p149-167.html))
- **Persona drift is a *within-conversation* problem as well, and it is severe.** The persona-drift benchmark
  (self-chats between two personalised chatbots, 100 persona system prompts across 5 categories, 200 conversations):
  LLaMA2-chat-70B "suffers a significant persona drift" — **within eight rounds of conversations** — attributed to
  **attention decay** across turns ("within each turn, π(t) remains almost constant, but there are significant
  decreases **across turns**"). Mitigations tested: `split-softmax` (power-law attention scaling) "presents a better
  trade-off between performance drop and persona stability" than classifier-free guidance; **system prompt
  repetition** "excels in regions with a larger number of turns" but "consumes a substantial portion of the context
  window."
  ([Measuring and Controlling Persona Drift in Language Model Dialogs](https://arxiv.org/html/2402.10962v1),
  [code](https://github.com/likenneth/persona_drift))
- A 2026 framework adds **Time-to-First-Drift (TtFD)** and decomposes drift into "hard facts, soft facts, and
  stylistic features", evaluating 100-round role-plays across ChatGPT, Qwen, Gemini and DeepSeek.
  ([Persona Drift Detection in Role-Playing Agents, ICASSP 2026](https://doi.org/10.1109/icassp55912.2026.11463024))
  **[UNVERIFIED — abstract only; the full text was not retrieved.]**

**Why this is the most immediately actionable finding in §7:** "persona drift within eight rounds" is a
*within-session* failure the user will hit in a normal chat, and **system-prompt repetition is a documented
mitigation that costs nothing but tokens.** For a 25k-char prompt on a cached-prefix API, re-injecting the
strongest voice constraints (the fingerprint constraints + the top exemplars) as a late-position turn every N
turns is a near-free, evidence-backed intervention. It also happens to be exactly what SillyTavern's "Author's
Note" implements: insert text **at a chosen depth** in the chat history, at a chosen **frequency**, with the
documented rule "**The closer the Author's Note is to the bottom of the prompt, the more impact it has on the next
AI response**" (Depth 0 = very end; Frequency 1 = every prompt; Frequency 4 = every fourth prompt).
([SillyTavern Author's Note](https://docs.sillytavern.app/usage/core-concepts/authors-note/),
[docs repo](https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Characters/Author's-Note.md))
SillyTavern's World Info engine adds the dynamic-insertion half: keyword-triggered entries with **recursive
scanning**, **Max Recursion Steps**, per-entry position, and options like `constant` (always inserted within
budget) vs selective, with keys supporting **regex** and set logic (`AND ANY`, `AND ALL`, `NOT ANY`, `NOT ALL`),
plus embedding-similarity activation.
([SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/),
[docs repo](https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/worldinfo.md))

**Recency weighting design, derived:** because drift is monotonic *and* feature-specific (§7.4, first bullet),
weigh **per feature**, not per message: give recent messages more weight in the *catchphrase currency* dimension
(which terms are live now) and in the *emoji set* dimension, while letting function-word rates and punctuation
habits pool across the whole window. The corpus is only 6 months old, so the honest expectation is that **the
global window is fine for stable habits and a decay is only needed for slang/emoji** — which is testable by
splitting the corpus at the midpoint, computing every fingerprint feature on each half, and keeping only those
features whose half-to-half delta exceeds the bootstrap CI.

---

## 8. Ranked shortlist for a TypeScript/Electron app with one hosted LLM API and no local GPU

Ordering is by expected value per unit of effort. Effort: **S** ≲ 1 day, **M** ≈ 2–5 days, **L** ≳ 1 week.
"Expected gain" is stated against the specific complaint (voice fidelity), with the evidence that supports it.

### Tier 1 — do these first

| # | Technique | Effort | Expected gain | Risk / cost |
|---|---|---|---|---|
| 1 | **Move exemplars out of the system prompt and into the current turn, as a labelled verbatim transcript, with an explicit "continue" instruction.** Keep the persona MDs, but demote them to background. Format: real turns, `Them:` / `Me:` labels (already the project's convention), then the incoming message, then generate. | **S** | **Largest single gain available.** Few-shot vs zero-shot is up to **23.5×** style-matching accuracy; zero-shot with statistical style summaries scored **<7%** at >95% confidence; text **completion** against a human prefix reached **≥99.9%** authorship agreement in 4/5 models. | Low. Risk is *recitation* of the exemplar instead of imitation — mitigated by (a) selecting exemplars that are topically *near* but textually distant from the incoming message, and (b) a client-side overlap check that regenerates if the output shares an n-gram ≥ 8 tokens with any injected exemplar. |
| 2 | **Per-recipient / per-conversation fingerprints and exemplar pools.** 184 conversations already exist. Store per-conversation numeric profiles; condition at inference on the interlocutor. | **M** | Directly targets the reported "register is wrong" symptom. Supported by audience design (addressee effect ~3× auditor effect; nonstandard-language rate inversely related to audience size) and code-mixing mirroring (**b = 0.71**). | Storage and scan time grow; scope creep into "which register is this". Mitigate by clustering to ~6–10 registers rather than 184 profiles. |
| 3 | **Extend the fingerprint to the Writeprints-Static schema + Dirichlet-smoothed log-odds catchphrases + a *never-used* (pattern-disruptor) list.** Feature card: 153 function words, 26 letters, 10 digits, 22 special chars, 9 punctuation marks, 12 POS tags, hapax ratio; Chinese counterpart = function-character n-grams (262 uni / 545 bi / 10 tri / 2 quad in the published list). | **M** | Converts "高频片段" from a curiosity into a ranked, defensible set; the never-used list becomes free negative constraints. Function words gave **99.0%** author accuracy vs 88–94% for collocations and are **topic-independent** — the property BM25 lacks. | The naive log-odds method is *documented to fail* ("overwhelmed by oddities"); using it wrong is worse than not having it. Use α₀ implying a 500-word prior sample and a dispersion-aware test (bootstrap / Wilcoxon), not χ². |
| 4 | **Build the held-out prediction harness (§5.2) before changing anything else.** 200–400 real held-out turns; metrics: char-n-gram TF-IDF centroid cosine to the user's style model, length/punctuation/emoji/script-mix deltas, banned-pattern violations, optional LLM pairwise judge with both-orderings. Report paired-bootstrap 95% CIs. | **M** | Not a fidelity gain — a *decision-making* gain. Without it, none of the other items can be shown to work, and the user's complaint has no falsifiable form. | Golden-set leakage (must hold out whole conversations, not random turns); the verifier's noise floor must be calibrated with the negative control in §5.5. |
| 5 | **Late-position re-injection every N turns (Author's-Note pattern) + cross-turn dedup.** | **S** | Directly addresses measured **persona drift within 8 rounds**; system-prompt repetition is a documented mitigation. Cross-turn repetition is a documented human dislike that per-response penalties cannot fix. | Token cost per re-injection. Keep it to the fingerprint constraints + 1–2 exemplars, not the whole 25k prompt. |

### Tier 2 — high value, more work

| # | Technique | Effort | Expected gain | Risk / cost |
|---|---|---|---|---|
| 6 | **Style-based retrieval: average-style centroid + cosine, or BM25→centroid rerank.** Use the user's mean embedding as a style query, not the incoming message's tokens. | **M–L** | Style-embedding retrieval beat BM25 *and* Contriever on the personalisation benchmark, and beat non-personalised retrieval decisively. | Needs a CPU embedding path (`transformers.js` on ONNX/WASM, int8) — the existing 334–929 ms retrieval budget is the constraint, so prefilter then rerank. k must stay **small (k=1–3)**: k=3 was *worse* than k=1 in the published result. |
| 7 | **Best-of-N (N=4–8) in one API call (`n`) + deterministic offline style reranker.** Score = geometric mean of (centroid distance, constraint compliance, length-band agreement). | **M** | The reranking recipe (geometric mean of toward/away/sim) is what made an 800M-param model beat GPT-4 on authorship transfer. Cost is linear in N. | BoN is **non-monotonic in N** under a noisy scorer; must A/B N=1/4/8. Some providers charge for all N. |
| 8 | **Re-parameterise BM25 for short utterances** (sweep `k1`, `b`; consider TF/DL offsets) and **add RRF fusion** if a second ranker exists. | **S–M** | Microblog retrieval's own finding is that BM25's free parameters should go to ~0 for short docs (it degenerates to IDF, which is *better*); +29.41% P@30 from TF/DL offsetting in one LM setup. RRF adds **+18% NDCG@10 over BM25** with **k=60 and no tuning**. | Must be measured on the harness or it is just a parameter change. |
| 9 | **Contrastive examples: retrieve 3 messages from *other* conversations into the same prompt as explicit "not-me" anchors.** | **S–M** | "+1% at minimum, every dataset", and "3 samples beat 5"; in one task it was the single best feature; **+15% relative** combined with author features. Free at scan time (other people's messages are already on disk). | Prompt budget. Risk of the model imitating the *contrast* instead of the target — must label unambiguously (`This is how OTHER PEOPLE write, not you:`). |
| 10 | **Deterministic post-processing pass:** bubble splitting to the user's burst histogram, punctuation normalisation to the user's profile, em-dash/AI-tell stripping, banned-phrase replacement. | **S–M** | Every item is fully deterministic and testable; the biggest observed AI tells are lexical and punctational, and a banned-list is documented to remove them "faster than any positive instruction". | Over-stripping makes text uncanny; needs a golden-file test per conversation type. |
| 11 | **Two-pass generate → restyle**, with the restyle call receiving the draft + the fingerprint constraints + the recipient profile and being asked for a minimal edit. | **M** | Self-Refine gives **~20% absolute average** improvement across 7 tasks, and **dialogue response generation went 25.4% → 74.6%** preference. Feedback specificity is the load-bearing variable. | Doubles latency and cost. **Documented regression risk:** post-editing does not fully remove LLM style — post-edited text "remained measurably closer in style to LLM-generated text than to participants' own fully human-authored text". |
| 12 | **Pragmatic-function routing + thread retrieval.** Classify the incoming message's *function* (greeting / question / vent / logistical / banter / emoji-reaction) with rules + the fingerprint, then retrieve matched-function exemplars **with 2–4 turns of surrounding context**, never isolated lines. | **M** | Directly answers "a greeting needs a greeting". Punctuation/casing is the strongest measured dialog-act cue ("no other factor influences the results as much"); context cuts unrecognised dialog-act classes from >50% to <10%. | Classifier errors silently poison retrieval; keep the rule set small, log the routing decision in `meta` for every turn so failures are diagnosable. |
| 13 | **Speculative / streaming candidate selection in the UI.** Generate 3 candidates, show the user all three with a one-tap pick, and log nothing but the chosen index as preference data. | **S–M** | Turns the user's own judgement into a signal without a research pipeline. Human judgement is the only ground truth that matters here — and humans are only ~59% accurate at spotting AI text, so a *forced choice among candidates* is far more informative than "does this sound like me?" | UI cost; three invocations per turn unless `n` is used. |

### Tier 3 — plausible but lower expected value, or explicitly closed

| # | Technique | Effort | Expected gain | Risk / cost |
|---|---|---|---|---|
| 14 | `logit_bias` banned-token list (if the provider supports it) | **S** | Makes the AI-tell ban a *sampler* guarantee rather than a request. OpenAI supports -100…100 with documented examples. | **DeepSeek does not document `logit_bias`** — must probe. If unsupported, degrade silently to the prompt-level ban. |
| 15 | LLM-as-judge style rubric (pairwise, both-orderings, reasoning-before-score, 1–4 scale) | **S–M** | Pairwise reaches **85%** human agreement; useful for automated regression on prompt changes. | Position bias is ~40% inconsistency for GPT-4-class judges without swapping; verbosity bias defeats *all* judges under the repetitive-list attack; self-preference up to **+25%** win rate. Never gate a release on it alone. |
| 16 | MMR diversification within a style stratum, λ ≈ 0.7–0.8 | **S** | Removes near-duplicate exemplars, which is a real problem with 104k messages. | **Anti-indicated across style classes**: "any other document could confuse the model if it deviates too much from the style of the author." Never let λ near 0. |
| 17 | DRY-style suffix-overlap penalty implemented client-side (regenerate on a detected loop) | **S–M** | DRY cuts verbatim loops **47%** vs baseline where frequency/presence penalties are indistinguishable from no intervention. | Client-side approximation cannot match the sampler; a full regeneration costs a whole call. |
| 18 | Recency decay | **S** | Real but *weak*: recency was the best retriever on only 1 of 7 LaMP tasks; idiolect drift is real but feature-specific. | A uniform 6-month window may well be fine. Measure before adding. |
| 19 | Local QLoRA fine-tune on the corpus | **L** (+GPU) | ASTRAPOP-style SFT+PO beats ICL/SFT on individual authorship transfer; a WeClone-style run on this exact data shape exists (Qwen2.5-VL-7B + LoRA). | **RAG beats PEFT +14.92% vs +1.07%** in the systematic comparison; cost is only ~$10–50 in rented GPU hours but requires uploading 104k private messages, breaking the app's hard "data never leaves the device" promise. **Recommendation: offer JSONL export, never an in-app upload.** |
| 20 | Activation steering / persona vectors / style vectors | **closed** | Strong science (persona vectors for evil/sycophancy/hallucination/politeness/apathy/humor/optimism; 171 emotion concepts; per-request steering at ~0% overhead via `hotwire-vllm`). | Requires hidden-state/activation access **or** running your own vLLM server on a GPU. Architecturally impossible for a hosted chat API. Documented so it stops being re-raised. |

### What I would *not* build

- **More markdown persona files, or bigger ones.** The current pipeline already produces 32–57 KB `profile.md`
  and the user still says it does not know how to speak. That is the definitive evidence that the profile channel
  is not the bottleneck. Additional prose competes for the context window with the material that works.
- **A generic "make it sound casual" instruction.** "Single adjectives underspecify... the model fills the gap with
  its own average guess."
- **A temperature increase as the diversity fix.** Weakly correlated with novelty, moderately correlated with
  incoherence, unrelated to cohesion or typicality, and low temperature is where mode collapse lives (92% collapse
  at t=0.7 in one measurement).
- **A static example list in the system prompt.** Already tried and correctly reverted; the project's own note
  ("模型要么整段照抄要么完全忽略") is the same failure mode the community reports and the same one the
  zero-shot/<7% result explains.

---

## 9. Open questions I could not resolve

1. **No open-source voice-fidelity harness exists.** PICON tests consistency; harness-evals tests coherence;
   LaMP is academic. Every style-aware evaluation in the literature is bespoke. Weport will be building this.
2. **Does DeepSeek support `logit_bias`?** Not documented in the parameter tables I could reach. Must be probed
   empirically before designing around it. **[UNVERIFIED]**
3. **Do style embeddings exist as a usable CPU artifact?** The published work uses Wegmann et al.'s STYLE
   embeddings and Rivera-Soto et al.'s UAR. I found no ONNX/transformers.js conversion of either. The realistic
   fallback is a char-n-gram TF-IDF centroid (the training-free verifier recipe, 97.5%/94.5% accuracy) or a
   general sentence embedder — and the latter may not capture style as well as it captures topic.
   **[UNVERIFIED whether a converted style-embedding model is obtainable.]**
4. **How much of the gain is attributable to each lever, for *this* corpus and this register?** All the numbers in
   this document come from essays, tweets, news, or roleplay. The EMNLP 2025 result explicitly predicts the
   informal end will underperform. The harness (item 4) exists precisely to answer this locally.
5. **Whether the code-mixing mirroring coefficient (b = 0.71) transfers** from Singaporean English/Mandarin chat
   to this user's Chinese/English WeChat corpus. It is a strong prior, not a measurement.
6. **Provider retention terms for a personalisation use case** are not documented in a form I could verify for
   the app's actual provider; the Together page shows the shape such policies take (separate personal vs org
   scopes; ZDR by default; training opt-in; a *separate* passthrough toggle) but not DeepSeek's. **[UNVERIFIED]**

---

## Sources

1. Identity-conditioned style imitation / authorship verification study (TF-IDF char n-grams + transformer
   embeddings; zero-shot <7%, few-shot up to 23.5×, completion ≥99.9%, perplexity 15.2–16.07 vs 29.5) —
   https://arxiv.org/pdf/2509.24930
2. *Catch Me If You Can? Not Yet: LLMs Still Struggle to Imitate the Implicit Writing Styles of Everyday Authors*,
   EMNLP Findings 2025 (>40,000 generations/model; 400+ authors; AA/AV/style-model/AI-detector ensemble; informal
   domains hardest) — https://aclanthology.org/2025.findings-emnlp.532.pdf
3. *LaMP: When Large Language Models Meet Personalization*, ACL 2024 (+12.2% zero-shot, +23.5% fine-tuned;
   retriever comparison incl. recency) — https://aclanthology.org/2024.acl-long.399.pdf
4. LaMP benchmark repository (RAG +14.92% vs PEFT +1.07% vs combined +15.98%) —
   https://github.com/lamp-benchmark/lamp
5. *RAGs to Style: Personalizing LLMs with Style Embeddings* (style embeddings > BM25 > Contriever; k=1 beats k=3;
   mean style vector as author identity) — https://doi.org/10.18653/v1/2024.personalize-1.11
6. *Improving RAG for Personalization with Author Features and Contrastive Examples* (author-feature sentence
   template; top-10 only; CE +1% minimum; 3 authors beat 5; +15% relative) — https://arxiv.org/html/2504.08745
7. *Revisiting Demonstration Selection Strategies in In-Context Learning*, ACL 2024 (ICL sensitivity; TopK+ConE;
   30 candidates; 4/8-shot) — https://doi.org/10.18653/v1/2024.acl-long.492
8. *In-Context Learning with Iterative Demonstration Selection* (diversity vs similarity is task-specific;
   reasoning-path as retrieval query) — https://arxiv.org/html/2310.09881v4
9. *Text Style Transfer via PEFT + roundtrip translation* (sketch-first retrieval; 5-shot > 3-shot > 0-shot;
   similar vs random examples; BLEU 52.35 / style acc 0.865; irrelevant examples can hurt) —
   https://www.arxiv.org/pdf/2602.15013
10. *TinyStyler: Efficient Few-Shot Text Style Transfer with Authorship Embeddings*, EMNLP Findings 2024
    (800M params beats GPT-4; geometric-mean reranking of away/toward/sim; 40K filtered pairs; STYLE vs UAR;
    embedding interpolation) — https://doi.org/10.18653/v1/2024.findings-emnlp.781  ·  https://d6108366.hf-mirror.com/papers/2406.15586
11. *Authorship Style Transfer with Policy Optimization* (ASTRAPOP; toward/away/SBERT/joint/confusion numbers;
    human study finds no significant style-confusion differences; GPT-3.5 SBERT 0.738) —
    https://doi.org/10.48550/arxiv.2403.08043
12. Character Card V2 specification (`mes_example`, `creator_notes` MUST NOT enter prompts, `character_book`) —
    https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md
13. SillyTavern's own V2 typings — https://github.com/SillyTavern/SillyTavern/blob/8172dcd0/src/types/spec-v2.d.ts
14. SillyTavern character design docs (token budget warning; `<START>` handling; example blocks evicted block by
    block; `{{char}}`/`{{user}}` prefixes; per-model context sizes) —
    https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Characters/characterdesign.md
15. SillyTavern Prompt Manager (drag-and-drop order; relative vs in-chat position with Depth; role grouping order
    User → AI Assistant → System) — https://docs.sillytavern.app/usage/prompts/prompt-manager.md
16. SillyTavern Prompt Manager PR (token budget list, per-prompt and accumulated token counts, "New example chat"
    utility prompt) — https://github.com/SillyTavern/SillyTavern/pull/768
17. SillyTavern Author's Note (depth, frequency, "closer to the bottom = more impact") —
    https://docs.sillytavern.app/usage/core-concepts/authors-note/  ·
    https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Characters/Author's-Note.md
18. SillyTavern World Info (keyword/regex activation, set logic AND ANY/AND ALL/NOT ANY/NOT ALL, recursion levels,
    Max Recursion Steps, constant entries, embedding-similarity activation) —
    https://docs.sillytavern.app/usage/core-concepts/worldinfo/  ·
    https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/worldinfo.md
19. Character.AI Dialog Definitions (`name: text` syntax; `{{char}}` / `{{random_user_N}}` placeholders) —
    https://book.character.ai/character-guide/advanced-creation/dialog-definitions
20. Character.AI Advanced Creation ("sometimes, less can be more") —
    https://book.character.ai/character-guide/advanced-creation
21. JanitorAI bot creation guide by Faylua (dialogue examples inside the personality block; ≤2k permanent tokens;
    2.5k absolute max for JLLM; permanent vs temporary tokens) —
    https://help.janitorai.com/en/article/bot-creation-guide-w-images-by-faylua-8jcbw1/
22. JanitorAI character creation overview (≤2500 permanent tokens; include dialogue examples in the Personality
    box) — https://help.janitorai.com/en/article/the-basics-the-character-creation-page-overview-15xevon/
23. Chub character creation (`<START>` convention; field list) —
    https://docs.chub.ai/docs/the-basics/character-creation
24. Chub prompting (`{{example_dialogue}}` macro; Normal prompt order) —
    https://docs.chub.ai/docs/advanced-setups/prompting
25. TavernSprite character-card best practices ("two or three example dialogue lines"; token budgeting; failure
    "No example dialogue") — https://tavernsprite.com/blog/sillytavern-character-card-best-practices/
26. RPDATE how to write an AI character card ("The most powerful and most skipped field"; no-example-dialogue is
    the most common cause of flat assistant voice; W++ vs prose) —
    https://rpdate.com/en/blog/how-to-write-ai-character-card
27. MiniTavern card-from-scratch guide ("Aim for 3-5 exchanges") —
    https://blog.mini-tavern.com/blog/sillytavern-character-card-creator-how-to-build-a-card-from-scratch-in-2026-488a51
28. MiniTavern troubleshooting ("One or two short exchanges can work wonders") —
    https://blog.mini-tavern.com/blog/sillytavern-character-card-troubleshooting-fix-common-errors-and-improve-ai-resp-8eba3a
29. oobabooga text-generation-webui Parameters tab (character context/greeting; `{{char}}`/`{{user}}`
    replacement) — https://github.com/oobabooga/text-generation-webui/blob/a0b5599e/docs/03%20-%20Parameters%20Tab.md
30. oobabooga API default generation parameters (temperature 0.5, top_p 1, repetition_penalty 1.1, top_k 0,
    mirostat, no_repeat_ngram_size, truncation_length) —
    https://github.com/oobabooga/text-generation-webui/blob/63770c0643b6b0fc973a124905a7df43eebc7ffe/extensions/api/util.py
31. *Measuring the Usefulness of Function Words for Authorship Attribution* (frequent words 99.00% vs pairs 91.60%
    vs collocations 88.94%/84.00%; function words unlikely to be under conscious control) —
    https://hcmc.uvic.ca/eol/ach.allc.2005/xhtml.xq%3Fid=162.html
32. *Understanding and explaining Delta measures for authorship attribution* (normalisation is the decisive factor;
    the deviation profile matters, not the extent) — https://doi.org/10.1093/llc/fqx023
33. *Testing Burrows's Delta* (remove personal pronouns and single-text-dominated words; more than 150 words is
    better) — https://doi.org/10.1093/llc/19.4.453
34. *Function Words in Authorship Attribution. From Black Magic to Theory?* (0.04% of vocabulary = half of running
    words; topic-independence; character n-grams as the strongest feature type) —
    https://aclanthology.org/anthology-files/anthology-files/pdf/W/W14/W14-0908.pdf
35. Writeprints, ACM TOIS 26(2) (94% accuracy across 100 authors; individual-author feature sets; information gain;
    pattern disruptors; 5,513 common misspellings) — https://doi.org/10.1145/1344411.1344413  ·
    https://ahmedabbasi.com/wp-content/uploads/J/AbbasiChen_Writeprints_ACMTOIS.pdf
36. writeprints-static feature inventory with exact counts (153 function words, 26 letters, 10 digits, 22 special
    chars, 9 punctuation, 12 POS, hapax/dis ratio) — https://github.com/ashenoy95/writeprints-static
37. Other stylometry toolkits reviewed for feature *shape* (not benchmarked): pystylometry (50+ metrics: Burrows'
    Delta, Cosine Delta, Zeta, MTLD, MATTR, function words, punctuation, register, drift) —
    https://github.com/craigtrim/pystylometry ; Styloscope (exact CSV output set incl.
    `punctuation_distribution.csv`, `function_word_distribution.csv`, `pos_profile.csv`) —
    https://github.com/clips/styloscope ; writeprints PyPI extractor — https://github.com/shaoormunir/writeprints ;
    SuperStyl (char 3-grams + SVM, rolling stylometry) — https://github.com/SupervisedStylometry/SuperStyl
38. *Experimental Modeling of Writing Styles for Authorship Verification via Punctuation Analysis* (9 punctuation/
    structure features; Dickens/Hemingway/Poe) — https://doi.org/10.1016/j.procs.2025.12.122
39. *Fightin' Words* (log-odds with informative Dirichlet prior; α₀ = 500-word prior sample; why zero-fudging fails;
    obscure-word domination) — https://doi.org/10.1093/pan/mpn018  ·
    https://languagelog.ldc.upenn.edu/myl/Monroe.pdf
40. *Significance Testing of Word Frequencies in Corpora* (χ² and log-likelihood ratio are anti-conservative;
    recommend t-test, Wilcoxon rank-sum, or bootstrap; dispersion) —
    http://users.ics.aalto.fi/lijffijt/articles/lijffijt2015a.pdf
41. *A Language Model Approach to Keyphrase Extraction* (pointwise KL vs likelihood ratio; phraseness +
    informativeness; BLRT discussion) — https://aclanthology.org/W03-1805.pdf
42. *“Depends on Who I'm Writing To”* (emoji rate strongly influenced by partner; attribution: emoji functions
    ~33%, emoji types 50%, emoticons 100%; Big-Five correlations) —
    https://www.frontiersin.org/journals/communication/articles/10.3389/fcomm.2022.840646/full
43. *Automatically Constructing a Normalisation Dictionary for Microblogs*, EMNLP 2012 (distributional similarity +
    string re-ranking; frequency baselines fail) — https://aclanthology.org/D12-1039.pdf
44. *Lexical Normalisation of Short Text Messages*, ACL 2011 (dictionary lookup + word similarity + context;
    5,021-item slang dictionary; morphophonemic features) —
    https://www.cl.uni-heidelberg.de/courses/ws13/twitternlp/han-baldwin-acl11.pdf
45. `nbnhhsh` pinyin-abbreviation decoder (community dictionary; Weibo/Tieba/Bilibili userscripts) —
    https://toolshu.com/en/web/160
46. Chinese netspeak reference list with era/origin metadata (yyds, 666, awsl, 内卷, 躺平, 破防; 41 terms) —
    https://recatools.com/netspeak-decoder/
47. *What Helps Transformers Recognize Conversational Structure?*, TACL 2021 (punctuation/casing is the dominant
    factor; DSER 14.2% → 32.9% and 8.4% → 17.5%; context fixes rare dialog acts from >50% unrecognised to <10%) —
    https://aclanthology.org/2021.tacl-1.69.pdf
48. *RSM-DCK: Learning to Detect Relevant Contexts and Knowledge for Response Selection* (response selection framing;
    two-pass context/response selection) — https://arxiv.org/html/2509.22845v1
49. *Microblog retrieval challenges and opportunities* (BM25 free parameters → 0 ⇒ BM25 becomes IDF; TF/DL offsets
    +29.41% P@30) — https://exa.ai/library/publication/zyfn6wg5q2l8l5j37s87cnk2
50. *Reciprocal Rank Fusion outperforms Condorcet and individual rank learning methods*, SIGIR 2009 (k = 60;
    4–5% average improvement; sign tests p ≈ 0.008–0.04) — https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf
51. Elasticsearch Labs, hybrid retrieval (RRF +18% NDCG@10 over BM25; linear combination better but not
    transferable) — https://www.elastic.co/search-labs/blog/improving-information-retrieval-elastic-stack-hybrid
52. Weaviate hybrid search explained (default `alpha = 0.75`; `relativeScoreFusion` default vs `rankedFusion` k=60) —
    https://weaviate.io/blog/hybrid-search-explained
53. Elasticsearch Labs, MMR (formula; λ guidance 0.3–0.5 discovery, 0.7–0.9 precision; reranking depth cost) —
    https://www.elastic.co/search-labs/blog/maximum-marginal-relevance-diversify-results
54. Elasticsearch `diversify` retriever docs (mmr type, `lambda`, `size`, order preservation) —
    https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/diversify-retriever
55. *Beyond Dialogue Time: Temporal Semantic Memory*, ACL Findings 2026 (semantic vs dialogue time; durative
    memory; up to 12.2% absolute gain) — https://aclanthology.org/2026.findings-acl.1496.pdf
56. *Learning User-Aware Recall: Personalized Retrieval in Long-Term Conversational Memory* (profile-embedding
    prior in the ranking score; λ = 0.8 optimal; GRPO query rewriter) — https://arxiv.org/html/2607.00017v2
57. *LAPDOG: Learning Retrieval Augmentation for Personalized Dialogue Generation* (retriever optimised toward
    generator metrics; candidate augmentation for diversity) — https://arxiv.org/pdf/2406.18847
58. *Prototype-to-Style* framework (mask stylistic words out of the retrieved response to build a neutral
    prototype; de-noising to prevent uncritical copying) — https://arxiv.org/pdf/2004.02214
59. *StyleChat* (StyleEval dataset: 38 styles / 24,728 dialogues; recitation-augmented memory; recite-then-respond
    at training, recall-then-respond at inference) — https://arxiv.org/html/2403.11439
60. *Self-Refine*, NeurIPS 2023 (~20% absolute average; dialogue 25.4% → 74.6%; actionable vs generic vs no
    feedback 43.2 / 31.2 / 0; more iterations help) — https://arxiv.org/abs/2303.17651  ·
    https://papers.neurips.cc/paper_files/paper/2023/file/91edff07232fb1b55a505a9e9f6c0ff3-Paper-Conference.pdf
61. *Revisiting the (Sub)Optimality of Best-of-N* (BoN optimal for win-rate at tuned N; non-monotone under reward
    hacking; E_M-regularised variant) — https://arxiv.org/html/2603.05739v1
62. *Is Temperature the Creativity Parameter of Large Language Models?* (weak novelty correlation; moderate
    incoherence correlation; no cohesion/typicality relation) — https://doi.org/10.48550/arxiv.2405.00492
63. *Escaping Mode Collapse in LLM Generation via Geometric Regulation* (92% collapse at t = 0.7; RMR 8% → 56%;
    entropy 1.0: 5% → 33%; top-k 50 / top-p 0.9 baseline) — https://arxiv.org/html/2605.00435v3
64. *Don't Repeat Yourself: Stopping Verbatim Loops at Sampling Time* (DRY parameters L, λ, β, B; 47% SER@4
    reduction; benchmarks preserved; <3% latency at 128K; adoption in llama.cpp / ExLlamaV2 /
    text-generation-webui) — https://arxiv.org/html/2608.22761
65. Multigrid, repetition loops (the three penalties confused, with ranges; repetition_penalty > ~1.2 damages
    fluency; penalties are structure-blind and single-response-only) — https://multigrid.ai/learn/repetition-loops
66. OpenAI chat completions reference (`logit_bias` -100…100; temperature 0–2; top_p; "altering this or top_p but
    not both"; deprecated `seed`) —
    https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/
67. OpenAI help centre, logit_bias worked examples (banning `" time"` 640 / `"time"` 2435; `{"27000": 5}` for
    "microwave"; +1 often insufficient, +10 too strong) —
    https://help.openai.com/en/articles/5247780-using-logit-bias-to-alter-token-probability-with-the-openai-api
68. OpenAI Structured Outputs (`strict: true`; schema subset; "constrains the shape of the JSON, not only its
    validity"; `refusal` field) — https://developers.openai.com/api/docs/guides/structured-outputs  ·
    https://developers.openai.com/cookbook/examples/structured_outputs_intro
69. llama.cpp GBNF grammars (JSON-schema → GBNF; "the JSON schema is only used to constrain the model output and
    is not injected into the prompt"; known limitations) — https://github.com/ggml-org/llama.cpp/blob/HEAD/grammars/README.md
70. llama.cpp grammar internals (sampler masks logits per step; llguidance alternative engine) —
    https://factory.ai/open-source-wikis/llama-cpp?page=systems%2Fgrammar.md
71. TensorRT-LLM post-processing hook (`emit` / `suppress` / `terminate`; per-chunk; text channel only) —
    https://nvidia.github.io/TensorRT-LLM/1.3.0rc22.post1/features/post-processor-hook.html
72. Stop sequences in LLMs (exact/case-sensitive matching; the stop string is excluded from output; pitfalls) —
    https://www.rohan-paul.com/p/stop-sequences-in-llms-concept-and
73. DeepSeek API V4 reference (temperature guidance 0.0/1.0/1.3/1.5; top_p 1.0 recommended; local deployment
    t = 1.0, top_p = 1.0; "do not copy OpenAI or Claude defaults into DeepSeek") —
    https://deepseekai.guide/api/deepseek-api-documentation/
74. DeepSeek API docs index (OpenAI/Anthropic-compatible base URLs and model names) — https://api-docs.deepseek.com/  ·
    https://api-docs.deepseek.com/guides/reasoning_model
75. DeepSeek models & pricing (prefix cache hit vs miss pricing; `deepseek-chat`/`deepseek-reasoner` deprecation
    mapping) — https://archive.ph/dZZN7
76. *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena* (>80% agreement; position bias — only GPT-4 >60%
    consistent; name bias; verbosity "repetitive list" attack defeats all judges; self-enhancement GPT-4 +10%,
    Claude-v1 +25%; reference-guided 70% → 15% failure) — https://arxiv.org/html/2306.05685v4
77. Self-preference bias measurement across 20 models ("Machiavellian Judges"; structured multi-dimensional
    prompting −31.5% SPB) — https://arxiv.org/html/2605.04305v1  **[UNVERIFIED arXiv id]**
78. LLM-as-judge implementation guide (both-orderings protocol; position-flipped gate ~10%; reasoning before
    score; 1–4/1–5 anchored scales; HF cookbook 0.567 → 0.843 Pearson; token-probability scoring; pairwise 85%
    agreement) — https://jatinbansal.com/ai-engineering/llm-as-judge/
79. 15 LLM-as-a-judge prompt templates (5 foundations + 10 rubrics; reasoning-before-score; tone rubric with
    pairwise recommendation) — https://promptassay.ai/blog/llm-as-a-judge-prompt-templates
80. *The Hitchhiker's Guide to Testing Statistical Significance in NLP* (parametric vs sampling-free vs
    sampling-based; sign/Wilcoxon/permutation/paired bootstrap; small-test-set caveat) —
    https://aclanthology.org/P18-1128.pdf
81. Pairwise bootstrap / Fisher-Pitman implementation note and "LLMs homogenize writing styles, reducing
    writing-complexity variance by a statistically significant 21–50%" — https://arxiv.org/pdf/2502.11266
82. *TURING: Evaluating Human Abilities to Identify AI-Generated Texts*, LREC 2026 (59% human accuracy; 9,164
    annotations; genre effects; automated tools 88%) — https://lrec.elra.info/lrec2026-main-355
83. *Bot or not* (Study 2: 39.39% correct — below chance, p < .001; Study 3: 51.97% — chance; reliance on
    "language" or "enjoyment" predicted *incorrect* answers) —
    https://www.cambridge.org/core/services/aop-cambridge-core/content/view/45E6DC0BB90AA648654D5AE243F6C667/S1930297526100424a.pdf/bot-or-not-can-people-tell-the-difference-between-stories-written-by-a-human-or-by-an-ai-system.pdf
84. *ACUTE-Eval* (multi-turn pairwise with one speaker highlighted; why single-turn pairwise and multi-turn Likert
    fail; self-play) — https://doi.org/10.48550/arxiv.1909.03087
85. *FFAEval* (free-for-all ranking with shared dialogue history; TrueSkill; why shared history is fairer) —
    https://p.rst.im/q/aclanthology.org/2023.findings-emnlp.1049.pdf
86. *Do LLMs write like humans? Variation in grammatical and rhetorical styles* (Biber features; systematic
    differences persist across model scale; larger for instruction-tuned models) —
    https://pmc.ncbi.nlm.nih.gov/articles/PMC11874169/
87. *Can You Make It Sound Like You? Post-Editing LLM-Generated Text for Personal Style*, ACL 2026 (n=81;
    p = .0002, g = 0.55 toward own style; g = −0.41 away from LLM; PGW detector g = −0.45; residual LLM style
    remains; first-draft ceiling) — https://aclanthology.org/2026.acl-long.2030.pdf
88. Pangram, why perplexity and burstiness fail (perplexity is model-relative; false positives on
    training-set-like text and on non-native English; 61.3% FPR on TOEFL essays per the 2023 Stanford study) —
    https://www.pangram.com/blog/why-perplexity-and-burstiness-fail-to-detect-ai
89. Perplexity/burstiness limits explainer (definitions; triage framing; 2026 shift to neural classifiers) —
    https://www.eyesift.com/blog/perplexity-and-burstiness-ai-detection/
90. PICON persona-interrogation framework (internal/external consistency, retest stability; OpenAI-compatible
    endpoint support; num_turns=20, num_sessions=2) — https://github.com/KAIST-Edlab/PICon-pkg
91. harness/harness-evals (five dimensions; ConversationCoherence / KnowledgeRetention / RoleAdherence / RubricJudge /
    Pairwise / GEval; ConversationGolden SIMULATE / REPLAY / SCRIPTED / GRAPH) —
    https://github.com/harness/harness-evals
92. *Measuring and Controlling Persona Drift in Language Model Dialogs* (drift within 8 rounds; attention decay;
    split-softmax vs system-prompt repetition; 100 prompts / 200 conversations) —
    https://arxiv.org/html/2402.10962v1  ·  code: https://github.com/likenneth/persona_drift
93. *Persona Drift Detection in Role-Playing Agents: A Multi-Dimensional Consistency Framework*, ICASSP 2026
    (TtFD; hard/soft facts + stylistic features; 100-round simulations across ChatGPT/Qwen/Gemini/DeepSeek) —
    https://doi.org/10.1109/icassp55912.2026.11463024  **[abstract only]**
94. *Audience-Modulated Variation in Online Social Media* (nonstandard-variable frequency inversely related to
    audience size) — https://doi.org/10.1215/00031283-3130324
95. *Style Shifting from Cypriot towards Greek Phonology* (addressee vs auditor effect; 15% / 43% / 99–100%;
    addressee shift ~3× auditor shift; 32% and 50% average shifts across audience configurations) —
    https://doi.org/10.1163/15699846-13130105
96. *Style-shifting and accommodative competence in Late Middle English written correspondence* (addressee and
    referee-based accommodation in letters) — https://doi.org/10.1515/flih-2018-0014
97. Hilte et al., accommodation in instant messaging (n=254; 49% → 69% → 70% → 78% "get along well" by mirroring
    degree, p < .0001; education track as the non-accommodated variable) —
    https://repository.uantwerpen.be/docman/irua/629176/2023_hilte_jlsp_prefinaleauteursversie.pdf
98. StuTS 73: Textual Variation in Instant Messaging — An Audience Design Approach (situational factors dominate;
    no significant personal style change; women showed greater variation) —
    https://talks.stuts.de/es/stuts73/public/events/1000
99. *Communication Accommodation in Instant Messaging: An Examination of Temporal Convergence* (convergence on
    length and duration of contributions; relational/conversational context effects) —
    https://journals.sagepub.com/doi/10.1177/0261927X12462695
100. *The Evolution of the Idiolect over the Lifetime*, Journal of Cultural Analytics (CIDRE; 10/11 corpora show
     above-chance chronological signal; year-prediction from motifs; "not all linguistic features evolve") —
     https://culturalanalytics.org/article/id/749/
101. *Tracking the evolution of literary style via Dirichlet–multinomial change point regression* (Pratchett:
     gradual drift + abrupt change at diagnosis; Christie: gradual only) —
     https://ideas.repec.org/a/bla/jorssa/v183y2020i1p149-167.html
102. *Digital tildes (“∼”) in Chinese WeChat messages* (543 messages; 89.32% speech acts; expressives 41.07%,
     directives 24.31%; sound extension / pragmatic / entertaining functions) —
     https://doi.org/10.1515/lass-2023-0009
103. *Naturalness of WeChat typed talk* (quasi-synchronicity; adjacency broken and recovered by the 7.0.9 citing
     affordance; message recall; bracket annotation; tickling) —
     https://public-pages-files-2025.frontiersin.org/journals/communication/articles/10.3389/fcomm.2023.994192/pdf
104. *Disentangling Codemixing in Chats: The NUS ABC Codemixed Corpus*, ACL Findings 2026 (355,641 messages;
     ~30% code-mixed; 36.7% in intimate short messages; mixing coefficient b = 0.71; length b = 0.50; LIWC
     correlations) — https://aclanthology.org/2026.findings-acl.80.pdf  ·  https://arxiv.org/pdf/2506.00332
105. *Robust stylometric analysis and author attribution based on tones and rimes* (Mandarin tones/rimes/motifs;
     SVM and random forests) — https://doi.org/10.1017/s135132491900010x
106. *CCTAA: A Reproducible Corpus for Chinese Authorship Attribution*, LREC 2022 (819 function character n-grams:
     262 uni / 545 bi / 10 tri / 2 quad; both SVM and Chinese RoBERTa baselines underperform on cross-topic prose) —
     https://aclanthology.org/2022.lrec-1.633.pdf
107. xming521/WeClone (the reference project: Qwen2.5-VL-7B-Instruct + LoRA SFT; Telegram JSON export;
     individual chats only; WeChat via openclaw-weixin; localized fine-tuning + deployment) —
     https://github.com/xming521/WeClone  ·  https://github.com/xming521/WeClone/blob/master/README.md
108. ahsan37/iMessage-QLoRA (Llama-3.1-8B-Instruct + QLoRA via Unsloth on a rented Lambda GPU; `--redact`;
     config-driven training) — https://github.com/ahsan37/iMessage-QLoRA
109. Edward Donner, *Fine-tuning an LLM on your texts, part 4 — QLoRA* (r=16, 1 epoch, paged_adamw_32bit,
     max_grad_norm=0.3, warmup_ratio=0.03, group_by_length, save_total_limit=10, OOM advice) —
     https://edwarddonner.com/2024/01/31/fine-tuning-an-llm-on-your-text-messages-using-qlora/
110. *Customizing LLM Generation Style using Parameter-Efficient Finetuning*, INLG 2024 (StyleTunedLM; 80k tokens;
     5%/35% data "significantly low"; Eder's 5,000–10,000-word attributions threshold; named-entity masking does
     not hurt style; LoRA merging preserves instruction following) —
     https://aclanthology.org/2024.inlg-main.34.pdf
111. CloudHostReview, RunPod vs Vast.ai 2026 (worked 8-hour A100 LoRA job: $13.12 / $8.80 / ≈$24.50; the dead-host
     anecdote; "start with RunPod / use Vast.ai for cheap experiments") —
     https://cloudhostreview.com/article/runpod-vs-vast-ai-2026-comparison
112. tech-insider.org, RunPod vs Lambda vs Vast.ai GPU pricing 2026 (per-GPU-hour table by tier) —
     https://tech-insider.org/runpod-vs-lambda-vs-vast-ai-2026/
113. Together AI privacy and security (ZDR by default; training opt-in off by default; personal vs organization
     scope; separate passthrough toggle; third-party models run on Together infrastructure) —
     https://docs.together.ai/docs/privacy-and-security
114. startupgeek.org, personal AI fine-tuning (neutral→styled pairs; data minimization / strip PII before upload;
     "50 to 100 high-quality examples" for a meaningful shift; overfitting vs underfitting; blind comparison) —
     https://startupgeek.org/personal-ai-fine-tuning-training-a-model-on-your-own-writing-style/
115. Persona Vectors (arXiv 2507.21509): automated extraction from a natural-language trait description;
     10 rollouts per prompt; response-token activations; layer selection; evil/sycophancy/hallucination plus
     politeness/apathy/humor/optimism; inference-time vs preventative steering; projection-difference data flagging —
     https://arxiv.org/pdf/2507.21509  ·  code: https://github.com/safety-research/persona_vectors
116. Anthropic, emotion concepts and their function (171 emotion words; local not persistent; causal influence on
     preferences and misaligned behaviour; post-training shifted activations toward broody/gloomy/reflective) —
     https://arxiv.org/html/2604.07729v1  ·  https://www.anthropic.com/research/emotion-concepts-function
117. Activation Addition (ActAdd): contrast-prompt activation differences; injection coefficient "between 3 and 15
     typical"; middle layers most effective; requires activation caching; overhead shrinks with model size —
     https://gwern.net/doc/www/arxiv.org/e36a6537cc575af8c5ce23817872da48ad21e2c9.pdf  ·
     https://openreview.net/notes/edits/attachment?id=91L4QwqDov&name=pdf
118. *Style Vectors for Steering Generative Large Language Models*, EACL Findings 2024 —
     https://aclanthology.org/2024.findings-eacl.52/
119. Author-Style Steering via Contrastive Activation Vectors (reproducible pipeline, mid-level layers) —
     https://research.ionio.ai/
120. hotwire-vllm (per-request activation steering inside CUDA graphs; `vllm_xargs` spec; TTFT 4.9 → 4.6 ms with
     all requests steered; slot budget and scale-palette limitation) — https://github.com/moudrkat/hotwire-vllm
121. steerscope (in-browser steering demo; contrastive activation addition; "incoherence zone" past the usable
     band; steering_scale = 0 is a bit-exact no-op) — https://github.com/millerharry/steerscope
122. Noren case study, "Can AI clone an unknown writer's style?" (367-line profile, 50+ patterns; per-generator
     scores 2.4–4.0; Opus as checklist vs Sonnet internalising; "No single model wins all voices"; six-year-old
     samples still held) — https://usenoren.ai/blog/gabriel-pickard-case-study
123. Syxo voice-prompt guide (500–800 words, five sections; 8 mechanical rules; 15–30 banned phrases; 3–5
     signature moves; the analyst extraction prompt; "three iteration rounds is typical") —
     https://www.syxoai.com/guides/ai-voice-prompts-complete-guide
124. AI/TLDR, prompting for tone and style (three signals weakest→strongest; 80–150-word style anchor; negative
     constraints beat positive instructions; style-vs-task separation; example-leakage trap; have the model infer
     the style guide from samples) —
     https://ai-tldr.dev/learn/prompt-engineering/prompting-basics/prompt-for-tone-and-style/
125. Eero Nevaluoto, *Teaching Claude to Write Like Me* (five published posts mined for recurring mechanics;
     reference document with real excerpts; em-dash rule baked into the skill and scrubbed from the skill's own
     instructions; ambition to keep the SOP format and blog voice as *opposite* objectives) —
     https://nevaluoto.fi/posts/teaching-claude-to-write-like-me-building-a-blog-post-skill/
126. Phrased (consumer "text like you" app: learns only the user's side from screenshots, **separate registers for
     casual vs work**, per-app register toggle, four tone-matched replies per tap; on-device text extraction) —
     https://phrased.app/
127. transformers.js (ONNX Runtime; CPU/WASM by default with int8 as the WASM default; `dtype` fp32/fp16/q8/q4;
     `env.localModelPath` / `allowRemoteModels` for fully offline operation; an Electron example ships in-repo) —
     https://github.com/xenova/transformers.js/blob/main/README.md  ·  https://registry.npmjs.org/@xenova/transformers
128. Mintplex-Labs/transformersjs-electron (the fork used by AnythingLLM Desktop to run transformers.js inside a
     packaged Electron app) — https://github.com/Mintplex-Labs/transformersjs-electron
129. 3p3r/cpu-embeddings (bundled quantised `all-MiniLM-L6-v2` ONNX; "runs entirely on CPU without requiring GPU
     acceleration"; `numThreads`; mean pooling + L2 normalisation) — https://github.com/3p3r/cpu-embeddings
130. Weport internal: `docs/agents/weclone.md` (current pipeline, constants, measured numbers, hard invariants) —
     repository file, not a URL.
