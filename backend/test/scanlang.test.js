// A scanned card must come back in the language being scanned.
//
// Card ART is identical in every language, so a scanner reads a card whatever
// language it is printed in, and the provider row it lands on is often the
// English printing. The scan route re-expresses that answer via getPrintingInLang;
// without it a Japanese scan filed an English printing, with English art and an
// English name, no matter what Card Language was set to.
//
// Scryfall is stubbed: this checks the lookup asks for the right thing and
// classifies the answer correctly, not that Scryfall is up.
const assert = require('assert');

process.env.DB_PATH = require('path').join(
  require('os').tmpdir(), `bindarr-scanlang-${process.pid}.db`
);

(async () => {
  const scryfall = require('../src/scryfallApi');
  const db = require('../src/db');
  await db.initDb();

  const requested = [];
  // The card endpoint's language form: /cards/:code/:number/:lang.
  scryfall.client.get = async (url) => {
    requested.push(url);
    const m = url.match(/^\/cards\/([^/]+)\/([^/]+)\/([^/?]+)/);
    if (!m) throw Object.assign(new Error('unexpected url'), { response: { status: 404 } });
    const [, set, number, lang] = m;
    // Alpha was never printed outside English — the real 404 case.
    if (set === 'lea') throw Object.assign(new Error('not found'), { response: { status: 404 } });
    return {
      data: {
        id: `${set}-${number}-${lang}`, lang,
        name: 'Ancestral Katana', printed_name: lang === 'ja' ? '祖先の刀' : 'Katana der Ahnen',
        set, set_name: 'Kamigawa: Neon Dynasty', collector_number: number,
        image_uris: { normal: `https://cards.scryfall.io/${lang}.jpg` },
        rarity: 'common', prices: {},
      },
    };
  };

  const ja = await scryfall.getPrintingInLang('neo', '1', 'Japanese');
  assert.ok(ja, 'a Japanese printing should resolve');
  assert.strictEqual(ja.language, 'Japanese', 'row must be tagged Japanese');
  assert.strictEqual(ja.printed_name, '祖先の刀', 'printed_name carries the localized name');
  assert.match(ja.image_url, /ja\.jpg$/, 'art must be the Japanese printing');
  assert.strictEqual(requested[0], '/cards/neo/1/ja', 'asks Scryfall by set+number+lang');

  // English resolves like any other language, or a copy set back to English stays
  // on the localized printing (#73). The Japanese lookup above already cached it,
  // as the price to fall back on, so it costs no request.
  const before = requested.length;
  const english = await scryfall.getPrintingInLang('neo', '1', 'English');
  assert.strictEqual(english && english.language, 'English', 'English printing resolves');
  assert.strictEqual(requested.length, before, 'served from card_cache');
  assert.ok(requested.includes('/cards/neo/1/en'), 'the unpriced Japanese printing fetched its English sibling');

  // Never printed in that language: null, so the caller keeps the English card
  // rather than showing nothing.
  assert.strictEqual(await scryfall.getPrintingInLang('lea', '1', 'Japanese'), null);

  // Second call for the same printing is served from card_cache.
  const cachedAt = requested.length;
  const again = await scryfall.getPrintingInLang('neo', '1', 'Japanese');
  assert.strictEqual(again.printed_name, '祖先の刀');
  assert.strictEqual(requested.length, cachedAt, 'cached printing must not re-request');

  // ---- Pokémon ----------------------------------------------------------
  //
  // Same defect, different mapping. A TCGdex id carries its language
  // (tcgdex-<lang>-<set>-<number>) and Western sets share one set id across
  // languages, so the localized card is addressed by swapping that segment.
  const tcgdex = require('../src/tcgdexApi');
  const asked = [];
  tcgdex.client.get = async (url) => {
    asked.push(url);
    const m = url.match(/^\/([a-z-]+)\/cards\/(.+)$/);
    if (!m) throw Object.assign(new Error('unexpected url'), { response: { status: 404 } });
    const [, lang, id] = m;
    // Japanese Pokémon sets are their own releases (S12, SV2a), not localized
    // editions of sv03 — so an English set id does not exist in Japanese.
    if (lang === 'ja') throw Object.assign(new Error('not found'), { response: { status: 404 } });
    return {
      data: {
        id, localId: id.split('-').pop(), category: 'Pokemon',
        name: lang === 'fr' ? 'Scovilain' : 'Halupenjo',
        set: { id: id.split('-')[0], name: 'Obsidian Flames' },
        image: `https://assets.tcgdex.net/${lang}/sv/sv03/025`,
        rarity: 'Rare', pricing: {},
      },
    };
  };

  const fr = await tcgdex.getPrintingInLang('tcgdex-en-sv03-025', 'French');
  assert.ok(fr, 'a French printing should resolve');
  assert.strictEqual(fr.id, 'tcgdex-fr-sv03-025', 'id swaps only the language segment');
  assert.strictEqual(fr.language, 'French');
  assert.strictEqual(fr.printed_name, 'Scovilain', 'localized name is what the card says');
  assert.match(fr.image_url, /\/fr\//, 'art must be the French printing');

  // Set does not exist in the target language: keep what the caller had.
  assert.strictEqual(await tcgdex.getPrintingInLang('tcgdex-en-sv03-025', 'Japanese'), null);
  // A pokemontcg.io id has no language segment, and its set numbering disagrees
  // with TCGdex's — no honest translation, so no guess.
  const beforePtcg = asked.length;
  assert.strictEqual(await tcgdex.getPrintingInLang('basep-50', 'French'), null);
  assert.strictEqual(asked.length, beforePtcg, 'a pokemontcg.io id must not be requested');
  // Already in the requested language: nothing to do.
  const beforeSame = asked.length;
  assert.strictEqual(await tcgdex.getPrintingInLang('tcgdex-ja-S12-001', 'Japanese'), null);
  assert.strictEqual(asked.length, beforeSame, 'same-language id must not be requested');

  console.log('scanlang.test.js: all 14 assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
