/**
 * weclone-eval / lib.mjs — pure metric functions, NO I/O, NO npm dependencies.
 *
 * Everything here is a pure function of its arguments (plus an explicit seeded RNG),
 * so it can be unit-tested with no corpus and no network.
 *
 * Metric families, and honesty about their power at 1-30 characters (the median
 * author message in the real corpus is 14 chars, mean 23.7):
 *
 *   STRONG per-message power at 1-30 chars
 *     - perAuthorModel / bpc   : character 4-gram interpolated LM, scored per message.
 *   MODERATE per-message power
 *     - normEditDistance, chrf : surface similarity to the one real target.
 *     - recoveryAtK            : discriminability in a small candidate pool.
 *     - lengthStats / buckets  : cheap, high-variance, still informative.
 *   BUNDLE-LEVEL ONLY (do not read a single message off these)
 *     - jensenShannon over char n-grams, punctuation/casing/code-switch profiles.
 *
 * Nothing in this file knows about WeChat; it is a generic text-measurement kit.
 */

// ---------------------------------------------------------------------------
// basics
// ---------------------------------------------------------------------------

/** Split into Unicode code points (surrogate pairs stay together). */
export function toChars(s) {
  return Array.from(s == null ? '' : String(s));
}

/** Count of Unicode code points. */
export function charLen(s) {
  return toChars(s).length;
}

