// PUT /api/collection/:id with a new card_id: re-file a saved copy under another
// printing of the same card (issue #79 — a bulk scan that picked the wrong set).
//
// Locked down here: the swap works and fetches an uncached printing; it is scoped
// to the owner; it refuses another game or another card's name; and it lands next
// to copies already on that printing as one stack rather than failing or merging.
// Scryfall is stubbed — no network. Run: `node test/changeprinting.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-changeprinting-${process.pid}.db`);

(async () => {
  const db = require('../src/db');
  await db.initDb();
  const scryfall = require('../src/scryfallApi');
  const express = require('express');
  const collectionRouter = require('../src/routes/collection');

  // Scryfall's /cards/:id — the only call an uncached Magic printing needs.
  scryfall.client.get = async (url) => {
    if (url !== '/cards/m21-bolt') throw Object.assign(new Error('not found'), { response: { status: 404 } });
    return {
      data: {
        id: 'm21-bolt', lang: 'en', name: 'Lightning Bolt', set: 'm21', set_name: 'Core Set 2021',
        collector_number: '199', image_uris: { normal: 'https://cards.scryfall.io/x.jpg' },
        rarity: 'uncommon', prices: { usd: '1.50' },
      },
    };
  };

  for (const u of ['owner', 'other']) {
    await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES (?, 'x', 'member', ?)`, [u, `${u}-share`]);
  }
  const owner = await db.get(`SELECT * FROM users WHERE username = 'owner'`);
  const other = await db.get(`SELECT * FROM users WHERE username = 'other'`);

  const cache = (id, name, game, setId) => db.run(
    `INSERT INTO card_cache (id, name, set_id, set_name, number, game, language) VALUES (?, ?, ?, ?, '1', ?, 'English')`,
    [id, name, setId, setId, game]
  );
  await cache('mtg-lea-bolt', 'Lightning Bolt', 'mtg', 'lea');
  await cache('mtg-2xm-bolt', 'Lightning Bolt', 'mtg', '2xm');
  await cache('mtg-lea-counterspell', 'Counterspell', 'mtg', 'lea');
  await cache('base1-4', 'Charizard', 'pokemon', 'base1');

  const addRow = async (userId, cardId) => (await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, condition, printing, language, list_type, game)
     VALUES (?, ?, 1, 'Near Mint', 'Normal', 'English', 'collection', 'mtg')`,
    [cardId, userId]
  )).lastID;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = req.get('x-user') === 'other' ? other : owner; next(); });
  app.use('/api', collectionRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const put = (id, body, as = 'owner') => fetch(`${base}/collection/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-user': as }, body: JSON.stringify(body),
  });
  const cardOf = async (id) => (await db.get(`SELECT card_id FROM collection WHERE id = ?`, [id])).card_id;

  try {
    const entry = await addRow(owner.id, 'mtg-lea-bolt');

    // 1. Another user cannot re-file it: same 404 as any entry they do not own.
    let res = await put(entry, { card_id: 'mtg-2xm-bolt' }, 'other');
    assert.strictEqual(res.status, 404, 'cross-user change must be refused');
    assert.strictEqual(await cardOf(entry), 'mtg-lea-bolt');

    // 2. Another game is not another printing.
    res = await put(entry, { card_id: 'base1-4' });
    assert.strictEqual(res.status, 400, 'cross-game change must be refused');
    assert.strictEqual(await cardOf(entry), 'mtg-lea-bolt');

    // 3. Nor is another card of the same game — that is a delete and an add.
    res = await put(entry, { card_id: 'mtg-lea-counterspell' });
    assert.strictEqual(res.status, 400, 'a different card name must be refused');
    assert.strictEqual(await cardOf(entry), 'mtg-lea-bolt');

    // 4. Unknown printing: 404, nothing written.
    res = await put(entry, { card_id: 'mtg-nope' });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(await cardOf(entry), 'mtg-lea-bolt');

    // 5. An uncached printing of the same card is fetched, cached and filed.
    res = await put(entry, { card_id: 'mtg-m21-bolt' });
    assert.strictEqual(res.status, 200, await res.text());
    assert.strictEqual(await cardOf(entry), 'mtg-m21-bolt');
    assert.ok(await db.get(`SELECT id FROM card_cache WHERE id = 'mtg-m21-bolt'`), 'the new printing is cached');
    assert.ok(await db.get(`SELECT 1 FROM price_history WHERE card_id = 'mtg-m21-bolt'`), 'its price starts a history');

    // 6. Onto a printing the user already owns in the same condition: both rows
    //    stay, and the stack (what every view shows) is the sum.
    const existing = await addRow(owner.id, 'mtg-2xm-bolt');
    res = await put(entry, { card_id: 'mtg-2xm-bolt' });
    assert.strictEqual(res.status, 200);
    const stack = await db.get(
      `SELECT COUNT(*) AS rows, SUM(quantity) AS qty FROM collection
       WHERE user_id = ? AND card_id = 'mtg-2xm-bolt' AND condition = 'Near Mint' AND printing = 'Normal' AND language = 'English'`,
      [owner.id]
    );
    assert.deepStrictEqual({ ...stack }, { rows: 2, qty: 2 }, 'the copy joins the existing stack');
    assert.strictEqual(await cardOf(existing), 'mtg-2xm-bolt', 'the existing copy is untouched');

    console.log('changeprinting.test.js: all assertions passed');
  } finally {
    server.close();
    await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch { /* gone */ } }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
