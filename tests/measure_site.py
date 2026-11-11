#!/usr/bin/env python3
"""Print speed numbers for the site: LCP, CLS, INP, first-screen weight, API time.

Usage:
  .venv/bin/python tests/measure_site.py                       # desktop and phone, three runs each
  .venv/bin/python tests/measure_site.py --json output/perf.json

Each run opens a fresh browser profile, so nothing is cached: this is what a
person sees on the first visit. The script only reads; it never writes to the
server.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

OBSERVERS = """
(() => {
  const store = (window.__cvPerf = { lcp: null, cls: 0, shifts: [], events: [], paints: {} });
  const watch = (type, handler, extra = {}) => {
    try { new PerformanceObserver((list) => list.getEntries().forEach(handler)).observe({ type, buffered: true, ...extra }); } catch (error) {}
  };
  watch("largest-contentful-paint", (entry) => {
    const node = entry.element;
    store.lcp = {
      time: entry.startTime,
      size: entry.size,
      url: entry.url || "",
      node: node ? node.tagName.toLowerCase() + (node.className && typeof node.className === "string" ? "." + node.className.trim().split(/\\s+/).join(".") : "") : "",
    };
  });
  watch("layout-shift", (entry) => {
    if (entry.hadRecentInput) return;
    store.cls += entry.value;
    const source = entry.sources && entry.sources[0] && entry.sources[0].node;
    store.shifts.push({ time: entry.startTime, value: entry.value, node: source && source.tagName ? source.tagName.toLowerCase() + (typeof source.className === "string" && source.className ? "." + source.className.trim().split(/\\s+/)[0] : "") : "" });
  });
  watch("paint", (entry) => { store.paints[entry.name] = entry.startTime; });
  watch("event", (entry) => {
    if (entry.interactionId) store.events.push({ id: entry.interactionId, name: entry.name, duration: entry.duration });
  }, { durationThreshold: 16 });
})();
"""

API_PROBES = [
    ("каталог, первая страница", "/api/catalog?page=1&limit=50&sort=audience"),
    ("каталог, «Последний год»", "/api/catalog?page=1&limit=50&sort=fresh&collection=new"),
    ("каталог, жанр «драма»", "/api/catalog?page=1&limit=50&sort=audience&genre=" + urllib.parse.quote("драма")),
    ("каталог, редкая страница", "/api/catalog?page={deep}&limit=50&sort=audience&genre=" + urllib.parse.quote("комедия")),
    ("поиск «Менталист»", "/api/catalog?page=1&limit=50&sort=audience&search=" + urllib.parse.quote("Менталист")),
    ("индекс для главной", "/api/catalog/index?limit=150"),
    ("жанры и счётчики", "/api/catalog/facets"),
]

PROFILES = {
    "desktop": {"viewport": {"width": 1440, "height": 900}, "is_mobile": False, "has_touch": False, "device_scale_factor": 1},
    "phone": {"viewport": {"width": 375, "height": 812}, "is_mobile": True, "has_touch": True, "device_scale_factor": 2},
}

NETWORKS = {
    "none": None,
    "4g": {"offline": False, "latency": 150, "downloadThroughput": 1_600_000 // 8, "uploadThroughput": 750_000 // 8},
}


def launch(playwright):
    try:
        return playwright.chromium.launch(channel="chrome", headless=True)
    except Exception:  # noqa: BLE001
        print("Google Chrome не найден, беру встроенный Chromium", file=sys.stderr)
        return playwright.chromium.launch(headless=True)


def measure_page(browser, base: str, profile: str, network: str, cpu: float) -> dict:
    context = browser.new_context(service_workers="block", locale="ru-RU", **PROFILES[profile])
    context.add_init_script(OBSERVERS)
    page = context.new_page()
    session = context.new_cdp_session(page)
    session.send("Network.enable")
    if NETWORKS[network]:
        session.send("Network.emulateNetworkConditions", NETWORKS[network])
    if cpu > 1:
        session.send("Emulation.setCPUThrottlingRate", {"rate": cpu})

    requests: dict[str, dict] = {}
    session.on("Network.requestWillBeSent", lambda event: requests.setdefault(event["requestId"], {"url": event["request"]["url"], "type": event.get("type", "Other"), "bytes": 0, "done": False}))

    def finished(event: dict) -> None:
        entry = requests.get(event["requestId"])
        if entry:
            entry["bytes"] = event.get("encodedDataLength", 0)
            entry["done"] = True

    session.on("Network.loadingFinished", finished)

    started = time.monotonic()
    page.goto(base + "/", wait_until="domcontentloaded", timeout=90_000)
    try:
        page.wait_for_load_state("networkidle", timeout=45_000)
    except PlaywrightTimeout:
        pass
    page.wait_for_timeout(1500)
    settled = time.monotonic() - started
    first_screen = [entry for entry in requests.values() if entry["done"] and not entry["url"].startswith("data:")]

    navigation = page.evaluate("(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { ttfb: n.responseStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd } : {}; })()")
    load_numbers = page.evaluate("(() => ({ lcp: window.__cvPerf.lcp, cls: window.__cvPerf.cls, shifts: window.__cvPerf.shifts, paints: window.__cvPerf.paints }))()")

    interact(page)
    after = page.evaluate("(() => ({ cls: window.__cvPerf.cls, events: window.__cvPerf.events }))()")
    context.close()

    by_interaction: dict[int, float] = defaultdict(float)
    names: dict[int, str] = {}
    for event in after["events"]:
        if event["duration"] >= by_interaction[event["id"]]:
            by_interaction[event["id"]] = event["duration"]
            names[event["id"]] = event["name"]
    worst = max(by_interaction, key=by_interaction.get) if by_interaction else None

    origin = urllib.parse.urlsplit(base).netloc
    groups: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for entry in first_screen:
        host = urllib.parse.urlsplit(entry["url"]).netloc
        kind = entry["type"] if host == origin else f"чужое: {host}"
        if host == origin and urllib.parse.urlsplit(entry["url"]).path.startswith("/api/"):
            kind = "API"
        groups[kind][0] += 1
        groups[kind][1] += entry["bytes"]
    heaviest = sorted(first_screen, key=lambda entry: entry["bytes"], reverse=True)[:6]

    return {
        "profile": profile,
        "network": network,
        "cpu": cpu,
        "ttfb_ms": navigation.get("ttfb"),
        "fcp_ms": load_numbers["paints"].get("first-contentful-paint"),
        "lcp_ms": (load_numbers["lcp"] or {}).get("time"),
        "lcp_node": (load_numbers["lcp"] or {}).get("node"),
        "lcp_url": (load_numbers["lcp"] or {}).get("url"),
        "cls_load": load_numbers["cls"],
        "cls_total": after["cls"],
        "worst_shifts": sorted(load_numbers["shifts"], key=lambda shift: shift["value"], reverse=True)[:3],
        "inp_ms": by_interaction[worst] if worst else None,
        "inp_event": names.get(worst) if worst else None,
        "interactions": len(by_interaction),
        "settled_s": settled,
        "requests": len(first_screen),
        "bytes": sum(entry["bytes"] for entry in first_screen),
        "groups": {kind: {"requests": count, "bytes": size} for kind, (count, size) in sorted(groups.items(), key=lambda item: -item[1][1])},
        "heaviest": [{"url": entry["url"][:110], "bytes": entry["bytes"]} for entry in heaviest],
    }


def interact(page) -> None:
    """A short walk that produces real input events for INP."""
    steps = [
        ('a.nav-item[data-view="catalog"]', 2500),
        (".genre-pill >> nth=2", 2500),
        (".studio-tab >> nth=1", 2500),
        (".poster-grid .poster-card >> nth=0", 3000),
    ]
    for selector, pause in steps:
        try:
            closer = page.locator("[data-adfilter-close]")
            if closer.count() and closer.first.is_visible():
                closer.first.click(timeout=1500)
            page.locator(selector).first.click(timeout=4000)
        except Exception:  # noqa: BLE001
            continue
        page.wait_for_timeout(pause)
    try:
        field = page.locator('input[type="search"], .search input').first
        field.click(timeout=3000)
        field.type("матрица", delay=60)
        page.wait_for_timeout(1500)
    except Exception:  # noqa: BLE001
        pass


def measure_api(base: str, repeats: int) -> list[dict]:
    rows = []
    deep = 20 + int(time.time()) % 400
    for label, path in API_PROBES:
        url = base + path.format(deep=deep)
        times, size = [], 0
        for _ in range(repeats):
            started = time.monotonic()
            with urllib.request.urlopen(url, timeout=120) as response:
                size = len(response.read())
            times.append((time.monotonic() - started) * 1000)
        rows.append({"label": label, "path": path.format(deep=deep), "first_ms": times[0], "repeat_ms": statistics.median(times[1:]) if len(times) > 1 else times[0], "bytes": size})
    return rows


def median(rows: list[dict], key: str):
    values = [row[key] for row in rows if row.get(key) is not None]
    return statistics.median(values) if values else None


def fmt(value, unit: str = "", digits: int = 0) -> str:
    if value is None:
        return "нет данных"
    return f"{value:.{digits}f}{unit}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://127.0.0.1:8090")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--profiles", default="desktop,phone")
    parser.add_argument("--network", default="none", choices=sorted(NETWORKS))
    parser.add_argument("--cpu", type=float, default=1, help="CPU slowdown, 4 is a mid-range phone")
    parser.add_argument("--api-repeats", type=int, default=4)
    parser.add_argument("--json", default="")
    args = parser.parse_args()
    base = args.base.rstrip("/")

    report: dict = {"base": base, "network": args.network, "cpu": args.cpu, "pages": {}, "api": []}
    with sync_playwright() as playwright:
        browser = launch(playwright)
        for profile in [name.strip() for name in args.profiles.split(",") if name.strip()]:
            runs = [measure_page(browser, base, profile, args.network, args.cpu) for _ in range(args.runs)]
            report["pages"][profile] = runs
            last = runs[-1]
            print(f"\n== {profile}, сеть {args.network}, CPU x{args.cpu:g}, медиана из {len(runs)} ==")
            print(f"TTFB {fmt(median(runs, 'ttfb_ms'), ' мс')} | FCP {fmt(median(runs, 'fcp_ms'), ' мс')} | LCP {fmt(median(runs, 'lcp_ms'), ' мс')} | CLS при загрузке {fmt(median(runs, 'cls_load'), '', 3)} | CLS с действиями {fmt(median(runs, 'cls_total'), '', 3)} | INP {fmt(median(runs, 'inp_ms'), ' мс')}")
            print(f"LCP-элемент: {last['lcp_node']} {last['lcp_url'][:90]}")
            print(f"Первый экран: {fmt(median(runs, 'requests'))} запросов, {fmt(median(runs, 'bytes') / 1024, ' КБ')}, сеть затихла через {fmt(median(runs, 'settled_s'), ' с', 1)}")
            for kind, group in last["groups"].items():
                print(f"  {kind}: {group['requests']} шт., {group['bytes'] / 1024:.0f} КБ")
            print("  самые тяжёлые: " + "; ".join(f"{item['url'].split('/')[-1][:40] or item['url']} {item['bytes'] / 1024:.0f} КБ" for item in last["heaviest"]))
            for shift in last["worst_shifts"]:
                print(f"  сдвиг {shift['value']:.3f} на {shift['time']:.0f} мс: {shift['node']}")
        browser.close()

    print(f"\n== API через {base}, первый запрос и медиана повторов ==")
    report["api"] = measure_api(base, args.api_repeats)
    for row in report["api"]:
        print(f"{row['first_ms']:7.0f} мс  {row['repeat_ms']:7.0f} мс  {row['bytes'] / 1024:6.0f} КБ  {row['label']}")

    if args.json:
        target = Path(args.json)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nJSON: {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
