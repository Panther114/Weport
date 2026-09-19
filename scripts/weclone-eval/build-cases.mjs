#!/usr/bin/env node
/**
 * weclone-eval / build-cases.mjs — freeze a held-out evaluation case set from a clone
 * corpus directory. Read-only w.r.t. the corpus; everything it produces is written to
 * --out.
 *
 *   node scripts/weclone-eval/build-cases.mjs \
 *     --corpus "C:\\Users\\<user>\\AppData\\Roaming\\Weport\\weclone-staging\\<wxid>" \
 *     --out .ui-probe/eval-cases [--holdout-days 14] [--target-cases 200] [--limit 40] [--seed 12345]
 *
 * A CASE is one real message the author sent inside the TEST window plus the
 * conversation context that preceded it:
 *   {id, sid, ts, cue, target, functionLabel, todLabel}
 * - target : from voice.jsonl (one real author message)
 * - cue    : the lines before it inside its chunks.jsonl chunk (other party included),
 *            capped at --max-cue-chars, whole lines only, taken from the END (nearest
 *            context) so the cue is never cut mid-message.
 *
 * SPLIT: the last --holdout-days of the corpus by timestamp is TEST, everything before
 * is TRAIN. Both windows are described in manifest.json including sha1 of the two
 * JSONLs, so a case set can always be traced back to the exact corpus revision.
 *
 * LEAKAGE CONTROLS (both mandatory):
 *  (a) train-voice.jsonl — the TRAIN-window author texts only. The harness builds the
 *      per-author BPC model and the copy-rate corpus from this file, never from the
 *      test window, so no metric can see the text it is predicting.
 *  (b) Every candidate case is dropped when its target (or any >= 8-char substring of
 *      it) appears verbatim in the clone's markdown persona files — the clone was
 *      generated FROM those files, so such a target is memorisation, not prediction.
 *
 * DETERMINISM: seeded LCG sampling, stable ordering, no Math.random. Same corpus +
 * same flags => byte-identical cases.jsonl.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {
  makeRng, shuffled, charLen, lengthStats, bucketOf, mean, median,
  buildNgramHashSet, hasNgramMatch,
} from './lib.mjs';

const SCHEMA = 'weclone-eval/cases/v1';
const LEAK_NGRAM = 8;
const PREFIX_ME = '我: ';
const DAY = 86400;

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
if (args.help || !args.corpus || !args.out) {
  console.log(`weclone-eval build-cases

required:
  --corpus <cloneDir>     directory holding chunks.jsonl + voice.jsonl (+ *.md persona files)
  --out <dir>             output directory (created if missing)
optional:
  --holdout-days <n>      TEST window = last n days of the corpus (default 14)
  --target-cases <n>      how many cases to freeze (default 200)
  --limit <n>             cap the written cases after sampling (quick runs)
  --seed <n>              sampling seed (default 12345)
  --max-cue-chars <n>     cue cap in code points (default 1200)
  --max-per-session <n>   soft cap on cases per session during sampling (default 3)
  --min-target-chars <n>  drop targets shorter than this (default 2)
`);
  process.exit(args.help ? 0 : 2);
}

const corpusDir = path.resolve(String(args.corpus));
const outDir = path.resolve(String(args.out));
const holdoutDays = Number(args['holdout-days'] ?? 14);
const targetCases = Number(args['target-cases'] ?? 200);
const limit = args.limit ? Number(args.limit) : 0;
const seed = Number(args.seed ?? 12345);
const maxCueChars = Number(args['max-cue-chars'] ?? 1200);
const maxPerSession = Number(args['max-per-session'] ?? 3);
const minTargetChars = Number(args['min-target-chars'] ?? 2);

const chunksPath = path.join(corpusDir, 'chunks.jsonl');
const voicePath = path.join(corpusDir, 'voice.jsonl');
for (const p of [chunksPath, voicePath]) {
  if (!fs.existsSync(p)) {
    console.error(`missing required file: ${p}`);
    process.exit(2);
  }
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const nowIso = new Date().toISOString();
const prog = (msg) => process.stderr.write(msg + '\n');

// ---------------------------------------------------------------------------
// placeholders / labels
// ---------------------------------------------------------------------------
// Pure ornament with no authored content: bracket tags, emoji, whitespace only.
const RE_ORNAMENT_ONLY = /^\s*(?:\[[^\]]{1,24}\]|[\p{Extended_Pictographic}\uFE0F\u200D\u20E3\s])+\s*$/u;
const RE_QUESTION_MARK = /[?？]\s*$/;
const RE_QUESTION_WORD = /吗|是不是|有没有|行不行|在不在|要不要|好不好/;
const RE_GREETING_ONLY = /^(hi+|hello|hey+|yo|在吗|在么|早安|早上好|中午好|下午好|晚上好|晚安|你好|哈喽|早|早啊)[\s!！。.,，~～]*$/i;

/**
 * Rule-based functional label of the cue = the conversational move the target answers,
 * read from the LAST cue line (earlier lines are background). The point is only to
 * stratify the sample so one kind of move cannot dominate the case set.
 *
 * Order: sticker (that line is ornament only) -> greeting (that line is a greeting
 * token) -> question (ends with ?/？ or carries 吗/是不是/...) -> statement.
 */
