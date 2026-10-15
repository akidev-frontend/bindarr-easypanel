// Korean Pokémon cards via tcgexchange.kr (Dogam).
//
// Why this exists: TCGdex serves Korean card METADATA (names, numbers, sets)
// but ZERO Korean card IMAGES — its assets.tcgdex.net/ko/ paths all 404.
// The catalog build therefore skips every Korean set ("no card data upstream")
// and Korean scanning falls back to the English catalog, which cannot see
// Korea-exclusive sets.
//
// tcgexchange.kr is a Korean card database with 277 Korean sets / 20,187 cards,
// ALL with images (868x1212 PNG on Amazon S3), no API key, no rate limit.
// It also carries Japanese and English sets in the same structure, but this
// module is Korean-only: TCGdex already serves ja/en well.
//
// IDs: `tcgexchange-kr-<setCode>-<number>` (e.g. `tcgexchange-kr-SV4K-001`).
// The prefix routes through cardApi without touching pokemonProvider policy.
const axios = require('axios');
const db = require('./db');
const { cacheNormalizedCards } = require('./utils/cardCache');
const { parseCardRow } = require('./utils/priceHelpers');
const languages = require('./utils/languages');

const BASE = 'https://api.tcgexchange.kr/v1';
const PREFIX = 'tcgexchange-kr-';
const LANG = 'kr';

const client = axios.create({
  baseURL: BASE,
  timeout: 30000,
  headers: { Accept: 'application/json', 'User-Agent': `Bindarr/${require('../package.json').version}` },
});

// tcgexchange set codes are ALREADY the provider's own (SV4K, SM1M, ...), so the
// id is the set code itself. cardId() adds the prefix.
const cardId = (setId, number) => `${PREFIX}${setId}-${number}`;
const providerId = (id) => String(id || '').replace(new RegExp(`^${PREFIX}`), '');

// Split `tcgexchange-kr-SV4K-001` back into set code and number.
function splitId(id) {
  const rest = providerId(id);
  const m = rest.match(/^(.+)-(\d+)$/);
  return m ? { setId: m[1], number: m[2] } : { setId: rest, number: '' };
}

// A tcgexchange card -> the card_cache shape.
//
// `name` = English name (searchable from any language); `printed_name` = Korean
// (what's on the card). Same two-name contract as Scryfall/TCGdex.
function normalizeCard(card, setName, setCode) {
  const code = languages.toCode('ko');
  const name = card.name || '';
  const printedName = card.name_ko || name;
  return {
    id: cardId(setCode || card.set_code, card.number),
    name,
    printed_name: printedName,
    supertype: card.species || '',       // tcgexchange has species, not supertype
    subtypes: [],
    types: [],
    rarity: card.rarity || 'Common',
    set_id: setCode || card.set_code || '',
    set_name: setName || card.set_name || '',
    number: String(card.number ?? ''),
    image_url: card.image_url || '',
    game: 'pokemon',
    language: languages.toName(code),
    price_trend: null,                   // tcgexchange has no prices; TCGCSV can fill later
    price_normal: null,
    price_holofoil: null,
    price_reverse_holofoil: null,
    price_avg1: null, price_avg7: null, price_avg30: null,
    price_currency: null,
    price_source: null,
    cmc: null,
    color_identity: [],
    tcgplayer_url: null,
    cardmarket_url: null,
  };
}

// Every Korean set, shaped like the other providers' listSets().
async function listSets(lang = 'ko') {
  const { data } = await client.get('/catalog/sets', { params: { language: LANG } });
  const sets = (data?.sets || [])
    // A handful of legacy sets (6 of 277) have no set_code upstream — they cannot
    // be addressed by /sets/{id}/cards and would break cacheSetCards's absence
    // handling. Skip them rather than let a null id reach card_cache.
    .filter(s => s.set_code)
    .map(s => ({
    id: s.set_code,
    name: s.name,
    series: s.era || '',
    printed_total: s.printed_total || 0,
    total: s.card_count || 0,
    release_date: String(s.release_date || '').replace(/-/g, '/'),
    ptcgo_code: '',
    symbol_url: s.symbol_url || '',
    logo_url: s.logo_url || '',
    game: 'pokemon',
  }));
  return sets;
}

