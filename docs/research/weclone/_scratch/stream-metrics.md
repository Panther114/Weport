# Metrics for Measuring Style Fidelity to One Specific Author

**Scope.** A survey of concrete, implementable metrics for measuring how closely a generated text
matches **one specific author's** style. Target application: a local-first desktop app that clones a
single person's WeChat writing style from ~104,000 of that person's own messages. The data is
Chinese/English code-mixed, informal, and messages are typically **2–3 sentences or shorter**
(empirically comparable to the one published chat corpus that reports it: **6.2 words per message
on average**, from the Heaven BBS corpus — DOI [10.1016/j.ipm.2007.12.009](https://doi.org/10.1016/j.ipm.2007.12.009)).

**Length regime in tokens.** A 2–3 sentence Chinese/English chat message is roughly **10–60 tokens**
and **20–120 characters**. Every "does this work at chat length?" judgement below is calibrated
against that range.

**Verification discipline.** Every claim is either (i) taken from a source I actually opened, with a
URL, or (ii) explicitly marked `UNVERIFIED`. Where a number came from a secondary citation inside a
paper I opened (rather than from the primary paper itself), it is marked `(secondary citation)`.
Where a paywalled abstract was readable but the body was not, exact numbers are marked
`UNVERIFIED — abstract only`.

---

## 0. Summary table — suitability at 2–3 sentence chat length

| # | Metric | Unit of computation | Minimum text for validity | Verdict at chat length |
|---|---|---|---|---|
| 1 | Per-author LM perplexity / cross-entropy / BPC | one message | ~20 tokens (measured) | **Best per-message metric.** Only metric with direct published evidence at 40 tokens |
| 2 | Character n-gram distribution distance (Cosine Delta on char 4-grams) | bundle (~50–200 msgs) | ~1,000–1,500 words | **Best bundle metric.** Robust on short/CJK/noisy text |
| 3 | Impostor-method score (fraction of feature subsets won) | bundle | ~500 words | Strong calibrated bundle score in [0,1] |
| 4 | Punctuation / emoji / casing / length rate deltas | sliding window of N msgs | usable per message, stable at N≥50 | Good *rate* signal; per-message variance is huge; emoji is partner-confounded |
| 5 | MAUVE | pool of ≥ ~2,000–5,000 generations | thousands of samples | Pool-level only. Never per message |
| 6 | MATTR / MTLD | bundle | ≥100 tokens (MATTR), ≥1 factor (MTLD) | Usable at bundle level; MTLD is the more length-robust of the two |
| 7 | Burrows's Delta (Classic, Manhattan on z-scores) | bundle | ~1,500 words for attribution; 100 words for shortlisting | **Unusable per message** (z-scores degenerate). Bundle only |
| 8 | KL / Jensen–Shannon over n-gram distributions | bundle | needs smoothing; ≥ hundreds of tokens | Fine at bundle level; infinite/undefined per message after smoothing |
| 9 | TTR / Yule's K / Herdan's C / Simpson's D | bundle | length-dependent | **Unusable per message**; documented length dependence |
| 10 | BERTScore | one message | works per sentence | **Valid metric, wrong construct** — semantic, not stylistic |
| 11 | Sentence-length distribution distance | bundle | Yule 1939 used ~600 sentences/author | **Unusable per message** (1 sample); bundle only |
| 12 | NCD (gzip / zlib) | bundle | ≈2 KByte per document | **Noise at chat length.** PAN'23 compressor baseline c@1 = 0.051 |
| 13 | Unmasking (incl. generalized short-text version) | bundle | 500-word chunks; generalization needs ~4 printed pages | Bundle only; not applicable to a 2–3 sentence generation |
| 14 | Human forced-choice A/B | bundle or message | — | Humans are at/below chance on origin discrimination; weak instrument |

---

## 1. Burrows's Delta, Cosine Delta, and `stylo` defaults

### 1.1 Original Burrows's Delta (Classic Delta)

**(a) Definition.** For each of the top `n_w` most frequent words (MFW) in the reference collection,
compute the relative frequency `f_i(D)` in each text `D`. Standardise across the collection:

```
z_i(D) = ( f_i(D) - mu_i ) / sigma_i
```

where `mu_i` and `sigma_i` are the mean and standard deviation of `f_i` across the texts in the
collection. Then

```
Delta_B(D, D') = || z(D) - z(D') ||_1 = SUM_{i=1..n_w} | z_i(D) - z_i(D') |
```

i.e. **Manhattan / L1 distance between z-scored MFW frequency profiles**. Verified verbatim from
Evert et al. 2015 (CLFL), [aclanthology.org/W15-0709](https://aclanthology.org/W15-0709/) and its
PDF [W15-0709.pdf](https://aclanthology.org/W15-0709.pdf).

**(b) Who / when.** John F. Burrows (2002), *"'Delta': A Measure of Stylistic Difference and a Guide
to Likely Authorship"*, **Literary and Linguistic Computing 17(3): 267–287**, DOI
[10.1093/llc/17.3.267](https://doi.org/10.1093/llc/17.3.267).

**(c) Reference implementation.** `stylo` (R) — function `dist.delta()`; also `dist.delta` is what
`distance.measure = "delta"` selects. See
[CRAN stylo index](https://search.r-project.org/CRAN/refmans/stylo/html/00Index.html).

**(d) Reported behaviour on SHORT texts — the single most important number in this section.**
Burrows's own abstract states the method is accurate for

> "distinguishing the most likely author of texts **exceeding about 1,500 words** in length. It is of
> even greater value as a method of **reducing the field** of likely candidates for texts of as little
> as **100 words** in length."

Source: [Burrows 2002 abstract, ResearchGate](https://www.researchgate.net/publication/240956478). So
the author himself states 1,500 words for a *verdict* and 100 words only for *shortlisting*. A
**2–3 sentence chat message is 2 orders of magnitude below the shortlisting threshold** and 3 orders
below the verdict threshold.

There is also a structural failure, independent of the empirical threshold: with `n_w = 100` MFW, a
30-token message contains ~30 tokens total, so most of the 100 MFW have frequency **exactly 0** and
the z-score vector is dominated by the presence/absence pattern of a handful of tokens. The
μ/σ estimates are computed corpus-wide, but the *message's* vector is a near-degenerate binary
pattern, so per-message Delta distance is dominated by message length and topic, not style.
`UNVERIFIED` as an explicit published measurement — but it follows directly from the formula.

**(e) Verdict.** **Not valid per message.** Valid only on **pooled bundles**. Practical implication
for the app: never show a per-message Delta score; show a Delta score for "the last N generated
messages" vs "N real messages from the corpus", with N chosen so the bundle clears ~1,500 words.

### 1.2 Cosine Delta (also "Würzburg Delta")

**(a) Definition.** Same z-scored profile vectors `x = z(D)`, `y = z(D')`, but measure the **angle**
between them:

```
cos(alpha) = (x^T y) / ( ||x||_2 * ||y||_2 )
Delta_angle(D, D') = alpha
```

Equivalently, since the angle is monotone in cosine similarity, `1 - cos` is an order-preserving
distance. In `stylo` this is `dist.wurzburg()`, documented as *"Cosine Delta Distance (aka Wurzburg
Distance)"* — [CRAN stylo index](https://search.r-project.org/CRAN/refmans/stylo/html/00Index.html).
Verified formula from Evert et al. 2015,
[aclanthology.org/W15-0709](https://aclanthology.org/W15-0709/).

**(b) Who / when.** Peter W. Smith and W. Aldridge (2011), *"Improving Authorship Attribution:
Optimizing Burrows' Delta Method"*, **Journal of Quantitative Linguistics 18(1)**, DOI
[10.1080/09296174.2011.533591](https://doi.org/10.1080/09296174.2011.533591). The name "Cosine
Delta" / "Würzburg Delta" also attaches to Jannidis et al. 2015 and Evert et al. 2017.

**(c) Reference implementation.** `stylo` (R): `dist.wurzburg()`. In Python there is no
single canonical package; the PAN `cngdist` baseline implements the same idea (see §1.4).

**(d) Reported behaviour.**
- Smith & Aldridge abstract: *"Our results show that a word frequency vector of between **200 and 300
  words** give the most accurate results … We also demonstrate a **dramatic improvement in accuracy**
  by adapting Burrows' Delta to the cosine similarity measure."* Exact accuracy figures
  **UNVERIFIED — abstract only** (paywalled at Taylor & Francis).
- Evert et al. 2015 (CLFL, pp. 79–88), systematic sweep `n_w` = 10…10,000 on three corpora of 25
  authors × 3 novels each (English / French / German): *"Delta_angle **consistently outperforms** the
  other Delta measures, regardless of the choice of `n_w`. It is **robust for values up to
  `n_w = 10,000`**, degrading much more slowly than Delta_B and Delta_Q."* Clustering quality
  "adjusted Rand index **above 90%** for a wide range of `n_w`". For small `n_w <= 500`, Delta_B and
  Delta_Q (Quadratic/Squared-Euclidean) achieve the same quality; Delta_Q degrades for `n_w > 500`.
- Evert et al. 2015 mechanism: *"vector normalization is revealed as the key factor behind the success
  of Cosine Delta"*, and L1-normalizing Delta_B raises it to the same clustering quality as
  Cosine Delta. With L2-normalized vectors, Quadratic Delta and Cosine Delta become **equivalent**
  (they "are not based on genuinely different distance metrics").
- Jannidis, Pielström, Schöch, Vitt (2015), *"Improving Burrows' Delta – An empirical evaluation of
  text distance measures"*, **Digital Humanities Conference 2015, Sydney** (no DOI found;
  `UNVERIFIED` for a stable URL). Reported (secondary citation inside Evert et al. 2015, verbatim):
  *"Burrows's Delta remains a strong contender, but is **outperformed quite clearly by Cosine Delta**
  as proposed by Smith and Aldridge (2011)."* Jannidis et al. tested Delta plus 13
  precursors/variants and considered only `n_w` ∈ {100, 1000, 5000}.

**(e) Verdict.** Same length constraint as Classic Delta — **bundle-level only**. But Cosine Delta is
the better choice of the two because (i) it is the one that stays robust as `n_w` grows, which matters
because in a 104k-message corpus with code-mixing you want more features, not fewer; and (ii) the
vector normalization that makes it work also cancels the *magnitude* differences that short bundles
produce (Evert et al. 2015's explanation: normalization "equalizes the average magnitude of the z_i",
which is exactly the quantity a short bundle distorts).

### 1.3 `stylo` (R) defaults — exact values

Verified by fetching the package source directly:
[`R/stylo.default.settings.R`](https://raw.githubusercontent.com/computationalstylistics/stylo/master/R/stylo.default.settings.R).

| Setting | Default value | Meaning |
|---|---|---|
| `mfw.min` / `mfw.max` / `mfw.incr` | `100` / `100` / `100` | **Exactly 100 MFW** (min == max ⇒ no iteration) |
| `start.at` | `1` | Rank 1 = single most frequent word; nothing skipped at the top |
| `culling.min` / `culling.max` / `culling.incr` | `0` / `0` / `20` | **0% culling = no culling** (all MFW kept) |
| `distance.measure` | `"delta"` | **Classic Delta** = Manhattan on z-scores |
| `linkage` | `"ward.D"` | |
| `analysis.type` | `"CA"` | Cluster analysis |
| `sampling` | `"no.sampling"` | Whole texts, no chunking |
| `sample.size` | `10000` | words, used only when sampling is on |
| `analyzed.features` / `ngram.size` | `"w"` / `1` | word 1-grams |
| `preserve.case` | `FALSE` | lowercased |
| `relative.frequencies` | `TRUE` | |
| `z.scores.of.all.samples` | `FALSE` | z-scores from the **primary (training) set only** |
| `culling.of.all.samples` | `TRUE` | culling computed over both sets |
| `mfw.list.cutoff` | `5000` | tail of the word list truncated |
| `classification.method` | `"delta"` | |
| `cv` | `"none"` | |

So: **`stylo`'s out-of-the-box pipeline is 100 MFW, no culling, Classic Delta (L1 on z-scores),
word unigrams, lowercased, Ward.D linkage, cluster analysis.** The package's own source comment calls
Classic Delta the safe default: *"For English, usually Classic Delta is a good choice."*

**Two tensions worth recording, because they affect reimplementation:**

1. The same source file says *"On theoretical grounds, Euclidean Distance and Manhattan Distance
   should be avoided in stylometry"* — yet the default `distance.measure` **is** Manhattan-on-z-scores
   (`"delta"`), and there is no `"cosine"` in the enumerated list of measures. Cosine Delta is only
   reachable via the `dist.wurzburg` name. Do not read the comment as contradicting the default.
2. **Conflicting statement about what z-scores are computed over.** The source comment for
   `z.scores.of.all.samples = FALSE` says the default relies on the primary set only and that this
   *"is the classical solution used by Burrows and Hoover"*. A literature snippet surfaced during
   search claims the opposite for `perform.delta()`: *"In a fashion that does not completely adhere to
   Burrows (2002)'s instructions, stylo's perform.delta() function by default calculates the means and
   standard deviations of the relative frequencies of the n most frequent features using not only the
   training set, but also the document whose authorship is to be determined."*
   → **`UNVERIFIED` / unresolved.** The two statements may refer to different functions
   (`stylo()` vs `perform.delta()` / `classify()`). Anyone reimplementing must decide explicitly
   whether μ/σ include the held-out document, and document the choice.

### 1.4 Character-n-gram variant of Cosine Delta (important for this corpus)

`stylo` supports `analyzed.features = "c"` with `ngram.size`. Two independent pieces of evidence say
character n-grams are the better substrate for short, noisy, code-mixed text:

- Sapkota, Bethard, Moens, Daelemans (2015), *"Not All Character N-grams Are Created Equal: A Study in
  Authorship Attribution"*, NAACL 2015,
  [aclanthology.org/N15-1010.pdf](https://aclanthology.org/N15-1010.pdf): models based **only** on
  affix + punctuation n-grams performed as well as models using all n-grams, single-domain and
  cross-domain; **punctuation n-grams generalize best across topic**; the best punctuation category
  (mid-punct) beat the best word category (whole-word) at p < .05 (two-tailed t-test, Guardian1 and
  Guardian2 corpora).
- PAN's `cngdist` baseline (as described in the PAN 2023 overview, Stamatatos et al.,
  [downloads.webis.de/pan/publications/papers/stamatatos_2023.pdf](https://downloads.webis.de/pan/publications/papers/stamatos_2023.pdf)):
  *"the most common **4-character frames** are extracted from the training
  texts and used to represent each text. Then, for a pair of texts, the **cosine similarity** between
  the two texts is calculated"*, with two thresholds θ1, θ2 to allow abstention.

A third corroborating data point (from a search result, `secondary citation`): a study on the Tatar
quatrain found *"the Cosine Delta measure with extraction of character n-grams (with n = 4) proved to
be the most effective"*.

**Recommendation for the app:** compute **Cosine Delta over character 4-grams** (with word 1-gram
Cosine Delta as a second view), on bundles of real vs generated messages. Character 4-grams are far
less sparse than 100 word-MFW on 20–120-character messages, they survive typos and code-switching
(the "not significantly affected by spelling errors or strange use of punctuation" argument,
Stamatatos 2009, secondary citation), and they capture punctuation placement directly.

---

## 2. Cosine similarity over function-word vectors; L1 vs L2 vs cosine

**(a) Definitions.**

```
cosine similarity  cos(x,y) = (x^T y) / (||x||_2 ||y||_2)          in [-1, 1]
cosine distance    d_cos(x,y) = 1 - cos(x,y)                       in [0, 2]
Manhattan / L1     d_L1(x,y)  = SUM_i |x_i - y_i|
Euclidean / L2     d_L2(x,y)  = sqrt( SUM_i (x_i - y_i)^2 )
```

**(b) Who / when.** Function-word stylometry goes back to Mosteller & Wallace (1964) on the Federalist
Papers (secondary citation across many of the sources opened). Cosine similarity as a *stylometric*
distance is Smith & Aldridge 2011 (§1.2) and, for function words specifically, Baayen, van Halteren,
Neijt, Tweedie (2002), *"An experiment in authorship attribution"*, JADT 2002,
[quantling.org/~hbaayen/publications/BaayenVanHalterenNeijtTweedieJADT2002.pdf](https://quantling.org/~hbaayen/publications/BaayenVanHalterenNeijtTweedieJADT2002.pdf)
(that paper uses entropy-weighted linear discriminant analysis, not cosine).

**(c) Reference implementation.** Trivially available: `scipy.spatial.distance.cosine`,
`sklearn.metrics.pairwise.cosine_similarity`, `scipy.spatial.distance.cityblock` (L1),
`scipy.spatial.distance.euclidean` (L2). In stylometry specifically: `stylo` R package's
`dist.cosine`, `dist.minmax`, `dist.manhattan`, `dist.euclidean`
([CRAN index](https://search.r-project.org/CRAN/refmans/stylo/html/00Index.html)).

**(d) Reported behaviour.**
- Evert et al. 2015: after z-standardisation, **L2-normalised Quadratic Delta and Cosine Delta are
  mathematically equivalent**; L1-normalisation of Delta_B gives clustering quality equal to
  Cosine Delta, and *"it seems to make little difference whether an appropriate normalization is used
  (L1 for Delta_B and L2 for Delta_Q) or not"*. So the choice of L1 vs L2 is **not** the operative
  variable — **whether you normalise the feature vectors at all** is. That is the actionable finding.
- Baayen et al. 2002, 8 Dutch students, 9 texts each (3 genres × 3 topics), ~1,000 words/text:
  plain LDA on 60 function words = **chance**; the *same* data with entropy weighting (ELDA) =
  **81.5%**; adding **8 punctuation marks** (`.,'"?!:;`) to 50 function words = **88.1%**. The
  authors' own conclusion: *"we were surprised by the extent to which the simple inclusion of
  punctuation marks in the analysis enhanced classification accuracy."*
- `stylo`'s own guidance (source comment, verified): Canberra *"risky, but sometimes amazingly
  good"*, and should be combined with careful culling and a limited number of MFW.

**(e) Verdict.** Valid **only on bundles**. The operative lever is **vector normalisation**, not the
metric. For 2–3 sentence messages, a function-word frequency vector has almost no support: with a
~30-token message and a 100-word MFW list, the vector is mostly zeros and the cosine is dominated by
which two or three of the MFW happened to appear. Use function-word cosine on bundles of ≈50–200
messages, where per-feature counts reach the tens.

---

## 3. Jensen–Shannon divergence and KL divergence over n-gram distributions

**(a) Definitions.**

```
KL(P || Q)  = SUM_i P(i) * log( P(i) / Q(i) )                 asymmetric, >= 0
JSD(P, Q)   = 0.5 * KL(P || M) + 0.5 * KL(Q || M),   M = 0.5*(P + Q)
```

JSD is **symmetric** and bounded: `0 <= JSD <= ln 2` nats (or `<= 1` if the log base is 2).
`JSD` is the *smoothed, symmetrised* form of KL — it is the standard fix for KL's asymmetry, which
arises because the expectation `SUM_i P(i)·...` is taken under the *first* argument only: `KL(P‖Q)`
penalises "P puts mass where Q has none" but not the reverse.

**(b) Smoothing requirement.** If `P(i) > 0` and `Q(i) = 0` for any `i`, then `KL(P‖Q) = +infinity`.
For n-gram distributions over short text this is the *normal* case, not the exception: a
character-4-gram present in the generated bundle but absent from the reference bundle makes the
divergence infinite. **Smoothing is mandatory.** Laplace/add-ε or Krichevsky–Trofimov (KT) smoothing
are the standard choices. KT smoothing is specifically the one recommended in the MAUVE line of work
(§8) for exactly this reason. Note that JSD is already a partial fix (it can never be infinite for
finite-support P, Q with a common support), so **prefer JSD over raw KL** on short text.

**(c) Who / when.**
- Lin, J. (1991), *"Divergence measures based on the Shannon entropy"*, IEEE Trans. Information
  Theory — the origin of JSD. `UNVERIFIED` (I did not open this paper; cited inside other sources).
- Smoothed KL: Kullback & Leibler (1951); Krichevsky & Trofimov (1981) for the KT estimator.
  `UNVERIFIED` (not opened).
- **KL over punctuation distributions in stylometry with numbers:**
  Darmon, Bazzi, Howison, Porter (2021), *"Pull out all the stops: Textual analysis via punctuation
  sequences"*, **European Journal of Applied Mathematics 32(6): 1069–1105**, DOI
  [10.1017/S0956792520000157](https://doi.org/10.1017/S0956792520000157)
  (author PDF: [math.ucla.edu](https://www.math.ucla.edu/~mason/papers/darmon-published-final-nov2021.pdf)).
  They define the **consistency of an author with respect to a feature** as *"the mean KL divergence
  for that feature across all pairs of documents by that author"* — i.e. a within-author KL baseline
  that is directly repurposable as a fidelity metric.
- **JSD over character n-gram distributions in authorship verification:**
  *"On divergence-based author obfuscation: An attack on the state of the art in statistical authorship
  verification"*, **it – Information Technology (2019)**, DOI
  [10.1515/itit-2019-0046](https://doi.org/10.1515/itit-2019-0046). Abstract (verbatim): the approach
  *"(1) models writing style difference as the **Jensen-Shannon distance between the character
  n-gram distributions** of texts"* and derives *"**text length-invariant thresholds** for
  termination"*. **Author list `UNVERIFIED`** (I read the abstract, not the byline). The JSD here is
  used as the *attack* objective against state-of-the-art verifiers, which is strong evidence it is a
  discriminative stylistic quantity.

**(d) Reported behaviour.**
- Darmon et al. 2021, 651 authors / 14,947 documents from Project Gutenberg, six punctuation features
  f1…f6 (f1 = punctuation frequency vector; f2 = conditional prob. of ordered punctuation pairs;
  f3 = joint prob. of ordered punctuation pairs; f4 = sentence-length frequency vector; f5 =
  words-between-punctuation frequency vector; f6 = mean words between ordered punctuation pairs).
  Author recognition, KL-divergence classifier, accuracy on held-out 20%:
  - f3 (joint prob. of successive punctuation pairs) is the **best single feature**: **0.74** at 10
    authors, **0.66** at 50 authors, 0.49 at 100, 0.47 at 200, 0.41 at 400 (baseline: 0.21 / 0.029 /
    0.019 / 0.0079 / 0.0047).
  - f1 (punctuation frequency): 0.69 / 0.54 / 0.37 / 0.30 / 0.27.
  - **f4 (sentence length): the weakest** — 0.52 / 0.30 / 0.25 / 0.16 / 0.15.
  - f5 (words between punctuation): 0.63 / 0.31 / 0.23 / 0.20 / 0.16.
  - One-layer NN (2,000 neurons) with all features: **0.72 on 651 authors**; with only f3, 0.62.
  - Same-author vs different-author KL distributions are separated with KS test p ≤ 1.218e-79 for all
    features.

**(e) Verdict.**
- **KL over raw n-gram counts at chat length: invalid** (infinite without smoothing; after smoothing
  the estimate is dominated by the smoothing constant). **Always use JSD**, or KT-smoothed KL.
- **JSD over punctuation / character-n-gram distributions at bundle level: valid and well supported.**
  The Darmon et al. "author consistency = mean KL over same-author document pairs" formulation is
  exactly the shape a fidelity score needs: compute the reference distribution of
  within-author-JSD from the 104k real messages (split into bundles), then score a generated bundle's
  JSD against that reference. Report a percentile, not a raw divergence.
- Note the clinical caveat for *this* corpus: Darmon et al. found f4 (sentence/utterance length) is
  the **worst** punctuation-family feature for author recognition. That matches §5's finding that
  length-distribution features need enormous samples. Do not lead with length.

---

## 4. Lexical diversity: TTR, MATTR, MTLD, Yule's K, Herdan's C, Simpson's D

Notation (as used by `quanteda`): `N` = total tokens, `V` = number of types, `f_v(i, N)` = number of
types occurring exactly `i` times in a sample of `N` tokens.

### 4.1 Exact formulas

| Measure | Formula | Origin |
|---|---|---|
| TTR | `V / N` | Chotlos 1944 / Templin 1957 (as credited by `lexicalrichness` docs) |
| MATTR | mean of TTR over all sliding windows of size `n` | Covington & McFall 2010 |
| MTLD | `N / (number of factors)`, where a **factor** ends each time running TTR drops below `0.720` | McCarthy & Jarvis 2010 |
| Yule's K | `K = 10^4 * [ -1/N + SUM_{i=1..V} f_v(i,N) * (i/N)^2 ]` | Yule 1944 (as presented in Tweedie & Baayen 1998, Eq. 16) |
| Herdan's C | `C = log V / log N` (aka LogTTR) | Herdan 1960/1964 |
| Simpson's D | `D = SUM_{i=1..V} f_v(i,N) * (i/N) * ((i-1)/(N-1))` | Simpson 1949 (Tweedie & Baayen 1998, Eq. 17) |

Yule's K, Herdan's C and Simpson's D formulas verified verbatim from the `quanteda` reference page
[quanteda.io/reference/textstat_lexdiv.html](https://quanteda.io/reference/textstat_lexdiv.html) and
the `lexicalrichness` formulas page
[lexicalrichness.readthedocs.io](https://lexicalrichness.readthedocs.io/en/latest/example.html).
Note Herdan's **Vm** is a *different* measure (Herdan 1955) — do not conflate it with Herdan's C.

### 4.2 MATTR — exact algorithm and the window-size trap

**(a) Definition.** Covington & McFall's algorithm: estimate TTR for tokens `1..n`, then `2..n+1`,
`3..n+2`, … to the end of the text, then average. "a moving window that is independent of text
length."

**(b) Who / when.** Michael A. Covington and Joe D. McFall (2010), *"Cutting the Gordian Knot: The
Moving-Average Type–Token Ratio (MATTR)"*, **Journal of Quantitative Linguistics 17(2)**, DOI
[10.1080/09296171003643098](https://doi.org/10.1080/09296171003643098).

**(c) Reference implementations — and their window defaults DISAGREE.**

| Package | Function | Default window | Verified |
|---|---|---|---|
| R `quanteda` | `compute_mattr(x, MATTR_window = 100L)` | **100** | [quanteda.io](https://quanteda.io/reference/compute_mattr.html) |
| Python `lexicalrichness` | `lex.mattr(window_size=100)` | **100** | [readthedocs](https://lexicalrichness.readthedocs.io/en/latest/docstring_docs.html) |
| Python `lexical_diversity` (kristopherkyle) | `ld.mattr(text)` | **50** | [GitHub](https://github.com/kristopherkyle/lexical_diversity) — README: *"By default, the window size is 50 words."* Worked example: `ld.mattr(flt)` → `0.7206106870229007`; `ld.mattr(flt, window_length=25)` → `0.7961538461538458` |

That last pair of numbers is itself the warning: **halving the window moved MATTR by +0.076**. MATTR
is only "length-independent" *given a fixed window*; across implementations it is not comparable.

**(d) Reported behaviour on short text.** `quanteda` documents the window as *"between 1 and the number
of tokens of the document"* — so MATTR is *defined* for a window equal to the message length, but then
it degenerates to plain TTR for any message shorter than the window. On a 30-token message with
`window = 100`, most implementations either error or return TTR. **UNVERIFIED**: no paper I opened
reports MATTR's variance specifically at 30–60 tokens.

**(e) Verdict.** **Bundle-level only, with `window <= min(bundle tokens)`.** For chat-style corpora use
a **small fixed window (25–50 tokens)** and report it, or use MTLD.

### 4.3 MTLD — exact algorithm, threshold 0.72

**(a) Definition.** *"MTLD is an index of a text's LD, evaluated sequentially. It is calculated as the
mean length of sequential word strings in a text that maintain a given TTR value (here, **.720**).
During the calculation process, each word of the text is evaluated sequentially for its TTR… when the
default TTR factor size value (here, .720) is reached, the factor count increases by a value of 1, and
the TTR evaluations are reset."* MTLD = `N / factor_count` (the published worked example: 340 words,
factor count 4.404 → MTLD 77.203).

**(b) Who / when.** Philip M. McCarthy and Scott Jarvis (2010), *"MTLD, vocd-D, and HD-D: A validation
study of sophisticated approaches to lexical diversity assessment"*, **Behavior Research Methods
42(2): 381–392**.

**(c) Reference implementations.** Python `lexicalrichness`: `lex.mtld(threshold=0.72)`; README
recommends the *"factor threshold in the range of [0.660, 0.750]"* per McCarthy & Jarvis (2010,
p. 385). Python `lexical_diversity`: `ld.mtld(text)`. R: `quanteda::textstat_lexdiv(measure = "MTLD")`.
`taaled` / `koRpus` also implement MTLD variants — **`UNVERIFIED`** (not opened).

**Threshold provenance (verified, verbatim from the paper):** *"The value of .720 was selected because
it fell on the higher side of the middle of this range. … Our initial testing suggested that there
were no significant differences between TTRs within the range from .660 to .750."* Stabilisation was
estimated at `.720 ± .03`; `.760` still showed fluctuations from "lexical clusters"; `.650` "strongly
established" but wastes tokens. So **.720 is a convention within a validated plateau, not a magic
number.**

**Forward/backward:** the standard practical variant computes MTLD left-to-right, then right-to-left,
and averages the two (bidirectional MTLD), because a single direction is sensitive to where the
factors happen to fall. **`PARTIALLY UNVERIFIED`** — the bidirectional convention is what
implementations such as Kyle's `taaled` (`mtld_ma_bid`) provide, but I did not open a McCarthy & Jarvis
passage mandating the forward+backward average. If you implement MTLD, implement both directions and
record which you used.

**(d) Reported behaviour on short text — the key finding.** McCarthy & Jarvis compared MTLD against
TTR, Maas, Yule's K, vocd-D and HD-D across two corpora on convergent, divergent, internal and
incremental validity: *"MTLD performs well with respect to all four types of validity and is, in fact,
**the only index not found to vary as a function of text length**."* That makes MTLD the single most
defensible lexical-diversity metric for a length-heterogeneous chat corpus.

**But MTLD needs at least one factor.** A 30-token message with threshold 0.72 typically has TTR high
enough that the running TTR never falls below 0.72 — there is **zero** factor boundary and MTLD is
undefined (or is computed with a partial-factor correction that is pure smoothing). **Practical
minimum: a bundle large enough that MTLD has ≥ 5 factors**, i.e. a few hundred tokens.

**(e) Verdict.** **MTLD: valid at bundle level, best-in-class length robustness.** **MATTR: valid at
bundle level if the window is fixed and reported.** **TTR / Yule's K / Herdan's C / Simpson's D:
invalid at message level, and only weakly useful at bundle level.**

### 4.4 Length dependence — the governing reference

Tweedie, F. J. and Baayen, R. H. (1998), *"How Variable May a Constant be? Measures of Lexical Richness
in Perspective"*, **Computers and the Humanities 32(5): 323–352**, DOI
[10.1023/A:1001749303137](https://doi.org/10.1023/A:1001749303137)
(author PDF: [quantling.org](https://quantling.org/~hbaayen/publications/TweedieBaayen1998.pdf)).

Verified findings, quoted from the paper:
- *"almost all constants that have been proposed in the literature **change systematically with the
  text length**."*
- Only `K(N)` (Yule's K), `D(N)` (Simpson's D), `Z(N)`, `b(N)`, `c(N)` are theoretically constant;
  K, D and Z are truly/nearly constant in theory *"but may reveal significant deviation from their
  expected values in actual text."*
- *"it should not be taken for granted that discourse structure leaves the constancy of lexical
  measures unaffected."* And: *"almost all of the so-called constants varied as the text length
  increased."*
- They reduce the field to **two useful families**: one measuring lexical **richness**
  (`K, D, Vm`) and one measuring **repetition**; and conclude *"the use of a great many different
  lexical constants in authorship attribution studies is unnecessary."* Comparing against 100
  function words: *"it is surprising how much authorial structure is already captured by just two
  measures, Z(N) and K(N)"* — with the explicit caveat that *"spatial separation [in the Z–K plane]
  does not guarantee a difference in authorship."*

**(e) Verdict.** Lexical diversity is a **weak, length-entangled** signal whose documented failure mode
is exactly the regime of a chat corpus. Use it only as a **bundle-level descriptor** (MTLD primary,
MATTR with a declared window secondary), and never as the headline fidelity number.

---

## 5. Sentence/utterance length, punctuation, emoji, emoticon, casing, typo rate

### 5.1 Sentence/utterance length distribution distance

**(a) Definition.** Build the frequency vector (or histogram) of sentence/utterance lengths in words;
compare two such vectors with a distribution distance — e.g. KL/JSD (§3), or the KL-based consistency
of Darmon et al. Feature `f4` in that paper *is* the sentence-length frequency vector. On a
per-message basis the natural analogue is the **utterance-length distribution over a window of N
messages**, plus scalar moments (mean, sd, coefficient of variation = "burstiness").

**(b) Who / when.**
- G. Udny Yule (1939), *"On Sentence-Length as a Statistical Characteristic of Style in Prose: With
  Application to Two Cases of Disputed Authorship"*, **Biometrika 30(3–4): 363–390**, DOI
  [10.1093/biomet/30.3-4.363](https://doi.org/10.1093/biomet/30.3-4.363) (JSTOR mirror
  [10.2307/2332655](https://doi.org/10.2307/2332655)). This is the founding paper.
- Darmon et al. 2021 (§3) for the modern KL treatment.
- Burstiness as a modern AI-vs-human signal: *"Sentence-Length Burstiness as a Cross Disciplinary and
  Cross-Model Signal of AI Rewriting"*, TextPulse Research, 2026 —
  [textpulse.ai PDF](https://textpulse.ai/research/textpulse-burstiness-sentence-length-2026.pdf).
  **NOT PEER REVIEWED — treat as grey literature.**

**(c) Reference implementation.** No canonical package. Compute directly: `numpy.std`, or a
histogram + `scipy.spatial.distance.jensenshannon`. Darmon et al. released code:
[github.com/alex-darmon/punctuation-stylometry](https://github.com/alex-darmon/punctuation-stylometry)
and data at DOI [10.5281/zenodo.3605100](https://doi.org/10.5281/zenodo.3605100).

**(d) Reported behaviour on SHORT texts — and Yule's own sample sizes.**
- **Yule 1939 needed ~600 sentences per author** to establish stability: his Lamb sample A and sample B
  were *"about 600 sentences"* and *"601 sentences"*; the Coleridge Biographia Literaria samples were
  601 and 606 sentences. He concluded sentence-length *"does remain constant within fairly narrow
  limits"*, but explicitly: *"In case of dispute … a judgement based on frequency distributions of
  sentence-lengths for the two must in the end be a **personal one**"*. He also warns length is
  affected by subject matter.
  → **600 sentences ≈ 300–600 chat messages.** A 2–3 sentence message contributes 1 sample.
- **Darmon et al. 2021: f4 (sentence length) was the WEAKEST of their six punctuation features** —
  0.52 accuracy at 10 authors falling to 0.15 at 400, versus f3's 0.74 → 0.41.
- TextPulse 2026 (grey literature, 60,779 human texts vs AI rewrites): human academic mean CV of
  sentence length **0.449**, AI rewrites **0.376**, 79.3% of rewrites flatter; per-model CV change
  ranged from −0.028 to −0.234 (DeepSeek strongest flattener). Most useful for the app is the
  authors' own operational conclusion, quoted: *"A cutoff of 0.40 catches 62 percent of rewrites in
  this corpus, but it also flags **39 percent of the genuine human texts**. … Burstiness distinguishes
  distributions with high confidence. **It does not identify individuals**."*

**(e) Verdict.** **Invalid per message** (1 sample per message; a distribution over one point has zero
information). **Moderately useful at bundle level**, and even then it is documented as the *weakest*
of the punctuation-family features and as a population-level rather than individual-level signal.
For a WeChat clone, use utterance-length CV as a **diagnostic against AI-flattening**, not as a
per-author fidelity score.

### 5.2 Punctuation features with numbers

**(a) Definition.** Darmon et al.'s six features are the clearest published set (verbatim from the
paper):
1. `f1` — frequency vector for punctuation marks in document k.
2. `f2` — empirical approximation of the conditional probability of the successive occurrence of
   elements in an ordered pair of punctuation marks.
3. `f3` — empirical approximation of the **joint probability** of the successive occurrence of an
   ordered pair of punctuation marks.
4. `f4` — frequency vector for **sentence lengths** (sentence end = `.` `!` `?` or ellipsis).
5. `f5` — frequency vector for the **number of words between successive punctuation marks**.
6. `f6` — mean number of words between successive occurrences of an ordered punctuation pair.

Author **consistency** = mean KL divergence for that feature across all pairs of documents by that
author.

**(b)/(c)/(d).** See §3 and §5.1 above for attribution, implementation and numbers:
- Punctuation-only author recognition, 651 authors: **f3 = 0.62–0.74**, all features via NN = **0.72**.
- Baayen et al. 2002: adding 8 punctuation marks to 50 function words raised ELDA accuracy from
  **81.5% → 88.1%**.
- Sapkota et al. 2015: **punctuation n-grams generalize best across topic**; affix+punct-only models
  match all-n-gram models.
- "Topic or Style?" (Sari, Stevenson, Vlachos, C18-1029,
  [aclanthology.org/C18-1029.pdf](https://p.rst.im/q/aclanthology.org/C18-1029.pdf) — canonical URL
  `https://aclanthology.org/C18-1029.pdf`): style feature block = **174 function words + 12 punctuation
  marks**; ablating style cost **−3.87 to −8.39** accuracy points (FNN) across Judgment, CCAT10,
  CCAT50, IMDb62. Their listed style features include *"Percentage of digits, percentage of upper case
  letters"*, *"Average word length, number of short words"*, *"Digit frequency"*, *"Occurrence of
  punctuation"*.
- Grieve 2007 (secondary citation, in C18-1029): *"the combination of word and punctuation mark
  profiles are effective features for representing authors"*, on the Telegraph Columnist corpus.
  Guthrie 2008 (secondary citation, same source): of 166 features, 15 were most useful, *"including
  punctuation marks, pronouns, fog index and average sentence length"*.

**(e) Verdict.** **Valid as a rate feature at any length** — a rate is defined on a single message — but
per-message variance is large. **Best used as a sliding-window rate delta** (e.g. over the last 50–200
messages) rather than a per-message score. This is the metric family where the app has the *most*
leverage, because (i) it works at short length, (ii) punctuation generalizes across topic, and (iii)
code-mixed Chinese/English chat has a very rich punctuation/typography inventory (full-width vs
half-width `，`/`,`, `。`/`.`, `！`/`!`, `～`, `……`, `、`, no-space vs space after punctuation,
repeated `！！！`, `???`, etc.) that no literary corpus ever sees.

### 5.3 Emoji and emoticon usage

**(a) Definition.** Counts and rates over a message or window: emoji count, types, emoji-per-word,
emoji-per-character, emoji *functions* (Evans 2017 classification, as expanded by Marko 2020), plus
distinct counts for ASCII emoticons (`:)`, `:D`, `orz`, `233`) which behave differently from Unicode
emoji.

**(b) Who / when and (d) reported behaviour.**
- Marko (2020), *"Exploring the Distinctiveness of Emoji Use for Digital Authorship Analysis"*,
  *Linguística* / LLLD (Universidade do Porto),
  [ojs.letras.up.pt](http://ojs.letras.up.pt/index.php/LLLD/article/view/10349). Sample: 60
  individuals on Instagram; extends Evans (2017)'s emoji-function framework. Verified conclusion:
  *"individuals do indeed exhibit emoji usage patterns that can be valuable for authorship analysis."*
  Note the corpus is **non-interactive** Instagram posts.
- *"'Depends on Who I'm Writing To' — The Influence of Addressees and Personality Traits on the Use of
  Emoji and Emoticons, and Related Implications for Forensic Authorship Analysis"*, **Frontiers in
  Communication (2022)**, DOI
  [10.3389/fcomm.2022.840646](https://doi.org/10.3389/fcomm.2022.840646). This is **the most
  important paper in this subsection for a WeChat clone.** Verified findings:
  - *"the **frequency of emoji use is indeed strongly influenced by conversation partners**"* —
    a statistically significant difference at **p = 0.001** between the emoji and non-emoji conditions.
  - Authorship attribution on chat turns using **only** emoji/emoticons: with only three participants
    who consistently used emoticons, attribution gave a **100% correct identification rate**; the
    range of emoticons was small (8 types vs 50 emoji types). Ordering of individuating power:
    **emoticons > emoji types > emoji functions**.
  - Explicit implication: controlling for interlocutor matters; the identification rate based on emoji
    functions was *"considerably reduced"* in interactive data relative to Marko's non-interactive
    Instagram data.
- Segalin, Celli, Polonio, Kosik, Cristani, Vinciarelli (2012), *"Conversationally-inspired stylometric
  features for authorship attribution in instant messaging"*, **ACM Multimedia 2012**, DOI
  [10.1145/2393347.2396398](https://doi.org/10.1145/2393347.2396398)
  (PDF: [cristinasegalin.com](https://www.cristinasegalin.com/research/papers/ACMM12.pdf)).
  Feature list extracted **per turn**, not per conversation: `#words`, `#emoticons`,
  `#emoticons/word`, `#emoticons/characters`, `#exclamation marks`, `#question marks`, `#characters`,
  `average word length`, `#three points` (ellipsis), `#uppercase letters`, `#uppercase/words`,
  `turn duration`, `#return chars`, `chars/second`, `words/second`, `mimicry degree`. 77 subjects,
  average **615 words per subject**, AUC of the Cumulative Match Characteristic curve = **89.5%**
  with turn-level rather than conversation-level features. Methodological note they give: they use
  **exponential histograms** with bins *"smaller for small values and larger for higher values"*
  *"because the turns are short and small values tend to be more represented"* — a directly reusable
  design decision for the app's feature binning.
- Chat mining: *"Predicting user attributes in text-based online messaging"*-style study in
  **Information Processing & Management (2008)**, DOI
  [10.1016/j.ipm.2007.12.009](https://doi.org/10.1016/j.ipm.2007.12.009)
  (PDF: [cs.bilkent.edu.tr](http://www.cs.bilkent.edu.tr/~aykanat/papers/08IPM.pdf)). Corpus: 1,616
  users, 218,742 messages, **6.2 words per message on average**, ~160 messages per user; stylistic
  feature set includes *"smileys"* because *"The smileys are important features that are frequently
  found in chat messages."* Result: author identity correctly predicted with **99.7% accuracy among
  100 authors** using term-based features; style-based features perform equally at small class counts
  but degrade faster as classes grow, *"because the dimensionality of the style-based feature sets are
  much smaller"*. Their finding that *"the vocabulary use of a person is dependent on the target and
  the time of the message while the communication style is only dependent on the person writing that
  message"* is a strong argument for style features in a clone — but it is contradicted in the emoji
  frequency case by the Frontiers 2022 accommodation result. Reconcile as: **lexical/phonetic style is
  person-stable; emoji frequency is partner-conditioned.**

**(e) Verdict.** **Emoji/emoticon rate delta is a valid short-text metric *if conditioned on the
interlocutor*** (the Frontiers 2022 p = 0.001 accommodation result makes an unconditioned emoji-rate
delta a measure of who you are talking to, not of who is writing). Emoticon *type* usage is the most
individuating of the emoji-family features. Write a per-contact correction or at minimum report the
delay separately per contact.

### 5.4 Casing ratio

**(a) Definition.** `#uppercase letters / #letters`, or `#uppercase words / #words`, or (for Chinese)
the rate of full-width vs half-width characters, and the rate of Latin-script tokens embedded in
Chinese text. Segalin et al. 2012 use `#uppercase letters` and `#uppercase letters / #words` as
turn-level features. "Topic or Style?" (C18-1029) lists *"percentage of upper case letters"* in its
style feature block, with the ablation numbers given in §5.2.

**(c) Reference implementation.** No canonical package; trivially computed. `textstat` and `lexicalrichness`
do not cover casing. **`UNVERIFIED`**: I found no paper isolating casing-ratio accuracy on chat data.

**(e) Verdict.** **Valid as a rate feature at message length.** Cheap, robust, and highly diagnostic
for a code-mixed chat corpus (where `OK` vs `ok` vs `Ok`, and the full-width/half-width choice,
are strong idiolect markers). Report as a rate over a window; per-message it is a near-binary signal.

### 5.5 Typo / misspelling rate

**(a) Definition.** Typically either (i) character-error rate against a dictionary/spellchecker,
(ii) rate of out-of-vocabulary tokens relative to the author's own vocabulary, or (iii) rate of
"informal orthography" tokens (`u`, `r`, `b4`, `233`, `orz`, pinyin-only spellings, tone-free
pinyin, dropped punctuation).

**(b)/(c)/(d).** **`UNVERIFIED`.** I did **not** open any paper that isolates a typo/misspelling **rate**
as a stylometric feature with reported accuracy numbers. What I did verify is weaker and indirect:
- Sapkota et al. 2015 (opened): character n-grams' success is partly attributed to affix and
  punctuation structure, and the paper discusses `mid-word` n-grams capturing morphological
  preferences.
- Stamatatos (2009) and Koppel & Schler (2003), both **secondary citations** surfaced inside opened
  sources: character n-gram representations are *"not significantly affected by spelling errors"*
  (i.e. typos are absorbed rather than measured), and *"character n-grams can be used to capture
  regular grammatical or orthographic errors which in some cases could represent the character of the
  authors"*.

**(e) Verdict.** Plausible and probably strong for a code-mixed chat corpus, but **`UNVERIFIED`** in the
literature I opened. If the app implements it, treat it as an in-house feature: define the typo proxy
explicitly (e.g. OOV rate against a corpus-derived lexicon, plus a pinyin-fallback rate) and calibrate
its weight empirically against the author's own held-out messages rather than citing a paper.

---

## 6. Compression-based distance: NCD, gzip/zlib, and the compression authorship line

### 6.1 NCD and its relatives — exact formulas

```
NCD(x, y)  = ( C(xy) - min{ C(x), C(y) } ) / max{ C(x), C(y) }        (Cilibrasi & Vitanyi)
CDM(x, y)  = C(xy) / ( C(x) + C(y) )                                  (Keogh et al.); range [0.5, 1]
CLM(x, y)  = 2 - 1 / CDM(x, y)                                        order-preserving map of CDM; range [0, 1]
CBC(x, y)  = 1 - ( C(x) + C(y) - C(xy) ) / sqrt( C(x) * C(y) )        (Halvani et al.'s "compression-based cosine")
```

where `C(z)` is the byte length of `z` after compression and `xy` is `x` concatenated with `y`.
Verified verbatim from Halvani, Winter, Graner (2017), *"Authorship Verification based on
Compression-Models"*, arXiv [1706.00516](https://arxiv.org/abs/1706.00516)
(DOI [10.48550/arXiv.1706.00516](https://doi.org/10.48550/arXiv.1706.00516)). Their relation:
`N_CBC = sqrt(C(x)C(y)) <= N_NCD = max{C(x),C(y)} <= N_CLM = C(xy) <= N_CDM = C(x)+C(y)`.

### 6.2 Provenance

**(b) Who / when.**
- **NCD:** Cilibrasi & Vitányi (2005), building on the Normalized Information Distance (NID) and
  Kolmogorov complexity. Cited inside Halvani et al. 2017 — the primary paper was **not** opened;
  `UNVERIFIED` for exact venue.
- **CDM:** Keogh, Lonardi, Ratanamahatana (2004). `UNVERIFIED` (not opened).
- **Fast Compression Distance (FCD):** `FCD(x,y) = ( |D(x)| - |D(x) ∩ D(y)| ) / |D(x)|`, where `D(x)`
  is the LZW-on-words dictionary of `x`. Cerra, Datcu et al. (2014), *"Authorship Analysis based on
  Data Compression"*, arXiv [1402.3405](https://arxiv.org/pdf/1402.3405v1.pdf).
- **The AV line:** Oren Halvani, Christian Winter, Lukas Graner (2017). Two venues:
  *"On the Usefulness of Compression Models for Authorship Verification"*, **IH&MMSec 2017**, DOI
  [10.1145/3098954.3104050](https://doi.org/10.1145/3098954.3104050); and the extended
  *"Authorship Verification based on Compression-Models"*, arXiv
  [1706.00516](https://arxiv.org/abs/1706.00516).

**(c) Reference implementation.** No single canonical package for stylometric NCD. The primitives are
`gzip` / `zlib` / `bz2` / `lzma` in the Python standard library (`len(zlib.compress(x))`), or `zip`
with a STORE/DEFLATE level. Halvani et al. benchmark five compressors (PPMd, GZip, BZip2, Zip, LZW)
and three dissimilarity measures. **`UNVERIFIED`**: I did not open a maintained PyPI package
specifically for stylometric NCD.

### 6.3 What text length is needed for NCD to be meaningful

This is the crux, and the literature is unusually explicit.

**(d) Reported behaviour on short text.**
- **Alfonseca, Cebrián, Ortega (2005), *"Common Pitfalls Using the Normalized Compression Distance:
  What to Watch Out for in a Compressor"*, Communications in Information and Systems 5(4)**, DOI
  [10.4310/cis.2005.v5.n4.a1](https://doi.org/10.4310/cis.2005.v5.n4.a1). Verified findings:
  - *"the compressors used to compute the normalized compression distance are **not idempotent** in
    some cases, being **strongly skewed with the size of the objects and window size**, and therefore
    causing a deviation in the identity property of the distance if we don't take care that the objects
    to be compressed fit the windows."*
  - *"NCD(x, x) is between 0.0 and 0.1 in the region where gzip can be used properly, while it gives
    values which grow to 1 outside that region."*
  - For gzip specifically: *"an initial slow-fluctuating growth with n, followed by a strong
    discontinuity, with a **jump to 0.9 at 32 Kbytes**, and finally a new slow (but slightly faster)
    growth, until the distance saturates in 1."*
  - Prescription: *"the block, the sliding window and the lookahead window should be **at least as
    large as the sum of the sizes of the objects to be compared**"*, and *"in computing the NCD(x, y)
    the concatenation xy should comfortably fit the window size or block size."*
- **Cerra et al. (2014), FCD**: *"A drawback of the proposed method is that it **cannot be applied
  effectively to very short texts**. … we estimated empirically **1000 tokens or words** to be a
  reasonable size for learning the model of a document and to be effective in its compression."*
- **Halvani et al. (2017)** corpus sizes, verified from the paper: CPAN15 comprises 500 problems /
  1,000 documents, *"where 83 are unique with a size of ≈ 2 KByte"*; in CPAN14esEval they noted *"the
  four shortest texts … document sizes between 2–3 KByte which, as shown in the results for
  CPAN15Eval, seems not to be the primary challenge"*. Their compressor/dissimilarity sweep found
  **PPMd** the best compressor and **CBC** the best measure across all corpora; **Zip was at least
  twice as fast as PPMd**. Threshold θ is set from a training corpus of equal true/false authorship
  problems, at the **EER** (equal error rate).
  → Their "short" documents are **2–3 KByte**, i.e. **~2,000–3,000 characters ≈ 700–1,500 words**.
  That is 20–50× a chat message.
- **PAN 2023 overview** (Stamatatos et al.):
  [downloads.webis.de](https://downloads.webis.de/pan/publications/papers/stamatatos_2023.pdf) —
  the **`compressor` baseline scored AUROC 0.506 and c@1 0.051**. A c@1 of 0.051 against a balanced
  two-class problem (chance = 0.50 accuracy, and abstention scoring in c@1 does not rescue it) means
  the compression baseline was **effectively always wrong** on that dataset's short, cross-discourse
  pairs. This is the single most damning number in this document for compression at short length.

**(e) Verdict.** **NCD / gzip-based distance is noise at 2–3 sentence chat length.** There is a formal
reason (the concatenation must comfortably fit the compressor window; gzip's own header/stream
overhead is ~18 bytes, non-trivial against a 60-byte message) and an empirical reason (PAN 2023
compressor baseline c@1 = 0.051). **Do not include a per-message compression distance in the app's
fidelity score.** At bundle level it becomes usable only once bundles reach roughly the **2 KByte per
document** scale that Halvani et al. actually tested — and even then it underperformed
feature-based methods.

---

## 7. Author-verification framing: ROC-AUC, c@1, F1, thresholds, impostors, unmasking

This section is the **evaluation scaffold** for every other metric: it tells you how to turn a
continuous fidelity score into an interpretable verdict, and how to calibrate it from held-out data.

### 7.1 The PAN protocol and its metrics

**(a) Definitions.** Given a pair `(known-author text, questioned text)`, a system outputs a scalar
`s ∈ [0, 1]` = the probability that the pair is same-author. **`s = 0.5` exactly means "abstain /
unanswerable."**

- **AUROC** — area under the ROC curve over all thresholds.
- **c@1** (Peñas & Rodrigo 2011): `c@1 = (1/n) * ( n_ac + n_ac * n_u / n )`, where `n` = number of
  questions, `n_ac` = number answered correctly, `n_u` = number left unanswered. Properties verified
  from the paper: a system answering everything gets plain accuracy; unanswered questions "add value
  … as if they were answered with the accuracy already shown"; a system answering nothing scores 0.
- **F1** — standard F1, ignoring unanswered cases.
- **F0.5u** — F0.5-based, highlights correctly answered same-author instances and rewards abstention.
- **Brier** — complement of the Brier loss, i.e. rewards confident correct predictions and penalises
  `s = 0.5` abstentions. Takes values in [0,1] with higher = better.
- PAN 2023's **overall score = the average of AUROC, c@1, F1, F0.5 and Brier.**

**(b) Who / when.**
- c@1: Anselmo Peñas and Álvaro Rodrigo (2011), *"A Simple Measure to Assess Non-response"*,
  **ACL-HLT 2011**, [aclanthology.org/P11-1142.pdf](https://aclanthology.org/P11-1142.pdf).
- PAN 2023 overview: Efstathios Stamatatos et al., *"Overview of the Authorship Verification Task at
  PAN 2023"*,
  [downloads.webis.de/pan/publications/papers/stamatatos_2023.pdf](https://downloads.webis.de/pan/publications/papers/stamatatos_2023.pdf).
- F0.5u: proposed by Bevendorff et al. (PAN 2022/2023 line), cited in the PAN 2023 overview.
  `UNVERIFIED` for the exact originating paper.

**(c) Reference implementation.** `bnagy/bdi` (Python) exposes `accuracy`, `auc`, `c_at_1`,
`pan_metrics`, plus a `ScoreShifter` that optimises scores for `AUC × c@1`:
[github.com/bnagy/bdi](https://github.com/bnagy/bdi). Also `fatihbozdag/bitig` (Python) exposes
`compute_pan_report` → AUC + c@1 + F0.5u + Brier + ECE + C_llr, alongside General Impostors and
Unmasking implementations: [github.com/fatihbozdag/bitig](https://github.com/fatihbozdag/bitig).
`sklearn.metrics.roc_auc_score` / `f1_score` / `brier_score_loss` cover the rest.

**(d) Reported behaviour — the sobering baseline.** PAN 2023 (cross-discourse-type pairs, perfectly
balanced same/different):

| System | AUROC | c@1 | F1 | F0.5 | Brier | Overall |
|---|---|---|---|---|---|---|
| Best (Ibrahim et al., reduced-graph) | **0.616** | **0.572** | 0.617 | 0.562 | 0.746 | 0.623 |
| Guo et al. | 0.581 | 0.557 | 0.621 | 0.571 | 0.742 | 0.614 |
| `najafi22` baseline (T5 + CNN + attention) | 0.601 | 0.569 | 0.466 | 0.543 | 0.595 | 0.555 |
| `cngdist` baseline (char-4-gram + cosine) | 0.516 | 0.499 | 0.666 | 0.555 | 0.741 | 0.595 |
| `galicia22` baseline | 0.504 | 0.502 | 0.650 | 0.552 | 0.740 | 0.589 |
| **`compressor` baseline** | 0.506 | **0.051** | 0.626 | 0.076 | 0.750 | 0.402 |

**Read this table as the realistic envelope.** Even the best 2023 system is at AUROC 0.616 on
cross-discourse short-ish pairs. Any fidelity metric the app ships must be **calibrated in-domain**
on this specific author's data, and its headline number should be reported as **c@1 or AUROC with a
stated abstention rate**, never as raw accuracy.

### 7.2 Setting a same-author / different-author threshold from held-out data

Three concrete, citable protocols:

1. **EER threshold from a training corpus of balanced problems** (Halvani et al. 2017, verified):
   *"Our strategy to define θ requires a training corpus consisting of n problems equally distributed
   regarding true (Y) and false (N) authorships. Given the chosen measure, we compute for each problem
   ρ in this corpus a dissimilarity score s_ρ. Then, we determine θ based on the **EER (equal error
   rate)**, i.e. we select the threshold where the false acceptance rate and the false rejection rate
   are equal."*
2. **Precision-targeted thresholds** (Koppel & Winter 2014, verified numbers — see §7.3): for their
   Blogs impostor universe, *"recall at precision=0.9 is 82.5% for the class same-author and 66.0% for
   the class different-author. The score threshold σ* for which we obtain precision of 0.9 for
   same-author is **0.13**; for diff-author we obtain precision=0.9 with score threshold of **0.01**.
   As a practical matter, this means that — assuming a prior probability of 0.5 that X and Y are by the
   same author — a score **above 0.12** indicates that the chance that X and Y are by different authors
   is less than 10% and a score **below 0.02** indicates that the chance that X and Y are by the same
   author is [less than 10%]."* That two-sided dead zone (0.02 … 0.12) is exactly the abstention band
   the app should display as "uncertain", mirroring PAN's `s = 0.5`.
3. **Threshold + margin with abstention** (PAN-style, verified from the graph-based Siamese paper,
   DOI [10.3390/math10020277](https://doi.org/10.3390/math10020277)): map a raw score `out_o` through
   a threshold `th` and margin `m`, sending `[th - m, th + m]` to exactly 0.5. Their grid search over
   `th ∈ [0.05, 0.95]` and `m ∈ [0, 0.25]` in steps of 0.05 improved the average PAN metric from
   **89.04** (th = 0.50, m = 0.00) to **90.24** (th = 0.50, m = 0.20) on the "med graph" configuration.
   The gain came entirely from routing hard cases to 0.5 — i.e. from abstaining.

**Recommendation.** For the app: build a **held-out problem set** from the 104k real messages by
splitting into disjoint bundles — positives = two disjoint bundles from the author; negatives = one
bundle from the author vs one bundle from an impostor pool (other contacts, or public corpora). Tune
the threshold at EER, then widen a symmetric abstention margin until the false-positive rate at the
"same author" operating point is acceptable. Report c@1 and AUROC with the abstention rate.

### 7.3 The impostor method (can it be repurposed as a fidelity score? — yes)

**(a) Definition** (verified, Koppel & Winter 2014, verbatim):
> 1. Generate a set of impostors `Y_1, …, Y_m`.
> 2. Compute `score_X(Y)` = the number of choices of feature sets (out of **100**) for which
>    `sim(X, Y) > sim(X, Y_i)` for all `i = 1, …, m`.
> 3. Repeat the above with impostors `X_1, …, X_m` and compute `score_Y(X)` analogously.
> 4. If `average(score_X(Y), score_Y(X))` is greater than a threshold `σ*`, assign `<X, Y>` to
>    same-author.

The score is a **fraction of random feature subsets in which the suspect wins a police lineup** — a
number in [0, 1] with a direct intuitive reading. That is exactly the shape a "style fidelity score"
should have.

**(b) Who / when.** Moshe Koppel and Yaron Winter (2014), *"Determining if two documents are written by
the same author"*, **Journal of the American Society for Information Science and Technology
(JASIST)**, DOI [10.1002/asi.22954](https://doi.org/10.1002/asi.22954); author PDF
[u.cs.biu.ac.il](https://u.cs.biu.ac.il/~koppel/papers/impostors-journal-revised2-140213.pdf).
The underlying feature-subsampling similarity is from Koppel, Schler et al. (2011).

**(c) Reference implementation.** `bnagy/bdi` (Python) — Bootstrap Distance Imposters, an update to
General Imposters with Potha & Stamatatos improvements. API verified from the README:
`BDIVerifier(metric="manhattan"|"euclidean"|"minmax"|"cng"|"cosine"|"nini", method="ranked"|"random"|"closest", nb_bootstrap_iter=100, rnd_prop=0.35, balance=False)`.
[github.com/bnagy/bdi](https://github.com/bnagy/bdi). Also `bitig.forensic.GeneralImpostors`
([github.com/fatihbozdag/bitig](https://github.com/fatihbozdag/bitig)).

**(d) Reported behaviour on SHORT texts — verified and encouraging.**
- The paper's own framing: *"We will see that when executed correctly, this method gives surprisingly
  strong results for the verification problem, **even when the documents in question contain no more
  than 500 words**."*
- **87.4% accuracy** with the Blogs impostor universe (a same-genre background set).
- Impostor-selection insight: *"when we choose impostors that are more similar to Y either in terms of
  genre (Blogs) or content (On-the-fly), **fewer impostors are required** to achieve the same or better
  accuracy than just choosing random impostors"*; perversely, *"For all impostor universes, the greater
  the number of impostors, the **more false negatives** and the **fewer false positives**."*
- 500 words ≈ 30–50 chat messages. So the impostor method is **bundle-level for chat**, not
  message-level.

**(e) Verdict.** **The single best "fidelity score" shape available at bundle level in [0,1]**, and its
500-word operating point is reachable by bundling ~50 real WeChat messages. Caveat: it needs a
background impostor set, which a local-first single-user app can supply from **other contacts'**
messages already in the local database (this is a privacy-clean, on-device resource) — and per the
paper, genre-similar impostors (other WeChat contacts) reduce the number needed.

### 7.4 Unmasking (Koppel–Schler) and its generalization to short texts

**(a) Definition** (verified, Koppel, Schler, Argamon 2004, verbatim-ish):
> We choose as an initial feature set the **250 words** with highest average frequency in `AX` and `X`
> (the average of the frequency in `AX` and the frequency in `X`, giving equal weight to `AX` and `X`).
> Using an **SVM with linear kernel** we run the following unmasking scheme:
> 1. Determine the accuracy results of a **ten-fold cross-validation** experiment for `AX` against `X`.
> 2. For the model obtained in each fold, eliminate the **3 most strongly-weighted positive features**
>    and the **3 most strongly-weighted negative features**.
> 3. Go to step 1.

This produces a **degradation curve** per pair. Curve-derived features used for meta-learning:
accuracy after `i` elimination rounds, accuracy difference between round `i` and `i+1`, between `i` and
`i+2`, the `i`-th highest accuracy drop in one iteration, and in two iterations.

**(b) Who / when.** Moshe Koppel, Jonathan Schler, Shlomo Argamon (2004), *"Authorship verification as
a one-class classification problem"*, **ICML 2004**, DOI
[10.1145/1015330.1015448](https://doi.org/10.1145/1015330.1015448); PDF
[icml.cc](https://icml.cc/Conferences/2004/proceedings/papers/415.pdf).

**(c) Reference implementation.** `bitig.forensic.Unmasking`
([github.com/fatihbozdag/bitig](https://github.com/fatihbozdag/bitig)). The PAN 2022/2023 short-text
unmasking variant is referenced as a baseline in the graph-Siamese paper.

**(d) Reported behaviour — and the hard length floor.**
- Koppel et al. 2004's qualitative separation rule, verified: *"for **all 13 distinct same-author
  curves**, it holds that: accuracy after 6 elimination rounds is lower than **89%** and the second
  highest accuracy drop in two iterations is greater than **16%**. These two conditions hold for only
  **5 of the 189 different-author curves**."* Note the corpus: 189 different-author vs 13 distinct
  same-author curves — **13 positives**, an extremely thin validation set. Do not over-read the
  precision of these thresholds.
- **The length floor, stated by the authors of the generalization:** unmasking "hinges on the
  availability of sufficiently many chunks per text, where each chunk has to be of at least the
  aforementioned **500 words** length, or else the training data becomes too sparse and no descriptive
  curves can be generated."
- **Generalized version** (Bevendorff, Stein, Hagen, Potthast 2019, *"Generalizing Unmasking for Short
  Texts"*, **NAACL-HLT 2019, pp. 654–659**, DOI
  [10.18653/v1/n19-1068](https://doi.org/10.18653/v1/n19-1068); PDF
  [aclanthology.org/N19-1068.pdf](https://aclanthology.org/N19-1068.pdf)). Verified algorithm:
  > 1. From either text, create **30 chunks counting 700 words each** by random chunk generation
  >    (bootstrap word oversampling — words drawn without replacement to fill a chunk, pool replenished
  >    when exhausted, guaranteeing each word is drawn at least once).
  > 2. Use the **250 words** with highest average frequency in A and B as features.
  > 3. Obtain **10-fold cross-validation accuracy** between A and B with a **linear SVM** kernel.
  > 4. Eliminate the on average **5 most significant positive and negative features across folds**
  >    (**10 removals** total).
  > 5. Go to Step 3 if there are still features left.
  > Then a linear SVM is trained on the curves, their central-difference gradients (1st and 2nd order),
  > and their gradients sorted by magnitude.
  - Results: works on texts *"as short as **four printed pages**"*; accuracy **75–80%**, *"on par with
    other state-of-the-art verifiers"*; precision can be driven to **1.0** by raising the confidence
    threshold — at `c = 0.8` only **13.8%** of cases are answerable but *"all same-author
    classifications are correct"*; `c = 0.4` answers about half the cases with "a still all correct
    answer set". Recommendation: **`c >= 0.7` if false positives must be entirely avoided.**
  - Their framing of the floor: PAN 2015 texts had *"an average size of about 1.5 kB (less than 400
    words), so it does not come as a surprise that **none of the participants employed unmasking**."*

**(e) Verdict.** Unmasking is a **document-level** method whose floor — even after generalization — is
**four printed pages (≈1.5–2.5 kB, ~700–1,500 words) for the *questioned* text**, and whose chunking
step needs 30 × 700 = 21,000 words of material *per side*. **A 2–3 sentence generation (10–60 tokens)
cannot be unmasked, full stop.** It is only applicable if the app scores a **bundle of generated
messages** (≥ ~1,000 words ≈ 60–100 messages) against a bundle of the author's real messages. The one
genuinely reusable idea at short length is the **precision-first confidence threshold with explicit
abstention**: at `c >= 0.7`, nearly all returned verdicts are correct — which is the right operating
posture for a "does this sound like me?" feature.

---

## 8. MAUVE (Pillutla et al. 2021)

**(a) Definition.** MAUVE measures the gap between two *distributions* of text, `P` (human) and `Q`
(model), in a **quantised embedding space**, as the **area under the divergence curve**:

1. Embed every sample from both pools with a foundation model `M` — in the paper, the **terminal
   hidden state of GPT-2 large**. (`mauve-text` default `featurize_model_name='gpt2-large'`, choice of
   `gpt2` / `gpt2-medium` / `gpt2-large` / `gpt2-xl`.)
2. Quantise the joint embedding set. Default `MAUVE-k-means`: run PCA keeping **90% of explained
   variance**, normalise each datapoint to unit L2 norm, run k-means with FAISS (max 500 iterations,
   5 repetitions, best objective value kept). Default number of clusters **`k = 500`**, and the
   library's default `num_buckets` is **`0.1 *` the number of samples**.
3. Form the quantised distributions `P̃`, `Q̃` by counting cluster memberships.
4. Build the divergence curve
   `C(P,Q) = { ( exp(-c·KL(Q‖R)), exp(-c·KL(P‖R)) ) : R = λP + (1-λ)Q, λ ∈ Λ }`
   with `Λ = {1/n, 2/n, …, (n-1)/n}` and default scaling constant **`c = 5`**.
5. `MAUVE` = area under `Ĉ(P̃, Q̃)` by numerical quadrature. Range **[0, 1]**, higher = closer.
   `frontier_integral` = the complementary quantity; **lower** = closer.

`mauve_star` / `frontier_integral_star` are the versions computed with **Krichevsky–Trofimov
smoothing**, recommended in the JMLR 2023 companion.

**(b) Who / when.** Krishna Pillutla, Swabha Swayamdipta, Rowan Zellers, John Thickstun, Sean Welleck,
Yejin Choi, Zaid Harchaoui (2021), *"MAUVE: Measuring the Gap Between Neural Text and Human Text using
Divergence Frontiers"*, **NeurIPS 2021 (Outstanding Paper Award)**, arXiv
[2102.01454](https://arxiv.org/abs/2102.01454). Theory companion: Lang Liu, Krishna Pillutla, Sean
Welleck, Sewoong Oh, Yejin Choi, Zaid Harchaoui (2021), *"Divergence Frontiers for Generative Models:
Sample Complexity, Quantization Effects, and Frontier Integrals"*, NeurIPS 2021; extended in JMLR 2023.

**(c) Reference implementation.** `mauve-text` on PyPI (`pip install mauve-text`),
[github.com/krishnap25/mauve](https://github.com/krishnap25/mauve). Requires `torch>=1.1.0` and
`transformers>=3.2.0`. API: `mauve.compute_mauve(p_text=..., q_text=..., device_id=0, max_text_length=256)`;
returns `.mauve`, `.frontier_integral`, `.mauve_star`, `.frontier_integral_star`, `.divergence_curve`,
`.p_hist`, `.q_hist`. Sample-size / quantisation tradeoff experiment harness:
[github.com/john-hewitt/ts-mauve-experiments](https://github.com/john-hewitt/ts-mauve-experiments).

**(d) Reported behaviour on short text / sample size — verified, and disqualifying for per-message use.**
- *"MAUVE computes the similarity between two **distributions**. Therefore, each distribution must
  contain **at least a few thousand samples** (we use **5000** each). MAUVE with a smaller number of
  samples is **biased towards optimism** (that is, MAUVE typically goes **down** as the number of
  samples increase) and exhibits a **larger standard deviation** between runs."*
- Quantisation limits: *"Too few clusters makes the distributions seem closer than they actually are
  while too many clusters leads to many empty clusters (which makes all distributions seem equally far
  away)."* Concretely: *"If k is too small (k < 100), all methods are scored close to 1. If k is too
  large (k > 2000), all methods are scored close to 0."*
- MAUVE is explicitly for **relative** comparison: *"We find that MAUVE is best suited for relative
  comparisons while the absolute MAUVE score is less meaningful."* The scaling constant `c` is
  order-preserving, so "the choice of the scaling constant affects the numerical value of MAUVE but
  leaves the relative ordering between different models unchanged."
- Sensitivity: *"We observed that it is quite easy to capture basic errors with MAUVE but much harder
  to quantify subtle errors."*
- The paper's own headline validation is open-ended generation: web text and story domains.

**(e) Verdict for 2–3 sentence chat turns.**
- **Never a per-message score.** MAUVE is undefined for a single text; it is a distance between pools.
- **Pool-level use is feasible for this app** in one specific framing: `P` = a random sample of the
  author's *real* messages (the corpus has 104,000 — vastly more than the 5,000 per side the paper
  uses), `Q` = a sample of the clone's generations. This yields a single "how far is the clone's
  distribution from the author's distribution" number, and it is legitimate for **A/B comparison
  between two clone checkpoints or two prompt configurations**, which is the decision the app actually
  needs to make. Absolute thresholds should not be shown to the user.
- **`UNVERIFIED`: I found no paper that validates MAUVE specifically on short chat turns / dialogue
  turns.** The library's own docs are silent on short-turn behaviour, and there is a structural reason
  for concern that is *not* verified empirically: MAUVE featurises each generation as the GPT-2 large
  **terminal hidden state**, so a 20-token Chinese/English code-mixed message produces an embedding
  built from very few tokens and from a tokenizer that fragments CJK; whether those embeddings retain
  authorial signal at that length is untested. **Treat pool-level MAUVE on short code-mixed chat as an
  untested adaptation and validate it in-house** (e.g. check that MAUVE ranks a deliberately
  style-broken clone below an intact one) before trusting it.

---

## 9. BERTScore (Zhang et al. 2020)

**(a) Definition.** Given reference `x = ⟨x_1, …, x_k⟩` and candidate `x̂ = ⟨x̂_1, …, x̂_l⟩`:

```
sim(x_i, x̂_j) = (x_i^T x̂_j) / ( ||x_i|| ||x̂_j|| )        contextual embeddings, pre-normalised -> inner product
R_BERT = (1/k) * SUM_{i=1..k} max_j sim(x_i, x̂_j)          greedy matching, recall
P_BERT = (1/l) * SUM_{j=1..l} max_i sim(x_i, x̂_j)          greedy matching, precision
F_BERT = 2 * P_BERT * R_BERT / (P_BERT + R_BERT)
```

Optional IDF weighting of the token similarities. Verified verbatim from the paper
([arXiv:1904.09675](https://arxiv.org/abs/1904.09675), HTML
[ar5iv](https://ar5iv.labs.arxiv.org/html/1904.09675)).

**(b) Who / when.** Tianyi Zhang, Varsha Kishore, Felix Wu, Kilian Q. Weinberger, Yoav Artzi (2020),
*"BERTScore: Evaluating Text Generation with BERT"*, **ICLR 2020**
([iclr.cc poster](https://iclr.cc/virtual/2020/poster/1738)), arXiv
[1904.09675](https://arxiv.org/abs/1904.09675).

**(c) Reference implementation.** `bert-score` on PyPI (`pip install bert-score`;
`bert_score.score(cands, refs, lang="en")`), [github.com/Tiiiger/bert_score](https://github.com/Tiiiger/bert_score).
Recommended config from the paper: **`F_BERT` with 24-layer `RoBERTa_large`** for English;
`BERT_multi` for non-English (noted as less stable on low-resource languages).

**(d) Documented reasons it is a semantic, not stylistic, metric.**
1. **By design.** The paper's opening framing: *"Automatic evaluation of natural language generation …
   requires comparing candidate sentences to annotated references. **The goal is to evaluate semantic
   equivalence.**"* BERTScore's stated purpose is to fix *n*-gram metrics' failure to *"account for
   meaning-preserving lexical and compositional diversity"* — i.e. it deliberately **discounts surface
   form**, which is precisely what a style metric must measure.
2. **Style sensitivity in the wrong direction — the key critique.**
   *"A Fine-Grained Analysis of BERTScore"*, WMT21,
   [statmt.org/wmt21/pdf/2021.wmt-1.59.pdf](https://statmt.org/wmt21/pdf/2021.wmt-1.59.pdf). Verified
   findings, quoted:
   - *"while BERTScore can detect when a candidate differs from a reference in important content words,
     it is **less sensitive to smaller errors, especially if the candidate is lexically or
     stylistically similar to the reference**."*
   - *"in the hard problem setting, where the bad candidate has high lexical overlap with and was
     **stylistically similar to the reference**, BERTScore struggled."*
   - *"Due to this **style sensitivity**, BERTScore may be better-suited to scoring candidates from
     widely-differing systems, as opposed to closely-related systems, or multiple candidates from one
     system."*
   - Even stronger: *"The mean BERTScore assigned to even examples containing [errors] is much higher
     than the mean BERTScore assigned to PE↔reference pairs … we suggest that this occurs due to
     **sensitivity to style**."*
   → **BERTScore rewards stylistic similarity even when the content is wrong, and it failed in the hard
   setting at or below chance in every error category.** For a *rewards-generic-text* critique this is
   the closest documented analogue: BERTScore can be fooled by surface resemblance, and it is *not*
   calibrated to any particular author — it has no notion of "this author specifically."
3. **Used as a content metric, not a style metric, in the style-transfer literature.**
   - *"Evaluating Text Style Transfer Evaluation: Are There Any Reliable Metrics?"*, NAACL 2025 SRW,
     [aclanthology.org/2025.naacl-srw.41.pdf](https://aclanthology.org/2025.naacl-srw.41.pdf):
     BERTScore is placed in the **content-preservation** category (*"all of which assess content
     similarity based on contextualized vector representations"*), while a **separate style-transfer
     accuracy** category holds EMD, KL divergence, cosine similarity, JS divergence and classifier
     confidence. Content-preservation correlations with human judgement for BERTScore: 0.50 / 0.31 /
     0.26 (English sentiment transfer), 0.45 / 0.33 / 0.27 (Hindi), 0.49 / 0.44 / 0.36 (Bengali),
     0.21 / 0.19 / 0.15 and 0.62 / 0.38 / 0.31 for the other two task/language blocks. **BERTScore is
     never used as a style metric in this survey.**
   - *"A Study on Manual and Automatic Evaluation for Text Style Transfer: The Case of
     Detoxification"*, HumEval 2022,
     [aclanthology.org/2022.humeval-1.8.pdf](https://p.rst.im/q/aclanthology.org/2022.humeval-1.8.pdf):
     *"The traditional MT evaluation metrics mainly check the semantic similarity, which makes them
     **unsuitable for style transfer**."* At system level BERTScore had the best correlation with human
     judgements, but correlations remain weak and the authors stress manual evaluation is still
     required.

**(e) Verdict.** **BERTScore is not a style-fidelity metric.** It is a *content* metric that happens to
be partly style-sensitive (which makes it unreliable even as a content metric for text that is
supposed to share the author's style). Its one genuine advantage for this app is that it is **defined
on a single short sentence pair**, so it works at chat length — making it a good control variable
("the clone said the right thing") to be reported **alongside** a style metric and never as the style
score itself. The Chinese/English code-mixing caveat: `F_BERT` with an English-only model on
code-mixed text is untested here (`UNVERIFIED`).

---

## 10. Perplexity under a per-author LM: cross-entropy, BPC, "authorial perplexity"

This is the metric family with the strongest published evidence **at exactly this app's length regime**.

### 10.1 Definitions

For a causal (autoregressive) LM `M` over a token sequence `T = (x_1, …, x_t)`:

```
PPL(M, T)  = exp{ -(1/t) * SUM_{i=1..t} log p_M( x_i | x_1..x_{i-1} ) }
           = exp{ CE(Logits, T) }
```

i.e. *"perplexity is the exponentiated mean negative log likelihood of tokens in the sequence, which
represents the average predictability of tokens in the sequence. In practice, we calculate perplexity
as the cross entropy between the true token and the predicted logits, namely `exp{CrossEntropy(Logits, T)}`"*
(verified verbatim from the ALMs paper). Implementation: `torch.nn.CrossEntropyLoss` then `exp`.

**Bits per character (BPC):** the same quantity with log base 2 and normalised by characters instead of
tokens: `BPC = -(1/|c|) * SUM_k log2 p(c_k | c_1..c_{k-1})`. Useful for a CJK/Latin code-mixed corpus
because token counts are tokeniser-dependent while character counts are not.
**`UNVERIFIED`:** I did not open a paper that uses BPC specifically for *authorial* attribution; BPC is
standard in the language-modelling literature, and the mapping from PPL is definitional
(`PPL = 2^BPC` when the base is consistent).

### 10.2 Authorial Language Models (ALMs) — the key paper

**(b) Who / when.** Weihang Huang and colleagues:
- Preprint: *"ALMs: Authorial Language Models for Authorship Attribution"*, arXiv
  [2401.12005v2](https://arxiv.org/pdf/2401.12005v2.pdf), 2024. **Full author list `UNVERIFIED`** (I
  read the PDF text, not the byline blocks).
- Journal version: *"Attributing authorship via the perplexity of authorial language models"*,
  **PLOS One**, published 2025-07-03, DOI
  [10.1371/journal.pone.0327081](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0327081).
- Code: [github.com/Weihang-Huang/ALMs](https://github.com/Weihang-Huang/ALMs).

**Method, verified.** Stage 1: fine-tune one base LM (GPT-2 base, 100 epochs, single Nvidia A100) on
each candidate author's known writings → one **Authorial Language Model** per author. Stage 2: for a
questioned document `Q`, tokenise with the GPT-2 BPE tokeniser, run each ALM, compute
`PPL(M_i, Q)`, and **assign Q to the author with the lowest perplexity**. Also supports **per-token
decomposition** of the perplexity, so the specific words driving an attribution are inspectable.

**(d) Reported behaviour — including the direct short-text ablation.**
- Benchmarks: macro-average accuracy **83.6% on Blogs50** (outperforming all other methods) and
  **74.9% on CCAT50** (matching the best).
- **Text ablation (the number that matters here):** *"to reach a macro-average accuracy of **70%**,
  ALMs needs **40 tokens on Blogs50** and 400 tokens on CCAT50, while to reach **60%** ALMs requires
  **20 tokens on Blogs50** and 70 tokens on CCAT50."*
  → **40 tokens against 50 candidate authors ≈ 2–4 short chat messages.** This is the only published
  result I found that directly validates a style metric at the app's target length. Note the variance
  across corpora is large (40 vs 400 tokens for the same 70% accuracy), so the Blogs50 figure is the
  optimistic end — informal, blog-like text, which is much closer to WeChat than CCAT50 newswire.
- Why ALMs work, per the authors: *"Compared to standard type-based methods in stylometry, which are
  based on the relative frequencies of common words, n-grams, and other types, perplexity-based
  methods are capable of capturing authorial information for **each word token** … thereby offering
  greater flexibility and finer granularity."*
- **A finding that overturns classic stylometry's core assumption:** the PLOS One version reports that
  *"**content words classes are characterized by a higher density of authorship information than
  function word classes**, challenging a long-standing assumption of stylometry."* The classic Delta
  tradition is built on function words precisely because they are supposed to be topic-independent. If
  ALMs' finding generalizes, then for a *neural* per-author LM the lexical content is informative too —
  which matters for a chat clone, because WeChat messages are extremely topic-diverse and a
  function-word-only view discards most of the signal.
- Context on the preceding line of work (verified from the ALMs paper's own related-work text):
  *"Although previous research has had relatively little success using LLM predictability metrics for
  human authorship attribution, this approach currently underlies state-of-the-art methods for LLM
  detection."* The cited detection methods are **GLTR** (Gehrmann, Strobelt, Rush 2019) and
  **GPTZero** (Tian et al. 2023) — both **secondary citations**, not opened. The detection result they
  summarise: *"causal language model perplexity has been found to be an effective indicator of
  authorship, where LLM-authored texts tend to be associated with relatively low perplexity scores in
  comparison to human-authored texts"* — note this is a **human-vs-machine** result, not a
  per-person result, and it is a *different task* from style fidelity. Do not conflate the two.

**"GPT-2 knows your author" / "Do LLMs capture author style?"** — I could **not** locate papers with
those exact titles. **`UNVERIFIED`.** The real line of work is: ALMs (above), GLTR / GPTZero for the
detection task, and the fine-grained-BERTScore / text-style-transfer evaluation literature for the
metric-critique side.

**(c) Reference implementation.** No packaged per-author-PPL library. The recipe is ~20 lines of
PyTorch: load GPT-2, call `transformers` `GPT2LMHeadModel`, compute
`torch.nn.CrossEntropyLoss()(logits[..., :-1, :].transpose(1, 2), input_ids[..., 1:])`, `exp` it.
The ALMs repo provides the fine-tuning scripts. For a purely conventional n-gram LM alternative,
`kenlm` / `nltk.lm` are the standard tools — **`UNVERIFIED`** that either is used in a published
per-author attribution comparison at short length (Peng et al. 2003 is cited as reaching >90% accuracy
with n-gram LMs, but that is a **secondary citation** and the Yale thesis that cites it reports their
own n-gram LM *"failed to outperform the previous results due to the problem of data sparsity"*).

**(e) Verdict.** **Per-author LM perplexity is the single most suitable metric for 2–3 sentence chat
messages**, on four independent grounds:
1. It is **length-normalised** — the mean negative log-likelihood per token — so it is *defined* on a
   20-token message, unlike every distribution-distance metric in this document.
2. There is **direct published evidence at 40 tokens** (70% macro-accuracy over 50 authors, Blogs50).
3. The author's own **104,000 messages** are an unusually large fine-tuning corpus for a single author;
   the ALMs paper fine-tuned on **Blogs50**, whose authors have far less data.
4. It is **inspectable**: the per-token decomposition lets the app show *which words* the model found
   uncharacteristic, which is the single most useful feature for a user trying to tune a clone.

**Caveats to state in the app's methodology note:**
- Perplexity is **tokeniser-relative**: values are not comparable across models or tokenisers. For a
  code-mixed corpus, a CJK-aware tokeniser matters, and BPC is the more portable report.
- Perplexity is **not calibrated** — a raw PPL of 34 is meaningless alone. Always report it as a
  **difference or ratio between the author's ALM and a baseline ALM** (e.g. the generic base model, or
  a second person's ALM), or as a **percentile against the author's own held-out messages**. The
  literature reports it as an *argmin* over candidate models, not as an absolute score.
- **`UNVERIFIED`:** the *variance* of per-author perplexity at 20–40 tokens. No opened paper reports a
  confidence interval for a single short message. Before shipping a per-message threshold, measure the
  empirical distribution of `PPL(ALM_author, real_message)` and `PPL(ALM_author, other_person_message)`
  on your own data.

---

## 11. Human A/B preference / forced-choice style similarity

### 11.1 How the literature actually runs it

The standard design is a **forced-choice, multi-way ranking task with no abstention option**, sometimes
with a Turing-test framing.

- *"Authorship identification of documents with high content similarity"*, **Scientometrics (2018)**,
  DOI [10.1007/s11192-018-2661-6](https://doi.org/10.1007/s11192-018-2661-6)
  (PDF: [link.springer.com](https://link.springer.com/content/pdf/10.1007/s11192-018-2661-6.pdf)).
  Design, verified: one **source** snippet + **four target** snippets (in Experiment 1, one same-author
  and three different-author), annotators **force-ranked** the targets by writing-style similarity with
  *"options like 'not able to find'"* removed. Three experiments per annotator; Experiments 2 and 3
  varied the composition (same-journal confounds; all-different targets while still claiming one was
  the same author, to detect random responding). Crowd setup: **56 annotators from 29 countries** on
  CrowdFlower, **minimum 20 s per annotation** to discourage random choices; a separate qualitative
  study with **4 author-annotators**, half the items enriched with an extracted feature list.
  **Results, verified:** *"At first glance, the annotators have a **small agreement** in the ranking…
  a full agreement is achieved in **26 targets**, **160** have an agreement of two annotators, and
  **78** of the targets have **no agreement at all**."* Krippendorff's alpha ≈ **0.250**, and 500,000
  random-simulation rounds gave mean alpha **0.250** (variance 0.020) with **28% of random rounds
  showing larger agreement** — so the authors can only claim *"with a confidence of **72%** that the
  annotators … did not rank in a random manner."* Random-selection precision = **25%** (4-way).
  Qualitative annotators: *"a slight improvement in the case the evaluators use the extracted
  features, but it isn't clear if this effect is a result of the additional information presented."*
  Their conclusion: *"this task turns out to be **very challenging**."*
- *"Bot or not: Can people tell the difference between stories written by a human or by an AI
  system?"*, preprint DOI [10.31234/osf.io/jkh6p_v2](https://doi.org/10.31234/osf.io/jkh6p_v2).
  Study 2: **N = 424** Prolific adults, each read **both** a human-written and a ChatGPT-written short
  story and guessed which was which (forced choice, binary). **Verified result: 167 of 424 = 39.4%
  correct, significantly *below* 50% (p < .001).** Question phrasing made no difference
  (37.9% vs 40.8%, χ²(1) = 0.38, p = .54). **AI expertise positively predicted correct responses
  (β = .18, p < .001); fictional-literature expertise did not (β = −.006, p = .87).** Authors'
  conclusion: *"Participants struggled to correctly differentiate human-written and AI-generated
  stories."* (Study 1, N = 1,498, manipulated *beliefs* rather than measuring discrimination.)

### 11.2 Reported human accuracy for authorship discrimination — summary

| Study | Task | N annotators | Human accuracy | Chance |
|---|---|---|---|---|
| Scientometrics 2018 | 4-way forced ranking, high-content-similarity snippets | 56 crowd + 4 expert | **at/near chance**; α ≈ 0.250 = random-simulation mean; only 72% confidence of non-randomness | 25% |
| Bot or not (Study 2) | binary forced choice, human vs ChatGPT short story | 424 | **39.4%** (below chance, p < .001) | 50% |

### 11.3 Verdict and what this means for the app

- **Naive human judges are at or below chance on authorship-origin forced choice**, even with hundreds
  of annotators. Human A/B preference is therefore a **weak instrument**, and it is *not* a ground
  truth that an automatic metric should be validated against unless the annotators are given
  substantial adaptation and feedback.
- **`UNVERIFIED`: I found no forced-choice human study on 2–3 sentence *chat* messages with a reported
  accuracy.** The closest chat-adjacent evidence is the Scientometrics study (short snippets, high
  content similarity) and the Bot-or-not story study; neither is chat.
- **The one human judge who is *not* naive about the target author is the app's own user.** The
  realistic design is a **self-judged paired forced choice**: show two candidate replies (or a real
  reply and a generated reply, position-randomised) for the same incoming message, and ask
  "which one is me?" — with an explicit **third option, "can't tell"**, because that is what makes the
  measurement usable: PAN's `s = 0.5` abstention is precisely the mechanism that rescued their metric
  scores (the graph-Siamese grid search gained +1.2 points purely by routing hard cases to 0.5), and
  **c@1 exists to score exactly this** (§7.1). Report the user's accuracy, the abstention rate, and
  **c@1**, not raw accuracy.
- Guard against the Scientometrics finding: **control for content**. If the two candidates for the same
  incoming message differ in *what they say*, the judge will rank topic, not style. Use a design where
  the semantic content is held fixed (e.g. two candidate phrasings of the same reply) or where
  content is deliberately matched, exactly as that paper's Experiment 2 tried to do with
  same-journal targets.

---

## 12. Consolidated recommendation for this app

Ordered by suitability at 2–3 sentence chat length. Full evidence in the section shown.

### Tier 1 — per-message, defensible

1. **Per-author LM perplexity / cross-entropy / BPC** (§10). Length-normalised, defined on a 20-token
   message, direct published evidence at 40 tokens (70% macro-accuracy over 50 authors). Report as a
   **ratio to a baseline LM** or a **percentile against the author's own held-out messages**, plus the
   **per-token decomposition**. Provide BPC alongside PPL for the code-mixed corpus.
2. **Punctuation / casing / emoji-family rate deltas** (§5). Defined on a single message; punctuation
   n-grams are the feature class that best generalizes across topic (Sapkota et al. 2015), and
   punctuation addition gave the single largest accuracy jump in Baayen et al. 2002 (81.5 → 88.1%).
   **Condition emoji rate on the interlocutor** — Frontiers 2022 measured p = 0.001 accommodation.
   Aggregate over a sliding window before displaying; use exponential histogram binning
   (small bins for small values) as Segalin et al. 2012 did for exactly this reason.

### Tier 2 — bundle-level, well supported. Show as "on your last N messages", never per message.

3. **Cosine Delta over character 4-grams** (§1.2, §1.4) — the strongest classic stylometric view for
   short, code-mixed, typo-laden text. Bundle must reach ~1,000–1,500 words; the 104k corpus makes
   that trivial.
4. **Impostor-method score** (§7.3) — a calibrated [0,1] fidelity score at a 500-word operating point,
   with the impostor pool drawn from the user's own other contacts. Report the two-sided dead zone.
5. **JSD over punctuation / character n-gram distributions**, benchmarked against the author's own
   within-author JSD distribution (Darmon et al. 2021's "author consistency") (§3). Prefer **f3-like**
   joint-probability-of-punctuation-pairs features; **avoid** leading with sentence/utterance length.
6. **MTLD** (primary) and **MATTR with a declared fixed 25–50 token window** (secondary) (§4).
7. **Utterance-length CV / burstiness** as an **AI-flattening diagnostic**, not an author-fidelity
   score (§5.1). The grey-literature cutoff analysis is the cautionary tale: a 0.40 CV threshold
   caught 62% of AI rewrites but flagged 39% of genuine human texts.

### Tier 3 — pool-level only, for A/B decisions between clone configurations

8. **MAUVE** (§8) between the author's real-message pool (≥5,000 samples) and a clone-generation pool.
   Relative comparisons only. **Untested on short code-mixed chat — validate in-house.**
9. **Bundle-level unmasking** (§7.4) — only if generated bundles reach ≥ ~1,000 words. Use the
   precision-first confidence threshold (`c >= 0.7`) and let it abstain.

### Tier 4 — do not use as a style metric

10. **BERTScore** (§9) — semantic, not stylistic; demonstrably fooled by surface/stylistic similarity;
    never used as a style metric in the style-transfer evaluation literature. Keep it only as a
    content control ("did the clone say the right thing").
11. **NCD / gzip compression distance** (§6) — noise at chat length. Formal window-size argument
    (Alfonseca et al. 2005) plus PAN 2023's compressor baseline c@1 = **0.051**.
12. **TTR / Yule's K / Herdan's C / Simpson's D** (§4) — documented systematic length dependence
    (Tweedie & Baayen 1998); unusable per message.
13. **Burrows's Classic Delta per message** (§1.1) — z-score vectors degenerate to a presence/absence
    pattern at 30 tokens. Burrows's own thresholds: 1,500 words for a verdict, 100 words for
    shortlisting only.
14. **Sentence-length distribution distance per message** (§5.1) — 1 sample per message; Yule 1939
    used ~600 sentences per author to establish stability.

### Cross-cutting: the evaluation scaffold (§7)

Whatever metric is chosen, calibrate it the PAN way: build balanced held-out same/different problems
from the author's own messages, tune the threshold at **EER**, widen a symmetric **abstention margin**
until the same-author false-positive rate is acceptable, and report **c@1 and AUROC with the
abstention rate** — never raw accuracy. Note that even the best PAN 2023 system reached only
**AUROC 0.616 / c@1 0.572** on cross-discourse pairs; an in-domain, single-author, single-genre
calibration should do much better, but the number must be measured, not assumed.

---

## Sources

Every source below was either opened directly (fetched full text/HTML) or surfaced via search with its
abstract, and is cited inline with a `(secondary citation)` or `UNVERIFIED` tag where appropriate.

### Primary papers and journal articles

1. Burrows, J. F. (2002). *'Delta': A Measure of Stylistic Difference and a Guide to Likely
   Authorship.* Literary and Linguistic Computing 17(3): 267–287.
   https://doi.org/10.1093/llc/17.3.267 — abstract at
   https://www.researchgate.net/publication/240956478
2. Smith, P. W. & Aldridge, W. (2011). *Improving Authorship Attribution: Optimizing Burrows' Delta
   Method.* Journal of Quantitative Linguistics 18(1).
   https://doi.org/10.1080/09296174.2011.533591 ·
   https://www.tandfonline.com/doi/abs/10.1080/09296174.2011.533591
3. Evert, S., Proisl, T., Vitt, T., Schöch, C., Jannidis, F., Pielström, S. (2015). *Towards a better
   understanding of Burrows's Delta in literary authorship attribution.* Proceedings of the Fourth
   Workshop on Computational Linguistics for Literature (CLFL), pp. 79–88, ACL.
   https://aclanthology.org/W15-0709/ · https://aclanthology.org/W15-0709.pdf ·
   https://doi.org/10.3115/v1/w15-0709 · author PDF
   https://www.stephanie-evert.de/PUB/EvertEtc2015_CL4Lit.pdf
4. Jannidis, F., Pielström, S., Schöch, C., Vitt, T. (2015). *Improving Burrows' Delta – An empirical
   evaluation of text distance measures.* Digital Humanities Conference 2015, Sydney.
   (No stable DOI located — `UNVERIFIED`.)
5. Eder, M., Rybicki, J., Kestemont, M. (2016). *Stylometry with R: A Package for Computational Text
   Analysis.* The R Journal. https://doi.org/10.32614/rj-2016-007 ·
   https://journal.r-project.org/articles/RJ-2016-007/RJ-2016-007.pdf
6. **stylo package source (opened, full text):** `R/stylo.default.settings.R` —
   https://raw.githubusercontent.com/computationalstylistics/stylo/master/R/stylo.default.settings.R ·
   https://github.com/computationalstylistics/stylo/blob/master/R/stylo.default.settings.R ·
   CRAN reference index https://search.r-project.org/CRAN/refmans/stylo/html/00Index.html ·
   mirrored at https://rdrr.io/cran/stylo/src/R/stylo.default.settings.R
7. Covington, M. A. & McFall, J. D. (2010). *Cutting the Gordian Knot: The Moving-Average Type–Token
   Ratio (MATTR).* Journal of Quantitative Linguistics 17(2).
   https://doi.org/10.1080/09296171003643098
8. McCarthy, P. M. & Jarvis, S. (2010). *MTLD, vocd-D, and HD-D: A validation study of sophisticated
   approaches to lexical diversity assessment.* Behavior Research Methods 42(2): 381–392.
   https://scispace.com/pdf/mtld-vocd-d-and-hd-d-a-validation-study-of-sophisticated-3j1xvu4x33.pdf ·
   https://www.proquest.com/openview/ed479350a401457da622a6ca52354ff4/1
9. Tweedie, F. J. & Baayen, R. H. (1998). *How Variable May a Constant be? Measures of Lexical
   Richness in Perspective.* Computers and the Humanities 32(5): 323–352.
   https://doi.org/10.1023/a:1001749303137 ·
   https://quantling.org/~hbaayen/publications/TweedieBaayen1998.pdf
10. Yule, G. U. (1939). *On Sentence-Length as a Statistical Characteristic of Style in Prose: With
    Application to Two Cases of Disputed Authorship.* Biometrika 30(3–4): 363–390.
    https://doi.org/10.1093/biomet/30.3-4.363 · https://doi.org/10.2307/2332655 ·
    https://academic.oup.com/biomet/article-abstract/30/3-4/363/227578
11. Darmon, A. N. M., Bazzi, M., Howison, S. D., Porter, M. A. (2021). *Pull out all the stops:
    Textual analysis via punctuation sequences.* European Journal of Applied Mathematics 32(6):
    1069–1105. https://doi.org/10.1017/S0956792520000157 ·
    https://www.cambridge.org/core/journals/european-journal-of-applied-mathematics/article/abs/pull-out-all-the-stops-textual-analysis-via-punctuation-sequences/B99D15C41973F50343A389EAECA68EB7 ·
    author PDF https://www.math.ucla.edu/~mason/papers/darmon-published-final-nov2021.pdf ·
    code https://github.com/alex-darmon/punctuation-stylometry · data
    https://doi.org/10.5281/zenodo.3605100
12. Sapkota, U., Bethard, S., Moens, M.-F., Daelemans, W. (2015). *Not All Character N-grams Are
    Created Equal: A Study in Authorship Attribution.* NAACL 2015.
    https://aclanthology.org/N15-1010.pdf
13. Baayen, R. H., van Halteren, H., Neijt, A., Tweedie, F. (2002). *An experiment in authorship
    attribution.* JADT 2002.
    https://quantling.org/~hbaayen/publications/BaayenVanHalterenNeijtTweedieJADT2002.pdf
14. *Topic or Style? Exploring the Most Useful Features for Authorship Attribution.* COLING 2018
    (C18-1029). https://aclanthology.org/C18-1029.pdf
15. Segalin, C., Celli, F., Polonio, L., Kosik, K., Cristani, M., Vinciarelli, A. (2012).
    *Conversationally-inspired stylometric features for authorship attribution in instant messaging.*
    ACM Multimedia 2012. https://doi.org/10.1145/2393347.2396398 ·
    https://www.cristinasegalin.com/research/papers/ACMM12.pdf
16. *Predicting user attributes in text-based online messaging* (chat mining). Information Processing
    & Management (2008). https://doi.org/10.1016/j.ipm.2007.12.009 ·
    http://www.cs.bilkent.edu.tr/~aykanat/papers/08IPM.pdf
17. *"Depends on Who I'm Writing To" — The Influence of Addressees and Personality Traits on the Use
    of Emoji and Emoticons, and Related Implications for Forensic Authorship Analysis.* Frontiers in
    Communication (2022). https://doi.org/10.3389/fcomm.2022.840646 ·
    https://www.frontiersin.org/journals/communication/articles/10.3389/fcomm.2022.840646/full
18. Marko, K. (2020). *Exploring the Distinctiveness of Emoji Use for Digital Authorship Analysis.*
    Linguística / LLLD (Universidade do Porto).
    http://ojs.letras.up.pt/index.php/LLLD/article/view/10349
19. Alfonseca, M., Cebrián, M., Ortega, A. (2005). *Common Pitfalls Using the Normalized Compression
    Distance: What to Watch Out for in a Compressor.* Communications in Information and Systems 5(4).
    https://doi.org/10.4310/cis.2005.v5.n4.a1
20. Halvani, O., Winter, C., Graner, L. (2017). *Authorship Verification based on Compression-Models.*
    arXiv:1706.00516. https://arxiv.org/abs/1706.00516 ·
    https://arxiv.org/pdf/1706.00516 · https://doi.org/10.48550/arxiv.1706.00516 · HTML
    https://arxiv.org/html/1706.00516v1
21. Halvani, O., Winter, C., Graner, L. (2017). *On the Usefulness of Compression Models for
    Authorship Verification.* IH&MMSec 2017.
    https://doi.org/10.1145/3098954.3104050
22. Cerra, D., Datcu, M., et al. (2014). *Authorship Analysis based on Data Compression.*
    arXiv:1402.3405. https://arxiv.org/pdf/1402.3405v1.pdf
23. *On divergence-based author obfuscation: An attack on the state of the art in statistical
    authorship verification.* it – Information Technology (2019).
    https://doi.org/10.1515/itit-2019-0046 (author list `UNVERIFIED`)
24. Koppel, M. & Winter, Y. (2014). *Determining if two documents are written by the same author.*
    JASIST. https://doi.org/10.1002/asi.22954 ·
    https://u.cs.biu.ac.il/~koppel/papers/impostors-journal-revised2-140213.pdf
25. Koppel, M., Schler, J., Argamon, S. (2004). *Authorship verification as a one-class
    classification problem.* ICML 2004.
    https://doi.org/10.1145/1015330.1015448 ·
    https://icml.cc/Conferences/2004/proceedings/papers/415.pdf
26. Bevendorff, J., Stein, B., Hagen, M., Potthast, M. (2019). *Generalizing Unmasking for Short
    Texts.* NAACL-HLT 2019, pp. 654–659.
    https://aclanthology.org/N19-1068/ · https://aclanthology.org/N19-1068.pdf ·
    https://doi.org/10.18653/v1/n19-1068
27. Peñas, A. & Rodrigo, Á. (2011). *A Simple Measure to Assess Non-response* (c@1). ACL-HLT 2011.
    https://aclanthology.org/P11-1142.pdf
28. Stamatatos, E., et al. (2023). *Overview of the Authorship Verification Task at PAN 2023.*
    https://downloads.webis.de/pan/publications/papers/stamatatos_2023.pdf
29. Argamon, S., et al. (2011). *Overview of the International Authorship Identification Competition
    at PAN-2011.* CEUR-WS Vol-1177.
    https://ceur-ws.org/Vol-1177/CLEF2011wn-PAN-ArgamonEt2011.pdf
30. *Graph-Based Siamese Network for Authorship Verification.* Mathematics 10(2): 277 (2022).
    https://doi.org/10.3390/math10020277
31. Pillutla, K., Swayamdipta, S., Zellers, R., Thickstun, J., Welleck, S., Choi, Y., Harchaoui, Z.
    (2021). *MAUVE: Measuring the Gap Between Neural Text and Human Text using Divergence Frontiers.*
    NeurIPS 2021 (Outstanding Paper Award). https://arxiv.org/abs/2102.01454 ·
    https://arxiv.org/abs/2102.01454v1 · project page https://krishnap25.github.io/mauve/ ·
    NeurIPS supplement
    https://proceedings.neurips.cc/paper_files/paper/2021/file/260c2432a0eecc28ce03c10dadc078a4-Supplemental.pdf
32. Liu, L., Pillutla, K., Welleck, S., Oh, S., Choi, Y., Harchaoui, Z. (2021). *Divergence Frontiers
    for Generative Models: Sample Complexity, Quantization Effects, and Frontier Integrals.*
    NeurIPS 2021 (JMLR 2023 extension). Cited from the MAUVE project page
    https://krishnap25.github.io/mauve/
33. Zhang, T., Kishore, V., Wu, F., Weinberger, K. Q., Artzi, Y. (2020). *BERTScore: Evaluating Text
    Generation with BERT.* ICLR 2020. https://arxiv.org/abs/1904.09675 ·
    https://ar5iv.labs.arxiv.org/html/1904.09675 ·
    https://iclr.cc/virtual/2020/poster/1738
34. *A Fine-Grained Analysis of BERTScore.* WMT21.
    https://statmt.org/wmt21/pdf/2021.wmt-1.59.pdf
35. *Evaluating Text Style Transfer Evaluation: Are There Any Reliable Metrics?* NAACL 2025 SRW.
    https://aclanthology.org/2025.naacl-srw.41.pdf
36. *A Study on Manual and Automatic Evaluation for Text Style Transfer: The Case of Detoxification.*
    HumEval 2022. https://aclanthology.org/2022.humeval-1.8.pdf
37. Huang, W., et al. (2024). *ALMs: Authorial Language Models for Authorship Attribution.*
    arXiv:2401.12005v2. https://arxiv.org/pdf/2401.12005v2.pdf ·
    code https://github.com/Weihang-Huang/ALMs (full author list `UNVERIFIED`)
38. Huang, W., et al. (2025). *Attributing authorship via the perplexity of authorial language
    models.* PLOS One. https://doi.org/10.1371/journal.pone.0327081 ·
    https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0327081
39. *Authorship identification of documents with high content similarity.* Scientometrics (2018).
    https://doi.org/10.1007/s11192-018-2661-6 ·
    https://link.springer.com/content/pdf/10.1007/s11192-018-2661-6.pdf
40. *Bot or not: Can people tell the difference between stories written by a human or by an AI
    system?* (preprint). https://doi.org/10.31234/osf.io/jkh6p_v2
41. *Sentence-Length Burstiness as a Cross Disciplinary and Cross-Model Signal of AI Rewriting.*
    TextPulse Research (2026). **Not peer reviewed.**
    https://textpulse.ai/research/textpulse-burstiness-sentence-length-2026.pdf
42. *An Evaluation Study of Authorship Attribution Approaches* (PhD thesis, White Rose etheses).
    https://etheses.whiterose.ac.uk/id/eprint/21415/1/FinalThesis_Yunita.pdf

### Reference implementations and packages (opened / verified)

43. `stylo` (R) — https://search.r-project.org/CRAN/refmans/stylo/html/00Index.html ·
    source https://github.com/computationalstylistics/stylo
44. `quanteda` (R) — `compute_mattr` https://quanteda.io/reference/compute_mattr.html ·
    `textstat_lexdiv` http://quanteda.io/reference/textstat_lexdiv.html
45. `lexicalrichness` (Python, PyPI) — https://github.com/lsys/lexicalrichness ·
    docs https://lexicalrichness.readthedocs.io/en/latest/details.html ·
    formulas https://lexicalrichness.readthedocs.io/en/latest/example.html ·
    docstrings https://lexicalrichness.readthedocs.io/en/latest/docstring_docs.html
46. `lexical_diversity` (Python) — https://github.com/kristopherkyle/lexical_diversity
47. `textstat` (Python) — https://github.com/textstat/textstat
48. `mauve-text` (Python, PyPI) — https://github.com/krishnap25/mauve ·
    https://pypi.org/project/mauve-text/ ·
    experiments https://github.com/john-hewitt/ts-mauve-experiments
49. `bert-score` (Python, PyPI) — https://github.com/Tiiiger/bert_score
50. `bdi` (Python) — Bootstrap Distance Imposters verification, AUC/c@1/PAN metrics, ScoreShifter.
    https://github.com/bnagy/bdi
51. `bitig` (Python) — General Impostors, Unmasking, PAN metrics (AUC + c@1 + F0.5u + Brier + ECE +
    C_llr), likelihood-ratio forensic reporting.
    https://github.com/fatihbozdag/bitig
