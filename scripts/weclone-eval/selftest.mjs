#!/usr/bin/env node
/**
 * weclone-eval / selftest.mjs — proves the instrument works with NO corpus, NO data
 * files and NO network. Exit code is non-zero if any assertion fails.
 *
 *   node scripts/weclone-eval/selftest.mjs
 */
import {
  chrf, editDistance, normEditDistance, charNgramDistribution, jensenShannon,
  punctuationProfile, casingProfile, codeSwitchProfile, lengthStats, burstStats,
  ksStatistic, copyRate, recoveryAtK, perAuthorModel, bpc, pairedBootstrapCI,
  compositeSfs, bucketOf, makeRng, median, charLen, DEFAULT_SFS_WEIGHTS,
} from './lib.mjs';

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`ok   ${name}${detail ? '  [' + detail + ']' : ''}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${detail ? '  [' + detail + ']' : ''}`);
  }
}

const near = (a, b, eps = 1e-9) => Number.isFinite(a) && Math.abs(a - b) <= eps;
// A deterministic 200-char pseudo-text; NOT corpus content.
const randString = (rng, n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(rng() * 26))).join('');

console.log('--- weclone-eval selftest (no data, no network) ---');

// ---------------------------------------------------------------------------
// chrF
// ---------------------------------------------------------------------------
{
  const s = 'hello world 你好世界';
  check('chrf: identical text scores 1.0', near(chrf(s, s), 1, 1e-12), `chrf=${chrf(s, s).toFixed(4)}`);
  const disjoint = chrf('aaaaaa', 'zzzzzz', { n: 6 });
  check('chrf: disjoint text scores 0.0', near(disjoint, 0, 1e-12), `chrf=${disjoint}`);
  const partial = chrf('hello there', 'hello world');
  check('chrf: partial overlap strictly between 0 and 1', partial > 0 && partial < 1, `chrf=${partial.toFixed(4)}`);
  check('chrf: empty vs empty is 1.0 (identical)', chrf('', '') === 1);
  check('chrf: empty vs text is 0', chrf('', 'x') === 0 && chrf('x', '') === 0);
  check('chrf: short identical text still 1.0 (orders below n skipped)', near(chrf('ab', 'ab'), 1, 1e-12));
  // asymmetric precision/recall: a long prediction against a short reference
  const betaHigh = chrf('abcabcabcabc', 'abc', { beta: 2 });
  const betaOne = chrf('abcabcabcabc', 'abc', { beta: 1 });
  check('chrf: beta changes the score when p != r', betaHigh !== betaOne, `f2=${betaHigh.toFixed(4)} f1=${betaOne.toFixed(4)}`);
  check('chrf: beta=2 (recall-weighted) >= beta=1 in [0,1]', betaHigh >= betaOne && betaHigh <= 1 && betaOne >= 0);
}

