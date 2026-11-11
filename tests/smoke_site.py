#!/usr/bin/env python3
"""Дымовой прогон сайта в настоящем браузере.

Проходит главные сценарии на нескольких ширинах экрана и падает, если на любом
шаге есть ошибка в консоли, упавший запрос к своему API, горизонтальная
прокрутка или пустой экран. Скриншот каждого шага сохраняется в --out.

    python3 tests/smoke_site.py --base http://127.0.0.1:8090
    python3 tests/smoke_site.py --fault tmdb      # image.tmdb.org недоступен
    python3 tests/smoke_site.py --fault player    # чужие плееры недоступны
    python3 tests/smoke_site.py --fault fonts     # шрифты не загрузились
    python3 tests/smoke_site.py --fault slow      # медленная сеть
    python3 tests/smoke_site.py --fault offline   # сеть пропала после загрузки

Нужен playwright (pip install playwright==1.48.0, браузер chromium).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FAULTS = ("none", "tmdb", "player", "fonts", "slow", "offline")
BLOCKED_HOSTS = {
    "tmdb": re.compile(r"(^|\.)(image\.tmdb\.org|themoviedb\.org)$"),
    "fonts": re.compile(r"(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$"),
}
QUERY = "Менталист"
TITLE_PATH = "/title/kinopoisk-412344/"
EXPECTED_NOISE = re.compile(r"Failed to load resource|net::ERR_|ERR_INTERNET_DISCONNECTED|ERR_FAILED", re.I)
PAGE_STATE_JS = """() => {
  const root = document.querySelector('#page');
  const box = root ? root.getBoundingClientRect() : {height: 0};
  return {
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    text: root ? root.innerText.trim().length : 0,
    pictures: root ? root.querySelectorAll('img, [style*="background-image"]').length : 0,
    loader: Boolean(root && root.querySelector('.page-skeleton, .catalog-loading-shell')),
    height: Math.round(box.height),
    path: location.pathname,
  };
}"""
COVER_JS = """(selector) => {
  const node = [...document.querySelectorAll(selector)].find((entry) => entry.getBoundingClientRect().width);
  if (!node) return 'элемент не найден';
  const box = node.getBoundingClientRect();
  const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  if (!top || node.contains(top)) return 'ничем';
  const owner = top.closest('aside, section, nav, div[class]') || top;
  return owner.tagName.toLowerCase() + '.' + [...owner.classList].join('.');
}"""
WIDE_JS = """() => [...document.querySelectorAll('body *')].filter((node) => {
  const box = node.getBoundingClientRect();
  if (!box.width || box.right <= window.innerWidth + 1) return false;
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) return false;
  }
  return true;
}).slice(0, 5).map((node) => node.tagName.toLowerCase() + '.' + [...node.classList].join('.'))"""


class Run:
    def __init__(self, page, width: int, fault: str, out: Path, base: str, patience: float):
        self.page = page
        self.width = width
        self.fault = fault
        self.out = out
        self.base = base
        self.origin = urlsplit(base).netloc
        self.patience = patience
        self.step = "start"
        self.problems: list[dict] = []
        self.notes: list[dict] = []
        self.timings: list[dict] = []
        self.shots = 0
        page.on("console", self.on_console)
        page.on("pageerror", lambda error: self.problem("исключение в скрипте", str(error)[:300]))
        page.on("requestfailed", self.on_request_failed)
        page.on("response", self.on_response)

    def problem(self, kind: str, detail: str) -> None:
        entry = {"width": self.width, "step": self.step, "kind": kind, "detail": detail}
        if entry not in self.problems:
            self.problems.append(entry)

    def note(self, text: str) -> None:
        entry = {"width": self.width, "step": self.step, "note": text}
        if entry not in self.notes:
            self.notes.append(entry)

    def on_console(self, message) -> None:
        if message.type != "error":
            return
        text = message.text[:300]
        source = (message.location or {}).get("url", "")
        if EXPECTED_NOISE.search(text) and (self.fault != "none" or (source and not self.own(source))):
            return
        self.problem("ошибка в консоли", text)

    def own(self, url: str) -> bool:
        return urlsplit(url).netloc == self.origin

    def on_request_failed(self, request) -> None:
        failure = request.failure or ""
        if "ERR_ABORTED" in failure or not self.own(request.url):
            return
        if self.fault in {"offline", "slow"} and EXPECTED_NOISE.search(failure):
            return
        self.problem("запрос не дошёл", f"{urlsplit(request.url).path} {failure}")

    def on_response(self, response) -> None:
        if response.status >= 400 and self.own(response.url):
            self.problem("свой сервер ответил ошибкой", f"{response.status} {urlsplit(response.url).path}")

    def timeout(self, seconds: float) -> int:
        return int(seconds * self.patience * 1000)

    def wait(self, selector: str, seconds: float = 12, what: str = "") -> bool:
        try:
            self.page.wait_for_selector(selector, timeout=self.timeout(seconds), state="visible")
            return True
        except PlaywrightTimeout:
            self.problem("не дождался", f"{what or selector} за {seconds * self.patience:.0f} с")
            return False

    def shot(self) -> None:
        self.shots += 1
        name = f"{self.width}-{self.shots:02d}-{self.step}.png"
        try:
            self.page.screenshot(path=str(self.out / name))
        except PlaywrightError as error:
            self.problem("скриншот не снят", str(error)[:200])

    def verify(self, allow_empty: bool = False) -> dict:
        self.page.wait_for_timeout(600)
        try:
            state = self.page.evaluate(PAGE_STATE_JS)
        except PlaywrightError as error:
            self.problem("страница не отвечает", str(error)[:200])
            return {}
        if state["scrollWidth"] > state["innerWidth"] + 1:
            culprits = ", ".join(self.page.evaluate(WIDE_JS)) or "не найден"
            self.problem("горизонтальная прокрутка", f"{state['scrollWidth']} > {state['innerWidth']} px: {culprits}")
        if state["loader"]:
            self.problem("загрузчик не ушёл", "экран всё ещё показывает загрузку")
        if not allow_empty and state["text"] < 20 and not state["pictures"]:
            self.problem("пустой экран", f"в #page {state['text']} символов текста и нет картинок")
        return state

    def scene(self, name: str, action, allow_empty: bool = False) -> None:
        self.step = name
        started = time.monotonic()
        try:
            action()
        except PlaywrightTimeout as error:
            self.problem("шаг не выполнен", str(error).splitlines()[0][:240])
        except PlaywrightError as error:
            self.problem("шаг упал", str(error).splitlines()[0][:240])
        self.timings.append({"width": self.width, "step": name, "seconds": round(time.monotonic() - started, 2)})
        self.verify(allow_empty=allow_empty)
        self.shot()

    def open(self, path: str) -> None:
        self.page.goto(self.base + path, wait_until="domcontentloaded", timeout=self.timeout(30))

    def settle(self, seconds: float = 5) -> None:
        try:
            self.page.wait_for_load_state("networkidle", timeout=self.timeout(seconds))
        except PlaywrightTimeout:
            pass

    def nav(self, view: str) -> None:
        link = self.page.locator(f'a.nav-item[data-view="{view}"]:visible').first
        if not link.count():
            # On tablets and phones the bottom menu has four items; the rest sit in the section switch.
            link = self.page.locator(f'.section-switch a[data-view="{view}"]:visible').first
        if not link.count():
            self.note(f"{view}: нет в меню на ширине {self.width}, открываю по адресу")
            self.open({"home": "/"}.get(view, f"/{view}/"))
            return
        try:
            link.click(timeout=self.timeout(4))
        except PlaywrightTimeout:
            cover = self.page.evaluate(COVER_JS, f'a.nav-item[data-view="{view}"]')
            self.problem("пункт меню не нажимается", f"{view} перекрыт: {cover}")
            offer_close = self.page.locator("[data-adfilter-close]").first
            if offer_close.count():
                offer_close.click()
            link.click(timeout=self.timeout(4))


def home(run: Run) -> None:
    run.open("/")
    run.wait(".home-feature, .discovery-shelf", 20, "главная: рекомендация или подборки")
    run.wait(".discovery-shelf .poster-card", 20, "главная: постеры в подборках")
    run.settle()


def catalog(run: Run) -> None:
    run.nav("catalog")
    run.wait(".poster-grid .poster-card", 25, "каталог: первые карточки")


def catalog_tabs(run: Run) -> None:
    tabs = run.page.locator(".studio-tab:visible")
    for index in range(1, tabs.count()):
        tabs.nth(index).click()
        run.page.wait_for_timeout(400)
        if not run.wait(".poster-grid .poster-card", 25, f"каталог: вкладка «{tabs.nth(index).inner_text().strip()}»"):
            return
    tabs.first.click()
    run.wait(".poster-grid .poster-card", 25, "каталог: вкладка «Все»")


def catalog_genre(run: Run) -> None:
    pill = run.page.locator(".genre-pill:visible").nth(1)
    label = pill.inner_text().strip().replace("\n", " ")
    pill.click()
    run.page.wait_for_timeout(500)
    run.wait(".poster-grid .poster-card", 25, f"каталог: жанр «{label}»")


def catalog_scroll(run: Run) -> None:
    cards = run.page.locator(".poster-grid .poster-card")
    before = cards.count()
    for _ in range(6):
        run.page.mouse.wheel(0, 2400)
        run.page.wait_for_timeout(500)
    deadline = time.monotonic() + 15 * run.patience
    while cards.count() <= before and time.monotonic() < deadline:
        run.page.wait_for_timeout(300)
    if cards.count() <= before:
        run.problem("каталог не подгрузился", f"после прокрутки осталось {before} карточек")


def search(run: Run) -> None:
    run.page.evaluate("window.scrollTo(0, 0)")
    field = run.page.locator("#search")
    if not field.is_visible():
        run.problem("поиск не виден", f"поле поиска скрыто на ширине {run.width}")
        return
    grid = run.page.locator("#page")
    before = grid.inner_text()[:400]
    field.click()
    field.type(QUERY, delay=40)
    run.page.wait_for_timeout(900)
    if not run.page.locator("#search-suggestions:visible").count() and grid.inner_text()[:400] == before:
        run.note("поиск молчит, пока не нажат Enter: ни подсказок, ни результатов")
    field.press("Enter")
    run.page.wait_for_timeout(500)
    if not run.wait(".poster-grid .poster-card", 20, "поиск: результаты"):
        return
    first = run.page.locator(".poster-grid .poster-card").first
    if QUERY.lower() not in first.inner_text().lower():
        run.problem("поиск вернул не то", f"первая карточка: {first.inner_text().strip()[:60]!r}")
    run.shot()
    first.click()
    run.wait(".detail-shell h1", 15, "карточка тайтла после поиска")


def series_title(run: Run) -> None:
    if not run.page.locator(".detail-shell").count():
        run.open(TITLE_PATH)
        run.wait(".detail-shell h1", 20, "карточка тайтла по прямой ссылке")
    if not run.wait(".season-tabs [data-season]", 25, "сезоны сериала"):
        return
    seasons = run.page.locator(".season-tabs [data-season]")
    if seasons.count() > 1:
        seasons.nth(1).click()
        run.page.wait_for_timeout(600)
    run.wait(".episode-card:not(.episode-card-skeleton)", 25, "серии второго сезона")


def favorite(run: Run) -> None:
    button = run.page.locator(".detail-shell [data-favorite]").first
    button.scroll_into_view_if_needed()
    button.click()
    run.page.wait_for_timeout(400)
    run.nav("favorites")
    run.wait("#page .poster-card", 15, "избранное: добавленный тайтл")


def player(run: Run) -> None:
    run.open(TITLE_PATH)
    if not run.wait(".hero-actions [data-play-media]", 30, "кнопка «Смотреть»"):
        return
    run.page.locator(".hero-actions [data-play-media]").first.click()
    if not run.wait(".player-choice-modal [data-player-choice], .player-modal, .player-choice-empty", 30, "выбор плеера"):
        return
    run.shot()
    choice = run.page.locator(".player-choice-modal [data-player-choice]").first
    if choice.count():
        choice.click()
    if run.wait(".player-modal, #modal-root .modal", 30, "окно плеера"):
        run.page.wait_for_timeout(int(4000 * run.patience))
        run.shot()
        close = run.page.locator('#modal-root .modal-head button[aria-label="Закрыть"]').first
        if close.count():
            close.click()
            run.page.wait_for_timeout(600)
        if run.page.locator("#modal-root .modal").count():
            run.problem("плеер не закрылся", "окно осталось после кнопки «Закрыть»")
        run.wait(".detail-shell h1", 10, "возврат на карточку после плеера")


def section(view: str, selector: str, what: str, seconds: float = 30):
    def action(run: Run) -> None:
        run.nav(view)
        run.wait(selector, seconds, what)
    return action


def offline_flow(run: Run, context) -> None:
    run.scene("offline-warmup", lambda: (home(run), run.page.evaluate("navigator.serviceWorker.ready.then(() => true)"), catalog(run)))
    context.set_offline(True)
    run.scene("offline-reload", lambda: (run.page.reload(wait_until="domcontentloaded", timeout=run.timeout(20)), run.page.wait_for_timeout(4000)))
    run.scene("offline-catalog", lambda: (run.nav("catalog"), run.page.wait_for_timeout(4000)))
    run.scene("offline-title", lambda: (run.page.locator("#page .poster-card").first.click(timeout=run.timeout(5)), run.page.wait_for_timeout(3000)))
    context.set_offline(False)
    run.scene("back-online", lambda: (run.nav("catalog"), run.wait(".poster-grid .poster-card", 30, "каталог после возврата сети")))


def full_flow(run: Run, with_player: bool) -> None:
    run.scene("home", lambda: home(run))
    run.scene("catalog", lambda: catalog(run))
    run.scene("catalog-tabs", lambda: catalog_tabs(run))
    run.scene("catalog-genre", lambda: catalog_genre(run))
    run.scene("catalog-scroll", lambda: catalog_scroll(run))
    run.scene("search", lambda: search(run))
    run.scene("series", lambda: series_title(run))
    run.scene("favorite", lambda: favorite(run))
    run.scene("upcoming", lambda: section("upcoming", "#page .poster-card", "«Скоро»: карточки")(run))
    run.scene("movies", lambda: section("movies", "#page .poster-card", "«Фильмы»: карточки")(run))
    run.scene("series-list", lambda: section("series", "#page .poster-card", "«Сериалы»: карточки")(run))
    run.scene("history", lambda: section("history", "#page .empty-state, #page .poster-card, #page .history-card", "история")(run))
    run.scene("settings", lambda: section("settings", "#page .settings-section", "настройки")(run))
    if with_player:
        run.scene("player", lambda: player(run))


def route_faults(context, fault: str, origin: str) -> None:
    if fault in BLOCKED_HOSTS:
        pattern = BLOCKED_HOSTS[fault]
        context.route("**/*", lambda route: route.abort() if pattern.search(urlsplit(route.request.url).hostname or "") else route.continue_())
    elif fault == "player":
        def handle(route) -> None:
            request = route.request
            inside_frame = request.frame.parent_frame is not None
            foreign_document = request.resource_type == "document" and urlsplit(request.url).netloc != origin
            route.abort() if inside_frame or foreign_document else route.continue_()
        context.route("**/*", handle)


def run_width(browser, width: int, args, out: Path) -> Run:
    height = {375: 812, 768: 1024}.get(width, 900)
    context = browser.new_context(
        viewport={"width": width, "height": height},
        service_workers="allow" if args.fault == "offline" else "block",
        is_mobile=width < 500,
        has_touch=width < 500,
        locale="ru-RU",
    )
    route_faults(context, args.fault, urlsplit(args.base).netloc)
    page = context.new_page()
    patience = 3.0 if args.fault == "slow" else 1.0
    if args.fault == "slow":
        session = context.new_cdp_session(page)
        session.send("Network.enable")
        session.send("Network.emulateNetworkConditions", {"offline": False, "latency": 300, "downloadThroughput": 190_000, "uploadThroughput": 90_000})
    run = Run(page, width, args.fault, out, args.base.rstrip("/"), patience)
    if args.fault == "offline":
        offline_flow(run, context)
    else:
        full_flow(run, with_player=args.player == "all" or (args.player == "widest" and width == max(args.widths)))
    context.close()
    return run


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://127.0.0.1:8090")
    parser.add_argument("--widths", default="375,768,1440", type=lambda value: [int(part) for part in value.split(",") if part])
    parser.add_argument("--fault", default="none", choices=FAULTS)
    parser.add_argument("--player", default="widest", choices=("none", "widest", "all"), help="На каких ширинах открывать плеер: у чужих плееров есть лимит запросов")
    parser.add_argument("--out", default="")
    args = parser.parse_args()
    out = Path(args.out) if args.out else ROOT / "output" / "site-smoke" / args.fault
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*.png"):
        stale.unlink()
    problems: list[dict] = []
    notes: list[dict] = []
    timings: list[dict] = []
    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch(channel="chrome")
        except PlaywrightError:
            print("Google Chrome не найден: беру встроенный Chromium, в нём нет кодеков H.264 и плеер покажет ошибку", flush=True)
            browser = playwright.chromium.launch()
        for width in args.widths:
            run = run_width(browser, width, args, out)
            problems += run.problems
            notes += run.notes
            timings += run.timings
            print(f"{width} px: шагов {len(run.timings)}, проблем {len(run.problems)}", flush=True)
        browser.close()
    (out / "result.json").write_text(json.dumps({"fault": args.fault, "base": args.base, "problems": problems, "notes": notes, "timings": timings}, ensure_ascii=False, indent=2), encoding="utf-8")
    for entry in problems:
        print(f"  [{entry['width']}] {entry['step']}: {entry['kind']} — {entry['detail']}")
    for entry in notes:
        print(f"  заметка [{entry['width']}] {entry['step']}: {entry['note']}")
    print(f"{'ПРОВАЛ' if problems else 'ОК'}: {len(problems)} проблем, скриншоты в {out}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
