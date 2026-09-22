# WeClone Style-Fidelity Evaluation — a buildable design

**Status:** design document, v1. Target reader: the engineer who will implement it in
`electron/services/`. **No empirical results are reported here** — every number is either a
published figure (cited), a formula (reproducible), or a computed statistic (script included).
Anything I could not verify is marked `UNVERIFIED`.

**Question this answers:** *does this persona clone actually talk like the real person?* — for
Chinese/English code-mixed informal WeChat messages, typically 1–30 characters.

**Inputs used.** `_scratch/stream-pan.md` (PAN shared tasks, short-text attribution),
`_scratch/stream-metrics.md` (metric definitions and their power), `_scratch/stream-failures.md`
(documented failure modes), `02-academic.md` §3, `03-practitioner.md` §5. Supporting computation:
`_scratch/binom-power.mjs` (exact binomial tables reproduced in §4.4).

---

## 0. The verdict in one screen

**The single most important structural fact about this corpus: the whole evaluation problem is
dominated by one thing — you have ~104,000 messages *by the target author*, and the classical
literature's thresholds (5,000 words/document, 120 tweets/user, 500-word chunks) are thresholds
about *how much author text is needed*. You have roughly 1–4M tokens of it. The constraint is
therefore not data volume; it is (a) that the evaluation unit (one 1–30 character message) is
far below every published threshold, and (b) leakage.**

Two consequences drive the whole design:

1. **Per-message metrics are almost all noise; bundles are where the power is.** A 12-character
   message contains ≤ 11 character bigrams and ≤ 11 character trigrams. With 100-MFW Burrows
   Delta (the `stylo` default, `mfw.min = mfw.max = 100`) a 30-token message has frequency
   exactly 0 for most of the 100 features, so the "profile" is a near-degenerate presence/absence
   pattern over a handful of tokens. Burrows' own abstract gives **1,500 words for a verdict** and
   100 words merely for *shortlisting* (`stream-metrics` §1.1(d)). Do not show a per-message Delta.
2. **Exactly one metric family has principled per-message power: per-author token-level
   cross-entropy (bits-per-character / perplexity).** Because cross-entropy is an *average over
   tokens*, a 12-character message contributes 12 observations, not 1. Averaged over 200 generated
   messages that is ~2,400 observations with a valid standard error. Every other family either
   needs a bundle or degenerates. This is why §1.8 is the load-bearing metric section.

**The design, in order of what to build:**

| # | Component | Unit | Cost to build | Why it earns its place |
|---|---|---|---|---|
| 1 | **Held-out next-message benchmark** (§3) | 200 cases | 1–2 days + <$2 of API | The only design with a fixed chance level and a real ceiling; it makes every other number interpretable |
| 2 | **Per-author char-n-gram LM cross-entropy** (§1.8) | message, pooled | ~300 lines TS | The one per-message metric with published power at 20–40 tokens on informal text |
| 3 | **Burst-size + length distribution** (§1.4) | window | ~100 lines TS | Currently *unmeasured* and structurally impossible for the clone to match today (it emits one message per turn) |
| 4 | **Punctuation / casing / script-mix / emoji rate deltas** (§1.3, §1.5) | message, reported as rate over ≥50 | ~150 lines TS | Works at message length; punctuation n-grams generalise best across topic |
| 5 | **Char n-gram JSD on 100-message bundles** (§1.1) | bundle | ~80 lines TS | Cheap, robust, language-independent; a regression tripwire, not a headline |
| 6 | **AV framing: verifier AUC / EER + accepted%** (§1.9) | pair set | ~200 lines TS | Produces a *thresholded decision*, which is what "shipped or not" needs |
| 7 | **Owner identification test** (§4) | 30–60 trials | 25 min of the owner's time | The only ground truth; with the binomial tables it becomes a real instrument instead of an anecdote |
| 8 | Frozen corpora + golden outputs + cost model (§5) | — | 0.5 day | Without this, a code change is unmeasurable |

**What to delete from the plan:** NCD/gzip (§1.7 — noise at chat length), MAUVE (needs ~5,000
samples per side), BERTScore/BLEU/ROUGE as *primary* style metrics (§1.9 note — they reward fluent
generic text and are structurally blind to function words and punctuation), TTR/Yule's K/Simpson's
D (§1.6), and any per-message lexical-diversity or sentence-length statistic.

**A note on the existing code — the circularity trap.** `electron/services/weCloneFingerprint.ts`
already computes, from the corpus: `lengthHistogram` (bucket `max` = 3/8/16/30/60/∞), `markers`
(punctuation and interjection rates per 100 messages), `endsWithPunctuation`, `emojiRatio`,
`latinRatio`, `noPunctuationRatio`, `phrases`, `englishPhrases`, `avgLength`, `medianLength`.
Those exact quantities are rendered into the model's system prompt (`renderFingerprint`). **If you
score the clone with the same statistics you prompted it with, you are measuring instruction
following, not imitation.** The separation rule is in §1.11 and it is not optional.

---

## 1. The metrics that survive at 1–30 characters

Notation throughout: a message `m` is a Unicode NFC-normalised string; `|m|` is its length in
**grapheme clusters** (not UTF-16 code units — see §2.2). A *bundle* is a contiguous run of `B`
messages by the target author. "Real" means held-out target-author messages; "clone" means
generated messages produced under evaluation.

### 1.0 The sample-size arithmetic that kills most metrics

Fix this table in your head before choosing anything:

| unit | count available from one 12-char message | count from one 30-char message |
|---|---|---|
| characters (graphemes) | 12 | 30 |
| char bigrams (`n=2`) | 11 | 29 |
| char 4-grams (`n=4`, the PAN `cngdist` substrate) | 9 | 27 |
| tokens (Chinese char ≈ 0.6 tok, English char ≈ 0.3 tok, per DeepSeek's own token guide) | ~4–7 tok | ~9–18 tok |
| "words" for a Burrows Delta profile | 0–3 non-zero features out of 100 | 0–18 non-zero out of 100 |
| sentence-length samples | 1 | 1 |
| lexical-diversity factors (MTLD, TTR threshold .720) | 0 (undefined) | 0–1 |

A *distribution* estimated from one observation is not a distribution. Anything in this document
whose unit of computation is "a distribution" needs a bundle; anything whose unit is "an average
over tokens" works per message. That single distinction explains every verdict below.

### 1.1 Character n-gram distribution divergence — bundle-level; the cheap workhorse

**Why character n-grams.** They are the one feature family with published support on *short,
noisy, code-mixed* text: PAN's `cngdist` baseline uses cosine similarity over the most common
**4-character frames** (`stream-metrics` §1.4); Koppel & Winter's 500-pair verification used the
100,000 most frequent space-free **character 4-grams** with tf-idf and got **87.4 %** accuracy
with the impostors method (`stream-pan` §2.2); Sapkota et al. NAACL 2015 found affix+punctuation
n-grams alone match all-n-gram models and that **punctuation n-grams generalise best across
topic**; Bagnall's PAN-2015 ablation reached **AUC 0.85 (EN) / 0.91 (ES)** with a *zero-width*
recurrent layer — i.e. character unigram biases alone (`stream-pan` §1.5). They also survive typos
and code-switching without a tokeniser.

**Definitions.** Let `P` and `Q` be the empirical distributions over the observed char-n-gram
vocabulary (union of both supports), normalised to sum to 1.

```
TVD(P,Q)  = 1/2 · Σ_g |P(g) − Q(g)|                       ∈ [0,1]
JSD(P,Q)  = 1/2 · KL(P‖M) + 1/2 · KL(Q‖M),  M = (P+Q)/2    ∈ [0, log 2] nats
JSDist    = sqrt(JSD)                                      ∈ [0, 1] (a metric)
cos(P,Q)  = (P·Q) / (‖P‖₂ ‖Q‖₂)                             ∈ [0,1]
d_cos     = 1 − cos
```

**Smoothing is mandatory for KL, and JSD is preferable anyway.** In a short bundle it is the
*norm* that a 4-gram present in the clone is absent from the reference, so raw KL is `+∞`.
Krichevsky–Trofimov (KT) smoothing `p̂ = (c + 1/2)/(N + V/2)` is the estimator recommended in the
MAUVE line of work and is what you should use if you ever want KL. JSD is always finite for a
common support and is symmetric, so use JSD as the default.

**Reference implementation (TS, ~80 lines).**

```ts
function charNgramDist(messages: readonly string[], n: number, opts: {foldWidth: boolean}) {
  const counts = new Map<string, number>(); let total = 0;
  for (const raw of messages) {
    const s = normaliseForNgrams(raw, opts);           // see §2.5 — the frozen tokeniser spec
    for (let i = 0; i + n <= s.length; i++) {
      const g = s.slice(i, i + n);                      // NB: operate on an array of graphemes, not on UTF-16
      counts.set(g, (counts.get(g) ?? 0) + 1); total++;
    }
  }
  const dist = new Map<string, number>();
  for (const [g, c] of counts) { const p = (c + 0.5) / (total + counts.size / 2); dist.set(g, p); }   // KT
  return dist;
}
// JSD in bits; returns [jsDistance, tvd, cosine]
export function compareCharNgrams(real: readonly string[], clone: readonly string[], n = 4) { /* ... */ }
```

**Bundle size.** With n=4 and B messages of ~12 characters, the bundle has ~9B 4-grams. You need
the number of 4-grams per *bundle* to be ≳ a few thousand before the divergence estimate stops
being dominated by which 4-grams happened to be rare: **B ≥ 200 messages** (≈2,400 characters,
≈2,160 4-grams) for a stable JSD; **B ≈ 500** if you want the number to move by less than its own
noise between two draws of the *same* author. `N_limit` check: O(V·B) memory is fine for a JS app.

**Honest power assessment.**
- At **B ≈ 200–500** this is a real, low-variance signal that reliably separates author A's real
  messages from author B's, in every published result I have (`stream-pan` §5.3, §6).
- It is **NOT** sensitive enough to say "config X is better than config Y" unless the difference
  is large. Its own noise floor is what you must measure first: split the *real* held-out messages
  into two disjoint halves of size B, compute JSD between them, repeat 200× → that distribution is
  your **within-author reference**. Report a clone's JSD as a **percentile of that reference**, not
  as a raw number. A raw JSD of 0.31 is meaningless; "worse than 94 % of same-author split-half
  comparisons of this person against himself" is a verdict.
- At **B < 50** it is noise. At **B = 1** it is undefined (empty vocabulary overlap, JSD=0 by
  accident, or infinite for KL).
- A known contamination: char n-grams proxy **content** as well as style — Koppel et al. 2009
  interpret `dsh` as a proxy for `spreadsheet`, and the EMNLP-2025 study found zero-shot
  attribution accuracy on short generations was "largely driven by topical/content overlap"
  (`02-academic` §3.1). Therefore **always run a content-only control**: a generic LLM given the
  same topic, scored the same way. If the clone does not beat the content-only control, the metric
  is measuring the topic.

### 1.2 Function-word / stopword-vector cosine and Burrows Delta variants — bundle-level only

**Formulas (classic Delta, as in `stylo`).** For the `k` most frequent features in the reference
collection, with `f_i(D)` the relative frequency in text `D`, `μ_i`, `σ_i` the mean and sd across
the collection texts:

```
z_i(D)       = ( f_i(D) − μ_i ) / σ_i
Delta_B      = Σ_i | z_i(D) − z_i(D') |                    (Manhattan / L1;  ''stylo'' default)
Delta_angle  = arccos( (z(D)·z(D')) / (‖z(D)‖₂ ‖z(D')‖₂) )  (Cosine Delta / Würzburg)
```

**Defaults and the documented variants** (`stream-metrics` §1.1–1.3): `stylo` ships
`mfw.min=mfw.max=100`, `culling = 0`, `distance.measure = "delta"` (Manhattan on z-scores),
`analyzed.features = "w"`, lowercased, z-scores from the primary set only. Smith & Aldridge found
**200–300 words optimal** for classic form. Evert et al. 2015 found Cosine Delta consistently
outperforms the other variants and stays robust to `k` up to 10,000, and identified the operative
lever as **vector normalisation, not the metric choice** (L2-normalised Quadratic Delta and Cosine
Delta are equivalent).

**Chinese function-word support.** Chinese function words are an established, published feature
family: the URTC-2016 Chinese-Twitter study found "function words are valuable features in
attributing Chinese Tweets" (20.52 % at 10 authors). Building on Bei Yu 2012. So a Chinese
stopword vector is legitimate — but see §2.1 for why the tokeniser must be frozen.

**Honest power assessment — this is the worst-supported family for this corpus.**
- `stylo`'s own default is 100 word-MFW; on a 30-token message most are zero and the profile is a
  presence/absence pattern. **Per message: unusable.**
- Burrows' own thresholds: 1,500 words for a verdict, 100 words for shortlisting. Eder's length
  sweep found "samples shorter than 5,000 words provide a poor 'guessing'… Below the size of
  3,000 words, the obtained results are simply disastrous" (stabilising at 5,000–10,000 words).
  Sanderson & Guenter: ~5,000 training words required. PAN 2018 states the tension outright:
  function-word and char-n-gram features "require relatively long documents to be successful and
  they typically result in sparse, less useful representations for short documents" (`stream-pan` §5.3).
- **Do not measure Delta per message.** Use it as a **bundle** metric at B ≈ 250–500 messages
  (a 12-char message × 300 ≈ 3,600 characters ≈ 2,000+ tokens — still below Eder's 5,000-word
  comfort zone, so treat any bundle Delta as a *relative* tripwire, never as an absolute verdict).
- There is one clean, non-negotiable use: `Delta_angle` over **char n-grams** rather than word
  MFW. That is the same computation with `analyzed.features = "c"` and is the variant recommended
  in `stream-metrics` §1.4 for exactly this corpus type.
- An unresolved implementation choice you must decide explicitly: whether `μ_i`,`σ_i` include the
  held-out document. `stylo`'s source comment says the primary set only (classical Burrows &
  Hoover); a literature snippet says `perform.delta()` includes the document under test. **Pick the
  primary-set-only convention, document it, and freeze it** (`stream-metrics` §1.3, item 2).