function functionLabelOf(cue) {
  const t = cue.trim();
  const lastLine = t.split('\n').filter((l) => l.trim().length > 0).pop() || '';
  const lastText = lastLine.replace(/^[^:]{1,60}: /, '').trim();
  if (RE_ORNAMENT_ONLY.test(lastText)) return 'sticker';
  if (RE_GREETING_ONLY.test(lastText)) return 'greeting';
  if (RE_QUESTION_MARK.test(lastText) || RE_QUESTION_WORD.test(lastText)) return 'question';
  return 'statement';
}

/** UTC hour, so the label does not depend on the machine's timezone. */
export function todLabelOf(ts) {
  const h = new Date(ts * 1000).getUTCHours();
  if (h < 6) return 'night';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}
const TOD_ORDER = ['night', 'morning', 'afternoon', 'evening'];
const FN_ORDER = ['question', 'greeting', 'sticker', 'statement'];

// ---------------------------------------------------------------------------
// load voice.jsonl (one row per author message)
// ---------------------------------------------------------------------------
prog(`reading ${path.basename(voicePath)} ...`);
const voiceBuf = fs.readFileSync(voicePath);
const voiceRaw = voiceBuf.toString('utf8');
const voiceRows = [];
for (const line of voiceRaw.split('\n')) {
  if (!line) continue;
  try {
    const o = JSON.parse(line);
    voiceRows.push({ id: String(o.id), sid: String(o.sid), ts: Number(o.ts) || 0, text: String(o.text ?? '') });
  } catch { /* ignore malformed line, counted below */ }
}
if (voiceRows.length === 0) {
  console.error('voice.jsonl produced no rows');
  process.exit(2);
}
const voiceByIdxSid = new Map(); // sid -> [row indexes in file order]
voiceRows.forEach((r, i) => {
  if (!voiceByIdxSid.has(r.sid)) voiceByIdxSid.set(r.sid, []);
  voiceByIdxSid.get(r.sid).push(i);
});
const tsAll = voiceRows.map((r) => r.ts).filter((t) => t > 0);
const maxTs = Math.max(...tsAll);
const minTs = Math.min(...tsAll);
const boundaryTs = Math.floor(maxTs - holdoutDays * DAY);

const trainRows = [];
const testSet = new Set();
voiceRows.forEach((r, i) => { if (r.ts > 0 && r.ts > boundaryTs) testSet.add(i); else trainRows.push(i); });
prog(`voice rows: ${voiceRows.length} | train ${trainRows.length} | test ${testSet.size} | boundary ${new Date(boundaryTs * 1000).toISOString()}`);

// ---------------------------------------------------------------------------
// leakage control (b): the clone's markdown persona files
// ---------------------------------------------------------------------------
const mdFiles = fs.readdirSync(corpusDir).filter((f) => f.toLowerCase().endsWith('.md'));
const mdTexts = [];
const mdLens = {};
for (const f of mdFiles.sort()) {
  const txt = fs.readFileSync(path.join(corpusDir, f), 'utf8');
  mdTexts.push(txt);
  mdLens[f] = txt.length;
}
const mdBlob = mdTexts.join('\n');
prog(`persona markdown: ${mdFiles.length} files, ${mdBlob.length} chars (leak filter: >=${LEAK_NGRAM} char verbatim match)`);
const mdNgrams = buildNgramHashSet(mdTexts, LEAK_NGRAM);

