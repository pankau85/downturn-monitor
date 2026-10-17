// Calibration report: node pipeline/calibrate.js data/data.json
// Prints live readings, composite history summary, per-indicator discrimination (recession vs expansion), and the back-test.
const path = require('path');
const DM = require(path.join(__dirname, '..', 'site', 'engine.js'));
const data = require(path.resolve(process.argv[2] || 'data/data.json'));
const settings = process.argv[3] ? JSON.parse(require('fs').readFileSync(process.argv[3], 'utf8')) : {};
const today = DM.dateToDay(new Date());
const m = DM.buildModel(data, settings);
const live = DM.aggregate(m, today, true);
const f = v => (v == null ? '  –  ' : v.toFixed(2));
console.log(`\n=== LIVE (${DM.dayToYmd(today)}) composite ${f(live.composite)} ${live.composite != null ? DM.levelOf(live.composite).name : ''} | economy ${f(live.macro)} | markets ${f(live.market)} | coverage ${(live.coverage * 100).toFixed(0)}% | n=${live.n}`);
for (const p of m.pillars) console.log(`  ${p.name.padEnd(32)} ${f(live.pillars[p.id].score)}  (${live.pillars[p.id].n} ind)`);
console.log('\n--- indicators (live) ---');
for (const x of m.ind) { const r = live.byInd[x.def.id]; console.log(`  ${x.def.id.padEnd(13)} ${x.def.short.padEnd(26)} ${x.available ? (r ? x.def.fmt(r.value).padStart(14) + '  score ' + f(r.score) + '  as of ' + DM.dayToYmd(r.t) : 'no reading') : 'UNAVAILABLE ' + (x.error || '')}`); }

const h = DM.history(m, '1990-01-31', today);
const recs = DM.recessions(m.S);
const inRec = d => recs.some(r => d >= r.start && (r.end == null || d < r.end));
console.log('\n--- composite by year (mean of month-ends) ---');
const byYear = {};
h.t.forEach((t, i) => { const y = DM.dayToYmd(t).slice(0, 4); (byYear[y] = byYear[y] || []).push(h.composite[i]); });
let line = '';
for (const y of Object.keys(byYear)) { const a = byYear[y].filter(v => v != null); const mean = a.reduce((s, v) => s + v, 0) / (a.length || 1); const mx = Math.max(...a); line += `${y}:${mean.toFixed(1)}/${mx.toFixed(1)}  `; if (line.length > 110) { console.log('  ' + line); line = ''; } }
if (line) console.log('  ' + line);

console.log('\n--- per-indicator discrimination: mean score in recession months vs expansion months (since 1990) ---');
for (const x of m.ind) { if (!x.available) continue; let sr = 0, nr = 0, se = 0, ne = 0, s5 = 0; for (let i = 0; i < h.t.length; i++) { const r = DM.readIndicator(x, h.t[i], false); if (!r || r.score == null) continue; if (inRec(h.t[i])) { sr += r.score; nr++; } else { se += r.score; ne++; if (r.score >= 4) s5++; } } console.log(`  ${x.def.short.padEnd(26)} recession ${nr ? (sr / nr).toFixed(2) : '  – '} (${String(nr).padStart(3)} m)   expansion ${ne ? (se / ne).toFixed(2) : '  – '} (${String(ne).padStart(3)} m)   expansion months at ≥4: ${s5}`); }

const bt = DM.backtest(m, h);
console.log('\n--- back-test ---');
for (const r of bt.recessions) console.log(`  ${r.name.padEnd(34)} -12m ${f(r.m12)}  -6m ${f(r.m6)}  -3m ${f(r.m3)}  start ${f(r.m0)}  peak ${f(r.peak)}  first High: ${r.lead == null ? 'none' : r.lead + 'm before'}`);
for (const e of bt.stress) console.log(`  ${e.name.padEnd(34)} peak ${f(e.peak)}`);
console.log('\n--- last 36 month-ends ---');
for (let i = Math.max(0, h.t.length - 36); i < h.t.length; i++) console.log(`  ${DM.dayToYmd(h.t[i])}  composite ${f(h.composite[i])}  economy ${f(h.macro[i])}  markets ${f(h.market[i])}  ${h.composite[i] != null ? DM.levelOf(h.composite[i]).name : ''}`);
