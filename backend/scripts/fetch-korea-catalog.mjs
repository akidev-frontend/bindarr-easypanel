// Build the bundled Korean card catalog from tcgexchange.kr.
//
// Korean Pokémon cards: TCGdex serves their metadata but ZERO Korean images, and
// Korea gets its own sets rather than localised editions of the Western ones. The
// app therefore ships a compact snapshot of the whole Korean catalog so Korean
// search and scanning work with no download, no API key and no network at
// runtime.
//
//   node scripts/fetch-korea-catalog.mjs
//
// Writes shared/pokemonKoreaCatalog.json. Re-run it to refresh (a few hundred
// requests against a free, unauthenticated endpoint). The file is generated, not
// hand-edited.
//
// Cards are stored as arrays, not objects, because 20k rows of repeated JSON keys
// is several MB of pure overhead: [setCode, number, name, name_ko, rarity, image].
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const BASE = 'https://api.tcgexchange.kr/v1';
const OUT = path.join(import.meta.dirname, '..', '..', 'shared', 'pokemonKoreaCatalog.json');
const CONCURRENCY = 6;

const get = async (url) => {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Bindarr/catalog-build' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
};

// Small promise pool: 6 at a time is polite to a free endpoint and still finishes
// the 277 sets in well under a minute.
async function pool(items, worker, size) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

async function main() {
  console.log(`Fetching Korean sets from ${BASE} ...`);
  const { sets: rawSets } = await get(`${BASE}/catalog/sets?language=kr`);
  const sets = (rawSets || []).filter(s => s.set_code);
  console.log(`  ${sets.length} sets`);

  let done = 0;
  const cards = [];
  await pool(sets, async (s) => {
    try {
      const { cards: cs } = await get(`${BASE}/catalog/sets/${encodeURIComponent(s.id)}/cards`);
      for (const c of cs || []) {
        cards.push([s.set_code, String(c.number ?? ''), c.name || '', c.name_ko || '', c.rarity || '', c.image_url || '']);
      }
    } catch (e) {
      console.warn(`  ${s.set_code}: ${e.message}`);
    }
    done++;
    if (done % 25 === 0) process.stdout.write(`  ${done}/${sets.length} sets, ${cards.length} cards\r`);
  }, CONCURRENCY);

  const out = {
    generatedAt: new Date().toISOString(),
    source: BASE,
    language: 'ko',
    sets: sets.map(s => ({
      code: s.set_code,
      name: s.name || '',
      name_ko: s.name_ko || '',
      era: s.era || '',
      releaseDate: String(s.release_date || '').replace(/-/g, '/'),
      printedTotal: s.printed_total || 0,
      cardCount: s.card_count || (s.available || 0),
      symbol: s.symbol_url || '',
      logo: s.logo_url || '',
    })),
    cards,
  };

  fs.writeFileSync(OUT, JSON.stringify(out));
  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(2);
  console.log(`\nWrote ${OUT}`);
  console.log(`  ${out.sets.length} sets, ${cards.length} cards, ${mb} MB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