### 1.3 Punctuation + casing profile distance — the strongest rate-family at message length

This is the family with the most leverage in this project, for three reasons: a *rate* is defined
on a single message; punctuation generalises across topic better than any other feature family
(Sapkota et al. 2015); and code-mixed Chinese/English chat has an inventory no literary corpus
ever sees.

**The inventory that matters here** (all already enumerated as `MARKERS` in
`weCloneFingerprint.ts`): full-width vs half-width pairs `，/,` `。/.` `！/!` `？/?` `：/:` `；/;`;
`……` vs `。。。` vs `...`; `~`/`～`/`～～`; `、`; repeated `！！！`/`???`; quote glyphs `“”`/`""`;
space-after-punctuation; **sentence-final-punctuation rate** (`endsWithPunctuation` — lower is more
"微信"); no-punctuation-at-all rate; and for the Latin half, casing (`OK`/`ok`/`Ok`, `IDK`/`idk`,
all-caps words) and apostrophe elision (`dont`/`don't`, `im`/`i'm`).

**Feature vector.** For a bundle of `B` messages, form
```
F = [ p_1 … p_J ,  e_punct ,  noPunct ,  capsRatio ,  latinRatio ,  digitRatio ,  spaceRatio ]
```
where `p_j` = occurrences of marker `j` per 100 messages, and the ratios are per-character.

**Distances.** For the count vector use **chi-square on raw counts** (not on the normalised
rates — the χ² statistic already carries the sample size, which is what makes it the right test
for "is this difference larger than sampling noise at this B"):
```
χ² = Σ_j (O_j − E_j)² / E_j ,   E_j = B · (O_j^real + O_j^clone) / (2B)
df = J − 1  (drop markers with E_j < 5)
```
For the ratio block use JSD after KT smoothing, or simply report the absolute difference in
percentage points with a **Wilson 95 % CI** (§4.4 gives the CI function).

**Reference numbers, so you know what "big" means.**
- Baayen et al. 2002: adding **8 punctuation marks** to 50 function words raised attribution from
  **81.5 % → 88.1 %** — punctuation is not a garnish.
- Darmon et al. 2021 (651 authors, 14,947 Gutenberg documents): punctuation features, KL
  classifier, held-out accuracy — `f3` (joint probability of successive punctuation pairs) is the
  best single feature at **0.74 (10 authors)** falling to **0.41 (400 authors)**; `f1` (punctuation
  frequency) **0.69 → 0.27**. Same-author vs different-author KL distributions separated at
  **KS p ≤ 1.218e-79** for all six features.
- Sapkota et al. 2015: the best punctuation category (mid-punct) beat the best word category
  (whole-word) at **p < .05**.

**Honest power assessment.**
- **Per message: usable as a rate, but the per-message variance is large.** `#exclamation marks`
  on a 12-character message is an integer in {0,1,2}. Do not compute a chi-square per message.
- **Sliding window of B ≥ 50 messages: good.** B ≥ 200 for a stable χ². Report the rate, the CI,
  and the χ² p-value together.
- **A caution from the same literature:** Darmon et al.'s `f4` (sentence-length frequency vector)
  was the *weakest* of their six punctuation features (0.52 → 0.15). Do not lead with length. See
  §1.4 for the one length-based statistic that is worth having (burst size), and note it is a
  different quantity from sentence length.

### 1.4 Message-length and burst-size distributions — the untapped metric

**Two different quantities, often conflated:**

