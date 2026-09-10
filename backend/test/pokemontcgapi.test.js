// Offline contract tests. Fixtures come from the public OpenAPI/docs; the
// adapter never contacts a provider or consumes credits. Run with plain Node.
const assert = require('assert');
const path = require('path');
const os = require('os');
process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-pokemontcgapi-${process.pid}.db`);
const db = require('../src/db');
const api = require('../src/pokemontcgapi');
const policy = require('../src/utils/pokemonProvider');
const cardApi = require('../src/utils/cardApi');
const cardSets = require('../src/cardSets');
const { resolveCardPrice } = require('../src/utils/priceHelpers');
const raw = require('./fixtures/pokemontcgapi/card.json');
const sets = require('./fixtures/pokemontcgapi/sets.json');
const axios = require('axios');
axios.defaults.adapter = async () => { throw new Error('Unexpected network request'); };
const calls = [];
let respond;
api.client.defaults.adapter = async config => {
  calls.push(config);
  assert.strictEqual(config.headers.get('X-Api-Key'), process.env.POKEMONTCGAPI_KEY);
  assert.strictEqual(config.maxRedirects, 0);
  return { status: 200, headers: { etag: '"fixture-v1"' }, config, data: await respond(config) };
};
const envelope = (data, next = null) => ({ data, meta: { has_more: !!next }, links: { next } });
const card = (id, region = 'WEST') => ({ ...raw, id, set_code: id.slice(0, id.lastIndexOf('-')), print_region: region });
const price = (source, amount, extra = {}) => ({ source, amount, currency: source === 'CARDMARKET' ? 'EUR' : 'USD', variant: 'MARKET', locale: 'en', grading: null, ...extra });
const clear = async () => { await db.run('DELETE FROM pokemontcgapi_cache'); calls.length = 0; };

async function normalization() {
  const normalized = api.normalizeCard(raw);
  assert.strictEqual(normalized.id, 'pokemontcgapi-bs-4');
  assert.strictEqual(normalized.set_id, 'pokemontcgapi-bs');
  assert.strictEqual(normalized.image_url, raw.images[0].url);
  assert.strictEqual(normalized.price_trend, 599.9);
  assert.strictEqual(normalized.price_currency, 'EUR');
  assert.strictEqual(normalized.price_source, 'pokemontcgapi-cardmarket');
  // Cardmarket has no printing breakdown in this fixture. The TCGplayer holo
  // price must not slip into a EUR-labelled column.
  assert.strictEqual(normalized.price_holofoil, null);
  assert.strictEqual(resolveCardPrice({ ...normalized, printing: 'Holofoil' }), 599.9);
  assert.strictEqual(resolveCardPrice({ ...normalized, market_value: 900 }), 900);
  assert.strictEqual(normalized.cardmarket_url, 'https://www.cardmarket.com/en/Pokemon/Products?idProduct=273699');
  const jp = api.normalizeCard({ ...raw, print_region: 'JP' });
  assert.strictEqual(jp.language, 'Japanese');
  assert.strictEqual(jp.name, 'Charizard');
  assert.strictEqual(jp.printed_name, 'リザードン');
  assert.strictEqual(jp.price_trend, 0, 'English quotes cannot price Japanese printings');
  const cn = api.normalizeCard({ ...card('cn-cbb6c-1-v1', 'CN'), prices: [] });
  assert.strictEqual(cn.language, 'Chinese (Simplified)');
  assert.strictEqual(cn.price_trend, 0);
  assert.strictEqual(api.normalizeCard({ ...raw, images: [] }).image_url, '');

  const prices = [price('TCGPLAYER', 10, { printing: 'NORMAL' }), price('TCGPLAYER', 20, { printing: 'HOLOFOIL' }),
    price('CARDMARKET', 7, { variant: 'TREND' }), price('CARDMARKET', 6, { variant: 'AVG_7D' }),
    price('CARDMARKET', 999, { grading: { company: 'PSA', score: '10' } }),
    price('CARDMARKET', 777, { locale: 'fr' })];
  assert.strictEqual(api.extractPrices(prices).price_trend, 7);
  assert.strictEqual(api.extractPrices(prices).price_avg7, 6);
  assert.strictEqual(api.extractPrices([price('CARDMARKET', 500, { printing: 'FIRST_EDITION' }), price('TCGPLAYER', 10)]).price_trend, 10, 'an edition-specific quote cannot become the ordinary printing price');
  const usd = api.extractPrices(prices.filter(p => p.source !== 'CARDMARKET'));
  assert.strictEqual(usd.price_currency, 'USD');
  assert.strictEqual(usd.price_normal, 10);
  assert.strictEqual(usd.price_holofoil, 20);
  assert.strictEqual(api.extractPrices([price('CARDMARKET', -1), price('TCGPLAYER', NaN)]).price_trend, 0);
  const links = await import('../../frontend/src/utils/marketplaceLinks.js');
  assert.deepStrictEqual(links.priceSource(normalized), { name: 'Cardmarket (via pokemontcgapi.com)', currency: 'EUR' });
  assert.deepStrictEqual(links.priceSource(usd), { name: 'TCGplayer (via pokemontcgapi.com)', currency: 'USD' });
}

async function routing() {
  assert.strictEqual(await policy.configured(), 'tcgdex', 'fresh-install default remains TCGdex');
  for (const lang of ['en', 'English', 'ja', 'Japanese', 'zh-cn', 'zhs']) assert.strictEqual(policy.decide('pokemontcgapi', lang), 'pokemontcgapi');
  for (const lang of ['de', 'fr', 'it', 'es', 'ko', 'zh-tw']) assert.strictEqual(policy.decide('pokemontcgapi', lang), 'tcgdex');
  assert.strictEqual(policy.decide('pokemontcg', 'en'), 'pokemontcg');
  assert.strictEqual(policy.decide('pokemontcg', 'ja'), 'tcgdex');
  assert.strictEqual(policy.decide('tcgdex', 'en'), 'tcgdex');
  await db.run("UPDATE app_settings SET pokemon_provider = 'pokemontcgapi'");
  assert.strictEqual(await policy.apiFor('en'), api);
  assert.strictEqual(await policy.apiFor('ja'), api);
  assert.strictEqual(await policy.apiFor('zh-tw'), require('../src/tcgdexApi'));
  assert.strictEqual(cardApi.isPokemontcgapiId('pokemontcgapi-bs-4'), true);
  assert.strictEqual(await cardApi.printingInLanguage(api.normalizeCard(raw), 'Japanese'), null);
}

async function paginationAndSets() {
  await clear();
  respond = config => {
    assert.strictEqual(config.params.limit, 250);
    if (config.url === '/sets') {
      assert.strictEqual(config.params.region, 'JP');
      return config.params.cursor ? envelope([sets.data[1]]) : envelope([sets.data[0]], 'https://api.pokemontcgapi.com/v1/sets?cursor=opaque-jp-page-2');
    }
    assert.strictEqual(config.url, '/cards');
    assert.strictEqual(config.params.set, 'm6');
    assert.strictEqual(config.params.include, 'images,prices,translations');
    return config.params.cursor ? envelope([card('m6-251', 'JP')]) : envelope(Array.from({ length: 250 }, (_, i) => ({ ...card(`m6-${i + 1}`, 'JP'), number: String(i + 1) })), 'https://api.pokemontcgapi.com/v1/cards?cursor=opaque-card-page-2');
  };
  const result = await api.listSets('ja');
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].id, 'pokemontcgapi-m6');
  assert.strictEqual(result[0].release_date, '2026/07/31');
  assert.deepStrictEqual(await cardSets.listAllSets('pokemon', 'ja'), result.map(s => s.id));
  assert.strictEqual(calls.length, 2, 'set cache is reused');
  const fetched = await cardSets.cacheSetCards('pokemon', 'pokemontcgapi-m6', 'ja');
  assert.strictEqual(fetched.length, 251);
  assert.strictEqual(fetched[0].raw.id, 'pokemontcgapi-m6-1');
  assert.strictEqual(calls.length, 4, 'two pages, no detail request per card');
  assert.strictEqual((await db.get("SELECT COUNT(*) n FROM card_cache WHERE set_id = 'pokemontcgapi-m6'")).n, 251);
  await api.getCardsBySet('pokemontcgapi-m6', 'ja');
  assert.strictEqual(calls.length, 4, 'repeated set download uses cached pages');
}

async function setSyncAndCacheIsolation() {
  await clear();
  await require('../src/utils/cardCache').cacheNormalizedCards([{ ...api.normalizeCard(raw), id: 'base1-4', set_id: 'base1' }], 'pokemon');
  await db.run("INSERT INTO sets (id, name, game) VALUES ('base1', 'Base Set', 'pokemon')");
  await db.run("INSERT INTO sets (id, name, game) VALUES ('old-unused', 'Unused', 'pokemon')");
  respond = config => {
    assert.strictEqual(config.params.region, 'WEST');
    return envelope([{ ...sets.data[0], code: 'bs', name: 'Base Set', region: 'WEST' }]);
  };
  await api.fetchAndCacheSets();
  assert.ok(await db.get("SELECT id FROM sets WHERE id = 'pokemontcgapi-bs'"));
  assert.ok(await db.get("SELECT id FROM sets WHERE id = 'base1'"), 'old set metadata survives when cards still reference it');
  assert.ok(!await db.get("SELECT id FROM sets WHERE id = 'old-unused'"));
  await api.cacheCards([api.normalizeCard({ ...raw, id: 'cache-isolation-4' })]);
  const local = await api.searchCards({ name: 'Charizard', scope: 'database', limit: 250 });
  assert.ok(local.cards.every(c => c.id.startsWith('pokemontcgapi-')), 'foreign IDs cannot consume local result pages');
  const before = calls.length;
  // Clearing the module's process-local state simulates a restart. The response
  // and its key scope still come from SQLite, so no network is needed.
  delete require.cache[require.resolve('../src/pokemontcgapi')];
  const restarted = require('../src/pokemontcgapi');
  restarted.client.defaults.adapter = async () => { throw new Error('persistent cache was not reused'); };
  assert.strictEqual((await restarted.listSets('en'))[0].id, 'pokemontcgapi-bs');
  assert.strictEqual(calls.length, before);
  require.cache[require.resolve('../src/pokemontcgapi')].exports = api;
  const key = process.env.POKEMONTCGAPI_KEY;
  process.env.POKEMONTCGAPI_KEY = 'rotated-offline-fixture';
  await api.listSets('en');
  assert.strictEqual(calls.length, before + 1, 'rotating the key cannot reuse another plan response');
  process.env.POKEMONTCGAPI_KEY = key;
}

async function searches() {
  await clear();
  respond = config => {
    assert.strictEqual(config.params.limit, 250);
    assert.strictEqual(config.params.q, 'name:"Charizard"');
    return envelope([card('search-1'), card('search-2', 'JP'), card('search-3'), card('search-4', 'CN')]);
  };
  const first = await api.searchCards({ name: 'Charizard', scope: 'internet', limit: 1 });
  const second = await api.searchCards({ name: 'Charizard', scope: 'internet', page: 2, limit: 1 });
  assert.deepStrictEqual([first.cards[0].id, second.cards[0].id], ['pokemontcgapi-search-1', 'pokemontcgapi-search-3']);
  assert.strictEqual(calls.length, 1, 'UI pages reuse one 250-row upstream page');
  assert.strictEqual((await api.searchCards({ name: 'Charizard', scope: 'internet', page: 3, limit: 1 })).cards.length, 0);
  // A Japanese first page must keep following cursors even if the first upstream
  // page contains no Japanese rows. Returning [] here would hide the later match.
  await clear();
  respond = config => config.params.cursor ? envelope([card('find-jp-4', 'JP')]) : envelope([card('find-en-4')], 'https://api.pokemontcgapi.com/v1/cards?cursor=find-jp');
  const jp = await api.searchCards({ name: 'Charizard', scope: 'internet', lang: 'ja', limit: 60 });
  assert.strictEqual(jp.cards.length, 1);
  assert.strictEqual(jp.cards[0].language, 'Japanese');
  assert.strictEqual(calls.length, 2);
  await clear();
  respond = config => {
    assert.strictEqual(config.params.set, 'test-set');
    return envelope([{ ...card('test-set-004'), number: '004' }, { ...card('test-set-TG12'), number: 'TG12' }]);
  };
  assert.strictEqual((await api.searchCards({ set: 'pokemontcgapi-test-set', number: '4', scope: 'internet' })).cards[0].number, '004');
  assert.strictEqual((await api.searchCards({ set: 'pokemontcgapi-test-set', number: 'SV49', scope: 'internet' })).cards.length, 0);
  await clear();
  respond = config => { assert.strictEqual(config.params.q, 'name:"A \\"quote\\" \\\\ OR name:*"'); return envelope([]); };
  await api.searchCards({ name: 'A "quote" \\ OR name:*', scope: 'internet' });
}

async function cacheAndErrors() {
  await clear();
  respond = () => raw;
  // Dispatch belongs to the ID, even after switching back to the old provider.
  await db.run("UPDATE app_settings SET pokemon_provider = 'tcgdex'");
  const fetched = await cardApi.getCardById('pokemontcgapi-bs-4');
  assert.strictEqual(fetched.id, 'pokemontcgapi-bs-4');
  assert.strictEqual(calls.length, 1);
  await cardApi.getCardById(fetched.id);
  assert.strictEqual(calls.length, 1);
  await db.run("UPDATE card_cache SET last_updated = '2000-01-01' WHERE id = ?", [fetched.id]);
  await db.run('UPDATE pokemontcgapi_cache SET fetched_at = 0');
  const adapter = api.client.defaults.adapter;
  api.client.defaults.adapter = async config => {
    calls.push(config);
    assert.strictEqual(config.headers.get('If-None-Match'), '"fixture-v1"');
    return { status: 304, headers: {}, config, data: '' };
  };
  assert.strictEqual((await api.getCardById(fetched.id)).name, 'Charizard');
  assert.strictEqual(calls.length, 2);
  assert.ok((await db.get('SELECT fetched_at FROM pokemontcgapi_cache')).fetched_at > 0);
  api.client.defaults.adapter = adapter;
  await clear();
  respond = () => { const error = new Error('must never expose Axios config'); error.config = { headers: { 'X-Api-Key': process.env.POKEMONTCGAPI_KEY } }; error.response = { status: 500 }; throw error; };
  assert.ok((await api.searchCards({ name: 'Charizard', scope: 'internet' })).cards.length, 'outage uses card_cache');
  await assert.rejects(api.searchCards({ name: 'notcached', scope: 'internet' }), { message: 'UPSTREAM_UNAVAILABLE' });
  const callsBefore = calls.length;
  await api.searchCards({ scope: 'collection' });
  assert.strictEqual(calls.length, callsBefore, 'collection scope is offline');
  const key = process.env.POKEMONTCGAPI_KEY;
  delete process.env.POKEMONTCGAPI_KEY;
  await assert.rejects(api.searchCards({ name: 'notcached', scope: 'internet' }), { message: 'POKEMONTCGAPI_KEY_REQUIRED' });
  assert.ok(await api.getCardById(fetched.id), 'cached owned cards remain readable without a key');
  process.env.POKEMONTCGAPI_KEY = key;
  respond = () => { const error = new Error('invalid key'); error.response = { status: 401 }; throw error; };
  await assert.rejects(api.getCardById('pokemontcgapi-missing-key'), { message: 'POKEMONTCGAPI_KEY_INVALID' });
  respond = () => { const error = new Error('not found'); error.response = { status: 404 }; throw error; };
  assert.strictEqual(await api.getCardById('pokemontcgapi-missing-card'), null);
  // Do not send credentials to a foreign next link, and do not silently return
  // an incomplete catalogue when an upstream accidentally repeats a cursor.
  await clear();
  respond = () => envelope([], 'https://example.com/v1/sets?cursor=bad');
  await assert.rejects(api.listSets('en'), { message: 'UPSTREAM_UNAVAILABLE' });
  assert.strictEqual(calls.length, 1);
  await clear();
  respond = () => envelope([], 'https://api.pokemontcgapi.com/v1/sets?cursor=repeated');
  await assert.rejects(api.listSets('en'), { message: 'UPSTREAM_UNAVAILABLE' });
  assert.strictEqual(calls.length, 2);
}

async function routes() {
  await clear();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 1, role: req.headers['x-test-role'] || 'admin' }; next(); });
  app.use('/api/settings', require('../src/routes/settings'));
  app.use('/api/sets', require('../src/routes/sets'));
  app.use('/api', require('../src/routes/collection'));
  await db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES ('fixture-session', 1, '2099-01-01')");
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-session' };
  const catalog = require('../src/tcgplayerCatalog');
  const sync = api.fetchAndCacheSets;
  const start = catalog.start;
  try {
    let res = await fetch(base + '/api/settings', { method: 'PUT', headers: { ...headers, 'x-test-role': 'member' }, body: JSON.stringify({ pokemon_provider: 'pokemontcgapi' }) });
    assert.strictEqual(res.status, 403);
    const key = process.env.POKEMONTCGAPI_KEY;
    delete process.env.POKEMONTCGAPI_KEY;
    res = await fetch(base + '/api/settings', { method: 'PUT', headers, body: JSON.stringify({ pokemon_provider: 'pokemontcgapi' }) });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(await policy.configured(), 'tcgdex', 'failed activation cannot change the setting');
    process.env.POKEMONTCGAPI_KEY = key;
    let synced = false;
    api.fetchAndCacheSets = async () => { synced = true; };
    const followup = new Promise(resolve => { catalog.start = resolve; });
    res = await fetch(base + '/api/settings', { method: 'PUT', headers, body: JSON.stringify({ pokemon_provider: 'pokemontcgapi' }) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).pokemon_provider, 'pokemontcgapi');
    await followup;
    assert.ok(synced, 'provider change syncs the matching set source');
    res = await fetch(base + '/api/settings', { headers });
    assert.ok(!(await res.text()).includes(key), 'settings never return the credential');
    respond = config => {
      assert.strictEqual(config.params.region, 'CN');
      return envelope([{ ...sets.data[0], code: 'cn-cbb6c', region: 'CN' }]);
    };
    res = await fetch(base + '/api/sets?game=pokemon&lang=zh-cn', { headers });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json())[0].id, 'pokemontcgapi-cn-cbb6c');
    respond = () => envelope([card('route-match-4')]);
    res = await fetch(base + '/api/search?game=pokemon&name=route-match&scope=internet', { headers });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json())[0].id, 'pokemontcgapi-route-match-4');
    assert.strictEqual(res.headers.get('X-Total-Count'), '1');
    res = await fetch(base + '/api/collection', { method: 'POST', headers, body: JSON.stringify({ card_id: 'pokemontcgapi-route-match-4', quantity: 1, game: 'pokemon', language: 'English' }) });
    assert.strictEqual(res.status, 200, await res.text());
    assert.ok(await db.get("SELECT id FROM collection WHERE card_id = 'pokemontcgapi-route-match-4'"));
    // Keep the sweep test focused on its one decked fixture.
    await db.run("DELETE FROM collection WHERE card_id = 'pokemontcgapi-route-match-4'");
    await db.run("UPDATE app_settings SET pokemon_provider = 'tcgdex'");
  } finally {
    api.fetchAndCacheSets = sync;
    catalog.start = start;
    await new Promise(resolve => server.close(resolve));
  }
}

async function pricesAndQuota() {
  await clear();
  const tcgcsv = require('../src/tcgcsvApi');
  assert.ok(!(await tcgcsv.setsToPrice('all')).some(s => s.set_id.startsWith('pokemontcgapi-')));
  assert.strictEqual((await tcgcsv.priceSet({ set_id: 'pokemontcgapi-bs' }, () => { throw new Error('must not map'); })).priced, 0);
  respond = () => { throw new Error('disabled provider must not fetch'); };
  await api.updateCollectionPrices();
  assert.strictEqual(calls.length, 0);
  await db.run("UPDATE app_settings SET pokemon_provider = 'pokemontcgapi'");
  // A decked card participates in the sweep without needing a collection copy.
  await db.run("INSERT INTO decks (name, user_id) VALUES ('Fixture deck', 1)");
  const deck = await db.get("SELECT id FROM decks WHERE name = 'Fixture deck'");
  await db.run('INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, 1)', [deck.id, 'pokemontcgapi-bs-4']);
  respond = config => { assert.strictEqual(config.params.q, 'id:"bs-4"'); return envelope([raw]); };
  await api.updateCollectionPrices();
  assert.strictEqual(calls.length, 1);
  await api.updateCollectionPrices();
  assert.strictEqual(calls.length, 1, 'daily sweep gate survives subsequent calls');
  assert.strictEqual((await db.get("SELECT price FROM price_history WHERE card_id = 'pokemontcgapi-bs-4'")).price, 599.9);
  await clear();
  respond = () => { const error = new Error('quota'); error.response = { status: 429, headers: { 'retry-after': '3600' } }; throw error; };
  await assert.rejects(api.searchCards({ name: 'quota-one', scope: 'internet' }), { message: 'UPSTREAM_UNAVAILABLE' });
  await assert.rejects(api.searchCards({ name: 'quota-two', scope: 'internet' }), { message: 'UPSTREAM_UNAVAILABLE' });
  assert.strictEqual(calls.length, 1, '429 pauses other requests without a retry storm');
}

(async () => {
  await db.initDb();
  process.env.POKEMONTCGAPI_KEY = 'offline-fixture-credential';
  await db.run("INSERT INTO users (id, username, password_hash, role, share_token) VALUES (1, 'fixture-owner', 'unused', 'admin', 'fixture-share')");
  await normalization();
  await routing();
  await paginationAndSets();
  await setSyncAndCacheIsolation();
  await searches();
  await cacheAndErrors();
  await routes();
  await pricesAndQuota();
  console.log('pokemontcgapi.test.js: all assertions passed');
})().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
