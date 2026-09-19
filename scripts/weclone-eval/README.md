# weclone-eval — an offline measurement instrument for the Weport persona clone

Tells you, with numbers instead of vibes, whether a change makes the clone sound more or
less like the one real person it is cloned from.

* Zero npm dependencies, plain Node >= 22 ESM. Only `node:fs`, `node:path`, `node:crypto`,
  `node:readline` are imported (`lib.mjs` imports nothing at all).
* **Runs fully offline.** No API client, no network call anywhere in this directory.
* Read-only with respect to the corpus. Every case set and report is written to `--out`.
* Deterministic: seeded LCG everywhere, no `Math.random`. Same corpus + same flags =>
  byte-identical `cases.jsonl`.

## Quick start

```sh
# 1. freeze a held-out case set (TEST = last 14 days, TRAIN = everything before)
node scripts/weclone-eval/build-cases.mjs \
  --corpus "C:\Users\<user>\AppData\Roaming\Weport\weclone-staging\<wxid>" \
  --out .ui-probe/eval-cases --target-cases 200

# 2. score the offline reference arms (+ REAL, the ceiling)
node scripts/weclone-eval/harness.mjs \
  --cases .ui-probe/eval-cases \
  --clone "C:\Users\<user>\AppData\Roaming\Weport\weclone-staging\<wxid>" \
  --out .ui-probe/eval-report.json

# 3. score a real clone run: produce predictions yourself (one {"id","text"} per line),
#    then hand the file to the harness. This harness never calls a model.
node scripts/weclone-eval/harness.mjs --cases .ui-probe/eval-cases \
  --clone "..." --predictions clone-output.jsonl --out .ui-probe/eval-report.json

# 4. prove the instrument itself works (no data, no network, non-zero exit on failure)
node scripts/weclone-eval/selftest.mjs
```

`--limit 40` on the builder gives a fast smoke set (strided across the whole test window,
not just its first 40 cases).

## Files

| file | role |
|---|---|
| `lib.mjs` | pure metric functions, no I/O (chrf, edit distance, JSD, profiles, bursts, copyRate, recoveryAtK, per-author LM + bpc, bootstrap, composite) |
| `build-cases.mjs` | freezes `cases.jsonl` + `train-voice.jsonl` + `manifest.json` from a corpus dir |
| `harness.mjs` | scores arms (REAL / PARROT / RANDOM / CLONE) and writes the JSON report |
| `selftest.mjs` | 96 assertions with zero data and zero network; exit code is the verdict |

Case set layout:

```
<out>/cases.jsonl        {id, sid, ts, cue, target, functionLabel, todLabel, cueChars, cueTruncated, chunkId}
<out>/train-voice.jsonl  one JSON string per line: TRAIN-window author messages only
<out>/manifest.json      split, sha1 of both corpus JSONLs, strata, drop counters, quality counters
```

`cases.jsonl` and `train-voice.jsonl` contain **real personal messages**. They are written
under `.ui-probe/` (gitignored). Never commit them, never paste a target or cue into a
chat, issue or report. The harness report contains ids, labels and numbers only — raw text
is embedded solely with `--include-texts`, for local debugging.

## How the case set is built

* **Split**: the last `--holdout-days` (default 14) of the corpus by timestamp is TEST,
  everything before is TRAIN. On the reference corpus: boundary `2026-09-05`, 29,290 train
  / 2,937 test author messages.
* **Case**: one real author message from the TEST window (from `voice.jsonl`) plus the
  conversation context that preceded it inside its `chunks.jsonl` chunk — other party's
  lines included, whole lines only, capped at 1,200 chars from the near end.
* **Pairing**: chunk lines are prefixed `我: ` for the author. Pairing walks each session's
  `voice.jsonl` rows with a short lookahead. On the reference corpus this matches
  **32,227 / 32,227 (100.0%)** with zero lookahead — the manifest reports the rate, and
  the builder warns below 90%.
* **Drops**: targets < 2 chars, pure ornament (`[图片]`, emoji-only), duplicate targets,
  and everything the leakage filters catch.
* **Stratification**: round-robin over `functionLabel x todLabel` cells with a soft cap of
  3 cases per session. `functionLabel` is read from the **last cue line** (the move the
  target answers): `sticker` (ornament only) -> `greeting` -> `question` (ends with `?`/`？`
  or carries 吗/是不是/…) -> `statement`. `todLabel` uses **UTC** hours
  (night/morning/afternoon/evening), so labels never shift with the machine timezone.
