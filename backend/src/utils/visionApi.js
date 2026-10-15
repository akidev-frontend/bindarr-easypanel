// Card identification through a generative vision model.
//
// This is the scanner's identification step. The browser detects the card's
// corners locally (cornelius, via utils/cardDetector) and uploads a rectified
// crop; this module asks an OpenAI-compatible `/chat/completions` endpoint to
// name the card and extract its objective data as JSON. The caller then resolves
// that identity to a real card through the normal provider search, exactly like
// a manual search — so everything after identification (prices, storage, saving)
// is the same code path it always was.
//
// Configuration is environment-first with an optional admin override, mirroring
// PUBLIC_BASE_URL:
//   VISION_BASE_URL  default https://api.openai.com/v1
//   VISION_MODEL     default gpt-4o-mini
//   VISION_API_KEY   the bearer token sent to the endpoint
//
// The client is deliberately OpenAI-compatible rather than OpenAI-specific: the
// same shape works for OpenAI, Azure OpenAI, OpenRouter, Groq and local servers
// (Ollama, LM Studio, vLLM) that expose /chat/completions. A local endpoint that
// needs no key is usable by setting VISION_BASE_URL alone.
const axios = require('axios');
const db = require('../db');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
// A confident identification is auto-added by the scanner. Below it the client
// shows the candidates for the user to pick, which is the safe answer for an
// uncertain read.
const AUTO_ADD_CONFIDENCE = Number(process.env.VISION_AUTO_ADD_CONFIDENCE || 0.6);
// Below this the answer is not even worth showing as a confident candidate.
const MIN_CONFIDENCE = Number(process.env.VISION_MIN_CONFIDENCE || 0.3);
const TIMEOUT_MS = Number(process.env.VISION_TIMEOUT_MS || 60000);
const GAMES = ['pokemon', 'mtg', 'lorcana'];

