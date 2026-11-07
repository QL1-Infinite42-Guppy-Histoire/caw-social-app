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
    '--outDir', BUILD, '--module', 'commonjs', '--target', 'es2022',
    '--esModuleInterop', '--skipLibCheck',
  ],
  { stdio: 'inherit', cwd: ROOT },
);
const core = require(BUILD + '/lib/cawCore.js');
const api = require(BUILD + '/lib/cawApi.js');
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