// ---------------------------------------------------------------------------
// edit distance
// ---------------------------------------------------------------------------
{
  check('editDistance: identical is 0', editDistance('abcdef', 'abcdef') === 0);
  check('editDistance: kitten/sitting is 3', editDistance('kitten', 'sitting') === 3);
  check('editDistance: empty vs abc is 3', editDistance('', 'abc') === 3 && editDistance('abc', '') === 3);
  check('editDistance: symmetric', editDistance('abcde', 'xyz') === editDistance('xyz', 'abcde'));
  check('editDistance: counts code points, not UTF-16 units', editDistance('你好', '你好') === 0 && editDistance('你好', '') === 2 && editDistance('😀', '😀') === 0);
  check('normEditDistance: identical is 0', normEditDistance('hello', 'hello') === 0);
  check('normEditDistance: both empty is 0', normEditDistance('', '') === 0);
  check('normEditDistance: in [0,1]', normEditDistance('kitten', 'sitting') > 0 && normEditDistance('kitten', 'sitting') <= 1, `ned=${normEditDistance('kitten', 'sitting').toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// n-gram distributions + JSD
// ---------------------------------------------------------------------------
{
  const d = charNgramDistribution('aaaa', 2);
  check('charNgramDistribution: counts windows', d.get('aa') === 3, `aa=${d.get('aa')}`);
  check('charNgramDistribution: empty when text < n', charNgramDistribution('a', 3).size === 0);

  const dist = charNgramDistribution('the quick brown fox', 3);
  const self = jensenShannon(dist, dist);
  check('jensenShannon: distribution with itself is 0', self === 0, `jsd=${self}`);
  const other = charNgramDistribution('zzz qqq', 3);
  const cross = jensenShannon(dist, other);
  check('jensenShannon: zero-support terms stay finite', Number.isFinite(cross) && cross > 0 && cross <= 1, `jsd=${cross.toFixed(4)}`);
  const emptyBoth = jensenShannon(new Map(), new Map());
  check('jensenShannon: empty vs empty is 0 (not NaN)', emptyBoth === 0 && Number.isFinite(emptyBoth));
  const emptyOne = jensenShannon(new Map(), other);
  check('jensenShannon: empty vs non-empty is finite', Number.isFinite(emptyOne) && emptyOne >= 0 && emptyOne <= 1, `jsd=${emptyOne.toFixed(4)}`);
  check('jensenShannon: identical single-count distributions are 0', jensenShannon({ a: 1 }, { a: 1 }) === 0);
  const mixedTypes = jensenShannon({ a: 2, b: 1 }, [3, 1]);
  check('jensenShannon: accepts plain objects and arrays without NaN', Number.isFinite(mixedTypes), `jsd=${mixedTypes}`);
  const noNaN = [jensenShannon({}, {}), jensenShannon({ a: 1 }, {}), jensenShannon([], [1, 2])].every((x) => Number.isFinite(x));
  check('jensenShannon: never NaN/Infinity across odd inputs', noNaN);
}

// ---------------------------------------------------------------------------
// surface profiles
// ---------------------------------------------------------------------------
{
  const texts = ['hello there', '在吗？', '哈哈哈哈', '[Sob]', 'im fine lol', '今天天气不错', ''];
  const p = punctuationProfile(texts);
  const ratesOnly = Object.entries(p).filter(([key]) => key !== 'n').map(([, v]) => v);
  check('punctuationProfile: all rate fields in [0,1]', ratesOnly.every((v) => v == null || (v >= 0 && v <= 1)), JSON.stringify(ratesOnly.map((v) => (v == null ? null : +v.toFixed(3)))));
  check('punctuationProfile: question rate counts the ?', p.question > 0, `question=${p.question.toFixed(3)}`);
  check('punctuationProfile: laugh rate counts 哈哈哈哈 and lol', near(p.laugh, 2 / 7, 1e-9), `laugh=${p.laugh.toFixed(3)}`);
  check('punctuationProfile: sticker-only rate counts [Sob]', p.stickerPlaceholder > 0, `sticker=${p.stickerPlaceholder.toFixed(3)}`);
  check('punctuationProfile: empty bundle gives nulls', punctuationProfile([]).hasAnyPunct === null);

  const c = casingProfile(['IM DONE', 'im done', 'dont know', '中文', 'WTF is that']);
  check('casingProfile: ascii subset is 4 of 5', near(c.asciiMessageShare, 4 / 5, 1e-9), `share=${c.asciiMessageShare.toFixed(3)}`);
  check('casingProfile: lowercase ratio in (0,1)', c.lowercaseLetterRatio > 0 && c.lowercaseLetterRatio < 1, `lw=${c.lowercaseLetterRatio.toFixed(3)}`);
  check('casingProfile: apostrophe omission detected', c.apostropheOmittedRate > 0, `ao=${c.apostropheOmittedRate.toFixed(3)}`);
  check('casingProfile: all-caps token rate > 0', c.allCapsTokenRate > 0, `caps=${c.allCapsTokenRate.toFixed(3)}`);

  const cs = codeSwitchProfile(['hello 你好', 'hello', '你好', '123']);
  check('codeSwitchProfile: mixed rate is 1/4', near(cs.mixedRate, 0.25, 1e-9), `mixed=${cs.mixedRate}`);
  check('codeSwitchProfile: latin and cjk ratios sum below 1', cs.latinCharRatio + cs.cjkCharRatio <= 1 + 1e-12, `latin=${cs.latinCharRatio.toFixed(3)} cjk=${cs.cjkCharRatio.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// length stats + KS
// ---------------------------------------------------------------------------
{
  const ls = lengthStats(['a', 'abcd', 'aaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaa']);
  check('lengthStats: median of 1,4,10,20 is 7', ls.median === 7, `median=${ls.median}`);
  check('lengthStats: p10/p90 bracket the median', ls.p10 <= ls.median && ls.median <= ls.p90, `p10=${ls.p10} p90=${ls.p90}`);
  check('lengthStats: histogram has all six buckets', Object.keys(ls.histogram).length === 6, Object.keys(ls.histogram).join('|'));
  check('bucketOf: boundaries', bucketOf(1) === '1-3' && bucketOf(3) === '1-3' && bucketOf(4) === '4-8' && bucketOf(8) === '4-8' && bucketOf(9) === '9-16' && bucketOf(17) === '17-30' && bucketOf(31) === '31-60' && bucketOf(61) === '60+');
  check('lengthStats: empty bundle gives nulls', lengthStats([]).mean === null && lengthStats([]).histogram['1-3'] === 0);
  check('lengthStats: uses code points for emoji', lengthStats(['😀😀']).mean === 2, `mean=${lengthStats(['😀😀']).mean}`);

  const sample = [3, 5, 7, 9, 11, 14, 18, 22, 27, 33, 40, 55];
  check('ksStatistic: sample vs itself is 0', ksStatistic(sample, sample) === 0);
  check('ksStatistic: disjoint sample gives D=1', ksStatistic(sample, sample.map((x) => x + 100)) === 1, `D=${ksStatistic(sample, sample.map((x) => x + 100))}`);
  check('ksStatistic: overlapping shift gives D in (0,1)', (() => { const d = ksStatistic(sample, sample.map((x) => x + 40)); return d > 0.8 && d < 1; })(), `D=${ksStatistic(sample, sample.map((x) => x + 40)).toFixed(4)}`);
  check('ksStatistic: empty side is 0', ksStatistic([], sample) === 0);
  const dHalf = ksStatistic([1, 2], [1, 2, 3, 4]);
  check('ksStatistic: partial overlap in (0,1)', dHalf > 0 && dHalf < 1, `D=${dHalf}`);
}

// ---------------------------------------------------------------------------
// bursts
// ---------------------------------------------------------------------------
{
  const events = [
    { sid: 'A', ts: 0 }, { sid: 'A', ts: 10 }, { sid: 'A', ts: 20 },      // burst of 3
    { sid: 'A', ts: 1000 },                                               // new burst (gap > 180)
    { sid: 'B', ts: 1005 }, { sid: 'B', ts: 1010 },                       // burst of 2
  ];
  const b = burstStats(events);
  check('burstStats: groups by sid and 180s gap', b.count === 3, `count=${b.count}`);
  check('burstStats: mean size is 2', b.mean === 2, `mean=${b.mean}`);
  check('burstStats: >=3 share is 1/3', near(b.ge3Share, 1 / 3, 1e-12), `ge3=${b.ge3Share.toFixed(3)}`);
  check('burstStats: unsorted input is sorted internally', burstStats([...events].reverse()).count === b.count);
  check('burstStats: empty input is safe', burstStats([]).count === 0 && burstStats([]).ge3Share === null);
  const straddle = burstStats([{ sid: 'A', ts: 10 }, { sid: 'B', ts: 11 }]);
  check('burstStats: interleaved sids do not merge', straddle.count === 2, `count=${straddle.count}`);
}

// ---------------------------------------------------------------------------
// copyRate
// ---------------------------------------------------------------------------
{
  const corpus = ['the quick brown fox jumps', 'hello there my friend', '完全无关的一句中文'];
  const copied = copyRate(['the quick brown fox jumps'], corpus, { minMatch: 8 });
  check('copyRate: corpus copy is 1.0', copied.rate === 1, `rate=${copied.rate} copied=${copied.copied}/${copied.total}`);
  const partialCopy = copyRate(['xyz the quick brown fox abc'], corpus, { minMatch: 8 });
  check('copyRate: embedded 8+ char copy is 1.0', partialCopy.rate === 1, `rate=${partialCopy.rate}`);
  const unrelated = copyRate(['zzzz qqqq wwww eeee'], corpus, { minMatch: 8 });
  check('copyRate: unrelated text is 0.0', unrelated.rate === 0, `rate=${unrelated.rate}`);
  const shortGen = copyRate(['ok'], corpus, { minMatch: 8 });
  check('copyRate: generated text shorter than minMatch is 0', shortGen.rate === 0);
  const mixed = copyRate(['the quick brown fox jumps', 'zzzz qqqq wwww eeee'], corpus, { minMatch: 8 });
  check('copyRate: half copy is 0.5', near(mixed.rate, 0.5, 1e-12), `rate=${mixed.rate}`);
  const cjkCopy = copyRate(['完全无关的一句中文'], corpus, { minMatch: 8 });
  check('copyRate: CJK copy detected', cjkCopy.rate === 1, `rate=${cjkCopy.rate}`);
  check('copyRate: empty generations give null rate', copyRate([], corpus).rate === null);
}

// ---------------------------------------------------------------------------
// recoveryAtK
// ---------------------------------------------------------------------------
{
  const pool = ['alpha one', 'beta two', 'gamma three', 'hello world'];
  const inPool = recoveryAtK(pool, 'hello world', { k: 20 });
  check('recoveryAtK: target in pool -> rank 1', inPool.rank === 1, `rank=${inPool.rank} rr=${inPool.rr}`);
  check('recoveryAtK: rank 1 -> rr 1', inPool.rr === 1);
  const notInPool = recoveryAtK(pool, 'not present at all', { k: 20 });
  check('recoveryAtK: target absent -> rank null', notInPool.rank === null && notInPool.rr === 0, `rank=${notInPool.rank}`);
  const scored = recoveryAtK(pool, 'hello world', { k: 20, scoreAgainst: 'helo wrld' });
  check('recoveryAtK: scoreAgainst finds the near target at rank 1', scored.rank === 1, `rank=${scored.rank}`);
  const scored2 = recoveryAtK(pool, 'hello world', { k: 1, scoreAgainst: 'alpha one' });
  check('recoveryAtK: scoreAgainst can push the target off rank 1', scored2.rank > 1 && scored2.hit === false, `rank=${scored2.rank}`);
  check('recoveryAtK: empty pool is null', recoveryAtK([], 'x').rank === null);
  check('recoveryAtK: ties break to the first (lowest-index) equal candidate', recoveryAtK(['aa', 'aa', 'bb'], 'aa').rank === 1, `rank=${recoveryAtK(['aa', 'aa', 'bb'], 'aa').rank}`);
}

// ---------------------------------------------------------------------------
// per-author model + bpc
// ---------------------------------------------------------------------------
{
  // Two synthetic "authors" with clearly different styles.
  const rngA = makeRng(7);
  const styleA = Array.from({ length: 120 }, () => {
    const n = 3 + Math.floor(rngA() * 3);
    return Array.from({ length: n }, () => (rngA() < 0.8 ? 'a' : 'b')).join('');
  });
  const styleB = Array.from({ length: 120 }, (_, i) => (i % 2 ? 'lol' : '[Sob]') + 'ok');
  const modelA = perAuthorModel(styleA);
  const bpcA = styleA.map((t) => bpc(modelA, t));
  const bpcB = styleB.map((t) => bpc(modelA, t));
  const meanA = bpcA.reduce((x, y) => x + y, 0) / bpcA.length;
  const meanB = bpcB.reduce((x, y) => x + y, 0) / bpcB.length;
  check('bpc: in-author text beats out-of-author text', meanA < meanB, `in=${meanA.toFixed(3)} out=${meanB.toFixed(3)}`);

  const longRandom = Array.from({ length: 40 }, () => randString(makeRng(99), 200));
  const bpcRandom = longRandom.map((t) => bpc(modelA, t));
  const meanRandom = bpcRandom.reduce((x, y) => x + y, 0) / bpcRandom.length;
  check('bpc: identical text scores far below a random-string baseline', meanA < meanRandom / 2, `in=${meanA.toFixed(3)} random=${meanRandom.toFixed(3)}`);
  check('bpc: empty text returns null', bpc(modelA, '') === null && bpc(modelA, null) === null);
  check('bpc: single char is finite and positive', Number.isFinite(bpc(modelA, 'a')) && bpc(modelA, 'a') > 0, `bpc=${bpc(modelA, 'a').toFixed(3)}`);
  check('bpc: unseen character stays finite (no log(0))', Number.isFinite(bpc(modelA, 'ZZZ📕')) && bpc(modelA, 'ZZZ📕') < 60, `bpc=${bpc(modelA, 'ZZZ📕').toFixed(3)}`);
  check('perAuthorModel: weights normalise to 1', near(modelA.weights.reduce((x, y) => x + y, 0), 1, 1e-12));
  check('perAuthorModel: vocabulary recorded', modelA.vocabSize > 0 && modelA.events > 0, `V=${modelA.vocabSize} events=${modelA.events}`);
  const capped = perAuthorModel(styleA, { maxChars: 100 });
  check('perAuthorModel: maxChars caps training text', capped.trainChars <= 100 && capped.events < modelA.events, `chars=${capped.trainChars}`);
  const order1 = perAuthorModel(styleA, { order: 1, weights: [1] });
  check('perAuthorModel: order 1 works', Number.isFinite(bpc(order1, 'aaa')));
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------
{
  const deltas = Array.from({ length: 60 }, (_, i) => ((i % 7) - 3) / 10);
  const a = pairedBootstrapCI(deltas, { resamples: 2000, seed: 12345 });
  const b = pairedBootstrapCI(deltas, { resamples: 2000, seed: 12345 });
  check('pairedBootstrapCI: reproducible across calls', a.mean === b.mean && a.lo === b.lo && a.hi === b.hi, `mean=${a.mean} [${a.lo.toFixed(4)},${a.hi.toFixed(4)}]`);
  const c = pairedBootstrapCI(deltas, { resamples: 2000, seed: 999 });
  check('pairedBootstrapCI: a different seed moves the interval', c.lo !== a.lo || c.hi !== a.hi);
  check('pairedBootstrapCI: lo <= mean <= hi', a.lo <= a.mean && a.mean <= a.hi, `[${a.lo.toFixed(3)}, ${a.hi.toFixed(3)}]`);
  const noVariance = pairedBootstrapCI([0.25, 0.25, 0.25, 0.25], { resamples: 100 });
  check('pairedBootstrapCI: zero variance collapses to the constant', near(noVariance.mean, 0.25) && near(noVariance.lo, 0.25) && near(noVariance.hi, 0.25));
  const empty = pairedBootstrapCI([], { resamples: 100 });
  check('pairedBootstrapCI: empty input gives nulls', empty.mean === null && empty.lo === null && empty.hi === null);
  const withNaN = pairedBootstrapCI([1, NaN, 1, null, undefined, 1]);
  check('pairedBootstrapCI: drops non-finite deltas', withNaN.n === 3 && withNaN.mean === 1);
  const allPos = pairedBootstrapCI(deltas.map((d) => d + 5), { resamples: 1000 });
  check('pairedBootstrapCI: a big shift excludes 0', allPos.lo > 0, `lo=${allPos.lo.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// composite
// ---------------------------------------------------------------------------
{
  const perfect = compositeSfs({ recovery: 1, predictability: 1, verifiability: 1, surface: 1 });
  check('compositeSfs: all-ones is 100', near(perfect.score, 100, 1e-9), `score=${perfect.score}`);
  const zero = compositeSfs({ recovery: 0, predictability: 0, verifiability: 0, surface: 0 });
  check('compositeSfs: all-zeros is 0', zero.score === 0);
  const partial = compositeSfs({ recovery: 1, surface: 0 });
  check('compositeSfs: missing components renormalise over the present weights', near(partial.score, 100 * (0.35 / 0.55), 1e-9), `score=${partial.score.toFixed(3)} (recovery 0.35 / (0.35+0.20))`);
  check('compositeSfs: drops the missing component and reports it', partial.dropped.includes('predictability'));
  const clamped = compositeSfs({ recovery: 2, predictability: -1 });
  check('compositeSfs: out-of-range components are clamped to [0,1]', near(clamped.score, 100 * (0.35 / 0.6), 1e-9), `score=${clamped.score.toFixed(3)}`);
  check('compositeSfs: nothing usable gives null', compositeSfs({}).score === null);
  const wSum = Object.values(DEFAULT_SFS_WEIGHTS).reduce((x, y) => x + y, 0);
  check('compositeSfs: default weights sum to 1 (proposed defaults, not literature)', near(wSum, 1, 1e-12), `sum=${wSum}`);
}

// ---------------------------------------------------------------------------
// determinism / misc
// ---------------------------------------------------------------------------
{
  const r1 = makeRng(42);
  const r2 = makeRng(42);
  const seq1 = Array.from({ length: 100 }, () => r1());
  const seq2 = Array.from({ length: 100 }, () => r2());
  check('makeRng: same seed -> same sequence', seq1.every((v, i) => v === seq2[i]));
  check('makeRng: stays in [0,1)', seq1.every((v) => v >= 0 && v < 1));
  check('median: even and odd lengths', median([1, 2, 3, 4]) === 2.5 && median([3, 1, 2]) === 2);
  check('median: empty is null', median([]) === null);
  const mixed = perAuthorModel(['abc', 'abc'], { order: 3 });
  check('charLen counts code points', charLen('😀a') === 2);
  check('perAuthorModel: deterministic (same input, same bpc)', bpc(mixed, 'abc') === bpc(perAuthorModel(['abc', 'abc'], { order: 3 }), 'abc'));
}

console.log('---');
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  failed: ${f}`);
  process.exitCode = 1;
} else {
  console.log('selftest OK');
}
