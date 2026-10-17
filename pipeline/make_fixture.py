#!/usr/bin/env python3
"""Synthetic data file for UI development only (never published as real data).
Shapes are plausible random walks with recession-like episodes injected around the real NBER dates,
so every code path in the page (charts, drawer, backtest table, time travel) can be exercised offline.
Output marks itself with "synthetic": true."""
import datetime as dt
import json
import math
import random
import sys

random.seed(7)
EPOCH = dt.date(1970, 1, 1)
START = dt.date(1985, 1, 1)
END = dt.date(2026, 10, 16)
NBER = [("1990-07-01", "1991-03-01"), ("2001-03-01", "2001-11-01"), ("2007-12-01", "2009-06-01"), ("2020-02-01", "2020-04-01")]
rec_ranges = [(dt.date.fromisoformat(a), dt.date.fromisoformat(b)) for a, b in NBER]


def in_rec(d, lead=0):
    for a, b in rec_ranges:
        if a - dt.timedelta(days=lead) <= d < b:
            return True
    return False


def stress(d):  # 0..1 intensity peaking inside recessions, ramping 9 months before
    best = 0.0
    for a, b in rec_ranges:
        if d < a - dt.timedelta(days=270):
            continue
        if d < a:
            best = max(best, (270 - (a - d).days) / 270 * 0.6)
        elif d < b:
            best = max(best, 1.0)
        elif d < b + dt.timedelta(days=270):
            best = max(best, 1.0 - (d - b).days / 270)
    return best


def dates(freq):
    out = []
    d = START
    if freq == "D":
        while d <= END:
            if d.weekday() < 5:
                out.append(d)
            d += dt.timedelta(days=1)
    elif freq == "W":
        d = START + dt.timedelta(days=(5 - START.weekday()) % 7)
        while d <= END:
            out.append(d)
            d += dt.timedelta(days=7)
    elif freq == "M":
        y, m = 1960, 1
        while dt.date(y, m, 1) <= END:
            out.append(dt.date(y, m, 1))
            m += 1
            if m > 12:
                m, y = 1, y + 1
    elif freq == "Q":
        y, m = 1990, 1
        while dt.date(y, m, 1) <= END:
            out.append(dt.date(y, m, 1))
            m += 3
            if m > 12:
                m, y = 1, y + 1
    return out


def walk(ds, base, calm_amp, stress_amp, noise, lo=None, hi=None, trend=0.0, sign=1):
    out, x = [], base
    for i, d in enumerate(ds):
        s = stress(d)
        target = base + trend * i + sign * (calm_amp * math.sin(i / 37.0) + stress_amp * s)
        x += (target - x) * 0.08 + random.gauss(0, noise)
        if lo is not None:
            x = max(lo, x)
        if hi is not None:
            x = min(hi, x)
        out.append(x)
    return out


def level_series(ds, base, growth, stress_drop, noise):
    """index-type series (payrolls, IP, permits) that grows in expansions and falls in recessions"""
    out, x = [], base
    for d in ds:
        s = stress(d)
        x *= (1 + growth - stress_drop * s + random.gauss(0, noise))
        out.append(x)
    return out


series = {}


def put(sid, freq, vals, ds, title, units, src="FRED"):
    t = [(d - EPOCH).days for d in ds]
    series[sid] = {"id": sid, "src": src, "freq": freq, "title": title, "units": units, "n": len(t), "start": ds[0].isoformat(), "end": ds[-1].isoformat(), "fetched_at": "synthetic", "t": t, "v": [round(v, 4) for v in vals]}


D, W, M, Q = dates("D"), dates("W"), dates("M"), dates("Q")
# curve: positive normally, inverts before recessions
put("T10Y3M", "D", walk(D, 1.6, 0.6, 2.6, 0.03, sign=-1), D, "10y-3m spread", "pct pts")
put("T10Y2Y", "D", walk(D, 1.1, 0.5, 1.9, 0.03, sign=-1), D, "10y-2y spread", "pct pts")
put("DGS2", "D", walk(D, 3.5, 1.5, 2.5, 0.03, lo=0.1, sign=-1), D, "2y", "pct")
put("DGS10", "D", walk(D, 4.2, 1.2, 1.5, 0.03, lo=0.5, sign=-1), D, "10y", "pct")
put("DFF", "D", walk(D, 3.8, 1.5, 3.0, 0.01, lo=0.05, sign=-1), D, "fed funds", "pct")
put("FEDFUNDS", "M", walk(M, 3.8, 1.5, 3.0, 0.02, lo=0.05, sign=-1), M, "fed funds monthly", "pct")
put("DFII10", "D", walk(D, 1.2, 0.8, 1.0, 0.02, sign=-1), D, "real 10y", "pct")
put("CPIAUCSL", "M", level_series(M, 100, 0.0022, 0.002, 0.0015), M, "CPI", "index")
put("PCEPILFE", "M", level_series(M, 60, 0.0018, 0.001, 0.0008), M, "core PCE", "index")
put("DCOILWTICO", "D", [max(10, v) for v in walk(D, 55, 20, 25, 0.6)], D, "WTI", "USD")
put("BAMLH0A0HYM2", "D", walk(D, 4.2, 0.9, 7.0, 0.04, lo=2.4), D, "HY OAS", "pct")
put("BAMLC0A0CM", "D", walk(D, 1.2, 0.25, 2.2, 0.01, lo=0.7), D, "IG OAS", "pct")
put("NFCI", "W", walk(W, -0.45, 0.15, 1.6, 0.03), W, "NFCI", "index")
put("STLFSI4", "W", walk(W, -0.5, 0.3, 3.5, 0.08), W, "STLFSI", "index")
put("DRTSCILM", "Q", walk(Q, 2, 8, 55, 2.0), Q, "SLOOS", "pct")
unrate = walk(M, 4.8, 0.6, 4.5, 0.05, lo=3.2)
put("UNRATE", "M", unrate, M, "unemployment", "pct")
sahm = []
for i in range(len(unrate)):
    a3 = sum(unrate[max(0, i - 2):i + 1]) / len(unrate[max(0, i - 2):i + 1])
    lo12 = min(unrate[max(0, i - 11):i + 1])
    sahm.append(max(0.0, a3 - lo12))