// Control for the leak filter: how often does a TRAIN-window message of the same shape
// trip it? If the control rate were also high, the filter would just be measuring
// "8-grams that are common in this person's writing" rather than persona quoting.
const leakControl = (() => {
  const pool = trainRows.filter((i) => charLen(voiceRows[i].text) >= LEAK_NGRAM);
  const rng = makeRng(seed + 1);
  const n = Math.min(500, pool.length);
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const pick = pool[Math.floor(rng() * pool.length)];
    if (hasNgramMatch(voiceRows[pick].text, mdNgrams, LEAK_NGRAM)) hits++;
  }
  return { n, hits, rate: n ? hits / n : null };
})();

function leaksIntoPersona(target) {
  if (charLen(target) >= LEAK_NGRAM) {
    if (hasNgramMatch(target, mdNgrams, LEAK_NGRAM)) return 'ngram8';
    return null;
  }
  // shorter than the n-gram length: only the target itself can be checked, and a
  // 2-3 char phrase ("好的", "在的") trivially occurs somewhere in 58 KB of markdown,
  // so those drops are reported separately — see leakRule in the manifest.
  return target.length > 0 && mdBlob.includes(target) ? 'shortSubstring' : null;
}

// ---------------------------------------------------------------------------
// walk chunks.jsonl and pair each authored line with its voice row
// ---------------------------------------------------------------------------
const drops = {
  unmatchedVoiceRow: 0,
  tsZero: 0,
  notInTestWindow: 0,
  targetTooShort: 0,
  targetPlaceholder: 0,
  duplicateTarget: 0,
  leakedIntoPersona: 0,
  noCue: 0,
};
const cases = [];
const seenTargets = new Set();
const leakedLengths = [];
const leakRule = { ngram8: 0, shortSubstring: 0 };
let authoredLines = 0;
let matchedLines = 0;
let lookaheadMatches = 0;
let cueTruncated = 0;
let chunkLines = 0;

const rl = readline.createInterface({ input: fs.createReadStream(chunksPath, { encoding: 'utf8' }), crlfDelay: Infinity });
const cursor = new Map(); // sid -> next index into that sid's voice-row list

for await (const line of rl) {
  if (!line) continue;
  let chunk;
  try { chunk = JSON.parse(line); } catch { continue; }
  const sid = String(chunk.sid);
  const idxs = voiceByIdxSid.get(sid) || [];
  let p = cursor.get(sid) ?? 0;
  const lines = String(chunk.text ?? '').split('\n');
  chunkLines += lines.length;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.startsWith(PREFIX_ME)) continue;
    authoredLines++;
    const text = ln.slice(PREFIX_ME.length);
    // Pair with the next voice row of this session. Chunk order and voice.jsonl order
    // agree per session, so a short lookahead absorbs the rare disagreement.
    let found = -1;
    for (let d = 0; d < 4 && p + d < idxs.length; d++) {
      if (voiceRows[idxs[p + d]].text === text) { found = d; break; }
    }
    if (found < 0) { drops.unmatchedVoiceRow++; continue; }
    const rowIdx = idxs[p + found];
    matchedLines++;
    if (found > 0) lookaheadMatches++;
    p += found + 1;
    cursor.set(sid, p);

    const row = voiceRows[rowIdx];
    if (!testSet.has(rowIdx)) { drops.notInTestWindow++; continue; }
    if (!row.ts) { drops.tsZero++; continue; }
    if (charLen(text) < minTargetChars) { drops.targetTooShort++; continue; }
    if (RE_ORNAMENT_ONLY.test(text)) { drops.targetPlaceholder++; continue; }
    if (seenTargets.has(text)) { drops.duplicateTarget++; continue; }
    const leakKind = leaksIntoPersona(text);

    // cue = whole lines before this one, capped from the END (nearest context)
    const before = lines.slice(0, i);
    const tail = [];
    let used = 0;
    for (let j = before.length - 1; j >= 0; j--) {
      const add = before[j].length + 1;
      if (used + add > maxCueChars) break;
      tail.push(before[j]);
      used += add;
    }
    let truncatedCue = tail.length < before.length;
    if (tail.length === 0 && before.length > 0) {
      // the nearest line alone is longer than the cap: keep its tail
      tail.push(before[before.length - 1].slice(-maxCueChars));
      truncatedCue = true;
    }
    if (tail.length === 0) { drops.noCue++; continue; }
    if (truncatedCue) cueTruncated++;
    const cue = tail.reverse().join('\n');
    if (leakKind) {
      drops.leakedIntoPersona++;
      leakRule[leakKind]++;
      leakedLengths.push(charLen(text));
      continue;
    }
    seenTargets.add(text);
    cases.push({
      id: `case_${row.id}`,
      sid,
      ts: row.ts,
      cue,
      target: text,
      functionLabel: functionLabelOf(cue),
      todLabel: todLabelOf(row.ts),
      voiceRow: rowIdx,
      chunkId: String(chunk.id ?? ''),
      cueTruncated: tail.length < before.length,
      cueChars: charLen(cue),
    });
  }
  cursor.set(sid, p);
}
prog(`chunk lines ${chunkLines} | authored lines ${authoredLines} | matched ${matchedLines} | candidates in test window ${cases.length}`);
if (authoredLines === 0) {
  console.error('no authored ("我: ") lines found in chunks.jsonl — wrong corpus shape?');
  process.exit(2);
}
const matchRate = matchedLines / authoredLines;
if (matchRate < 0.9) prog(`WARNING: voice/chunk pairing match rate is only ${(matchRate * 100).toFixed(1)}% — case cues may be misaligned`);