// All cards in one Korean set. One request per set (no pagination — verified:
// even the 774-card MC set returns in a single response).
//
// Case-insensitive on purpose: catalog.start() lowercases every set id once when
// it builds the job (so neither phase has to think about case), and tcgexchange
// set codes are uppercase (SV4K). An exact match would silently miss every set
// the build walks and report "no card data upstream" — the same failure the old
// TCGdex Korean path had.
async function getCardsBySet(setCode, lang = 'ko') {
  const wanted = String(setCode || '').toLowerCase();
  const { data } = await client.get('/catalog/sets', { params: { language: LANG } });
  const set = (data?.sets || []).find(s => String(s.set_code || '').toLowerCase() === wanted);
  if (!set) return [];
  const { data: cd } = await client.get(`/catalog/sets/${encodeURIComponent(set.id)}/cards`);
  const cards = (cd?.cards || []);
  return cards.map(c => normalizeCard(c, set.name, set.set_code));
}

// searchCards: match the other providers' interface so routes/collection.js
// can call it without a language branch. Filters on set/number/name.
async function searchCards({ name = '', number = '', set = '', lang = 'ko', limit = 60, page = 1 } = {}) {
  const code = languages.toCode(lang);
  if (code !== 'ko') return { cards: [], total: null };

  // Set-scoped search reads the whole set in one request (same pattern as TCGdex).
  if (set) {
    const setCodes = String(set).split(',').map(s => s.trim()).filter(Boolean);
    const all = [];
    for (const sc of setCodes) {
      const cards = await getCardsBySet(sc, code).catch(() => []);
      all.push(...cards);
    }
    const filtered = all.filter(c =>
      (!number || sameNumber(c.number, number)) &&
      (!name || c.name.toLowerCase().includes(name.toLowerCase()) ||
        c.printed_name.toLowerCase().includes(name.toLowerCase()))
    );
    const offset = (page - 1) * limit;
    return { cards: filtered.slice(offset, offset + limit), total: filtered.length };
  }

  // Name-only search: walk sets until enough matches (bounded).
  if (name) {
    const sets = await listSets(code).catch(() => []);
    const matches = [];
    for (const s of sets) {
      if (matches.length >= limit * page) break;
      const cards = await getCardsBySet(s.id, code).catch(() => []);
      const hit = cards.filter(c =>
        c.name.toLowerCase().includes(name.toLowerCase()) ||
        c.printed_name.toLowerCase().includes(name.toLowerCase())
      );
      matches.push(...hit);
    }
    const offset = (page - 1) * limit;
    return { cards: matches.slice(offset, offset + limit), total: matches.length };
  }

  return { cards: [], total: null };
}

const sameNumber = (a, b) => {
  const x = String(a || '').replace(/^0+/, '');
  const y = String(b || '').replace(/^0+/, '');
  return x === y;
};

async function getCardById(id) {
  const cached = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [id]);
  if (cached) return parseCardRow(cached);
  const { setId, number } = splitId(id);
  if (!setId || !number) return null;
  const cards = await getCardsBySet(setId).catch(() => []);
  const card = cards.find(c => sameNumber(c.number, number));
  if (card) await cacheNormalizedCards([card], 'pokemon');
  return card || null;
}

// Fetch-and-cache sets into the `sets` table (called from server.js at boot).
async function fetchAndCacheSets(force = false) {
  try {
    const existing = await db.get(`SELECT COUNT(*) n FROM sets WHERE game = 'pokemon' AND id LIKE ?`, [`${PREFIX}%`]);
    // tcgexchange set ids are already bare (SV4K); prefix them in the table so
    // they don't collide with TCGdex ids (sv4k vs SV4K are the same set).
    if (!force && existing && existing.n > 0) {
      console.log(`Korean sets already populated (${existing.n}). Skipping tcgexchange fetch.`);
      return;
    }
    console.log('Fetching Korean sets from tcgexchange.kr...');
    const sets = await listSets('ko');
    if (!sets.length) throw new Error('tcgexchange returned no sets');
    for (const s of sets) {
      await db.run(
        `INSERT OR REPLACE INTO sets (id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url, game)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 'pokemon')`,
        [`${PREFIX}${s.id}`, s.name, s.series, s.printed_total, s.total, s.release_date, s.symbol_url, s.logo_url]
      );
    }
    console.log(`Cached ${sets.length} Korean sets from tcgexchange.kr.`);
  } catch (error) {
    console.error('tcgexchange set sync:', error.message);
  }
}

// Price sweep: tcgexchange has no prices. TCGCSV can price Korean cards off the
// English catalogue (tcgcsvApi already handles non-English languages), so this
// is a no-op that keeps the interface consistent.
async function updateCollectionPrices() { /* no prices from tcgexchange */ }

module.exports = {
  client, listSets, getCardsBySet, searchCards, getCardById,
  fetchAndCacheSets, updateCollectionPrices, normalizeCard, cardId, providerId, splitId,
};
