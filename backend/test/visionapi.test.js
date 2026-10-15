// The vision identification client: request shape, JSON parsing, normalization
// and configuration precedence. The HTTP call is mocked, so this is offline.
//
// The parts worth guarding are the ones a model's output routinely violates:
// JSON wrapped in prose or code fences, a missing field, a confidence outside
// 0..1, and a game it made up. Everything downstream (the provider search and
// the save) assumes the normalized shape.
const assert = require('assert');
const path = require('path');
const os = require('os');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-vision-${process.pid}.db`);
delete process.env.VISION_API_KEY;
delete process.env.VISION_BASE_URL;
delete process.env.VISION_MODEL;

(async () => {
  const db = require('../src/db');
  await db.initDb();

  const axios = require('axios');
  const realPost = axios.post;
  const visionApi = require('../src/utils/visionApi');

  // 1. JSON straight out.
  assert.deepStrictEqual(visionApi.parseJson('{"a":1}'), { a: 1 });

  // 2. Fenced and prose-wrapped JSON, which is most of what models emit.
  assert.deepStrictEqual(
    visionApi.parseJson('Sure!\n```json\n{"name":"Pikachu","number":"58"}\n```'),
    { name: 'Pikachu', number: '58' }
  );

  // 3. No JSON at all is an error, not a silent empty card.
  assert.throws(() => visionApi.parseJson('I cannot tell what this is.'), /did not return JSON/);
  assert.throws(() => visionApi.parseJson(null), /no content/);

  // 3b. The endpoint URL accepts either the API base or the full path, so a
  // pasted "/chat/completions" is not appended a second time (a 404 in the wild).
  assert.strictEqual(visionApi.endpointUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  assert.strictEqual(visionApi.endpointUrl('https://api.deepseek.com/chat/completions'), 'https://api.deepseek.com/chat/completions');
  assert.strictEqual(visionApi.endpointUrl('https://api.deepseek.com/chat/completions/'), 'https://api.deepseek.com/chat/completions');

  // 4. Normalization: fields trimmed, confidence clamped, unknown game falls back
  // to the one being scanned, a made-up game does not.
  const norm = visionApi.normalize({
    name: '  Charizard ', printed_name: 'リザードン', set: 'Base Set', set_code: 'BS',
    number: '4/102', language: 'Japanese', game: 'pokemon', rarity: 'Rare Holo', confidence: 1.7,
  }, { game: 'mtg' });
  assert.strictEqual(norm.name, 'Charizard');
  assert.strictEqual(norm.printed_name, 'リザードン');
  assert.strictEqual(norm.set_code, 'BS');
  assert.strictEqual(norm.number, '4/102');
  assert.strictEqual(norm.game, 'pokemon');
  assert.strictEqual(norm.confidence, 1, 'confidence clamps to 1');

  const unknownGame = visionApi.normalize({ name: 'Elsa', game: 'yugioh', confidence: 0.5 }, { game: 'lorcana' });
  assert.strictEqual(unknownGame.game, 'lorcana', 'an unsupported game falls back to the scanned one');
  assert.strictEqual(visionApi.normalize({ name: 'x', confidence: -3 }).confidence, 0, 'negative clamps to 0');
  assert.strictEqual(visionApi.normalize({ name: 'x' }).confidence, null, 'missing confidence is null, not 0');
  // printed_name defaults to name when the model omits it.
  assert.strictEqual(visionApi.normalize({ name: 'Sol Ring' }).printed_name, 'Sol Ring');

  // 5. Configuration: not configured with nothing set …
  assert.strictEqual(await visionApi.isConfigured(), false);

  // … configured by an API key …
  process.env.VISION_API_KEY = 'sk-test';
  assert.strictEqual(await visionApi.isConfigured(), true);
  let cfg = await visionApi.config();
  assert.strictEqual(cfg.apiKey, 'sk-test');
  assert.strictEqual(cfg.baseUrl, visionApi.DEFAULT_BASE_URL);
  assert.strictEqual(cfg.model, visionApi.DEFAULT_MODEL);

  // … or by an explicit base URL alone (a local server with no key).
  delete process.env.VISION_API_KEY;
  process.env.VISION_BASE_URL = 'http://localhost:11434/v1';
  assert.strictEqual(await visionApi.isConfigured(), true);

  // 6. An admin override wins over the environment.
  process.env.VISION_API_KEY = 'sk-env';
  await db.run(`UPDATE app_settings SET vision_base_url = ?, vision_model = ?, vision_api_key = ? WHERE id = 1`,
    ['https://admin.example/v1/', 'admin-model', 'sk-admin']);
  cfg = await visionApi.config();
  assert.strictEqual(cfg.baseUrl, 'https://admin.example/v1', 'trailing slash trimmed');
  assert.strictEqual(cfg.model, 'admin-model');
  assert.strictEqual(cfg.apiKey, 'sk-admin', 'the admin key overrides the env one');

  // 7. identify() sends a chat/completions request with the image and a bearer key.
  let seen = null;
  axios.post = async (url, body, opts) => {
    seen = { url, body, opts };
    return { data: { choices: [{ message: { content: '{"name":"Pikachu","game":"pokemon","confidence":0.9}' } }] } };
  };
  const identified = await visionApi.identify('data:image/jpeg;base64,AAAA', { game: 'pokemon', lang: 'Japanese' });
  assert.strictEqual(seen.url, 'https://admin.example/v1/chat/completions');
  assert.strictEqual(seen.opts.headers.Authorization, 'Bearer sk-admin');
  assert.strictEqual(seen.body.model, 'admin-model');
  const userContent = seen.body.messages[1].content;
  assert.ok(userContent.some(p => p.type === 'image_url' && p.image_url.url === 'data:image/jpeg;base64,AAAA'),
    'the image travels as a data URL');
  assert.strictEqual(identified.name, 'Pikachu');
  assert.strictEqual(identified.game, 'pokemon');
  assert.strictEqual(identified.confidence, 0.9);

  // 8. A bare base64 payload gets a JPEG data URL prefix so the endpoint can read it.
  axios.post = async (url, body) => {
    seen = body;
    return { data: { choices: [{ message: { content: '{"name":"x","confidence":0.4}' } }] } };
  };
  await visionApi.identify('Zm9v', {});
  assert.match(seen.messages[1].content.find(p => p.type === 'image_url').image_url.url, /^data:image\/jpeg;base64,Zm9v$/);

  axios.post = realPost;
  console.log('visionapi.test.js: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
