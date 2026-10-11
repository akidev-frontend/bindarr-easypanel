// A Magic copy's language can be changed, back and forth, without losing its value (#73).
//
// Two defects. Setting a copy to German moved it to the German printing, which
// Scryfall rarely prices, so it was worth $0.00. Setting it back to English left it
// on the German printing for good, because getPrintingInLang refused English. Now
// English resolves like any other language, and an unpriced non-English printing
// is valued at its English printing's price. The bulk "Set language" action shares
// the single edit's logic. Scryfall is stubbed: no request leaves the process.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

process.env.SCRYFALL_GAP_SCALE = '0';
const tmpDb = path.join(os.tmpdir(), `bindarr-mtglanguage-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');
const scryfall = require('../src/scryfallApi');

let server;
async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

// One card, Ancestral Katana neo #1, in English (priced) and German (not priced,
// which is how Scryfall answers for most non-English printings).
// Real Scryfall ids, because the sweep only asks by id for something UUID-shaped.
const uuid = { en: '00000000-0000-4000-8000-0000000000e0', de: '00000000-0000-4000-8000-0000000000d0' };
const EN = `mtg-${uuid.en}`;
const DE = `mtg-${uuid.de}`;
let englishUsd = '4.00';
const raw = (lang) => ({
  id: uuid[lang], lang, name: 'Ancestral Katana',
  ...(lang === 'de' ? { printed_name: 'Katana der Ahnen' } : {}),
  set: 'neo', set_name: 'Kamigawa: Neon Dynasty', collector_number: '1',
  image_uris: { normal: `https://cards.scryfall.io/${lang}.jpg` }, rarity: 'common',
  prices: lang === 'en' ? { usd: englishUsd } : {},
});

async function main() {
  await db.initDb();

  scryfall.client.get = async (url) => {
    const m = url.match(/^\/cards\/neo\/1\/(en|de)$/);
    if (!m) throw Object.assign(new Error(`unexpected ${url}`), { response: { status: 404 } });
    return { data: raw(m[1]) };
  };
  // The price sweep's bulk lookup: by id it returns that printing, by set + number
  // the English one, exactly like the real /cards/collection.
  scryfall.client.post = async (url, body) => ({
    data: { data: body.identifiers.map(i => raw(i.id === uuid.de ? 'de' : 'en')), not_found: [] },
  });

  const mkUser = async (name) => (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, 'member', ?)`,
    [name, db.hashPassword('x'), `share-${name}-${process.pid}`]
  )).lastID;
  const alice = await mkUser('alice');
  const bob = await mkUser('bob');

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: alice, role: 'member' }; next(); });
  app.use('/api', require('../src/routes/collection'));
  const base = await new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  // The copy as an English-catalog scan files it: the English printing, priced.
  await scryfall.cacheCards([scryfall.normalizeCard(raw('en'))]);
  const addCopy = async (userId) => (await db.run(
    `INSERT INTO collection (card_id, user_id, language, game) VALUES (?, ?, 'English', 'mtg')`, [EN, userId]
  )).lastID;
  const entry = await addCopy(alice);
  const entryOf = (id) => db.get(`SELECT card_id, language FROM collection WHERE id = ?`, [id]);
  const valueOf = async (id) => (await call('GET', '/api/collection')).body.find(r => r.entry_id === id).price_trend;

  // English -> German: the German printing (its art and name), at the English price.
  assert.strictEqual((await call('PUT', `/api/collection/${entry}`, { language: 'German' })).status, 200);
  assert.deepStrictEqual(await entryOf(entry), { card_id: DE, language: 'German' });
  assert.strictEqual(await valueOf(entry), 4, 'an unpriced German printing is valued at the English price');
  const german = await db.get(`SELECT printed_name, price_currency FROM card_cache WHERE id = ?`, [DE]);
  assert.strictEqual(german.printed_name, 'Katana der Ahnen');
  assert.strictEqual(german.price_currency, 'USD', 'the currency comes with the borrowed price');

  // German -> English: back on the original printing. This is the half that stuck.
  assert.strictEqual((await call('PUT', `/api/collection/${entry}`, { language: 'English' })).status, 200);
  assert.deepStrictEqual(await entryOf(entry), { card_id: EN, language: 'English' });
  assert.strictEqual(await valueOf(entry), 4);

  // The daily sweep refreshes the German row by its own id (still unpriced), and the
  // English printing behind it, so the fallback follows the English price.
  await call('PUT', `/api/collection/${entry}`, { language: 'German' });
  englishUsd = '5.00';
  await scryfall.updateCollectionPrices(true);
  assert.strictEqual(await valueOf(entry), 5, 'the sweep keeps the fallback on today\'s English price');

  // Bulk: same semantics, and only the caller's own copies.
  const mine = await addCopy(alice);
  const theirs = await addCopy(bob);
  const bulk = await call('POST', '/api/collection/bulk', { entry_ids: [entry, mine, theirs], action: 'language', value: 'English' });
  assert.strictEqual(bulk.status, 200);
  assert.strictEqual(bulk.body.affected, 2, 'bob\'s copy is not alice\'s to change');
  assert.deepStrictEqual(await entryOf(entry), { card_id: EN, language: 'English' }, 'bulk restores the English printing too');
  const toGerman = await call('POST', '/api/collection/bulk', { entry_ids: [mine, theirs], action: 'language', value: 'German' });
  assert.strictEqual(toGerman.body.affected, 1);
  assert.deepStrictEqual(await entryOf(mine), { card_id: DE, language: 'German' });
  assert.deepStrictEqual(await entryOf(theirs), { card_id: EN, language: 'English' }, 'untouched');

  // Allow-listed: the language table's display names, nothing else.
  assert.strictEqual((await call('POST', '/api/collection/bulk', { entry_ids: [mine], action: 'language', value: 'Klingon' })).status, 400);

  console.log('mtglanguage.test.js: all assertions passed');
}

main()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
