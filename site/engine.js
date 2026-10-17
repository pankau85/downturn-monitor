/* Downturn Monitor — scoring engine (pure functions, no DOM)
 * Works in the browser (window.DM) and in Node (module.exports) so the page's
 * logic can be unit-tested against the real data file.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MS_DAY = 86400000;
  const dayToDate = d => new Date(d * MS_DAY);
  const dateToDay = date => Math.floor(date.getTime() / MS_DAY);
  const ymdToDay = s => { const [y, m, d] = s.split('-').map(Number); return Math.floor(Date.UTC(y, m - 1, d) / MS_DAY); };
  const dayToYmd = d => dayToDate(d).toISOString().slice(0, 10);
  const monthEndDay = (y, m) => Math.floor(Date.UTC(y, m, 0) / MS_DAY); // m is 1..12 → last day of that month
  const addMonths = (day, k) => { const dt = dayToDate(day); const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1 + k; return monthEndDay(y + Math.floor((m - 1) / 12), ((m - 1) % 12 + 12) % 12 + 1); };

  // ---------- series primitives: {t:[days asc], v:[numbers]} ----------
  function idxAt(s, day) { // index of last t <= day, or -1
    let lo = 0, hi = s.t.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (s.t[mid] <= day) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function valueAt(s, day, maxGapDays) {
    if (!s || !s.t.length) return null;
    const i = idxAt(s, day);
    if (i < 0) return null;
    if (maxGapDays != null && day - s.t[i] > maxGapDays) return null;
    return { t: s.t[i], v: s.v[i], i };
  }
  const last = s => (s && s.t.length) ? { t: s.t[s.t.length - 1], v: s.v[s.v.length - 1] } : null;
  const mk = (t, v) => ({ t, v });
  function mapSeries(s, fn) { const t = [], v = []; for (let i = 0; i < s.t.length; i++) { const r = fn(s.v[i], i, s); if (r != null && Number.isFinite(r)) { t.push(s.t[i]); v.push(r); } } return mk(t, v); }
  function slice(s, fromDay, toDay) { const t = [], v = []; for (let i = 0; i < s.t.length; i++) { if (s.t[i] >= fromDay && (toDay == null || s.t[i] <= toDay)) { t.push(s.t[i]); v.push(s.v[i]); } } return mk(t, v); }
  function upTo(s, day) { const i = idxAt(s, day); return i < 0 ? mk([], []) : mk(s.t.slice(0, i + 1), s.v.slice(0, i + 1)); }

  // index-based changes (for regular monthly/weekly/quarterly series)
  function pctChangeK(s, k) { const t = [], v = []; for (let i = k; i < s.t.length; i++) { const b = s.v[i - k]; if (b) { t.push(s.t[i]); v.push((s.v[i] / b - 1) * 100); } } return mk(t, v); }
  function diffK(s, k) { const t = [], v = []; for (let i = k; i < s.t.length; i++) { t.push(s.t[i]); v.push(s.v[i] - s.v[i - k]); } return mk(t, v); }
  // date-based change (for irregular daily series): value now minus/over value `days` earlier
  function changeDays(s, days, pct) { const t = [], v = []; for (let i = 0; i < s.t.length; i++) { const r = valueAt(s, s.t[i] - days, Math.max(10, days * 0.2)); if (r && r.i < i) { t.push(s.t[i]); v.push(pct ? (s.v[i] / r.v - 1) * 100 : s.v[i] - r.v); } } return mk(t, v); }
  function rollMean(s, n) { const t = [], v = []; let sum = 0; for (let i = 0; i < s.t.length; i++) { sum += s.v[i]; if (i >= n) sum -= s.v[i - n]; if (i >= n - 1) { t.push(s.t[i]); v.push(sum / n); } } return mk(t, v); }
  function rollMax(s, n) { const t = [], v = []; for (let i = 0; i < s.t.length; i++) { let m = -Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) if (s.v[j] > m) m = s.v[j]; if (i >= Math.min(n, 20) - 1) { t.push(s.t[i]); v.push(m); } } return mk(t, v); }
  function rollMin(s, n) { const t = [], v = []; for (let i = 0; i < s.t.length; i++) { let m = Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) if (s.v[j] < m) m = s.v[j]; if (i >= Math.min(n, 20) - 1) { t.push(s.t[i]); v.push(m); } } return mk(t, v); }
  // combine on a's grid: fn(a_i, b at or before t_i)
  function combine(a, b, fn, maxGap) { const t = [], v = []; for (let i = 0; i < a.t.length; i++) { const r = valueAt(b, a.t[i], maxGap); if (r) { const x = fn(a.v[i], r.v); if (x != null && Number.isFinite(x)) { t.push(a.t[i]); v.push(x); } } } return mk(t, v); }
  function percentileOf(s, day, lookbackDays) { // percentile rank (0-100) of value at day within trailing window
    const r = valueAt(s, day); if (!r) return null; const from = day - lookbackDays; let n = 0, below = 0, eq = 0;
    for (let j = r.i; j >= 0 && s.t[j] >= from; j--) { n++; if (s.v[j] < r.v) below++; else if (s.v[j] === r.v) eq++; }
    return n > 1 ? 100 * (below + 0.5 * eq) / n : null;
  }

  // ---------- scoring ----------
  // anchors: value at score 1,2,3,4,5 (monotone increasing or decreasing). Linear between anchors, clamped.
  function scoreFromAnchors(x, A) {
    if (x == null || !Number.isFinite(x)) return null;
    const inc = A[4] > A[0];
    const a = inc ? A : A.map(v => -v); const y = inc ? x : -x;
    if (y <= a[0]) return 1; if (y >= a[4]) return 5;
    for (let k = 0; k < 4; k++) if (y <= a[k + 1]) { const span = a[k + 1] - a[k]; return span > 0 ? (k + 1) + (y - a[k]) / span : k + 2; }
    return 5;
  }
  const scoreSeries = (s, A) => mapSeries(s, x => scoreFromAnchors(x, A));
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const maxSeries = (a, b) => combine(a, b, (x, y) => Math.max(x, y), 45);
  const meanSeries = (a, b) => combine(a, b, (x, y) => (x + y) / 2, 45);

  // Cycle-aware yield-curve scorer. Inverted → 4.0–4.8 by depth. Sustained re-steepening after a
  // material inversion → 5 for ~9 months, fading to the level score by month 18. Otherwise level-based.
  function curveScore(spread, opts) {
    const o = Object.assign({ matDays: 40, minRun: 10, lookback: 730, window1: 270, window2: 540, levelAnchors: [1.75, 1.0, 0.4, 0.0, -0.5] }, opts || {});
    const t = [], v = [], meta = [];
    let invRun = 0, posRun = 0, lastInvEnd = null, materialAtEnd = false;
    const invDays = []; // days with inversion (for trailing count)
    for (let i = 0; i < spread.t.length; i++) {
      const d = spread.t[i], x = spread.v[i];
      if (x < 0) { invRun++; posRun = 0; invDays.push(d); } else { posRun++; if (invRun >= o.minRun) { // a real inversion run (not a one-week blip) just ended
          while (invDays.length && invDays[0] < d - o.lookback) invDays.shift();
          materialAtEnd = invDays.length >= o.matDays; lastInvEnd = d; } invRun = 0; }
      while (invDays.length && invDays[0] < d - o.lookback) invDays.shift();
      let score, state;
      if (x < 0) { score = clamp(4.0 + 0.8 * Math.min(1, -x / 1.0), 4, 4.8); state = 'inverted'; }
      else if (lastInvEnd != null && materialAtEnd && d - lastInvEnd <= o.window2) {
        const since = d - lastInvEnd; const lvl = scoreFromAnchors(x, o.levelAnchors);
        if (since <= o.window1) { score = 5; state = 'post-inversion window'; }
        else { const f = (since - o.window1) / (o.window2 - o.window1); score = 5 + (lvl - 5) * f; state = 'post-inversion fading'; }
      } else { score = scoreFromAnchors(x, o.levelAnchors); state = 'normal'; }
      t.push(d); v.push(score); meta.push(state);
    }
    return { score: mk(t, v), state: meta, lastInvEnd, materialAtEnd };
  }

  // ---------- indicator catalogue ----------
  const F = {
    pct1: x => (x == null ? '–' : x.toFixed(1) + '%'),
    pct2: x => (x == null ? '–' : x.toFixed(2) + '%'),
    pp2: x => (x == null ? '–' : (x >= 0 ? '+' : '') + x.toFixed(2) + ' pp'),
    pp1: x => (x == null ? '–' : (x >= 0 ? '+' : '') + x.toFixed(1) + ' pp'),
    num1: x => (x == null ? '–' : x.toFixed(1)),
    num2: x => (x == null ? '–' : x.toFixed(2)),
    idx: x => (x == null ? '–' : x.toFixed(1)),
    k: x => (x == null ? '–' : (x >= 0 ? '+' : '') + Math.round(x) + 'k'),
    spct: x => (x == null ? '–' : (x >= 0 ? '+' : '') + x.toFixed(1) + '%'),
    yoy: x => (x == null ? '–' : (x >= 0 ? '+' : '') + x.toFixed(1) + '% y/y'),
  };

  const PILLARS = [
    { id: 'rates', name: 'Rates & policy', weight: 15, lens: 'macro', blurb: 'The yield curve and the stance of monetary policy. The curve is the longest-lead signal; the recession usually arrives after it re-steepens, not while it is inverted.' },
    { id: 'credit', name: 'Credit & financial conditions', weight: 20, lens: 'market', blurb: 'What lenders and bond investors are charging for risk. Spreads and stress indexes move early in corrections and confirm recessions.' },
    { id: 'labor', name: 'Labor market', weight: 20, lens: 'macro', blurb: 'Claims lead, the Sahm rule confirms. Labor turns late, but once it turns it rarely reverses without a recession.' },
    { id: 'growth', name: 'Growth & activity', weight: 20, lens: 'macro', blurb: 'Real activity: national activity indexes, surveys, orders, permits and production. Housing and capital goods lead; production is coincident.' },
    { id: 'consumer', name: 'Consumer', weight: 10, lens: 'macro', blurb: 'The household sector: real income, real spending, confidence and credit stress. Two-thirds of GDP, usually the last domino.' },
    { id: 'market', name: 'Market stress', weight: 15, lens: 'market', blurb: 'What equities and volatility are already pricing. The correction side of the question: trend, drawdown and implied volatility.' },
  ];

  // Each indicator: inputs (raw series ids), transform(S) → value series, anchors (value at score 1..5),
  // optional scorer(valueSeries, S) → {score: Series, extra}, lag (publication lag in days for as-of history).
  const INDICATORS = [
    // ---------------- Rates & policy ----------------
    { id: 'curve_10y3m', pillar: 'rates', name: '10-year minus 3-month Treasury spread', short: '10y–3m curve', weight: 30, inputs: ['T10Y3M'], unit: 'pp', fmt: F.pp2, lag: 1,
      transform: S => S.T10Y3M, anchors: [1.75, 1.0, 0.4, 0.0, -0.5], scorer: (vs) => curveScore(vs),
      rule: 'Inverted: 4.0–4.8 by depth. Re-steepening after a material inversion (a run of at least 10 trading days, with 40 or more inverted days in the prior two years): 5 for nine months after the curve turns positive, fading to the level score by month 18. Otherwise by level: ≥1.75 → 1, 1.0 → 2, 0.4 → 3, 0 → 4.',
      why: 'The most reliable recession predictor in US data since the 1960s (Estrella & Mishkin). Inversions have preceded every recession since 1968 with one false signal (1966) and a long, debated episode in 2022–24. Timing is the weak point: recessions start a median of 6–12 months after the curve re-steepens.' },
    { id: 'curve_10y2y', pillar: 'rates', name: '10-year minus 2-year Treasury spread', short: '10y–2y curve', weight: 20, inputs: ['T10Y2Y'], unit: 'pp', fmt: F.pp2, lag: 1,
      transform: S => S.T10Y2Y, anchors: [1.5, 0.8, 0.3, 0.0, -0.4], scorer: (vs) => curveScore(vs, { levelAnchors: [1.5, 0.8, 0.3, 0.0, -0.4] }),
      rule: 'Same cycle-aware logic as 10y–3m with slightly tighter level anchors (≥1.5 → 1, 0.8 → 2, 0.3 → 3, 0 → 4).',
      why: 'The market’s favourite curve measure. It inverts earlier than 10y–3m (the 2-year prices the next two years of policy) and re-steepens earlier too, so it is a useful second clock on the same signal.' },
    { id: 'twos_ff', pillar: 'rates', name: '2-year yield minus fed funds', short: '2y – fed funds', weight: 15, inputs: ['DGS2', 'DFF'], unit: 'pp', fmt: F.pp2, lag: 1,
      transform: S => combine(S.DGS2, S.DFF, (a, b) => a - b, 7), anchors: [0.5, 0.0, -0.5, -1.0, -1.75],
      rule: '≥ +0.50 → 1, 0 → 2, −0.50 → 3, −1.00 → 4, ≤ −1.75 → 5.',
      why: 'When the 2-year trades well below the policy rate the market is pricing rapid cuts, which it only does when it expects the economy to force the Fed’s hand. Readings below −1 pp preceded 2001, 2007–08 and 2019–20.' },
    { id: 'real_ff', pillar: 'rates', name: 'Real policy rate (fed funds minus core PCE inflation)', short: 'Real fed funds', weight: 15, inputs: ['FEDFUNDS', 'PCEPILFE'], unit: 'pp', fmt: F.pp2, lag: 60,
      transform: S => combine(S.FEDFUNDS, pctChangeK(S.PCEPILFE, 12), (ff, pi) => ff - pi, 62), anchors: [0.0, 1.0, 2.0, 3.0, 4.0],
      rule: '≤ 0 → 1, +1 → 2, +2 → 3, +3 → 4, ≥ +4 → 5.',
      why: 'Monetary policy acts with a lag. A real policy rate well above the economy’s neutral rate (most estimates 0.5–1.5%) is the mechanism through which tightening cycles end in recessions.' },
    { id: 'cpi', pillar: 'rates', name: 'CPI inflation, year over year', short: 'CPI inflation', weight: 10, inputs: ['CPIAUCSL'], unit: '%', fmt: F.yoy, lag: 42,
      transform: S => pctChangeK(S.CPIAUCSL, 12), anchors: [2.0, 3.0, 4.0, 5.5, 7.0],
      scorer: (vs) => ({ score: mapSeries(vs, x => Math.max(scoreFromAnchors(x, [2.0, 3.0, 4.0, 5.5, 7.0]), scoreFromAnchors(x, [1.5, 1.0, 0.5, 0.0, -1.0]))) }),
      rule: 'Two-sided: 2% → 1, 3% → 2, 4% → 3, 5.5% → 4, ≥7% → 5; and on the deflation side 1.5% → 1 down to ≤ −1% → 5.',
      why: 'High inflation forces policy tightening (the 1970s, 1980, 2022); outright deflation signals collapsing demand (2009, 2015). Either tail raises downturn risk.' },
    { id: 'oil', pillar: 'rates', name: 'WTI crude oil, year-over-year change', short: 'Oil shock', weight: 10, inputs: ['DCOILWTICO'], unit: '%', fmt: F.yoy, lag: 1,
      transform: S => changeDays(S.DCOILWTICO, 365, true), anchors: [0, 25, 50, 75, 100],
      rule: '≤ 0% → 1, +25% → 2, +50% → 3, +75% → 4, ≥ +100% → 5.',
      why: 'Hamilton’s oil-shock literature: nine of the last eleven US recessions were preceded by a sharp rise in oil prices. A one-sided test; falling oil is read through growth indicators instead.' },
    // ---------------- Credit & financial conditions ----------------
    { id: 'hy_oas', pillar: 'credit', name: 'High-yield OAS, level and 3-month change', short: 'HY spreads', weight: 30, inputs: ['BAMLH0A0HYM2'], unit: '%', fmt: F.pct2, lag: 1,
      transform: S => S.BAMLH0A0HYM2, anchors: [3.25, 4.0, 5.0, 6.5, 8.5],
      scorer: (vs) => ({ score: maxSeries(scoreSeries(vs, [3.25, 4.0, 5.0, 6.5, 8.5]), scoreSeries(changeDays(vs, 91, false), [0.25, 0.75, 1.25, 2.0, 3.5])), aux: { name: '3-month change (pp)', series: changeDays(vs, 91, false), fmt: F.pp2 } }),
      rule: 'Higher of the level score (3.25% → 1, 4% → 2, 5% → 3, 6.5% → 4, ≥8.5% → 5) and the momentum score on the 3-month change (+0.25 pp → 1, +0.75 → 2, +1.25 → 3, +2.0 → 4, ≥ +3.5 → 5).',
      why: 'High-yield spreads are the price of default risk. They widen before and during every recession and every major correction; the speed of widening matters as much as the level.' },
    { id: 'ig_oas', pillar: 'credit', name: 'Investment-grade OAS, level and 3-month change', short: 'IG spreads', weight: 15, inputs: ['BAMLC0A0CM'], unit: '%', fmt: F.pct2, lag: 1,
      transform: S => S.BAMLC0A0CM, anchors: [0.95, 1.15, 1.45, 1.9, 2.6],
      scorer: (vs) => ({ score: maxSeries(scoreSeries(vs, [0.95, 1.15, 1.45, 1.9, 2.6]), scoreSeries(changeDays(vs, 91, false), [0.10, 0.25, 0.45, 0.75, 1.25])), aux: { name: '3-month change (pp)', series: changeDays(vs, 91, false), fmt: F.pp2 } }),
      rule: 'Higher of level (0.95% → 1, 1.15 → 2, 1.45 → 3, 1.9 → 4, ≥2.6 → 5) and 3-month change (+0.10 pp → 1, +0.25 → 2, +0.45 → 3, +0.75 → 4, ≥ +1.25 → 5).',
      why: 'Investment-grade spreads move less but matter more for TRS-sized fixed income books: they drive mark-to-market on the core bond sleeve and signal funding stress for large borrowers.' },
    { id: 'nfci', pillar: 'credit', name: 'Chicago Fed National Financial Conditions Index', short: 'NFCI', weight: 25, inputs: ['NFCI'], unit: 'index', fmt: F.num2, lag: 5,
      transform: S => S.NFCI, anchors: [-0.6, -0.4, -0.2, 0.1, 0.6],
      rule: '≤ −0.60 → 1, −0.40 → 2, −0.20 → 3, +0.10 → 4, ≥ +0.60 → 5. Zero is the long-run average; positive means tighter than average.',
      why: 'A weekly composite of 105 measures of risk, credit and leverage. Every recession since 1971 has seen it move above zero; most of the time it sits comfortably negative.' },
    { id: 'stlfsi', pillar: 'credit', name: 'St. Louis Fed Financial Stress Index', short: 'Financial stress', weight: 15, inputs: ['STLFSI4'], unit: 'index', fmt: F.num2, lag: 6,
      transform: S => S.STLFSI4, anchors: [-0.6, -0.3, 0.1, 1.0, 2.5],
      rule: '≤ −0.60 → 1, −0.30 → 2, +0.10 → 3, +1.0 → 4, ≥ +2.5 → 5. Zero is average stress.',
      why: 'Built from 18 weekly series (yields, spreads, volatility). It spikes in market crises (2008, 2020, March 2023) and so complements the slower NFCI.' },
    { id: 'sloos', pillar: 'credit', name: 'Banks tightening C&I lending standards (SLOOS, net %)', short: 'Bank lending standards', weight: 15, inputs: ['DRTSCILM'], unit: '%', fmt: F.num1, lag: 35,
      transform: S => S.DRTSCILM, anchors: [-5, 5, 20, 40, 60],
      rule: '≤ −5% → 1, +5% → 2, +20% → 3, +40% → 4, ≥ +60% → 5.',
      why: 'The Fed’s quarterly loan-officer survey. Net tightening above 40% has accompanied every recession since the survey began in 1990 and leads C&I loan growth by two to three quarters.' },
    // ---------------- Labor ----------------
    { id: 'sahm', pillar: 'labor', name: 'Sahm rule (3-month average unemployment minus 12-month low)', short: 'Sahm rule', weight: 35, inputs: ['SAHMREALTIME'], unit: 'pp', fmt: F.pp2, lag: 35,
      transform: S => S.SAHMREALTIME, anchors: [0.05, 0.2, 0.3, 0.4, 0.5],
      rule: '≤ 0.05 pp → 1, 0.20 → 2, 0.30 → 3, 0.40 → 4, ≥ 0.50 → 5 (the official trigger).',
      why: 'Claudia Sahm’s rule has flagged every recession since 1970 within months of its start with no false positives until the debated August 2024 trigger. It confirms rather than predicts, which is exactly why it anchors the labor pillar.' },
    { id: 'claims', pillar: 'labor', name: 'Initial claims (4-week average) above the 52-week low', short: 'Initial claims', weight: 25, inputs: ['ICSA'], unit: '%', fmt: F.spct, lag: 5,
      transform: S => { const a = rollMean(S.ICSA, 4); const lo = rollMin(a, 52); return combine(a, lo, (x, m) => (x / m - 1) * 100, 0); }, anchors: [8, 15, 25, 40, 60],
      rule: '≤ 8% above the 52-week low → 1, 15% → 2, 25% → 3, 40% → 4, ≥ 60% → 5.',
      why: 'The timeliest labor data there is. Measuring claims against their own trailing low removes the drift from population growth; recessions see a 50–100% rise from the low.' },
    { id: 'cont_claims', pillar: 'labor', name: 'Continued claims, year-over-year change', short: 'Continued claims', weight: 15, inputs: ['CCSA'], unit: '%', fmt: F.yoy, lag: 12,
      transform: S => pctChangeK(S.CCSA, 52), anchors: [-5, 2, 10, 20, 35],
      rule: '≤ −5% y/y → 1, +2% → 2, +10% → 3, +20% → 4, ≥ +35% → 5.',
      why: 'Rising continued claims mean the unemployed are not finding work. It is a cleaner read on hiring than initial claims, with a one-week extra lag.' },
    { id: 'payrolls', pillar: 'labor', name: 'Nonfarm payrolls, 3-month average monthly change', short: 'Payroll growth', weight: 25, inputs: ['PAYEMS'], unit: 'k', fmt: F.k, lag: 35,
      transform: S => mapSeries(diffK(S.PAYEMS, 3), x => x / 3), anchors: [175, 100, 50, 0, -100],
      rule: '≥ +175k/month → 1, +100k → 2, +50k → 3, 0 → 4, ≤ −100k → 5.',
      why: 'Payroll growth below break-even (roughly 50–100k a month at current demographics) pushes unemployment up. Negative three-month averages have only occurred in or at the edge of recessions. Note that benchmark revisions can move recent months materially.' },
    // ---------------- Growth & activity ----------------
    { id: 'cfnai', pillar: 'growth', name: 'Chicago Fed National Activity Index, 3-month average', short: 'CFNAI-MA3', weight: 25, inputs: ['CFNAIMA3'], unit: 'index', fmt: F.num2, lag: 52,
      transform: S => S.CFNAIMA3, anchors: [0.25, 0.0, -0.25, -0.5, -0.7],
      rule: '≥ +0.25 → 1, 0 → 2, −0.25 → 3, −0.50 → 4, ≤ −0.70 → 5 (the Chicago Fed’s recession threshold).',
      why: 'A weighted average of 85 monthly activity indicators. Zero means trend growth; the Chicago Fed treats −0.70 after an expansion as a recession signal, which has worked since 1967 with few misses.' },
    { id: 'wei', pillar: 'growth', name: 'Weekly Economic Index (scaled to 4-quarter GDP growth)', short: 'Weekly Economic Index', weight: 15, inputs: ['WEI'], unit: '%', fmt: F.pct1, lag: 5,
      transform: S => S.WEI, anchors: [2.5, 1.75, 1.0, 0.0, -1.5],
      rule: '≥ 2.5 → 1, 1.75 → 2, 1.0 → 3, 0 → 4, ≤ −1.5 → 5.',
      why: 'Ten weekly series (claims, retail, fuel sales, steel, electricity, tax withholding, rail) scaled to GDP growth. The fastest broad read on real activity, available since 2008.' },
    { id: 'ism', pillar: 'growth', name: 'ISM Manufacturing PMI', short: 'ISM manufacturing', weight: 15, inputs: ['ISMPMI'], unit: 'index', fmt: F.num1, lag: 31, optional: true,
      transform: S => S.ISMPMI, anchors: [55, 51.5, 48.5, 45.5, 42],
      rule: '≥ 55 → 1, 51.5 → 2, 48.5 → 3, 45.5 → 4, ≤ 42 → 5. Fifty is the expansion/contraction line; ISM says ~42.5 is consistent with overall GDP contraction.',
      why: 'The most watched business survey. Manufacturing is a small share of GDP but a large share of cyclical variance. Sourced from DBnomics; FRED no longer carries ISM data.' },
    { id: 'permits', pillar: 'growth', name: 'Building permits, year-over-year change', short: 'Building permits', weight: 15, inputs: ['PERMIT'], unit: '%', fmt: F.yoy, lag: 48,
      transform: S => pctChangeK(S.PERMIT, 12), anchors: [5, 0, -8, -18, -30],
      rule: '≥ +5% y/y → 1, 0 → 2, −8% → 3, −18% → 4, ≤ −30% → 5.',
      why: '“Housing is the business cycle” (Leamer, 2007). Permits lead starts, which lead construction employment and durable-goods demand by two to four quarters.' },
    { id: 'capex', pillar: 'growth', name: 'Core capital goods orders, year-over-year change', short: 'Core capex orders', weight: 10, inputs: ['NEWORDER'], unit: '%', fmt: F.yoy, lag: 56,
      transform: S => pctChangeK(S.NEWORDER, 12), anchors: [4, 1, -2, -5, -10],
      rule: '≥ +4% y/y → 1, +1% → 2, −2% → 3, −5% → 4, ≤ −10% → 5.',
      why: 'Nondefense capital goods excluding aircraft is the cleanest read on business investment intentions, which fall first when CFOs lose confidence.' },
    { id: 'indpro', pillar: 'growth', name: 'Industrial production, year-over-year change', short: 'Industrial production', weight: 10, inputs: ['INDPRO'], unit: '%', fmt: F.yoy, lag: 46,
      transform: S => pctChangeK(S.INDPRO, 12), anchors: [2.5, 1.0, 0.0, -2.0, -5.0],
      rule: '≥ +2.5% y/y → 1, +1% → 2, 0 → 3, −2% → 4, ≤ −5% → 5.',
      why: 'One of the four coincident series the NBER dating committee watches. Negative year-over-year readings outside recessions have been short-lived (2015–16, 2019, 2023).' },
    { id: 'regional', pillar: 'growth', name: 'Regional Fed manufacturing surveys (Philadelphia + New York, 3-month average)', short: 'Regional Fed surveys', weight: 10, inputs: ['GACDFSA066MSFRBPHI', 'GACDISA066MSFRBNY'], unit: 'index', fmt: F.num1, lag: 20,
      transform: S => { const avg = S.GACDISA066MSFRBNY ? combine(S.GACDFSA066MSFRBPHI, S.GACDISA066MSFRBNY, (a, b) => (a + b) / 2, 20) : S.GACDFSA066MSFRBPHI; return rollMean(avg, 3); }, anchors: [10, 0, -10, -20, -35],
      rule: '≥ +10 → 1, 0 → 2, −10 → 3, −20 → 4, ≤ −35 → 5 (diffusion index, 3-month average).',
      why: 'The Philly Fed and Empire State surveys arrive mid-month, two weeks before ISM. They are noisy, hence the 3-month average.' },
    // ---------------- Consumer ----------------
    { id: 'sentiment', pillar: 'consumer', name: 'Consumer sentiment (Michigan): level and 6-month change', short: 'Consumer sentiment', weight: 25, inputs: ['UMCSENT'], unit: 'index', fmt: F.num1, lag: 28,
      transform: S => S.UMCSENT, anchors: [90, 80, 70, 60, 50],
      scorer: (vs) => ({ score: meanSeries(scoreSeries(vs, [90, 80, 70, 60, 50]), scoreSeries(diffK(vs, 6), [5, 2, -2, -6, -12])), aux: { name: '6-month change (points)', series: diffK(vs, 6), fmt: F.num1 } }),
      rule: 'Average of the level score (90 → 1, 80 → 2, 70 → 3, 60 → 4, ≤ 50 → 5) and the 6-month-change score (+5 → 1, +2 → 2, −2 → 3, −6 → 4, ≤ −12 → 5).',
      why: 'Sentiment leads spending at turning points, but since 2020 its level has been depressed by inflation and partisanship without a recession following, so the change term carries half the weight.' },
    { id: 'real_income', pillar: 'consumer', name: 'Real personal income excluding transfers, year-over-year change', short: 'Real income ex transfers', weight: 30, inputs: ['W875RX1'], unit: '%', fmt: F.yoy, lag: 60,
      transform: S => pctChangeK(S.W875RX1, 12), anchors: [3, 2, 1, 0, -1],
      rule: '≥ +3% y/y → 1, +2% → 2, +1% → 3, 0 → 4, ≤ −1% → 5.',
      why: 'Another of the NBER’s four coincident indicators and the purest measure of earned purchasing power. It has fallen year over year only in recessions and in the 2022 inflation squeeze.' },
    { id: 'real_retail', pillar: 'consumer', name: 'Real retail and food-services sales, year-over-year change', short: 'Real retail sales', weight: 25, inputs: ['RRSFS'], unit: '%', fmt: F.yoy, lag: 45,
      transform: S => pctChangeK(S.RRSFS, 12), anchors: [2.5, 1.0, 0.0, -2.0, -4.0],
      rule: '≥ +2.5% y/y → 1, +1% → 2, 0 → 3, −2% → 4, ≤ −4% → 5.',
      why: 'Spending adjusted for inflation. Flat-to-negative real sales for several months is the consumer actually retrenching rather than merely saying so.' },
    { id: 'card_dq', pillar: 'consumer', name: 'Credit card delinquency rate, all commercial banks', short: 'Card delinquencies', weight: 20, inputs: ['DRCCLACBS'], unit: '%', fmt: F.pct2, lag: 140,
      transform: S => S.DRCCLACBS, anchors: [2.2, 2.7, 3.2, 4.0, 5.0],
      rule: '≤ 2.2% → 1, 2.7% → 2, 3.2% → 3, 4.0% → 4, ≥ 5.0% → 5.',
      why: 'Household credit stress builds slowly and lags, but the level shows how much cushion consumers have when the labor market softens. Quarterly, published ~7 weeks after quarter end.' },
    // ---------------- Market stress ----------------
    { id: 'spx_dd', pillar: 'market', name: 'S&P 500 drawdown from 52-week high', short: 'S&P 500 drawdown', weight: 35, inputs: ['SPX'], unit: '%', fmt: x => (x == null ? '–' : '−' + x.toFixed(1) + '%'), lag: 1,
      transform: S => { const px = S.SPX; const hi = rollMax(px, 252); return combine(px, hi, (p, h) => (1 - p / h) * 100, 0); }, anchors: [3, 6, 10, 15, 20],
      rule: '≤ 3% below the high → 1, 6% → 2, 10% → 3, 15% → 4, ≥ 20% → 5.',
      why: 'A 10% drawdown is the conventional definition of a correction, 20% of a bear market. Equities are a leading indicator with a famous false-positive rate (“nine of the last five recessions”), so this pillar’s weight is deliberately moderate.' },
    { id: 'spx_ma', pillar: 'market', name: 'S&P 500 versus its 200-day moving average', short: 'S&P 500 vs 200-day', weight: 25, inputs: ['SPX'], unit: '%', fmt: F.spct, lag: 1,
      transform: S => { const px = S.SPX; const ma = rollMean(px, 200); return combine(px, ma, (p, m) => (p / m - 1) * 100, 0); }, anchors: [6, 3, 0, -5, -12],
      rule: '≥ +6% above → 1, +3% → 2, at the average → 3, −5% → 4, ≤ −12% → 5.',
      why: 'The simplest trend filter. Sustained trading below the 200-day average has preceded or accompanied every bear market; it also whipsaws in range-bound years, hence the modest weight.' },
    { id: 'vix', pillar: 'market', name: 'CBOE VIX (S&P 500 implied volatility)', short: 'VIX', weight: 25, inputs: ['VIXCLS'], unit: 'index', fmt: F.num1, lag: 1,
      transform: S => S.VIXCLS, anchors: [14, 18, 22, 28, 36],
      rule: '≤ 14 → 1, 18 → 2, 22 → 3, 28 → 4, ≥ 36 → 5.',
      why: 'The price of equity insurance. Sustained readings above 30 mark genuine stress regimes; single-day spikes (August 2024) usually reverse, which the daily refresh will show.' },
    { id: 'move', pillar: 'market', name: 'ICE BofA MOVE index (Treasury implied volatility)', short: 'MOVE', weight: 15, inputs: ['MOVE'], unit: 'index', fmt: F.num1, lag: 1, optional: true,
      transform: S => S.MOVE, anchors: [70, 95, 115, 135, 165],
      rule: '≤ 70 → 1, 95 → 2, 115 → 3, 135 → 4, ≥ 165 → 5.',
      why: 'Rates volatility is the plumbing of every other market. It ran structurally high in 2022–24 without a recession, so the anchors are set wide. Sourced from Yahoo Finance; optional.' },
  ];

  const REFERENCE = [
    { id: 'recprob', name: 'Smoothed recession probability (Chauvet–Piger)', input: 'RECPROUSM156N', fmt: F.pct1, note: 'A dynamic-factor Markov-switching model on the four NBER coincident series. Readings above 20% have only occurred in recessions. Published with a two-month lag.' },
    { id: 'nyfed', name: 'NY Fed yield-curve recession probability, 12 months ahead', input: 'NYFEDPROB', fmt: F.pct1, note: 'Probit of the 10y–3m spread. Rows are dated by the month being predicted.' },
  ];

  const LEVELS = [
    { n: 1, name: 'Benign', from: 1.0, to: 1.8, desc: 'Expansion intact. Few indicators elevated.' },
    { n: 2, name: 'Guarded', from: 1.8, to: 2.6, desc: 'Late-cycle signs. Worth watching, not acting on.' },
    { n: 3, name: 'Elevated', from: 2.6, to: 3.4, desc: 'Broad slowdown signals. Corrections typical at this level.' },
    { n: 4, name: 'High', from: 3.4, to: 4.2, desc: 'Recession or correction risk high. Multiple pillars stressed.' },
    { n: 5, name: 'Severe', from: 4.2, to: 5.01, desc: 'Recession or major correction under way or imminent.' },
  ];
  const levelOf = s => (s == null ? null : LEVELS.find(L => s >= L.from && s < L.to) || LEVELS[4]);

  const STRESS_EPISODES = [
    { name: 'LTCM / Russia', from: '1998-08-31', to: '1998-10-31' },
    { name: 'US downgrade / euro crisis', from: '2011-08-31', to: '2011-11-30' },
    { name: 'China / oil / industrial recession', from: '2015-08-31', to: '2016-02-29' },
    { name: 'Q4 2018 selloff', from: '2018-10-31', to: '2018-12-31' },
    { name: '2022 rate-shock bear market', from: '2022-01-31', to: '2022-10-31' },
    { name: 'March 2023 bank failures', from: '2023-03-31', to: '2023-05-31' },
    { name: 'August 2024 Sahm trigger', from: '2024-07-31', to: '2024-09-30' },
    { name: 'April 2025 tariff shock', from: '2025-03-31', to: '2025-05-31' },
  ];

  // ---------- model evaluation ----------
  function prepareSeries(data) {
    // normalise raw data: use Stooq/Yahoo S&P if present, else FRED SP500; expose as S.SPX
    const S = {};
    for (const k in data.series) S[k] = { t: data.series[k].t, v: data.series[k].v };
    if (!S.SPX && S.SP500) S.SPX = S.SP500;
    else if (S.SPX && S.SP500) { // splice: extend SPX with FRED SP500 if FRED is fresher
      const a = last(S.SPX), b = last(S.SP500);
      if (b && a && b.t > a.t) { const t = S.SPX.t.slice(), v = S.SPX.v.slice(); for (let i = 0; i < S.SP500.t.length; i++) if (S.SP500.t[i] > a.t) { t.push(S.SP500.t[i]); v.push(S.SP500.v[i]); } S.SPX = mk(t, v); }
    }
    return S;
  }

  function buildModel(data, settings) {
    const S = prepareSeries(data);
    const st = settings || {};
    const ind = [];
    for (const def of INDICATORS) {
      const have = def.inputs.every(k => S[k] && S[k].t.length > 10);
      if (!have) { ind.push({ def, available: false }); continue; }
      let vs; try { vs = def.transform(S); } catch (e) { ind.push({ def, available: false, error: String(e) }); continue; }
      const anchors = (st.anchors && st.anchors[def.id]) || def.anchors;
      let scored;
      if (def.scorer && !(st.anchors && st.anchors[def.id])) scored = def.scorer(vs, S);
      else scored = { score: scoreSeries(vs, anchors) };
      ind.push({ def, available: true, values: vs, score: scored.score, aux: scored.aux || null, curve: scored.state ? scored : null, anchors,
        weight: (st.weights && st.weights[def.id] != null) ? st.weights[def.id] : def.weight,
        enabled: !(st.disabled && st.disabled[def.id]) });
    }
    const pillars = PILLARS.map(p => ({ ...p, weight: (st.pillarWeights && st.pillarWeights[p.id] != null) ? st.pillarWeights[p.id] : p.weight }));
    return { S, ind, pillars, data };
  }

  // reading for one indicator as of `day`; live=true ignores publication lags
  function readIndicator(x, day, live) {
    if (!x.available) return null;
    const lag = live ? 0 : (x.def.lag || 0);
    const r = valueAt(x.values, day - lag, 400);
    if (!r) return null;
    const s = valueAt(x.score, r.t, 0);
    return { value: r.v, score: s ? s.v : null, t: r.t };
  }

  function aggregate(model, day, live) {
    const out = { day, pillars: {}, composite: null, macro: null, market: null, coverage: 0, byInd: {}, counts: [0, 0, 0, 0, 0], n: 0 };
    let totW = 0, availW = 0;
    for (const p of model.pillars) {
      let sw = 0, ss = 0, n = 0;
      for (const x of model.ind) {
        if (x.def.pillar !== p.id) continue;
        totW += p.weight * (x.enabled ? x.weight : 0);
        if (!x.enabled) continue;
        const r = readIndicator(x, day, live);
        out.byInd[x.def.id] = r;
        if (r && r.score != null) { sw += x.weight; ss += x.weight * r.score; n++; availW += p.weight * x.weight; const L = levelOf(r.score); if (L) out.counts[L.n - 1]++; out.n++; }
      }
      out.pillars[p.id] = n ? { score: ss / sw, n, weight: p.weight } : { score: null, n: 0, weight: p.weight };
    }
    const agg = ids => { let w = 0, s = 0; for (const id of ids) { const p = out.pillars[id]; if (p && p.score != null) { w += p.weight; s += p.weight * p.score; } } return w ? s / w : null; };
    out.composite = agg(model.pillars.map(p => p.id));
    out.macro = agg(model.pillars.filter(p => p.lens === 'macro').map(p => p.id));
    out.market = agg(model.pillars.filter(p => p.lens === 'market').map(p => p.id));
    out.coverage = totW ? availW / totW : 0;
    return out;
  }

  function history(model, fromYmd, toDay) {
    const start = ymdToDay(fromYmd); const t = [], comp = [], macro = [], market = [], cov = [], pil = {};
    for (const p of model.pillars) pil[p.id] = [];
    let d = addMonths(start, 0);
    while (d <= toDay) { const a = aggregate(model, d, false); t.push(d); comp.push(a.composite); macro.push(a.macro); market.push(a.market); cov.push(a.coverage); for (const p of model.pillars) pil[p.id].push(a.pillars[p.id].score); d = addMonths(d, 1); }
    return { t, composite: comp, macro, market, coverage: cov, pillars: pil };
  }

  function recessions(S) { // from USREC monthly flags → [{start, end}] in epoch days (month starts)
    const out = []; const u = S.USREC; if (!u) return out; let cur = null;
    for (let i = 0; i < u.t.length; i++) { if (u.v[i] >= 0.5 && !cur) cur = { start: u.t[i], end: null }; if (u.v[i] < 0.5 && cur) { cur.end = u.t[i]; out.push(cur); cur = null; } }
    if (cur) out.push(cur); return out;
  }

  function backtest(model, hist) {
    const S = model.S; const recs = recessions(S).filter(r => r.start >= ymdToDay('1989-01-01'));
    const at = day => { const i = idxAt({ t: hist.t, v: hist.composite }, day); return i < 0 ? null : hist.composite[i]; };
    const maxIn = (a, b) => { let m = null; for (let i = 0; i < hist.t.length; i++) if (hist.t[i] >= a && hist.t[i] <= b && hist.composite[i] != null) m = m == null ? hist.composite[i] : Math.max(m, hist.composite[i]); return m; };
    const rows = recs.map(r => {
      const startEOM = addMonths(r.start, 0); const endEOM = r.end ? addMonths(r.end, -1) : hist.t[hist.t.length - 1];
      // first month within the prior 18 months with composite >= 3.4 (High)
      let lead = null; for (let k = 18; k >= 0; k--) { const d = addMonths(startEOM, -k); const c = at(d); if (c != null && c >= 3.4) { lead = k; break; } }
      return { name: 'Recession ' + dayToYmd(r.start).slice(0, 7) + (r.end ? ' – ' + dayToYmd(addMonths(r.end, -1)).slice(0, 7) : ' – ongoing'), start: r.start, m12: at(addMonths(startEOM, -12)), m6: at(addMonths(startEOM, -6)), m3: at(addMonths(startEOM, -3)), m0: at(startEOM), peak: maxIn(startEOM, endEOM), lead };
    });
    const stress = STRESS_EPISODES.map(e => ({ name: e.name, from: e.from, to: e.to, peak: maxIn(ymdToDay(e.from), ymdToDay(e.to)) }));
    return { recessions: rows, stress };
  }

  function changesSince(model, dayNow, dayThen, live) {
    const a = aggregate(model, dayNow, live), b = aggregate(model, dayThen, false); const moves = [];
    for (const x of model.ind) { const r1 = a.byInd[x.def.id], r0 = b.byInd[x.def.id]; if (r1 && r0 && r1.score != null && r0.score != null) moves.push({ id: x.def.id, name: x.def.short, pillar: x.def.pillar, d: r1.score - r0.score, from: r0.score, to: r1.score, fromLevel: levelOf(r0.score).n, toLevel: levelOf(r1.score).n }); }
    moves.sort((p, q) => Math.abs(q.d) - Math.abs(p.d));
    return { now: a, then: b, moves };
  }

  return { MS_DAY, dayToDate, dateToDay, ymdToDay, dayToYmd, addMonths, monthEndDay, idxAt, valueAt, last, slice, upTo, mapSeries, pctChangeK, diffK, changeDays, rollMean, rollMax, rollMin, combine, percentileOf,
    scoreFromAnchors, scoreSeries, curveScore, F, PILLARS, INDICATORS, REFERENCE, LEVELS, levelOf, STRESS_EPISODES, prepareSeries, buildModel, readIndicator, aggregate, history, recessions, backtest, changesSince };
});
