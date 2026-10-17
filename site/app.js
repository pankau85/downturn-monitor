/* Downturn Monitor — page logic (depends on DM engine) */
(function () {
  'use strict';
  const CONFIG = window.DM_CONFIG || {};   // {liveUrl, repoUrl}
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const el = (tag, attrs, ...kids) => { const n = document.createElement(tag); if (attrs) for (const k in attrs) { if (k === 'class') n.className = attrs[k]; else if (k === 'text') n.textContent = attrs[k]; else if (k === 'html') n.innerHTML = attrs[k]; else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]); else if (attrs[k] != null) n.setAttribute(k, attrs[k]); } for (const c of kids) { if (c == null) continue; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); } return n; };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDay = d => { const x = DM.dayToDate(d); return MONTHS[x.getUTCMonth()] + ' ' + x.getUTCDate() + ', ' + x.getUTCFullYear(); };
  const fmtMonth = d => { const x = DM.dayToDate(d); return MONTHS[x.getUTCMonth()] + ' ' + x.getUTCFullYear(); };
  const fmtScore = s => (s == null ? '–' : s.toFixed(1));
  const ordinal = n => { n = Math.round(n); const m100 = n % 100, m10 = n % 10; return n + ((m100 >= 11 && m100 <= 13) ? 'th' : m10 === 1 ? 'st' : m10 === 2 ? 'nd' : m10 === 3 ? 'rd' : 'th'); };
  const fmtObs = (x, day) => { const sid = x.def.inputs[0]; const fq = state.data && state.data.series[sid] ? state.data.series[sid].freq : 'D'; if (fq === 'M') return fmtMonth(day); if (fq === 'Q') { const dt = DM.dayToDate(day); return 'Q' + (Math.floor(dt.getUTCMonth() / 3) + 1) + ' ' + dt.getUTCFullYear(); } return fmtDay(day); };
  const fmtDelta = (d, digits) => { if (d == null) return '–'; const n = digits == null ? 1 : digits; const r = Math.abs(d).toFixed(n); const zero = parseFloat(r) === 0; return (zero ? '' : d > 0 ? '+' : '−') + r; };
  const lv = s => DM.levelOf(s);
  const lvC = s => DM.levelOfComposite(s);
  const lvClass = s => (s == null ? 'na' : 'l' + lv(s).n);
  const lvClassC = s => (s == null ? 'na' : 'l' + lvC(s).n);
  const chipC = s => { const L = lvC(s); return el('span', { class: 'chip ' + lvClassC(s), text: s == null ? 'n/a' : fmtScore(s) + ' ' + L.name }); };
  const chipNameC = s => { const L = lvC(s); return el('span', { class: 'chip ' + lvClassC(s), text: L ? L.name : 'n/a' }); };
  const chipName = s => { const L = lv(s); return el('span', { class: 'chip ' + lvClass(s), text: L ? L.name : 'n/a' }); };
  const chip = (s, withName) => { const L = lv(s); return el('span', { class: 'chip ' + lvClass(s), text: s == null ? 'n/a' : (fmtScore(s) + (withName === false ? '' : ' ' + L.name)) }); };
  const PILLAR_BY_ID = Object.fromEntries(DM.PILLARS.map(p => [p.id, p]));
  const RANGES = { '1Y': 365, '3Y': 1096, '5Y': 1827, '10Y': 3653, '20Y': 7305, 'Max': null };

  const state = { data: null, model: null, hist: null, bt: null, today: null, asOf: null, range: '5Y', sort: { key: 'score', dir: -1 }, lens: { macro: true, market: true }, source: '', theme: 'system', dl: undefined, settings: null, openId: null, drawerRange: null };

  // ---------------- settings ----------------
  const SKEY = 'dm.settings.v1';
  const emptySettings = () => ({ pillarWeights: {}, weights: {}, disabled: {}, anchors: {} });
  function loadSettings() { try { const raw = localStorage.getItem(SKEY); state.settings = raw ? Object.assign(emptySettings(), JSON.parse(raw)) : emptySettings(); } catch (e) { state.settings = emptySettings(); } }
  function saveSettings() { try { localStorage.setItem(SKEY, JSON.stringify(state.settings)); } catch (e) { /* storage unavailable: settings live for this session only */ } }
  const isCustomised = () => { const s = state.settings; return Object.keys(s.pillarWeights).length + Object.keys(s.weights).length + Object.keys(s.disabled).length + Object.keys(s.anchors).length > 0; };

  // ---------------- theme ----------------
  function applyTheme(t) { state.theme = t; const root = document.documentElement; if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t); try { localStorage.setItem('dm.theme', t); } catch (e) { } const b = $('#btnTheme'); if (b) b.lastChild.textContent = t === 'system' ? 'Theme: auto' : t === 'dark' ? 'Theme: dark' : 'Theme: light'; }

  // ---------------- data loading ----------------
  async function fetchJson(url, timeoutMs) { const c = new AbortController(); const id = setTimeout(() => c.abort(), timeoutMs); try { const r = await fetch(url, { signal: c.signal, cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(id); } }
  async function loadData() {
    const attempts = [];
    if (CONFIG.liveUrl) attempts.push(fetchJson(CONFIG.liveUrl, 20000).then(j => ({ j, src: 'live feed (GitHub)' })).catch(e => ({ e, src: 'live feed' })));
    attempts.push(fetchJson('data.json', 20000).then(j => ({ j, src: 'published snapshot' })).catch(e => ({ e, src: 'snapshot' })));
    if (window.DM_EMBEDDED && window.DM_EMBEDDED.series) attempts.push(Promise.resolve({ j: window.DM_EMBEDDED, src: 'data built into this file' }));
    const res = await Promise.all(attempts);
    const ok = res.filter(r => r.j && r.j.series);
    if (!ok.length) return { error: res.map(r => r.src + ': ' + (r.e && r.e.message || 'failed')).join(' · ') };
    ok.sort((a, b) => (b.j.generated_at || '').localeCompare(a.j.generated_at || ''));
    return ok[0];
  }

  // ---------------- compute ----------------
  function compute() {
    state.today = DM.dateToDay(new Date());
    state.model = DM.buildModel(state.data, state.settings);
    state.hist = DM.history(state.model, '1990-01-31', state.today);
    const live = DM.aggregate(state.model, state.today, true);
    state.live = live;
    // append the live reading as the final point of the history
    const h = state.hist; h.t.push(state.today); h.composite.push(live.composite); h.macro.push(live.macro); h.market.push(live.market); h.coverage.push(live.coverage); for (const p of state.model.pillars) h.pillars[p.id].push(live.pillars[p.id].score);
    state.bt = DM.backtest(state.model, state.hist);
    state.asOfMax = h.t.length - 1;
  }
  const viewDay = () => (state.asOf == null ? state.today : state.asOf);
  const viewAgg = () => (state.asOf == null ? state.live : DM.aggregate(state.model, state.asOf, false));
  function histAt(day, key) { const i = DM.idxAt({ t: state.hist.t }, day); if (i < 0) return null; return key ? state.hist[key][i] : i; }
  function compositeAgo(months) { const d = DM.addMonths(viewDay(), -months); const i = DM.idxAt({ t: state.hist.t }, d); return i < 0 ? null : state.hist.composite[i]; }

  // ---------------- SVG line chart ----------------
  function niceTicks(lo, hi, n) { const span = hi - lo || 1; const raw = span / n; const mag = Math.pow(10, Math.floor(Math.log10(raw))); const norm = raw / mag; const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag; const t0 = Math.floor(lo / step) * step, t1 = Math.ceil(hi / step) * step; const ticks = []; for (let v = t0; v <= t1 + step / 2; v += step) ticks.push(+v.toFixed(10)); return { ticks, lo: t0, hi: t1 }; }
  function sampled(s, x0, x1, pw) { const i0 = Math.max(0, DM.idxAt(s, x0)), i1 = DM.idxAt(s, x1); if (i1 < 0) return []; const n = i1 - i0 + 1; const out = []; if (n <= pw * 2) { for (let i = i0; i <= i1; i++) out.push([s.t[i], s.v[i]]); return out; } const bw = (x1 - x0) / pw; let b = null, mn = null, mx = null; for (let i = i0; i <= i1; i++) { const bi = Math.floor((s.t[i] - x0) / bw); if (bi !== b) { if (mn) { out.push(mn[0] < mx[0] ? mn : mx); if (mn[0] !== mx[0]) out.push(mn[0] < mx[0] ? mx : mn); } b = bi; mn = mx = [s.t[i], s.v[i]]; } else { if (s.v[i] < mn[1]) mn = [s.t[i], s.v[i]]; if (s.v[i] > mx[1]) mx = [s.t[i], s.v[i]]; } } if (mn) { out.push(mn[0] < mx[0] ? mn : mx); if (mn[0] !== mx[0]) out.push(mn[0] < mx[0] ? mx : mn); } return out; }
  function xLabels(x0, x1) { const y0 = DM.dayToDate(x0).getUTCFullYear(), y1 = DM.dayToDate(x1).getUTCFullYear(); const yrs = (x1 - x0) / 365.25; const out = []; if (yrs <= 2.2) { for (let y = y0; y <= y1; y++) for (let m = 0; m < 12; m += (yrs <= 1.1 ? 2 : 3)) { const d = Math.floor(Date.UTC(y, m, 1) / DM.MS_DAY); if (d >= x0 && d <= x1) out.push([d, MONTHS[m] + (m === 0 || out.length === 0 ? ' ' + String(y).slice(2) : '')]); } return out; } const step = yrs <= 7 ? 1 : yrs <= 16 ? 2 : yrs <= 32 ? 5 : 10; for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) { const d = DM.ymdToDay(y + '-01-01'); if (d >= x0 && d <= x1) out.push([d, String(y)]); } return out; }

  function lineChart(host, o) {
    host.innerHTML = '';
    const W = Math.max(280, host.clientWidth || 640), H = o.height || 260; const m = { l: o.ml || 48, r: o.mr || 16, t: 10, b: 24 }; const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const x0 = o.xFrom, x1 = o.xTo; const xs = d => m.l + (d - x0) / (x1 - x0) * pw;
    let lo = o.yMin, hi = o.yMax, ticks;
    if (lo == null || hi == null) { let a = Infinity, b = -Infinity; for (const s of o.series) { if (s.hidden) continue; for (const p of sampled(s, x0, x1, pw)) { if (p[1] < a) a = p[1]; if (p[1] > b) b = p[1]; } } for (const h of (o.hLines || [])) { if (h.y < a) a = h.y; if (h.y > b) b = h.y; } if (!isFinite(a)) { a = 0; b = 1; } if (a === b) { a -= 1; b += 1; } const pad = (b - a) * 0.08; const nt = niceTicks(a - pad, b + pad, 5); lo = lo == null ? nt.lo : lo; hi = hi == null ? nt.hi : hi; ticks = nt.ticks.filter(t => t >= lo && t <= hi); }
    else ticks = o.yTicks || niceTicks(lo, hi, 4).ticks.filter(t => t >= lo && t <= hi);
    const ys = v => m.t + (hi - v) / (hi - lo) * ph; const cl = v => Math.max(lo, Math.min(hi, v));
    const uid = 'c' + Math.random().toString(36).slice(2, 8); const P = [];
    P.push(`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${o.aria || 'chart'}"><defs><clipPath id="${uid}"><rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/></clipPath></defs>`);
    for (const b of (o.bands || [])) { const y1 = ys(cl(b.to)), y2 = ys(cl(b.from)); if (y2 - y1 > 0.5) P.push(`<rect x="${m.l}" y="${y1}" width="${pw}" height="${y2 - y1}" fill="${b.color}" opacity="${b.opacity == null ? 0.11 : b.opacity}"/>`); }
    for (const s of (o.shades || [])) { const a = Math.max(x0, s.from), b = Math.min(x1, s.to); if (b > a) P.push(`<rect x="${xs(a)}" y="${m.t}" width="${Math.max(1, xs(b) - xs(a))}" height="${ph}" fill="var(--rec)"/>`); }
    for (const t of ticks) P.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${ys(t)}" y2="${ys(t)}" stroke="var(--line)" stroke-width="1"/><text x="${m.l - 8}" y="${ys(t) + 3.5}" text-anchor="end" font-size="11" fill="var(--ink-3)" font-variant-numeric="tabular-nums">${(o.yFmt || (v => v))(t)}</text>`);
    if (lo < 0 && hi > 0 && !o.noZero) P.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${ys(0)}" y2="${ys(0)}" stroke="var(--line-2)" stroke-width="1"/>`);
    for (const h of (o.hLines || [])) P.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${ys(h.y)}" y2="${ys(h.y)}" stroke="${h.color || 'var(--ink-3)'}" stroke-width="1"/>${h.label ? `<text x="${m.l + pw - 4}" y="${ys(h.y) - 4}" text-anchor="end" font-size="10.5" fill="var(--ink-3)">${h.label}</text>` : ''}`);
    for (const [d, lab] of xLabels(x0, x1)) P.push(`<text x="${xs(d)}" y="${H - 7}" text-anchor="middle" font-size="11" fill="var(--ink-3)">${lab}</text>`);
    P.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${m.t + ph}" y2="${m.t + ph}" stroke="var(--line-2)" stroke-width="1"/>`);
    P.push(`<g clip-path="url(#${uid})">`);
    const pts = [];
    o.series.forEach((s, si) => { if (s.hidden) { pts.push([]); return; } const sp = sampled(s, x0, x1, pw); pts.push(sp); if (!sp.length) return; let d = ''; sp.forEach((p, i) => { d += (i ? 'L' : 'M') + xs(p[0]).toFixed(1) + ' ' + ys(p[1]).toFixed(1); }); if (s.area) { P.push(`<path d="${d}L${xs(sp[sp.length - 1][0]).toFixed(1)} ${ys(Math.max(lo, Math.min(hi, s.areaBase == null ? lo : s.areaBase))).toFixed(1)}L${xs(sp[0][0]).toFixed(1)} ${ys(Math.max(lo, Math.min(hi, s.areaBase == null ? lo : s.areaBase))).toFixed(1)}Z" fill="${s.color}" opacity="0.10"/>`); } P.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`); if (s.endDot !== false && sp.length) { const e = sp[sp.length - 1]; P.push(`<circle cx="${xs(e[0])}" cy="${ys(e[1])}" r="4" fill="${s.endColor || s.color}" stroke="var(--surface)" stroke-width="2"/>`); } });
    P.push('</g>');
    if (o.cursorDay != null && o.cursorDay >= x0 && o.cursorDay <= x1) P.push(`<line x1="${xs(o.cursorDay)}" x2="${xs(o.cursorDay)}" y1="${m.t}" y2="${m.t + ph}" stroke="var(--accent)" stroke-width="1.5"/><text x="${xs(o.cursorDay) + 4}" y="${m.t + 11}" font-size="10.5" fill="var(--accent)">${o.cursorLabel || 'viewing'}</text>`);
    P.push(`<g class="hover" style="display:none"><line class="hx" x1="0" x2="0" y1="${m.t}" y2="${m.t + ph}" stroke="var(--ink-3)" stroke-width="1"/>${o.series.map((s) => `<circle class="hd" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2" style="display:none"/>`).join('')}</g>`);
    P.push(`<rect class="hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent" style="cursor:${o.onClick ? 'pointer' : 'crosshair'}"/>`);
    P.push('</svg>');
    host.innerHTML = P.join('');
    const svg = host.firstElementChild; const tip = el('div', { class: 'tip' }); host.appendChild(tip); const hover = svg.querySelector('.hover'), hx = svg.querySelector('.hx'), hds = $$('.hd', svg); const hit = svg.querySelector('.hit');
    const toDay = evt => { const r = svg.getBoundingClientRect(); const px = (evt.clientX - r.left) * (W / r.width); return x0 + (px - m.l) / pw * (x1 - x0); };
    const nearest = (s, day) => { if (!s.t.length) return null; let i = DM.idxAt(s, day); if (i < 0) i = 0; if (i + 1 < s.t.length && Math.abs(s.t[i + 1] - day) < Math.abs(s.t[i] - day)) i++; return i; };
    hit.addEventListener('pointermove', evt => {
      const day = toDay(evt); let anchorDay = null; const rows = [];
      o.series.forEach((s, si) => { if (s.hidden || !s.t.length) { hds[si].style.display = 'none'; return; } const i = nearest(s, day); if (anchorDay == null) anchorDay = s.t[i]; const j = DM.idxAt(s, anchorDay + (o.snapTol || 0)); const k = (j >= 0 && Math.abs(s.t[j] - anchorDay) <= Math.abs(s.t[i] - anchorDay)) ? j : i; const t = s.t[k], v = s.v[k]; if (Math.abs(t - anchorDay) > (x1 - x0) / pw * 6 + (o.snapTol || 0) && si > 0) { hds[si].style.display = 'none'; return; } hds[si].setAttribute('cx', xs(t)); hds[si].setAttribute('cy', ys(Math.max(lo, Math.min(hi, v)))); hds[si].style.display = ''; rows.push({ s, v, t }); });
      if (anchorDay == null) return; hover.style.display = ''; hx.setAttribute('x1', xs(anchorDay)); hx.setAttribute('x2', xs(anchorDay));
      tip.innerHTML = ''; tip.appendChild(el('div', { class: 'd', text: (o.tipDate || fmtDay)(anchorDay) }));
      for (const r of rows) { const row = el('div', { class: 'r' }); const left = el('span'); const key = el('i'); key.style.setProperty('--kc', r.s.color); left.appendChild(key); left.appendChild(document.createTextNode(r.s.name)); row.appendChild(left); row.appendChild(el('b', { text: (r.s.fmt || o.yFmt || (v => v))(r.v) })); tip.appendChild(row); }
      if (o.tipExtra) { const ex = o.tipExtra(anchorDay); if (ex) tip.appendChild(el('div', { class: 'd', text: ex })); }
      tip.style.display = 'block'; const r = svg.getBoundingClientRect(); const px = (evt.clientX - r.left); const left = px + 14 + tip.offsetWidth > host.clientWidth ? px - tip.offsetWidth - 10 : px + 14; tip.style.left = left + 'px'; tip.style.top = Math.max(0, (evt.clientY - r.top) - 10) + 'px';
    });
    hit.addEventListener('pointerleave', () => { hover.style.display = 'none'; tip.style.display = 'none'; });
    if (o.onClick) hit.addEventListener('click', evt => o.onClick(Math.round(toDay(evt))));
  }
  const sparkline = (host, t, v, opts) => { opts = opts || {}; const W = opts.w || host.clientWidth || 200, H = opts.h || 44, p = 5; const pts = []; for (let i = 0; i < t.length; i++) if (v[i] != null) pts.push([t[i], v[i]]); if (pts.length < 2) { host.innerHTML = ''; return; } const x0 = pts[0][0], x1 = pts[pts.length - 1][0]; let lo = opts.min != null ? opts.min : Math.min(...pts.map(p => p[1])), hi = opts.max != null ? opts.max : Math.max(...pts.map(p => p[1])); if (lo === hi) { lo -= 1; hi += 1; } const xs = d => p + (d - x0) / (x1 - x0 || 1) * (W - 2 * p), ys = y => p + (hi - y) / (hi - lo) * (H - 2 * p); let d = ''; pts.forEach((q, i) => { d += (i ? 'L' : 'M') + xs(q[0]).toFixed(1) + ' ' + ys(q[1]).toFixed(1); }); const e = pts[pts.length - 1]; host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">${opts.bands ? opts.bands.map(b => `<rect x="0" y="${ys(Math.min(hi, b.to))}" width="${W}" height="${Math.max(0, ys(Math.max(lo, b.from)) - ys(Math.min(hi, b.to)))}" fill="${b.color}" opacity="0.10"/>`).join('') : ''}<path d="${d}" fill="none" stroke="var(--ink-2)" stroke-width="1.5"/><circle cx="${xs(e[0])}" cy="${ys(e[1])}" r="3.5" fill="${opts.endColor || 'var(--ink)'}" stroke="var(--surface)" stroke-width="1.5"/></svg>`; };
  const levelBands = () => DM.LEVELS.map(L => ({ from: L.from, to: Math.min(5, L.to), color: `var(--l${L.n})` }));
  const compositeBands = () => DM.COMPOSITE_LEVELS.map(L => ({ from: L.from, to: Math.min(5, L.to), color: `var(--l${L.n})` }));
  const recessionShades = () => DM.recessions(state.model.S).map(r => ({ from: r.start, to: r.end || state.today }));

  // ---------------- gauge ----------------
  function gaugeSVG(score, ghost) {
    const cx = 170, cy = 178, r = 126, sw = 22; const ang = pos => Math.PI * (1 - Math.max(0, Math.min(5, pos)) / 5); const pt = (a, rr) => [cx + rr * Math.cos(a), cy - rr * Math.sin(a)];
    const seg = (p0, p1, col) => { const gap = 0.02; const a0 = ang(p0) - (p0 > 0 ? gap : 0), a1 = ang(p1) + (p1 < 5 ? gap : 0); const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r); return `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="${col}" stroke-width="${sw}"/>`; };
    let s = ''; DM.COMPOSITE_LEVELS.forEach((L, i) => { s += seg(i, i + 1, `var(--l${L.n})`); });
    // boundary labels: the composite values where one band hands over to the next
    const labels = [1, ...DM.COMPOSITE_LEVELS.slice(1).map(L => L.from), 5];
    labels.forEach((v, k) => { const [x, y] = pt(ang(k), r - sw / 2 - 11); s += `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="var(--ink-3)">${k === 0 || k === 5 ? v : v.toFixed(1)}</text>`; });
    const deg = s0 => (s0 == null ? -90 : -90 + DM.bandPosition(s0) / 5 * 180);
    if (ghost != null) { const [gx, gy] = pt(ang(DM.bandPosition(ghost)), r + sw / 2 + 9); s += `<circle cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" r="4" fill="none" stroke="var(--ink-3)" stroke-width="1.5"><title>a month ago</title></circle>`; }
    const ro = r + sw / 2, tipR = ro + 3, baseR = ro + 15;
    s += `<g class="needle" style="transform-origin:${cx}px ${cy}px;transform:rotate(${deg(score)}deg);transition:transform .6s cubic-bezier(.2,.7,.2,1)"><line x1="${cx}" y1="${cy - r + sw / 2 - 1}" x2="${cx}" y2="${cy - r - sw / 2 + 1}" stroke="var(--surface)" stroke-width="3"/><line x1="${cx}" y1="${cy - r + sw / 2 - 1}" x2="${cx}" y2="${cy - r - sw / 2 + 1}" stroke="var(--ink)" stroke-width="1.5"/><path d="M${cx - 7} ${cy - baseR}L${cx} ${cy - tipR}L${cx + 7} ${cy - baseR}Z" fill="var(--ink)"/></g>`;
    return `<svg viewBox="0 0 340 200" role="img" aria-label="Composite score gauge">${s}</svg>`;
  }

  // ---------------- rendering ----------------
  function renderFreshness() {
    const g = state.data.generated_at ? new Date(state.data.generated_at) : null; const ageH = g ? (Date.now() - g.getTime()) / 36e5 : null;
    const f = $('#freshness'); f.innerHTML = ''; const d = el('span', { class: 'dot' + (ageH == null ? ' bad' : ageH > 96 ? ' bad' : ageH > 36 ? ' warn' : '') });
    const when = g ? g.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'unknown';
    f.appendChild(d); f.appendChild(document.createTextNode(`Data refreshed ${when} · ${state.source}`));
    const bad = Object.entries(state.data.status || {}).filter(([k, v]) => !v.ok); const ban = $('#dataBanner'); ban.innerHTML = ''; ban.hidden = true;
    if (ageH != null && ageH > 96) { ban.hidden = false; ban.className = 'banner warn'; ban.appendChild(el('div', { class: 'grow', text: `This data is ${Math.round(ageH / 24)} days old. The daily refresh may have stalled; the page still works, but readings may be stale.` })); }
  }

  function renderHero() {
    const a = viewAgg(); const s = a.composite; const L = lvC(s);
    $('#gauge').innerHTML = gaugeSVG(s, compositeAgo(1));
    $('#gaugeScore').textContent = fmtScore(s);
    const gl = $('#gaugeLevel'); gl.innerHTML = ''; gl.appendChild(el('span', { class: 'swatch', style: `background:var(--l${L ? L.n : 1})` })); gl.appendChild(document.createTextNode(L ? `${L.n} · ${L.name}` : '–'));
    $('#gaugeDesc').textContent = L ? L.desc : '';
    const d1 = compositeAgo(1), d3 = compositeAgo(3), d12 = compositeAgo(12); const dd = $('#gaugeDeltas'); dd.innerHTML = '';
    for (const [lab, v] of [['1 month', d1], ['3 months', d3], ['12 months', d12]]) { const diff = (s != null && v != null) ? s - v : null; dd.appendChild(el('span', null, `vs ${lab} ago `, el('b', { text: fmtDelta(diff) }))); }
    const lensBox = $('#lenses'); lensBox.innerHTML = '';
    for (const [key, name, desc] of [['macro', 'Economy', 'Rates & policy, labor, growth, consumer'], ['market', 'Markets', 'Credit conditions and market stress']]) { const v = a[key]; const box = el('div', { class: 'lens' }); box.appendChild(el('div', { class: 'lens-head' }, el('span', { class: 't', text: name }), el('span', { class: 's' }, chipC(v)))); const meter = el('div', { class: 'meter', role: 'img', 'aria-label': `${name} score ${fmtScore(v)}` }); const pos = DM.bandPosition(v); for (let k = 1; k <= 5; k++) { const seg = el('i'); const pct = pos == null ? 0 : Math.max(0, Math.min(1, pos - (k - 1))); const b = el('b'); b.style.setProperty('--fill', (pct * 100).toFixed(0) + '%'); seg.appendChild(b); meter.appendChild(seg); } box.appendChild(meter); box.appendChild(el('div', { class: 'meter-scale' }, el('span', { text: '1' }), el('span', { text: desc }), el('span', { text: '5' }))); lensBox.appendChild(box); }
    const diff = $('#diffusion'); diff.innerHTML = ''; const total = a.counts.reduce((x, y) => x + y, 0) || 1; const bar = el('div', { class: 'bar', role: 'img', 'aria-label': 'Indicators by level' }); a.counts.forEach((c, i) => { if (!c) return; const sp = el('span'); sp.style.width = (c / total * 100) + '%'; sp.style.background = `var(--l${i + 1})`; bar.appendChild(sp); }); diff.appendChild(el('div', { class: 'lens-head' }, el('span', { class: 't', text: `${a.n} indicators by level` }), el('span', { class: 's small muted', text: `${Math.round(a.coverage * 100)}% of weight available` }))); diff.appendChild(bar);
    const leg = el('div', { class: 'legend' }); DM.LEVELS.forEach((Lx, i) => { const k = el('span'); const sw = el('i'); sw.style.background = `var(--l${Lx.n})`; k.appendChild(sw); k.appendChild(document.createTextNode(`${Lx.name} ${a.counts[i]}`)); leg.appendChild(k); }); diff.appendChild(leg);
    // summary sentence
    const sm = $('#summary'); sm.innerHTML = '';
    const ch = DM.changesSince(state.model, viewDay(), DM.addMonths(viewDay(), -1), state.asOf == null);
    const high = state.model.ind.filter(x => a.byInd[x.def.id] && a.byInd[x.def.id].score >= 3.4).sort((p, q) => a.byInd[q.def.id].score - a.byInd[p.def.id].score);
    const dir = (s != null && d1 != null) ? (s - d1 > 0.05 ? 'up' : s - d1 < -0.05 ? 'down' : 'unchanged') : null;
    const p1 = el('p'); p1.appendChild(el('b', { text: L ? `${L.name} (${fmtScore(s)}).` : 'No reading.' })); if (dir) p1.appendChild(document.createTextNode(dir === 'unchanged' ? ' Unchanged from a month ago.' : ` ${dir === 'up' ? 'Up' : 'Down'} ${Math.abs(s - d1).toFixed(1)} from a month ago.`)); p1.appendChild(document.createTextNode(` Economy ${fmtScore(a.macro)}, markets ${fmtScore(a.market)}.`)); sm.appendChild(p1);
    const p2 = el('p'); if (high.length) { p2.appendChild(document.createTextNode(`${high.length} of ${a.n} indicators read High or Severe: `)); high.slice(0, 6).forEach((x, i) => { if (i) p2.appendChild(document.createTextNode(', ')); p2.appendChild(el('span', { class: 'ind', text: x.def.short, onclick: () => openIndicator(x.def.id) })); }); if (high.length > 6) p2.appendChild(document.createTextNode(` and ${high.length - 6} more`)); p2.appendChild(document.createTextNode('.')); } else p2.appendChild(document.createTextNode(`None of the ${a.n} indicators read High or Severe.`)); sm.appendChild(p2);
    const movers = ch.moves.filter(mv => Math.abs(mv.d) >= 0.3).slice(0, 4); if (movers.length) { const p3 = el('p'); p3.appendChild(document.createTextNode('Biggest moves over the month: ')); movers.forEach((mv, i) => { if (i) p3.appendChild(document.createTextNode(', ')); p3.appendChild(el('span', { class: 'ind', text: mv.name, onclick: () => openIndicator(mv.id) })); p3.appendChild(document.createTextNode(` ${fmtDelta(mv.d)}`)); }); p3.appendChild(document.createTextNode('.')); sm.appendChild(p3); }
  }

  function renderAsOf() {
    const sl = $('#asofSlider'); sl.max = state.asOfMax; const idx = state.asOf == null ? state.asOfMax : histAt(state.asOf); sl.value = idx == null ? state.asOfMax : idx;
    $('#asofWhen').textContent = state.asOf == null ? 'Today' : fmtMonth(state.asOf);
    document.body.classList.toggle('timetravel', state.asOf != null);
    const b = $('#asofBanner'); b.hidden = state.asOf == null; if (state.asOf != null) { b.innerHTML = ''; b.className = 'banner info'; b.appendChild(el('div', { class: 'grow' }, el('b', { text: `Viewing as of ${fmtMonth(state.asOf)}. ` }), 'Values are those that would have been published by then (release lags applied); indicator data is as currently revised, which flatters the historical read slightly. ')); b.appendChild(el('button', { class: 'btn sm', text: 'Back to today', onclick: () => { state.asOf = null; renderAll(); } })); }
    $('#btnToday').hidden = state.asOf == null;
  }

  function renderHistory() {
    const h = state.hist; const days = RANGES[state.range]; let xTo = state.today; let xFrom = days ? xTo - days : h.t[0];
    if (state.asOf != null && days && state.asOf < xFrom + days * 0.1) { xFrom = state.asOf - Math.round(days * 0.65); xTo = Math.min(state.today, state.asOf + Math.round(days * 0.35)); }
    const host = $('#histChart');
    lineChart(host, { xFrom, xTo, yMin: 1, yMax: 5, yTicks: [1, 2, 3, 4, 5], height: host.clientWidth < 600 ? 220 : 280, aria: 'Composite score history', bands: compositeBands(), shades: recessionShades(), cursorDay: state.asOf, cursorLabel: 'viewing', tipDate: d => (d === state.today ? 'Today (' + fmtDay(d) + ')' : fmtMonth(d)),
      series: [
        { name: 'Composite', t: h.t, v: h.composite, color: 'var(--ink)', width: 2.25, fmt: fmtScore },
        { name: 'Economy', t: h.t, v: h.macro, color: 'var(--accent)', width: 1.5, fmt: fmtScore, hidden: !state.lens.macro },
        { name: 'Markets', t: h.t, v: h.market, color: 'var(--lens2)', width: 1.5, fmt: fmtScore, hidden: !state.lens.market },
      ],
      tipExtra: d => { const i = DM.idxAt({ t: h.t }, d); const c = i < 0 ? null : h.coverage[i]; const L = i < 0 ? null : lvC(h.composite[i]); return (L ? L.name + ' · ' : '') + (c != null ? Math.round(c * 100) + '% of indicator weight available' : ''); },
      onClick: day => { let i = DM.idxAt({ t: h.t }, day); if (i < 0) i = 0; if (i + 1 < h.t.length && Math.abs(h.t[i + 1] - day) < Math.abs(h.t[i] - day)) i++; state.asOf = (i >= state.asOfMax) ? null : h.t[i]; renderAll(); } });
    const lg = $('#histLegend'); lg.innerHTML = '';
    const mk = (name, color, key) => { const b = el('button', { class: 'key', 'aria-pressed': key ? String(state.lens[key]) : 'true', onclick: key ? () => { state.lens[key] = !state.lens[key]; renderHistory(); } : null }); const i = el('i'); i.style.setProperty('--kc', color); b.appendChild(i); b.appendChild(document.createTextNode(name)); return b; };
    lg.appendChild(mk('Composite', 'var(--ink)')); lg.appendChild(mk('Economy lens', 'var(--accent)', 'macro')); lg.appendChild(mk('Markets lens', 'var(--lens2)', 'market'));
    const rk = el('span', { class: 'key' }); const ri = el('i', { class: 'box' }); ri.style.setProperty('--kc', 'var(--ink-3)'); rk.appendChild(ri); rk.appendChild(document.createTextNode('NBER recession')); lg.appendChild(rk);
    lg.appendChild(el('span', { class: 'muted', text: 'Click the chart to view the board as of that month.' }));
  }

  function renderPillars() {
    const a = viewAgg(); const host = $('#pillars'); host.innerHTML = ''; const h = state.hist; const day = viewDay();
    const i1 = histAt(DM.addMonths(day, -1)); const prev = i1 == null ? null : DM.aggregate(state.model, h.t[Math.min(i1, state.asOfMax - 1)], false);
    for (const p of state.model.pillars) {
      const ps = a.pillars[p.id]; const card = el('div', { class: 'card pillar' });
      const head = el('div', { class: 'pillar-head' }, el('div', null, el('div', { class: 'name', text: p.name }), el('div', { class: 'w', text: `${p.weight}% of composite · ${ps.n} indicators` })), el('div', { class: 'pillar-score' }, el('div', { class: 'v ' + lvClassC(ps.score), text: fmtScore(ps.score) }), chipNameC(ps.score)));
      card.appendChild(head); host.appendChild(card);
      const sp = el('div', { class: 'pillar-spark' }); card.appendChild(sp);
      const idxEnd = state.asOf == null ? h.t.length - 1 : histAt(state.asOf); const i0 = Math.max(0, idxEnd - 60); sparkline(sp, h.t.slice(i0, idxEnd + 1), h.pillars[p.id].slice(i0, idxEnd + 1), { min: 1, max: 5, bands: compositeBands(), endColor: `var(--l${lvC(ps.score) ? lvC(ps.score).n : 1})` });
      const ul = el('ul', { class: 'pillar-list' });
      for (const x of state.model.ind.filter(x => x.def.pillar === p.id)) {
        const r = a.byInd[x.def.id]; const li = el('li', { class: x.enabled && x.available ? '' : 'off', tabindex: '0', role: 'button', onclick: () => openIndicator(x.def.id), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openIndicator(x.def.id); } } });
        li.appendChild(el('span', { class: 'n', text: x.def.short }));
        const val = el('span', { class: 'v' }); if (r) { val.textContent = x.def.fmt(r.value); const pr = prev && prev.byInd[x.def.id]; if (pr && pr.score != null && r.score != null) { const d = r.score - pr.score; if (Math.abs(d) >= 0.15) val.appendChild(el('span', { class: 'arrow ' + (d > 0 ? 'up' : 'down'), text: d > 0 ? '▲' : '▼', title: `score ${fmtDelta(d)} vs a month ago` })); } } else val.textContent = x.available ? 'no data' : 'not available';
        li.appendChild(val); li.appendChild(chip(r ? r.score : null, false)); ul.appendChild(li);
      }
      card.appendChild(ul);
    }
  }

  function renderTable() {
    const a = viewAgg(); const day = viewDay(); const tb = $('#tblBody'); tb.innerHTML = '';
    const i1 = histAt(DM.addMonths(day, -1)); const prev = i1 == null ? null : DM.aggregate(state.model, state.hist.t[Math.min(i1, state.asOfMax - 1)], false);
    const rows = state.model.ind.map(x => { const r = a.byInd[x.def.id]; const pr = prev && prev.byInd[x.def.id]; return { x, r, pr, score: r ? r.score : null, pct: (r && x.available) ? DM.percentileOf(x.values, r.t, 3653) : null }; });
    const k = state.sort.key, dir = state.sort.dir; rows.sort((p, q) => { let u, v; if (k === 'name') { u = p.x.def.short; v = q.x.def.short; return dir * u.localeCompare(v); } if (k === 'pillar') { u = p.x.def.pillar; v = q.x.def.pillar; return dir * (u === v ? (q.score || 0) - (p.score || 0) : u.localeCompare(v)); } if (k === 'score') { u = p.score == null ? -1 : p.score; v = q.score == null ? -1 : q.score; } else if (k === 'delta') { u = (p.r && p.pr) ? p.r.score - p.pr.score : -9; v = (q.r && q.pr) ? q.r.score - q.pr.score : -9; } else if (k === 'pct') { u = p.pct == null ? -1 : p.pct; v = q.pct == null ? -1 : q.pct; } else if (k === 'weight') { u = p.x.weight * (PILLAR_BY_ID[p.x.def.pillar].weight); v = q.x.weight * (PILLAR_BY_ID[q.x.def.pillar].weight); } return dir * (u - v); });
    for (const row of rows) { const { x, r, pr } = row; const tr = el('tr', { class: 'row' + (x.enabled && x.available ? '' : ' off'), tabindex: '0', onclick: () => openIndicator(x.def.id), onkeydown: e => { if (e.key === 'Enter') openIndicator(x.def.id); } });
      tr.appendChild(el('td', { class: 'name' }, el('div', { text: x.def.short }), el('div', { class: 'ep', text: x.def.name })));
      tr.appendChild(el('td', { text: PILLAR_BY_ID[x.def.pillar].name }));
      tr.appendChild(el('td', { class: 'r', text: r ? x.def.fmt(r.value) : (x.available ? 'no data' : 'unavailable') }));
      tr.appendChild(el('td', { class: 'ep', text: r ? fmtObs(x, r.t) : '' }));
      const d = (r && pr && r.score != null && pr.score != null) ? r.score - pr.score : null; tr.appendChild(el('td', { class: 'r', text: d == null ? '' : fmtDelta(d) }));
      tr.appendChild(el('td', { class: 'r', text: r && r.score != null ? r.score.toFixed(2) : '' }));
      tr.appendChild(el('td', null, chip(r ? r.score : null)));
      const pc = el('td'); if (row.pct != null) { const w = el('span', { class: 'pct' }); const bar = el('i'); const b = el('b'); b.style.width = row.pct.toFixed(0) + '%'; bar.appendChild(b); w.appendChild(bar); w.appendChild(el('span', { class: 'ep', text: ordinal(row.pct) })); pc.appendChild(w); } tr.appendChild(pc);
      const pweight = state.model.pillars.find(p => p.id === x.def.pillar).weight; const sumP = state.model.pillars.reduce((s, p) => s + p.weight, 0) || 1; const totalW = state.model.ind.filter(y => y.def.pillar === x.def.pillar && y.enabled && y.available).reduce((s, y) => s + y.weight, 0) || 1; const eff = x.enabled && x.available ? 100 * (pweight / sumP) * (x.weight / totalW) : 0; tr.appendChild(el('td', { class: 'r', text: eff.toFixed(1) + '%' }));
      tb.appendChild(tr); }
    $$('#tbl th[data-key]').forEach(th => th.setAttribute('aria-sort', th.dataset.key === k ? (dir > 0 ? 'ascending' : 'descending') : 'none'));
  }

  function renderBacktest() {
    const bt = state.bt; const t1 = $('#btRecessions'); t1.innerHTML = '';
    for (const r of bt.recessions) { const tr = el('tr'); tr.appendChild(el('td', { text: r.name })); for (const v of [r.m12, r.m6, r.m3, r.m0, r.peak]) tr.appendChild(el('td', { class: 'r' }, v == null ? el('span', { class: 'muted', text: '–' }) : chipC(v))); tr.appendChild(el('td', { text: r.lead == null ? 'none in the prior 18 months' : r.lead === 0 ? 'in the start month' : r.lead === 1 ? '1 month before' : `${r.lead} months before` })); t1.appendChild(tr); }
    const t2 = $('#btStress'); t2.innerHTML = '';
    for (const e of bt.stress) { const tr = el('tr'); tr.appendChild(el('td', { text: e.name })); tr.appendChild(el('td', { class: 'ep', text: fmtMonth(DM.ymdToDay(e.from)) + ' – ' + fmtMonth(DM.ymdToDay(e.to)) })); tr.appendChild(el('td', { class: 'r' }, e.peak == null ? el('span', { class: 'muted', text: '–' }) : chipC(e.peak))); t2.appendChild(tr); }
  }

  function renderReference() {
    const host = $('#refGrid'); host.innerHTML = ''; const S = state.model.S;
    for (const ref of DM.REFERENCE) { const s = S[ref.input]; const box = el('div', { class: 'ref' }); box.appendChild(el('div', { class: 't', text: ref.name })); if (!s) { box.appendChild(el('div', { class: 'note', text: 'Not available in the current data file. ' + ref.note })); host.appendChild(box); continue; } const horizon = ref.forward ? viewDay() + 370 : viewDay(); const r = DM.valueAt(s, horizon); const sp = el('div'); const i1 = DM.idxAt(s, horizon); const i0 = Math.max(0, i1 - 60); box.appendChild(el('div', null, el('div', { class: 'v', text: r ? ref.fmt(r.v) : '–' }), el('div', { class: 'ep', text: r ? (ref.forward ? 'for ' + fmtMonth(r.t) : fmtMonth(r.t)) : '' }))); box.appendChild(sp); sparkline(sp, s.t.slice(i0, i1 + 1), s.v.slice(i0, i1 + 1), { w: 140, h: 36, min: 0 }); box.appendChild(el('div', { class: 'note', text: ref.note })); host.appendChild(box); }
  }

  function renderMethod() {
    const w = $('#weightsTbl'); w.innerHTML = '';
    for (const p of state.model.pillars) { const tr = el('tr'); tr.appendChild(el('td', { text: p.name })); tr.appendChild(el('td', { class: 'r', text: p.weight + '%' })); tr.appendChild(el('td', { text: p.lens === 'macro' ? 'Economy' : 'Markets' })); tr.appendChild(el('td', { class: 'ep', text: state.model.ind.filter(x => x.def.pillar === p.id).map(x => `${x.def.short} ${x.weight}`).join(' · ') })); w.appendChild(tr); }
    const ds = $('#dataStatus'); ds.innerHTML = ''; const gen = state.data.generated_at ? DM.dateToDay(new Date(state.data.generated_at)) : state.today;
    const expect = { D: 6, W: 12, M: 50, Q: 130 };
    for (const [id, s] of Object.entries(state.data.series)) { const st = (state.data.status || {})[id] || {}; const endDay = DM.ymdToDay(s.end); const age = gen - endDay; const lateBy = age - (expect[s.freq] || 60); const tr = el('tr'); const url = s.src === 'FRED' ? `https://fred.stlouisfed.org/series/${id}` : (state.data.sources || {})[s.src] || '#'; tr.appendChild(el('td', null, el('a', { href: url, target: '_blank', rel: 'noopener', text: id }))); tr.appendChild(el('td', { class: 'name', text: s.title })); tr.appendChild(el('td', { text: ({ D: 'Daily', W: 'Weekly', M: 'Monthly', Q: 'Quarterly' })[s.freq] || s.freq })); tr.appendChild(el('td', { text: s.src })); tr.appendChild(el('td', { class: 'r', text: s.end })); const flag = el('td'); if (st.ok === false) flag.appendChild(el('span', { class: 'chip l4', text: st.kept_previous ? 'fetch failed, kept previous' : 'failed' })); else if (lateBy > 0) flag.appendChild(el('span', { class: 'chip l3', text: 'later than usual' })); else flag.appendChild(el('span', { class: 'chip l1', text: 'current' })); if (st.error) flag.title = st.error; tr.appendChild(flag); ds.appendChild(tr); }
    $('#genStamp').textContent = state.data.generated_at ? new Date(state.data.generated_at).toUTCString() : 'unknown';
  }

  function renderAll() { document.body.classList.add('loading-dim'); requestAnimationFrame(() => { renderAsOf(); renderHero(); renderHistory(); renderPillars(); renderTable(); renderBacktest(); renderReference(); renderMethod(); $('#customNote').hidden = !isCustomised(); document.body.classList.remove('loading-dim'); }); }

  // ---------------- drawer ----------------
  function valueAtScore(A, s) { const inc = A[4] > A[0]; const k = Math.min(3, Math.max(0, Math.floor(s - 1))); const f = s - 1 - k; return A[k] + (A[k + 1] - A[k]) * f; }
  function anchorBands(A) { const b = [1.5, 2.5, 3.5, 4.5].map(s => valueAtScore(A, s)); const inc = A[4] > A[0]; const INF = 1e12; const out = []; for (let k = 0; k < 5; k++) { let lo, hi; if (inc) { lo = k === 0 ? -INF : b[k - 1]; hi = k === 4 ? INF : b[k]; } else { hi = k === 0 ? INF : b[k - 1]; lo = k === 4 ? -INF : b[k]; } out.push({ from: lo, to: hi, color: `var(--l${k + 1})`, opacity: 0.12 }); } return out; }
  function openIndicator(id) {
    const x = state.model.ind.find(i => i.def.id === id); if (!x) return; const keepScroll = state.openId === id ? $('#drawer').scrollTop : 0; state.openId = id; const d = x.def; const a = viewAgg(); const r = a.byInd[id];
    const dr = $('#drawer'); const body = $('#drawerBody'); body.innerHTML = '';
    $('#drawerCrumb').textContent = PILLAR_BY_ID[d.pillar].name; $('#drawerTitle').textContent = d.name;
    if (!x.available) { body.appendChild(el('p', { class: 'muted', text: 'This indicator is not in the current data file (its source may be unavailable). ' + (d.optional ? 'It is optional and excluded from the composite until data arrives.' : '') })); body.appendChild(el('div', { class: 'rule-box' }, el('b', { text: 'Why it matters' }), d.why)); dr.classList.add('open'); $('#scrim').classList.add('open'); return; }
    const k = el('div', { class: 'kpis' });
    k.appendChild(el('div', { class: 'kpi' }, el('div', { class: 'l', text: 'Latest value' }), el('div', { class: 'v', text: r ? d.fmt(r.value) : '–' }), el('div', { class: 'ep', text: r ? fmtObs(x, r.t) : '' })));
    k.appendChild(el('div', { class: 'kpi' }, el('div', { class: 'l', text: 'Score' }), el('div', { class: 'v' }, chip(r ? r.score : null)), el('div', { class: 'ep', text: x.curve && r ? ((x.curve.state[DM.idxAt(x.score, r.t)] || '') + (x.curve.lastInvEnd && x.curve.state[DM.idxAt(x.score, r.t)] !== 'normal' && x.curve.state[DM.idxAt(x.score, r.t)] !== 'inverted' ? ' · inversion ended ' + fmtDay(x.curve.lastInvEnd) : '')) : '' })));
    const pct = r ? DM.percentileOf(x.values, r.t, 3653) : null; k.appendChild(el('div', { class: 'kpi' }, el('div', { class: 'l', text: '10-year percentile' }), el('div', { class: 'v', text: pct == null ? '–' : ordinal(pct) }), el('div', { class: 'ep', text: 'of readings in the trailing 10 years' })));
    const prevR = (() => { const i1 = histAt(DM.addMonths(viewDay(), -1)); if (i1 == null) return null; return DM.readIndicator(x, state.hist.t[Math.min(i1, state.asOfMax - 1)], false); })(); k.appendChild(el('div', { class: 'kpi' }, el('div', { class: 'l', text: 'A month ago' }), el('div', { class: 'v sm', text: prevR ? d.fmt(prevR.value) : '–' }), el('div', { class: 'ep', text: prevR && r && prevR.score != null && r.score != null ? 'score ' + fmtDelta(r.score - prevR.score) : '' })));
    if (x.aux) { const av = r ? DM.valueAt(x.aux.series, r.t, 10) : null; k.appendChild(el('div', { class: 'kpi' }, el('div', { class: 'l', text: x.aux.name }), el('div', { class: 'v sm', text: av ? x.aux.fmt(av.v) : '–' }))); }
    body.appendChild(k);
    // range row for the detail charts
    const rr = el('div', { class: 'ctl-group' }, el('span', { class: 'ctl-label', text: 'Range' })); const seg = el('div', { class: 'seg' }); const cur = state.drawerRange || state.range; for (const key of Object.keys(RANGES)) seg.appendChild(el('button', { text: key, 'aria-pressed': String(key === cur), onclick: () => { state.drawerRange = key; openIndicator(id); } })); rr.appendChild(seg); body.appendChild(rr);
    const chartHost = el('div', { class: 'chart-wrap' }); body.appendChild(chartHost); const days = RANGES[cur]; const xTo = state.today, xFrom = days ? xTo - days : Math.max(x.values.t[0], DM.ymdToDay('1985-01-01'));
    const ser = [{ name: d.short, t: x.values.t, v: x.values.v, color: 'var(--ink)', width: 2, fmt: d.fmt }];
    body.appendChild(el('div', { class: 'legend-row', style: 'padding:0' }, el('span', { class: 'muted small', text: 'Shaded bands show the score levels implied by the thresholds; grey columns are NBER recessions.' })));
    body.appendChild(el('h3', { text: 'Score history' })); const scoreHost = el('div', { class: 'chart-wrap' }); body.appendChild(scoreHost);
    requestAnimationFrame(() => { lineChart(chartHost, { xFrom, xTo, height: 240, aria: d.name, bands: anchorBands(x.anchors), shades: recessionShades(), cursorDay: state.asOf, cursorLabel: 'viewing', yFmt: v => d.fmt(v).replace(' y/y', '').replace(/^\+/, ''), series: ser }); lineChart(scoreHost, { xFrom, xTo, yMin: 1, yMax: 5, yTicks: [1, 2, 3, 4, 5], height: 120, aria: d.name + ' score history', bands: levelBands(), shades: recessionShades(), cursorDay: state.asOf, series: [{ name: 'Score', t: x.score.t, v: x.score.v, color: 'var(--accent)', width: 1.75, fmt: fmtScore }] }); });
    body.appendChild(el('div', { class: 'rule-box' }, el('b', { text: 'Rule' }), d.rule)); body.appendChild(el('div', { class: 'rule-box' }, el('b', { text: 'Why it matters' }), d.why));
    // thresholds editor
    const te = el('div'); te.appendChild(el('h3', { text: 'Thresholds (value at each score)' })); const an = el('div', { class: 'anchors' }); const inputs = [];
    x.anchors.forEach((v, i) => { const inp = el('input', { type: 'number', step: 'any', value: String(+v.toFixed(4)), id: `anc-${id}-${i}`, 'aria-label': `value at score ${i + 1}` }); inputs.push(inp); const lab = el('label', { class: 'l' + (i + 1) }, el('span', { text: `Score ${i + 1}` }), inp); an.appendChild(lab); });
    te.appendChild(an); const custom = !!(state.settings.anchors && state.settings.anchors[id]);
    te.appendChild(el('p', { class: 'small muted', style: 'margin-top:6px', text: (d.scorer ? 'Editing thresholds switches this indicator to the plain level rule (the built-in momentum or cycle logic is paused until you reset). ' : '') + (custom ? 'Custom thresholds are in use.' : 'Default thresholds.') }));
    const btns = el('div', { class: 'row-btns', style: 'margin-top:8px' }); btns.appendChild(el('button', { class: 'btn sm primary', text: 'Apply thresholds', onclick: () => { const vals = inputs.map(i => parseFloat(i.value)); if (vals.some(v => !Number.isFinite(v))) { toast('Enter a number for every score'); return; } const inc = vals[4] > vals[0]; for (let i = 1; i < 5; i++) if (inc ? vals[i] < vals[i - 1] : vals[i] > vals[i - 1]) { toast('Thresholds must run in one direction'); return; } state.settings.anchors[id] = vals; saveSettings(); compute(); renderAll(); openIndicator(id); toast('Thresholds applied'); } })); if (custom) btns.appendChild(el('button', { class: 'btn sm', text: 'Reset to default', onclick: () => { delete state.settings.anchors[id]; saveSettings(); compute(); renderAll(); openIndicator(id); } })); te.appendChild(btns); body.appendChild(te);
    // weight + include
    const wrow = el('div', { class: 'row-btns' }); const lab = el('label', { class: 'switch' }); const cb = el('input', { type: 'checkbox', id: `inc-${id}` }); cb.checked = x.enabled; cb.addEventListener('change', () => { if (cb.checked) delete state.settings.disabled[id]; else state.settings.disabled[id] = true; saveSettings(); compute(); renderAll(); openIndicator(id); }); lab.appendChild(cb); lab.appendChild(document.createTextNode('Include in composite')); wrow.appendChild(lab);
    const wl = el('label', { class: 'switch' }, 'Weight within pillar '); const wi = el('input', { type: 'number', class: 'winput', min: '0', max: '100', step: '5', value: String(x.weight), id: `w-${id}` }); wi.addEventListener('change', () => { const v = parseFloat(wi.value); if (!Number.isFinite(v) || v < 0) return; if (v === d.weight) delete state.settings.weights[id]; else state.settings.weights[id] = v; saveSettings(); compute(); renderAll(); openIndicator(id); }); wl.appendChild(wi); wrow.appendChild(wl); body.appendChild(wrow);
    const src = state.data.series[d.inputs[0]]; body.appendChild(el('p', { class: 'small muted' }, 'Source series: ', ...d.inputs.flatMap((sid, i) => [i ? ', ' : '', el('a', { href: (state.data.series[sid] && state.data.series[sid].src === 'FRED') ? `https://fred.stlouisfed.org/series/${sid}` : '#', target: '_blank', rel: 'noopener', text: sid })]), src ? ` · last observation ${src.end}` : '', ` · publication lag assumed ${d.lag} days for the historical view.`));
    dr.classList.add('open'); $('#scrim').classList.add('open'); dr.scrollTop = keepScroll; if (!keepScroll) $('#drawerClose').focus();
  }
  function closeOverlays() { $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open'); $('#settings').classList.remove('open'); state.openId = null; }

  // ---------------- settings modal ----------------
  const PRESETS = { Default: null, 'Equal weights': { rates: 1, credit: 1, labor: 1, growth: 1, consumer: 1, market: 1 }, 'Economy focus': { rates: 20, credit: 15, labor: 25, growth: 25, consumer: 15, market: 0 }, 'Markets focus': { rates: 15, credit: 30, labor: 10, growth: 10, consumer: 5, market: 30 } };
  function openSettings() {
    const box = $('#settingsBody'); box.innerHTML = '';
    box.appendChild(el('p', { class: 'small muted', text: 'Pillar weights set how much each group of indicators counts in the composite. They are normalised to 100%. Settings are saved in this browser only.' }));
    const pr = el('div', { class: 'presets' }); for (const name of Object.keys(PRESETS)) pr.appendChild(el('button', { class: 'btn sm', text: name, onclick: () => { const p = PRESETS[name]; state.settings.pillarWeights = p ? Object.fromEntries(DM.PILLARS.map(x => [x.id, p[x.id] * (name === 'Equal weights' ? 100 / 6 : 1)])) : {}; saveSettings(); compute(); renderAll(); openSettings(); } })); box.appendChild(pr);
    const total = state.model.pillars.reduce((s, p) => s + p.weight, 0) || 1;
    for (const p of state.model.pillars) { const row = el('div', { class: 'wrow' }); row.appendChild(el('span', { text: p.name })); const sl = el('input', { type: 'range', min: '0', max: '40', step: '1', value: String(Math.round(p.weight)), id: `pw-${p.id}` }); const out = el('span', { class: 'pw', text: Math.round(p.weight / total * 100) + '%' }); sl.addEventListener('input', () => { out.textContent = sl.value + ' →'; }); sl.addEventListener('change', () => { state.settings.pillarWeights = Object.fromEntries(state.model.pillars.map(q => [q.id, q.id === p.id ? parseFloat(sl.value) : q.weight])); saveSettings(); compute(); renderAll(); openSettings(); }); row.appendChild(sl); row.appendChild(out); box.appendChild(row); }
    box.appendChild(el('h3', { text: 'Indicators in the composite' })); const tg = el('div', { class: 'ind-toggles' });
    for (const x of state.model.ind) { const lab = el('label', { class: 'switch' }); const cb = el('input', { type: 'checkbox', id: `tg-${x.def.id}` }); cb.checked = x.enabled; cb.disabled = !x.available; cb.addEventListener('change', () => { if (cb.checked) delete state.settings.disabled[x.def.id]; else state.settings.disabled[x.def.id] = true; saveSettings(); compute(); renderAll(); }); lab.appendChild(cb); lab.appendChild(document.createTextNode(x.def.short + (x.available ? '' : ' (no data)'))); tg.appendChild(lab); }
    box.appendChild(tg);
    box.appendChild(el('h3', { text: 'Save or share your settings' })); const ta = el('textarea', { class: 'json', id: 'settingsJson' }); ta.value = JSON.stringify(state.settings); box.appendChild(ta);
    const rb = el('div', { class: 'row-btns' }); rb.appendChild(el('button', { class: 'btn sm', text: 'Copy settings', onclick: () => copyText(ta.value, 'Settings copied') })); rb.appendChild(el('button', { class: 'btn sm', text: 'Apply pasted settings', onclick: () => { try { const s = JSON.parse(ta.value); state.settings = Object.assign(emptySettings(), s); saveSettings(); compute(); renderAll(); openSettings(); toast('Settings applied'); } catch (e) { toast('That is not valid settings JSON'); } } })); rb.appendChild(el('button', { class: 'btn sm', text: 'Reset everything to defaults', onclick: () => { state.settings = emptySettings(); saveSettings(); compute(); renderAll(); openSettings(); toast('Defaults restored'); } })); box.appendChild(rb);
    $('#settings').classList.add('open'); $('#scrim').classList.add('open');
  }

  // ---------------- export ----------------
  function scoresCSV() { const a = viewAgg(); const rows = [['indicator', 'pillar', 'as_of_date', 'value', 'unit', 'score', 'level', 'weight_in_pillar', 'pillar_weight', 'included']]; for (const x of state.model.ind) { const r = a.byInd[x.def.id]; rows.push([x.def.short, PILLAR_BY_ID[x.def.pillar].name, r ? DM.dayToYmd(r.t) : '', r ? r.value : '', x.def.unit, r && r.score != null ? r.score.toFixed(3) : '', r && r.score != null ? lv(r.score).name : '', x.weight, state.model.pillars.find(p => p.id === x.def.pillar).weight, x.enabled && x.available ? 'yes' : 'no']); } rows.push([]); rows.push(['composite', '', DM.dayToYmd(viewDay()), '', '', a.composite == null ? '' : a.composite.toFixed(3), a.composite == null ? '' : lvC(a.composite).name]); rows.push(['economy lens', '', '', '', '', a.macro == null ? '' : a.macro.toFixed(3)]); rows.push(['markets lens', '', '', '', '', a.market == null ? '' : a.market.toFixed(3)]); rows.push([]); rows.push(['composite history (month-end, release lags applied)']); rows.push(['date', 'composite', 'economy', 'markets', 'coverage']); state.hist.t.forEach((t, i) => rows.push([DM.dayToYmd(t), fmtN(state.hist.composite[i]), fmtN(state.hist.macro[i]), fmtN(state.hist.market[i]), fmtN(state.hist.coverage[i])])); return rows.map(r => r.map(c => { const s = c == null ? '' : String(c); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n'); }
  const fmtN = v => (v == null ? '' : (+v).toFixed(3));
  async function exportScores() { const csv = scoresCSV(); if (state.dl) { try { await state.dl.save({ filename: 'downturn-monitor-scores-' + DM.dayToYmd(viewDay()) + '.csv', data: csv }); toast('Saved'); return; } catch (e) { if (e && e.code === 'declined') return; } } copyText(csv, 'Scores copied as CSV (download not available in this view)'); }
  function copyText(text, msg) { const done = () => toast(msg || 'Copied'); if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); else fallbackCopy(text, done); }
  function fallbackCopy(text, done) { const ta = el('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Select the text in the settings panel to copy it'); } ta.remove(); }
  let toastT; function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }

  // ---------------- wiring ----------------
  function wire() {
    $('#btnTheme').addEventListener('click', () => applyTheme(state.theme === 'system' ? 'light' : state.theme === 'light' ? 'dark' : 'system'));
    $('#btnSettings').addEventListener('click', openSettings); $('#btnExport').addEventListener('click', exportScores);
    $('#scrim').addEventListener('click', closeOverlays); $('#drawerClose').addEventListener('click', closeOverlays); $('#settingsClose').addEventListener('click', closeOverlays); $('#settings').addEventListener('click', e => { if (e.target.id === 'settings') closeOverlays(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeOverlays(); });
    $$('#rangeSeg button').forEach(b => b.addEventListener('click', () => { state.range = b.dataset.range; state.drawerRange = null; $$('#rangeSeg button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderHistory(); }));
    const sl = $('#asofSlider'); sl.addEventListener('input', () => { const i = parseInt(sl.value, 10); $('#asofWhen').textContent = i >= state.asOfMax ? 'Today' : fmtMonth(state.hist.t[i]); }); sl.addEventListener('change', () => { const i = parseInt(sl.value, 10); state.asOf = i >= state.asOfMax ? null : state.hist.t[i]; renderAll(); });
    $('#btnToday').addEventListener('click', () => { state.asOf = null; renderAll(); });
    $$('#tbl th[data-key]').forEach(th => th.addEventListener('click', () => { const k = th.dataset.key; if (state.sort.key === k) state.sort.dir *= -1; else state.sort = { key: k, dir: k === 'name' || k === 'pillar' ? 1 : -1 }; renderTable(); }));
    $('#fileInput').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); if (!j.series) throw new Error('no series'); state.data = j; state.source = 'local file ' + f.name; $('#loadError').hidden = true; $('#main').hidden = false; renderFreshness(); compute(); renderAll(); } catch (err) { toast('That file is not a Downturn Monitor data file'); } });
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (state.model) { renderHistory(); renderPillars(); if (state.openId) openIndicator(state.openId); } }, 150); });
    const repo = $('#repoLink'); if (CONFIG.repoUrl) { repo.href = CONFIG.repoUrl; } else repo.hidden = true;
  }

  async function boot() {
    try { applyTheme(localStorage.getItem('dm.theme') || 'system'); } catch (e) { applyTheme('system'); }
    loadSettings(); wire();
    if (window.claude && typeof window.claude.use === 'function') window.claude.use('downloads').then(ns => { state.dl = ns; }).catch(() => { state.dl = null; }); else state.dl = null;
    const res = await loadData();
    if (res.error) { $('#loading').hidden = true; const le = $('#loadError'); le.hidden = false; $('#loadErrorMsg').textContent = 'Could not load the data file (' + res.error + '). Check your connection, or load a data.json produced by the pipeline.'; return; }
    state.data = res.j; state.source = res.src; $('#loading').hidden = true; $('#main').hidden = false; renderFreshness(); compute(); renderAll();
  }
  window.DMApp = { state, openIndicator, renderAll, compute };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
