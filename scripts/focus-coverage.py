#!/usr/bin/env python3
"""
Measure how well aw-watcher-web covers the time the browser was actually
focused, using aw-watcher-window as ground truth.

Draft-PR helper for the "Only track when browser is focused" setting (#140);
remove before merge. Reads from the local ActivityWatch API and prints only
aggregate numbers and times (no URLs or titles), so the output is safe to
paste into a GitHub comment.

Usage:
    python3 scripts/focus-coverage.py --start 2026-10-10T09:00 [--end ...]
        [--browser chrome] [--app "Google Chrome"] [--server http://localhost:5600]
"""

import argparse
import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

# Window-watcher app names to treat as "this browser is focused", keyed by the
# browser name in the web bucket id (aw-watcher-web-<browser>_<host>)
BROWSER_APP_RES = {
    "chrome": r"chrome|chromium",
    "brave": r"brave",
    "edge": r"edge",
    "firefox": r"firefox",
    "opera": r"opera",
    "safari": r"safari",
    "vivaldi": r"vivaldi",
    "arc": r"^arc",
}


def get(server, path):
    with urllib.request.urlopen(f"{server}/api/0/{path}") as r:
        return json.load(r)


def parse(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def local(ts):
    dt = datetime.fromisoformat(ts)
    return dt if dt.tzinfo else dt.astimezone()


def events(server, bucket, start, end):
    query = urllib.parse.urlencode(
        {
            "limit": -1,
            "start": start.astimezone(timezone.utc).isoformat(),
            "end": end.astimezone(timezone.utc).isoformat(),
        }
    )
    path = f"buckets/{bucket}/events?{query}"
    out = []
    for e in get(server, path):
        s = parse(e["timestamp"])
        out.append((s, s + timedelta(seconds=e["duration"]), e["data"]))
    return sorted(out, key=lambda x: x[0])


def pick_bucket(buckets, type_, prefix, hint=None, hostname=None):
    ids = [b for b, v in buckets.items() if v["type"] == type_ and b.startswith(prefix)]
    if hint:
        ids = [b for b in ids if hint in b]
    # Prefer the bucket from the same host as the web bucket, if there is one
    same_host = [b for b in ids if hostname and buckets[b].get("hostname") == hostname]
    if same_host:
        ids = same_host
    if len(ids) != 1:
        raise SystemExit(
            f"Expected one {prefix}* bucket, found {len(ids)}: {ids}"
            + ("; use --browser" if prefix == "aw-watcher-web" else "")
        )
    return ids[0]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--start", required=True, help="local time, e.g. 2026-10-10T09:00")
    p.add_argument("--end", help="local time (default: now)")
    p.add_argument("--browser", help="substring of the web bucket id, e.g. chrome")
    p.add_argument("--app", help="regex for the browser's app name in aw-watcher-window")
    p.add_argument("--server", default="http://localhost:5600")
    a = p.parse_args()

    start = local(a.start)
    end = local(a.end) if a.end else datetime.now().astimezone()
    buckets = get(a.server, "buckets/")
    web_id = pick_bucket(buckets, "web.tab.current", "aw-watcher-web", a.browser)
    browser_name = web_id.split("_")[0].removeprefix("aw-watcher-web-")
    app_pattern = a.app or BROWSER_APP_RES.get(browser_name)
    if not app_pattern:
        raise SystemExit(f"Unknown browser {browser_name!r}; pass --app")
    app_re = re.compile(app_pattern, re.I)
    win_id = pick_bucket(
        buckets, "currentwindow", "aw-watcher-window",
        hostname=buckets[web_id].get("hostname"),
    )
    web = events(a.server, web_id, start, end)
    win = events(a.server, win_id, start, end)

    def clip(s, e):
        return max(s, start), min(e, end)

    def covered(s, e):
        return sum(max(0, (min(e, we) - max(s, ws)).total_seconds()) for ws, we, _ in web)

    focused = [clip(s, e) for s, e, d in win if app_re.search(d.get("app", ""))]
    focused = [(s, e) for s, e in focused if e > s]
    total = sum((e - s).total_seconds() for s, e in focused)
    if not total:
        raise SystemExit("No focused-browser time found; check --app")
    cov = sum(covered(s, e) for s, e in focused)
    web_total = sum(max(0, (min(e, end) - max(s, start)).total_seconds()) for s, e, _ in web)

    apps = sorted({d.get("app") for _, _, d in win if app_re.search(d.get("app", ""))})
    print(f"Browser: {browser_name}; app name(s): {', '.join(apps)}")
    print(f"Period: {start:%Y-%m-%d %H:%M} to {end:%Y-%m-%d %H:%M}")
    print(f"Browser focused: {total / 3600:.1f}h in {len(focused)} periods")
    print(f"Covered by web events: {cov / total * 100:.1f}%")
    print(f"Web time while browser not focused: {(web_total - cov) / 60:.1f} min")

    long = [(s, e) for s, e in focused if (e - s).total_seconds() >= 60]
    bad = [(s, e) for s, e in long if covered(s, e) < 0.8 * (e - s).total_seconds()]
    print(f"Focused periods >=60s: {len(long)}, of which <80% covered: {len(bad)}")
    for s, e in bad:
        print(
            f"  {s.astimezone():%a %H:%M:%S}  {int((e - s).total_seconds())}s focused,"
            f" {int(covered(s, e))}s covered"
        )


if __name__ == "__main__":
    main()
