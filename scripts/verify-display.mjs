/* Verification for name display. Run: node scripts/verify-display.mjs
 *
 * CORRECTED BACKGROUND (v0.1.3): which name source is true was
 * settled by the mint transactions — Minter.mint("dreamin")
 * created token 189 (tx 0xc4ac11ad…, block 5189285) and
 * Minter.mint("neptune") created token 190 (tx 0x9c374074…, block
 * 5189287), exactly the names on the tokens' CARDS (tokenURI).
 * The shifted getter is usernames(): usernames(n) returns token
 * n+1's name (usernames(190) = "loveforqom", which belongs to
 * #191). v0.1.2 wrongly standardised on usernames(id); v0.1.3
 * standardises every display on the CARD name (fallback:
 * usernames(id − 1), the corrected slot), and the avatar picture
 * comes from the same card metadata, so picture and caption can
 * never describe different names again.
 *
 * This script checks, against live chain data:
 *   1. statically: the card is wired in as the name source
 *      (readCardName + SEL.tokenURI in cawApi, avatarFor in ui.tsx);
 *   2. the trap: usernames() disagrees with the cards for ids
 *      189/190/191, while the cards match the mint records;
 *   3. every app surface resolves ids 188–191 to their CARD names:
 *      resolveName (timeline / profile / quote labels), tokensOf
 *      (name picker, my-names list, compose "post as", timeline
 *      acting label) — for the f8cc wallet, #190 shows ONLY as
 *      "neptune" and no row is labelled "loveforqom";
 *   4. the fallback law: usernames(id − 1) == card(id);
 *   5. avatarSpec letters derive from the card name.
 *   6. (v0.4.9) the avatar PICTURE path for a NON-own name: the
 *      card image is a base64 SVG data URI; svgFromImageUri
 *      must decode it to real SVG carrying the name's own
 *      text. The pre-fix Avatar ran decodeURIComponent over
 *      the base64 payload and handed base64 text to the SVG
 *      renderer, which rendered nothing — and because the
 *      element was already assigned, the letter fallback
 *      never ran: plain gray circles for every name without
 *      an on-device custom picture (user report, 2026-11-10).
 *      Also pinned: another user's device-local customization
 *      is ABSENT here (by design — it lives only on their
 *      phone), never faked.
 *   7. (v0.4.10) the balance GRID on both cards: one shared
 *      BalanceGrid per card, cells in the approved mock order
 *      (wallet CAW, QOM, in-name CAW, [42], CAT42, O, KET,
 *      empty); the B/M abbreviation (truncated, never rounded,
 *      boundaries pinned); the exact figure behind a tap; the
 *      O / KET reads under the v0.4.7 null rule with decimals
 *      read from the contracts (stubbed + live); and CAT42's
 *      caption switched to the tip wording in all 13 locales.
 *
 * No keys, no sends — reads and local logic only.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname;
const BUILD = new URL('./.build-display', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

/* ---------- 1. static audit: the card is the name source ---------- */
const cawApiSrc = readFileSync(ROOT + 'src/lib/cawApi.ts', 'utf8');
const uiSrc = readFileSync(ROOT + 'src/components/ui.tsx', 'utf8');
const configSrc = readFileSync(ROOT + 'src/config.ts', 'utf8');
check('static: cawApi resolves names via the card (readCardName + SEL.tokenURI)',
  /readCardName/.test(cawApiSrc) && /SEL\.tokenURI/.test(cawApiSrc));
check('static: config carries the tokenURI selector',
  /tokenURI: '0xc87b56dd'/.test(configSrc));
check('static: Avatar renders the card picture (avatarFor) in ui.tsx',
  /avatarFor\(nameId\)/.test(uiSrc));

/* ---------- build the modules under test ---------- */
execFileSync(
  'npx',
  [
    'tsc', '--ignoreConfig',
    'src/config.ts', 'src/lib/cawCore.ts', 'src/lib/cawApi.ts',
    'src/lib/profileCustom.ts',
    '--outDir', BUILD, '--module', 'commonjs', '--target', 'es2022',
    '--esModuleInterop', '--skipLibCheck',
  ],
  { stdio: 'inherit', cwd: ROOT },
);
const core = require(BUILD + '/lib/cawCore.js');
const api = require(BUILD + '/lib/cawApi.js');
const { ProfileCustomStore } = require(BUILD + '/lib/profileCustom.js');
const { CAW_NAME } = require(BUILD + '/config.js');

