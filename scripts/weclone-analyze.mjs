/**
 * weclone-analyze.mjs — deterministic voice analysis over weclone-staging chunks.
 * Extracts: user's own lines, style stats, top phrases, emoticons, eval pairs,
 * categorized exemplar candidates. Output: JSON to stdout (or file via argv[2]).
 */
import { createInterface } from 'node:readline'
import { createReadStream, writeFileSync } from 'node:fs'

const STAGING = String(process.argv[2] || '').replace(/\/+$/, '')
const OUT = process.argv[3] || ''
if (!STAGING) {
  console.error('usage: node weclone-analyze.mjs <stagingDir> [outJson]')
  process.exit(1)
}

const MY = '我'
const lines = [] // { sid, ts, talker, mine, text }

const rl = createInterface({ input: createReadStream(`${STAGING}/chunks.jsonl`, 'utf8'), crlfDelay: Infinity })
for await (const raw of rl) {
  const t = raw.trim()
  if (!t) continue
  let chunk
  try { chunk = JSON.parse(t) } catch { continue }
  const sid = chunk.sid || ''
  const ts = chunk.ts || 0
  // chunk text lines: "wxid_x: wxid_x: content" | "我: content" | bare continuation?
  const parts = String(chunk.text || '').split('\n')
  let lastTalker = chunk.talker || ''
  for (const lineRaw of parts) {
    const line = lineRaw.trim()
    if (!line) continue
    let m
    if ((m = line.match(/^我:\s*(.*)$/))) {
      lines.push({ sid, ts, mine: true, text: m[1] })
    } else if ((m = line.match(/^([^\s:]+):\s*\1:\s*(.*)$/))) {
      lastTalker = m[1]
      lines.push({ sid, ts, mine: false, talker: lastTalker, text: m[2] })
    } else if ((m = line.match(/^([^\s:]+):\s*(.*)$/))) {
      lastTalker = m[1]
      lines.push({ sid, ts, mine: false, talker: lastTalker, text: m[2] })
    }
  }
}
rl.close()

const mineAll = lines.filter((l) => l.mine && l.text.trim())
// filter noise: xml, pure emoji-msg, empty
const isNoise = (s) => /^\s*</.test(s) || /^<\?xml/.test(s) || !s.trim()
const mine = mineAll.filter((l) => !isNoise(l.text))

// ---- length stats ----
const lens = mine.map((l) => [...l.text].length).sort((a, b) => a - b)
const pct = (p) => lens[Math.floor((lens.length - 1) * p)] ?? 0
const sum = lens.reduce((a, b) => a + b, 0)

