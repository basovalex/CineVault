const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app/app.js', 'utf8');
const start = source.indexOf('  function upcomingPremiere(');
const end = source.indexOf('\n  function ', start + 12);
assert.ok(start >= 0 && end > start);
const context = { Date, Intl, Number, String };
vm.runInNewContext(`${source.slice(start, end)}; this.upcomingPremiere = upcomingPremiere;`, context);

test('дата премьеры показывается без сдвига суток; прошедшая и неверная не объявляются будущими', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  assert.match(context.upcomingPremiere({ premiere: '2026-11-05', premiereRegion: 'мир' }, now), /5 ноября 2026 г\. · мир/);
  assert.equal(context.upcomingPremiere({ premiere: '2026-11-04' }, now), '');
  assert.equal(context.upcomingPremiere({ premiere: '2026-02-30', year: 2027 }, now), '');
  assert.equal(context.upcomingPremiere({ year: 2027 }, now), 'Ожидается в 2027 году');
  assert.match(context.upcomingPremiere({ premiere: '2026-12' }, now), /декабрь 2026/);
  assert.equal(context.upcomingPremiere({ premiere: '2027' }, now), 'Ожидается в 2027 году');
});