const WALLET_A = '0x75bb70588b1de571487C4e6dd62546765B7c55e2'; // owns 189 (card: dreamin)
const F8CC = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC';     // owns 190 (card: neptune)

// Ground-truth oracles, read raw (retries: a transient RPC hiccup on
// the oracle side must not masquerade as an app mismatch).
const cardDirect = async (id) => {
  const uri = await api.withRetry(
    () => api.readStr(CAW_NAME, '0xc87b56dd' + core.word(id)), 3, 500);
  if (!uri.startsWith('data:application/json;base64,')) return null;
  return JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8')).name || null;
};
const usernamesDirect = async (id) =>
  api.withRetry(() => api.readStr(CAW_NAME, '0x136dd963' + core.word(id)), 3, 500);

/* ---------- 2. the trap: usernames() vs the cards (mint truth) ---------- */
try {
  const [c189, c190, c191, u189, u190, u191] = [
    await cardDirect(189n), await cardDirect(190n), await cardDirect(191n),
    await usernamesDirect(189n), await usernamesDirect(190n), await usernamesDirect(191n),
  ];
  check('card truth (== mint records): #189 dreamin, #190 neptune, #191 loveforqom',
    c189 === 'dreamin' && c190 === 'neptune' && c191 === 'loveforqom',
    `cards: ${c189}/${c190}/${c191}`);
  check('evidence: usernames() is the shifted one (189→neptune, 190→loveforqom, 191→nakamoto)',
    u189 === 'neptune' && u190 === 'loveforqom' && u191 === 'nakamoto',
    `usernames: ${u189}/${u190}/${u191}`);
} catch (e) {
  check('card vs usernames evidence', false, String((e && e.message) || e));
}

/* ---------- 3. every surface resolves to the card name ---------- */
try {
  for (const [id, want] of [[188n, 'lionelmessi'], [189n, 'dreamin'], [190n, 'neptune'], [191n, 'loveforqom']]) {
    const viaApp = await api.resolveName(id);
    const direct = await cardDirect(id);
    check(`resolveName(${id}) (timeline/profile label) = card(${id})`,
      viaApp === want && direct === want, `app=${viaApp} card=${direct}`);
  }

  const f8 = await api.tokensOf(F8CC);
  const row190 = f8.find((t) => t.id === 190n);
  check('f8cc list (picker / my names / compose): id 190 labelled "neptune"',
    !!row190 && row190.username === 'neptune',
    row190 ? '@' + row190.username : 'row missing');
  check('f8cc list: NO row is labelled "loveforqom" (that is #191, not owned here)',
    !f8.some((t) => t.username === 'loveforqom'));
  let allCard = f8.length > 0;
  for (const t of f8) {
    let expected = null;
    try { expected = await cardDirect(t.id); } catch { /* unreadable card */ }
    if ((expected || '') !== t.username) allCard = false;
  }
  check(`f8cc list: all ${f8.length} labels match the card names exactly`, allCard);

  const a = await api.tokensOf(WALLET_A);
  check('wallet A list: exactly [189 "dreamin"], no 190',
    a.length === 1 && a[0].id === 189n && a[0].username === 'dreamin',
    a.map((t) => '#' + t.id + ' @' + t.username).join(', '));
} catch (e) {
  check('live display resolution', false, String((e && e.message) || e));
}

/* ---------- 4. fallback law: usernames(id − 1) == card(id) ---------- */
try {
  let law = true;
  for (const id of [189n, 190n, 191n]) {
    if ((await usernamesDirect(id - 1n)) !== (await cardDirect(id))) law = false;
  }
  check('fallback law holds: usernames(id-1) equals the card name (ids 189–191)', law);
} catch (e) {
  check('fallback law', false, String((e && e.message) || e));
}

