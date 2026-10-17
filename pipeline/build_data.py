#!/usr/bin/env python3
"""
Downturn Monitor – data pipeline
================================
Pulls every input series from free public sources (FRED first; Yahoo Finance for
the S&P 500 full history and the MOVE index; the NY Fed for its yield-curve
recession probability) and writes a compact data/data.json that the dashboard reads.

Design rules
* Standard library only (urllib, csv, json). Optional extras (xlrd for the NY Fed
  workbook) are used when importable and skipped otherwise.
* Every source is wrapped in try/except: one broken feed never blocks the rest.
  Failures are recorded in the "status" block so the page can show staleness.
* Output is append-only in spirit: if a series fails today, yesterday's copy of
  that series is kept (read from the existing data.json) so the page never loses
  history because of a transient outage.

Usage:  python pipeline/build_data.py [--out data/data.json] [--start 1959-01-01]
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (compatible; DownturnMonitor/1.0; +https://github.com)"
EPOCH = dt.date(1970, 1, 1)

# --------------------------------------------------------------------------- #
# Series catalogue.  "id" is the key the dashboard uses.  Everything with
# src == "FRED" is fetched from fredgraph.csv (no API key needed).
# --------------------------------------------------------------------------- #
SERIES = [
    # ---- Rates & policy -------------------------------------------------- #
    {"id": "T10Y3M",   "src": "FRED", "freq": "D", "start": "1982-01-01", "title": "10-Year minus 3-Month Treasury spread", "units": "pct pts"},
    {"id": "T10Y2Y",   "src": "FRED", "freq": "D", "start": "1976-06-01", "title": "10-Year minus 2-Year Treasury spread", "units": "pct pts"},
    {"id": "DGS2",     "src": "FRED", "freq": "D", "start": "1976-06-01", "title": "2-Year Treasury yield", "units": "pct"},
    {"id": "DGS10",    "src": "FRED", "freq": "D", "start": "1962-01-01", "title": "10-Year Treasury yield", "units": "pct"},
    {"id": "DFF",      "src": "FRED", "freq": "D", "start": "1976-01-01", "title": "Effective federal funds rate (daily)", "units": "pct"},
    {"id": "FEDFUNDS", "src": "FRED", "freq": "M", "start": "1959-01-01", "title": "Effective federal funds rate (monthly)", "units": "pct"},
    {"id": "DFII10",   "src": "FRED", "freq": "D", "start": "2003-01-01", "title": "10-Year TIPS real yield", "units": "pct"},
    {"id": "CPIAUCSL", "src": "FRED", "freq": "M", "start": "1959-01-01", "title": "CPI, all items (SA)", "units": "index"},
    {"id": "PCEPILFE", "src": "FRED", "freq": "M", "start": "1959-01-01", "title": "Core PCE price index (SA)", "units": "index"},
    {"id": "DCOILWTICO","src": "FRED","freq": "D", "start": "1986-01-01", "title": "WTI crude oil spot", "units": "USD/bbl"},
    # ---- Credit & financial conditions ------------------------------------ #
    {"id": "BAMLH0A0HYM2", "src": "FRED", "freq": "D", "start": "1996-12-31", "title": "ICE BofA US High Yield OAS", "units": "pct"},
    {"id": "BAMLC0A0CM",   "src": "FRED", "freq": "D", "start": "1996-12-31", "title": "ICE BofA US Corporate (IG) OAS", "units": "pct"},
    {"id": "BAA10Y",       "src": "FRED", "freq": "D", "start": "1986-01-02", "title": "Moody's Baa corporate yield minus 10-Year Treasury", "units": "pct pts"},
    {"id": "NFCI",         "src": "FRED", "freq": "W", "start": "1971-01-01", "title": "Chicago Fed National Financial Conditions Index", "units": "index"},
    {"id": "STLFSI4",      "src": "FRED", "freq": "W", "start": "1993-12-31", "title": "St. Louis Fed Financial Stress Index", "units": "index"},
    {"id": "DRTSCILM",     "src": "FRED", "freq": "Q", "start": "1990-01-01", "title": "SLOOS: net % of banks tightening C&I standards (large/mid firms)", "units": "pct"},
    # ---- Labor ------------------------------------------------------------ #
    {"id": "SAHMREALTIME", "src": "FRED", "freq": "M", "start": "1959-12-01", "title": "Real-time Sahm Rule recession indicator", "units": "pct pts"},
    {"id": "UNRATE",       "src": "FRED", "freq": "M", "start": "1959-01-01", "title": "Unemployment rate", "units": "pct"},
    {"id": "ICSA",         "src": "FRED", "freq": "W", "start": "1967-01-07", "title": "Initial jobless claims (SA)", "units": "persons"},
    {"id": "CCSA",         "src": "FRED", "freq": "W", "start": "1967-01-07", "title": "Continued jobless claims (SA)", "units": "persons"},
    {"id": "PAYEMS",       "src": "FRED", "freq": "M", "start": "1959-01-01", "title": "Total nonfarm payrolls (SA)", "units": "thousands"},
    # ---- Growth & activity ------------------------------------------------ #
    {"id": "CFNAIMA3",  "src": "FRED", "freq": "M", "start": "1967-05-01", "title": "Chicago Fed National Activity Index, 3-month MA", "units": "index"},
    {"id": "WEI",       "src": "FRED", "freq": "W", "start": "2008-01-05", "title": "Weekly Economic Index (Lewis-Mertens-Stock)", "units": "index"},
    {"id": "PERMIT",    "src": "FRED", "freq": "M", "start": "1960-01-01", "title": "Building permits, new private housing (SAAR)", "units": "thousands"},
    {"id": "NEWORDER",  "src": "FRED", "freq": "M", "start": "1992-02-01", "title": "Mfg new orders: nondefense capital goods ex aircraft", "units": "USD mn"},
    {"id": "INDPRO",    "src": "FRED", "freq": "M", "start": "1959-01-01", "title": "Industrial production index", "units": "index"},
    {"id": "GACDFSA066MSFRBPHI", "src": "FRED", "freq": "M", "start": "1968-05-01", "title": "Philadelphia Fed manufacturing: current general activity (SA)", "units": "diffusion"},
    {"id": "GACDISA066MSFRBNY",  "src": "FRED", "freq": "M", "start": "2001-07-01", "title": "Empire State manufacturing: general business conditions (SA)", "units": "diffusion"},
    # ---- Consumer --------------------------------------------------------- #
    {"id": "UMCSENT",   "src": "FRED", "freq": "M", "start": "1959-01-01", "title": "U. Michigan consumer sentiment", "units": "index"},
    {"id": "W875RX1",   "src": "FRED", "freq": "M", "start": "1959-01-01", "title": "Real personal income excl. transfer receipts", "units": "USD bn (2017$)"},
    {"id": "RRSFS",     "src": "FRED", "freq": "M", "start": "1992-01-01", "title": "Real retail and food services sales", "units": "USD mn (2017$)"},
    {"id": "DRCCLACBS", "src": "FRED", "freq": "Q", "start": "1991-01-01", "title": "Credit card delinquency rate, all commercial banks", "units": "pct"},
    # ---- Markets ---------------------------------------------------------- #
    {"id": "SP500",     "src": "FRED", "freq": "D", "start": "2010-01-01", "title": "S&P 500 (FRED, trailing 10 years)", "units": "index"},
    {"id": "VIXCLS",    "src": "FRED", "freq": "D", "start": "1990-01-02", "title": "CBOE VIX", "units": "index"},
    {"id": "NASDAQCOM", "src": "FRED", "freq": "D", "start": "1985-01-01", "title": "NASDAQ Composite", "units": "index"},
    {"id": "DTWEXBGS",  "src": "FRED", "freq": "D", "start": "2006-01-01", "title": "Trade-weighted US dollar index, broad", "units": "index"},
    # ---- Reference / context --------------------------------------------- #
    {"id": "USREC",          "src": "FRED", "freq": "M", "start": "1959-01-01", "title": "NBER recession indicator (1 = recession)", "units": "flag"},
    {"id": "RECPROUSM156N",  "src": "FRED", "freq": "M", "start": "1967-06-01", "title": "Smoothed US recession probabilities (Chauvet-Piger)", "units": "pct"},
    {"id": "M2SL",           "src": "FRED", "freq": "M", "start": "1959-01-01", "title": "M2 money stock (SA)", "units": "USD bn"},
    # ---- Non-FRED (optional) --------------------------------------------- #
    {"id": "SPX",    "src": "YAHOO", "symbol": "^GSPC", "freq": "D", "start": "1985-01-01", "title": "S&P 500 (Yahoo Finance, full daily history)", "units": "index"},
    {"id": "MOVE",   "src": "YAHOO", "symbol": "^MOVE", "freq": "D", "start": "2002-01-01", "title": "ICE BofA MOVE index (Treasury implied vol)", "units": "index"},
    {"id": "NYFEDPROB", "src": "NYFED", "freq": "M", "start": "1959-01-01", "title": "NY Fed recession probability (yield-curve model); rows dated by the month predicted", "units": "pct"},
]

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def http_get(url: str, timeout: int = 60, retries: int = 3, headers: dict | None = None) -> bytes:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionError) as e:  # noqa: PERF203
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET failed after {retries} attempts: {url} :: {last}")


def to_day(d: dt.date) -> int:
    return (d - EPOCH).days


def parse_date(s: str) -> dt.date:
    return dt.date.fromisoformat(s[:10])


def pack(points: list[tuple[dt.date, float]], start: str) -> dict:
    """points -> {"t":[epoch days], "v":[values]} sorted, de-duplicated, trimmed."""
    start_d = parse_date(start)
    seen: dict[int, float] = {}
    for d, v in points:
        if d < start_d or v is None:
            continue
        seen[to_day(d)] = v
    ts = sorted(seen)
    return {"t": ts, "v": [round(seen[t], 6) for t in ts]}


# --------------------------------------------------------------------------- #
# Fetchers
# --------------------------------------------------------------------------- #

def fetch_fred(series_id: str, start: str) -> list[tuple[dt.date, float]]:
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}&cosd={start}"
    raw = http_get(url).decode("utf-8", errors="replace")
    rdr = csv.reader(io.StringIO(raw))
    header = next(rdr, None)
    if not header or len(header) < 2:
        raise RuntimeError(f"unexpected FRED response for {series_id}: {raw[:120]!r}")
    out = []
    for row in rdr:
        if len(row) < 2 or row[1] in (".", ""):
            continue
        try:
            out.append((parse_date(row[0]), float(row[1])))
        except ValueError:
            continue
    if not out:
        raise RuntimeError(f"FRED returned no observations for {series_id}")
    return out


def fetch_yahoo(symbol: str) -> list[tuple[dt.date, float]]:
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(symbol)}?period1=0&period2={int(time.time())}&interval=1d&includePrePost=false")
    js = json.loads(http_get(url).decode("utf-8"))
    res = js["chart"]["result"][0]
    ts = res["timestamp"]
    closes = res["indicators"]["quote"][0]["close"]
    out = []
    for t, c in zip(ts, closes):
        if c is None:
            continue
        out.append((dt.datetime.utcfromtimestamp(t).date(), float(c)))
    if len(out) < 100:
        raise RuntimeError("Yahoo returned too few rows")
    return out


def fetch_nyfed_prob() -> list[tuple[dt.date, float]]:
    """NY Fed 'Probability of US recession predicted by Treasury spread' (allmonth.xls)."""
    try:
        import xlrd  # type: ignore
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("xlrd not installed") from e
    url = "https://www.newyorkfed.org/medialibrary/media/research/capital_markets/allmonth.xls"
    book = xlrd.open_workbook(file_contents=http_get(url))
    sh = book.sheet_by_index(0)
    # find header row containing 'Rec_prob'
    hdr_row, col_date, col_prob = None, None, None
    for r in range(min(sh.nrows, 20)):
        vals = [str(sh.cell_value(r, c)).strip().lower() for c in range(sh.ncols)]
        if any("rec_prob" in v or "recession" in v for v in vals):
            hdr_row = r
            for c, v in enumerate(vals):
                if v.startswith("date"):
                    col_date = c
                if "rec_prob" in v or "recession" in v:
                    col_prob = c
            break
    if hdr_row is None or col_date is None or col_prob is None:
        raise RuntimeError("NY Fed workbook layout not recognised")
    out = []
    for r in range(hdr_row + 1, sh.nrows):
        dv = sh.cell_value(r, col_date)
        pv = sh.cell_value(r, col_prob)
        if dv in ("", None) or pv in ("", None):
            continue
        try:
            if isinstance(dv, float):
                y, m, d, *_ = xlrd.xldate_as_tuple(dv, book.datemode)
                date = dt.date(y, m, d)
            else:
                sv = str(dv).strip()
                try:
                    date = dt.datetime.strptime(sv, "%d-%b-%Y").date()
                except ValueError:
                    date = parse_date(sv)
            prob = float(pv)
            if prob <= 1.0:
                prob *= 100.0
            out.append((date, prob))
        except (ValueError, TypeError):
            continue
    if not out:
        raise RuntimeError("NY Fed workbook: no rows parsed")
    return out


def fetch_series(spec: dict) -> list[tuple[dt.date, float]]:
    src = spec["src"]
    if src == "FRED":
        return fetch_fred(spec["id"], spec["start"])
    if src == "YAHOO":
        return fetch_yahoo(spec["symbol"])
    if src == "NYFED":
        return fetch_nyfed_prob()
    raise RuntimeError(f"unknown source {src}")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/data.json")
    ap.add_argument("--only", default="", help="comma-separated series ids (debug)")
    ap.add_argument("--sleep", type=float, default=0.4, help="pause between requests (politeness)")
    args = ap.parse_args()

    previous: dict = {}
    if os.path.exists(args.out):
        try:
            with open(args.out, "r", encoding="utf-8") as f:
                previous = json.load(f)
        except Exception:  # noqa: BLE001
            previous = {}
    prev_series = previous.get("series", {})

    only = {s for s in args.only.split(",") if s}
    series_out: dict = {}
    status: dict = {}
    n_ok = n_fail = 0

    for spec in SERIES:
        sid = spec["id"]
        if only and sid not in only:
            continue
        t0 = time.time()
        try:
            pts = fetch_series(spec)
            packed = pack(pts, spec["start"])
            if not packed["t"]:
                raise RuntimeError("no observations after trimming")
            series_out[sid] = {
                "id": sid, "src": spec["src"], "freq": spec["freq"], "title": spec["title"],
                "units": spec["units"], "n": len(packed["t"]),
                "start": (EPOCH + dt.timedelta(days=packed["t"][0])).isoformat(),
                "end": (EPOCH + dt.timedelta(days=packed["t"][-1])).isoformat(),
                "fetched_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "t": packed["t"], "v": packed["v"],
            }
            status[sid] = {"ok": True, "n": len(packed["t"]), "end": series_out[sid]["end"], "secs": round(time.time() - t0, 2)}
            n_ok += 1
            print(f"ok   {sid:<22} {len(packed['t']):>6} obs  last {series_out[sid]['end']}  {series_out[sid]['v'][-1]}")
        except Exception as e:  # noqa: BLE001
            n_fail += 1
            msg = str(e)[:300]
            if sid in prev_series:
                series_out[sid] = prev_series[sid]
                series_out[sid]["stale"] = True
                status[sid] = {"ok": False, "kept_previous": True, "end": prev_series[sid].get("end"), "error": msg}
                print(f"WARN {sid:<22} fetch failed, kept previous copy (last {prev_series[sid].get('end')}): {msg}")
            else:
                status[sid] = {"ok": False, "kept_previous": False, "error": msg}
                print(f"FAIL {sid:<22} {msg}")
        time.sleep(args.sleep)

    core_ok = sum(1 for s in SERIES if s["src"] == "FRED" and status.get(s["id"], {}).get("ok"))
    core_total = sum(1 for s in SERIES if s["src"] == "FRED" and (not only or s["id"] in only))

    out = {
        "schema": 1,
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generator": "pipeline/build_data.py",
        "sources": {
            "FRED": "https://fred.stlouisfed.org/",
            "YAHOO": "https://finance.yahoo.com/",
            "NYFED": "https://www.newyorkfed.org/research/capital_markets/ycfaq.html",
        },
        "summary": {"ok": n_ok, "failed": n_fail, "fred_ok": core_ok, "fred_total": core_total},
        "status": status,
        "series": series_out,
    }

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    # small sidecar for freshness checks
    with open(os.path.join(os.path.dirname(args.out) or ".", "status.json"), "w", encoding="utf-8") as f:
        json.dump({"generated_at": out["generated_at"], "summary": out["summary"], "status": status}, f, indent=1)
    # human-readable snapshot of latest values
    with open(os.path.join(os.path.dirname(args.out) or ".", "latest.csv"), "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "title", "units", "freq", "last_date", "last_value", "n_obs", "source", "ok"])
        for sid, s in series_out.items():
            w.writerow([sid, s["title"], s["units"], s["freq"], s["end"], s["v"][-1], s["n"], s["src"], status.get(sid, {}).get("ok")])

    size_mb = os.path.getsize(args.out) / 1e6
    print(f"\nwrote {args.out} ({size_mb:.2f} MB)  ok={n_ok} failed={n_fail}  FRED {core_ok}/{core_total}")
    # Fail the job only if FRED itself is broadly down (so a broken optional feed never fails CI)
    return 0 if core_total == 0 or core_ok >= max(1, int(0.8 * core_total)) else 1


if __name__ == "__main__":
    sys.exit(main())
