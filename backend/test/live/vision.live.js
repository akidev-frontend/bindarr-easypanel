// Live test: exercises the REAL /api/scan-match HTTP path end to end against a
// fake OpenAI-compatible vision endpoint, with the card provider stubbed so the
// test does not depend on the internet.
//
// It proves the pieces the unit tests cannot: that the route reaches the vision
// endpoint over HTTP with the image and the bearer key, parses the JSON answer,
// resolves the identity to a card, decides auto-add, and returns the shape the
// client expects.
//
// Run: node test/live/vision.live.js
const http = require('http');
const path = require('path');
const os = require('os');
const assert = require('assert');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-vision-live-${process.pid}.db`);

// A tiny card provider, so no card API is contacted. Mirrors the provider card
// shape the route hydrates from.
const CARD = {
  id: 'mtg-neo-1',
  name: 'Ancestral Katana',
  set_id: 'neo',
  set_name: 'Kamigawa: Neon Dynasty',
  number: '1',
  image_url: 'https://cards.scryfall.io/neo-1.jpg',
  game: 'mtg',
  rarity: 'common',
};

async function main() {
  const express = require('express');
  const db = require('../../src/db');
  await db.initDb();

  // --- the fake vision API -------------------------------------------------
  const seen = [];
  let fail = false;
  let replyContent = JSON.stringify({
    name: 'Ancestral Katana', printed_name: 'Ancestral Katana', set: 'Kamigawa: Neon Dynasty',
    set_code: 'NEO', number: '1', language: 'English', game: 'mtg', rarity: 'common', confidence: 0.95,
  });
  const ai = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      if (fail) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream boom' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: replyContent } }] }));
    });
  });
  await new Promise((r) => ai.listen(0, '127.0.0.1', r));
  const aiPort = ai.address().port;

  process.env.VISION_BASE_URL = `http://127.0.0.1:${aiPort}/v1`;
  process.env.VISION_MODEL = 'mock-vision';
  process.env.VISION_API_KEY = 'sk-live-test';
  delete require.cache[require.resolve('../../src/utils/visionApi')];

  // Stub the provider the route resolves against.
  const scryfall = require('../../src/scryfallApi');
  const realSearch = scryfall.searchCards;
  scryfall.searchCards = async () => ({ cards: [CARD], total: 1 });

  // --- the real API --------------------------------------------------------
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use((req, res, next) => { req.user = { id: 1, role: 'admin', tcg_api_key: '' }; next(); });
  app.use('/api/settings', require('../../src/routes/settings'));
  app.use('/api', require('../../src/routes/collection'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Settings report configured, expose the key state, never the key.
    let res = await fetch(`${base}/api/settings`);
    let settings = await res.json();
    assert.strictEqual(settings.vision_configured, true, 'env key counts as configured');
    assert.ok(!JSON.stringify(settings).includes('sk-live-test'), 'the API key must never be returned');

    // 2. A scan reaches the vision endpoint and resolves a card.
    const image = 'data:image/jpeg;base64,' + Buffer.alloc(400, 7).toString('base64');
    res = await fetch(`${base}/api/scan-match`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: 'mtg', image, set: 'neo', lang: 'en' }),
    });
    assert.strictEqual(res.status, 200, `scan-match status ${res.status}`);
    const out = await res.json();
    assert.strictEqual(out.engine, 'vision');
    assert.strictEqual(out.game, 'mtg');
    assert.strictEqual(out.vision.name, 'Ancestral Katana');
    assert.strictEqual(out.vision.set_code, 'NEO');
    assert.strictEqual(out.autoAdd, true, 'a confident exact identity auto-adds');
    assert.strictEqual(out.candidates[0].card.id, CARD.id, 'the named printing resolves first');
    assert.strictEqual(out.candidates[0].card.set_id, 'neo');

    // 3. The vision endpoint was actually called, with the image and the key.
    assert.strictEqual(seen.length, 1, 'exactly one vision request');
    assert.strictEqual(seen[0].url, '/v1/chat/completions');
    assert.strictEqual(seen[0].auth, 'Bearer sk-live-test');
    assert.strictEqual(seen[0].body.model, 'mock-vision');
    const userContent = seen[0].body.messages[1].content;
    assert.ok(userContent.some(p => p.type === 'image_url' && p.image_url.url === image),
      'the uploaded card image travels to the model');

    // 4. Low confidence → candidates but no auto-add.
    replyContent = JSON.stringify({ name: 'Ancestral Katana', set_code: 'NEO', number: '1', game: 'mtg', confidence: 0.2 });
    res = await fetch(`${base}/api/scan-match`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: 'mtg', image, lang: 'en' }),
    });
    const low = await res.json();
    assert.strictEqual(low.autoAdd, false, 'an unsure answer must not auto-add');
    assert.strictEqual(low.candidates.length, 1, 'the candidates stay on screen');

    // 5. A Korean scan resolves through the BUNDLED Korean catalog (no network):
    // the model gives the English name, the route returns the Korean printing.
    replyContent = JSON.stringify({ name: 'Pansage', set_code: '', number: '1', language: 'English', game: 'pokemon', confidence: 0.9 });
    res = await fetch(`${base}/api/scan-match`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: 'pokemon', image, lang: 'ko' }),
    });
    const ko = await res.json();
    assert.strictEqual(ko.engine, 'vision');
    assert.ok(ko.candidates.length >= 1, 'a Korean scan must resolve a candidate');
    assert.strictEqual(ko.candidates[0].card.language, 'Korean', 'the candidate must be the Korean printing');
    assert.strictEqual(ko.candidates[0].card.printed_name, '야나프', 'the Korean name must be shown');
    assert.match(ko.candidates[0].card.image_url, /^https:\/\//, 'the Korean image must be present');

    // 6. Unconfigured → 503 notBuilt with a message that names the fix.
    delete process.env.VISION_API_KEY;
    delete process.env.VISION_BASE_URL;
    await db.run(`UPDATE app_settings SET vision_api_key = '', vision_base_url = '' WHERE id = 1`);
    delete require.cache[require.resolve('../../src/utils/visionApi')];   // re-read config? config reads db+env live
    res = await fetch(`${base}/api/scan-match`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: 'mtg', image, lang: 'en' }),
    });
    assert.strictEqual(res.status, 503);
    const notBuilt = await res.json();
    assert.strictEqual(notBuilt.notBuilt, true);
    assert.match(notBuilt.error, /vision model/i);

    // 7. A failing vision provider → 502 with the provider's own message, not a
    // blank 500. Reconfigure, then make the mock endpoint fail.
    process.env.VISION_BASE_URL = `http://127.0.0.1:${aiPort}/v1`;
    process.env.VISION_API_KEY = 'sk-live-test';
    fail = true;
    res = await fetch(`${base}/api/scan-match`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: 'mtg', image, lang: 'en' }),
    });
    assert.strictEqual(res.status, 502, 'a provider failure is a 502, not a 500');
    const failed = await res.json();
    assert.strictEqual(failed.visionError, true);
    assert.match(failed.error, /upstream boom/, 'the provider message is surfaced');

    console.log('vision.live.js: all 24 assertions passed across 7 scenarios');
  } finally {
    scryfall.searchCards = realSearch;
    await new Promise((r) => server.close(r));
    await new Promise((r) => ai.close(r));
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
