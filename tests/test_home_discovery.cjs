const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const source = fs.readFileSync('app/app.js', 'utf8');
function functions(from, to, context) {
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf(`  function ${from}`), source.indexOf(to, source.indexOf(`  function ${from}`))), context);
  return context;
}
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
test('widely watched feature outranks obscure high-rated short in audience score', () => {
  const context = functions('audienceScore(item)', '  function isCredibleRecommendation', {});
  assert.ok(context.audienceScore({kind: 'movie', runtime: 140, voteCount: 2000000}) > context.audienceScore({kind: 'movie', runtime: 10, voteCount: 1000}));
});
