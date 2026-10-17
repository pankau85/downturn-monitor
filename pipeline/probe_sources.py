#!/usr/bin/env python3
"""Diagnostic: dump what the optional (non-FRED) sources actually return, so fetchers can be fixed
without guessing. Writes data/probe.json. Run by the 'Probe sources' workflow on demand."""
import datetime as dt
import json
import sys
import time
import traceback

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build_data import http_get  # noqa: E402

out = {"ran_at": dt.datetime.now(dt.timezone.utc).isoformat()}


def probe(name, fn):
    t0 = time.time()
    try:
        out[name] = {"ok": True, "secs": round(time.time() - t0, 1), "result": fn()}
    except Exception as e:  # noqa: BLE001
        out[name] = {"ok": False, "error": str(e)[:500], "trace": traceback.format_exc()[-800:]}


def stooq():
    raw = http_get("https://stooq.com/q/d/l/?s=%5Espx&i=d").decode("utf-8", "replace")
    lines = raw.splitlines()
    return {"status_head": lines[:5], "tail": lines[-3:], "n_lines": len(lines)}


def yahoo(symbol, params):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?{params}"
    js = json.loads(http_get(url).decode("utf-8"))
    res = js["chart"]["result"][0]
    ts = res.get("timestamp", [])
    meta = res.get("meta", {})
    return {"url": url, "n": len(ts), "first": dt.datetime.utcfromtimestamp(ts[0]).isoformat() if ts else None,
            "last": dt.datetime.utcfromtimestamp(ts[-1]).isoformat() if ts else None,
            "dataGranularity": meta.get("dataGranularity"), "range": meta.get("range"), "validRanges": meta.get("validRanges")}


def dbnomics():
    js = json.loads(http_get("https://api.db.nomics.world/v22/series/ISM/pmi?observations=1&limit=200").decode("utf-8"))
    docs = js.get("series", {}).get("docs", [])
    rows = []
    for d in docs:
        per, val = d.get("period", []), d.get("value", [])
        rows.append({"code": d.get("series_code"), "name": d.get("series_name"), "first": per[0] if per else None, "last": per[-1] if per else None,
                     "n": len(per), "tail": list(zip(per[-6:], val[-6:]))})
    datasets = json.loads(http_get("https://api.db.nomics.world/v22/datasets/ISM?limit=50").decode("utf-8"))
    return {"pmi_series": rows, "datasets": [(x.get("code"), x.get("name"), x.get("nb_series")) for x in datasets.get("datasets", {}).get("docs", [])]}


def nyfed():
    import xlrd  # type: ignore
    raw = http_get("https://www.newyorkfed.org/medialibrary/media/research/capital_markets/allmonth.xls")
    info = {"bytes": len(raw), "magic": raw[:8].hex()}
    book = xlrd.open_workbook(file_contents=raw)
    sh = book.sheet_by_index(0)
    info["sheets"] = book.sheet_names()
    info["nrows"] = sh.nrows
    info["ncols"] = sh.ncols
    info["datemode"] = book.datemode
    info["head"] = [[repr(sh.cell_value(r, c)) + ":" + str(sh.cell_type(r, c)) for c in range(min(sh.ncols, 8))] for r in range(min(sh.nrows, 12))]
    info["tail"] = [[repr(sh.cell_value(r, c)) for c in range(min(sh.ncols, 8))] for r in range(max(0, sh.nrows - 5), sh.nrows)]
    return info


probe("stooq", stooq)
probe("yahoo_gspc_range_max", lambda: yahoo("%5EGSPC", "range=max&interval=1d"))
probe("yahoo_gspc_period", lambda: yahoo("%5EGSPC", f"period1=0&period2={int(time.time())}&interval=1d"))
probe("yahoo_move_period", lambda: yahoo("%5EMOVE", f"period1=0&period2={int(time.time())}&interval=1d"))
probe("dbnomics_ism", dbnomics)
probe("nyfed", nyfed)

with open("data/probe.json", "w", encoding="utf-8") as f:
    json.dump(out, f, indent=1, default=str)
print(json.dumps({k: (v.get("ok"), v.get("error")) for k, v in out.items() if isinstance(v, dict)}, indent=1))
