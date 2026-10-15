// tcgexchange.kr: Korean card provider (bundled catalog).
//
// Verifies:
//   1. pokemonProvider routes 'ko' to tcgexchange, every other language unchanged.
//   2. tcgexchangeApi.listSets returns the bundled Korean sets with card counts.
//   3. tcgexchangeApi.getCardsBySet returns cards with image_url, normalized shape.
//   4. cardApi dispatches tcgexchange-kr- ids to tcgexchangeApi.
//   5. printingInLanguage returns null for tcgexchange ids (no cross-provider swap).
//   6. findPrinting resolves a Korean printing by English name + number.
//
// Offline: reads shared/pokemonKoreaCatalog.json. Falls back to the live API only
// if the bundle is missing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.DB_PATH = require('path').join(
  require('os').tmpdir(), `bindarr-tcgexchange-${process.pid}.db`
);

(async () => {
  // 1. Provider routing.
  const provider = require('../src/utils/pokemonProvider');
  assert.strictEqual(provider.decide('tcgdex', 'ko'), provider.TCGEXCHANGE,
    'Korean must route to tcgexchange regardless of the provider setting');
  assert.strictEqual(provider.decide('pokemontcg', 'ko'), provider.TCGEXCHANGE,
    'Korean must route to tcgexchange even with pokemontcg.io configured');
  assert.strictEqual(provider.decide('pokemontcgapi', 'ko'), provider.TCGEXCHANGE,
    'Korean must route to tcgexchange even with pokemontcgapi configured');
  assert.strictEqual(provider.decide('tcgdex', 'en'), provider.TCGDEX,
    'English must still route to TCGdex');
  assert.strictEqual(provider.decide('tcgdex', 'ja'), provider.TCGDEX,
    'Japanese must still route to TCGdex');
  assert.strictEqual(provider.decide('pokemontcgapi', 'ja'), provider.POKEMONTCGAPI,
    'Japanese + pokemontcgapi setting must still route to pokemontcgapi');
  console.log('PASS: provider routing (ko -> tcgexchange, others unchanged)');

  // 2. apiFor returns the tcgexchange module for Korean.
  const api = await provider.apiFor('ko');
  assert.strictEqual(typeof api.listSets, 'function');
  assert.strictEqual(typeof api.getCardsBySet, 'function');
  assert.strictEqual(typeof api.searchCards, 'function');
  assert.strictEqual(typeof api.getCardById, 'function');
  console.log('PASS: apiFor(ko) returns tcgexchangeApi');

  // 3. cardApi id dispatch.
  const cardApi = require('../src/utils/cardApi');
  assert.ok(cardApi.isTcgexchangeId('tcgexchange-kr-SV4K-001'), 'isTcgexchangeId recognizes the prefix');
  assert.ok(!cardApi.isTcgexchangeId('tcgdex-ko-SV4K-001'), 'isTcgexchangeId rejects TCGdex ids');
  assert.ok(!cardApi.isTcgexchangeId('mtg-abc'), 'isTcgexchangeId rejects MTG ids');
  console.log('PASS: cardApi id dispatch (isTcgexchangeId)');

  // Init the temp DB so card_cache exists for the cache-miss fetch below.
  const db = require('../src/db');
  await db.initDb();
  console.log('PASS: initDb (temp card_cache ready)');

  // 4. printingInLanguage returns null for tcgexchange ids (never asks TCGdex to
  //    swap a tcgexchange id; the early return at the top handles same-language).
  const tcgex = require('../src/tcgexchangeApi');
  // The catalog is bundled with the app — Korean support must not need a download.
  assert.ok(fs.existsSync(tcgex.BUNDLE_PATH), 'shared/pokemonKoreaCatalog.json must be present');
  console.log('PASS: bundled Korean catalog present');
  const nullResult = await cardApi.printingInLanguage(
    { id: 'tcgexchange-kr-SV4K-001', language: 'Korean', set_id: 'SV4K', number: '001', name: 'Pansage' },
    'English'
  ).catch(e => { throw e; });
  assert.strictEqual(nullResult, null,
    'printingInLanguage must return null for a tcgexchange id asked into another language');
  console.log('PASS: printingInLanguage returns null for tcgexchange ids');

  // 5. Live API checks — skip gracefully if the network is unavailable.
  let sets;
  try {
    sets = await tcgex.listSets('ko');
  } catch (e) {
    console.log(`SKIP: tcgexchange.kr unreachable (${e.message}) — live checks skipped`);
    console.log('tcgexchange.test.js: all offline assertions passed');
    return;
  }

  assert.ok(Array.isArray(sets) && sets.length >= 100,
    `listSets should return ≥100 Korean sets, got ${sets.length}`);
  assert.ok(sets.every(s => s.id && typeof s.total === 'number'),
    'every set must carry an id and a numeric total');
  console.log(`PASS: listSets returned ${sets.length} Korean sets`);

  // Find a set known to have cards (SV4K was verified earlier: 95 cards).
  const sv4k = sets.find(s => s.id === 'SV4K');
  assert.ok(sv4k, 'SV4K (Ancient Roar) must be in the Korean set list');
  assert.strictEqual(sv4k.total, 95, 'SV4K should list 95 cards');

  const cards = await tcgex.getCardsBySet('SV4K', 'ko');
  assert.ok(Array.isArray(cards) && cards.length === 95,
    `SV4K should return 95 cards, got ${cards.length}`);
  const first = cards[0];
  assert.ok(first.id.startsWith('tcgexchange-kr-SV4K-'), `id must carry the prefix, got ${first.id}`);
  assert.strictEqual(first.language, 'Korean', 'language must be the display name');
  assert.strictEqual(first.game, 'pokemon');
  assert.ok(first.image_url && first.image_url.startsWith('https://'),
    `image_url must be a real URL, got ${first.image_url}`);
  assert.ok(first.name && first.printed_name, 'both English and Korean names must be present');
  assert.ok(first.number, 'number must be present');
  console.log(`PASS: getCardsBySet(SV4K) returned ${cards.length} cards with images`);

  // getCardById: cache-miss path fetches from the API. The test DB is empty, so
  // initDb must run first to create card_cache — do that up-front instead.
  const fetched = await tcgex.getCardById(first.id);
  assert.ok(fetched, 'getCardById must resolve a live card');
  assert.strictEqual(fetched.id, first.id, 'getCardById must return the same id');
  console.log('PASS: getCardById resolves a live Korean card');

  // searchCards: set-scoped search.
  const found = await tcgex.searchCards({ set: 'SV4K', number: first.number, lang: 'ko' });
  assert.ok(found.cards.length >= 1, 'set-scoped search must find the card');
  assert.ok(found.cards.some(c => c.number === first.number), 'found card must match the number');
  console.log('PASS: searchCards finds a card by set + number');

  // findPrinting: the scan route's path from an English identity to the Korean card.
  const pansage = await tcgex.findPrinting('Pansage', '001');
  assert.ok(pansage, 'findPrinting must resolve a Korean printing by English name');
  assert.strictEqual(pansage.printed_name, '야나프', 'the Korean name must come back as printed_name');
  assert.strictEqual(pansage.language, 'Korean');
  assert.ok(pansage.image_url.startsWith('https://'), 'the Korean image must be present');
  console.log('PASS: findPrinting resolves the Korean printing by English name + number');

  console.log('tcgexchange.test.js: all assertions passed');
})().catch(e => {
  console.error('tcgexchange.test.js FAILED:', e.message);
  process.exit(1);
});
