#!/usr/bin/env python3
"""Inline styles.css, engine.js and app.js into template.html → site/downturn-monitor.html.

Usage: python pipeline/build_site.py [--live-url URL] [--repo-url URL] [--out site/downturn-monitor.html]
"""
import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(os.path.dirname(HERE), "site")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live-url", default="")
    ap.add_argument("--repo-url", default="")
    ap.add_argument("--out", default=os.path.join(SITE, "downturn-monitor.html"))
    a = ap.parse_args()
    read = lambda n: open(os.path.join(SITE, n), encoding="utf-8").read()
    html = read("template.html")
    cfg = {k: v for k, v in {"liveUrl": a.live_url, "repoUrl": a.repo_url}.items() if v}
    html = html.replace("/*__CSS__*/", read("styles.css"))
    html = html.replace("/*__CONFIG__*/{}", json.dumps(cfg))
    html = html.replace("/*__ENGINE__*/", read("engine.js").replace("</script>", "<\\/script>"))
    html = html.replace("/*__APP__*/", read("app.js").replace("</script>", "<\\/script>"))
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"wrote {a.out} ({os.path.getsize(a.out)/1024:.0f} KB) config={cfg}")


if __name__ == "__main__":
    main()
