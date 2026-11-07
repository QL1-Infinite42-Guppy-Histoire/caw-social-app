/* Verification for the v0.1.2 identity fix. Run: node scripts/verify-identity.mjs
 *
 * Background (user report 2026-11-07 20:19 JST): the app presented
 * @loveforqom (id 190) as the user's own name, but the user is
 * @neptune (id 189). Chain facts, re-measured live by this script:
 *   - usernames(189) = "neptune",   ownerOf(189) = 0x75bb… (the user)
 *   - usernames(190) = "loveforqom", ownerOf(190) = 0x9035… (a friend)
 *   - CawName.tokens(owner) pairs every id with the username of the
 *     token one id lower (the id-190 row literally carries the string
 *     "neptune"), so in v0.1.0 a name could be picked believing it was
 *     a different one, and the choice then persisted.
 *   - The four actions shown under the loveforqom name on 2026-11-07
 *     (18:44 post, 18:49 like, 18:50 share, 20:18 like) were all
 *     SIGNED by 0x9035… — the last section below re-recovers the
 *     signer from the real calldata and asserts it. The user's own
 *     key (0x75bb…) signed none of them; that address sent no
 *     transaction at all on 2026-11-07.
 *
 * The fix: "my names" (tokensOf) is built ONLY from the ERC-721
 * enumeration (balanceOf + tokenOfOwnerByIndex), every id is
 * cross-checked with ownerOf, names come from usernames(id) and
 * balances from cawBalanceOf(id). tokens() is never consulted.
 *
 * No keys, no sends — reads and local logic only.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recoverAddress } = require('ethers');
const BUILD = new URL('./.build-identity', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

/* ---- build the modules under test ---- */
execFileSync(
  'npx',
  [
    'tsc', '--ignoreConfig',
    'src/config.ts', 'src/lib/cawCore.ts', 'src/lib/cawApi.ts',
    '--outDir', BUILD, '--module', 'commonjs', '--target', 'es2022',
    '--esModuleInterop', '--skipLibCheck',
  ],
  { stdio: 'inherit', cwd: new URL('..', import.meta.url).pathname },
);
const core = require(BUILD + '/lib/cawCore.js');
const api = require(BUILD + '/lib/cawApi.js');

const USER = '0x75bb70588b1de571487C4e6dd62546765B7c55e2';   // owns 189 neptune
const FRIEND = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC'; // owns 190 loveforqom (+33)
const NOBODY = '0x000000000000000000000000000000000000dEaD'; // owns nothing

/* ---------- live identity resolution ---------- */
try {
  const mine = await api.tokensOf(USER);
  check('user wallet resolves to exactly one name',
    mine.length === 1, 'got ' + mine.length);
  check('user name is id 189 "neptune"',
    mine.length === 1 && mine[0].id === 189n && mine[0].username === 'neptune',
    mine.length ? '#' + mine[0].id + ' @' + mine[0].username : 'empty');
  check('id 190 (loveforqom) is NOT in the user list',
    !mine.some((t) => t.id === 190n));
  check('user name balance matches cawBalanceOf(189)',
    mine.length === 1 && mine[0].balance === (await api.nameBalance(189n)));

  // every row of every list must be provably owned + correctly named
  const friend = await api.tokensOf(FRIEND);
  const { CAW_NAME: CN, SEL: SL } = require(BUILD + '/config.js');
  let allOwned = friend.length > 0;
  let allNamed = true;
  for (const t of friend) {
    const o = await api.nameOwner(t.id);
    if (o.toLowerCase() !== FRIEND.toLowerCase()) allOwned = false;
    // Compare against a direct usernames(id) read. The read REVERTS
    // for duplicate-minted names (measured: "community" was minted
    // twice, ids 3913+3914; usernames(3914) reverts) — both the app
    // and this check treat that as "no readable name" ('' / null).
    let expected = null;
    try {
      expected = await api.readStr(CN, SL.usernames + core.word(t.id));
    } catch { /* reverted read = no readable name */ }
    if ((expected || '') !== t.username) allNamed = false;
  }
  check('friend list: every id ownerOf-verified (' + friend.length + ' names)', allOwned);
  check('friend list: every username matches usernames(id)', allNamed);
  const f190 = friend.find((t) => t.id === 190n);
  check('friend list: id 190 labelled loveforqom, never neptune',
    !!f190 && f190.username === 'loveforqom',
    f190 ? '@' + f190.username : 'row missing');
  check('friend list: id 189 (neptune) is NOT in it',
    !friend.some((t) => t.id === 189n));

  const none = await api.tokensOf(NOBODY);
  check('address with no names resolves to an empty list', none.length === 0);

  // the acting-name restore rule from AppContext, replayed against
  // the live lists: a remembered id is honoured only when owned.
  const restore = (toks, saved) =>
    saved !== null && toks.some((t) => t.id === saved) ? saved : (toks[0] ? toks[0].id : null);
  check('restore: remembered 190 is rejected for the user (falls back to 189)',
    restore(mine, 190n) === 189n);
  check('restore: remembered 189 is kept for the user',
    restore(mine, 189n) === 189n);
  check('restore: remembered 190 is kept for its real owner (the friend)',
    restore(friend, 190n) === 190n);
} catch (e) {
  check('live identity checks', false, String((e && e.message) || e));
}