* **Leakage control (a) — window**: the per-author model is trained only on
  `train-voice.jsonl` (TRAIN window). No metric can see the text it is predicting.
* **Leakage control (b) — persona**: a candidate target is dropped when it, or any >= 8
  codepoint substring of it, occurs verbatim in the clone's `.md` persona files (the clone
  was generated from those files, so such a target is memorisation, not prediction).

## Metrics

| metric | what it measures | power at 1–30 chars |
|---|---|---|
| `chrf` | char n-gram F2 (orders 1..6 averaged) vs the one real target | moderate; sharp when text overlaps, blind to style |
| `normEditDistance` | Levenshtein / max length vs the target | moderate |
| **`bpc` / `bpcVsNull`** | bits per character under a per-author char 4-gram interpolated LM (add-k, BOS/EOS), divided by a **length-bucket-matched** null of real held-out train messages | **the only family with per-message power here** |
| `recovery@1/5/20`, `MRR` | rank of the real target in a 21-option pool scored by edit distance to the arm's text | strong discriminator (chance 4.76% @1) |
| `lengthBucketAgreement` | arm length bucket == target length bucket (1-3/4-8/9-16/17-30/31-60/60+) | cheap, high variance |
| `copyRate` | share of arm messages sharing a >= 8-char verbatim substring with the train corpus / with the persona `.md` | memorisation detector, **not** a quality metric |
| surface profiles | has-punctuation, sentence-final punctuation, question, ellipsis, laugh (哈哈/lol/haha/草), sticker/`[tag]` placeholder, emoji, lowercase ratio, all-caps tokens, apostrophe omission (`im`/`dont`/…), Latin/CJK ratios, mixed-script rate | bundle-level only |
| `histogramL1`, `ksStatistic`, `jensenShannon` | length-distribution and char-n-gram distance between an arm and a reference | bundle-level only |
| `burstStats` | count/mean/median/`>=3 share` of same-session bursts (gap <= 180 s) | approximation, see caveat below |
| `pairedBootstrapCI` | percentile CI of the per-case mean difference between two arms | the only honest way to read arm-vs-arm deltas |

Two framing rules the harness enforces in its own output:

1. Everything is measured **per case** against the case's own target. Only after that are
   per-arm means computed.
2. Two surface reference frames are printed — **vs the author's train corpus** (absolute
   realism) and **vs this case set's own targets** (gate-ready; REAL is 0 by construction).
   The case set is deliberately stratified and leakage-filtered, so it sits a few chars
   shorter than the corpus; that is a property of the case set, not of any arm.

Convention worth knowing: a profile rate is `null` when its denominator is empty (e.g.
`lowercaseLetterRatio` for an arm with no ASCII letters at all). The harness prints the
delta against such a profile as if the rate were 0, which is the honest reading — an arm
with zero Latin characters really is unlike an author who uses Latin in 77% of messages.

### Caveats baked into the metrics

* `burstStats` is an approximation: a real burst is "messages until the other party
  replies", and the corpus indexes do not carry reply direction, so contiguous same-session
  messages within 180 s are used as a proxy.
* `recoveryAtK` in `lib.mjs` ranks candidates by distance **to the given reference**. With
  the default reference (= the target) rank 1 simply means "the target is in the pool";
  the harness passes `scoreAgainst = arm text`, which is what makes it a discriminator.
* `bpc` is strongly **length-dependent** on the real corpus (5,000-message train sample:
  4.64 bits/char at 1-3 chars, 5.56 at 4-8, 4.89 at 9-16, 3.99 at 17-30, 3.66 at 31-60,
  3.67 at 60+) and a model scores text it was trained on optimistically. Hence the
  **calibration split**: 10% of the TRAIN window is held out of the model entirely and used
  for the RANDOM arm and for the length-matched null. Raw `bpc` is printed for the record;
  **`bpcVsNull` is the number to quote.**
* `copyRate` counts 8-char windows, so a short message (< 8 chars) can never be flagged.
  The human base rate matters more than the raw number: on the reference corpus **44.5% of
  real held-out author messages already share an 8-char window with the train corpus**, and
  the REAL arm scores 0.000 against the persona `.md`. A clone at 0.45 vs train is not
  "memorising"; one at 0.05 vs persona md is.

