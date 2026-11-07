/* Verification for name identity. Run: node scripts/verify-identity.mjs
 *
 * CORRECTED BACKGROUND (v0.1.3 — this script's v0.1.2-era framing
 * had the shift backwards, and is rewritten here):
 *
 * On 2026-11-07 the app showed the user his token #190 under the
 * name "loveforqom" and he protested: "I am neptune — that is my
 * friend's id." v0.1.2 took the usernames() mapping as the truth
 * (usernames(190) = "loveforqom") and rebuilt identity on it. The
 * MINT TRANSACTIONS then settled which getter is broken:
 *
 *   - tx 0xc4ac11ad… (block 5189285): Minter.mint("dreamin")
 *     created token 189, delivered to 0x75bb…
 *   - tx 0x9c374074… (block 5189287): Minter.mint("neptune")
 *     created token 190, delivered to 0x0Cdd1E…, later transferred
 *     to the user's wallet 0x9035…f8cc.
 *
 * So the tokenURI CARD names are the mint truth (#189 "dreamin",
 * #190 "neptune", #191 "loveforqom"), and the one shifted getter is
 * usernames(): usernames(n) returns token n+1's minted name (a
 * 0-based list read against 1-based ids — slot 0 holds token 1's
 * name, "elonmusk"). tokens() and idByUsername agree with the
 * cards. The user was right from the start: #190 IS his neptune.
 *
 * What v0.1.2 got right and v0.1.3 keeps: "my names" is built from
 * the ERC-721 enumeration (balanceOf + tokenOfOwnerByIndex) with
 * every id cross-checked by ownerOf, and the pre-sign guard is
 * fail-closed. What v0.1.3 fixes: names come from the tokens'
 * CARDS (tokenURI name field; fallback usernames(id − 1), the
 * corrected slot), never from usernames(id).
 *
 * The last section re-recovers the signers of the four actions of
 * 2026-11-07 that were displayed under #190: all were signed by
 * 0x9035…f8cc — the owner of #190 — i.e. by the user's own wallet,
 * acting as his own "neptune", exactly as the chain recorded.
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
const { CAW_NAME } = require(BUILD + '/config.js');

const WALLET_A = '0x75bb70588b1de571487C4e6dd62546765b7c55e2'; // owns 189 (card: dreamin)
const F8CC = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC';     // owns 190 (card: neptune) + 33 more
const NOBODY = '0x000000000000000000000000000000000000dEaD';     // owns nothing

/** Ground-truth oracle: the name on a token's card, read raw. */
async function cardNameDirect(id) {
  const uri = await api.withRetry(
    () => api.readStr(CAW_NAME, '0xc87b56dd' + core.word(id)), 3, 500);
  if (!uri.startsWith('data:application/json;base64,')) return null;
  const meta = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
  return meta.name || null;
}

/* ---------- live identity resolution ---------- */
try {
  const b = await api.tokensOf(F8CC);
  check('f8cc wallet resolves its names', b.length > 0, 'got ' + b.length);
  const b190 = b.find((t) => t.id === 190n);
  check('f8cc list: id 190 labelled "neptune" (its card / mint name)',
    !!b190 && b190.username === 'neptune',
    b190 ? '#' + b190.id + ' @' + b190.username : 'row missing');
  check('f8cc list: NO row labelled "loveforqom" (that name is #191, not owned here)',
    !b.some((t) => t.username === 'loveforqom'));
  let allOwned = b.length > 0;
  let allCard = true;
  for (const t of b) {
    const o = await api.nameOwner(t.id);
    if (o.toLowerCase() !== F8CC.toLowerCase()) allOwned = false;
    let expected = null;
    try { expected = await cardNameDirect(t.id); } catch { /* unreadable card */ }
    if ((expected || '') !== t.username) allCard = false;
  }
  check('f8cc list: every id ownerOf-verified (' + b.length + ' names)', allOwned);
  check('f8cc list: every label matches the tokenURI card name', allCard);

  const a = await api.tokensOf(WALLET_A);
  check('wallet A resolves to exactly one name', a.length === 1, 'got ' + a.length);
  check('wallet A name is id 189 "dreamin" (its card / mint name)',
    a.length === 1 && a[0].id === 189n && a[0].username === 'dreamin',
    a.length ? '#' + a[0].id + ' @' + a[0].username : 'empty');
  check('id 190 (neptune) is NOT in wallet A list', !a.some((t) => t.id === 190n));
  check('wallet A name balance matches cawBalanceOf(189)',
    a.length === 1 && a[0].balance === (await api.nameBalance(189n)));

  const none = await api.tokensOf(NOBODY);
  check('address with no names resolves to an empty list', none.length === 0);

  // the acting-name restore rule from AppContext, replayed against
  // the live lists: a remembered id is honoured only when owned.
  const restore = (toks, saved) =>
    saved !== null && toks.some((t) => t.id === saved) ? saved : (toks[0] ? toks[0].id : null);
  check('restore: remembered 190 is rejected for wallet A (falls back to 189)',
    restore(a, 190n) === 189n);
  check('restore: remembered 189 is kept for wallet A', restore(a, 189n) === 189n);
  check('restore: remembered 190 is kept for its owner (f8cc)', restore(b, 190n) === 190n);
} catch (e) {
  check('live identity checks', false, String((e && e.message) || e));
}

/* ---------- the usernames() trap, demonstrated ---------- */
try {
  const shifted = await api.withRetry(
    () => api.readStr(CAW_NAME, '0x136dd963' + core.word(190n)), 3, 500);
  check('evidence: usernames(190) returns the SHIFTED "loveforqom" (name of #191)',
    shifted === 'loveforqom', 'usernames(190)=' + JSON.stringify(shifted));
  const raw = await api.ethCall(CAW_NAME, '0xe4860339' + core.encAddr(F8CC));
  const rows = core.decTokensRet(raw);
  const row190 = rows.find((r) => r.id === 190n);
  check('evidence: tokens() row for id 190 carries the TRUE name "neptune"',
    !!row190 && row190.username === 'neptune',
    row190 ? 'row username="' + row190.username + '"' : 'row missing');
} catch (e) {
  check('usernames() shift evidence', false, String((e && e.message) || e));
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
  const owner190 = await api.nameOwner(190n);
  for (const f of FLAGGED) {
    const res = await fetch(API + '/transactions/' + f.hash);
    if (!res.ok) throw new Error('api ' + res.status);
    const tx = await res.json();
    const acts = core.decodeActions(tx.raw_input);
    const a = acts[0];
    const signer = recoverAddress(core.actionDigest(a), sigOf(tx.raw_input, 0));
    check('signer of ' + f.label + ' is the owner of #190 (f8cc) — the name owner himself',
      !!a && a.type === f.type && a.senderId === 190n &&
        signer.toLowerCase() === F8CC.toLowerCase() &&
        signer.toLowerCase() === owner190.toLowerCase(),
      'signer=' + signer);
  }
} catch (e) {
  check('flagged-action signer recovery', false, String((e && e.message) || e));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
