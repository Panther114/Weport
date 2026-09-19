#!/usr/bin/env node
/**
 * weclone-eval / harness.mjs — score clone outputs against a frozen case set.
 *
 *   node scripts/weclone-eval/harness.mjs \
 *     --cases .ui-probe/eval-cases \
 *     --clone "C:\\Users\\<user>\\AppData\\Roaming\\Weport\\weclone-staging\\<wxid>" \
 *     --out .ui-probe/eval-report.json \
 *     [--predictions clone-output.jsonl] [--seed 12345] [--pool-size 20] [--model-max-chars N]
 *
 * OFFLINE ARMS (no network, ever):
 *   REAL    the real held-out message itself — the ceiling of the instrument
 *   PARROT  best BM25 lexical match over the TRAIN window of voice.jsonl, cue as query
 *   RANDOM  a deterministic pseudo-random real TRAIN message — the floor
 *   CLONE   only with --predictions <file.jsonl>, one {"id","text"} per line. This
 *           harness NEVER calls a model; it only scores text you already produced.
 *
 * The report is written as JSON (full per-case rows included) and summarised as a
 * compact table. The reference-frame check prints FIRST: if RANDOM is not clearly
 * worse than REAL, or PARROT does not beat RANDOM on surface metrics, the instrument
 * is mis-calibrated and every other number in the run is suspect.
 *
 * PRIVACY: nothing here prints message content. It prints ids, labels and numbers only.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  chrf, normEditDistance, bpc, perAuthorModel, bucketOf, charLen, mean, median, percentile,
  punctuationProfile, casingProfile, codeSwitchProfile, lengthStats, histogramShares,
  histogramL1, charNgramDistribution, mergeDistributions, jensenShannon, copyRate,
  recoveryAtK, pairedBootstrapCI, compositeSfs, makeRng, hashString, toChars, ksStatistic,
} from './lib.mjs';

const SCHEMA = 'weclone-eval/report/v1';
const CHANCE = 1 / 21; // 20 sampled train texts + the real target
const NULL_SAMPLES = 5; // held-out real train messages per case for the length-matched bpc null

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (args.help || !args.cases || !args.out) {
  console.log(`weclone-eval harness

required:
  --cases <dir>          output of build-cases.mjs (cases.jsonl + manifest.json + train-voice.jsonl)
  --out <report.json>    where to write the full JSON report
optional:
  --clone <cloneDir>     the clone directory the cases came from; used to verify the corpus
                         sha1s against the manifest, to read the persona .md files, and to
                         score memorisation of persona text (copyRate vs persona)
  --predictions <file>   JSONL of {"id","text"} to score as the CLONE arm
  --seed <n>             seed for the RANDOM arm and the candidate pools (default 12345)
  --pool-size <n>        candidate pool size, target included (default 20)
  --k <n>                recovery@k cut-off (default 20)
  --resamples <n>        bootstrap resamples (default 10000)
  --model-max-chars <n>  cap the per-author model's training text (default: no cap)
`);
  process.exit(args.help ? 0 : 2);
}

const casesDir = path.resolve(String(args.cases));
const outPath = path.resolve(String(args.out));
const cloneDir = args.clone ? path.resolve(String(args.clone)) : null;
const predictionsPath = args.predictions ? path.resolve(String(args.predictions)) : null;
const seed = Number(args.seed ?? 12345);
const poolSize = Math.max(2, Number(args['pool-size'] ?? 20));
const k = Math.max(1, Number(args.k ?? 20));
const resamples = Math.max(100, Number(args['resamples'] ?? 10000));
const modelMaxChars = args['model-max-chars'] ? Number(args['model-max-chars']) : 0;

const t0 = process.hrtime.bigint();
const msSince = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const rssMb = () => process.memoryUsage().rss / 1048576;
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const num = (x, d = 3) => (x == null || !Number.isFinite(x) ? '-' : x.toFixed(d));
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// load case set
// ---------------------------------------------------------------------------
const casesPath = path.join(casesDir, 'cases.jsonl');
const manifestPath = path.join(casesDir, 'manifest.json');
const trainVoicePath = path.join(casesDir, 'train-voice.jsonl');
for (const p of [casesPath, manifestPath, trainVoicePath]) {
  if (!fs.existsSync(p)) {
    console.error(`missing ${p} — run build-cases.mjs first`);
    process.exit(2);
  }
}
const casesBuf = fs.readFileSync(casesPath);
const cases = casesBuf.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const trainBuf = fs.readFileSync(trainVoicePath);
const trainTexts = trainBuf.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (cases.length === 0 || trainTexts.length === 0) {
  console.error('empty case set or empty train-voice.jsonl');
  process.exit(2);
}
console.log(`cases      ${cases.length} from ${casesPath}`);
console.log(`train      ${trainTexts.length} author messages (train-voice.jsonl, sha1 ${manifest.files?.trainVoiceSha1?.slice(0, 12) ?? '?'})`);
console.log(`manifest   ${manifest.schema} built ${manifest.generatedAt} boundary ${manifest.split?.boundaryIso} chance level ${(CHANCE * 100).toFixed(2)}%`);

// ---------------------------------------------------------------------------
// verify the corpus the cases came from + persona markdown
// ---------------------------------------------------------------------------
let cloneCheck = { provided: Boolean(cloneDir), ok: null, notes: [], personaFiles: [], personaChars: 0 };
const personaTexts = [];
if (cloneDir) {
  const chunkPath = path.join(cloneDir, 'chunks.jsonl');
  const voicePath = path.join(cloneDir, 'voice.jsonl');
  const haveBoth = fs.existsSync(chunkPath) && fs.existsSync(voicePath);
  if (haveBoth) {
    const chunkSha = sha1(fs.readFileSync(chunkPath));
    const voiceSha = sha1(fs.readFileSync(voicePath));
    cloneCheck.chunksSha1 = chunkSha;
    cloneCheck.voiceSha1 = voiceSha;
    cloneCheck.ok = chunkSha === manifest.corpus?.chunksSha1 && voiceSha === manifest.corpus?.voiceSha1;
    if (!cloneCheck.ok) {
      cloneCheck.notes.push(`corpus sha1 mismatch: the case set was built from a DIFFERENT corpus revision than ${cloneDir}`);
    }
  } else {
    cloneCheck.notes.push(`no chunks.jsonl/voice.jsonl under ${cloneDir}`);
  }
  const mds = fs.readdirSync(cloneDir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  for (const f of mds) {
    const txt = fs.readFileSync(path.join(cloneDir, f), 'utf8');
    personaTexts.push(txt);
    cloneCheck.personaFiles.push({ file: f, chars: txt.length, sha1: sha1(Buffer.from(txt)).slice(0, 12) });
  }
  cloneCheck.personaChars = personaTexts.reduce((a, t) => a + t.length, 0);
}
console.log(`clone dir  ${cloneDir ?? '(not given)'}${cloneCheck.ok === true ? '  corpus sha1 OK' : cloneCheck.ok === false ? '  CORPUS SHA1 MISMATCH' : ''}${personaTexts.length ? `  persona md ${personaTexts.length} files / ${cloneCheck.personaChars} chars` : ''}`);
for (const n of cloneCheck.notes) console.log(`           note: ${n}`);

// ---------------------------------------------------------------------------
// per-author model (TRAIN window only) + author surface baseline
//
// CALIBRATION SPLIT: bpc is length-dependent (measured on this corpus: ~4.6 bits/char
// for 1-3 char messages, ~5.6 at 4-8, ~3.7 at 31-60) AND a model scores text it was
// trained on optimistically. So 10% of the TRAIN window is held out of the model
// entirely and used for (a) the RANDOM arm and (b) the length-bucket-matched BPC null.
// All three offline arms are then model-unseen text and the bpc comparison is
// apples-to-apples. The model never sees the TEST window in any configuration.
// ---------------------------------------------------------------------------
const calibFrac = args['calib-frac'] !== undefined ? Math.min(0.5, Math.max(0, Number(args['calib-frac']))) : 0.1;
const modelTexts = [];
const calibTexts = [];
for (const t of trainTexts) (hashString(t) % 1000 < Math.round(calibFrac * 1000) ? calibTexts : modelTexts).push(t);
if (calibTexts.length < 20) {
  console.log('note       calibration slice too small — falling back to the full train window for the model and the nulls (bpc will be optimistic on train text)');
  modelTexts.push(...calibTexts);
  calibTexts.length = 0;
  calibTexts.push(...trainTexts);
}
const calibByBucket = new Map();
for (const t of calibTexts) {
  const b = bucketOf(charLen(t));
  if (!calibByBucket.has(b)) calibByBucket.set(b, []);
  calibByBucket.get(b).push(t);
}

const tModel = process.hrtime.bigint();
const model = perAuthorModel(modelTexts, { order: 4, k: 0.1, weights: [0.1, 0.2, 0.3, 0.4], maxChars: modelMaxChars });
const modelBuildMs = msSince(tModel);
console.log(`model      char 4-gram interpolated, vocab ${model.vocabSize}, ${model.events} events, ${model.trainChars} chars, built in ${modelBuildMs.toFixed(0)} ms, rss ${rssMb().toFixed(0)} MB`);
console.log(`calib      ${modelTexts.length} model-train / ${calibTexts.length} held-out (${(calibFrac * 100).toFixed(0)}%) TRAIN-window messages used for the RANDOM arm and the BPC null`);

// static unigram distribution over the model vocab, for the random-string control
const uniDist = (() => {
  const chars = [];
  const cum = [];
  let acc = 0;
  for (const [ch, n] of model.uni) { chars.push(ch); acc += n; cum.push(acc); }
  return { chars, cum, total: acc };
})();
function randomStringLike(len, rng) {
  const out = [];
  for (let i = 0; i < len; i++) {
    const x = rng() * uniDist.total;
    let lo = 0;
    let hi = uniDist.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (uniDist.cum[mid] < x) lo = mid + 1; else hi = mid; }
    out.push(uniDist.chars[lo]);
  }
  return out.join('');
}

const authorTargets = cases.map((c) => c.target);
const authorSurface = {
  length: lengthStats(trainTexts),
  punctuation: punctuationProfile(trainTexts),
  casing: casingProfile(trainTexts),
  codeSwitch: codeSwitchProfile(trainTexts),
  lengthShares: histogramShares(trainTexts.map(charLen)),
};
const authorBigrams = mergeDistributions(trainTexts.map((t) => charNgramDistribution(t, 2)));
const authorTargetLengths = authorTargets.map(charLen);
// Second, gate-ready reference frame: the case set's own targets. The author's whole
// train corpus is the absolute realism reference, but the case set is deliberately
// stratified and leakage-filtered, so it sits a bit shorter than the corpus; measuring
// an arm against the case set's own targets compares like with like (and makes REAL
// exactly zero by construction — it IS the reference).
const targetSurface = {
  length: lengthStats(authorTargets),
  lengthShares: histogramShares(authorTargetLengths),
  punctuation: punctuationProfile(authorTargets),
  casing: casingProfile(authorTargets),
  codeSwitch: codeSwitchProfile(authorTargets),
};

// ---------------------------------------------------------------------------
// PARROT: BM25-ish lexical retrieval over the TRAIN window
// ---------------------------------------------------------------------------
const RE_LATIN_TOKEN = /[a-z0-9']+/g;
const RE_CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

/** Latin words + CJK character bigrams (plus single chars for 1-char runs). */
function tokenize(text) {
  const toks = [];
  const lower = String(text || '').toLowerCase();
  const latin = lower.match(RE_LATIN_TOKEN);
  if (latin) for (const t of latin) toks.push('w:' + t);
  const runs = lower.match(RE_CJK_RUN);
  if (runs) {
    for (const run of runs) {
      const cs = toChars(run);
      if (cs.length === 1) toks.push('c:' + cs[0]);
      for (let i = 0; i + 2 <= cs.length; i++) toks.push('c:' + cs[i] + cs[i + 1]);
    }
  }
  return toks;
}