## What is unreliable at 1–30 characters (blunt)

The median real message is 14 chars and 82% carry no punctuation at all. That kills most of
the standard tooling:

* **JSD over char n-grams**: bundle-level only. A 14-char message has ~13 bigrams; two
  unrelated short messages can look closer than two styles. Bundle >= 200 messages.
* **Lexical richness / type-token ratio, vocabulary size, hapax rates**: meaningless per
  message; divide by length and they still mostly measure length.
* **NCD (compression distance) and MAUVE**: bundle-level only, and both need thousands of
  tokens to stabilise. Do not report them per message.
* **BLEU / ROUGE / BERTScore: the wrong construct.** They reward text that is *similar to
  the target in a generic sense* — BLEU/ROUGE reward repeating the cue's content words and
  BERTScore rewards fluent generic Chinese. A clone that answers in textbook Chinese scores
  well on all three and still does not sound like this person (who writes `ok`, `im`, `[Sob]`
  and code-switched half-sentences). They are not implemented here on purpose.
* **Anything that needs an LLM judge** is out of scope: this instrument must run offline and
  produce the same numbers twice.
* Punctuation/casing/code-switch rates are stable only at bundle scale; treat single-message
  differences as noise.

The one metric family that survives at this message length is **per-author BPC with a
length-matched null** — it is the reason this harness exists and it should carry real weight
in any decision.

## Reference frame — printed before any result

The harness prints eight checks first and shouts if the instrument looks mis-calibrated:

| check | measured on the 200-case reference run |
|---|---|
| REAL chrF − RANDOM chrF >= 0.20 | 0.964 (REAL 1.000 vs RANDOM 0.036) |
| RANDOM normEditDist − REAL >= 0.30 | 0.936 (REAL 0.000 vs RANDOM 0.936) |
| REAL recovery@1 is the ceiling (>= 0.99) | 1.000 |
| RANDOM recovery@1 near chance (<= 2.5× chance) | 0.055 vs chance 0.048 |
| BPC null calibrated on REAL, \|x−1\| <= 0.20 | 1.065 |
| BPC null calibrated on RANDOM, \|x−1\| <= 0.25 | 1.049 |
| BPC separates real text from unigram noise, paired gap >= 0.10 bits/char | 0.456 |
| PARROT beats RANDOM on a surface metric | chrF 0.048 vs 0.036, normEditDist 0.922 vs 0.936 |

If any of these fails, the report says **MIS-CALIBRATED** and exits non-zero: the arm
numbers below it must not be quoted until the case set, the arm wiring or the metric is
fixed. This is not decoration — the first version of this harness passed six checks and
failed the seventh, which is how the length confound in raw BPC was found.

## Reference numbers (this corpus, 200 cases, offline arms only)

```
arm       n    chrF     ned  bucket     bpc  bpc/null   R@1    R@5   R@20    MRR    copy  copyMd
REAL    200   1.000   0.000   1.000   5.274     1.065 1.000  1.000  1.000  1.000   0.445   0.000
PARROT  200   0.048   0.922   0.165   4.773     0.994 0.105  0.265  0.510  0.206   0.575   0.180
RANDOM  200   0.036   0.936   0.140   5.039     1.049 0.055  0.185  0.545  0.153   0.700   0.245
```

Reading it:

* REAL is the ceiling for surface/recovery, but its `bpcVsNull` is **1.065**, i.e. the test
  window is ~6.5% less predictable than the train window at matched length: a genuine
  train/test drift. Any future gate must live above that, not at 1.0.
* PARROT (BM25 over the train window, query = last two cue lines) reaches R@1 = 10.5%,
  about 2.2× chance, and is **worse than REAL on every surface metric** — a keyword
  retriever is not a persona model.
* RANDOM sits at chance on recovery (5.5% vs 4.76%), copies 70% of its text from the train
  corpus and 24.5% from the persona files — it is a floor, not a baseline.
* The composite scores REAL 88.0, PARROT 54.5, RANDOM 47.1. **REAL is the empirical
  ceiling, not 100**: verifiability tops out at `1 − REAL's own copy rate` and
  predictability at ~0.88 because of the drift above.
* Cost: model build ~1.2 s, BM25 index ~90 ms, scoring ~26 ms/case over 3 arms, whole
  200-case run **2.9 s** at ~316 MB RSS, **0 API calls, $0.00**.

