// Exact binomial power analysis for the owner-as-rater identification test.
// Run: node docs/research/weclone/_scratch/binom-power.mjs
// No dependencies. All numbers printed are exact (double-precision) binomial sums.

const logFact = [0];
for (let i = 1; i < 5000; i++) logFact[i] = logFact[i - 1] + Math.log(i);
const logChoose = (n, k) => logFact[n] - logFact[k] - logFact[n - k];
const binomPmf = (k, n, p) =>
  k < 0 || k > n ? 0 : p === 0 ? (k === 0 ? 1 : 0) : Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
const upperTail = (k, n, p) => {           // P(X >= k)
  let s = 0;
  for (let i = k; i <= n; i++) s += binomPmf(i, n, p);
  return Math.min(1, s);
};

// ---- 1. two-alternative forced choice (real vs clone), chance = 0.5 ----
console.log('=== 2AFC: "which of these did I write?"  chance p0 = 0.50, one-sided alpha = 0.05 ===');
const curve = [];
for (let n = 8; n <= 60; n++) {
  let crit = n + 1;
  for (let k = 0; k <= n; k++) if (upperTail(k, n, 0.5) <= 0.05) { crit = k; break; }
  curve.push({ n, crit, obs: crit / n, typeI: upperTail(crit, n, 0.5) });
}
console.log('n\tcrit(>=)\tcrit/n\talpha_actual');
for (const r of curve) console.log(`${r.n}\t${r.crit}\t\t${(r.obs * 100).toFixed(1)}%\t${r.typeI.toFixed(4)}`);

console.log('\n=== power at true accuracy p (one-sided 0.05) ===');
console.log('n\tcrit\t' + [0.60, 0.65, 0.70, 0.75, 0.80, 0.90].map(p => 'p=' + p).join('\t'));
for (const n of [10, 15, 20, 25, 30, 40, 50, 60]) {
  const r = curve.find(x => x.n === n);
  const row = [0.60, 0.65, 0.70, 0.75, 0.80, 0.90]
    .map(p => upperTail(r.crit, n, p).toFixed(3)).join('\t');
  console.log(`${n}\t${r.crit}\t${row}`);
}

console.log('\n=== minimum n for 80% / 90% power ===');
for (const p of [0.60, 0.65, 0.70, 0.75, 0.80]) {
  let n80 = null, n90 = null;
  for (let n = 6; n <= 400; n++) {
    let crit = n + 1;
    for (let k = 0; k <= n; k++) if (upperTail(k, n, 0.5) <= 0.05) { crit = k; break; }
    const pw = upperTail(crit, n, p);
    if (n80 === null && pw >= 0.8) n80 = { n, crit };
    if (n90 === null && pw >= 0.9) { n90 = { n, crit }; break; }
  }
  console.log(`true p = ${p}: 80% power at n = ${n80.n} (need >= ${n80.crit} correct); 90% power at n = ${n90.n} (need >= ${n90.crit})`);
}

// ---- 2. three-way ranking (real / cloneA / cloneB), chance = 1/3 ----
console.log('\n=== 3-way: "which of the three did I write?"  chance p0 = 1/3, one-sided alpha = 0.05 ===');
for (let n = 9; n <= 45; n += 3) {
  let crit = n + 1;
  for (let k = 0; k <= n; k++) if (upperTail(k, n, 1 / 3) <= 0.05) { crit = k; break; }
  const p65 = upperTail(crit, n, 0.65), p75 = upperTail(crit, n, 0.75), p50 = upperTail(crit, n, 0.50);
  console.log(`n=${n}\tcrit>=${crit} (${(100 * crit / n).toFixed(1)}%)\talpha=${upperTail(crit, n, 1 / 3).toFixed(4)}\tpower@0.50=${p50.toFixed(3)}\tpower@0.65=${p65.toFixed(3)}\tpower@0.75=${p75.toFixed(3)}`);
}

// ---- 3. Wilson 95% CI for an observed proportion ----
console.log('\n=== Wilson 95% CI ===');
const wilson = (k, n) => {
  const z = 1.959964, p = k / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [((c - h) / d * 100).toFixed(1), ((c + h) / d * 100).toFixed(1)];
};
for (const [k, n] of [[10, 20], [15, 30], [18, 30], [20, 30], [24, 30], [12, 20], [36, 60], [40, 60], [48, 60]])
  console.log(`${k}/${n} = ${(100 * k / n).toFixed(1)}%  -> 95% CI [${wilson(k, n).join(', ')}]%`);

// ---- 4. paired comparison: how many discordant pairs are needed (McNemar / sign test) ----
console.log('\n=== McNemar-style: A beats B on d discordant trials out of m; how many discordant trials needed ===');
for (const m of [5, 8, 10, 12, 15, 20, 30]) {
  const crit = Math.ceil(m / 2 + 0.5 * Math.sqrt(m) * 1.96); // normal approx, continuity ignored
  let exact = m + 1;
  for (let k = 0; k <= m; k++) if (upperTail(k, m, 0.5) <= 0.05) { exact = k; break; }
  console.log(`m=${m} discordant: need >= ${exact} one way (exact one-sided 0.05); normal approx ${crit}`);
}