export function mean(xs) {
  if (!xs || xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Median of a numeric array (does not mutate the input). Linear-time-select is overkill here. */
export function median(xs) {
  if (!xs || xs.length === 0) return null;
  const a = [...xs].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Percentile in [0,1] using linear interpolation between order statistics. */
export function percentile(xs, q) {
  if (!xs || xs.length === 0) return null;
  const a = [...xs].sort((x, y) => x - y);
  if (a.length === 1) return a[0];
  const pos = q * (a.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/** Deterministic 32-bit FNV-1a string hash (used for stable tie-breaks and hash sets). */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    h ^= c & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (c >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (c >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic LCG (Numerical Recipes constants). No Math.random anywhere in this
 * harness, so every number in a report is reproducible from the seed.
 * Returns a function () => float in [0,1).
 */
export function makeRng(seed = 12345) {
  let state = (Math.trunc(seed) >>> 0) || 1;
  return function next() {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Fisher-Yates using an injected rng; returns a new array. */
export function shuffled(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// ---------------------------------------------------------------------------
// char n-gram F-score (chrF)
// ---------------------------------------------------------------------------

function ngramCounts(chars, n) {
  const m = new Map();
  if (chars.length < n) return m;
  for (let i = 0; i + n <= chars.length; i++) {
    const g = chars.slice(i, i + n).join('');
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

function overlapCount(a, b) {
  let overlap = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [g, c] of small) {
    const other = big.get(g);
    if (other) overlap += Math.min(c, other);
  }
  return overlap;
}

/**
 * chrF: character n-gram F-score, orders 1..n averaged (standard chrF form).
 *
 * Orders where either side has no n-grams (text shorter than n) are skipped, so
 * identical short texts still reach 1.0 instead of being penalised for length.
 * beta=2 weights recall twice as heavily as precision (the standard chrF2 default).
 *
 * Returns a number in [0,1]. Both sides empty => 1.0 (identical).
 */
export function chrf(pred, ref, { n = 6, beta = 2 } = {}) {
  const p = toChars(pred);
  const r = toChars(ref);
  if (p.length === 0 && r.length === 0) return 1;
  if (p.length === 0 || r.length === 0) return 0;
  const beta2 = beta * beta;
  let precSum = 0;
  let recSum = 0;
  let orders = 0;
  for (let o = 1; o <= n; o++) {
    const pc = ngramCounts(p, o);
    const rc = ngramCounts(r, o);
    if (pc.size === 0 || rc.size === 0) continue;
    let pTotal = 0;
    for (const c of pc.values()) pTotal += c;
    let rTotal = 0;
    for (const c of rc.values()) rTotal += c;
    const ov = overlapCount(pc, rc);
    precSum += pTotal ? ov / pTotal : 0;
    recSum += rTotal ? ov / rTotal : 0;
    orders++;
  }
  if (orders === 0) return 0;
  const prec = precSum / orders;
  const rec = recSum / orders;
  const denom = beta2 * prec + rec;
  if (denom === 0) return 0;
  return (1 + beta2) * (prec * rec) / denom;
}

// ---------------------------------------------------------------------------
// edit distance
// ---------------------------------------------------------------------------

/**
 * Levenshtein distance with insert/delete/substitute cost 1.
 * Two-row DP, O(min(|a|,|b|)) memory (the shorter string becomes the row axis).
 */
export function editDistance(a, b) {
  const s = toChars(a);
  let t = toChars(b);
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  // make the row axis the shorter one
  let row = s;
  let col = t;
  if (row.length > col.length) [row, col] = [col, row];
  const n = row.length;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= col.length; i++) {
    cur[0] = i;
    const ci = col[i - 1];
    for (let j = 1; j <= n; j++) {
      const cost = row[j - 1] === ci ? 0 : 1;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      cur[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[n];
}

/** Levenshtein distance normalised by the longer code-point length. 0 for identical/empty, max 1. */
export function normEditDistance(a, b) {
  const la = charLen(a);
  const lb = charLen(b);
  const m = Math.max(la, lb);
  if (m === 0) return 0;
  return editDistance(a, b) / m;
}

// ---------------------------------------------------------------------------
// distributions + Jensen-Shannon divergence
// ---------------------------------------------------------------------------

/**
 * Character n-gram distribution of `text` as a Map<ngram, count>.
 * n<1 is clamped to 1. Text shorter than n yields an empty Map.
 */
export function charNgramDistribution(text, n = 2) {
  const k = Math.max(1, Math.trunc(n));
  return ngramCounts(toChars(text), k);
}

function asCountMap(dist) {
  const m = new Map();
  if (!dist) return m;
  if (dist instanceof Map) {
    for (const [k, v] of dist) if (Number.isFinite(v) && v > 0) m.set(String(k), (m.get(String(k)) || 0) + v);
    return m;
  }
  if (Array.isArray(dist)) {
    dist.forEach((v, i) => { if (Number.isFinite(v) && v > 0) m.set(String(i), v); });
    return m;
  }
  if (typeof dist === 'object') {
    for (const [k, v] of Object.entries(dist)) if (Number.isFinite(v) && v > 0) m.set(String(k), v);
  }
  return m;
}

/** Merge several count distributions into one. */
export function mergeDistributions(dists) {
  const out = new Map();
  for (const d of dists) for (const [k, v] of asCountMap(d)) out.set(k, (out.get(k) || 0) + v);
  return out;
}

/**
 * Jensen-Shannon divergence between two count distributions (base 2 => range [0,1]).
 *
 * Smoothing: `alpha` (default 0.5, a Krichevsky-Trofimov-ish/Laplace pseudo-count) is
 * added to EVERY term of the union support of both distributions. Consequence: an
 * unseen term never contributes log(0), and zero-support terms stay finite. If both
 * sides are empty the divergence is defined as 0. The result is clamped to [0,1] to
 * absorb float error. It never returns NaN or Infinity.
 *
 * Caveat (see README): at 1-30 characters a single message carries too few n-grams
 * for JSD to be meaningful. Use it on bundles of >=200 messages only.
 */
export function jensenShannon(p, q, { alpha = 0.5, base = 2 } = {}) {
  const P = asCountMap(p);
  const Q = asCountMap(q);
  if (P.size === 0 && Q.size === 0) return 0;
  const a = Number.isFinite(alpha) && alpha > 0 ? alpha : 0.5;
  const support = new Set([...P.keys(), ...Q.keys()]);
  let pTotal = 0;
  let qTotal = 0;
  for (const k of support) {
    pTotal += (P.get(k) || 0) + a;
    qTotal += (Q.get(k) || 0) + a;
  }
  if (!(pTotal > 0) || !(qTotal > 0)) return 0;
  const logBase = Math.log(Number.isFinite(base) && base > 1 ? base : 2);
  let jsd = 0;
  for (const k of support) {
    const pi = ((P.get(k) || 0) + a) / pTotal;
    const qi = ((Q.get(k) || 0) + a) / qTotal;
    const mi = 0.5 * (pi + qi);
    if (pi > 0 && mi > 0) jsd += 0.5 * pi * (Math.log(pi) - Math.log(mi)) / logBase;
    if (qi > 0 && mi > 0) jsd += 0.5 * qi * (Math.log(qi) - Math.log(mi)) / logBase;
  }
  if (!Number.isFinite(jsd)) return 0;
  return Math.min(1, Math.max(0, jsd));
}

// ---------------------------------------------------------------------------
// KS statistic
// ---------------------------------------------------------------------------

/**
 * Two-sample Kolmogorov-Smirnov statistic D = max |F1(x) - F2(x)| over the pooled
 * sorted sample. No p-value (not needed here; we compare generators, not test
 * hypotheses). Returns 0 when either sample is empty.
 */
export function ksStatistic(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const vals = [...a, ...b].sort((x, y) => x - y);
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < a.length || j < b.length) {
    const v = Math.min(i < a.length ? a[i] : Infinity, j < b.length ? b[j] : Infinity);
    while (i < a.length && a[i] <= v) i++;
    while (j < b.length && b[j] <= v) j++;
    const diff = Math.abs(i / a.length - j / b.length);
    if (diff > d) d = diff;
  }
  return d;
}

// ---------------------------------------------------------------------------
// surface profiles (bundle-level: compute over >=200 messages, never one message)
// ---------------------------------------------------------------------------

const RE_ANY_PUNCT = /[\p{P}]/u;
const RE_ENDS_SENTENCE_PUNCT = /[.!?。！？…；;~～]+$/u;
const RE_QUESTION = /[?？]|吗[?？。!！]?$|吧[?？]$|呢[?？。!！]?$|怎么|为什么|啥|多少/;
const RE_ELLIPSIS = /(…|。{2,}|\.{3,}|~{2,})/u;
const RE_LAUGH = /(哈{2,}|haha+|lol|lmao|hehe|hiahia|233|hhh|草)/iu;
const RE_STICKER_ONLY = /^\s*(?:\[[^\]]{1,24}\]|[\p{Extended_Pictographic}\uFE0F\u200D\u20E3\s])+\s*$/u;
const RE_BRACKET_TAG = /\[[^\]]{1,24}\]/u;
const RE_EMOJI = /\p{Extended_Pictographic}/u;

function rate(texts, re) {
  if (!texts || texts.length === 0) return null;
  let n = 0;
  for (const t of texts) if (re.test(t)) n++;
  return n / texts.length;
}

/**
 * Punctuation / ornament profile of a message bundle. All rates are per-message
 * fractions in [0,1] (null for an empty bundle).
 *
 *  hasAnyPunct        : contains any Unicode punctuation (\p{P})
 *  endsWithSentencePunct: ends with . ! ? 。 ！ ？ … ; ； ~ ～
 *  question           : contains ?/？ or a Chinese interrogative marker (吗/呢/怎么/...)
 *  ellipsis           : contains … or 。。+ or ... or ~~
 *  laugh              : 哈哈+/haha/lol/lmao/hehe/233/草
 *  stickerPlaceholder : message consists ONLY of [bracket tags] / emoji / whitespace
 *  bracketTag         : contains any [bracket tag] (includes [已脱敏:...] placeholders)
 *  emoji              : contains any Extended_Pictographic code point
 *  charPunctRatio     : punctuation code points / all code points (char level, not per-message)
 */
export function punctuationProfile(texts) {
  const list = texts || [];
  const prof = {
    n: list.length,
    hasAnyPunct: rate(list, RE_ANY_PUNCT),
    endsWithSentencePunct: rate(list, RE_ENDS_SENTENCE_PUNCT),
    question: rate(list, RE_QUESTION),
    ellipsis: rate(list, RE_ELLIPSIS),
    laugh: rate(list, RE_LAUGH),
    stickerPlaceholder: rate(list, RE_STICKER_ONLY),
    bracketTag: rate(list, RE_BRACKET_TAG),
    emoji: rate(list, RE_EMOJI),
    charPunctRatio: null,
  };
  let punctChars = 0;
  let allChars = 0;
  for (const t of list) {
    for (const ch of toChars(t)) {
      allChars++;
      if (RE_ANY_PUNCT.test(ch)) punctChars++;
    }
  }
  prof.charPunctRatio = allChars ? punctChars / allChars : null;
  return prof;
}

const RE_ASCII_LETTER = /[A-Za-z]/;
const RE_ASCII_TOKEN = /[A-Za-z][A-Za-z']*/g;
// Lowercase contraction/possessive forms with the apostrophe omitted. Heuristic:
// it also matches legitimate lowercase words ("its", "were", "cant" as a name), so
// treat the rate as a style indicator for a bundle, never as ground truth.
const RE_APOSTROPHE_OMITTED = /\b(?:im|dont|doesnt|didnt|hes|shes|its|ive|youre|youve|thats|wont|cant|couldnt|shouldnt|wouldnt|isnt|wasnt|arent|werent|hasnt|havent|hadnt|theres|whats|lets|id|ill|youll|dont|aint)\b/;

/**
 * ASCII casing profile over messages that contain ASCII letters. Rates are computed
 * with that message subset as the denominator (null if the subset is empty).
 *
 *  asciiMessageShare      : share of all messages containing an ASCII letter
 *  lowercaseLetterRatio   : lowercase / all ASCII letters
 *  allLowercaseMsgRate    : share of ASCII messages with no uppercase letter at all
 *  allCapsTokenRate       : share of ASCII tokens (len>=2) that are ALL CAPS
 *  apostropheOmittedRate  : share of ASCII messages containing im/dont/hes/... (heuristic)
 */
export function casingProfile(texts) {
  const list = texts || [];
  const asciiMsgs = list.filter((t) => RE_ASCII_LETTER.test(t));
  let lower = 0;
  let upper = 0;
  let allLowerMsgs = 0;
  let omitted = 0;
  let tokens = 0;
  let capsTokens = 0;
  for (const t of asciiMsgs) {
    let hasUpper = false;
    for (const ch of toChars(t)) {
      if (ch >= 'a' && ch <= 'z') lower++;
      else if (ch >= 'A' && ch <= 'Z') { upper++; hasUpper = true; }
    }
    if (!hasUpper) allLowerMsgs++;
    if (RE_APOSTROPHE_OMITTED.test(t)) omitted++;
    const toks = t.match(RE_ASCII_TOKEN) || [];
    for (const tok of toks) {
      if (tok.length < 2) continue;
      tokens++;
      if (tok === tok.toUpperCase() && /[A-Z]/.test(tok)) capsTokens++;
    }
  }
  const den = asciiMsgs.length;
  const letters = lower + upper;
  return {
    n: list.length,
    asciiMessageShare: list.length ? den / list.length : null,
    lowercaseLetterRatio: letters ? lower / letters : null,
    allLowercaseMsgRate: den ? allLowerMsgs / den : null,
    allCapsTokenRate: tokens ? capsTokens / tokens : null,
    apostropheOmittedRate: den ? omitted / den : null,
  };
}

const RE_LATIN_LETTER = /[A-Za-z]/;
const RE_CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * Code-switch profile. Ratios are over all code points (spaces included); the mixed
 * rate is the per-message fraction containing BOTH a Latin letter and a CJK char.
 */
export function codeSwitchProfile(texts) {
  const list = texts || [];
  let latin = 0;
  let cjk = 0;
  let other = 0;
  let mixed = 0;
  let withLatin = 0;
  let withCjk = 0;
  for (const t of list) {
    let hasL = false;
    let hasC = false;
    for (const ch of toChars(t)) {
      if (RE_LATIN_LETTER.test(ch)) { latin++; hasL = true; }
      else if (RE_CJK.test(ch)) { cjk++; hasC = true; }
      else other++;
    }
    if (hasL) withLatin++;
    if (hasC) withCjk++;
    if (hasL && hasC) mixed++;
  }
  const total = latin + cjk + other;
  return {
    n: list.length,
    latinCharRatio: total ? latin / total : null,
    cjkCharRatio: total ? cjk / total : null,
    otherCharRatio: total ? other / total : null,
    latinMsgRate: list.length ? withLatin / list.length : null,
    cjkMsgRate: list.length ? withCjk / list.length : null,
    mixedRate: list.length ? mixed / list.length : null,
    latinChars: latin,
    cjkChars: cjk,
  };
}

// ---------------------------------------------------------------------------
// length distribution
// ---------------------------------------------------------------------------

export const LENGTH_BUCKETS = ['1-3', '4-8', '9-16', '17-30', '31-60', '60+'];

/** Bucket label for a code-point length. */
export function bucketOf(len) {
  const n = Number(len) || 0;
  if (n <= 3) return '1-3';
  if (n <= 8) return '4-8';
  if (n <= 16) return '9-16';
  if (n <= 30) return '17-30';
  if (n <= 60) return '31-60';
  return '60+';
}

/** Counts per bucket, always all six keys, in LENGTH_BUCKETS order. */
export function histogram(lengths) {
  const h = {};
  for (const b of LENGTH_BUCKETS) h[b] = 0;
  for (const l of lengths || []) h[bucketOf(l)]++;
  return h;
}

/** Share per bucket (fractions, all six keys). Empty input => all zeros. */
export function histogramShares(lengths) {
  const h = histogram(lengths);
  const n = (lengths || []).length;
  if (!n) return h;
  for (const b of LENGTH_BUCKETS) h[b] = h[b] / n;
  return h;
}

/** L1 distance between two histograms of the same support, clamped to [0,2]. */
export function histogramL1(a, b, keys = LENGTH_BUCKETS) {
  let d = 0;
  for (const k of keys) d += Math.abs(((a || {})[k] || 0) - ((b || {})[k] || 0));
  return Math.min(2, d);
}

/** mean/median/p10/p90/min/max/stdev + the six-bucket histogram, in code points. */
export function lengthStats(texts) {
  const list = texts || [];
  const lengths = list.map(charLen);
  if (lengths.length === 0) {
    return { n: 0, mean: null, median: null, p10: null, p90: null, min: null, max: null, stdev: null, histogram: histogram([]) };
  }
  const m = mean(lengths);
  let varSum = 0;
  for (const l of lengths) varSum += (l - m) * (l - m);
  return {
    n: lengths.length,
    mean: m,
    median: median(lengths),
    p10: percentile(lengths, 0.1),
    p90: percentile(lengths, 0.9),
    min: Math.min(...lengths),
    max: Math.max(...lengths),
    stdev: Math.sqrt(varSum / lengths.length),
    histogram: histogram(lengths),
  };
}

// ---------------------------------------------------------------------------
// bursts
// ---------------------------------------------------------------------------

/**
 * Approximate burst statistics. Input is [{sid, ts}] (any order; ties are broken by
 * original index so the result is deterministic). Consecutive messages of the SAME
 * session with a gap <= gapSeconds are grouped into one burst.
 *
 * APPROXIMATION: a real "burst" is "messages until the other party replies". The
 * corpus indexes do not carry a reply direction here, so contiguous same-session
 * messages within 3 minutes are used as a proxy. Treat `>=3 share` as a style
 * indicator, not a measurement of turn structure.
 *
 * Returns {count, mean, median, ge3Share, gaps?}.
 */
export function burstStats(events, { gapSeconds = 180, includeGaps = false } = {}) {
  const ev = (events || []).map((e, i) => ({ sid: e.sid, ts: Number(e.ts) || 0, i }));
  ev.sort((a, b) => (a.ts - b.ts) || (a.i - b.i));
  const bursts = [];
  let cur = null;
  let prevTs = null;
  for (const e of ev) {
    if (cur && e.sid === cur.sid && prevTs !== null && e.ts - prevTs <= gapSeconds) {
      cur.size++;
      cur.last = e.ts;
    } else {
      cur = { sid: e.sid, size: 1, first: e.ts, last: e.ts };
      bursts.push(cur);
    }
    prevTs = e.ts;
  }
  const sizes = bursts.map((b) => b.size);
  let ge3 = 0;
  for (const s of sizes) if (s >= 3) ge3++;
  const out = {
    count: bursts.length,
    mean: mean(sizes),
    median: median(sizes),
    ge3Share: sizes.length ? ge3 / sizes.length : null,
    msgsPerBurst: sizes.length ? ev.length / sizes.length : null,
  };
  if (includeGaps) out.gaps = bursts.map((b) => b.last - b.first);
  return out;
}

// ---------------------------------------------------------------------------
// copy rate (verbatim memorisation)
// ---------------------------------------------------------------------------

/**
 * Fraction of `generatedTexts` that share a verbatim substring of >= minMatch code
 * points with ANY text in `corpusTexts`.
 *
 * Implementation: every minMatch-window of the corpus is hashed with a rolling
 * FNV-style polynomial hash into a Set<number>; each generated message is checked by
 * hashing its own windows and testing membership.
 *
 * MEMORY: the corpus n-gram set costs one 32-bit number per distinct window, in a JS
 * Set (roughly 40-60 bytes/entry). The real corpus (32k messages, mean 23.7 chars,
 * minMatch 8) lands near ~600k windows => ~30-50 MB. Budget accordingly; if you raise
 * minMatch the set shrinks fast. 32-bit hash collisions are possible in principle and
 * would only ever inflate the copy rate; at these sizes the expected collision count
 * is far below 1.
 *
 * Returns {rate, copied, total}.
 */
// Exact 32-bit rolling hash helpers, shared by copyRate and the case builder's
// leakage filter. Every step goes through Math.imul + >>>0, so the polynomial is
// computed modulo 2^32 with no float rounding (a float `h * BASE` would exceed 2^53
// and silently break the slide invariant).
function rollingWindows(chars, m, fn) {
  const BASE = 0x01000193;
  if (chars.length < m) return;
  let h = 0;
  for (let i = 0; i < m; i++) h = (Math.imul(h, BASE) + chars[i].codePointAt(0)) >>> 0;
  fn(h);
  let hpow = 1;
  for (let i = 0; i < m - 1; i++) hpow = Math.imul(hpow, BASE) >>> 0;
  for (let i = m; i < chars.length; i++) {
    const out = chars[i - m].codePointAt(0);
    const inC = chars[i].codePointAt(0);
    h = (Math.imul((h - Math.imul(out, hpow)) >>> 0, BASE) + inC) >>> 0;
    fn(h);
  }
}

/**
 * Set of hashes of every `m`-code-point window over `texts`. Used to test whether a
 * short string shares a >= m char verbatim substring with a corpus (the leakage filter
 * in build-cases.mjs). Same memory caveat as copyRate below.
 */
export function buildNgramHashSet(texts, m = 8) {
  const k = Math.max(2, Math.trunc(m));
  const set = new Set();
  for (const raw of texts || []) rollingWindows(toChars(raw), k, (h) => set.add(h));
  return set;
}

/** True if `text` contains a window hashed in `set` (i.e. shares an m-char substring). */
export function hasNgramMatch(text, set, m = 8) {
  const k = Math.max(2, Math.trunc(m));
  const chars = toChars(text);
  if (chars.length < k) return false;
  let hit = false;
  rollingWindows(chars, k, (h) => { if (!hit && set.has(h)) hit = true; });
  return hit;
}

/**
 * Fraction of `generatedTexts` that share a verbatim substring of >= minMatch code
 * points with ANY text in `corpusTexts`.
 *
 * MEMORY: the corpus n-gram set costs one 32-bit number per distinct window, in a JS
 * Set (roughly 40-60 bytes/entry). The real corpus (32k messages, mean 23.7 chars,
 * minMatch 8) lands near ~600k windows => ~30-50 MB. Budget accordingly; if you raise
 * minMatch the set shrinks fast. 32-bit hash collisions are possible in principle and
 * would only ever inflate the copy rate; at these sizes the expected collision count
 * is far below 1.
 *
 * Generated texts shorter than minMatch count as not copied (they cannot contain a
 * window of that length).
 *
 * Returns {rate, copied, total, minMatch, corpusWindows}.
 */
export function copyRate(generatedTexts, corpusTexts, { minMatch = 8 } = {}) {
  const m = Math.max(2, Math.trunc(minMatch));
  const set = buildNgramHashSet(corpusTexts, m);
  const gen = generatedTexts || [];
  let copied = 0;
  for (const raw of gen) if (hasNgramMatch(raw, set, m)) copied++;
  return { rate: gen.length ? copied / gen.length : null, copied, total: gen.length, minMatch: m, corpusWindows: set.size };
}

// ---------------------------------------------------------------------------
// recovery@k
// ---------------------------------------------------------------------------

/**
 * Rank of `target` inside `candidates` after scoring every candidate by
 * normEditDistance ascending (ties broken deterministically by candidate index, then
 * by string comparison).
 *
 *   recoveryAtK(cands, target)                  -> distance(candidate, target): the
 *       target is its own best match, so rank is 1 iff it is present, null otherwise.
 *   recoveryAtK(cands, target, {scoreAgainst})  -> distance(candidate, scoreAgainst),
 *       while the rank still refers to `target`. This is the form the harness uses:
 *       the pool is 20 sampled real TRAIN texts plus the real target, and the arm's
 *       generated text is what the pool is scored against.
 *
 * Returns {rank (1-based|null), rr (1/rank, 0 when null), hit (rank<=k), n}.
 */
export function recoveryAtK(candidates, target, { k = 20, scoreAgainst = null } = {}) {
  const cands = candidates || [];
  if (cands.length === 0) return { rank: null, rr: 0, hit: false, n: 0, k };
  const ref = scoreAgainst == null ? target : scoreAgainst;
  const scored = cands.map((c, i) => ({ c, i, d: normEditDistance(c, ref) }));
  scored.sort((a, b) => (a.d - b.d) || (a.i - b.i) || (a.c < b.c ? -1 : a.c > b.c ? 1 : 0));
  let rank = null;
  for (let r = 0; r < scored.length; r++) {
    if (scored[r].c === target) { rank = r + 1; break; }
  }
  return { rank, rr: rank ? 1 / rank : 0, hit: rank != null && rank <= k, n: cands.length, k };
}

// ---------------------------------------------------------------------------
// per-author character LM ("the only family with per-message power at 1-30 chars")
// ---------------------------------------------------------------------------

export const BOS = '\u0002'; // start-of-message marker
export const EOS = '\u0003'; // end-of-message marker

/**
 * Character 4-gram INTERPOLATED model with add-k smoothing, trained on one author's
 * messages.
 *
 * For each predicted character c with context ctx (up to order-1 previous chars):
 *
 *   P(c|ctx) = SUM over o in 1..order of
 *                w[o-1] * ( count_o(ctx,c) + k ) / ( count_o(ctx) + k*V )
 *
 * where V = |vocabulary| + 1, so even a never-seen character gets probability k/(k*V)
 * and no log(0) is possible. Levels whose context was never observed fall back to the
 * uniform-over-vocab distribution, and the lower-order terms keep the estimate sane.
 *
 * WHY THE MESSAGE MARKERS MATTER: with a 4-gram model and 1-30 char messages, EOS is
 * what makes "how much text, and does it end here" part of the likelihood. Each text
 * is scored as [BOS x (order-1)] + chars + [EOS], and bpc divides by (chars + 1) events
 * = "bits per character over the text-plus-end-marker sequence".
 *
 * This is the only metric family in this harness with real statistical power on a
 * single 14-character message, so it must be built from a WINDOW-SPLIT train file
 * (see build-cases.mjs) and never from the target text itself.
 *
 * Cost: one Map entry per observed context+char at each level. The real corpus (32k
 * messages, ~770k chars) yields ~0.9M entries => a few hundred MB while building.
 * `maxChars` caps the training text deterministically (texts in file order).
 */
export function perAuthorModel(texts, { order = 4, k = 0.1, weights = [0.1, 0.2, 0.3, 0.4], maxChars = 0 } = {}) {
  const ord = Math.max(1, Math.trunc(order));
  const kk = Number.isFinite(k) && k > 0 ? k : 0.1;
  let w = Array.isArray(weights) && weights.length >= ord ? weights.slice(0, ord) : null;
  if (!w) {
    w = new Array(ord).fill(1 / ord);
  }
  const wSum = w.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
  if (!(wSum > 0)) w = new Array(ord).fill(1 / ord);
  else w = w.map((x) => (Number.isFinite(x) && x > 0 ? x : 0) / wSum);

  const uni = new Map();
  const gram = new Array(ord + 1); // 1-based; gram[1] === uni
  const ctxTot = new Array(ord + 1);
  gram[1] = uni;
  for (let o = 2; o <= ord; o++) {
    gram[o] = new Map();
    ctxTot[o] = new Map();
  }
  const vocab = new Set();
  let events = 0;
  let chars = 0;
  const pad = BOS.repeat(ord - 1);

  for (const raw of texts || []) {
    if (!raw) continue;
    const cs = toChars(raw);
    if (maxChars > 0 && chars + cs.length + 1 > maxChars) break;
    chars += cs.length + 1;
    const seq = toChars(pad).concat(cs, [EOS]);
    for (let i = ord - 1; i < seq.length; i++) {
      const c = seq[i];
      vocab.add(c);
      uni.set(c, (uni.get(c) || 0) + 1);
      events++;
      for (let o = 2; o <= ord; o++) {
        const ctx = seq.slice(i - o + 1, i).join('');
        const key = ctx + '\u0000' + c;
        const m = gram[o];
        m.set(key, (m.get(key) || 0) + 1);
        ctxTot[o].set(ctx, (ctxTot[o].get(ctx) || 0) + 1);
      }
    }
  }

  return {
    order: ord,
    k: kk,
    weights: w,
    V: vocab.size + 1,
    vocabSize: vocab.size,
    uni,
    gram,
    ctxTot,
    events,
    trainChars: chars,
    trainTexts: (texts || []).length,
  };
}

/** -log2 P(char | context) under the interpolated model; never 0 due to add-k. */
export function charLogProbBits(model, ctx, ch) {
  const ord = model.order;
  let p = 0;
  const uni = model.gram[1];
  const uniTotal = model.events;
  p += model.weights[0] * (((uni.get(ch) || 0) + model.k) / (uniTotal + model.k * model.V));
  const ctxChars = typeof ctx === 'string' ? ctx : (ctx || []).join('');
  for (let o = 2; o <= ord; o++) {
    const c = ctxChars.slice(Math.max(0, ctxChars.length - (o - 1)));
    const key = c + '\u0000' + ch;
    const num = (model.gram[o].get(key) || 0) + model.k;
    const den = (model.ctxTot[o].get(c) || 0) + model.k * model.V;
    p += model.weights[o - 1] * (num / den);
  }
  if (!(p > 0) || !Number.isFinite(p)) return 60; // 2^-60 floor; unreachable with add-k
  return -Math.log2(p);
}

/**
 * Bits per character of `text` under `model` (see perAuthorModel for the exact
 * definition: events = characters + EOS). Returns null for empty/missing text.
 * Lower = more like the author. Guarded against log(0).
 */
export function bpc(model, text) {
  if (text == null || text === '') return null;
  const cs = toChars(text);
  const pad = BOS.repeat(model.order - 1);
  const seq = toChars(pad).concat(cs, [EOS]);
  let bits = 0;
  for (let i = model.order - 1; i < seq.length; i++) {
    const ctx = seq.slice(Math.max(0, i - model.order + 1), i).join('');
    bits += charLogProbBits(model, ctx, seq[i]);
  }
  return bits / (cs.length + 1);
}

// ---------------------------------------------------------------------------
// paired bootstrap CI (deterministic)
// ---------------------------------------------------------------------------

/**
 * Mean and percentile CI of the mean of paired `deltas` (arm A minus arm B per case).
 *
 * Deterministic: resampling uses a seeded LCG, so the same deltas + seed always give
 * the same interval. Non-finite entries are dropped; null/empty input => all nulls.
 *
 * Returns {mean, lo, hi, n, resamples, alpha, seed, method:'percentile-bootstrap'}.
 */
export function pairedBootstrapCI(deltas, { resamples = 10000, alpha = 0.05, seed = 12345 } = {}) {
  const d = (deltas || []).filter((x) => Number.isFinite(x));
  if (d.length === 0) return { mean: null, lo: null, hi: null, n: 0, resamples: 0, alpha, seed, method: 'percentile-bootstrap' };
  const observed = mean(d);
  if (d.length === 1) return { mean: observed, lo: observed, hi: observed, n: 1, resamples: 0, alpha, seed, method: 'percentile-bootstrap' };
  const rng = makeRng(seed);
  const n = d.length;
  const means = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(rng() * n)];
    means[r] = s / n;
  }
  means.sort((a, b) => a - b);
  return {
    mean: observed,
    lo: percentile(means, alpha / 2),
    hi: percentile(means, 1 - alpha / 2),
    n,
    resamples,
    alpha,
    seed,
    method: 'percentile-bootstrap',
  };
}

// ---------------------------------------------------------------------------
// composite
// ---------------------------------------------------------------------------

/** Component weights for the SFS composite. ===== PROPOSED DEFAULT, NOT A LITERATURE RESULT =====
 * These are a defensible starting point only. The instrument has to be calibrated on
 * the first two real runs (see README): measure the REAL ceiling and the RANDOM floor
 * per component, then re-pick the weights so the composite is monotone in human
 * judgement. Until that calibration exists, do not quote a composite number as a
 * verdict, and never compare composites produced under different weights.
 */
export const DEFAULT_SFS_WEIGHTS = {
  recovery: 0.35,       // recovery@k / MRR: can this text be picked out of a pool?
  predictability: 0.25, // per-author BPC: how likely is this text under the author's own LM?
  verifiability: 0.2,   // copy/memorisation penalties: verbatim reuse of train or persona text
  surface: 0.2,         // length/terseness, punctuation, laughter, code-switching
};

/**
 * Composite 0-100 score. Every component must already be normalised to [0,1] by the
 * caller (higher = better). `weights` defaults to DEFAULT_SFS_WEIGHTS; missing or
 * non-finite components are dropped and the remaining weights renormalise, so the
 * result stays in [0,100] even with an incomplete profile.
 * Returns {score, weights, components, dropped}.
 */
export function compositeSfs({ recovery, predictability, verifiability, surface, weights } = {}) {
  const given = { recovery, predictability, verifiability, surface };
  const w = { ...DEFAULT_SFS_WEIGHTS, ...(weights || {}) };
  let wSum = 0;
  const used = {};
  const dropped = [];
  for (const key of Object.keys(given)) {
    const val = given[key];
    const weight = Number.isFinite(w[key]) && w[key] > 0 ? w[key] : 0;
    if (val == null || !Number.isFinite(val) || weight === 0) { dropped.push(key); continue; }
    used[key] = { value: Math.min(1, Math.max(0, val)), weight };
    wSum += weight;
  }
  if (wSum === 0) return { score: null, weights: {}, components: {}, dropped };
  let acc = 0;
  const components = {};
  for (const [key, { value, weight }] of Object.entries(used)) {
    const nw = weight / wSum;
    components[key] = { value, weight: nw, contribution: value * nw };
    acc += value * nw;
  }
  return { score: 100 * acc, weights: Object.fromEntries(Object.entries(used).map(([k2, v]) => [k2, v.weight / wSum])), components, dropped };
}