// ---------------------------------------------------------------------------
// stratified deterministic sampling
// ---------------------------------------------------------------------------
const cells = new Map(); // "fn|tod" -> candidates
for (const c of cases) {
  const key = `${c.functionLabel}|${c.todLabel}`;
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push(c);
}
const rng = makeRng(seed);
const cellKeys = [...cells.keys()].sort();
const shuffledCells = new Map();
for (const k of cellKeys) shuffledCells.set(k, shuffled(shuffled(cells.get(k), rng), rng));

const perSession = new Map();
const picked = [];
const pickedSet = new Set();
let relaxedUsed = false;

/** One round-robin pass over the (functionLabel x todLabel) cells. */
function fillPass(relax) {
  let progress = true;
  while (picked.length < targetCases && progress) {
    progress = false;
    for (const k of cellKeys) {
      if (picked.length >= targetCases) break;
      const list = shuffledCells.get(k);
      while (list.length) {
        const c = list[list.length - 1];
        const n = perSession.get(c.sid) || 0;
        if (!relax && n >= maxPerSession) break; // leave it for the relaxed pass
        list.pop();
        if (pickedSet.has(c.id)) continue;
        pickedSet.add(c.id);
        perSession.set(c.sid, n + 1);
        picked.push(c);
        progress = true;
        break;
      }
    }
  }
}
fillPass(false);
if (picked.length < targetCases) {
  const beforeRelax = picked.length;
  fillPass(true);
  relaxedUsed = picked.length > beforeRelax;
}
picked.sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
// --limit takes a strided subset so a quick run still spans the whole test window
// instead of only its first N cases; deterministic and stable under insertion.
let finalCases = picked;
if (limit > 0 && picked.length > limit) {
  const strided = [];
  for (let j = 0; j < limit; j++) strided.push(picked[Math.floor((j * picked.length) / limit)]);
  finalCases = strided;
}

// ---------------------------------------------------------------------------
// write outputs
// ---------------------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });
const casesPath = path.join(outDir, 'cases.jsonl');
const trainVoicePath = path.join(outDir, 'train-voice.jsonl');
const manifestPath = path.join(outDir, 'manifest.json');

const casesOut = finalCases.map((c) => JSON.stringify({
  id: c.id,
  sid: c.sid,
  ts: c.ts,
  cue: c.cue,
  target: c.target,
  functionLabel: c.functionLabel,
  todLabel: c.todLabel,
  cueChars: c.cueChars,
  cueTruncated: c.cueTruncated,
  chunkId: c.chunkId,
}));
fs.writeFileSync(casesPath, casesOut.join('\n') + (casesOut.length ? '\n' : ''));

