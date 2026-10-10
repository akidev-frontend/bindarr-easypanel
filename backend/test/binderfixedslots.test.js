// Fixed slots (locations.fixed_slots, issue #74): a binder can pin a set's cards
// to the pocket their collector number names, leaving gaps for missing cards.
//
// The slot math is checked on its own first, then the three placement paths that
// must agree on it — single recommend, batch recommend and the per-page rebalance
// that runs after every move — through the real storage routes on a temp SQLite.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-binderfixedslots-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');
const {
  normalizeFixedSlots, fixedSlotRanges, fixedSlotFor, fixedPagePositions, rebalanceCompartmentByScheme
} = require('../src/utils/compartmentSort');

let server;

async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

function startApp(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'admin' }; next(); });
  app.use('/api', require('../src/routes/storage'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function slotMath() {
  const ranges = fixedSlotRanges(normalizeFixedSlots([
    { set_id: 'mtg-aaa', max_number: 10 },               // slots 1-10
    { set_id: 'bbb', start_slot: 11, max_number: 5 }     // slots 11-15
  ]));
  const at = (set_id, number) => fixedSlotFor({ set_id, number }, ranges);
  assert.strictEqual(at('aaa', '3'), 3, 'card #3 goes to slot 3, MTG bare code matching the mtg- set id');
  assert.strictEqual(at('aaa', '007'), 7, 'leading zeros are still number 7');
  assert.strictEqual(at('aaa', '10'), 10, 'the cap itself is inside the range');
  assert.strictEqual(at('aaa', '11'), null, 'past max_number has no fixed slot');
  assert.strictEqual(at('aaa', '3a'), null, 'a non-numeric collector number has no fixed slot');
  assert.strictEqual(at('aaa', '★'), null, 'a star promo number has no fixed slot');
  assert.strictEqual(at('bbb', '1'), 11, 'the second set is offset by its start slot');
  assert.strictEqual(at('bbb', '5'), 15, 'the second set ends at start + cap - 1');
  assert.strictEqual(at('zzz', '1'), null, 'an unconfigured set has no fixed slot');

  // Page 2 holds slots 10-18; 10-15 are reserved, 16-18 are not.
  const twins = [
    { id: 1, card_id: 'b2', set_id: 'bbb', number: '2', position: 3000 },
    { id: 2, card_id: 'b2', set_id: 'bbb', number: '2', position: 3000 }
  ];
  const page2 = { ranges, startSlot: 10, capacity: 9 };
  const plain = fixedPagePositions(twins, { ...page2, allowStacking: false });
  assert.deepStrictEqual([plain.get(1), plain.get(2)], [3000, 7000], 'a second copy takes the first unreserved pocket, not a gap kept for a missing card');
  const stacked = fixedPagePositions(twins, { ...page2, allowStacking: true });
  assert.deepStrictEqual([stacked.get(1), stacked.get(2)], [3000, 3000], 'on a stacking binder the copy shares its pinned pocket');

  const open = fixedSlotRanges(normalizeFixedSlots([
    { set_id: 'y', start_slot: 100 }, { set_id: 'x' }
  ]));
  assert.strictEqual(fixedSlotFor({ set_id: 'x', number: '99' }, open), 99, 'an uncapped set runs up to the next start');
  assert.strictEqual(fixedSlotFor({ set_id: 'x', number: '100' }, open), null, "an uncapped set never runs into the next set's pockets");
  assert.strictEqual(fixedSlotFor({ set_id: 'y', number: '500' }, open), 599, 'the last uncapped set is open-ended');

  assert.strictEqual(normalizeFixedSlots([]), null, 'an empty list is off');
  assert.strictEqual(normalizeFixedSlots(null), null, 'null is off');
  assert.deepStrictEqual(JSON.parse(normalizeFixedSlots([{ set_id: ' s1 ' }])), [{ set_id: 's1', start_slot: 1, max_number: null }]);
  for (const bad of [
    [{ set_id: 's1', start_slot: 0 }], [{ set_id: 's1', start_slot: 1.5 }], [{ set_id: 's1', max_number: 'ten' }],
    [{ set_id: '' }], [{ set_id: 's1' }, { set_id: 'S1' }], { set_id: 's1' }, [{ set_id: 's1', start_slot: 1e9 }]
  ]) {
    assert.throws(() => normalizeFixedSlots(bad), `should reject ${JSON.stringify(bad)}`);
  }
  console.log('PASS: slot = start + number - 1, with offset, cap, non-numeric and two-set cases');
}

async function main() {
  slotMath();
  await db.initDb();

  const user = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    ['fixed-test', db.hashPassword('x'), 'admin', `share-${process.pid}`]
  );
  const userId = user.lastID;
  const base = await startApp(userId);
  const api = (method, url, body) => fetch(`${base}/api${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  }).then(async r => ({ status: r.status, body: await r.json() }));

  // Three nine-pocket pages: slots 1-9, 10-18, 19-27.
  const loc = await db.run(
    `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, game, user_id)
     VALUES ('Set Binder', 'Binder', 'set-number', 'normals_first', 'any', 'any', ?)`, [userId]
  );
  const locId = loc.lastID;
  const pages = [];
  for (let i = 1; i <= 3; i++) {
    pages.push((await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, 9)`, [locId, i])).lastID);
  }

  const bad = await api('PUT', `/locations/${locId}`, { fixed_slots: [{ set_id: 'aaa', start_slot: -1 }] });
  assert.strictEqual(bad.status, 400, 'an invalid start slot is refused at the route');
  const ok = await api('PUT', `/locations/${locId}`, {
    fixed_slots: [{ set_id: 'mtg-aaa', max_number: 10 }, { set_id: 'bbb', start_slot: 11, max_number: 5 }]
  });
  assert.strictEqual(ok.status, 200, 'a valid config saves');
  console.log('PASS: the route validates and stores fixed_slots');

  const card = async (id, set_id, number) => db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, game)
     VALUES (?, ?, 'MTG', '[]', '[]', 'Common', ?, ?, ?, '', 1, 'mtg')`, [id, `Card ${id}`, set_id, `Set ${set_id}`, number]
  );
  await card('a5', 'aaa', '5');
  await card('a5b', 'aaa', '5a');
  await card('a23', 'aaa', '23');
  await card('b2', 'bbb', '2');
  await card('a1', 'aaa', '1');
  await card('a9', 'aaa', '9');
  await card('a7', 'aaa', '7');

  const rec = async (card_id) => (await api('POST', `/locations/${locId}/recommend`, { card_id })).body;
  let r = await rec('a5');
  assert.deepStrictEqual([r.compartment_id, r.position], [pages[0], 5000], 'set A #5 goes to page 1, slot 5 with slots 1-4 empty');
  r = await rec('b2');
  assert.deepStrictEqual([r.compartment_id, r.position], [pages[1], 3000], 'set B #2 is binder slot 12: page 2, pocket 3');
  r = await rec('a5b');
  assert.strictEqual(r.compartment_id, pages[2], 'a non-numeric number is filed on the page after the reserved slots');
  r = await rec('a23');
  assert.strictEqual(r.compartment_id, pages[2], 'a number past the cap is filed on the page after the reserved slots');

  const addCopy = async (cardId, compartmentId, position) => (await db.run(
    `INSERT INTO collection (card_id, quantity, condition, printing, language, location_id, compartment_id, position, user_id)
     VALUES (?, 1, 'Near Mint', 'Normal', 'English', ?, ?, ?, ?)`, [cardId, locId, compartmentId, position, userId]
  )).lastID;
  await addCopy('a5', pages[0], 5000);
  r = await rec('a5');
  assert.strictEqual(r.compartment_id, pages[2], 'a second copy finds its pocket taken and goes to the overflow page');
  console.log('PASS: recommend pins numbered cards and overflows the rest');

  const e1 = await addCopy('a1', null, 0);
  const e9 = await addCopy('a9', null, 0);
  const batch = (await api('POST', `/locations/${locId}/recommend-batch`, { entry_ids: [e9, e1] })).body;
  assert.deepStrictEqual(batch.map(b => [b.recommended.compartment_id, b.recommended.position]),
    [[pages[0], 9000], [pages[0], 1000]], 'batch recommend uses the same fixed slots');
  console.log('PASS: recommend-batch honors fixed slots');

  // A card stored in the wrong pocket, then the post-move rebalance.
  const e7 = await addCopy('a7', pages[0], 1000);
  await rebalanceCompartmentByScheme(db, pages[0], 'set-number', 'normals_first');
  const pos = async (id) => (await db.get(`SELECT position FROM collection WHERE id = ?`, [id])).position;
  assert.strictEqual(await pos(e7), 7000, 'rebalance moves #7 to its own pocket instead of compacting');
  const a5Entry = await db.get(`SELECT id FROM collection WHERE card_id = 'a5'`);
  assert.strictEqual(await pos(a5Entry.id), 5000, 'rebalance leaves #5 in slot 5, keeping the gap before it');
  console.log('PASS: rebalance keeps fixed pockets and gaps');

  const off = await api('PUT', `/locations/${locId}`, { fixed_slots: null });
  assert.strictEqual(off.status, 200);
  const stored = await db.get(`SELECT fixed_slots FROM locations WHERE id = ?`, [locId]);
  assert.strictEqual(stored.fixed_slots, null, 'sending null turns fixed slots off');
  await rebalanceCompartmentByScheme(db, pages[0], 'set-number', 'normals_first');
  assert.strictEqual(await pos(a5Entry.id), 1000, 'with fixed slots off the page compacts as before');
  console.log('PASS: turning it off restores the normal sorted layout');
}

main()
  .then(() => cleanup())
  .catch(async err => {
    console.error('FAIL:', err.stack || err.message);
    await cleanup();
    process.exitCode = 1;
  });