/* ---------- 5. fallback avatar derives from the card name ---------- */
try {
  const n189 = await api.resolveName(189n);
  const n190 = await api.resolveName(190n);
  const n191 = await api.resolveName(191n);
  check('avatarSpec letters come from the card names (D / N / L)',
    core.avatarSpec(n189, 189n).letter === 'D' &&
    core.avatarSpec(n190, 190n).letter === 'N' &&
    core.avatarSpec(n191, 191n).letter === 'L',
    `189=${n189} 190=${n190} 191=${n191}`);
  check('avatarSpec is deterministic (same name -> same colour)',
    core.avatarSpec('neptune', 190n).bg === core.avatarSpec('neptune', 190n).bg &&
    !!core.avatarSpec('neptune', 190n).bg);
  const pic = await api.avatarFor(190n);
  check('avatarFor(190) returns the card picture for the timeline/profile avatar',
    typeof pic === 'string' && pic.length > 0,
    pic ? pic.slice(0, 32) + '…' : 'null');
} catch (e) {
  check('avatar checks', false, String((e && e.message) || e));
}

/* ---------- 6. (v0.4.9) the card picture DECODE — non-own names ---------- */
{
  check('static: Avatar decodes the card picture via svgFromImageUri (ui.tsx)',
    /svgFromImageUri\(img\)/.test(uiSrc));
  check('static: the base64-as-percent-encoding decode is gone from the avatar path',
    !/decodeURIComponent\(img\.split/.test(uiSrc));

  // Pure fixtures first (no chain): the two data-URI shapes and
  // the honest-null cases that must fall through to the letter.
  const svgText = '<svg xmlns="http://www.w3.org/2000/svg" width="270" height="270"><text>guppy</text></svg>';
  const b64 = Buffer.from(svgText, 'utf8').toString('base64');
  check('decode: base64 SVG data URI -> the SVG text itself',
    core.svgFromImageUri('data:image/svg+xml;base64,' + b64) === svgText);
  check('decode: percent-encoded SVG data URI -> the SVG text itself',
    core.svgFromImageUri('data:image/svg+xml,' + encodeURIComponent(svgText)) === svgText);
  check('decode: garbage base64 -> null (letter fallback, not a dead element)',
    core.svgFromImageUri('data:image/svg+xml;base64,!!!not-base64!!!') === null);
  check('decode: base64 of non-SVG text -> null',
    core.svgFromImageUri('data:image/svg+xml;base64,' +
      Buffer.from('hello world', 'utf8').toString('base64')) === null);
  check('decode: a remote URL is not an SVG data URI -> null',
    core.svgFromImageUri('https://example.com/a.png') === null);
  check('decode: null / empty -> null',
    core.svgFromImageUri(null) === null && core.svgFromImageUri('') === null);

  // The live path for names owned by OTHER wallets (this device
  // holds neither): avatarFor reads the card, svgFromImageUri
  // must yield the real card art carrying the name's own text.
  try {
    for (const [id, want] of [[410n, 'guppy'], [190n, 'neptune']]) {
      const pic = await api.avatarFor(id);
      const svg = pic ? core.svgFromImageUri(pic) : null;
      check(`live: avatar of non-own #${id} decodes to its card SVG ("${want}")`,
        typeof svg === 'string' && svg.trim().startsWith('<svg') &&
          svg.includes('>' + want + '<'),
        svg ? svg.slice(0, 40) + '…' : 'null');
    }
  } catch (e) {
    check('live non-own avatar decode', false, String((e && e.message) || e));
  }

  // By design, NOT a bug: profile customization lives only on
  // the owner's device. A store holding a custom for #190 must
  // answer "nothing" for #410 — absent, never faked.
  try {
    const kvMem = new Map([
      ['caw-profile-customs', JSON.stringify({
        '190': { avatarPath: 'file:///device/only-mine.png', displayName: 'Mine' },
      })],
    ]);
    const store = new ProfileCustomStore();
    await store.init({
      getItem: async (k) => kvMem.get(k) ?? null,
      setItem: async (k, v) => void kvMem.set(k, v),
    });
    check('customs: my own name keeps its on-device custom picture',
      !!store.get(190n) && store.get(190n).avatarPath === 'file:///device/only-mine.png');
    check('customs: another user\u2019s name has NO custom on this device (absent, not faked)',
      store.get(410n) === undefined);
  } catch (e) {
    check('customs absence', false, String((e && e.message) || e));
  }
}

/* ---------- 7. (v0.4.10) the balance grid ---------- */
{
  const tlSrc = readFileSync(ROOT + 'src/screens/TimelineScreen.tsx', 'utf8');
  const appSrc = readFileSync(ROOT + 'App.tsx', 'utf8');
  const cfgSrc = readFileSync(ROOT + 'src/config.ts', 'utf8');
  const ctxSrc = readFileSync(ROOT + 'src/context/AppContext.tsx', 'utf8');
  const i18nSrc = readFileSync(ROOT + 'src/i18n.ts', 'utf8');
  const apiSrc = readFileSync(ROOT + 'src/lib/cawApi.ts', 'utf8');

  check('grid: ui.tsx exports BalanceGrid with tap-to-exact wiring (fmtExactDec + open state + hint)',
    /export function BalanceGrid/.test(uiSrc) &&
    /fmtExactDec\(cell\.raw, dec\)/.test(uiSrc) &&
    /setOpen/.test(uiSrc) && /tr\('card\.tapHint'\)/.test(uiSrc));
  check('grid: cells show fmtCardDisplay (B/M abbreviation applied inside the grid)',
    /fmtCardDisplay\(cell\.raw, dec\)/.test(uiSrc));

  // Cell order pinned by the label sequence inside each card's
  // own <BalanceGrid cells={[ ... ]}> block (the approved mock).
  const labelIdx = (src) => {
    const at = src.indexOf('<BalanceGrid');
    const seg = src.slice(at, at + 1800);
    return [
      "tr('home.qcaw')", "tr('home.qom')", "tr('card.inName')",
      "tr('card.f42')", "tr('card.cat42')", "label: 'O'", "label: 'KET'",
    ].map((k) => seg.indexOf(k));
  };
  for (const [name, src] of [['Home card', tlSrc], ['name card', appSrc]]) {
    const idxs = labelIdx(src);
    check(`grid: ${name} renders ONE BalanceGrid, cells in mock order (CAW, QOM, in-name, 42, CAT42, O, KET)`,
      (src.match(/<BalanceGrid/g) || []).length === 1 &&
      idxs.every((v) => v >= 0) &&
      idxs.every((v, i) => i === 0 || v > idxs[i - 1]),
      'idx=' + idxs.join(','));
    check(`grid: ${name} completes the table with an empty 8th cell`,
      /'KET'[\s\S]{0,300}?\n\s+null,\n\s+\]/.test(src.slice(src.indexOf('<BalanceGrid'), src.indexOf('<BalanceGrid') + 1800)));
  }

  /* --- the B/M abbreviation: pure, boundaries + truncation --- */
  const T = (whole, frac18 = 0n) => BigInt(whole) * 10n ** 18n + frac18;
  check('abbr: the brief example 3,281,416,300.24 -> "3.28B"',
    core.fmtAmountAbbr(3281416300240000000000000000n, 18) === '3.28B');
  check('abbr: 99,939,279.89 -> "99.93M" (TRUNCATED per the rule; the mock\u2019s 99.94 was the rounded figure)',
    core.fmtAmountAbbr(99939279890000000000000000n, 18) === '99.93M');
  check('abbr: below a million there is no abbreviation (999,999 and 999,999.99)',
    core.fmtAmountAbbr(T(999999n), 18) === null &&
    core.fmtAmountAbbr(T(999999n, 990000000000000000n), 18) === null);
  check('abbr: exactly 1,000,000 -> "1.00M"; exactly 1e9 -> "1.00B"',
    core.fmtAmountAbbr(T(1000000n), 18) === '1.00M' &&
    core.fmtAmountAbbr(T(1000000000n), 18) === '1.00B');
  check('abbr: 999,999,999 -> "999.99M" (just under the B boundary)',
    core.fmtAmountAbbr(T(999999999n), 18) === '999.99M');
  check('abbr: truncation never rounds up (1.999M -> "1.99M", 3.289B -> "3.28B")',
    core.fmtAmountAbbr(T(1999000n), 18) === '1.99M' &&
    core.fmtAmountAbbr(T(3289000000n), 18) === '3.28B');
  check('abbr: honours the token\u2019s own decimals (1.5M at 6 decimals -> "1.50M"; same raw at 18 -> none)',
    core.fmtAmountAbbr(1500000000000n, 6) === '1.50M' &&
    core.fmtAmountAbbr(1500000000000n, 18) === null);
  check('display: below 1M the cell uses the card format; at/above it is flagged abbreviated',
    core.fmtCardDisplay(1011569804262003083182n, 18).text === '1,011.56' &&
    core.fmtCardDisplay(1011569804262003083182n, 18).abbreviated === false &&
    core.fmtCardDisplay(3281416300240000000000000000n, 18).text === '3.28B' &&
    core.fmtCardDisplay(3281416300240000000000000000n, 18).abbreviated === true);
  check('exact: the tap figure is digit-for-digit (CAT42 f8cc raw, dust, zero)',
    core.fmtExactDec(1011569804262003083182n, 18) === '1,011.569804262003083182' &&
    core.fmtExactDec(28350000000000n, 18) === '0.00002835' &&
    core.fmtExactDec(0n, 18) === '0' &&
    core.fmtExactDec(440000000000000000n, 18) === '0.44');
  check('exact: card format at foreign decimals (1.5 at 6 -> "1.50", the two-digit rule; integer at 0 -> separators)',
    core.fmtAmountCardDec(1500000n, 6) === '1.50' &&
    core.fmtAmountCardDec(1234567n, 0) === '1,234,567' &&
    core.fmtAmountCard(1011569804262003083182n) === '1,011.56');

  /* --- O / KET wiring --- */
  check('tokens: config pins the user-supplied O address and the table-resolved KET address',
    /O_TOKEN = '0x6c39b68a28bA90F4EB80032ec0eB32ad81cbbEd4'/.test(cfgSrc) &&
    /KET42 = '0xb749d42e6004db590b2f04f32b87485402a061e2'/.test(cfgSrc) &&
    /decimals: '0x313ce567'/.test(cfgSrc));
  check('tokens: O is read on QL1 (its chain), KET on 42 Chain — decimals from the contracts',
    /tokenQl1\(O_TOKEN\)/.test(apiSrc) && /token42\(KET42\)/.test(apiSrc) &&
    /SEL\.decimals/.test(apiSrc) && /interface TokenBalance/.test(apiSrc));
  check('tokens: refreshBalances stores O / KET only on success (guarded, v0.4.7 rule)',
    /if \(b\.oTok !== null\) setOTok\(b\.oTok\)/.test(ctxSrc) &&
    /if \(b\.ket !== null\) setKet\(b\.ket\)/.test(ctxSrc));

  /* --- O / KET behaviour under the null rule (selector-aware stub) --- */
  {
    const realFetch = globalThis.fetch;
    const ADDR = '0x0000000000000000000000000000000000000001';
    const w = (n) => '0x' + n.toString(16).padStart(64, '0');
    const stub = (mode) => async (_url, opts) => {
      if (mode === 'down') throw new Error('network down');
      const body = JSON.parse(opts.body);
      const data = (body.params && body.params[0] && body.params[0].data) || '';
      const result =
        body.method === 'eth_getBalance'
          ? w(10n ** 18n)
          : data.startsWith('0x313ce567')
            ? w(18n) // decimals()
            : w(2n * 10n ** 18n); // balanceOf
      return {
        json: async () =>
          mode === 'rpcError'
            ? { jsonrpc: '2.0', id: body.id, error: { message: 'boom' } }
            : { jsonrpc: '2.0', id: body.id, result },
      };
    };
    try {
      globalThis.fetch = stub('ok');
      const ok = await api.walletBalances(ADDR);
      check('tokens: successful O / KET reads return { raw, decimals } from the contracts',
        ok.oTok !== null && ok.oTok.raw === 2n * 10n ** 18n && ok.oTok.decimals === 18 &&
        ok.ket !== null && ok.ket.raw === 2n * 10n ** 18n && ok.ket.decimals === 18,
        'oTok=' + JSON.stringify(ok.oTok, (_, v) => typeof v === 'bigint' ? v.toString() : v));
      globalThis.fetch = stub('down');
      const down = await api.walletBalances(ADDR);
      check('tokens: failed O / KET reads return null — NEVER a numeric 0',
        down.oTok === null && down.ket === null);
      globalThis.fetch = stub('rpcError');
      const rerr = await api.walletBalances(ADDR);
      check('tokens: RPC-error O / KET reads return null — NEVER a numeric 0',
        rerr.oTok === null && rerr.ket === null);
    } catch (e) {
      check('tokens: O / KET failure semantics', false, String((e && e.message) || e));
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  /* --- live reads through the new code path (f8cc) --- */
  try {
    const b = await api.walletBalances(F8CC);
    check('live: f8cc O read (QL1 token at the user address; decimals from the contract; 0 as of 2026-11-10)',
      b.oTok !== null && b.oTok.decimals === 18 && b.oTok.raw === 0n,
      'oTok=' + (b.oTok ? `raw ${b.oTok.raw} dec ${b.oTok.decimals}` : 'null'));
    check('live: f8cc KET read (42 Chain; decimals from the contract; 0 as of 2026-11-10)',
      b.ket !== null && b.ket.decimals === 18 && b.ket.raw === 0n,
      'ket=' + (b.ket ? `raw ${b.ket.raw} dec ${b.ket.decimals}` : 'null'));
    check('live: f8cc CAT42 through the same reader (user screenshot: 1,011.56)',
      b.cat42 !== null && core.fmtAmountCard(b.cat42) === '1,011.56',
      'cat42=' + (b.cat42 !== null ? core.fmtAmountCard(b.cat42) : 'null'));
  } catch (e) {
    check('live f8cc new-path reads', false, String((e && e.message) || e));
  }

  /* --- CAT42 caption: tip wording everywhere --- */
  check('caption: card.cat42 + card.tapHint exist in all 20 language dicts',
    (i18nSrc.match(/'card\.cat42'/g) || []).length === 20 &&
    (i18nSrc.match(/'card\.tapHint'/g) || []).length === 20);
  check('caption: JA + EN carry the tip wording',
    /'card\.cat42': 'CAT42（チップ用）'/.test(i18nSrc) &&
    /'card\.cat42': 'CAT42 \(for tips\)'/.test(i18nSrc));
  check('caption: NO locale describes the CAT42 balance as "for SuperLike" any more',
    !/'card\.cat42': '[^']*(SuperLike|超いいね)/.test(i18nSrc));

  /* --- v0.5.0: HuntersExchange naming + 20 languages --- */
  const hsSrc = readFileSync(ROOT + '/src/screens/HuntersSwapScreen.tsx', 'utf8');
  check('naming: the brand header renders "Hunters" + "Exchange"',
    hsSrc.includes('>Exchange<') || hsSrc.includes('}Exchange{') || hsSrc.includes('Exchange</Text>'));
  check('naming: no user-visible "HuntersDEX" remains (comments only)',
    !/>\s*DEX\s*</.test(hsSrc) && !hsSrc.includes('"HuntersDEX"') &&
    !hsSrc.includes("'HuntersDEX'"));
  /* v0.5.0 formal: the candidate's swap/book mode toggle is
   * GONE (user: 「板だけにして」) — the screen renders the book
   * directly. The full reachability suite lives in
   * verify-exchange.mjs section 4. */
  check('naming: NO mode toggle — the screen opens directly on the order book (v0.5.0 formal)',
    !hsSrc.includes("tr('hx.modeSwap')") && !hsSrc.includes("tr('hx.modeBook')") &&
    !hsSrc.includes('hsMode') && hsSrc.includes('<ExchangeSection />'));
  const langsBlock = i18nSrc.slice(i18nSrc.indexOf('export const LANGS'), i18nSrc.indexOf('];', i18nSrc.indexOf('export const LANGS')));
  check('languages: LANGS offers exactly 20 languages',
    (langsBlock.match(/\{ code: '/g) || []).length === 20,
    'entries=' + (langsBlock.match(/\{ code: '/g) || []).length);
  check('languages: the 7 new locales are offered (vi th tr it nl pl uk + ar de ru…)',
    ['vi', 'th', 'tr', 'it', 'nl', 'pl', 'uk', 'de', 'ru', 'ar'].every((l) =>
      langsBlock.includes(`code: '${l}'`)));
  check('v0.5.0 actions: the tip button sits on the post card action row',
    uiSrc.includes("tr('tl.tip')") && uiSrc.includes('onTip'));
  check('v0.5.0 actions: the SuperRecaw badge renders on marked recaws',
    uiSrc.includes("tr('tl.superRecaw')") && uiSrc.includes('superFrame'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