const trainTexts = trainRows.map((i) => voiceRows[i].text).filter((t) => t && t.length > 0);
fs.writeFileSync(trainVoicePath, trainTexts.map((t) => JSON.stringify(t)).join('\n') + (trainTexts.length ? '\n' : ''));

const strata = {};
for (const fn of FN_ORDER) {
  strata[fn] = {};
  for (const tod of TOD_ORDER) {
    strata[fn][tod] = finalCases.filter((c) => c.functionLabel === fn && c.todLabel === tod).length;
  }
}
const sessionCounts = new Map();
for (const c of finalCases) sessionCounts.set(c.sid, (sessionCounts.get(c.sid) || 0) + 1);
const targetLengths = finalCases.map((c) => charLen(c.target));
const cueLengths = finalCases.map((c) => c.cueChars);
const bucketCounts = {};
for (const l of targetLengths) bucketCounts[bucketOf(l)] = (bucketCounts[bucketOf(l)] || 0) + 1;

const manifest = {
  schema: SCHEMA,
  generatedAt: nowIso,
  tool: { node: process.version, script: 'build-cases.mjs' },
  params: { seed, holdoutDays, targetCases, limit, maxCueChars, minTargetChars, maxPerSession },
  corpus: {
    dir: corpusDir,
    chunksSha1: sha1(fs.readFileSync(chunksPath)),
    voiceSha1: sha1(voiceBuf),
    chunksLines: chunkLines,
    voiceRows: voiceRows.length,
    personaFiles: mdFiles.map((f) => ({ file: f, sha1: sha1(fs.readFileSync(path.join(corpusDir, f))), chars: mdLens[f] })),
  },
  split: {
    rule: `TEST = ts > (maxTs - ${holdoutDays} days); TRAIN = everything else`,
    boundaryTs,
    boundaryIso: new Date(boundaryTs * 1000).toISOString(),
    maxTs,
    minTs,
    maxTsIso: new Date(maxTs * 1000).toISOString(),
    minTsIso: new Date(minTs * 1000).toISOString(),
    train: { voiceRows: trainRows.length, textsWritten: trainTexts.length },
    test: { voiceRows: testSet.size, casesAvailable: cases.length, casesWritten: finalCases.length },
  },
  leakageControls: {
    trainOnlyModelFile: path.basename(trainVoicePath),
    personaNgramChars: LEAK_NGRAM,
    droppedLeakedCases: drops.leakedIntoPersona,
    rule: 'target dropped if any >=8 code point substring of it occurs verbatim in the persona markdown; targets shorter than 8 chars are dropped only if the whole target occurs verbatim',
    droppedByRule: leakRule,
    droppedTargetLength: { mean: leakedLengths.length ? mean(leakedLengths) : null, median: leakedLengths.length ? median(leakedLengths) : null },
    controlTrainMessageMatchRate: leakControl.rate,
    controlTrainMessagesSampled: leakControl.n,
    note: 'The BPC model and the copy-rate corpus are built from train-voice.jsonl (TRAIN window only). Targets that share a >=8 char verbatim substring with the persona markdown are dropped.',
  },
  strata: { byFunctionAndTod: strata, sessionsUsed: sessionCounts.size, casesPerSessionMax: Math.max(0, ...sessionCounts.values()) },
  targetStats: { length: lengthStats(finalCases.map((c) => c.target)), buckets: bucketCounts },
  cueStats: { length: lengthStats(finalCases.map((c) => c.cue)), truncatedCases: finalCases.filter((c) => c.cueTruncated).length },
  quality: { authoredLines, matchedLines, voiceChunkMatchRate: matchRate, lookaheadMatches, cueTruncated, relaxedSessionCap: relaxedUsed, leakControlTrainMatchRate: leakControl.rate },
  drops,
  leakDroppedLengths: { mean: leakedLengths.length ? mean(leakedLengths) : null, median: leakedLengths.length ? median(leakedLengths) : null },
  sampling: { stratified: 'round-robin over (functionLabel x todLabel) cells, deterministic LCG shuffle, soft per-session cap', relaxedSessionCap: relaxedUsed, eligibleCandidates: cases.length },
  files: {
    cases: path.basename(casesPath),
    trainVoice: path.basename(trainVoicePath),
    casesSha1: sha1(Buffer.from(casesOut.join('\n') + (casesOut.length ? '\n' : ''))),
    trainVoiceSha1: sha1(Buffer.from(trainTexts.map((t) => JSON.stringify(t)).join('\n') + (trainTexts.length ? '\n' : ''))),
  },
  chanceLevel: {
    poolSize: 21,
    note: 'harness pools 20 sampled TRAIN texts + the real target (21 options) => recovery@1 chance = 4.76%, @5 = 23.8%, @20 = 95.2%.',
  },
  caveats: [
    'A burst is really "until the other party replies"; burstStats only approximates it with a 180s gap (see lib.mjs).',
    'todLabel uses UTC hours, so labels do not shift with the machine timezone.',
    'Cue content is raw conversation context including the other party; do not ship cues as a user-visible dataset.',
  ],
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// ---------------------------------------------------------------------------
// human-readable summary
// ---------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log(`weclone-eval cases frozen -> ${outDir}`);
console.log(`split     TEST = last ${holdoutDays} days (ts > ${boundaryTs} = ${manifest.split.boundaryIso})`);
console.log(`corpus    voice ${voiceRows.length} rows (train ${trainRows.length} / test ${testSet.size}) | chunks ${chunkLines} lines`);
console.log(`pairing   authored lines ${authoredLines}, matched ${matchedLines} (${(matchRate * 100).toFixed(1)}%), lookahead ${lookaheadMatches}`);
console.log(`cases     ${finalCases.length} written of ${cases.length} eligible candidates in the test window`);
console.log('');
console.log('strata (functionLabel x time-of-day, UTC)');
console.log('  ' + pad('', 11) + TOD_ORDER.map((t) => pad(t, 11)).join('') + 'total');
for (const fn of FN_ORDER) {
  const row = TOD_ORDER.map((t) => strata[fn][t]);
  console.log('  ' + pad(fn, 11) + row.map((v) => pad(v, 11)).join('') + row.reduce((a, b) => a + b, 0));
}
console.log('  ' + pad('sessions', 11) + `${sessionCounts.size} distinct sessions used, max ${Math.max(0, ...sessionCounts.values())} cases from any one session`);
console.log('');
console.log('drops');
for (const [k, v] of Object.entries(drops)) console.log(`  ${pad(k, 22)} ${v}`);
console.log(`  ${pad('  -> ngram8', 22)} ${leakRule.ngram8}   (>=8 char verbatim in persona markdown)`);
console.log(`  ${pad('  -> shortSubstring', 22)} ${leakRule.shortSubstring}   (target <8 chars, whole target found in markdown; these are mostly short filler phrases)`);
if (leakedLengths.length) {
  const llMean = mean(leakedLengths);
  const llMed = median(leakedLengths);
  console.log(`  ${pad('leaked target len', 22)} mean=${llMean.toFixed(1)} median=${llMed} (${leakRule.shortSubstring} of ${drops.leakedIntoPersona} dropped targets are shorter than ${LEAK_NGRAM} chars)`);
}
console.log(`  ${pad('leak control', 22)} ${leakControl.hits}/${leakControl.n} sampled TRAIN messages also match (${leakControl.rate == null ? '-' : (leakControl.rate * 100).toFixed(1)}%)`);
console.log('');
const tlen = manifest.targetStats.length;
console.log(`targets   n=${finalCases.length} mean=${tlen.mean == null ? '-' : tlen.mean.toFixed(1)} median=${tlen.median} p10=${tlen.p10} p90=${tlen.p90} chars`);
console.log(`buckets   ${Object.entries(bucketCounts).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`cues      mean=${manifest.cueStats.length.mean == null ? '-' : manifest.cueStats.length.mean.toFixed(0)} chars, ${manifest.cueStats.truncatedCases} capped at ${maxCueChars}`);
console.log(`chance    21-option pool (20 sampled train + target): recovery@1 = ${(100 / 21).toFixed(1)}%`);
console.log(`files     ${path.basename(casesPath)}, ${path.basename(trainVoicePath)} (${trainTexts.length} train texts), ${path.basename(manifestPath)}`);
console.log('');
console.log('NOTE: cases.jsonl contains real personal messages. Keep it inside .ui-probe/ or another ignored path;');
console.log('      never commit it and never paste a target/cue into a chat, issue or report.');
