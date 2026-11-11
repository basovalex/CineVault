const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'sw.js'), 'utf8');

function worker({ fetchImpl, saved = {} }) {
  const listeners = {};
  const store = new Map(Object.entries(saved));
  const cache = {
    match: async (key) => store.get(key),
    put: async (key, value) => { store.set(key, value); },
    keys: async () => [...store.keys()],
    delete: async (key) => store.delete(key),
  };
  const context = {
    URL, Promise, Map, Set, Math, setTimeout: (fn) => setTimeout(fn, 5),
    Response: { error: () => 'network-error' },
    fetch: fetchImpl,
    caches: { open: async () => cache, match: async (key) => store.get(key), keys: async () => [] },
    self: { location: { origin: 'https://cv.test' }, addEventListener: (name, fn) => { listeners[name] = fn; }, skipWaiting() {}, clients: { claim() {} } },
  };
  vm.runInNewContext(source, context);
  return {
    store,
    send(url, init = {}) {
      let responded;
      const pending = [];
      listeners.fetch({
        request: { url: `https://cv.test${url}`, method: 'GET', mode: 'cors', ...init },
        respondWith: (value) => { responded = value; },
        waitUntil: (value) => pending.push(value),
      });
      return { responded, settled: () => Promise.all(pending) };
    },
  };
}

const ok = (body) => ({ ok: true, body, clone: () => ok(body) });
const never = () => new Promise(() => {});

test('a stalled page load falls back to the saved page', async () => {
  const sw = worker({ fetchImpl: never, saved: { '/index.html': 'saved-page' } });
  assert.equal(await sw.send('/', { mode: 'navigate' }).responded, 'saved-page');
});

test('a stalled versioned script finds the copy saved without its version', async () => {
  const sw = worker({ fetchImpl: never, saved: { '/app.js': 'saved-js' } });
  assert.equal(await sw.send('/app.js?v=new').responded, 'saved-js');
});

test('a failed script load never receives the page as a substitute', async () => {
  const sw = worker({ fetchImpl: () => Promise.reject(new Error('offline')), saved: { '/index.html': 'saved-page' } });
  assert.equal(await sw.send('/app.js?v=new').responded, 'network-error');
});

test('a stalled catalog request answers from the last saved copy', async () => {
  const url = '/api/catalog?page=1&limit=48';
  const sw = worker({ fetchImpl: never, saved: { [url]: 'saved-catalog' } });
  assert.equal(await sw.send(url).responded, 'saved-catalog');
});

test('a slow catalog request with nothing saved still waits for the network', async () => {
  let finish;
  const sw = worker({ fetchImpl: () => new Promise((resolve) => { finish = resolve; }) });
  const { responded } = sw.send('/api/catalog?page=1&limit=48');
  setTimeout(() => finish(ok('late-catalog')), 30);
  assert.equal((await responded).body, 'late-catalog');
});

test('a successful catalog response is saved for next time', async () => {
  const url = '/api/catalog?page=1&limit=48';
  const sw = worker({ fetchImpl: async () => ok('fresh') });
  const call = sw.send(url);
  assert.equal((await call.responded).body, 'fresh');
  await call.settled();
  assert.equal(sw.store.get(url).body, 'fresh');
});

test('search results and personal id lists are not saved', async () => {
  for (const url of ['/api/catalog?search=abc', '/api/catalog?ids=1,2']) {
    const sw = worker({ fetchImpl: async () => ok('fresh') });
    const call = sw.send(url);
    await call.responded;
    await call.settled();
    assert.equal(sw.store.size, 0, url);
  }
});