## Chance level and the four hard gates

Chance: the candidate pool is 20 sampled TRAIN messages **plus the real target** = 21
options, so `recovery@1` chance is **1/21 = 4.76%** (`@5` 23.8%, `@20` 95.2%).

The four gates below are **provisional**, derived from the REAL/PARROT/RANDOM trio above,
and should be re-derived once two real clone runs exist. A clone must pass all four:

1. **Discriminability** — `recovery@1 >= 0.20` (>= 4× chance, ~2× PARROT) **and**
   `MRR >= 0.30` (PARROT 0.206). A clone that cannot be picked out of a 21-option pool
   better than keyword retrieval is not a persona clone.
2. **Author-likeness** — mean `bpcVsNull <= 1.10` (REAL 1.065, RANDOM 1.049, unigram noise
   1.52). This is the one per-message-power gate.
3. **Anti-memorisation** — `copyRate` vs the train corpus `<= 0.55` (human base rate 0.445)
   **and** vs the persona `.md` `<= 0.05` (REAL 0.00, PARROT 0.180).
4. **Surface fidelity vs the case set** — length-bucket `L1 <= 0.45` (PARROT 0.62),
   `|lengthRelErr| <= 0.35`, `|Δ mixed-script rate| <= 0.10`.

Gate reading rules: only trust a passed gate if the **paired bootstrap CI** in the report
supports it; a gate that passes on the mean but whose CI spans zero is not passed, it is
undecided. A gate that is only checked on the 40-case smoke set is also undecided — use
`--target-cases 200` before believing any of them.

The gates have been verified to bite. Feeding the 200-case set a synthetic arm of polite
generic Chinese (the shape of a textbook assistant reply, one of three sentences per case)
produces:

```
CLONE    chrF 0.006  ned 0.990  bucket 0.305  bpc/null 1.644  R@1 0.040  MRR 0.125  copy 0.000/0.000  composite 30.5
```

That arm fails gate 1 (0.040 < 0.20), gate 2 (1.644 > 1.10 — worse than the
unigram-random-string control at 1.521) and gate 4 (bucket L1 1.390 > 0.45), passes gate 3
trivially, and lands 58 composite points below REAL. A measurement that cannot fail an arm
is not a measurement.

## Composite score

`compositeSfs` is an optional 0–100 roll-up: `recovery` (`MRR`), `predictability`
(`bpcVsNull` anchored at 1.0 => 1.0 and at this run's unigram-random-string control => 0.0),
`verifiability` (`1 − copyRate` vs train), `surface` (`1 −` max(bucket L1/2, relative length
error) vs the case set's targets).

**The weights (`DEFAULT_SFS_WEIGHTS`, 0.35/0.25/0.20/0.20) are a PROPOSED DEFAULT, not a
literature result, and must be calibrated on the first two real runs rather than trusted.**
Calibrate by ranking a handful of known-good and known-bad clone outputs by hand, then
picking weights that reproduce that order and are monotone in it. Until then: quote the
component numbers, not the composite, and never compare two composites produced under
different weights.

## Determinism, cost, privacy

* Seeded LCG (`lib.makeRng`, default seed 12345) for candidate pools, the RANDOM arm, the
  calibration split (hash-based), the stratified sample and the bootstrap. Re-running any
  command reproduces the same numbers on the same inputs.
* The calibration split, the BM25 index and the candidate pools are all built from
  `train-voice.jsonl`; the TEST window is used only to supply targets and cues.
* No network code exists in this directory. `--predictions` is the only way a generated arm
  enters, and it is a local file.
* Reports are written without message text by default (`--include-texts` opts in).

## Known limitations

* One target per case: no multi-turn dialogue scoring, and a single-message cue cap of 1,200
  chars means very long conversations are truncated from the near end.
* `functionLabel`/`todLabel` are rule-based stratifiers, not annotations; they exist to keep
  the sample balanced.
* Burst structure is approximated (see caveat above); nothing here scores *turn-taking*.
* The clone's own generation pipeline is not invoked. This is a pure scorer — you produce
  `predictions.jsonl`, the harness judges it.
* The case set cannot be compared across corpora revisions: `manifest.json` pins the sha1 of
  both JSONLs, and the harness verifies the `--clone` directory against them (it prints
  `corpus sha1 OK` or a loud mismatch note).
