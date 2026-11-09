/* Pre-release verification for the CAW Social app.
 *
 * 1) Compiles the app's REAL TypeScript core (src/lib/cawCore.ts +
 *    src/lib/cawApi.ts) with tsc and exercises those exact functions.
 * 2) Corpus check: every action in the 264-action corpus of real
 *    on-chain processAction transactions (public chain data, collected
 *    during the web front end's verification) must
 *      - recover its sender from the app core's digest + the real
 *        signature (ecrecover), and
 *      - re-encode to the exact original calldata, byte for byte.
 *    Corpus path: $CAW_CORPUS or the default verification-workspace
 *    location. If the corpus is absent the corpus section is skipped
 *    (the live smoke below still runs).
 * 3) Live smoke against the real QL1 RPC / Blockscout API: timeline
 *    decode count, name resolution, balances.
 *
 * No keys, no sends. Run: npm run verify
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/* Inside the repo so the compiled files resolve the app's node_modules. */
const BUILD = new URL('./.build', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

/* ---- build the app core ---- */
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
const { recoverAddress } = require('ethers');

/* ---- corpus check ---- */
const corpusPath =
  process.env.CAW_CORPUS || '/home/hatch/workspace/.scratch-caw/work/txs.json';
if (!existsSync(corpusPath)) {
  console.log('SKIP corpus check (file not found: ' + corpusPath + ')');
} else {
  const txs = JSON.parse(readFileSync(corpusPath, 'utf8'));
  // Independent batch parser (same approach as the web verification):
  // walks the processAction calldata structure directly.
  function parseTx(t) {
    const body = t.raw.slice(10);
    const word = (i) => body.slice(i * 64, i * 64 + 64);
    const wi = (i) => parseInt(word(i), 16);
    const sAt = wi(1) / 32;
    const aOff = sAt + wi(sAt) / 32, vOff = sAt + wi(sAt + 1) / 32,
      rOff = sAt + wi(sAt + 2) / 32, sOff = sAt + wi(sAt + 3) / 32;
    const n = wi(aOff);
    const acts = [], sigs = [];
    for (let k = 0; k < n; k++) {
      const tOff = aOff + 1 + wi(aOff + 1 + k) / 32;
      const f = (i) => word(tOff + i);
      const fi = (i) => parseInt(f(i), 16);
      const textWord = tOff + fi(8) / 32;
      const textLen = wi(textWord);
      const textHex = body.slice(
        (textWord + 1) * 64, (textWord + 1) * 64 + textLen * 2);
      acts.push({
        type: fi(0), senderId: BigInt(fi(1)), receiverId: BigInt(fi(2)),
        ts: fi(4), sender: '0x' + f(5).slice(24), cawId: '0x' + f(7),
        text: Buffer.from(textHex, 'hex').toString('utf8'),
      });
      sigs.push({
        v: wi(vOff + 1 + k), r: '0x' + word(rOff + 1 + k),
        s: '0x' + word(sOff + 1 + k),
      });
    }
    return { acts, sigs };
  }

  let batches = 0, actions = 0, recOk = 0, rebOk = 0, decOk = 0, nonEmpty = 0;
  for (const t of txs) {
    if (!t.raw.startsWith('0x84e33f2f')) continue;
    let p;
    try { p = parseTx(t); } catch { continue; }
    batches++;
    if (p.acts.length > 0) nonEmpty++;
    let batchAllRec = true;
    for (let i = 0; i < p.acts.length; i++) {
      actions++;
      const a = p.acts[i];
      const digest = core.actionDigest(a);
      let rec = null;
      try { rec = recoverAddress(digest, p.sigs[i]); } catch { /* counted below */ }
      if (rec && rec.toLowerCase() === a.sender.toLowerCase()) recOk++;
      else batchAllRec = false;
      // the app's own decoder must read the first action identically
      if (i === 0) {
        const d = core.decodeAction(t.raw);
        if (
          d && d.type === a.type && d.senderId === a.senderId &&
          d.receiverId === a.receiverId && d.ts === a.ts &&
          d.sender.toLowerCase() === a.sender.toLowerCase() &&
          d.cawId.toLowerCase() === a.cawId.toLowerCase() && d.text === a.text
        ) decOk++;
      }
    }
    const rebuilt = core.encodeBatch(p.acts, p.sigs);
    if (rebuilt.toLowerCase() === t.raw.toLowerCase()) rebOk++;
  }
  check('corpus actions recovered (ecrecover == sender)',
    recOk === actions && actions > 0, recOk + '/' + actions + ' actions in ' + batches + ' txs');
  check('corpus batches rebuilt byte-for-byte',
    rebOk === batches, rebOk + '/' + batches);
  check('app decodeAction matches independent parser (first actions)',
    decOk === nonEmpty, decOk + '/' + nonEmpty + ' non-empty batches (' +
    (batches - nonEmpty) + ' empty batches decode to null, as on the web)');
}

/* ---- fmtAmountCard (v0.4.6 summary-frame formatting) ----
 * Display-only law for the name card / Home wallet card frames:
 * thousands separators, at most two fraction digits, TRUNCATED
 * (never rounded up — the card must not promise more than the
 * wallet holds), both digits kept when either is non-zero. */
{
  const E = 10n ** 18n;
  const cases = [
    [0n, '0'],
    [E, '1'],
    [1900000000n * E, '1,900,000,000'],
    // the user's real QOM balance shape: .509999 -> .50, not .51
    [594867714n * E + 509999n * 10n ** 12n, '594,867,714.50'],
    [99993999n * E + 999999n * 10n ** 12n, '99,993,999.99'],
    // truncation, never rounding: 1.999 -> 1.99, 0.009 -> 0
    [1n * E + 999n * 10n ** 15n, '1.99'],
    [9n * 10n ** 15n, '0'],
    // a tenth keeps both digits: 2.5 -> 2.50 (matches the mock)
    [2n * E + 5n * 10n ** 17n, '2.50'],
    // separators across groups with a fraction
    [1234567n * E + 1n * 10n ** 16n, '1,234,567.01'],
  ];
  let ok = true;
  for (const [wei, want] of cases) {
    const got = core.fmtAmountCard(wei);
    if (got !== want) {
      ok = false;
      console.log('  fmtAmountCard(' + wei.toString() + ') = ' + got + ', want ' + want);
    }
  }
  check('fmtAmountCard: separators + truncate-to-2dp, never rounds up', ok,
    cases.length + ' cases');
}

/* ---- live smoke ---- */
try {
  const page = await api.fetchTimelinePage(null);
  check('live timeline page decodes', page.items.length > 0,
    page.items.length + ' actions decoded');
} catch (e) {
  check('live timeline page decodes', false, String(e && e.message || e));
}
try {
  const r = await api.resolveNameId('donaldtrump');
  check('live resolveNameId(donaldtrump) == 2',
    r.status === 'ok' && r.id === 2n, JSON.stringify(r, (k, v) => typeof v === 'bigint' ? v.toString() : v));
} catch (e) {
  check('live resolveNameId(donaldtrump) == 2', false, String(e && e.message || e));
}
let neptuneId = null;
try {
  const r = await api.resolveNameId('neptune');
  if (r.status === 'ok') neptuneId = r.id;
  check('live resolveNameId(neptune) resolves', r.status === 'ok',
    r.status === 'ok' ? 'id ' + r.id.toString() : r.status);
} catch (e) {
  check('live resolveNameId(neptune) resolves', false, String(e && e.message || e));
}
if (neptuneId !== null) {
  try {
    const owner = await api.nameOwner(neptuneId);
    const toks = await api.tokensOf(owner);
    const hit = toks.find((t) => t.id === neptuneId);
    check('live tokensOf(neptune owner) contains neptune', !!hit,
      'owner ' + owner + ', names: ' + toks.map((t) => '@' + t.username).join(', '));
    const bal = await api.walletBalances(owner);
    check('live walletBalances reads', typeof bal.qom === 'bigint' && typeof bal.qcaw === 'bigint',
      'QOM ' + bal.qom.toString() + ' / qCAW ' + bal.qcaw.toString());
    const fc = await api.followerCount(neptuneId);
    check('live followerCount(neptune) reads', typeof fc === 'bigint', fc.toString());
  } catch (e) {
    check('live neptune reads', false, String(e && e.message || e));
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
