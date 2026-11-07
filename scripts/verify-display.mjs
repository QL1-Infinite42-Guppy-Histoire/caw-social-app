/* Verification for the v0.1.3 display fix. Run: node scripts/verify-display.mjs
 *
 * Background (user instruction 2026-11-07 21:03 JST: "get rid of the
 * shift confusion itself"): on QL1, CawName's tokenURI metadata is
 * shifted by one id — token 190's card (name field AND the picture
 * metadata) says "neptune" while the registry usernames(190) is
 * "loveforqom", and token 189's card says "dreamin" while
 * usernames(189) is "neptune". v0.1.2 unified every NAME LABEL on
 * the registry (usernames(id)); v0.1.3 removes the last shifted
 * display source: the tokenURI picture that Avatar used to render.
 * Avatars are now generated on-device from the registry name
 * (avatarSpec: initial letter + colour), with a user's own
 * off-chain custom picture still taking priority.
 *
 * This script checks, against live chain data:
 *   1. statically: no functional tokenURI use remains in src/
 *      (no avatarFor, no SEL.tokenURI, no raw selector);
 *   2. the trap is real: tokenURI(189/190) name fields disagree
 *      with usernames(189/190) — the reason the picture was dropped;
 *   3. every app surface resolves ids 188/189/190 to usernames(id):
 *      resolveName (timeline / profile / quote labels), tokensOf
 *      (name picker, my-names list, compose "post as", timeline
 *      acting label) — for the f8cc wallet, id 190 shows ONLY as
 *      "loveforqom" and no row anywhere is labelled "neptune";
 *   4. avatarSpec derives letter + colour from the registry name.
 *
 * No keys, no sends — reads and local logic only.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BUILD = new URL('./.build-display', import.meta.url).pathname;
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

/* ---------- 1. static audit: no functional tokenURI use in src/ ---------- */
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}
const files = [...walk(join(ROOT, 'src')), join(ROOT, 'App.tsx')];
const badPatterns = [/avatarFor/, /SEL\.tokenURI/, /0xc87b56dd/];
let offenders = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const re of badPatterns) {
    if (re.test(text)) offenders.push(f.replace(ROOT, '') + ' ~ ' + re);
  }
}
check('static: no avatarFor / SEL.tokenURI / raw tokenURI selector in src/',
  offenders.length === 0, offenders.join('; '));

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

const USER = '0x75bb70588b1de571487C4e6dd62546765B7c55e2';   // owns 189 (registry: neptune)
const F8CC = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC';   // owns 190 (registry: loveforqom)

// Ground-truth reads get retries too: a transient RPC hiccup on the
// oracle side must not masquerade as an app mismatch. A consistent
// disagreement still fails after the retries.
const usernamesDirect = async (id) =>
  api.withRetry(() => api.readStr(CAW_NAME, '0x136dd963' + core.word(id)), 3, 500);
async function tokenUriName(id) {
  const uri = await api.readStr(CAW_NAME, '0xc87b56dd' + core.word(id));
  if (!uri.startsWith('data:application/json;base64,')) return null;
  const meta = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
  return meta.name || null;
}

/* ---------- 2. the trap: tokenURI disagrees with the registry ---------- */
try {
  const [u189, u190, t189, t190] = [
    await usernamesDirect(189n), await usernamesDirect(190n),
    await tokenUriName(189n), await tokenUriName(190n),
  ];
  check('registry truth: usernames(189)="neptune", usernames(190)="loveforqom"',
    u189 === 'neptune' && u190 === 'loveforqom', `189=${u189} 190=${u190}`);
  check('evidence: tokenURI(190) name is the shifted "neptune" (not loveforqom)',
    t190 === 'neptune', 'tokenURI(190).name=' + JSON.stringify(t190));
  check('evidence: tokenURI(189) name is the shifted "dreamin" (not neptune)',
    t189 === 'dreamin', 'tokenURI(189).name=' + JSON.stringify(t189));
} catch (e) {
  check('tokenURI trap evidence', false, String((e && e.message) || e));
}

/* ---------- 3. every surface resolves to usernames(id) ---------- */
try {
  for (const [id, want] of [[188n, 'dreamin'], [189n, 'neptune'], [190n, 'loveforqom']]) {
    const viaApp = await api.resolveName(id);
    const direct = await usernamesDirect(id);
    check(`resolveName(${id}) (timeline/profile label) = usernames(${id})`,
      viaApp === want && direct === want, `app=${viaApp} chain=${direct}`);
  }

  const f8 = await api.tokensOf(F8CC);
  const row190 = f8.find((t) => t.id === 190n);
  check('f8cc list (picker / my names / compose): id 190 labelled "loveforqom"',
    !!row190 && row190.username === 'loveforqom',
    row190 ? '@' + row190.username : 'row missing');
  check('f8cc list: NO row is labelled "neptune" (the shifted card text)',
    !f8.some((t) => t.username === 'neptune'));
  let allMatch = f8.length > 0;
  for (const t of f8) {
    let expected = null;
    try { expected = await usernamesDirect(t.id); } catch { /* reverted = unreadable name */ }
    if ((expected || '') !== t.username) allMatch = false;
  }
  check(`f8cc list: all ${f8.length} labels match usernames(id) exactly`, allMatch);

  const mine = await api.tokensOf(USER);
  check('user list: exactly [189 "neptune"], no 190',
    mine.length === 1 && mine[0].id === 189n && mine[0].username === 'neptune',
    mine.map((t) => '#' + t.id + ' @' + t.username).join(', '));
} catch (e) {
  check('live display resolution', false, String((e && e.message) || e));
}

/* ---------- 4. generated avatar derives from the registry name ---------- */
try {
  const sN = core.avatarSpec('neptune', 189n);
  const sL = core.avatarSpec('loveforqom', 190n);
  const sD = core.avatarSpec('dreamin', 188n);
  check('avatarSpec letters come from the registry name (N / L / D)',
    sN.letter === 'N' && sL.letter === 'L' && sD.letter === 'D',
    `neptune=${sN.letter} loveforqom=${sL.letter} dreamin=${sD.letter}`);
  check('avatarSpec is deterministic (same name -> same colour)',
    core.avatarSpec('neptune', 189n).bg === sN.bg && !!sN.bg);
  check('avatarSpec for an unreadable name falls back to "?" + id colour',
    core.avatarSpec('', 3914n).letter === '?' && !!core.avatarSpec(null, 3914n).bg);
  // the letter shown for id 190 anywhere in the app can only ever be
  // the registry initial: resolveName(190) feeds avatarSpec.
  const reg190 = await api.resolveName(190n);
  check('avatar for id 190 is generated from "loveforqom" (letter L), never "neptune"',
    core.avatarSpec(reg190, 190n).letter === 'L', 'registry name=' + reg190);
} catch (e) {
  check('avatarSpec checks', false, String((e && e.message) || e));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