// ---- ending punctuation distribution ----
const endDist = {}
for (const l of mine) {
  const s = l.text.trim()
  const ch = [...s].pop() || ''
  let key = 'none'
  if (/^[。．.]$/.test(ch)) key = '。'
  else if (/^[？?]$/.test(ch)) key = '?'
  else if (/^[！!]$/.test(ch)) key = '!'
  else if (/^~$/.test(ch)) key = '~'
  else if (/^…$/.test(ch)) key = '...'
  else if (/^,$/.test(ch)) key = ','
  else if (!/[\u4e00-\u9fffA-Za-z0-9）)”"’%\]]/.test(ch)) key = `other:${ch}`
  endDist[key] = (endDist[key] || 0) + 1
}

// ---- english lowercase ratio (letters at word starts) ----
let enWords = 0, enLowerStart = 0
for (const l of mine) {
  for (const w of l.text.match(/[A-Za-z]+/g) || []) {
    enWords += 1
    if (/^[a-z]/.test(w)) enLowerStart += 1
  }
}

// ---- emoticons [xxx] used by me ----
const emo = {}
for (const l of mine) {
  for (const m of l.text.match(/\[[^\[\]]{1,12}\]/g) || []) emo[m] = (emo[m] || 0) + 1
}
const topEmo = Object.entries(emo).sort((a, b) => b[1] - a[1]).slice(0, 25)

// ---- laughter / reaction tokens ----
const reactTokens = ['哈哈', '哈哈哈哈', '666', '233', '草', 'bruh', 'lol', 'Lol', 'LOL', 'lmao', '难绷', '绷不住', '笑死', 'wtf', 'omg', 'sb', 'tf', 'gay', 'sehr gut', 'nb', '牛', '寄', '麻了', 'g']
const reactCounts = {}
for (const tok of reactTokens) {
  const re = new RegExp(`(^|[^\\u4e00-\\u9fffA-Za-z])${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\u4e00-\\u9fffA-Za-z])`, 'g')
  let n = 0
  for (const l of mine) {
    const hits = l.text.match(re)
    if (hits) n += hits.length / 2
  }
  if (n > 0) reactCounts[tok] = Math.round(n)
}

// ---- top repeated phrases (verbatim, freq>=3, len>=2, not pure numbers/punct) ----
const phrase = {}
for (const l of mine) {
  const s = l.text.trim()
  if (s.length < 2 || s.length > 40) continue
  if (isNoise(s)) continue
  phrase[s] = (phrase[s] || 0) + 1
}
const dupPhrases = Object.entries(phrase).filter(([k, v]) => v >= 3 && !/^[\d\s\W]+$/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 120)

// ---- n-grams across messages (CJK bigrams/trigrams + EN unigrams) ----
const gram = {}
const addGram = (g) => { if (g) gram[g] = (gram[g] || 0) + 1 }
for (const l of mine) {
  const s = l.text.toLowerCase()
  const cjkRuns = s.match(/[\u4e00-\u9fff]{2,}/g) || []
  for (const run of cjkRuns) {
    for (let i = 0; i + 2 <= run.length && i < 12; i++) addGram(run.slice(i, i + 2))
    for (let i = 0; i + 3 <= run.length && i < 10; i++) addGram(run.slice(i, i + 3))
  }
  for (const w of s.match(/[a-z][a-z0-9']{1,15}/g) || []) addGram(w)
}
const stopEn = new Set(['the','a','an','to','of','in','is','are','was','it','and','or','you','i','me','my','we','us','this','that','be','have','has','do','does','did','not','no','yes','ok','oh','so','if','on','at','for','with','can','could','would','will','just','but','what','how','why','when','who','its',"it's",'im',"i'm",'ur','u'])
const topGrams = Object.entries(gram)
  .filter(([g, c]) => c >= 8 && !stopEn.has(g) && !/^\d+$/.test(g))
  .sort((a, b) => b[1] - a[1]).slice(0, 80)

// ---- question rate ----
const qRate = mine.filter((l) => /[?？]\s*$/.test(l.text) || /^(为什么|怎么|啥|什么|哪|which|what|how|why|is |are |do |does |did |r u)/i.test(l.text.trim())).length / Math.max(1, mine.length)

// ---- time buckets (activity) ----
const hourHist = new Array(24).fill(0)
for (const l of mine) if (l.ts) hourHist[new Date(l.ts * 1000).getHours()] += 1

// ---- eval pairs: friend stimulus -> my next reply (same chunk adjacency) ----
const pairs = []
for (let i = 1; i < lines.length; i++) {
  const prev = lines[i - 1], cur = lines[i]
  if (cur.mine && !prev.mine && !cur.sameAsPrev) {
    const st = prev.text.trim(), rp = cur.text.trim()
    if (isNoise(st) || isNoise(rp)) continue
    const sl = [...st].length, rl2 = [...rp].length
    if (sl < 4 || sl > 60 || rl2 < 1 || rl2 > 50) continue
    if (/^<|^http/.test(st)) continue
    pairs.push({ sid: cur.sid, ts: cur.ts, stimulus: st, reply: rp })
  }
}
// dedupe identical stimuli keeping first occurrence, sample spread
const seenStim = new Set()
const uniqPairs = []
for (const p of pairs) {
  const key = p.stimulus
  if (seenStim.has(key)) continue
  seenStim.add(key)
  uniqPairs.push(p)
}

// ---- verbatim exemplars: medium-length own lines, diverse ----
const cand = mine
  .filter((l) => { const n = [...l.text].length; return n >= 3 && n <= 45 && !isNoise(l.text) && !/^@/.test(l.text) })
const exemplarsByFreq = [...dupPhrases.map(([k, c]) => ({ text: k, freq: c }))]
const exemplarsRandom = []
{
  const seen = new Set(exemplarsByFreq.map((e) => e.text))
  const step = Math.max(1, Math.floor(cand.length / 400))
  for (let i = 0; i < cand.length; i += step) {
    const t = cand[i].text.trim()
    if (!seen.has(t)) { seen.add(t); exemplarsRandom.push({ text: t, sid: cand[i].sid }) }
  }
}

const result = {
  totalLines: lines.length,
  myMessages: mine.length,
  lengthStats: { mean: +(sum / Math.max(1, lens.length)).toFixed(1), p25: pct(0.25), p50: pct(0.5), p75: pct(0.75), p90: pct(0.9) },
  endDist: Object.fromEntries(Object.entries(endDist).sort((a, b) => b[1] - a[1]).slice(0, 10)),
  enLowerStartRate: +(enLowerStart / Math.max(1, enWords)).toFixed(2),
  enWordTotal: enWords,
  questionRate: +qRate.toFixed(2),
  topEmoticons: topEmo,
  reactionTokens: reactCounts,
  topRepeatedFullLines: dupPhrases,
  topNgrams: topGrams,
  hourHist,
  evalPairCount: uniqPairs.length,
  evalPairsSample: uniqPairs.filter((_, i) => i % Math.max(1, Math.floor(uniqPairs.length / 150)) === 0).slice(0, 150),
  exemplarsRandom: exemplarsRandom.slice(0, 200),
}

if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2))
console.log(JSON.stringify({
  totalLines: result.totalLines,
  myMessages: result.myMessages,
  lengthStats: result.lengthStats,
  endDistTop: Object.fromEntries(Object.entries(result.endDist).slice(0, 6)),
  enLowerStartRate: result.enLowerStartRate,
  questionRate: result.questionRate,
  topEmoticons: result.topEmoticons.slice(0, 12),
  reactionTokens: result.reactionTokens,
  topRepeatedFullLines: result.topRepeatedFullLines.slice(0, 40),
  topNgrams: result.topNgrams.slice(0, 40),
  hourPeak: result.hourHist.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, 6),
  evalPairCount: result.evalPairCount,
}, null, 2))
