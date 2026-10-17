# Downturn Monitor

A recession-and-correction early-warning board for the US economy and markets, built entirely on free public data.
Thirty indicators across six pillars are scored on a continuous 1–5 scale and combined into one composite reading:

| Level | Name | Composite |
|---|---|---|
| 1 | Benign | 1.0 – 1.8 |
| 2 | Guarded | 1.8 – 2.6 |
| 3 | Elevated | 2.6 – 3.4 |
| 4 | High | 3.4 – 4.2 |
| 5 | Severe | 4.2 – 5.0 |

## How it runs

```
.github/workflows/update-data.yml   GitHub Actions schedule: pulls every series twice each weekday morning
pipeline/build_data.py              the fetcher (standard library only; FRED + Yahoo Finance + NY Fed)
data/data.json                      the output the dashboard reads (committed by the workflow)
data/latest.csv, data/status.json   human-readable snapshot and freshness sidecar
site/                               the dashboard: template.html + styles.css + engine.js + app.js
pipeline/build_site.py              inlines everything into one self-contained HTML file (index.html, downturn-monitor.html)
```

Three ways to open the dashboard, all reading the same `data/data.json`:

- **GitHub Pages** (plain website): `index.html` at the repository root, served at `https://pankau85.github.io/downturn-monitor/`
  once Pages is enabled (Settings → Pages → Deploy from a branch → `main` / root). It reads `data/data.json` relatively.
- **Standalone file**: `downturn-monitor.html` — one self-contained file you can download, email or put on a shared drive;
  it fetches the data from this repository's raw URL when opened, with a "Load data file" fallback when offline.
- **Claude artifact**: the same page published as an artifact, with its own daily-refreshed snapshot of the data.

Both HTML copies are rebuilt from `site/` by the workflow on every run, so they never drift from the source.

## Running the pipeline yourself

```bash
python pipeline/build_data.py --out data/data.json      # ~1 minute; needs internet access to FRED
python pipeline/build_site.py --live-url <raw data.json URL> --repo-url <this repo>
```

`build_data.py` never fails the whole run because one source is down: a series that cannot be fetched keeps its previous
copy (flagged `stale`) and the failure is recorded in `status.json`. The job only exits non-zero when FRED itself is
broadly unreachable.

## Scoring in one paragraph

Each indicator has five thresholds: the values at which it would score exactly 1, 2, 3, 4 and 5, with straight-line
interpolation in between (see `site/engine.js`, `INDICATORS`). A few use richer rules: the yield curve is cycle-aware
(the danger window is the re-steepening after an inversion), credit spreads take the higher of a level and a momentum
score, CPI is two-sided and consumer sentiment blends level and change. Indicators are averaged within pillars, pillars
into the composite, with weights that can be changed in the page. Historical readings apply assumed publication lags so
the back-test reflects what was knowable at each month end (with the caveat that most series are as revised today).

## Sources

FRED (Federal Reserve Bank of St. Louis), ICE BofA indexes via FRED, Chicago Fed (NFCI, CFNAI), St. Louis Fed (STLFSI),
New York Fed (yield-curve recession probability), Dallas Fed (Weekly Economic Index), BLS, BEA, Census, University of
Michigan, CBOE, Stooq, Yahoo Finance, DBnomics (ISM). All data remains the property of its publishers.