// The admin override wins over the environment, and the environment over the
// default — the same precedence the rest of app_settings uses. The API key is
// stored in the row so an admin can rotate it without a redeploy; it is never
// returned to the client (see routes/settings.js).
async function config() {
  const row = await db.get(
    `SELECT vision_base_url, vision_model, vision_api_key FROM app_settings WHERE id = 1`
  ).catch(() => null);
  const baseUrl = String((row && row.vision_base_url) || process.env.VISION_BASE_URL || DEFAULT_BASE_URL)
    .trim().replace(/\/+$/, '');
  const model = String((row && row.vision_model) || process.env.VISION_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const apiKey = String((row && row.vision_api_key) || process.env.VISION_API_KEY || '').trim();
  return { baseUrl, model, apiKey, overriddenBaseUrl: !!(row && row.vision_base_url) || !!process.env.VISION_BASE_URL };
}

// "Configured" is not simply "has a key": a self-hosted endpoint on the LAN
// needs no key at all, and requiring one would make local inference impossible.
// So a key OR an explicit base URL is enough to try.
async function isConfigured() {
  const { apiKey, overriddenBaseUrl } = await config();
  return !!apiKey || overriddenBaseUrl;
}

// The model's instructions. Kept in the system role so the user turn is just the
// image plus the (small) context hints, which is what the vision models expect.
const SYSTEM_PROMPT = `You are a collectible trading card identifier. You receive a photo of a single trading card (Pokémon TCG, Magic: The Gathering, or Disney Lorcana) and must identify it and extract its objective data.

Respond with ONLY a JSON object (no markdown, no code fences, no prose) using exactly these keys:
{
  "name": "the searchable card name in English, e.g. 'Charizard'",
  "printed_name": "the card name exactly as printed on the card, in its own language",
  "set": "the full name of the set/edition printed on the card, e.g. 'Base Set'",
  "set_code": "the 2-6 character set code printed on the card if visible, e.g. 'BS', 'SV1', 'FDN'; otherwise empty string",
  "number": "the collector number as printed, WITHOUT the set size, e.g. '4' not '4/102'; otherwise empty string",
  "language": "the language the card is printed in, as an English language name, e.g. 'English', 'Japanese', 'Spanish'",
  "game": "one of 'pokemon', 'mtg', 'lorcana', or 'unknown'",
  "rarity": "the rarity if visible, e.g. 'Common', 'Rare Holo', 'Mythic Rare'; otherwise empty string",
  "confidence": a number from 0 to 1 for how sure you are of the identification
}

Rules:
- Never invent a set, number, or name you cannot read. Leave a field as an empty string instead.
- The "name" is always the English name even for a non-English card; "printed_name" keeps the printed text.
- Do not add explanation or extra keys. Output the JSON object and nothing else.`;

function buildUserPrompt({ game, lang, setHint } = {}) {
  const bits = [];
  if (GAMES.includes(game)) bits.push(`The user says the game is: ${game}.`);
  if (lang) bits.push(`The user says the card language is: ${lang}.`);
  if (setHint) bits.push(`The user has narrowed the scan to these set codes, which may help: ${setHint}.`);
  bits.push('Identify this card.');
  return bits.join(' ');
}

function toDataUrl(image) {
  const s = String(image || '');
  if (!s) return '';
  if (s.startsWith('data:')) return s;
  // A bare base64 payload arrives without a prefix when a caller strips it; put
  // the common JPEG one back so the endpoint can decode it.
  return `data:image/jpeg;base64,${s}`;
}

// Build the chat-completions URL from whatever the admin entered. People paste
// either the API base ("https://api.openai.com/v1") or the full endpoint
// ("https://api.deepseek.com/chat/completions"); appending blindly produced
// ".../chat/completions/chat/completions" and a 404. Accept both.
function endpointUrl(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`;
}

// Models wrap JSON in prose or fences often enough that a bare JSON.parse is a
// coin flip. Take the outermost {...} and parse that; if there is none, fail
// loudly rather than returning a half-answer.
function parseJson(content) {
  if (!content) throw new Error('vision model returned no content');
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('vision model did not return JSON');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`vision model returned invalid JSON: ${e.message}`);
  }
}

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null);

// Coerce whatever the model said into the fixed shape the route and client use.
// A missing game falls back to the game the user was scanning; an unknown one
// never does, because a wrong game would search the wrong provider.
function normalize(raw, opts = {}) {
  const rawGame = str(raw.game).toLowerCase();
  const game = GAMES.includes(rawGame) ? rawGame : (GAMES.includes(opts.game) ? opts.game : null);
  const name = str(raw.name) || str(raw.printed_name);
  return {
    name,
    printed_name: str(raw.printed_name) || name,
    set: str(raw.set),
    set_code: str(raw.set_code),
    number: str(raw.number),
    language: str(raw.language),
    game,
    rarity: str(raw.rarity),
    confidence: clamp01(Number(raw.confidence)),
  };
}

// Identify a card from an image (data URL or bare base64). Throws on transport
// or parse failure so the route can report it; returns the normalized identity
// otherwise. It does NOT resolve the identity to a catalog card — that is the
// caller's job, because it needs the database and the providers.
async function identify(image, opts = {}) {
  const { baseUrl, model, apiKey } = await config();
  const dataUrl = toDataUrl(image);
  if (!dataUrl) throw new Error('missing image');

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const resp = await axios.post(endpointUrl(baseUrl), {
    model,
    temperature: 0,
    max_tokens: 400,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildUserPrompt(opts) },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  }, { headers, timeout: TIMEOUT_MS });

  const content = resp.data && resp.data.choices && resp.data.choices[0]
    && resp.data.choices[0].message && resp.data.choices[0].message.content;
  return normalize(parseJson(content), opts);
}

module.exports = {
  identify,
  config,
  isConfigured,
  parseJson,
  normalize,
  endpointUrl,
  AUTO_ADD_CONFIDENCE,
  MIN_CONFIDENCE,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
};
