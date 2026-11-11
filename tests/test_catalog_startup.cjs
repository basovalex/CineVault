const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('первая страница не ждёт медленные дополнительные подборки', async () => {
  const source = fs.readFileSync('app/app.js', 'utf8');
  const start = source.indexOf('  async function loadImportedCatalog()');
  const end = source.indexOf('\n  async function loadAudienceCatalog()', start);
  assert.ok(start >= 0 && end > start);
  let finishPage;
  const page = new Promise((resolve) => { finishPage = resolve; });
  const slow = new Promise(() => {});
  const context = {
    state: { catalogPage: 1 }, initialCatalogReady: false,
    window: { setTimeout: (callback) => setTimeout(callback, 0) },
    loadRemoteCatalogPage: () => page,
    loadRemoteCatalogFacets: () => slow, loadRemoteDiscoveryCatalog: () => slow,
    loadRemoteFreshCatalog: () => slow, loadTrendingCatalog: () => slow,
    loadAudienceCatalog: () => slow, loadUpcomingCatalog: () => slow,
  };
  vm.runInNewContext(`${source.slice(start, end)}; this.loadImportedCatalog = loadImportedCatalog;`, context);
  const result = context.loadImportedCatalog();
  finishPage();
  assert.equal(await Promise.race([result.then(() => 'ready'), new Promise((resolve) => setTimeout(() => resolve('timeout'), 100))]), 'ready');
});