put("SAHMREALTIME", "M", sahm, M, "Sahm", "pct pts")
put("ICSA", "W", walk(W, 240000, 25000, 280000, 4000, lo=170000), W, "initial claims", "persons")
put("CCSA", "W", walk(W, 1900000, 250000, 3500000, 20000, lo=1300000), W, "continued claims", "persons")
put("PAYEMS", "M", level_series(M, 90000, 0.0014, 0.006, 0.0006), M, "payrolls", "thousands")
put("CFNAIMA3", "M", walk(M, 0.1, 0.25, 1.9, 0.05, sign=-1), M, "CFNAI MA3", "index")
Wwei = [d for d in W if d >= dt.date(2008, 1, 5)]
put("WEI", "W", walk(Wwei, 2.2, 0.8, 6.0, 0.1, sign=-1), Wwei, "WEI", "index")
put("PERMIT", "M", level_series(M, 1400, 0.0008, 0.03, 0.01), M, "permits", "thousands")
Mn = [d for d in M if d >= dt.date(1992, 2, 1)]
put("NEWORDER", "M", level_series(Mn, 50000, 0.0015, 0.015, 0.006), Mn, "core capex", "USD mn")
put("INDPRO", "M", level_series(M, 60, 0.0016, 0.012, 0.003), M, "IP", "index")
put("GACDFSA066MSFRBPHI", "M", walk(M, 8, 10, 45, 3.0, sign=-1), M, "Philly", "diffusion")
Me = [d for d in M if d >= dt.date(2001, 7, 1)]
put("GACDISA066MSFRBNY", "M", walk(Me, 6, 10, 45, 3.0, sign=-1), Me, "Empire", "diffusion")
put("UMCSENT", "M", walk(M, 88, 8, 30, 1.2, lo=50, hi=112, sign=-1), M, "sentiment", "index")
put("W875RX1", "M", level_series(M, 6000, 0.0022, 0.008, 0.002), M, "real income ex transfers", "USD bn")
Mr = [d for d in M if d >= dt.date(1992, 1, 1)]
put("RRSFS", "M", level_series(Mr, 150000, 0.0018, 0.012, 0.004), Mr, "real retail", "USD mn")
Qd = [d for d in Q if d >= dt.date(1991, 1, 1)]
put("DRCCLACBS", "Q", walk(Qd, 3.0, 0.5, 2.5, 0.05, lo=1.5), Qd, "card dq", "pct")
spx = level_series(D, 300, 0.00035, 0.0045, 0.009)
put("SPX", "D", spx, D, "S&P 500", "index", src="STOOQ")
Dsp = [d for d in D if d >= dt.date(2016, 10, 17)]
put("SP500", "D", spx[-len(Dsp):], Dsp, "S&P 500 FRED", "index")
Dv = [d for d in D if d >= dt.date(1990, 1, 2)]
put("VIXCLS", "D", walk(Dv, 16, 4, 40, 0.5, lo=9), Dv, "VIX", "index")
put("NASDAQCOM", "D", level_series(D, 300, 0.0004, 0.006, 0.013), D, "NASDAQ", "index")
Dm = [d for d in D if d >= dt.date(2002, 1, 2)]
put("MOVE", "D", walk(Dm, 95, 20, 90, 1.5, lo=45), Dm, "MOVE", "index", src="YAHOO")
put("ISMPMI", "M", walk(M, 53, 3, 16, 0.5, lo=30, hi=68, sign=-1), M, "ISM PMI", "diffusion", src="DBNOMICS_ISM")
put("USREC", "M", [1.0 if in_rec(d) else 0.0 for d in M], M, "NBER recession", "flag")
put("RECPROUSM156N", "M", [min(100, max(0, 100 * stress(d) ** 2 + random.gauss(0, 1))) for d in M], M, "recession prob", "pct")
put("NYFEDPROB", "M", [min(100, max(0, 45 * stress(d) + 5 + random.gauss(0, 1))) for d in M], M, "NY Fed prob", "pct", src="NYFED")
put("M2SL", "M", level_series(M, 2000, 0.005, -0.002, 0.001), M, "M2", "USD bn")
put("DTWEXBGS", "D", walk([d for d in D if d >= dt.date(2006, 1, 2)], 110, 6, 10, 0.2), [d for d in D if d >= dt.date(2006, 1, 2)], "dollar", "index")

out = {"schema": 1, "synthetic": True, "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "generator": "pipeline/make_fixture.py (SYNTHETIC)",
       "sources": {"FRED": "https://fred.stlouisfed.org/"}, "summary": {"ok": len(series), "failed": 0}, "status": {k: {"ok": True, "n": v["n"], "end": v["end"]} for k, v in series.items()}, "series": series}
path = sys.argv[1] if len(sys.argv) > 1 else "site/fixture.json"
json.dump(out, open(path, "w"), separators=(",", ":"))
print("wrote", path, len(series), "series")
