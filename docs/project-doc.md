# Downturn Monitor — design, data pipeline and operating notes

_Built 2026-10-17. A separate dashboard from the TRS risk dashboard: it tracks public macro and market indicators that
historically precede recessions and major corrections, and rolls them into one 1–5 score._

## Links

- Dashboard (Claude artifact, always-current): https://claude.ai/artifact/QMqq8xMDeJhMeUC99RYo1v
- Repository (pipeline, data, source): https://github.com/pankau85/downturn-monitor
- Live data file the page reads: https://raw.githubusercontent.com/pankau85/downturn-monitor/main/data/data.json

## What it shows

- **Composite score 1–5** with five named levels. Aggregates (composite, lenses, pillars) use calibrated bands:
  1 Benign (1.0–1.7), 2 Guarded (1.7–2.3), 3 Elevated (2.3–3.0), 4 High (3.0–3.7), 5 Severe (3.7–5.0); individual
  indicators use equal bands (1.8 / 2.6 / 3.4 / 4.2). Calibration rule: on 1990–2026 history every recession reaches
  High or Severe and non-recession stress episodes top out at Elevated. Green → yellow → orange → red; every level also
  carries its number and name so colour never stands alone.
- **Two lenses**: Economy (rates & policy, labor, growth, consumer) and Markets (credit conditions, market stress).
- **Six pillars** with default weights: Rates & policy 15, Credit & financial conditions 20, Labor 20, Growth & activity
  20, Consumer 10, Market stress 15.
- **Thirty indicators** (29 FRED-based + MOVE from Yahoo Finance), each with its value, score, level,
  one-month score change, ten-year percentile and effective weight; click-through to a chart with the threshold bands,
  the rule, the rationale, a score history and an editable threshold set.
- **Composite history since 1990** with NBER recession shading. Clicking the chart or using the slider shows the whole
  board "as of" any month, using only data that would have been published by then (publication lags are assumed per
  series). Caveat: most series are as revised today, so the historical read is cleaner than true real time; the Sahm
  rule uses the real-time series.
- **Track record**: composite 12/6/3 months before each recession since 1990, at the start, its peak, and the first
  month it read High; plus the peak composite during eight stress episodes that did not become recessions (LTCM, 2011,
  2015–16, Q4 2018, 2022, March 2023, August 2024, April 2025).
- **Reference models** (not in the composite): Chauvet–Piger smoothed recession probability (FRED RECPROUSM156N) and
  the NY Fed yield-curve probability.
- **Weights & rules**: pillar weight sliders with presets (Default, Equal, Economy focus, Markets focus), indicator
  on/off, per-indicator thresholds, settings export/import as JSON. Stored in the browser only.
- **Download scores** (CSV of current readings plus the monthly composite history) via the artifact download capability.

## Scoring method

Each indicator has five anchor values: the readings at which it scores exactly 1, 2, 3, 4 and 5, linearly interpolated
and clamped. Richer rules where the literature calls for it:

- Yield curves (10y–3m, 10y–2y) are cycle-aware: inverted = 4.0–4.8 by depth; the nine months after a material
  inversion ends = 5, fading to the level score by month 18; otherwise by level.
- HY and IG spreads take the higher of a level score and a three-month-change score.
- CPI is two-sided (inflation and deflation tails both raise the score).
- Consumer sentiment averages a level score and a six-month-change score (its level has been structurally depressed
  since 2020).

Pillar score = weighted mean of available indicators; composite = weighted mean of pillars; missing indicators drop out
and weights rescale; the page shows the share of intended weight in play.

## Indicator roster (FRED id unless noted)

Rates & policy: T10Y3M, T10Y2Y, DGS2−DFF, FEDFUNDS−core PCE y/y (PCEPILFE), CPIAUCSL y/y, DCOILWTICO y/y.
Credit: BAMLH0A0HYM2, BAMLC0A0CM (FRED carries only three years of the ICE BofA indexes), BAA10Y (Moody's Baa minus
10-year, daily since 1986, carries the long history), NFCI, STLFSI4, DRTSCILM (SLOOS).
Labor: SAHMREALTIME, ICSA (4-wk avg vs 52-wk low), CCSA y/y, PAYEMS 3-mo avg change.
Growth: CFNAIMA3, WEI, PERMIT y/y, NEWORDER y/y, INDPRO y/y, regional Fed surveys (GACDFSA066MSFRBPHI +
GACDISA066MSFRBNY, 3-mo avg).
Consumer: UMCSENT (level + 6-month change; FRED posts it with a one-month embargo), W875RX1 y/y, RRSFS y/y,
DRCCLACBS (level + 12-month change).
Market stress: S&P 500 drawdown from 52-wk high and vs 200-day average (Yahoo ^GSPC daily since 1985, FRED SP500 as
fallback), VIXCLS, MOVE (Yahoo ^MOVE, daily since 2002).
Reference: USREC (recession shading), RECPROUSM156N, NY Fed allmonth.xls.