const tBm25 = process.hrtime.bigint();
const postings = new Map(); // term -> array of [docIdx, tf]
const docLens = new Array(trainTexts.length);
let docLenSum = 0;
trainTexts.forEach((text, docIdx) => {
  const toks = tokenize(text);
  docLens[docIdx] = toks.length;
  docLenSum += toks.length;
  const tf = new Map();
  for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [t, n] of tf) {
    let p = postings.get(t);
    if (!p) { p = []; postings.set(t, p); }
    p.push([docIdx, n]);
  }
});
const avgdl = docLenSum / Math.max(1, trainTexts.length);
const N = trainTexts.length;
const idfCache = new Map();
function idf(term) {
  let v = idfCache.get(term);
  if (v === undefined) {
    const df = postings.get(term)?.length || 0;
    v = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    idfCache.set(term, v);
  }
  return v;
}
const K1 = 1.2;
const B = 0.75;

/**
 * Best-scoring train message for a cue; deterministic (ties -> lowest doc index).
 * The query is the last couple of cue lines (the message(s) being answered) — feeding
 * the whole 1200-char cue buries the relevant words in the other party's older text.
 */
function parrotPick(cue) {
  const lines = String(cue || '').split('\n').filter((l) => l.trim().length > 0);
  const query = lines.slice(-2).join('\n');
  let best = bm25Best(query);
  if (best == null) best = bm25Best(cue); // fall back to the whole cue
  return best;
}