1. **Message length distribution** — `L = |m|` in graphemes. Compare with **Kolmogorov–Smirnov**
   (statistic `D = sup_x |F_real(x) − F_clone(x)|`, distribution-free, use the exact/asymptotic
   p-value) and/or **1-Wasserstein** `W₁ = ∫|F_real(x) − F_clone(x)| dx` (interpretable: "the
   clone's lengths are on average N characters away"). A chi-square over the existing
   `LENGTH_BUCKETS` is also fine but is sensitive to bucket choice — report it only as a secondary
   view, and use `LENGTH_BUCKETS` exactly as the code already defines them (3/8/16/30/60/∞) so the
   number is comparable across runs.
2. **Burst size** — the number of consecutive messages the author sends before the other party
   replies. This is a *different* and, for a chat corpus, stronger idiolect marker: some people
   send one 40-character message, others send four 8-character ones. It is trivial to compute from
   the dated corpus and it is **currently unmeasured by Weport and structurally unmatchable by the
   clone.** The clone emits one message per turn; if the owner's median burst is 3, the clone is
   wrong on a visible, high-frequency dimension regardless of how good each individual line is.

**Power assessment — and it is brutal for per-message use.**
- **Message length, per message: 1 sample.** A distribution over one point has zero information.
  Useless per message. Yule 1939 needed **~600 sentences per author** for stability; that is
  ~300–600 chat messages. TextPulse (grey literature, non-peer-reviewed) found human CV of
  sentence length 0.449 vs AI 0.376 and concluded explicitly: "Burstiness distinguishes
  distributions with high confidence. **It does not identify individuals.**"
- **Message length, bundle: usable**, but it is confounded with *what the conversation is about*.
  Two speakers discussing a technical topic both write longer. Control by stratifying the held-out
  cases by the interlocutor and by the topic proxy (the previous message's length band), or by
  reporting the delta **per contact**.
- **Burst size: the best of the three, because the sampling unit is a *turn*, not a message.**
  A 200-case benchmark yields 200 turns; the burst-size distribution over 200 turns is a genuine
  distribution with a median and a sd, and the KS/Wasserstein/chi-square tests are properly powered
  at that N. Effect sizes here are likely to be huge (real median burst vs clone's constant 1),
  so this is the cheapest, most discriminating thing you can add.
- **Structural caveat:** burst size is partly a function of the *medium* (typing on a phone) and
  the *relationship*. Condition on contact.

### 1.5 Emoji & kaomoji deltas — usable, but only conditioned on the interlocutor

**What to count.** Per message and per bundle:
`emojiCount` (grapheme clusters matching `\p{Extended_Pictographic}`, see §2.2),
`kaomojiCount`, `emoticonCount` (ASCII: `:)`, `:D`, `xD`, `orz`, `233`, `awsl`, `xswl`),
`emojiTypes` (distinct clusters), `emojiPerMessage`, `emojiPerCharacter`,
`emojiFunctionShare` (Evans-2017-style functional classification),
plus WeChat media placeholders `[图片]` `[表情]` `[语音]` `[视频]` as a separate class.
Reuse `EMOJI_RE` / `KAOMOJI_RE` / the placeholder list already in `weCloneFingerprint.ts` — but
**fix them once and freeze them** (§2.5), and note the existing `KAOMOJI_RE` only covers a subset
(it matches bracketed ASCII faces and a small character class for `╯╰ノ゜°▽ω・´`). That is a
*measurement* limitation: under-counting kaomoji is fine as long as the same regex scores real and
clone; it is not fine if you change the regex between runs.

**Distances.** `ΔemojiPerMessage` in percentage points with a Wilson CI; a JSD/χ² over the
*type-frequency* histogram; and — per the ordering result below — a JSD over the **emoticon type**
histogram specifically, which is the most individuating of the three classes.

**Power assessment.**
- **Usable per message as a rate**; a single message's emoji count is a small integer, so report
  rates over windows of ≥ 50 messages.
- **The killer caveat, and it is quantitative:** the Frontiers-in-Communication 2022 study found
  the frequency of emoji use "is indeed strongly influenced by conversation partners" at
  **p = 0.001**, and that attribution based on emoji *functions* was "considerably reduced" in
  interactive data relative to non-interactive Instagram data. Ordering of individuating power:
  **emoticons > emoji types > emoji functions.** An unconditioned emoji-rate delta therefore
  measures **who you are talking to, not who is writing**. Compute the delta **per contact**, and
  report the number of contacts for which the clone's rate is inside the real per-contact range.
- Supporting: Segalin et al. 2012 (77 subjects, instantaneous messaging, turn-level features,
  **nAUC 89.5 %**, rank-1 29.2 %) built a content-free baseline from `#words`, `#emoticons`,
  `#emoticons/word`, `#exclamation marks`, `#question marks`, `#three points`, `#uppercase`, and
  used **exponential histograms** ("bins smaller for small values") precisely *because* the turns
  are short. Copy that binning choice.
- Counter-evidence to be honest about: the IPM-2008 chat study (1,616 users, 218,742 messages,
  **6.2 words/message**) found *vocabulary* use depends on the target while *communication style*
  depends only on the writer. Reconcile as: lexical/phonetic style is person-stable; **emoji
  frequency is partner-conditioned.**

### 1.6 Lexical richness — compute it, but never as a headline, and never per message

**Formulas** (`stream-metrics` §4.1; verified against `quanteda` and `lexicalrichness` references):

```
TTR        = V / N                                          (Chotlos 1944 / Templin 1957)
MATTR      = mean of TTR over all sliding windows of fixed size n   (Covington & McFall 2010)
MTLD       = N / (number of factors),  a factor ends when running TTR < 0.720  (McCarthy & Jarvis 2010)
Yule's K   = 10⁴ · [ −1/N + Σ_i f_v(i,N) · (i/N)² ]          (Yule 1944)
Herdan's C = log V / log N                                   (Herdan 1960)   [ ≠ Herdan's Vm]
Simpson's D= Σ_i f_v(i,N) · (i/N) · ((i−1)/(N−1))            (Simpson 1949)
```

**Length-sensitivity warnings — three independent ones.**
1. Tweedie & Baayen 1998: "almost all constants that have been proposed in the literature change
   systematically with the text length." Only `K(N)`, `D(N)`, `Z(N)` are theoretically constant,
   and they "may reveal significant deviation from their expected values in actual text." Their
   conclusion reduces the whole family to two useful measures (`Z(N)`, `K(N)`) and says using many
   different lexical constants "is unnecessary".
2. MATTR's "length-independence" holds **only at a fixed window**, and the ecosystem disagrees on
   the default: `quanteda::compute_mattr` and Python `lexicalrichness` both default to **100**;
   Kyle's `lexical_diversity` defaults to **50**. Halving the window moved one worked example's
   MATTR from **0.7206 to 0.7962 (+0.076)**. If you implement MATTR you must declare the window.
3. MTLD is the one with the strongest validity claim — McCarthy & Jarvis: "**the only index not
   found to vary as a function of text length**" across convergent, divergent, internal and
   incremental validity. But it needs at least one factor boundary; at threshold .720 a
   30-token message often has **zero** factors and MTLD is undefined.

**Verdict.** Per message (1–30 chars): **pure noise — do not compute.** Bundle: MTLD primary
(needs ≈ a few hundred tokens so that ≥5 factors exist), MATTR secondary with a **declared and
frozen window (recommend 25 or 50 tokens, not 100)**. Implement **both directions** of MTLD
(left-to-right and right-to-left) and average them, and record which variant you used — the
bidirectional convention is what implementations such as `taaled`'s `mtld_ma_bid` provide, but I
did **not** find a McCarthy & Jarvis passage mandating it (`stream-metrics` §4.3, marked
PARTIALLY UNVERIFIED). Use it as a *descriptor* attached to a regression report, never as a score.

### 1.7 Compression distance (NCD / gzip) — useless at chat length; keep it only as a copy detector

**Formulas** (`stream-metrics` §6.1, verbatim from Halvani, Winter & Graner 2017):
```
NCD(x,y) = ( C(xy) − min{C(x), C(y)} ) / max{C(x), C(y)}
CDM(x,y) = C(xy) / ( C(x) + C(y) )                    ∈ [0.5, 1]
CLM(x,y) = 2 − 1/CDM(x,y)                             ∈ [0, 1]
CBC(x,y) = 1 − ( C(x) + C(y) − C(xy) ) / sqrt( C(x)·C(y) )
```
with `C(·)` = compressed byte length.

**Why it dies here — three independent reasons, all quantitative.**
1. **The compressor's window.** Alfonseca et al. 2005: NCD is "strongly skewed with the size of the
   objects and window size", `NCD(x,x)` sits between 0.0 and 0.1 "in the region where gzip can be
   used properly, while it gives values which grow to 1 outside that region", with "a jump to 0.9
   at 32 Kbytes". Prescription: the block/window "should be at least as large as the sum of the
   sizes of the objects to be compared". A 24-byte Chinese message is inside gzip's header and
   entropy-coding overhead, not inside its useful region.
2. **The published minimum.** Cerra et al. (FCD): "it cannot be applied effectively to very short
   texts… we estimated empirically **1000 tokens or words**"; Halvani et al.'s own corpus texts are
   **≈2 KByte** and their best configuration (PPMd + CBC, threshold at EER) ran 500 cases in
   "few seconds".
3. **Dependency on the concatenation order and on shared boilerplate.** For chat messages that
   share greetings/particles, `C(xy)` is dominated by the shared formulaic material, so NCD mostly
   measures "how much template did both of you use".

**Verdict.** **Per message: noise. Do not use as a fidelity metric, ever.** One legitimate use at
this scale, and it is not a style metric: a **verbatim-replay alarm**. Compute the longest common
substring between each generated message and the *entire* corpus; a char-identical (or ≥ 90 %
overlapping) match of ≥ 8 characters flags regurgitation. The memorization literature makes this
necessary rather than optional: duplication drives memorization log-linearly, dedup "will not
perfectly prevent leakage", and extractability rose from **33 % → 65 %** as prompt context grew
50 → 450 tokens (`stream-failures` §5.1b). A WeChat log is *enormously* self-duplicated.

### 1.8 Per-author n-gram / small-LM cross-entropy — the only metric with per-message power

**Why this one works at 1–30 characters and the others do not.** Cross-entropy is
`H = −(1/N) Σ_t log p_θ(t_t | t_{<t})` — an average over *tokens*. A 12-character Chinese message
contributes ~7 token-observations; 200 messages contribute ~1,400–3,600. The estimator's standard
error scales as `σ/√n_tokens`, not `σ/√messages`. Every other family in §1.1–§1.7 is an average over
*messages*, of which you have exactly one per generation.

**The published support, and it is unusually direct.**
- Authorial Language Models (Huang et al., arXiv:2401.12005 / PLOS ONE 2025): fine-tune one causal
  LM per author, attribute to the lowest-perplexity model. Reported **83.6 % macro-accuracy on
  Blogs50** (SOTA), 74.9 % on CCAT50. The length ablation is the load-bearing number for this
  project: **70 % macro-accuracy needs 40 tokens on Blogs50** and **60 % needs 20 tokens** — and
  Blogs50 is the *informal, personal-writer* corpus. On informal text, **20–40 tokens suffices**.
- The follow-up analysis found **content-word classes carry more authorship information than
  function-word classes** — a direct challenge to the "it's all function words" folklore, and
  consistent with Koppel et al. 2009's own data ("in no case do they [content words] lead us
  astray"; character trigrams significantly outperform content words on blogs).
- The `ppl` direction check (arXiv:2509.24930): human essays average perplexity **29.5**, matched
  LLM outputs **15.2**; at threshold 20, ~90 % of generated texts fall below vs only ~15 % of human
  essays. "**stylistic fidelity and statistical detectability are separable**."

**Concrete implementation (three tiers, cheapest first; all implementable in TS).**

**Tier 1 — char-5-gram with interpolated Kneser–Ney, trained on the author only (~300 lines).**
Train on the author's messages (excluding the held-out window). Compute per-message
**bits-per-character** `BPC(m) = −(1/|m|) Σ_i log₂ p(c_i | c_{i−4..i−1})` and the equivalent
perplexity `2^BPC`. Report the **bundle mean BPC** over the clone's messages against the
distribution of per-message BPC over real held-out messages. Score = the clone's **percentile**
in that distribution (0 = as predictable as the most formulaic real message, 100 = as surprising
as the least). Two-sided: **too low is a failure mode too** — it means the clone is regurgitating
a habitual phrase, not speaking.
- Minimum grammatical n for the model: use a **char 3-gram model if your messages average < 6
  graphemes**, char 5-gram otherwise. Check the corpus's own `avgLength` (already computed by
  `computeFingerprint`) before choosing; freeze the choice with the baseline.
- Smoothing constants must be frozen in the golden-output test (§5).

**Tier 2 — a real small LM. `transformers.js`-style ONNX encoder/causal decoder is optional. If
you want a stronger signal, ship a small model and use `logprobs` if/when the provider exposes
them.** Note: DeepSeek's chat-completions API exposes `logprobs`/`top_logprobs` on some routes;
whether it does on the exact route Weport calls is `UNVERIFIED` and must be checked before
designing around it.

**Tier 3 — the likelihood-ratio / "one-class" framing, which needs no training at all.**
For each message, `LR(m) = CE_author(m) − CE_reference(m)`, where `CE_reference` is the same
n-gram model trained on a **matched contrast set**: the interlocutor's messages, or (better, per
the personalisation literature) a few authors "least similar to the current author"
(`stream-failures` §8.1). Report the median LR and its bootstrap CI. This is the cheapest thing
that produces a signed, interpretable number and it is the direct analogue of the impostors method
(Koppel & Winter 2014: 500-word documents, **87.4 %** with a blog-universe impostor set, using
min-max similarity and a threshold at the EER).

**Honest power assessment.**
- **The only metric in this document I would trust on a per-message basis**, and the only one whose
  minimum valid text length is published as **~20 tokens on informal text**.
- **Paired design is what makes it decisive here.** Evaluate config A and config B on the *same*
  200 held-out cases with the *same* context; then the relevant quantity is the distribution of
  `BPC_A(m) − BPC_B(m)` over cases, bootstrapped by case (§3.4). Topic and interlocutor variance
  cancel.
- **Failure mode to guard against:** BPC is *partly* a topic signal — a message about an unusual
  subject is inherently less predictable. Always report the content-only control on the same cases.
- **Corpus-size note:** 104k messages is far past the point where a char n-gram LM saturates
  (a char 5-gram over ~1–4M characters has dense counts across the range of Chinese characters
  actually used by one person). This is the one place where having 104k messages makes a
  *rigorous* metric possible rather than merely a convenient one.

### 1.9 The authorship-verification framing — ROC-AUC / EER with a threshold

Everything above produces a *distance*. A shipping decision needs a *decision*. The verification
framing gives you one, and it is the framing PAN has standardised for 15 years.

**Task.** Given the clone's message and a real message by the target author, decide whether they
are by the same author. This is "the fundamental problem" (Koppel & Schler 2004); verification is
a **one-class** problem, and PAN's own framing notes "every author identification problem with
multiple candidate authors can be transformed to a set of author verification problems."

**Construction (concrete).**
1. Positives: `(clone_i, real_i)` pairs where `real_i` is the real reply to the same context.
2. Negatives: `(clone_i, real_j)`, `i ≠ j` — draw 4 negatives per positive, matched on length band
   and contact so the negative is not trivially distinguishable by topic or length.
3. Score each pair with a fixed scorer. Start with the one you can build today:
   `s = α·cos_char4gram(clone, real) + β·(−|BPC_clone − BPC_real|) + γ·(−|len diff|)` — but note
   that a hand-weighted score is a *model*, and it must be fit on a **train** split of the clone's
   own generated pairs (never on the test cases). The training-free alternative with published
   accuracy is the TF-IDF-char-n-gram + embedding-distance-distribution verifier of
   arXiv:2509.24930 (**97.5 %** essays, **94.5 %** cross-domain — suspiciously high; re-validate on
   this corpus, and note its own paper reports zero-shot prompting at **< 7 %** accuracy as a
   contrast).
4. Report: **ROC-AUC** (threshold-free, and the correct primary because the same-author prior is
   unknown), **EER** along with the threshold value that achieves it, and **% accepted as
   same-author at the EER threshold**. Include a content-only control arm (§3.4) as a mandatory
   third series.

**Reference numbers for calibration.** PAN 2013 (85 problems, 3 languages): best individual F1
**0.753**, best AUC **0.777**, random baseline **0.500**. PAN 2014: best final score AUC·c@1
**0.490** vs a non-random baseline of **0.325**. PAN 2015: best macro **0.628**, and the ensemble
*stopped* being best. Voight-Kampff (PAN/ELOQUENT 2024, 43 systems, 70 test variants including
short-text and *language-switching* regimes): top system mean **0.924**; baselines Binoculars
0.741, PPMd-CBC 0.544, unmasking 0.467, and a mere "text length" baseline **0.604**. PAN 2025
subtask 1 leaderboard: winner **0.989** mean; TF-IDF-SVM baseline **0.922**; the PPMd-CBC
compression baseline **0.790**. **Read this two ways:** (i) machine-vs-human detection on short and
code-switched text is a *solved-ish* task when the machine text is generic — so a low AUC here
means your clone is loudly machine-written; (ii) but these AUCs are about *detectability*, not
*person-specific fidelity*, and §7 of `stream-failures` is explicit that fidelity and detectability
are separable. **Report both axes.**

**Correction to my own scratch notes.** `stream-metrics`' summary table states "PAN'23 compressor
baseline c@1 = 0.051". The retrieved PAN-2023 overview table is garbled at that row, and the
cleaner PAN-2025 leaderboard shows the same PPMd-CBC baseline at **c@1 0.759, mean 0.790**. **Do
not cite 0.051**; treat the PAN'23 value as `UNVERIFIED`.

**Power assessment.**
- **Valid per message** *if* the verifier is trained/calibrated on this person's own message-length
  distribution. This matters: PAN 2014's Dutch-reviews corpus (one known document, short texts) was
  the hardest; EER on microblog data with few training tweets is above **20–25 %** and drops below
  **15 %** once hundreds of training tweets exist (arXiv:2008.01533).
- **The CI must be clustered by case, not computed over pairs.** Each clone appears in 5 pairs
  (1 positive + 4 negatives), so pairs are dependent; a naive pair-level bootstrap gives a
  too-narrow interval. Resample **cases** with replacement, recompute all pairs, recompute AUC.
- **Do not optimise the threshold on the test set.** Fit the threshold on a disjoint split of
  generated cases; report it; refit only when the baseline changes, and then re-report the old
  threshold's performance on the new split so the two are comparable.

### 1.10 The "useless at chat length" list — with the reason, in one table

| Metric | Status at 1–30 chars | The reason (not a guess) |
|---|---|---|
| Burrows's Classic Delta, per message | **Useless** | Most of 100 MFW have frequency exactly 0; the vector is a presence/absence pattern. Burrows: 1,500 words for a verdict, 100 for shortlisting |
| Function-word cosine, per message | **Useless** | Same sparsity; ~30 tokens cannot populate a 100–500-dim profile |
| KL over raw n-gram counts | **Useless (mathematically invalid)** | `KL(P‖Q) = +∞` whenever the clone uses a 4-gram the reference lacks — the normal case here |
| TVD / JSD / cosine over n-grams, per message | **Useless** | ≤ 11 bigrams is not a distribution; estimate dominated by which rare grams appeared |
| Sentence/utterance-length distribution, per message | **Useless** | 1 sample. Yule needed ~600 sentences/author |
| TTR, Yule's K, Herdan's C, Simpson's D, per message | **Useless** | Documented systematic length dependence; degenerates at N=12 |
| MATTR, per message | **Useless** | With window ≥ 25 and N < 25 it *is* TTR; with window ≤ N it is TTR |
| MTLD, per message | **Useless / undefined** | No factor boundary is reached at threshold .720 in a 30-token text |
| NCD / gzip / zlib distance, per message | **Useless** | Objects sit inside gzip's header region; published minimum is ~1,000 tokens / ≈2 KB; `NCD(x,x)` leaves [0, 0.1] outside the window region |
| MAUVE | **Useless** | Needs ≥ ~5,000 samples per side; "biased towards optimism" below that; relative comparisons only |
| BERTScore (as a style metric) | **Wrong construct** | Semantic; documented as less sensitive to function-word-only differences — i.e. blind to exactly the signal you want |
| BLEU / ROUGE as style metrics | **Wrong construct** | Lexical overlap; rewards a fluent generic paraphrase that preserves meaning |
| Unmasking (Koppel & Schler) | **Useless here** | Needs 500-word chunks; Sanderson & Guenter showed it is "less useful when dealing with relatively short texts" |
| Human detection of AI text, yes/no | **Weak instrument** | 187 participants averaged **57 %** accurate (78 % on social-media comments); for narrative text, **39.39 %** in one study — significantly *worse* than chance |
| Chi-square on a *single* message's marker counts | **Useless** | Expected counts < 5; the test is not valid |

### 1.11 The circularity rule (do not skip this)

`weCloneFingerprint.ts` puts `lengthHistogram`, `markers`, `endsWithPunctuation`, `emojiRatio`,
`latinRatio`, `noPunctuationRatio` and the phrase lists **into the system prompt**. Scoring with
those same quantities measures how well the model obeyed its instructions.

**Rule: partition the feature space into two disjoint sets, and never let a feature be both
prompted and scored.**

- **Set P (prompted, evaluable only as a secondary "compliance" metric):** everything currently in
  `WeCloneFingerprint` except the phrase lists. Report compliance separately as *instruction
  adherence*, and label it as such in every report. It is genuinely useful — a clone that ignores
  its own fingerprint is a bug — but it is not evidence of fidelity.
- **Set S (scored, never prompted):** char n-gram JSD (n=4 and n=2), per-author BPC and its
  percentile, burst-size distribution, KS/Wasserstein on length in *graphemes*, the emoticon-type
  histogram specifically, MTLD, verifier AUC/EER, recovery@K, and the human identification test.
- **The check that enforces it:** run the evaluator against a "fingerprint-only" baseline arm — an
  LLM given *nothing but* the rendered fingerprint, with the persona prompt suppressed. If that arm
  scores as well as the full clone on the Set-S metrics, the full clone's score is compliance, not
  imitation. This is a 30-case, ~$0.05 experiment and it is the most informative single control in
  the design.

---

## 2. Chinese-specific measurement problems

The Chinese/English code-mixed informal register is, per the one study that measured it directly,
the **worst case** for style imitation: Wang et al., Findings of EMNLP 2025, over 40,000 generations
per model and 400+ real authors, found LLMs approximate style "in structured formats like news and
email" but "struggle with nuanced, informal writing in blogs and forums", with performance
"generally lower on Reddit and Blog, where writing tends to be more informal and stylistically
diverse" (`stream-failures` §7.1). It also means the *measurement* problems are the hard ones.

### 2.1 No word boundaries — char n-grams, and the bigram-index trap

**Do not word-segment for scoring.** Three reasons:
1. Chinese has no orthographic word boundaries; every segmenter is a *model*, so scores become
   properties of the segmenter.
2. Chat text is exactly where segmenters degrade: names, neologisms, pinyin initialisms (`yyds`,
   `xswl`), Latin words inside Chinese, and no punctuation. jieba/pkuseg split these inconsistently
   across runs and versions.
3. The published result favours the language-independent substrate: PAN 2018's headline
   methodological lesson was that "simple approaches based on character/word n-grams and well-known
   classification algorithms are much more effective in this task than more sophisticated methods
   based on deep learning and linguistic analysis"; the winner was an ensemble of three simple
   char/word n-gram approaches plus compression, and third place was compression-based
   (`stream-pan` §1.8).

**Bigram indexing — the specific trap.** A char-bigram inverted index over Chinese is dense
(`的X`, `X的`, `是X` recur everywhere). If a retrieval index or a similarity feature is built on
char bigrams, the top-scoring pairs are decided by a handful of function characters and the metric
becomes a high-frequency-character detector. **Use n = 4 as the primary** (PAN `cngdist`'s choice),
n = 2 as a *diagnostic only*, and **always report the top-20 highest-contributing grams** alongside
any divergence number, so you can see whether the difference is stylistic or just `的` frequency.

**What "token" means for the code-switching metrics.** For the Guzmán-style indices in §2.3 you
need *some* language tagging. Use a rule-based tagger, not a segmenter:

```
tag(chunk) = 'latin'  if /^[A-Za-z][A-Za-z'’]*$/
           = 'digit'  if /^[0-9]+([.,][0-9]+)?$/
           = 'han'    if /^\p{Script=Han}+$/
           = 'other'  otherwise   (emoji, kaomoji, punctuation, WeChat placeholders)
```

One tag per whitespace-separated chunk, with a contiguous Han run counted as one chunk. Freeze the
tagger.

### 2.2 Emoji and kaomoji counting — count grapheme clusters

**This is a real bug generator, and it corrupts the *length* metric too** — and length is already
used in the fingerprint (`avgLength`, `medianLength`, `LENGTH_BUCKETS`).

Measured counts for a single emoji (`EmojiFYI`, consistent with UAX #29):
`"👩‍💻"` → `.length === 5` (UTF-16 code units), `[...s].length === 3` (code points),
**1 grapheme cluster**. `"👨‍👩‍👧‍👦"` → 1. `"🏳️‍🌈"` → 1. `"👋🏽"` → 1. `"1️⃣"` → 1.

**Rule.** Use `new Intl.Segmenter(undefined, { granularity: 'grapheme' })` and
`[...seg.segment(s)].length` for every length, and for counting emoji clusters. This is a
Node built-in (ES2022, Node ≥ 16) — no dependency. UAX #29 GB11 (emoji ZWJ sequences) and GB12/GB13
(regional-indicator flag pairs) are the rules that make these single clusters; a
`\p{Extended_Pictographic}` *code-point* count over-counts both.

**Known limitations — state them in the report, do not hide them.**
- **Kaomoji are not in Unicode's emoji data.** `(╯°□°）╯︵ ┻━┻` is a sequence of ordinary characters.
  The existing `KAOMOJI_RE` catches bracketed ASCII faces and a small exotic-character class; it
  will miss much of the CJK kaomoji inventory. That is defensible **only if the regex is frozen**
  and applied identically to real and clone. Report `kaomojiCount` as "matches of regex R@version",
  never as "number of kaomoji".
- **Variation selectors.** `U+FE0F` forces emoji presentation; it is a separate code point but part
  of the same grapheme cluster. Counting it separately inflates counts.
- **Repeated emoji.** `😂😂😂` is 3 clusters; count 3 **and** record a `maxRunLength` feature,
  because how many times a person repeats an emoji is itself individuating.
- **WeChat placeholders** (`[图片] [表情] [语音] [视频] [文件] [链接] [动画表情]`) are *tokens the
  person chose to send*, so they belong in the marker inventory (they are already in the code) —
  but count them **before** any grapheme pass that would treat `[`…`]` as punctuation.

### 2.3 Measuring the Chinese–English code-switch ratio — one number is not enough

`latinRatio` (the fingerprint's "Latin letters ÷ all characters") is a **script share**. Necessary,
not sufficient: 50 % Latin could be one English sentence or one Latin word inside every Chinese
sentence, and those are different people. Use the Guzmán et al. Interspeech-2017 family — all four
are cheap, and all four are defined on a *tag sequence*:

```
M-Index    = (1 − Σ_j p_j²) / ( (k−1) · Σ_j p_j² )        k = #languages, p_j = token share
                                                           0 = monolingual, 1 = equal shares
LE         = −Σ_j p_j log₂ p_j                             language entropy, ≤ log₂ k bits
I-Index    = (1/(n−1)) · Σ_{i=1..n−1} S(l_i, l_{i+1})      S = 1 iff tags differ
                                                           ≈ P(a given token is a switch point)
Burstiness = (σ_τ − m_τ) / (σ_τ + m_τ)                     τ = language spans, ∈ [−1, 1]
SpanEntropy= −Σ_l p_l log₂ p_l                             entropy of the span-length distribution
Memory     = (1/(n_r−1)) Σ (τ_i−m₁)(τ_{i+1}−m₂)/(σ₁σ₂)     lag-1 autocorrelation of spans, ∈[−1,1]
```

**Script vs language — the pinyin-romanisation case.** If the *person* writes 中文 phonetically in
Latin letters, or if the *clone* does so where the person writes 汉字, `latinRatio` is identical and
the idiolect is entirely different. Add:
- `hanRatio` = Han graphemes ÷ all non-emoji, non-punctuation graphemes;
- `latinRunClass` = share of Latin runs classified as (a) English words, (b) pinyin initialisms
  (§2.4), (c) English abbreviations (`ok`, `btw`, `idk`), (d) transliterations (`emo`) — tagged by a
  frozen dictionary plus the rule "an all-lowercase 2–5-letter Latin chunk with no vowel, or with an
  impossible English cluster (`xswl`, `zqsg`, `dbq`), is a pinyin initialism".
- **Never normalise the script before measuring the ratio.** Transliterate-and-measure destroys the
  quantity being measured. Normalise only for the §1.1 char-n-gram metric, and use a *different*
  normalisation there (§2.5).

**Power assessment.** `M-Index`, `LE` and `latinRatio` are *shares*, so per message they are one
number with huge variance (a 6-character message with one English word is 33 % Latin). Report them
over windows of ≥ 50 messages with Wilson CIs. `I-Index` and `Burstiness` need a long tag sequence
but converge quickly — ≥ 200 tokens — so they are likewise bundle-level. `Memory` is the most
sample-hungry and least likely to be stable; mark it exploratory. **No member of this family has
published per-message validation on WeChat-like data — mark the family `UNVERIFIED as a stylometric
feature` and treat the values as within-corpus calibrated statistics.** That is how Guzmán et al.
use them: to describe and compare corpora, not to identify individuals.

### 2.4 Typos, abbreviations, and pinyin initialisms (yyds / xswl) — measure as rates, never normalise

**What `yyds`/`xswl` are.** *Internet lettered words* composed of pinyin syllable initials:
`yyds` ← 永远滴神 / 永远的神, `xswl` ← 笑死我了, `dbq` ← 对不起, `zqsg` ← 真情实感,
`u1s1` ← 有一说一. The literature is explicit that they are internet-only ("they are only used on
online social platforms… there is no need to standardize their pronunciation"), that both upper and
lower case are acceptable (`emo`/`EMO`/`Emo` are the same word), and that they propagate by
**imitation**. Two consequences:
1. **Case-insensitive matching is required** — a case-sensitive marker list under-counts by 2× or more.
2. **They are era-stamped.** `yyds` first appears on Weibo at **23:18 on 2017-11-12** and enters
   sustained growth around **2019-11-10**. Within a 6-month corpus this is mostly irrelevant; for
   §6's "is the meme era-appropriate" question it is fatal — you cannot build a historical meme
   lexicon retroactively from one 6-month window.

**The measurable quantities.** All are rates over a window, all computable with a frozen version of
`MARKERS` (which already contains `yyds`, `xswl`, `awsl`, `233`, `艹`, `草`, `卧槽`, `我靠`, `hhh`
plus a solid English list):

| Quantity | Definition |
|---|---|
| `abbrevRate` | pinyin-initialism tokens ÷ messages (matched case-insensitively, frozen list) |
| `abbrevTypeEntropy` | Shannon entropy of the abbreviation-type distribution — *which* ones, not just how many |
| `typoProxyRate` | tokens in neither (author lexicon ∪ common-English lexicon ∪ valid 汉字/拼音) ÷ tokens |
| `oovRate` | tokens absent from the author's own train-window lexicon |
| `latinLowercaseRate` | share of Latin tokens in all-lowercase form |
| `missingApostropheRate` | `dont`/`im`/`its`-as-`it's` shares (English half only) |

**Honest status: typos as a stylometric feature are `UNVERIFIED`.** No paper I have isolates a
typo/misspelling *rate* with reported accuracy on chat data. What is supported is weaker and
indirect: char n-grams are "not significantly affected by spelling errors" (i.e. typos are
*absorbed*, not measured — Stamatatos 2009, secondary citation), and char n-grams "can be used to
capture regular grammatical or orthographic errors which in some cases could represent the character
of the authors" (Koppel & Schler 2003, secondary citation). The empirical support for
idiosyncratic-feature strength comes from a different angle: Belvisi et al. 2020 found
**"idiosyncratic" features (misspellings, slang, emoji) at 98.5 %** accuracy — highest of their four
families, above char n-grams (97 %), word n-grams (94–95 %) and lexical/structural (92–96 %) — but
on **only 40 authors**. So: implement the rates, calibrate their weight **against this author's own
held-out messages**, and do not attach a paper's number to them.

**The hard rule: never normalise before measuring.** Expanding `xswl`→笑死我了, folding `，，，`→`，`,
or lowercasing before measurement deletes the signal. Run two parallel pipelines:
- **`raw`** — NFC normalise, nothing else. All *idiolect* metrics (§1.3, §1.5, §2.3, §2.4) run here.
- **`folded`** — NFC + full/half-width folding + case folding + whitespace collapsing. Only the
  §1.1 char n-gram divergence and the §2.1 bigram diagnostic run here.

Report which pipeline every number came from. A number whose pipeline is unstated is not a result.

### 2.5 How to avoid the tokeniser becoming the thing you measure

Four rules, all cheap, all testable.

1. **One frozen tokenisation spec, in one file, under test.**
   ```
   TOKENISATION_SPEC v1
     normalise:       NFC
     width folding:   off for `raw`, on for `folded`
     case:            preserve for `raw`, lowercase for `folded`
     segmentation:    Intl.Segmenter granularity='grapheme'
     n-gram unit:     grapheme clusters (never UTF-16 code units)
     emoji regex:     EMOJI_RE@v1    (frozen literal)
     kaomoji regex:   KAOMOJI_RE@v1  (frozen literal)
     language tagger: tag()@v1       (§2.1)
     marker list:     MARKERS@v1     (frozen literal, case-insensitive matching)
   ```
   Every metric function takes the spec version as an explicit argument. A golden test asserts that
   incrementing any spec version changes that metric's output — a change-detector test, so a silent
   edit cannot happen.
2. **Double-tokenisation probe.** Compute every headline metric twice under two *independent*
   tokenisations (grapheme-n4 vs code-point-n4; `raw` vs `folded`). If the metric's *ordering* of two
   configurations flips between them, the metric is measuring the tokeniser. Report ordering
   stability as a property of the metric; drop it from the gate if it is unstable.
3. **Round-trip idempotence test.** `normalise(normalise(x)) === normalise(x)` over a corpus sample
   including emoji, kaomoji, full-width, ZWJ sequences and WeChat placeholders. Non-idempotent
   normalisation means every score depends on how many times it was applied.
4. **Distinct-n and entropy are tokeniser-inflated.** Self-BLEU / distinct-n / n-gram entropy rise
   mechanically as the unit gets finer. Never compare across tokeniser versions; if you must, report
   the **ratio** to the same metric computed on real held-out messages under the same tokeniser.

---

## 3. The held-out next-message prediction benchmark — the primary evaluation

This is the strongest available design for this corpus, and the only one with (a) a fixed chance
level, (b) a measurable ceiling, and (c) a single reportable number.

### 3.1 Corpus construction and the four leaks

**The corpus is dated and complete, which is what makes this possible.** The target of each case is
the author's *actual next message*, never shown to the model in any form.

**Split by time, not at random.**
```
corpus = messages sorted by (sessionId, timestamp)
train  window = months 1–5   →  persona generation + retrieval index + ALL metric references
test   window = month 6      →  held-out cases
```
A random split leaks catastrophically: adjacent messages in a chat are near-duplicates
("哈哈", "好", "嗯"), so a random split puts the author's own paraphrase of the target on the
"training" side and converts the benchmark into a memorisation test.

**Four leaks, each with a concrete fix.**

| # | Leak | Fix |
|---|---|---|
| L1 | **The BM25 index contains the target message** (and the following turns). Retrieval then *is* lookup. | Build a **separate evaluation index** that excludes, for each case, the target message and every message at or after the target's timestamp in that session. Simplest correct implementation: build the evaluation index **from the train window only**. |
| L2 | **The persona markdown files were generated by map-reduce over the whole corpus**, so they encode the test window's statistics and phrases. | **Design A (recommended):** regenerate the persona from the train window only and evaluate against that. Then also evaluate the shipped persona on the same cases and report the **gap between them as measured leakage** — a number worth knowing on its own. **Design B (cheap, optimistic):** leave the persona alone; every absolute score is then an upper bound and must be labelled as such. |
| L3 | **Near-duplicate messages inside the train window** inflate the retrieved context's apparent richness and let the model copy a habitual line. | Dedup the evaluation index by exact match after the `folded` normalisation, keeping one exemplar per duplicate cluster (earliest). Report the dedup ratio. |
| L4 | **The interlocutor's message is in the context** and may literally contain the answer. | This is *not* leakage — the real person had the same information. Keep it, but record `prevIsReplyToUser` as a stratification variable and check the metric per stratum. |

**Also mandatory: a canary set.** Insert 20 synthetic, unique, never-sent strings into the *train*
window only (e.g. a fake product name), and assert none appears in any generation. This is the
standard exposure/canary audit (Carlini et al. 2019) and the cheapest defence against the
verbatim-replay failure the memorization literature predicts for a self-duplicated corpus
(`stream-failures` §5.1b: extractability **33 % → 65 %** as prompt context grows 50 → 450 tokens;
duplicate count drives memorization log-linearly; "deduplication will not perfectly prevent leakage").

### 3.2 Case sampling — how many, and how to choose them

**Unit of a case.**
```
{ caseId, sessionId, contactId, t, context: Message[K], target: string }
```
Conditions: (i) `target` is by the author; (ii) the message immediately before `t` is by the other
party, so this is a genuine *reply* rather than a continuation; (iii) the session has ≥ 3 prior
turns; (iv) `target` is a text message — exclude `[图片]`/`[语音]`/`[转账]`/recalls; (v) `target` is
not a pure URL or pure digits.

**Context size K.** Include both sides verbatim with real timestamps. Sweep K ∈ {3, 8, 20} on a
calibration split, then **freeze K = 8** for the benchmark: long enough for topic, short enough that
the model cannot recover the answer from the transcript. K changes the number, so it must be frozen
with the baseline.

**Stratification.** Draw proportionally to the corpus over three axes:
- **contact** — across ≥ 8 contacts, capped at 25 % of cases from any one contact (emoji rate and
  register are partner-conditioned, §1.5);
- **length band** — the six existing `LENGTH_BUCKETS` (3/8/16/30/60/∞), proportionally;
- **month** — spread across the test window so a single topic-heavy week cannot dominate.

**N.**
- **N = 30** — smoke run. Catches gross regressions, gates nothing, costs < $0.10 (§5.4).
- **N = 200** — **the frozen benchmark.** At N = 200, recovery@1 has a chance rate of 5 % and a
  Wilson 95 % CI half-width of roughly ±6 points at an observed 25 %, which is enough to separate
  "near chance" from "clearly above chance" — the decision that matters. Going to 500 changes a
  verdict only for small effects, and past that the binding constraint is case-level variance, not N.
- **Rolling-origin folds.** With 6 months, build 5 folds of "predict month k+1 from months ≤ k".
  Cheap, and it is the only defence against a benchmark that has silently tuned itself to one
  month's topics. Report per-fold numbers; the fold-to-fold spread is the honest uncertainty.

### 3.3 Scoring a case — five functions and one ranking test

**Exact match is hopeless.** The probability that an LLM emits the author's exact 8-character reply
to an open-ended chat prompt is negligible, and optimising for it pushes the clone toward the most
predictable formulaic response ("嗯嗯", "好的") — precisely the failure mode under investigation. So
score *similarity with a fixed, published, character-level metric*, and report the distribution,
never a single case.

**(a) chrF — the primary per-case string metric.** Character n-gram F-score (Popović 2015): it is
"language independent and also tokenisation independent", which is exactly right for code-mixed
Chinese without word boundaries.

```
CHRP  = mean over n ∈ N of ( matched char n-grams in hyp ÷ total char n-grams in hyp )
CHRR  = mean over n ∈ N of ( matched char n-grams in ref ÷ total char n-grams in ref )
chrFβ = (1+β²)·CHRP·CHRR / (β²·CHRP + CHRR)         β=1 → chrF ;  β=3 → chrF3 (recall-weighted)
N     = {1..6}                                       (Popović's default)
```
Implementation: `sacrebleu`'s `CHRF` for the offline reference run, plus a ~60-line TS port for the
app. **Report chrF as the headline** and chrF3 alongside — Popović found chrF3 had the highest
segment-level correlation and it is the variant that rewards *not omitting* the author's habitual
particles. **Caveat to state:** chrF was validated on MT, not on chat replies; its segment-level
correlations are good *relative to BLEU/TER*, not good in absolute terms. Treat it as a consistent
yardstick, not as a measure of "how human".

**(b) Normalised character edit distance.** `1 − lev(hyp, ref)/max(|hyp|,|ref|)` on graphemes. Cheap
and interpretable, and it is the right sanity metric precisely because the target is *short* — for a
pile of `嗯嗯` cases, edit distance and chrF agree, and any disagreement is diagnostic of length
mismatch.

**(c) BLEU-1 and ROUGE-L — compute, report, never gate.** Both are lexical-overlap metrics that
systematically reward a fluent generic paraphrase which preserves meaning; ROUGE-L additionally
rewards length, which interacts badly with the clone's tendency toward longer, well-formed replies.
Their value is as *diagnostic contrast* to chrF: a large chrF gain with no BLEU-1 gain usually means
the gain is in particles and punctuation — which is exactly what you want here. Label them
"diagnostic only" in every table.

**(d) Embedding cosine.** `cos(embed(hyp), embed(ref))`. Useful for exactly one thing: separating
"on-style but wrong content" from "right content but wrong style". Never use it as a style score —
it is a **semantic** metric, and the WMT-2021 fine-grained analysis found BERTScore "is more easily
fooled when the difference is only in function (not content) words" (`02-academic` §3.7). Since
function words and punctuation are the core of style, an embedding metric is structurally blind to
the target signal.

**(e) Per-author BPC / perplexity** (§1.8). Per case, record `BPC(hyp)` and `BPC(ref)` under the
frozen char n-gram model; the case statistic is the **paired** `ΔBPC = BPC(hyp) − BPC(ref)`. This is
the most sensitive column in the table.

**(f) The recoverability test — the headline number.**
For each case, build a candidate pool of **20 real messages by the author**: the true target plus 19
distractors from the same author's held-out messages, matched to the target's `LENGTH_BUCKETS` band
and, where possible, to a topic proxy (same contact, or an overlapping content-word set). Rank the 20
candidates by similarity to the clone's output (`cos` over the folded char-4-gram vector, or chrF),
then report the **rank of the true target**:

```
Recovery@1 = share of cases where the true target ranks 1st      chance = 1/20 = 5.0 %
Recovery@5 = share of cases where the true target ranks ≤ 5th     chance = 5/20 = 25.0 %
MRR        = mean of 1/rank                                       chance = (1/20)·Σ_{r=1..20} 1/r ≈ 0.1799
```

**Why this is the right headline.** It has a fixed chance level, so any value is immediately
interpretable; it rewards a reply that is *different but in the author's voice*, and it does not
reward verbatim copying any more than a good paraphrase — the pool is real messages, so the clone
must be *closer to the true reply than 19 other things the author actually wrote*.

**Its one weakness, and the fix.** A clone that copies a retrieved exemplar verbatim scores
maximally. Therefore Recovery@K **must** be reported alongside the verbatim-copy rate from §1.7
(longest common substring with the corpus ≥ 8 characters, or ≥ 90 % overlap). A build may not pass
the gate on Recovery@K while exceeding the copy-rate threshold in §7.

### 3.4 Producing one comparable number with a confidence interval

**Step 1 — four fixed arms, always co-reported.**

| arm | definition |
|---|---|
| `REAL` | the author's actual reply. The **ceiling**: this is the real person by construction |
| `CLONE` | the build under test |
| `BASE` | a **frozen generic-assistant** reply to the same context — no persona, no retrieval, same model, same decode parameters |
| `FP-ONLY` | optional but recommended (§1.11): only the rendered fingerprint text, no persona, no retrieval |

Every metric is computed for all arms on **the same cases**. The `BASE` arm is the content-only
control in every section above; without it none of the numbers mean anything.

**Step 2 — the per-case score.** Define the primary per-case scalar as a **normalised recovery
margin**, bounded and arm-comparable:
```
margin(case) = ( 1/rank_clone − 1/rank_base )        # paired, signed
```
Aggregate by a **paired case-level bootstrap**:
```
for b in 1..10000:
    idx = sample_with_replacement(1..N, N)           # resample CASES — never messages, never pairs
    stat[b] = mean over idx of margin
CI = [quantile(stat, 0.025), quantile(stat, 0.975)]
```
**Bootstrap over cases.** Messages within a case are dependent (same context), and in §1.9 a single
clone appears in five pairs. A message-level or pair-level bootstrap yields a confidence interval
that is too narrow — the most common way an evaluation like this reports a false improvement.

**Step 3 — the reported single number.**
```
Recovery@1(CLONE) = 21.5 %  [17.0, 26.5]   N = 200
    chance            5.0 %
    BASE arm          __ %     ← fill in; if CLONE ≈ BASE the metric measures topic
    REAL arm          __ %     ← the instrument's ceiling under this candidate pool
```
**The REAL arm's Recovery@1 is the instrument's ceiling and must be measured, not assumed.** Rank the
real target against the other 19 real candidates. If the real message does not reliably beat 19 other
real messages by the author, the pool is too homogeneous (usually: length-matched distractors from
the same contact) and the benchmark is mis-specified. **A ceiling below ~40 % means rebuild the pool
with more diverse distractors — it does not mean the clone is good.**

**Step 4 — the significance test.** For large N use the **Wilcoxon signed-rank** test on the paired
per-case margins — recommended in the NLP significance-testing guide as "applicable for most NLP
setups… due to its improved power", with that guide's own warning that it "is less effective for
small test sets". At N = 30 prefer the **paired bootstrap** or a **randomisation/permutation** test.
Report the test, the statistic and the p-value; never report a delta without one.

### 3.5 The secondary benchmark — content-matched restyling

The next-message benchmark conflates two questions: *did the clone pick the right content* and *did
it phrase things like the author*. The secondary benchmark isolates the second.

```
content = a neutral paraphrase of the real reply, produced once by a strong LLM
          ("state only the information, in the flattest possible register"),
          frozen, and reviewed for leakage
prompt  = "the conversation is <context>; say this: <content>"
score   = chrF(clone, real), ΔBPC, verifier score — for CLONE / BASE / REAL / COPY-INPUT arms
```
This is what the style-transfer literature actually evaluates, and it carries a mandatory warning:
`stream-failures` §2.4 (STRAP, EMNLP 2020) showed "a naïve baseline that randomly chooses to either
copy its input or retrieve a random sentence written in the target style **outperforms prior work**
on poorly-designed metrics", and fewer than 25 % of style-transferred sentences from two
state-of-the-art systems were even rated as paraphrases of their inputs. **So: always include the
copy-input baseline as an arm, and always co-report content preservation** (embedding cosine to
`content`), because a clone can win the style metric by discarding the content. Report the pair —
a point, not a scalar.

### 3.6 The two controls that make the numbers honest

1. **Content-only control** (`BASE` arm). If `CLONE` does not beat `BASE` on the style metrics *on
   the same content*, the metric is measuring topic.
2. **Within-author noise floor.** Build 200 "pseudo-clone" cases by substituting a **different real
   message by the author** (same contact and length band, different turn) for the clone. Compute
   every metric on those. That is the **irreducible noise level** — the score a *perfect* clone would
   not exceed. Report every clone score as a fraction of this floor. This single control is worth
   more than any additional metric, because it converts "JSD = 0.31" into
   "JSD = 0.31, versus 0.24 for the author against himself".

---

## 4. A cheap, honest human protocol

The human test is the **only** ground truth available, and the literature is unambiguous that it is
a weak instrument that must be engineered rather than trusted. Everything below is designed around
two published facts: humans detect generic AI text at roughly **57 %** (9164 annotations, 214
participants, 500 texts, 10 genres; 78 % on social-media comments) or, for narrative text, at or
below chance (**39.39 %** in one study, significantly *worse* than chance; **51.97 %** in another,
no different from chance); and inter-annotator agreement on *style* judgements is low —
**Krippendorff α = 0.299** for forced-choice authorship discrimination (Rexha et al. 2018, 56
annotators, precision near the 25 % random baseline), and for style-transfer evaluation
**κ = 0.297** (style-masked) vs **0.173** (unmasked) (Mir et al., NAACL 2019). A single-rater
protocol therefore cannot claim more than a coarse, direction-only result — but a coarse
direction-only result is exactly what the project currently lacks.

### 4.1 The trial format: blind, forced choice, three ways

Each trial shows the owner a **real context** (the messages preceding a real turn, as in §3) and two
anonymous replies in randomised order. He answers one question:

> **Which of these did I actually write?**

This is the identification test and it is the right primary: it is relative (so it needs no scale),
it is blind by construction, and it has a known chance level (0.5 for a 2-way trial, 1/3 for a
3-way trial).

Three arms, always present:

| arm | construction | purpose |
|---|---|---|
| `REAL` | the author's actual message | the correctness anchor |
| `CLONE` | the build under test | the object of measurement |
| `BASE` | a frozen generic-assistant reply to the same context | the "is it better than nothing" anchor |

**Anchoring arm (mandatory, and it is the one people omit).** Add a **`PARROT`** arm: the single
nearest corpus message retrieved by BM25 for the same context, verbatim, with no generation. `PARROT`
is the metric-gaming adversary: it should be *unrecognisable as the author's reply in context* while
scoring extremely well on every surface metric. If the owner does not rank `CLONE` above `PARROT`,
something is wrong with the clone regardless of what the automatic metrics say. This arm is the
human-protocol equivalent of the copy-input baseline required by STRAP.

**Trial design (concrete).**
- **Round A (2-way):** `CLONE` vs `REAL`, N = 30, order randomised.
- **Round B (3-way):** `REAL` / `CLONE` / `BASE`, N = 30, order randomised.
- **Round C (anchoring):** `CLONE` vs `PARROT`, N = 20.
- Total owner time: **~25 minutes** for 80 trials at ~15 s each. Run it once per release, not per commit.
- Present each trial in the app with the context rendered as the real chat, and **no metadata**
  (no timestamps that could identify the real message, no length hints).
- Force a choice. No "both" / "neither" / abstain; an abstain option destroys the chance level.

### 4.2 Randomisation and position-bias control

**Human position bias is large and must be measured, not assumed away.** The LLM-judge literature
gives the calibration: "all of them exhibit strong position bias. Most LLM judges favor the first
position… Only GPT-4 outputs consistent results in more than 60 % of cases", and the recommended
mitigation is a **both-orderings protocol** with a **position-flip rate gate at ~10 %**
(`03-practitioner` §5.4). Apply the human version:

1. **Counterbalance exactly.** Each of the N cases is presented in each order across N/2 cases, so
   the position assignment is exactly balanced and independent of the arm.
2. **Report the position-flip rate.** For the subset presented both ways, the share of cases where the
   owner's answer changes with order. Gate: if the flip rate exceeds **~20 %**, the trials are too
   noisy to decide anything; increase N or simplify the trial.
3. **Report the first-position choice rate.** Under the null it is 50 %. If the owner picks the first
   option 70 % of the time, his ACCURACY is uninterpretable and only the flip-corrected estimate
   (average of the two orderings, where disagreements count 0.5) is reportable.

### 4.3 The single-rater problem

**Say it plainly in the report:** with one rater, inter-rater agreement is *undefined* — there is
nothing to agree with. What you have is a Bernoulli sequence and a binomial CI. Three specific biases
the owner-rater brings, each with a concrete mitigation:

| bias | why it applies here | mitigation |
|---|---|---|
| **Familiarity / self-recognition bias** | He will rate a habitual phrase highly *because he uses it*, even when it is the wrong reply in that context. This favours `PARROT` and pushes the clone toward formulaic output. | The `PARROT` arm measures exactly this; report the CLONE−PARROT margin, not CLONE's absolute score |
| **Demand characteristics** | He built the feature and wants it to work. | Pre-register the decision rule and the N **before** seeing results; blind 4-character arm codes; a practice set that is discarded |
| **Hindsight leakage** | He has the real message available (he must, to know the answer), so he can rationalise either choice. | Show the *context only*; the real message is what he is choosing, not something he compares against |

**If a second informed rater exists** (a friend who knows his typing style well), run Round A with
both and report **Krippendorff's α** between them. Expect **α ≈ 0.2–0.4** based on the published
style-judgement values above; treat α < 0.2 as "the instrument cannot support a claim" rather than
as a failure of the raters.

### 4.4 The binomial maths for interpreting N judgements

Exact computations, reproduced from `_scratch/binom-power.mjs` (no dependencies; re-run it to verify).

**(a) Two-way forced choice, chance p₀ = 0.5, one-sided α = 0.05.**

| N trials | minimum correct to reject chance | required accuracy | actual α |
|---|---|---|---|
| 10 | 9 | 90.0 % | 0.0107 |
| 15 | 12 | 80.0 % | 0.0176 |
| 20 | 15 | 75.0 % | 0.0207 |
| 25 | 18 | 72.0 % | 0.0216 |
| 30 | 20 | 66.7 % | 0.0494 |
| 40 | 26 | 65.0 % | 0.0403 |
| 50 | 32 | 64.0 % | 0.0325 |
| 60 | 37 | 61.7 % | 0.0462 |

**(b) Power to detect a true accuracy p (one-sided 0.05).**

| N | crit | p=.60 | p=.65 | p=.70 | p=.75 | p=.80 | p=.90 |
|---|---|---|---|---|---|---|---|
| 20 | 15 | .126 | .245 | .416 | .617 | .804 | .989 |
| 30 | 20 | .291 | .508 | .730 | .894 | .974 | 1.000 |
| 40 | 26 | .317 | .572 | .807 | .946 | .992 | 1.000 |
| 50 | 32 | .336 | .622 | .859 | .971 | .997 | 1.000 |
| 60 | 37 | .451 | .753 | .937 | .993 | 1.000 | 1.000 |

**(c) Minimum N for a given power.**

| true accuracy | 80 % power | 90 % power |
|---|---|---|
| 0.60 | **158** trials (≥ 90 correct) | 213 trials (≥ 119) |
| 0.65 | **69** trials (≥ 42 correct) | 93 (≥ 55) |
| 0.70 | **37** trials (≥ 24 correct) | 53 (≥ 33) |
| 0.75 | **23** trials (≥ 16 correct) | 33 (≥ 22) |
| 0.80 | **18** trials (≥ 13 correct) | 23 (≥ 16) |

**The single most important consequence of table (c): a 30-trial protocol cannot detect a modest
effect.** If the clone is genuinely recognisable-but-good — say the owner can pick the real message
65 % of the time — **30 trials gives only 51 % power**: you will fail to see the improvement half
the time. To detect a 65 % effect reliably you need **69 trials**. To detect a 60 % effect you need
**158**. Practically: **use 30 trials only to detect large effects (≥75 %, and even then it is
underpowered at 89 %), and either accept that modest effects are undetectable or budget 3× the
trials.** This is a design constraint, not a footnote.

**(d) Three-way trial** (`REAL` / `CLONE` / `BASE`), chance p₀ = 1/3, one-sided α = 0.05:

| N | minimum correct | actual α | power at true 0.65 |
|---|---|---|---|
| 15 | 9 (60.0 %) | .0308 | .755 |
| 18 | 10 (55.6 %) | .0433 | .861 |
| 24 | 13 (54.2 %) | .0284 | .906 |
| 30 | 15 (50.0 %) | .0435 | .970 |

**Note the trap:** a three-way trial needs a *lower* observed accuracy than a two-way trial to reach
significance, but the chance level is also lower — so a 50 % three-way score sounds like "chance"
and is in fact significant. Always state p₀ explicitly next to the accuracy.

**(e) Wilson 95 % CIs for reporting an observed accuracy.**

| observed | 95 % Wilson CI |
|---|---|
| 15/30 = 50.0 % | [33.2, 66.8] % |
| 18/30 = 60.0 % | [42.3, 75.4] % |
| 20/30 = 66.7 % | [48.8, 80.8] % |
| 24/30 = 80.0 % | [62.7, 90.5] % |
| 36/60 = 60.0 % | [47.4, 71.4] % |
| 48/60 = 80.0 % | [68.2, 88.2] % |

**(f) A/B between two *configurations*** (CLONE-A vs CLONE-B), which is the regression question.
Use only the **discordant** trials (cases where the owner's choice differs between A and B) and a
sign test / McNemar on them:

| discordant trials m | need ≥ this many one way for one-sided p < 0.05 |
|---|---|
| 5 | 5 |
| 8 | 7 |
| 10 | 9 |
| 12 | 10 |
| 15 | 12 |
| 20 | 15 |
| 30 | 20 |

With 30 cases you will typically get **8–15 discordant** trials, so a config-to-config decision needs
**7 of 8, or 12 of 15** — i.e. near-unanimity. **Conclusion: the human protocol cannot resolve
config-vs-config differences at N = 30.** Use it for the ship/don't-ship decision and for
qualitative critique; use §3's automatic benchmark for regression.

### 4.5 What "the owner is the rater" buys and costs — the honest summary

- **Buys:** privileged knowledge of the *relationship* and the *context*; the ability to say *why*
  something is wrong, which no metric supplies; and a zero-marginal-cost rater who is always
  available.
- **Costs:** n = 1 (no inter-rater agreement is possible), a strong prior toward "it's not me"
  (which is the complaint that started this work — an unblinded protocol will confirm it), and a
  documented human ceiling near chance on short texts (the Weibo per-post human ceiling was
  **55.5–64.0 %**, with the machine at 64.5 % on the same items).
- **Therefore:** report the owner's result as *"N trials, k correct, p₀ = 0.5, one-sided p = …, Wilson
  95 % CI …"* — never as "the owner can tell". And never as "my friends couldn't tell", which the
  literature shows is worthless evidence.

---

## 5. Regression discipline

The goal: **any code change produces a number that is comparable to the previous number**, on a paid
API, for under a few dollars.

### 5.1 Frozen artefacts

```
docs/research/weclone/_eval/
  corpus-snapshot.json      # normalised (raw pipeline) self-messages: {id, ts, session, contact, text}
  corpus-snapshot.sha256    # over the canonical JSON serialisation
  cases-N200.json            # the frozen case list: id, session, contact, ts, context[], target
  cases-N200.seed.txt        # the exact RNG seed + sampling code version
  distractors-N200.json      # the frozen 20-candidate pools for Recovery@K
  metrics-baseline.json      # golden per-case metrics for the frozen baseline build
  metrics-baseline.tol.json  # per-metric absolute tolerances
  arms/                      # cached arm generations (see 5.5 — never regenerate what you can cache)
  results/<buildid>.json     # one file per evaluated build, immutably versioned
```

**Every result file must record, as a header:** git commit, app version, model id string,
temperature/top-p/max-tokens, the TOKENISATION_SPEC version, the cases file hash, the tokeniser
version of the per-author LM, the arm list, the sampling seed, the run date, and the **cache-hit rate
reported by the API**. A result without a complete header is not a result.

**Golden-output tolerances.** For deterministic metrics (char n-gram JSD, BPC, χ², KS, MTLD) the
golden test asserts **bit-exact equality** on the frozen corpus — these functions have no randomness
and exact equality is achievable. For anything that touches generation, assert only **rank stability**
(the arm ordering must not change) and a tolerance band derived from the measured noise floor (§5.5).

### 5.2 Determinism: what you can and cannot seed

| source of randomness | controllable? | how to handle |
|---|---|---|
| case sampling | yes | frozen seed + frozen case file; the file is the contract, the seed is only how it was made |
| distractor sampling for Recovery@K | yes | frozen file |
| bootstrap / permutation | yes | frozen seed; 10,000 resamples |
| metric code | yes (pure functions) | golden bit-exact tests |
| **LLM generation** | **no** | `temperature`, `top_p`, and a `seed` parameter are *requests*, not guarantees. Re-sample 3×, report the run-to-run SD, and treat the mean as the estimate |
| **provider-side batching** | **no** | see below |

**`temperature = 0` does not mean reproducible.** A documented, instrumented case on a DeepSeek-V4-Flash
serving stack: with `temperature=0` and `seed=42`, the same prompt returned different completions at a
rate that grows with concurrency — 0.5 % at concurrency 32, and **2.36 % with speculative decoding
disabled**. The mechanism is measured, not inferred: the *same query row* produced attention output
differing by **1–2 ULP of bf16** depending only on how many other rows shared the batch, which flips
the argmax at tokens whose top-2 logit margin is already near zero (the margin collapsing from ~18
logprobs to 0.1–2.0). The kernel was bit-exact on identical-shape re-runs (50/50) — it is
**deterministic but not batch-invariant**. (`vllm-project/vllm` issues #53257 and #53436.)

**Two honest caveats.** (i) Those reports are about a self-hosted vLLM deployment, **not** about
DeepSeek's hosted API — the hosted API's determinism is `UNVERIFIED`. (ii) But the *category* of
mechanism is generic to MoE/batched serving, so the correct engineering response is to **measure it
rather than assume it**: run one fixed prompt 10× at the production parameters and record the number
of distinct outputs. Put that count in the results header. If it is > 1, no tolerance may be tighter
than the observed spread.

### 5.3 Provider model drift

Model ids are aliases, and aliases move. Three cheap defences:

1. **Pin and record.** Pin the exact model id string; record it in every result header; fail the
   comparison (do not silently compare) when the id differs between two runs.
2. **A drift canary run.** Each release, re-run **20 frozen cases with frozen parameters** and
   compare the new probe output against the previous probe output with two cheap statistics:
   self-`chrF` between the two probe runs, and `ΔBPC`. Compare that drift against the **baseline's own
   repeat-run drift** (5 repeats, same build). If probe drift > 3 × the repeat-run drift, the provider
   changed something; the release is blocked until the baseline is re-measured on the new model.
3. **Record the pricing snapshot.** The app already fetches live prices from `models.dev`
   (`modelRegistry.ts`, 24 h TTL, ETag). Store the resolved price alongside the result so cost
   regressions are visible too, and so a historical result's cost remains interpretable.

### 5.4 Cost model — concrete, for the current stack

**Token conversion, from DeepSeek's own guidance: 1 English character ≈ 0.3 token; 1 Chinese
character ≈ 0.6 token** ("每一次实际处理 token 数量以模型返回为准" — always prefer the API's reported
`usage` over the estimate).

**Assumed call shape (state these assumptions in the results header):**
```
system prompt (persona + fingerprint + 5 markdown files) ≈ 25,000 chars ≈ 12,500 tokens
   (range 7,500 if all-Latin at 0.3 tok/char, 15,000 if all-Chinese at 0.6 tok/char)
retrieved BM25 context + chat history                       ≈  1,500 tokens
per-call input                                              ≈ 14,000 tokens
per-call output (a ~30-char Chinese reply + framing)        ≈     50 tokens
```

**Prices** (`models.dev`, the same registry the app uses; corroborated by DeepSeek's pricing page,
where peak rates are ≈ 2× off-peak):

| model | input /1M | output /1M | cache read /1M |
|---|---|---|---|
| `deepseek-v4-flash` | $0.15 | $0.60 | $0.003 |
| `deepseek-v4-pro` | $0.435 | $0.87 | $0.003625 |

**Per-run costs:**

| run | calls | input tokens | flash, no cache | flash, 90 % cache hit | pro, no cache |
|---|---|---|---|---|---|
| smoke (30 cases × 1 arm) | 30 | 0.42 M | **$0.06** | **$0.01** | $0.19 |
| benchmark (200 × 4 arms × 1 sample) | 800 | 11.2 M | $1.68 | $0.19 | $4.87 |
| full (200 × 4 arms × 3 samples) | 2,400 | 33.6 M | **$5.04** | **$0.55** | **$14.61** |
| weekly regression (200 × CLONE+BASE × 3) | 1,200 | 16.8 M | $2.52 | $0.28 | $7.31 |

Output cost is negligible (120k tokens max = $0.07). **The whole corpus-side evaluation — per-author
n-gram LM, char n-gram divergence, BPC, χ², KS, MTLD — is local and free.**

**Budget conclusion: evaluation is not cost-constrained.** At flash pricing a full 4-arm benchmark
costs ~$5 worst-case and ~$0.55 with a warm prefix cache; a monthly full run plus weekly regressions
is well under **$20/month**. Prefer `deepseek-v4-flash` for the *benchmark's* generation when the
shipped product uses flash; if the product ships on `pro`, the benchmark must use `pro` (the metric
measures the product).

**A cache-effect warning that invalidates latency comparisons.** The prefix-cache price is **50×
cheaper than a miss** ($0.003 vs $0.15 per 1M), and the ~12,500-token system prompt is the ideal
cache target. Therefore: (i) always report the measured cache-hit rate with the cost; (ii) **never
report latency as a metric** unless cache state is controlled, because a cold run and a warm run
differ by far more than any eval-relevant effect; (iii) since caching is an optimisation, a cache-hit
run and a cache-miss run *should* produce identical text — if they do not, that is a provider bug
worth recording. And for cost, run each arm's cases consecutively so the per-arm system prompt stays
warm (this is irrelevant to the human protocol's counterbalancing, which applies to §4 only).

### 5.5 The comparison protocol

```
1. Regenerate NOTHING that is already cached in arms/. Key the cache by
   (arm, caseId, modelId, temperature, topP, maxTokens, promptHash, TOKENISATION_SPEC).
2. Evaluate new build → results/<buildid>.json, containing per-case metrics for every arm.
3. Paired comparison against metrics-baseline.json:
     for each metric m and each case c:  d_c = m_new(c) − m_base(c)
     CI(d) = case-level paired bootstrap, 10,000 resamples, frozen seed
4. Noise floor: the baseline's own 5 repeat runs give SD_run per metric.
     Declare a change ONLY if |mean(d)| > 2·SD_run AND the CI excludes 0.
5. Hard gates (never averaged): copy rate, canary leak, Recovery@1 vs chance.
6. Write a one-page report: the arm table, the deltas with CIs, the gates, the header.
```

**Two rules that prevent self-deception.**
- **Never change two things at once.** One prompt change, one retrieval change, or one decode change
  per measurement. The paired design removes variance but it does not attribute it.
- **Never tune on the frozen 200.** Sweep parameters on a disjoint 100-case "dev" split drawn from
  the train window's last month. The frozen 200 is touched once per candidate that survives the dev
  split. Every touch of the frozen set must be logged (a counter in `metrics-baseline.json`), because
  a benchmark touched 40 times is a training set.

---

## 6. What CANNOT be measured this way — and the protocol to use instead

### 6.1 The list, with the reason each one resists measurement

| property | why no metric in §1–§3 can see it |
|---|---|
| **Sarcasm / irony** | It is a relation between the utterance, the speaker's actual stance, and the common ground. No surface statistic distinguishes `真棒` said sincerely from `真棒` said flatly. The IMPersona study names the neighbouring failure explicitly: models imitate surface markers but "**it has a hard time replicating the affective stance**" |
| **Humour timing / affect** | Related but worse: the tell they measured was not missing humour but **excess** — "a common failure across all prompting-based models was their **excessive enthusiasm**, which made them easily identifiable as AI" |
| **In-group references** | Requires knowing a private shared history with one specific contact; the clone has retrieval, not memory of a relationship. Retrieval can surface the *words* but cannot tell whether this particular in-joke is still live or is now awkward |
| **Era-appropriateness of a meme** | Needs a dated meme lexicon, which you cannot build retroactively from a single 6-month window (§2.4: `yyds` first appears 2017-11-12 and grows from 2019-11-10, i.e. outside this corpus's baseline period). You can measure *whether the person used it in this window*; you cannot measure *whether it was appropriate* |
| **Message timing** | Turn duration, characters/second and words/second are published, usable features for instant messaging (Segalin et al. 2012) — but Weport's clone is request-driven and emits one message on demand, so **the entire timing dimension is structurally absent from the product** and therefore unmeasurable. This is also why burst-size (§1.4) is worth so much: it is the one temporal feature that survives the request-driven design |
| **"Feel"** | No construct validity, no reference frame. Anything that maps it to a number is a proxy for something already in §1 |
| **False memory / confabulation** | Named as a *documented gap*: no benchmark exists for private-individual autobiographical-memory hallucination. CharacterEval, RoleEval, TimeChara and SGR all target **public figures or fictional characters** (`stream-failures` §9, item 4). The failure is real and named — cross-universe hallucination, where the model "mistakenly acknowledges" a relationship or event that never existed — and the persona-clone analogue is the model cheerfully "remembering" a shared event that did not happen. **You must build this yourself** |

### 6.2 The qualitative protocol (Q1–Q5)

These produce *critique*, not scores. Run them per release, and keep the raw text — the value is in
the recurring categories, not in a number.

**Q1 — Point-in-time false-memory probes (the highest-value qualitative test).** Construct 20 probes
with known ground truth from the corpus:
- 10 **true** events/entities taken from the corpus (`"上个月我们不是去了<place>吗"`),
- 10 **plausible-but-false** events: entities that never appear anywhere in the corpus but fit the
  person's world (a city they never mention, a project that never existed).
Ask the clone in-character, in a real conversation shell. Score two rates:
`falseAffirmationRate` (must be ≈ 0) and `trueConfirmationRate` (should be high).
Then **flip the question**: ask whether a *false* event happened in a way that invites agreement, and
check for sycophantic confirmation — the sycophancy literature found "the PM prefers the sycophantic
response almost half the time (45 %)" and that sycophantic responses were preferred over truthful ones
**95 % of the time**, so an agreeable clone will fail this probe by construction.

**Q2 — The owner's free-text complaint log, with a fixed rubric.** Six fixed prompts, answered after
each release, on the same 20 real contexts:
1. What did the clone get wrong here? 2. What would you have said? 3. Is the *length* right?
4. Is the *emotional stance* right? 5. Did it invent anything? 6. Would this have been weird to receive?
Count answers into a **frozen category list** (too formal / too enthusiastic / wrong length / invented
a fact / wrong register for this contact / copied a phrase / other). The category *counts* are
comparable across releases even though the answers are free text.

**Q3 — Transcript-level A/B, following ACUTE-Eval.** Show the owner **two whole conversations**, each
with only one speaker highlighted, and ask a **single** pairwise question about a **named** quality
("which of these two speaks more like you?"). ACUTE-Eval's motivation is the failure of the
alternatives: single-turn pairwise ignores the multi-turn aspect, Likert has per-annotator bias and
variance and "often yields comparisons that are not statistically significant", and anchoring makes
Likert scores "generally not comparable". Use 10 transcript pairs, ~10 minutes.

**Q4 — Third-party critique, never a score.** Show a friend who knows the owner 10 real and 10
generated replies in random order and ask only *"what's off about these?"*. Record the critiques;
**do not** compute a detection accuracy from this. The reason: humans detect AI text at ~57 %, at or
below chance for narrative, and self-reported cues ("monotony, lack of cohesion") had "very limited
effects on accuracy" with a learning effect of "practically negligible (0.1–0.2 %)". A friend's
verdict is evidence about the friend, not about the clone.

**Q5 — The stance tally.** For each of 20 generated replies the owner marks the stance as
`matches` / `too warm` / `too flat` / `wrong` (agreement, enthusiasm, reluctance, disinterest). This
is countable, cheap, targeted at the one documented failure (excessive enthusiasm / unreplicated
affective stance), and it is the closest thing to a measurement of the "feel" dimension. Report it as
a 4-way tally, never as a single number.

**What to do with all five:** keep them as a **release-notes appendix**, quoted, with the tally
counts. Their job is to tell you *what to fix next*, which no metric in this document can do.

---

## 7. A single "style fidelity score" — recommendation

### 7.1 The argument against a naive composite

A distance has no scale. "JSD = 0.31", "chrF = 0.41", "BPC = 6.2" are numbers without verdicts, and
averaging un-normalised distances produces a composite whose meaning changes every time you add,
remove, or rescale a component. Worse, the style-transfer literature has a documented failure mode
here: a **copy-or-retrieve baseline beat state-of-the-art systems** on poorly designed composite
metrics "despite not doing any style transfer at all" (STRAP, EMNLP 2020; see also §3.5). A composite
built from surface distances will reward the `PARROT` arm.

**Therefore: build the composite only out of components that have each been normalised against a
measured reference — a chance level, a ceiling, or the author's own against-himself distance — and
always print the components next to the composite.**

### 7.2 The recommended score: SFS (0–100)

Four components, each bounded in [0, 1], each with an explicit reference:

| component | definition | normaliser |
|---|---|---|
| `C1` recovery | `(Recovery@1_CLONE − 0.05) / (Recovery@1_REAL − 0.05)`, clipped to [0,1] | chance 0.05; ceiling = the REAL arm (§3.4) |
| `C2` predictability | `1 − |pct_clone − 50| / 50`, where `pct_clone` = the clone's percentile in the distribution of per-message BPC over real held-out messages | the author's own BPC distribution (§1.8). Symmetric: too predictable *and* too surprising both lose points |
| `C3` verifiability | `2 · (AUC − 0.5)`, clipped to [0,1] | chance AUC 0.5; 1.0 = perfect separation (§1.9) |
| `C4` surface match | `1 − min(1, mean_k( d_k / floor_k ))` over the §1 Set-S distance metrics | **`floor_k` = the within-author noise floor** for metric k, measured by swapping in a different real message by the author (§3.6) |

```
SFS = 100 × ( w1·C1 + w2·C2 + w3·C3 + w4·C4 )
w = (0.35, 0.25, 0.20, 0.20)      # PROPOSED DEFAULT — see the warning below
```

**Warning, stated as plainly as I can:** the weights `(0.35, 0.25, 0.20, 0.20)` are a **proposed
starting point, not a result**. They are chosen so that the component most directly tied to the
owner's question (recoverability) carries the most weight, and they must be **calibrated on the first
two runs** by checking that the four arms land where they should:
```
BASE (generic assistant)      should land  ≈ 15–25
PARROT (verbatim retrieval)   should land  ≈ 30–45   (high C4, poor C1)
baseline CLONE                the reference point — SFS ≡ its measured value
REAL (the ceiling arm)        should land  ≈ 90–100  by construction
```
**If `BASE` lands above 50, the reference frame is wrong — fix the metric, not the threshold.**

### 7.3 Hard gates that the composite may not average away

A high SFS built on regurgitation is worthless. Four gates, all boolean:

- **G1 — copy rate.** Verbatim/near-verbatim messages (longest common substring with the corpus ≥ 8
  characters, or ≥ 90 % character overlap) must be **≤ 2 %** of generated messages (§1.7).
- **G2 — canary leak.** Zero canary strings from §3.1 may appear in any generation.
- **G3 — above chance.** `Recovery@1 > 0.05` at one-sided p < 0.05 on N ≥ 200 (§3.4 step 4).
- **G4 — no component more than 2 × its floor.** Prevents one metric from being sacrificed entirely.

### 7.4 "Shipped" and "regressed"

**Shipped.** A build ships when **all four gates pass** and:
```
SFS ≥ 55          → ship
40 ≤ SFS < 55     → ship only if ΔSFS vs the current baseline ≥ 0 (no regression)
SFS < 40          → do not ship
```
Again: these thresholds are **proposed defaults to be set once the first baseline is measured**, and
the reference-frame check in §7.2 is what makes them meaningful. Do not tune the thresholds to make a
build pass; tune the build.

**Regression detection (the operational rule).**
```
ΔSFS = SFS_new − SFS_old        (same frozen cases, same arms, same params)
CI    = case-level paired bootstrap over the per-case SFS contributions, 10,000 resamples
SD_run = sd of SFS across 5 repeat runs of the SAME build (the non-determinism floor)

REGRESSION  ⟺  (any hard gate newly fails)  OR  ( ΔSFS < 0  AND  CI upper bound < 0
                                                 AND  |ΔSFS| > 2·SD_run )
NO DETECTABLE CHANGE  otherwise — and say exactly that, do not round it to "no regression"
```
The `2·SD_run` term is not decoration. With LLM generation, a 3-sample mean and a 200-case set, a
1–2 point SFS move is inside the noise; declaring a regression on it trains the team to ignore the
number, which is worse than not having it.

### 7.5 If only one number can ever be reported

Then report **`Recovery@1(CLONE)` with its Wilson/paired-bootstrap CI, next to the chance level (5 %)
and the `BASE` and `REAL` arms' values.** That is a single number; it has a fixed chance level; its
ceiling is measured rather than assumed; it cannot be won by verbatim copying (the pool is real
human messages); and it is directly comparable across builds and across months. It is strictly
better than a badly-normalised composite — and if the project only ever implements one thing from
this document, it should be this.

---

## Sources

**Internal evidence streams (read in full for this document).**
- `docs/research/weclone/_scratch/stream-pan.md` — PAN shared tasks 2011–2018, short-text attribution, function words, unmasking.
- `docs/research/weclone/_scratch/stream-metrics.md` — Burrows/Cosine Delta, JSD/KL, lexical diversity, length/punctuation/emoji, NCD.
- `docs/research/weclone/_scratch/stream-failures.md` — mode collapse, persona drift, memorization, catchphrase overfitting, and the documented negative results.
- `docs/research/weclone/02-academic.md` §3 — metric formulas and survivability at message length.
- `docs/research/weclone/03-practitioner.md` §5 — verification harnesses, human-eval baselines, LLM-as-judge biases.
- `docs/research/weclone/_scratch/binom-power.mjs` — the exact binomial/power/Wilson/McNemar computations in §4.4 (written for this document; re-run to verify).

**Primary sources retrieved or opened directly in this session.**
1. Popović, M. (2015). *chrF: character n-gram F-score for automatic MT evaluation.* WMT 2015. https://doi.org/10.18653/v1/w15-3049 · https://statmt.org/wmt15/pdf/WMT49.pdf — formula (1), `n=1..6` default, system-level correlations (WMT14 r: chrF 0.805, chrF3 0.857, BLEU 0.845, TER 0.814, METEOR 0.822), chrF3 beating all standard metrics on 70–80 % of texts.
2. Guzmán, G., Ricard, J., Serigos, J., Bullock, B. E., Toribio, A. J. (2017). *Metrics for Modeling Code-Switching Across Corpora.* Interspeech 2017, 67–71. https://doi.org/10.21437/Interspeech.2017-1429 · https://www.isca-archive.org/interspeech_2017/guzman17_interspeech.pdf — M-Index (Eq. 2), Language Entropy (Eq. 3), I-Index (Eq. 5), Burstiness (Eq. 6), Span Entropy (Eq. 7, 8), Memory (Eq. 9); Table 1 corpora values.
3. Bevendorff, J., et al. (2024). *Overview of the "Voight-Kampff" Generative AI Authorship Verification Task at PAN and ELOQUENT 2024.* https://downloads.webis.de/publications/papers/bevendoff_2024d.pdf — task framing ("pick out the human"), the five metrics (ROC-AUC, Brier complement, c@1, F1, F0.5u) and the macro-average, 43 systems on 70 variants including short-text and language-switching regimes; leaderboard values quoted in §1.9.
4. PAN at CLEF 2023 — Authorship Verification task page. https://pan.webis.de/clef23/pan23-web/author-identification.html — cross-discourse-type AV, the TF-IDF char-4-gram and PPM-compression baselines, metric definitions.
5. PAN at CLEF 2025 — Voight-Kampff Generative AI Detection task page. https://pan.webis.de/clef25/pan25-web/generated-content-analysis.html — subtask leaderboards and the PPMd-CBC / TF-IDF-SVM / Binoculars baseline values quoted in §1.9.
6. DeepSeek. *Models & Pricing.* https://api-docs.deepseek.com/quick_start/pricing — per-1M-token prices, cache-hit vs cache-miss, off-peak vs peak.
7. DeepSeek token-usage guide (documentation mirror). https://deepseek.apifox.cn/token-用量计算-5903702m0 — "1 个英文字符 ≈ 0.3 个 token；1 个中文字符 ≈ 0.6 个 token".
8. `models.dev` API (`https://models.dev/api.json`) — queried live for this document; `deepseek-v4-flash` input $0.15 / output $0.60 / cache-read $0.003 per 1M; `deepseek-v4-pro` $0.435 / $0.87 / $0.003625. This is the same registry `modelRegistry.ts` consumes.
9. Unicode Consortium. *UAX #29: Unicode Text Segmentation*, §3.1 — grapheme cluster boundary rules GB11 (emoji ZWJ sequences), GB12/GB13 (regional-indicator flags). https://www.unicode.org/reports/tr29/
10. EmojiFYI. *Emoji String Length Gotchas: Surrogate Pairs, Grapheme Clusters, and Byte Counts.* https://emojifyi.com/stories/emoji-string-length-gotchas/ — the `"👩‍💻"` / `.length === 5` / `[...s].length === 3` / 1-grapheme worked example; `Intl.Segmenter` recipe.
11. Luo, C. (2023). *An Analysis of Lettered Words in Chinese Internet Language: A Case Study of "Emo" and "Yyds".* https://doi.org/10.17265/1539-8080/2023.04.006 — `yyds` ← 永远滴神, `xswl` ← 笑死我了, `dbq`, `zqsg`, `u1s1`; internet-only usage; case-insensitivity.
12. (2022). *How to go from popular to dissipating? — the process and mechanism of the Chinese internet buzzword "YYDS".* https://doi.org/10.56028/aehssr.2.1.485 — first Weibo post containing "YYDS" at 23:18 on 2017-11-12; growth inflection 2019-11-10.
13. `vllm-project/vllm` issue #53257 — *[Bug] DeepSeek-V4-Flash: non-deterministic output at temperature=0, rate scales with concurrency.* https://github.com/vllm-project/vllm/issues/53257 — 0.5 % at concurrency 32, 2.36 % with no speculative config, identical-shape re-runs 50/50 bit-exact, solo-vs-in-batch mismatch 11/50 at 1–2 ULP bf16, top-2 logit margin collapsing from ~18 to 0.1–2.0.
14. `vllm-project/vllm` issue #53436 — *Run-to-run performance non-determinism with speculative decoding at temperature=0 (fixed seed) on DeepSeek-V4-Flash / Blackwell SM120.* https://github.com/vllm-project/vllm/issues/53436 — target-model forward not bit-reproducible; acceptance rate CV 14.2 %; `VLLM_BATCH_INVARIANT` unavailable on that configuration.

**Sources cited from the internal evidence streams** (opened by the earlier stream authors, quoted here
with their stream and section; I did not re-open them in this session). Full bibliographic details,
URLs and reading-status flags are in those files:
Burrows 2002 (`stream-metrics` §1.1); Smith & Aldridge 2011 (§1.2); Evert et al. 2015 (§1.2, §2);
`stylo` defaults (§1.3); Sapkota et al. 2015 (§1.4); Baayen et al. 2002 (§2); Lin 1991 / Darmon et al.
2021 (§3); Tweedie & Baayen 1998 (§4.4); Covington & McFall 2010 and McCarthy & Jarvis 2010 (§4.2–4.3);
Yule 1939 (§5.1); Marko 2020 and Frontiers-in-Communication 2022 (§5.3); Segalin et al. 2012 (§5.3);
IPM 2008 chat mining (§5.3); Cilibrasi & Vitányi 2005, Keogh et al. 2004, Cerra et al. 2014, Halvani et
al. 2017, Alfonseca et al. 2005 (§6); MAUVE / Pillutla et al. 2021 (`02-academic` §3.7); Huang et al.
ALMs (`02-academic` §3.6); arXiv:2509.24930 (perplexity 29.5 vs 15.2) (`stream-failures` §7.4);
Wang et al. 2025 (`stream-failures` §7.1); STRAP / Krishna et al. 2020 (§2.4); Mir et al. 2019 (κ
0.297 / 0.173) (`02-academic` §3.9, `03-practitioner` §5.3); Rexha et al. 2018 (Krippendorff α
0.299) (`02-academic` §3.9); TURING LREC 2026 (57 %) and Borot/not narrative results
("Bot or not", Cambridge) (`03-practitioner` §5.3); MT-Bench / Zheng et al. 2023 position bias (`03-practitioner` §5.4);
ACUTE-Eval (`03-practitioner` §5.3); Carlini et al. 2019 (canary/exposure) and Carlini et al. 2022
(33 %→65 % as context grows) (`stream-failures` §5.1); Sharma et al. 2023 (sycophancy 95 %/45 %)
(`stream-failures` §3.1); IMPersona / Shi et al. 2025 (excessive enthusiasm, affective stance)
(`stream-failures` §3.5); Koppel & Schler 2004, Koppel, Schler & Argamon 2009, Koppel & Winter 2014,
Koppel et al. 2007, Sanderson & Guenter 2006, Eder 2015, Luyckx & Daelemans 2011, Layton et al. 2010,
Schwartz et al. 2013, Shrestha et al. 2017, Belvisi et al. 2020, arXiv:2008.01533, Segalin et al.
2012, Sharma et al. 2018, URTC 2016 (Chinese Twitter), RANLP 2017 (Weibo human ceiling), PAN 2011–2018
overviews (`stream-pan`, passim).