Not included: Conference Board LEI and consumer confidence (proprietary), equity breadth (no free feed), ISM PMI
(the only free feed, DBnomics, covers 2020–2025 and is corrupted after Sept 2025), Stooq (bot wall on GitHub runners).
Candidates for later: OECD CLI, Philadelphia Fed ADS and state leading index, Atlanta Fed GDPNow, copper/gold.

## Pipeline and refresh

- `pipeline/build_data.py` (standard library only) pulls every series from `fredgraph.csv` (no API key), Yahoo
  Finance (chart API with explicit period1/period2 — `range=max` silently returns quarterly data) and the NY Fed
  workbook; writes `data/data.json` (compact arrays of epoch-days and values, ~2 MB), `data/status.json` and
  `data/latest.csv`. A failed series keeps its previous copy and is flagged; the job fails only if FRED is broadly down.
  `pipeline/probe_sources.py` + the "Probe sources" workflow dump raw source diagnostics to `data/probe.json` on demand.
  `pipeline/calibrate.js data/data.json` prints live readings, year-by-year composite, per-indicator discrimination
  (recession vs expansion months) and the back-test — run it after any threshold change.
- GitHub Actions (`.github/workflows/update-data.yml`) runs at 11:10 UTC Mon–Sat (prior-day market closes; FRED posts
  the S&P 500 at ~7 pm CT) and 14:25 UTC Mon–Fri (after the 8:30 ET releases), commits the data, and ends with a
  `gh api` call that re-enables the workflow (GitHub disables schedules after 60 days without activity; third-party
  keepalive actions are blocked on this account — the first run failed with "Repository access blocked" until the
  marketplace action was removed).
- The artifact page fetches the raw data file on every load and falls back to the snapshot published with the page.
  A Claude scheduled task ("Downturn Monitor — refresh data snapshot", 6:50 AM CT Mon–Sat, automatic approval)
  downloads the GitHub file and republishes the artifact's `data.json` so the page stays current where GitHub is blocked.
- One-time setup that was needed: link GitHub to Claude, create the empty repo by hand (sessions cannot create repos),
  and grant the Claude GitHub App access to it (pushes are refused until then).
- Why GitHub: this workspace and the artifact sandbox cannot reach FRED (FRED has no CORS), and no third-party proxy
  belongs in a pension fund's data path. GitHub's runners can reach everything, cost nothing, and the output is a
  plain file with CORS.

## Known limitations and judgement calls

- Threshold anchors are judgement informed by the literature and the series' behaviour around past recessions; the
  back-test uses revised data, so treat lead times as optimistic. Back-test as built (composite at start / peak):
  1990 3.1 / 4.2, 2001 3.6 / 4.1 (High three months before), 2008 3.5 / 4.4 (High two months before), 2020 3.0 / 3.7
  (lag-limited). Stress-episode peaks: 1998 2.4, 2011 2.3, 2015–16 2.2, 2018 2.0, 2022 2.7, 2023 2.8, 2024 2.5, 2025 2.5.
- Yield-curve rule parameters are the most consequential judgement call: an inversion run counts only if it lasts
  10+ trading days; with the 10y–3m blips of Feb–Aug 2025 counting, the curve still scores ~3.4 in Oct 2026 (fading
  window); with a 15-day minimum it would score ~2.3. The drawer shows the state and the date the last inversion ended.
- First reading (17 Oct 2026): composite 1.7 Guarded — economy 1.9, markets 1.4. Rates & policy 2.9 (oil +71% y/y,
  CPI 4.0%, curve in post-inversion window), consumer 2.6 (sentiment 51.7, real income +0.8% y/y); credit, labor,
  growth and market stress all Benign.
- The composite is a prior, not a forecast; several episodes read 3+ without a recession (by design the Markets lens
  reacts to corrections).
- ISM PMI depends on DBnomics; MOVE on Yahoo; both are optional and the composite reweights without them.
- GitHub cron can run minutes late at busy times; the freshness chip and data-status table show exactly what was
  available when the file was built.