/* ---------- the tokens() trap, demonstrated ---------- */
try {
  const { CAW_NAME } = require(BUILD + '/config.js');
  // SEL.tokens was removed in v0.1.2; call the raw selector directly.
  const raw = await api.ethCall(CAW_NAME, '0xe4860339' + core.encAddr(FRIEND));
  const rows = core.decTokensRet(raw);
  const row190 = rows.find((r) => r.id === 190n);
  check('evidence: tokens() row for id 190 carries the shifted string "neptune"',
    !!row190 && row190.username === 'neptune',
    row190 ? 'row username="' + row190.username + '"' : 'row missing');
} catch (e) {
  check('tokens() shift evidence', false, String((e && e.message) || e));
}

/* ---------- who signed the flagged 2026-11-07 actions? ---------- */
const API = 'https://scan.qom.network/api/v2';
const FLAGGED = [
  { hash: '0x4f6bbf870cf723e61a8de72f0e9a25ee4970f79e7308ba797ab40b3ff83478a1', label: '18:44 post "Hisashiburi!"', type: 0 },
  { hash: '0xc22b89670ff619f53df3be35f4056d0d37cdd1a2166d89dbccecad07b00eda87', label: '18:49 like', type: 1 },
  { hash: '0x8678913dbf86c0737d1d61ceca531db80e0035ccc27e5b241ab39ea8e723f225', label: '18:50 share', type: 2 },
  { hash: '0xc6db4f4c8cad609acc85700e7087b548c175d1164eea8250a56e3b2746225f25', label: '20:18 like', type: 1 },
];
function sigOf(raw, k) {
  const body = core.strip(raw).slice(8);
  const wAt = (i) => body.slice(i * 64, i * 64 + 64);
  const wi = (i) => Number(BigInt('0x' + wAt(i)));
  const headAt = wi(1) / 32;
  const vsAt = headAt + wi(headAt + 1) / 32;
  const rsAt = headAt + wi(headAt + 2) / 32;
  const ssAt = headAt + wi(headAt + 3) / 32;
  return { v: wi(vsAt + 1 + k), r: '0x' + wAt(rsAt + 1 + k), s: '0x' + wAt(ssAt + 1 + k) };
}
try {
  for (const f of FLAGGED) {
    const res = await fetch(API + '/transactions/' + f.hash);
    if (!res.ok) throw new Error('api ' + res.status);
    const tx = await res.json();
    const acts = core.decodeActions(tx.raw_input);
    const a = acts[0];
    const signer = recoverAddress(core.actionDigest(a), sigOf(tx.raw_input, 0));
    check('signer of ' + f.label + ' is the loveforqom owner (friend), not the user',
      !!a && a.type === f.type && a.senderId === 190n &&
        signer.toLowerCase() === FRIEND.toLowerCase() &&
        signer.toLowerCase() !== USER.toLowerCase(),
      'signer=' + signer);
  }
} catch (e) {
  check('flagged-action signer recovery', false, String((e && e.message) || e));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