function bm25Best(query) {
  const toks = tokenize(query);
  const scores = new Map();
  for (const t of toks) {
    const p = postings.get(t);
    if (!p) continue;
    const w = idf(t);
    for (const [docIdx, tf] of p) {
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * docLens[docIdx] / avgdl));
      scores.set(docIdx, (scores.get(docIdx) || 0) + w * norm);
    }
  }
  if (scores.size === 0) return null;
  let best = -1;
  let bestScore = -Infinity;
  for (const [docIdx, s] of scores) {
    if (s > bestScore || (s === bestScore && docIdx < best)) { best = docIdx; bestScore = s; }
  }
  return best;
}
const bm25BuildMs = msSince(tBm25);
console.log(`parrot     BM25 index: ${postings.size} terms over ${N} train messages, built in ${bm25BuildMs.toFixed(0)} ms`);

// ---------------------------------------------------------------------------
// CLONE arm from --predictions
// ---------------------------------------------------------------------------
const predictions = new Map();
let predictionStats = { lines: 0, bad: 0, empty: 0 };
if (predictionsPath) {
  for (const line of fs.readFileSync(predictionsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    predictionStats.lines++;
    let o;
    try { o = JSON.parse(line); } catch { predictionStats.bad++; continue; }
    if (!o || typeof o.id !== 'string') { predictionStats.bad++; continue; }
    const text = typeof o.text === 'string' ? o.text : '';
    if (!text.trim()) { predictionStats.empty++; continue; }
    predictions.set(o.id, text);
  }
  console.log(`clone arm  ${predictions.size} usable predictions of ${predictionStats.lines} lines (${predictionStats.bad} malformed, ${predictionStats.empty} empty)`);
  const idSet = new Set(cases.map((c) => c.id));
  predictionStats.unmatched = 0;
  for (const id of predictions.keys()) if (!idSet.has(id)) predictionStats.unmatched++;
  const covered = cases.filter((c) => predictions.has(c.id)).length;
  predictionStats.covered = covered;
  console.log(`           covers ${covered}/${cases.length} cases (${predictionStats.unmatched} predictions match no case id; uncovered cases are counted as missing for this arm, not as failures)`);
}

// ---------------------------------------------------------------------------
// arms + per-case metrics
// ---------------------------------------------------------------------------
const ARMS = ['REAL', 'PARROT', 'RANDOM'];
if (predictionsPath) ARMS.push('CLONE');

const chance = 1 / (poolSize + 1);
const randomRng = makeRng(seed);
const perCase = [];
const copyStore = { trainHits: {}, personaHits: {} };
const armTexts = {};
for (const a of ARMS) armTexts[a] = [];
let parrotNoHit = 0;
let poolDedup = 0;

for (let ci = 0; ci < cases.length; ci++) {
  const c = cases[ci];
  const target = c.target;
  const targetBucket = bucketOf(charLen(target));
  // deterministic candidate pool: poolSize unique TRAIN messages + the target
  const poolRng = makeRng((seed ^ hashString(c.id)) >>> 0);
  const pool = [];
  const poolSeen = new Set([target]);
  for (let guard = 0; pool.length < poolSize && guard < poolSize * 20; guard++) {
    const pick = trainTexts[Math.floor(poolRng() * trainTexts.length)];
    if (poolSeen.has(pick)) { poolDedup++; continue; }
    poolSeen.add(pick);
    pool.push(pick);
  }
  pool.push(target);
  const options = pool.length;

  // length-matched BPC null: real messages the model has never seen, same length bucket
  const nullPool = calibByBucket.get(targetBucket) || calibTexts;
  const nullN = Math.min(NULL_SAMPLES, nullPool.length);
  const nullBpcs = [];
  for (let i = 0; i < nullN; i++) {
    const v = bpc(model, nullPool[Math.floor(poolRng() * nullPool.length)]);
    if (Number.isFinite(v)) nullBpcs.push(v);
  }
  const bpcNull = mean(nullBpcs);
  // random-string control: unigram-random text at the target's length
  const stringRng = makeRng((seed ^ hashString('str:' + c.id)) >>> 0);
  const stringBpcs = [];
  for (let i = 0; i < 3; i++) {
    const v = bpc(model, randomStringLike(charLen(target), stringRng));
    if (Number.isFinite(v)) stringBpcs.push(v);
  }
  const bpcString = mean(stringBpcs);

  const outs = {
    REAL: target,
    PARROT: null,
    RANDOM: calibTexts[Math.floor(randomRng() * calibTexts.length)],
  };
  const parrotIdx = parrotPick(c.cue);
  if (parrotIdx == null) parrotNoHit++;
  outs.PARROT = parrotIdx == null ? outs.RANDOM : trainTexts[parrotIdx];
  if (predictionsPath) outs.CLONE = predictions.get(c.id) ?? null;

  const row = {
    id: c.id, sid: c.sid, ts: c.ts, functionLabel: c.functionLabel, todLabel: c.todLabel,
    cueChars: c.cueChars, targetChars: charLen(target), targetBucket, poolOptions: options,
    bpcNull, bpcString, arms: {},
  };
  for (const arm of ARMS) {
    const text = outs[arm];
    if (text == null) { row.arms[arm] = { missing: true }; continue; }
    armTexts[arm].push(text);
    const rec = recoveryAtK(pool, target, { k, scoreAgainst: text });
    const armBpc = bpc(model, text);
    row.arms[arm] = {
      chars: charLen(text),
      lengthBucket: bucketOf(charLen(text)),
      lengthBucketAgreement: bucketOf(charLen(text)) === targetBucket ? 1 : 0,
      ned: normEditDistance(text, target),
      chrf: chrf(text, target),
      bpc: armBpc,
      bpcVsNull: Number.isFinite(armBpc) && Number.isFinite(bpcNull) && bpcNull > 0 ? armBpc / bpcNull : null,
      recoveryRank: rec.rank,
      rr: rec.rr,
      recoveryHit: rec.hit ? 1 : 0,
    };
  }
  perCase.push(row);
  if (args['include-texts']) {
    row._target = target;
    row._cue = c.cue;
    row._texts = { ...outs };
  }
  if ((ci + 1) % 250 === 0) console.log(`  ... scored ${ci + 1}/${cases.length} cases (rss ${rssMb().toFixed(0)} MB)`);
}

// ---------------------------------------------------------------------------
// aggregates
// ---------------------------------------------------------------------------
const metricDefs = {
  chrf: { label: 'chrF', better: 'higher' },
  ned: { label: 'normEditDist', better: 'lower' },
  bc: { label: 'lenBucket=target', better: 'higher' },
  bpc: { label: 'bpc', better: 'lower' },
  rr: { label: 'recip-rank', better: 'higher' },
};

function armAggregate(arm) {
  const rows = perCase.map((r) => r.arms[arm]).filter((x) => x && !x.missing);
  const get = (f) => rows.map(f).filter((v) => Number.isFinite(v));
  const ch = get((x) => x.chrf);
  const nd = get((x) => x.ned);
  const bc = get((x) => x.lengthBucketAgreement);
  const bp = get((x) => x.bpc);
  const bpn = get((x) => x.bpcVsNull);
  const rr = get((x) => x.rr);
  const ranks = rows.map((x) => x.recoveryRank);
  const present = ranks.filter((r) => r != null);
  const at = (limit) => (present.length ? present.filter((r) => r <= limit).length / present.length : null);
  const texts = armTexts[arm];
  const copyTrain = copyRate(texts, trainTexts, { minMatch: 8 });
  const copyPersona = personaTexts.length ? copyRate(texts, personaTexts, { minMatch: 8 }) : null;
  copyStore.trainHits[arm] = copyTrain;
  copyStore.personaHits[arm] = copyPersona;
  const punct = punctuationProfile(texts);
  const casing = casingProfile(texts);
  const codeSwitch = codeSwitchProfile(texts);
  const len = lengthStats(texts);
  const shares = histogramShares(texts.map(charLen));
  const bigrams = mergeDistributions(texts.map((t) => charNgramDistribution(t, 2)));
  const surface = {
    lengthMean: len.mean, lengthMedian: len.median, lengthStdev: len.stdev,
    lengthBucketShares: shares,
    lengthBucketL1: histogramL1(shares, authorSurface.lengthShares),
    lengthKsVsAuthor: ksStatistic(texts.map(charLen), trainTexts.slice(0, 5000).map(charLen)),
    hasPunct: punct.hasAnyPunct, endsSentencePunct: punct.endsWithSentencePunct,
    question: punct.question, ellipsis: punct.ellipsis, laugh: punct.laugh,
    stickerPlaceholder: punct.stickerPlaceholder, bracketTag: punct.bracketTag, emoji: punct.emoji,
    charPunctRatio: punct.charPunctRatio,
    lowercaseLetterRatio: casing.lowercaseLetterRatio, apostropheOmittedRate: casing.apostropheOmittedRate,
    allCapsTokenRate: casing.allCapsTokenRate,
    latinCharRatio: codeSwitch.latinCharRatio, cjkCharRatio: codeSwitch.cjkCharRatio, mixedRate: codeSwitch.mixedRate,
    jsdCharBigramVsAuthor: jensenShannon(bigrams, authorBigrams),
  };
  const deltas = {
    lengthMean: len.mean - authorSurface.length.mean,
    hasPunct: (punct.hasAnyPunct ?? 0) - (authorSurface.punctuation.hasAnyPunct ?? 0),
    endsSentencePunct: (punct.endsWithSentencePunct ?? 0) - (authorSurface.punctuation.endsWithSentencePunct ?? 0),
    question: (punct.question ?? 0) - (authorSurface.punctuation.question ?? 0),
    laugh: (punct.laugh ?? 0) - (authorSurface.punctuation.laugh ?? 0),
    stickerPlaceholder: (punct.stickerPlaceholder ?? 0) - (authorSurface.punctuation.stickerPlaceholder ?? 0),
    emoji: (punct.emoji ?? 0) - (authorSurface.punctuation.emoji ?? 0),
    lowercaseLetterRatio: (casing.lowercaseLetterRatio ?? 0) - (authorSurface.casing.lowercaseLetterRatio ?? 0),
    apostropheOmittedRate: (casing.apostropheOmittedRate ?? 0) - (authorSurface.casing.apostropheOmittedRate ?? 0),
    latinCharRatio: (codeSwitch.latinCharRatio ?? 0) - (authorSurface.codeSwitch.latinCharRatio ?? 0),
    cjkCharRatio: (codeSwitch.cjkCharRatio ?? 0) - (authorSurface.codeSwitch.cjkCharRatio ?? 0),
    mixedRate: (codeSwitch.mixedRate ?? 0) - (authorSurface.codeSwitch.mixedRate ?? 0),
  };
  // the same deltas against the case set's own targets (gate-ready; REAL is 0 there)
  const surfaceVsTargets = {
    lengthMean: len.mean - targetSurface.length.mean,
    lengthRelError: targetSurface.length.mean ? Math.abs((len.mean ?? 0) - targetSurface.length.mean) / targetSurface.length.mean : null,
    lengthBucketL1: histogramL1(shares, targetSurface.lengthShares),
    hasPunct: (punct.hasAnyPunct ?? 0) - (targetSurface.punctuation.hasAnyPunct ?? 0),
    endsSentencePunct: (punct.endsWithSentencePunct ?? 0) - (targetSurface.punctuation.endsWithSentencePunct ?? 0),
    question: (punct.question ?? 0) - (targetSurface.punctuation.question ?? 0),
    laugh: (punct.laugh ?? 0) - (targetSurface.punctuation.laugh ?? 0),
    stickerPlaceholder: (punct.stickerPlaceholder ?? 0) - (targetSurface.punctuation.stickerPlaceholder ?? 0),
    emoji: (punct.emoji ?? 0) - (targetSurface.punctuation.emoji ?? 0),
    mixedRate: (codeSwitch.mixedRate ?? 0) - (targetSurface.codeSwitch.mixedRate ?? 0),
    latinCharRatio: (codeSwitch.latinCharRatio ?? 0) - (targetSurface.codeSwitch.latinCharRatio ?? 0),
    allCapsTokenRate: (casing.allCapsTokenRate ?? 0) - (targetSurface.casing.allCapsTokenRate ?? 0),
  };
  return {
    n: rows.length,
    missing: perCase.length - rows.length,
    chrf: { mean: mean(ch), median: median(ch) },
    ned: { mean: mean(nd), median: median(nd) },
    lengthBucketAgreement: { mean: mean(bc), median: median(bc) },
    bpc: { mean: mean(bp), median: median(bp) },
    bpcVsNull: { mean: mean(bpn), median: median(bpn), shareBetterThanNull: bpn.length ? bpn.filter((x) => x < 1).length / bpn.length : null, n: bpn.length },
    recovery: { recoveryAt1: at(1), recoveryAt5: at(5), [`recoveryAt${k}`]: at(k), mrr: mean(rr), targetInPool: present.length / Math.max(1, rows.length) },
    copyRate: { vsTrain: copyTrain, vsPersona: copyPersona },
    surface,
    surfaceDeltas: deltas,
    surfaceVsTargets,
  };
}

const arms = {};
for (const arm of ARMS) arms[arm] = armAggregate(arm);

// ---------------------------------------------------------------------------
// paired bootstrap CIs (paired per case: same cases, two arms)
// ---------------------------------------------------------------------------
const pairMetrics = [
  { key: 'chrf', get: (x) => x.chrf, better: 'higher' },
  { key: 'ned', get: (x) => x.ned, better: 'lower' },
  { key: 'bpcVsNull', get: (x) => x.bpcVsNull, better: 'lower' },
  { key: 'rr', get: (x) => x.rr, better: 'higher' },
  { key: 'lengthBucketAgreement', get: (x) => x.lengthBucketAgreement, better: 'higher' },
];
const pairs = [];
for (let i = 0; i < ARMS.length; i++) {
  for (let j = i + 1; j < ARMS.length; j++) {
    const a = ARMS[i];
    const b = ARMS[j];
    const metrics = {};
    for (const m of pairMetrics) {
      const deltas = [];
      for (const row of perCase) {
        const ra = row.arms[a];
        const rb = row.arms[b];
        if (!ra || !rb || ra.missing || rb.missing) continue;
        const va = m.get(ra);
        const vb = m.get(rb);
        if (Number.isFinite(va) && Number.isFinite(vb)) deltas.push(va - vb);
      }
      const ci = pairedBootstrapCI(deltas, { resamples, alpha: 0.05, seed });
      metrics[m.key] = { ...ci, better: m.better, favours: ci.mean == null ? null : (ci.mean === 0 ? 'tie' : ((m.better === 'higher') === (ci.mean > 0) ? a : b)), excludesZero: ci.lo != null && (ci.lo > 0 || ci.hi < 0) };
    }
    pairs.push({ a, b, metrics });
  }
}

// ---------------------------------------------------------------------------
// reference-frame check — print FIRST, before any result is trusted
// ---------------------------------------------------------------------------
const rfChecks = [];
function rf(name, ok, detail) { rfChecks.push({ name, ok: Boolean(ok), detail }); }
const chrfGap = (arms.REAL.chrf.mean ?? 0) - (arms.RANDOM.chrf.mean ?? 0);
const nedGap = (arms.RANDOM.ned.mean ?? 0) - (arms.REAL.ned.mean ?? 0);
rf('REAL chrF - RANDOM chrF >= 0.20', chrfGap >= 0.2, `gap=${num(chrfGap)} (REAL ${num(arms.REAL.chrf.mean)} vs RANDOM ${num(arms.RANDOM.chrf.mean)})`);
rf('RANDOM normEditDist - REAL >= 0.30', nedGap >= 0.3, `gap=${num(nedGap)} (REAL ${num(arms.REAL.ned.mean)} vs RANDOM ${num(arms.RANDOM.ned.mean)})`);
rf('REAL recovery@1 is the ceiling (>= 0.99)', (arms.REAL.recovery.recoveryAt1 ?? 0) >= 0.99, `REAL R@1=${num(arms.REAL.recovery.recoveryAt1)}`);
rf(`RANDOM recovery@1 near chance (<= ${num(2.5 * chance)})`, (arms.RANDOM.recovery.recoveryAt1 ?? 1) <= 2.5 * chance, `RANDOM R@1=${num(arms.RANDOM.recovery.recoveryAt1)} vs chance ${num(chance)}`);
// BPC is only meaningful against a LENGTH-MATCHED null built from real text the model
// never saw (bpc is strongly length-dependent and train text scores optimistically).
const nullReal = arms.REAL.bpcVsNull.mean;
const nullRandom = arms.RANDOM.bpcVsNull.mean;
rf('BPC null calibrated on REAL (|x-1| <= 0.20)', nullReal != null && Math.abs(nullReal - 1) <= 0.2, `REAL bpc/null = ${num(nullReal)}`);
rf('BPC null calibrated on RANDOM (|x-1| <= 0.25)', nullRandom != null && Math.abs(nullRandom - 1) <= 0.25, `RANDOM bpc/null = ${num(nullRandom)}`);
const stringNull = mean(perCase.map((r) => (Number.isFinite(r.bpcString) && Number.isFinite(r.bpcNull) && r.bpcNull > 0 ? r.bpcString / r.bpcNull : null)).filter(Number.isFinite));
// Paired, in bits/char units relative to the same null: how much more predictable real
// held-out text is than unigram-random strings of the same length.
const bpcNoiseGap = mean(perCase.map((r) => (Number.isFinite(r.bpcString) && Number.isFinite(r.bpcNull) && r.bpcNull > 0 && Number.isFinite(r.arms.REAL?.bpc)
  ? (r.bpcString - r.arms.REAL.bpc) / r.bpcNull : null)).filter(Number.isFinite));
rf('BPC separates real text from unigram noise (paired gap >= 0.10 bits/char)', bpcNoiseGap != null && bpcNoiseGap >= 0.10, `real text is ${num(bpcNoiseGap)} bits/char (null units) more predictable than unigram-random strings`);
const parrotBeatsRandom = (arms.PARROT.chrf.mean ?? -Infinity) > (arms.RANDOM.chrf.mean ?? Infinity)
  || (arms.PARROT.ned.mean ?? Infinity) < (arms.RANDOM.ned.mean ?? -Infinity);
rf('PARROT beats RANDOM on a surface metric', parrotBeatsRandom, `chrF ${num(arms.PARROT.chrf.mean)} vs ${num(arms.RANDOM.chrf.mean)}, normEditDist ${num(arms.PARROT.ned.mean)} vs ${num(arms.RANDOM.ned.mean)}`);
const rfOk = rfChecks.every((c) => c.ok);

console.log('');
console.log('='.repeat(78));
console.log('REFERENCE FRAME (read this before any other number)');
console.log('='.repeat(78));
for (const c of rfChecks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${pad(c.name, 46)} ${c.detail}`);
if (!rfOk) {
  console.log('');
  console.log('  ############################################################################');
  console.log('  #  !! WARNING: THE INSTRUMENT LOOKS MIS-CALIBRATED !!                      #');
  console.log('  #  REAL (the real held-out message) must sit clearly above RANDOM, and     #');
  console.log('  #  PARROT (a real TRAIN message picked by cue similarity) must beat RANDOM #');
  console.log('  #  on surface metrics. One of those is false here, so either the case set  #');
  console.log('  #  is degenerate (too few/too short targets, broken cues), the arm wiring  #');
  console.log('  #  is wrong, or the metrics are not measuring surface similarity.          #');
  console.log('  #  DO NOT report the arm numbers below as evidence until this is fixed.    #');
  console.log('  ############################################################################');
} else {
  console.log('  frame OK: REAL > PARROT/CLONE > RANDOM ordering is at least possible to detect.');
}
console.log('');

// ---------------------------------------------------------------------------
// composite (weights are a proposal — see README)
// ---------------------------------------------------------------------------
const composite = {
  note: 'DEFAULT_SFS_WEIGHTS are a PROPOSED default, not a literature result; re-calibrate after the first two real runs. predictability is anchored to the length-matched null built from held-out real text (bpc/null = 1 => 1.0) and to this run\'s unigram-random-string control (=> 0.0), NOT to the REAL arm, because the test window is measurably less predictable than the train window. Text MORE predictable than a real unseen message also clamps to 1.0: memorisation is penalised by verifiability(copyRate), not here.',
  ceiling: null,
  weights: null,
  arms: {},
};
{
  const predLow = 1.0;        // bpc/null of a real unseen message == human baseline
  const predHigh = stringNull; // unigram-random strings of the same length == noise
  for (const arm of ARMS) {
    const x = arms[arm];
    const ratio = x.bpcVsNull.mean;
    const pred = (Number.isFinite(ratio) && Number.isFinite(predHigh) && predHigh > predLow)
      ? Math.min(1, Math.max(0, (predHigh - ratio) / (predHigh - predLow)))
      : null;
    const lenErr = targetSurface.length.mean ? Math.abs((x.surface.lengthMean ?? 0) - targetSurface.length.mean) / targetSurface.length.mean : null;
    const surfaceComp = lenErr == null ? null : 1 - Math.min(1, Math.max((x.surfaceVsTargets.lengthBucketL1 ?? 0) / 2, lenErr));
    const copyTrainRate = x.copyRate.vsTrain?.rate;
    const sfs = compositeSfs({
      recovery: x.recovery.mrr,
      predictability: pred,
      verifiability: copyTrainRate == null ? null : 1 - copyTrainRate,
      surface: surfaceComp,
    });
    composite.weights = composite.weights || sfs.weights;
    composite.arms[arm] = { score: sfs.score, components: sfs.components, dropped: sfs.dropped, raw: { mrr: x.recovery.mrr, bpcVsNull: ratio, predictability: pred, copyRateVsTrain: copyTrainRate, surfaceSim: surfaceComp } };
  }
  composite.ceiling = {
    arm: 'REAL',
    score: composite.arms.REAL?.score ?? null,
    note: 'REAL is the empirical ceiling of the composite on this case set, not 100: verifiability tops out at 1 - REAL\'s own copy rate (~0.25 here, i.e. the base rate at which real author messages repeat an 8-char window of the train corpus) and predictability tops out at ~0.77 because the test window is ~9% less predictable than the train window. Read the other arms as a fraction of this ceiling.',
    predictabilityAnchors: { realUnseenMessage: predLow, unigramRandomStrings: predHigh },
    verifiabilityAnchor: '1 - copyRate(vs train); the REAL arm shows the human base rate for this corpus',
  };
}

// ---------------------------------------------------------------------------
// human-readable summary (numbers and labels only — never message content)
// ---------------------------------------------------------------------------
const armList = ARMS.slice();
console.log('='.repeat(78));
console.log(`ARMS  (${cases.length} cases, candidate pool ${poolSize + 1} options, chance R@1 = ${(chance * 100).toFixed(2)}%)`);
console.log('='.repeat(78));
console.log(`  ${pad('arm', 8)}${padL('n', 5)}${padL('chrF', 8)}${padL('ned', 8)}${padL('bucket', 8)}${padL('bpc', 8)}${padL('bpc/null', 10)}${padL('R@1', 8)}${padL('R@5', 8)}${padL(`R@${k}`, 8)}${padL('MRR', 8)}${padL('copy', 8)}${padL('copyMd', 8)}`);
for (const arm of armList) {
  const x = arms[arm];
  console.log(`  ${pad(arm, 8)}${padL(x.n, 5)}${padL(num(x.chrf.mean), 8)}${padL(num(x.ned.mean), 8)}${padL(num(x.lengthBucketAgreement.mean), 8)}${padL(num(x.bpc.mean), 8)}${padL(num(x.bpcVsNull.mean), 10)}${padL(num(x.recovery.recoveryAt1), 8)}${padL(num(x.recovery.recoveryAt5), 8)}${padL(num(x.recovery[`recoveryAt${k}`]), 8)}${padL(num(x.recovery.mrr), 8)}${padL(num(x.copyRate.vsTrain?.rate), 8)}${padL(num(x.copyRate.vsPersona?.rate), 8)}`);
}
console.log('  chrF/bucket/MRR higher is better; ned/bpc lower is better; copy = share of messages sharing >=8 chars verbatim with the arm corpus.');
console.log(`  bpc/null = bpc divided by the length-bucket-matched mean bpc of up to ${NULL_SAMPLES} real HELD-OUT train messages the model never saw.`);
console.log('  ~1.0 means "as predictable as a real unseen message of the same length"; >1 means less author-like than that null.');
console.log(`  reference: unigram-random strings of the same length score ${num(stringNull)}x that null (real text is ${num(bpcNoiseGap)} bits/char more predictable).`);
console.log(`  medians: ${armList.map((a) => `${a} chrF ${num(arms[a].chrf.median)} ned ${num(arms[a].ned.median)} bpc/null ${num(arms[a].bpcVsNull.median)}`).join(' | ')}`);

console.log('');
console.log('SURFACE vs THIS CASE SET ("what a real reply to these cues looks like" — the gate-ready reference)');
console.log('='.repeat(78));
console.log(`  ${pad('arm', 8)}${padL('Δlen', 8)}${padL('lenRelErr', 10)}${padL('bucketL1', 9)}${padL('Δpunct', 8)}${padL('Δends', 8)}${padL('Δquest', 8)}${padL('Δlaugh', 8)}${padL('Δsticker', 8)}${padL('Δemoji', 8)}${padL('Δmixed', 8)}${padL('Δlatin', 8)}${padL('Δcaps', 8)}`);
for (const arm of armList) {
  const d = arms[arm].surfaceVsTargets;
  console.log(`  ${pad(arm, 8)}${padL(num(d.lengthMean, 1), 8)}${padL(num(d.lengthRelError), 10)}${padL(num(d.lengthBucketL1), 9)}${padL(num(d.hasPunct), 8)}${padL(num(d.endsSentencePunct), 8)}${padL(num(d.question), 8)}${padL(num(d.laugh), 8)}${padL(num(d.stickerPlaceholder), 8)}${padL(num(d.emoji), 8)}${padL(num(d.mixedRate), 8)}${padL(num(d.latinCharRatio), 8)}${padL(num(d.allCapsTokenRate), 8)}`);
}
console.log(`  targets baseline: mean len ${num(targetSurface.length.mean, 1)} chars, hasPunct ${num(targetSurface.punctuation.hasAnyPunct)}, ends ${num(targetSurface.punctuation.endsWithSentencePunct)}, question ${num(targetSurface.punctuation.question)}, laugh ${num(targetSurface.punctuation.laugh)}, mixed ${num(targetSurface.codeSwitch.mixedRate)}`);
console.log('  REAL is 0 here by construction (it IS the target). bucketL1 is BUNDLE-LEVEL only.');
console.log('');

console.log('SURFACE DELTAS vs the author (train window; 0 = same rate as the author)');
console.log('='.repeat(78));
console.log(`  ${pad('arm', 8)}${padL('Δlen', 8)}${padL('Δpunct', 8)}${padL('Δends', 8)}${padL('Δquest', 8)}${padL('Δlaugh', 8)}${padL('Δsticker', 8)}${padL('Δemoji', 8)}${padL('Δlower', 8)}${padL('Δlatin', 8)}${padL('bucketL1', 8)}${padL('JSDbigram', 9)}`);
for (const arm of armList) {
  const d = arms[arm].surfaceDeltas;
  const s = arms[arm].surface;
  console.log(`  ${pad(arm, 8)}${padL(num(d.lengthMean, 1), 8)}${padL(num(d.hasPunct), 8)}${padL(num(d.endsSentencePunct), 8)}${padL(num(d.question), 8)}${padL(num(d.laugh), 8)}${padL(num(d.stickerPlaceholder), 8)}${padL(num(d.emoji), 8)}${padL(num(d.lowercaseLetterRatio), 8)}${padL(num(d.latinCharRatio), 8)}${padL(num(s.lengthBucketL1), 8)}${padL(num(s.jsdCharBigramVsAuthor), 9)}`);
}
console.log(`  author baseline: mean len ${num(authorSurface.length.mean, 1)} chars, hasPunct ${num(authorSurface.punctuation.hasAnyPunct)}, laugh ${num(authorSurface.punctuation.laugh)}, mixed ${num(authorSurface.codeSwitch.mixedRate)}, lowercaseLetterRatio ${num(authorSurface.casing.lowercaseLetterRatio)}`);
console.log('  bucketL1 and JSD are BUNDLE-LEVEL only: never read them off a single message.');

console.log('');
console.log(`PAIRED BOOTSTRAP CIs (A - B per case, ${resamples} resamples, seed ${seed})`);
console.log('='.repeat(78));
for (const p of pairs) {
  const parts = pairMetrics.map((m) => {
    const mm = p.metrics[m.key];
    const arrow = mm.favours === 'tie' ? '=' : `->${mm.favours}`;
    return `${m.key} ${num(mm.mean, 3)} [${num(mm.lo, 3)}, ${num(mm.hi, 3)}] ${arrow}`;
  });
  console.log(`  ${p.a} - ${p.b}:`);
  for (const part of parts) console.log(`      ${part}`);
}
console.log('  legend: bpcVsNull lower = more predictable, but below 1.0 it means the arm emits text the model was trained on');
console.log('          (i.e. memorised TRAIN text) — that is what the copy column is for, not a quality win.');

console.log('');
console.log('COMPOSITE (0-100, proposed weights, deliberately NOT a verdict yet)');
console.log('='.repeat(78));
for (const arm of armList) {
  const x = composite.arms[arm];
  console.log(`  ${pad(arm, 8)} score ${pad(x.score == null ? '-' : x.score.toFixed(1), 6)}  ${Object.entries(x.components).map(([k2, v]) => `${k2} ${v.value.toFixed(3)}x${v.weight.toFixed(2)}`).join('  ')}`);
}
console.log(`  empirical ceiling = REAL at ${num(composite.ceiling.score, 1)} (not 100): verifiability tops out at 1 - REAL's own copy rate (the human`);
console.log('  base rate for repeating an 8-char train window) and predictability at ~0.8 because the test window is measurably less');
console.log('  predictable than the train window. Read the other arms relative to REAL.');
console.log(`  predictability anchors: bpc/null 1.0 (real unseen message) -> 1.0, bpc/null ${num(stringNull)} (unigram-random strings) -> 0.0, clamped.`);
console.log('  weights are a PROPOSED default: calibrate them on the first two real runs (see README).');

// ---------------------------------------------------------------------------
// write the full report
// ---------------------------------------------------------------------------
const scoringMs = msSince(t0) - modelBuildMs - bm25BuildMs;
const wallMs = msSince(t0);
const report = {
  schema: SCHEMA,
  generatedAt: new Date().toISOString(),
  tool: { node: process.version, script: 'harness.mjs' },
  run: {
    casesDir, cases: cases.length, casesSha1: sha1(casesBuf), manifestSha1: sha1(fs.readFileSync(manifestPath)),
    cloneDir, cloneCheck, predictions: predictionsPath ? { file: predictionsPath, usable: predictions.size, ...predictionStats } : null,
    seed, poolSize, poolOptions: poolSize + 1, k, resamples, modelMaxChars, calibFrac,
    calibrationSplit: { modelTexts: modelTexts.length, calibTexts: calibTexts.length },
    chanceRecoveryAt1: chance, parrotNoHit, poolDedup,
    caseManifest: { schema: manifest.schema, boundaryIso: manifest.split?.boundaryIso, holdoutDays: manifest.params?.holdoutDays, corpus: manifest.corpus },
  },
  diagnostics: {
    bpcNull: 'per case: mean bpc of up to 5 real TRAIN-window messages (from the held-out calibration slice) in the same length bucket as the target',
    bpcStringControlVsNull: stringNull,
    bpcStringsAreUnigramRandom: 'random strings drawn from the model unigram distribution at the target length, used only as a control that the BPC metric separates real text from noise',
  },
  referenceFrame: { ok: rfOk, checks: rfChecks, chanceRecoveryAt1: chance },
  author: {
    trainMessages: trainTexts.length, modelTrainMessages: modelTexts.length, calibMessages: calibTexts.length,
    trainChars: model.trainChars, vocab: model.vocabSize,
    surface: {
      length: authorSurface.length, lengthBucketShares: authorSurface.lengthShares,
      punctuation: authorSurface.punctuation, casing: authorSurface.casing, codeSwitch: authorSurface.codeSwitch,
    },
    targets: {
      n: authorTargets.length, length: lengthStats(authorTargets), lengthBucketShares: targetSurface.lengthShares,
      punctuation: targetSurface.punctuation, casing: targetSurface.casing, codeSwitch: targetSurface.codeSwitch,
    },
  },
  metricNotes: {
    chrf: 'character n-gram F2, orders 1..6 averaged (lib.chrf)',
    ned: 'Levenshtein / max code-point length vs the single real target',
    bpc: 'bits per character (chars + EOS events) under the TRAIN-window per-author char 4-gram interpolated model — the metric with real per-message power at 1-30 chars',
    bpcVsNull: 'bpc / (length-bucket-matched bpc of held-out real TRAIN messages). Length alone moves bpc from ~4.6 (1-3 chars) to ~3.7 (31-60 chars), so the raw number is not comparable across arms with different length distributions; the ratio is.',
    recovery: `rank of the real target inside a ${poolSize + 1}-option pool scored by normEditDistance to the arm text; candidates are ${poolSize} deterministic TRAIN samples plus the target`,
    copyRate: 'share of arm messages sharing a >=8 char verbatim substring with the corpus in question',
    surface: 'bundle-level rates; JSD over char bigrams and bucket L1 are bundle-level only',
  },
  arms,
  pairwise: pairs,
  composite,
  perCase: perCase.map((r) => ({
    id: r.id, sid: r.sid, ts: r.ts, functionLabel: r.functionLabel, todLabel: r.todLabel,
    cueChars: r.cueChars, targetChars: r.targetChars, poolOptions: r.poolOptions, arms: r.arms,
    // raw text is embedded ONLY with --include-texts (local debugging); by default the
    // report stays free of message content so it can be shared safely.
    ...(args['include-texts'] ? { target: r._target, cue: r._cue, texts: r._texts } : {}),
  })),
  cost: {
    wallMs, scoringMs, modelBuildMs, bm25BuildMs,
    msPerCase: wallMs / Math.max(1, cases.length),
    rssMb: rssMb(),
    predictionsPerSecond: null,
    apiCostUsd: 0,
    apiCalls: 0,
    note: 'No network calls: PARROT/RANDOM/REAL are computed locally and CLONE is scored from a supplied predictions file. The cost of producing that file is not measured here.',
  },
  caveats: [
    'CHANCE: with 20 sampled TRAIN texts plus the real target the pool has 21 options, so recovery@1 chance is 4.76%.',
    'The composite weights are a proposal; the first two runs exist to calibrate them.',
    'Bundle-level metrics (JSD over char n-grams, lexical richness, punctuation/casing rates) say nothing about a single 1-30 char message.',
    'copyRate is a memorisation detector, not a quality metric: a generator that parrots train text scores high on copy and high on surface.',
    'PARROT is a lexical-retrieval baseline, not a persona model; it is the surface ceiling an offline non-generative method can reach.',
  ],
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');

console.log('');
console.log('='.repeat(78));
console.log('COST & LATENCY');
console.log('='.repeat(78));
console.log(`  model build      ${modelBuildMs.toFixed(0)} ms  (char 4-gram over ${model.trainChars} chars, vocab ${model.vocabSize})`);
console.log(`  BM25 build       ${bm25BuildMs.toFixed(0)} ms  (${postings.size} terms, ${N} train messages)`);
console.log(`  scoring          ${scoringMs.toFixed(0)} ms  (${(scoringMs / Math.max(1, cases.length)).toFixed(1)} ms/case over ${cases.length} cases x ${ARMS.length} arms)`);
console.log(`  total wall       ${(wallMs / 1000).toFixed(2)} s`);
console.log(`  process rss      ${rssMb().toFixed(0)} MB`);
console.log(`  API calls        0  |  API cost  $0.00  (all arms offline; CLONE scored from a local predictions file)`);
console.log('');
console.log(`report written: ${outPath}`);
console.log('NOTE: the report contains case ids, labels and numbers only — no message text (pass --include-texts to embed text for local debugging).');
if (!rfOk) {
  console.log('');
  console.log('WARNING: reference-frame checks failed — the arm numbers above are NOT trustworthy yet.');
  process.exitCode = 3;
}

