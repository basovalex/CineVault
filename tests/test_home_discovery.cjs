const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const source = fs.readFileSync('app/app.js', 'utf8');
const indexSource = fs.readFileSync('app/index.html', 'utf8');
function functions(from, to, context) {
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf(`  function ${from}`), source.indexOf(to, source.indexOf(`  function ${from}`))), context);
  return context;
}
test('initial page shell shows a logo and loader before app.js renders', () => {
  assert.match(indexSource, /id="page"[^>]*><div class="app-startup" role="status"/);
  assert.match(indexSource, /class="brand-mark" aria-hidden="true"><\/span><span class="loading-spinner"/);
});
test('mood replaces only its results; preserves button focus and other rails', () => {
  let saves = 0, renders = 0, opened = 0;
  const buttons = ['уютно', 'романтично', 'смеяться'].map(mood => ({dataset: {mood}, classList: {toggle(_, active) {this.active = active;}}, setAttribute(_, value) {this.pressed = value;}}));
  const results = {innerHTML: ''}, link = {addEventListener(_, handler) {this.click = handler;}};
  const context = functions('homeMoodMarkup()', '  const catalogGenreAliases', {
    state: {view: 'home', mood: 'уютно'}, moodDefinitions: {уютно: {}, романтично: {}, смеяться: {}},
    saveState() {saves++;}, render() {renders++;}, hydrateLazyPosters() {},
    openCatalogCollection(id) {assert.equal(id, 'mood'); opened++;},
    moodDefinition() {return {title: this.state?.mood, description: ''};},
    collectionItems() {return [];}, discoveryShelf() {return 'updated mood';},
    $(selector) {return selector === '#home-mood-results' ? results : link;}, $$() {return buttons;}
  });
  context.selectMood('романтично');
  assert.equal(results.innerHTML, 'updated mood');
  assert.equal(buttons[1].pressed, 'true');
  assert.equal(buttons[0].pressed, 'false');
  assert.equal(renders, 0); assert.equal(saves, 1);
  link.click(); assert.equal(opened, 1);
  context.selectMood('романтично'); assert.equal(saves, 1);
  context.selectMood('смеяться'); assert.equal(saves, 2); assert.equal(renders, 0);
});
test('episode button carries its season to the player', () => {
  const context = functions('episodePosterMarkup(item, season, episode, title, episodePlayable)', '  function renderSeasons', {escapeHtml: String, uiIcon: () => '<svg></svg>'});
  for (const playable of [true, false]) {
    const markup = context.episodePosterMarkup({id: 'kinopoisk-449993', poster: 'none'}, 2, 1, 'Серия 1', playable);
    assert.match(markup, /data-resume-season="2"/);
    assert.match(markup, /data-episode="1"/);
  }
});
test('next catalog page waits for scrolling and never cancels a filter that is loading', () => {
  const button = {dataset: {catalogPage: '2'}, classList: {add() {}}};
  const calls = [];
  const context = functions('loadMoreCatalog(button)', '  let catalogAutoMoreObserver', {
    catalogPaging: false, remoteCatalogLoading: true, loadedCatalogKey: 'a',
    catalogListKey() {return 'a';}, remoteCatalog: {page: 1},
    loadRemoteCatalogPage(page) {calls.push(page); return new Promise(() => {});},
  });
  context.loadMoreCatalog(button);
  assert.deepEqual(calls, []);
  vm.runInContext('remoteCatalogLoading = false; loadedCatalogKey = "old";', context);
  context.loadMoreCatalog(button);
  assert.deepEqual(calls, []);
  vm.runInContext('loadedCatalogKey = "a";', context);
  context.loadMoreCatalog(button);
  assert.deepEqual(calls, [2]);
  const shown = functions('catalogCardsAllShown()', '  function recheckCatalogAutoMore', {progressiveCatalogNext: 16, progressiveCatalogItems: new Array(50)});
  assert.equal(shown.catalogCardsAllShown(), false);
  vm.runInContext('progressiveCatalogNext = 50;', shown);
  assert.equal(shown.catalogCardsAllShown(), true);
});
test('seasons come from the catalog counts', () => {
  const context = functions('hasOwnEpisodeSources(item)', '  function lampacOrigin', {});
  assert.deepEqual(JSON.parse(JSON.stringify(context.titleSeasonList({kinopoiskId: 7, seasons: [2]}))), [{number: 1, episodes: [1, 2]}]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.titleSeasonList({seasons: [1, 3]}))), [{number: 1, episodes: [1]}, {number: 2, episodes: [1, 2, 3]}]);
});
test('last year collection opens newest first and leaving it restores the default order', () => {
  const {sortForCatalogCollection} = functions('sortForCatalogCollection(collectionId, currentSort)', '  function openCatalogCollection', {});
  assert.equal(sortForCatalogCollection('new', 'audience'), 'year');
  assert.equal(sortForCatalogCollection('', 'year'), 'now');
  assert.equal(sortForCatalogCollection('audience', 'rating'), 'rating');
});
test('TMDB shelf links open a standalone collection page', () => {
  const rows = new Map();
  const context = functions('tmdbHomeRowMarkup(row)', '  function tmdbCollectionRow', {
    escapeHtml: String, uiIcon: () => '<svg></svg>', poster: item => `<a>${item.title}</a>`,
    tmdbRenderedRows: rows, tmdbWideRowMarkup: () => '',
  });
  const markup = context.tmdbHomeRowMarkup({key: 'popular-movies', title: 'Популярные фильмы', description: '', items: [{title: 'Пример'}]});
  assert.match(markup, /data-open-tmdb-collection="popular-movies"/);
  assert.equal(rows.get('popular-movies').items[0].title, 'Пример');
});
test('standalone collection route keeps its shelf key in the address', () => {
  const context = functions('routeForCollection(id)', '  function readRouteFromLocation', {});
  assert.equal(context.routeForCollection('popular-movies'), '/collection/popular-movies/');
  assert.equal(context.routeForCollection('genre 0'), '/collection/genre%200/');
});
test('detail taglines lose only their surrounding quotation marks', () => {
  const context = functions('cleanTagline(value)', '  function detailAge', {});
  assert.equal(context.cleanTagline('«Бросьте вызов богам»'), 'Бросьте вызов богам');
  assert.equal(context.cleanTagline('“Truth is closer”'), 'Truth is closer');
  assert.equal(context.cleanTagline('Короткий слоган'), 'Короткий слоган');
});
test('Lampac sources keep their live order until three starts, then fastest first', () => {
  const context = functions('rankLampacSources(sources, stats = lampacSourceStats())', '  // A source either answers', {});
  const sources = [{id: 'slow'}, {id: 'fast'}, {id: 'new'}];
  const once = context.rankLampacSources(sources, {fast: {samples: 2, averageMs: 500}, slow: {samples: 3, averageMs: 4000}});
  assert.deepEqual(Array.from(once, source => source.id), ['slow', 'fast', 'new']);
  const established = context.rankLampacSources(sources, {fast: {samples: 3, averageMs: 500}, slow: {samples: 3, averageMs: 4000}});
  assert.deepEqual(Array.from(established, source => source.id), ['fast', 'slow', 'new']);
});
test('home collection loader appears only while a genre shelf is being fetched', () => {
  const spinner = {hidden: true};
  const sentinel = {classes: new Set(), classList: {toggle(name, on) { on ? this.owner.classes.add(name) : this.owner.classes.delete(name); }}, querySelector() { return spinner; }, classes: new Set()};
  sentinel.classList.owner = sentinel;
  const context = functions('setHomeMoreLoading(sentinel, loading)', '  async function loadNextTmdbGenreRow', {});
  context.setHomeMoreLoading(sentinel, true);
  assert.equal(spinner.hidden, false);
  assert.equal(sentinel.classes.has('is-loading'), true);
  context.setHomeMoreLoading(sentinel, false);
  assert.equal(spinner.hidden, true);
  assert.equal(sentinel.classes.has('is-loading'), false);
});
test('widely watched feature outranks obscure high-rated short in audience score', () => {
  const context = functions('audienceScore(item)', '  function isCredibleRecommendation', {});
  assert.ok(context.audienceScore({kind: 'movie', runtime: 140, voteCount: 2000000}) > context.audienceScore({kind: 'movie', runtime: 10, voteCount: 1000}));
});
test('personal recommendations alternate with popular titles and never duplicate a film', () => {
  const context = functions('mixPersonalAndPopularRecs(personal, popular, limit = 40)', '  function loadPersonalRecs', {});
  const mixed = context.mixPersonalAndPopularRecs(
    [{id: 'dexter-related'}, {id: 'history-related'}, {id: 'also-related'}],
    [{id: 'popular-1'}, {id: 'history-related'}, {id: 'popular-2'}],
    5,
  );
  assert.deepEqual(Array.from(mixed, item => item.id), ['dexter-related', 'popular-1', 'history-related', 'popular-2', 'also-related']);
});
test('wide Now Watching rails get centered desktop arrows that scroll by one view', () => {
  const rail = {
    dataset: {}, classList: {contains(name) { return name === 'wide-rail'; }},
    clientWidth: 100, scrollWidth: 250, scrollLeft: 0,
    replaceWith(node) { this.wrapper = node; },
    addEventListener(name, handler) { if (name === 'scroll') this.update = handler; },
    scrollBy(options) { this.scrollOptions = options; },
  };
  const context = functions('enhanceRails()', '  new MutationObserver', {
    railArrowsWanted: {matches: true},
    page: {querySelectorAll() { return [rail]; }},
    window: {requestAnimationFrame(callback) { callback(); }},
    document: {createElement() { return {dataset: {}, classList: {add() {}}, setAttribute() {}, addEventListener(name, handler) { if (name === 'click') this.click = handler; }, append(...nodes) { this.nodes = [...(this.nodes || []), ...nodes]; }}; }},
  });
  context.enhanceRails();
  const wrapper = rail.wrapper;
  const [previous, next] = wrapper.nodes.filter(node => node.type === 'button');
  assert.equal(wrapper.className, 'rail-wrap rail-wrap-wide');
  assert.equal(previous.hidden, true);
  assert.equal(next.hidden, false);
  next.click();
  assert.equal(rail.scrollOptions.left, 85);
  assert.equal(rail.scrollOptions.behavior, 'smooth');
});
test('poster preview uses a 700ms hover delay', () => {
  assert.match(source, /const POSTER_PREVIEW_DELAY_MS = 700;/);
  assert.match(source, /\}, POSTER_PREVIEW_DELAY_MS\);/);
});
test('recent shelves rotate daily, stay stable during the day and diversify countries', () => {
  const context = functions('rotatingFreshItems(items, limit = 12, day = Math.floor((Date.now() + 5 * 3600000) / 86400000), poolSize = 40)', '  function personalCollectionItems', {});
  const items = Array.from({length: 40}, (_, i) => ({id: String(i), countries: [i < 20 ? 'Россия' : 'США']}));
  const a = context.rotatingFreshItems(items, 12, 100);
  const b = context.rotatingFreshItems(items, 12, 101);
  assert.deepEqual(Array.from(a, x => x.id), Array.from(context.rotatingFreshItems(items, 12, 100), x => x.id));
  assert.notDeepEqual(Array.from(a, x => x.id), Array.from(b, x => x.id));
  assert.equal(new Set(a.map(x => x.id)).size, 12);
});
test('world trending resolves TMDB order to matching catalog films and series', async () => {
  const start = source.indexOf('  async function loadWorldTrendingCatalog()');
  const end = source.indexOf('  async function loadRemoteDiscoveryCatalog()', start);
  const records = Array.from({length: 12}, (_, i) => ({id: i + 1, media_type: i % 2 ? 'tv' : 'movie'}));
  const cards = records.map(r => ({id: `cv-${r.id}`, tmdbId: r.id, kind: r.media_type === 'tv' ? 'series' : 'movie', posterImage: 'poster'})).reverse();
  const context = {tmdbCredential: 'test-key', TMDB_API_BASE: 'https://example.test', URL, URLSearchParams, AbortController,
    ensureWorldTrending: async () => false, window: {setTimeout, clearTimeout}, fetch: async (url) => ({ok: true, json: async () => ({results: url.searchParams.get('page') === '1' ? records : []})}),
    apiFetch: async (url) => { assert.ok(url.includes('tmdb_ids=')); return {ok: true, json: async () => ({items: cards})}; }};
  vm.createContext(context);
  vm.runInContext('var worldTrendingCatalog = [];\n' + source.slice(start, end), context);
  await context.loadWorldTrendingCatalog();
  assert.deepEqual(Array.from(context.worldTrendingCatalog, item => item.id), records.map(r => `cv-${r.id}`));
});
test('episode progress is read from every player, newest first', () => {
  const now = Date.now();
  const id = 'kinopoisk-1';
  const context = functions('episodeProgressEntries(item)', '  function progressForTitle', {state: {progress: {
    [`${id}-s1e1`]: {titleId: id, seasonNumber: 1, episodeNumber: 1, updatedAt: now - 3000},
    [`${id}-s1e11`]: {titleId: id, updatedAt: now - 2000, completed: true},
    [`${id}-alt`]: {titleId: id, seasonNumber: 2, episodeNumber: 7, updatedAt: now},
    [`${id}-embed`]: {titleId: id, untracked: true, updatedAt: now + 1},
    'kinopoisk-2-alt': {titleId: 'kinopoisk-2', seasonNumber: 3, episodeNumber: 1, updatedAt: now + 2},
  }}});
  const entries = context.episodeProgressEntries({id});
  assert.equal(entries.map(({season, episode}) => `${season}x${episode}`).join(' '), '2x7 1x11 1x1');
});
