// The daily Pokémon price sweep, and the two things it used to get wrong.
//
// It selected every owned English Pokémon card and handed each one to
// getCardById. That returns the cached row untouched when it is less than three
// days old — so on a daily sweep against a three-day cache, most days it made
// almost no requests. It then slept a second per card regardless, which meant a
// 5,000-card collection spent 83 minutes a day in setTimeout to fetch nothing.
//
// Two assertions, and neither can be made by reading the code: how many requests
// reach the provider, and how long the sweep takes relative to the number of
// cards it actually had work for.
//
// No framework — plain node + assert. Run: `node test/pricesweep.test.js`
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-pricesweep-${process.pid}.db`);
process.env.POKEMON_TCG_API_KEY = 'test-key';
// initDb only seeds the 'admin' user when a password is pinned, and collection
// rows carry a user_id that references it.
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
// The real gap is a second per request. The point here is that it is paid per
// REQUEST rather than per owned card, which a smaller gap measures just as well
// and 30 seconds faster.
process.env.POKEMON_PRICE_GAP_MS = '40';

const db = require('../src/db');
const { updateCollectionPrices, tcgClient } = require('../src/tcgApi');

// Stand-in for api.pokemontcg.io. Counts what actually reaches it.
function makeServer(state) {
  return http.createServer((req, res) => {
    state.hits++;
    const id = decodeURIComponent(req.url.split('/cards/')[1] || '').split('?')[0];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        id,
        name: 'Test Card',
        number: '1',
        set: { id: 'test', name: 'Test Set' },
        images: { small: 'https://img/small.png' },
        tcgplayer: { prices: { normal: { market: 1.23 } } },
      },
    }));
  });
}

const listen = (server) => new Promise(resolve =>
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

// `fresh` cards were cached just now; `stale` ones four days ago. Only the stale
// ones have anything to fetch.
async function seed({ fresh, stale }) {
  await db.run(`DELETE FROM collection`);
  await db.run(`DELETE FROM card_cache`);
  await db.run(`DELETE FROM price_sweeps`).catch(() => {});
  let n = 0;
  const add = async (count, when) => {
    for (let i = 0; i < count; i++) {
      const id = `sv1-${++n}`;
      await db.run(
        `INSERT INTO card_cache (id, name, set_id, number, game, language, price_trend, last_updated)
         VALUES (?, ?, ?, ?, 'pokemon', 'English', 1.0, ${when})`,
        [id, `Card ${n}`, 'sv1', String(n)]
      );
      await db.run(
        `INSERT INTO collection (user_id, card_id, quantity, condition) VALUES (1, ?, 1, 'Near Mint')`,
        [id]
      );
    }
  };
  await add(fresh, `datetime('now')`);
  await add(stale, `datetime('now', '-4 days')`);
}

async function main() {
  await db.initDb();

  // --- 1. Nothing stale: no requests, and no time spent pretending. ----------
  {
    const state = { hits: 0 };
    const server = makeServer(state);
    tcgClient.defaults.baseURL = await listen(server);
    try {
      await seed({ fresh: 40, stale: 0 });
      const t0 = Date.now();
      await updateCollectionPrices(true);
      const ms = Date.now() - t0;

      assert.strictEqual(state.hits, 0, 'cards cached today must not be re-fetched');
      // The old loop slept POKEMON_PRICE_GAP_MS per owned card whether or not it
      // fetched anything: 40 cards, 40 gaps. Anything near that is the bug back.
      assert.ok(ms < 20 * Number(process.env.POKEMON_PRICE_GAP_MS),
        `a sweep with nothing to do took ${ms}ms — it is still sleeping per owned card`);
    } finally {
      await new Promise(r => server.close(r));
    }
  }

  // --- 2. Some stale: exactly those are fetched, and priced. -----------------
  {
    const state = { hits: 0 };
    const server = makeServer(state);
    tcgClient.defaults.baseURL = await listen(server);
    try {
      await seed({ fresh: 30, stale: 5 });
      await updateCollectionPrices(true);

      assert.strictEqual(state.hits, 5,
        `expected one request per STALE card, got ${state.hits} for 5 stale of 35 owned`);

      // The fetched rows really were written back, or "refreshed" means nothing.
      const priced = await db.get(
        `SELECT COUNT(*) n FROM card_cache
          WHERE game = 'pokemon' AND price_trend = 1.23 AND last_updated > datetime('now', '-1 day')`
      );
      assert.strictEqual(priced.n, 5, 'every stale card must come back with its new price');

      // And a price series row for each, since the price moved 1.00 -> 1.23.
      const history = await db.get(`SELECT COUNT(*) n FROM price_history`);
      assert.strictEqual(history.n, 5, 'a price movement must be recorded once per card');
    } finally {
      await new Promise(r => server.close(r));
    }
  }

  // --- 3. The gap is paid BETWEEN requests, not after the last one. ----------
  {
    const state = { hits: 0 };
    const server = makeServer(state);
    tcgClient.defaults.baseURL = await listen(server);
    try {
      await seed({ fresh: 0, stale: 1 });
      const t0 = Date.now();
      await updateCollectionPrices(true);
      const ms = Date.now() - t0;

      assert.strictEqual(state.hits, 1);
      assert.ok(ms < Number(process.env.POKEMON_PRICE_GAP_MS),
        `one card took ${ms}ms — the sweep is still sleeping after the last request`);
    } finally {
      await new Promise(r => server.close(r));
    }
  }

  console.log('pricesweep.test.js: all 7 assertions passed');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
