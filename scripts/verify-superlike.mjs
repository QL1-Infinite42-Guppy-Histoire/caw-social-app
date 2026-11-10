#!/usr/bin/env node
/**
 * SuperLike verification (v0.5.0 — the O-burn design).
 * Behaviour where the module allows it (the marked-burn codec,
 * guard decisions, the chain-wide marked-burn scanner against
 * a stubbed QL1 RPC), statics for the RN-bound wiring
 * (performSuperlike / TimelineScreen / ProfileScreen /
 * PostDetailScreen / PostCard), and the live O tolerance
 * probe's numbers as a fixture.
 *
 * v0.5.0 design: a SuperLike is ONE QL1 transaction — burn
 * exactly 1,000,000 O to 0x…dEaD with trailing calldata
 * "SLK1" + the post's cawId. The CAT42 path of v0.4.8/9 (and
 * its pending-burn debt store) is gone: no SuperLike was ever
 * sent at the CAT42 prices, so no legacy counting exists.
 * Counts come from a chain-wide scan of O Transfer events TO
 * the burn address, inputs parsed for the marker (the
 * recipient is dEaD for everyone, so per-author scans are
 * impossible — see lib/markedBurns.ts).
 *
 * The tolerance fixture: on 2026-11-10 the REAL O token was
 * probed read-only (QL1 head 13,435,401) with a simulated
 * 1,000,000 O burn transfer from the QomSwap O/WQOM pair
 * (a holder of ~13.28 trillion O):
 *   eth_call plain  -> 0x…01 (true)
 *   eth_call marked -> 0x…01 (true)   (marker = "SLK1" + cawId)
 *   estimateGas plain  = 35,077
 *   estimateGas marked = 35,281  (delta 204 = exactly the
 *   intrinsic calldata charge of the test marker: 5 nonzero
 *   bytes x 16 + 31 zero bytes x 4 — execution untouched)
 * And no transfer tax: 36 real direct transfer() txs sampled
 * over ~1.46M blocks each had input amount == Transfer log
 * amount (0 mismatches). The v0.4.9 CAT42 probe (2026-11-09,
 * delta 576 = 36 nonzero bytes x 16) is the same mechanics on
 * the old token; it stays valid as a pattern reference.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = ROOT + '/scripts/.build-superlike';
let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log('  ok  ' + label);
  } else {
    fail++;
    console.log('  FAIL ' + label);
  }
}

/* ---------- compile the pure graph ---------- */
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
try {
  execFileSync(
    'npx',
    [
      'tsc',
      '--ignoreConfig',
      'src/config.ts',
      'src/lib/cawCore.ts',
      'src/lib/chains.ts',
      'src/lib/cawApi.ts',
      'src/lib/markedBurns.ts',
      'src/lib/superlike.ts',
      '--outDir',
      OUT,
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: ROOT, stdio: 'pipe' },
  );
  ok(true, 'tsc compiles config/cawCore/chains/cawApi/markedBurns/superlike');
} catch (e) {
  ok(false, 'tsc: ' + (e.stdout || '').toString().slice(0, 400));
  process.exit(1);
}
writeFileSync(OUT + '/package.json', '{"type":"commonjs"}');

const SL = await import(OUT + '/lib/superlike.js');
const MB = await import(OUT + '/lib/markedBurns.js');
const CFG = await import(OUT + '/config.js');

/* ---------- the marker codec ---------- */
const P1 = '0x' + '11'.repeat(32);
const P2 = '0x' + '22'.repeat(32);
const PRICE = 1000000n * 10n ** 18n;
{
  const data = SL.buildSuperlikeData(P1);
  ok(typeof data === 'string', 'buildSuperlikeData returns data');
  ok(
    (data.length - 2) / 2 === 104,
    'marked burn is exactly 104 bytes (68 + 4 magic + 32 cawId)',
  );
  ok(data.startsWith('0xa9059cbb'), 'starts with the transfer selector');
  ok(data.toLowerCase().includes(SL.SUPERLIKE_MAGIC), 'carries the SLK1 magic');
  ok(
    '0x' + data.slice(34, 74) ===
      '0x000000000000000000000000000000000000dead',
    'recipient is the burn address 0x…dEaD',
  );
  ok(BigInt('0x' + data.slice(74, 138)) === PRICE, 'amount is exactly 1,000,000 O');
  const mark = SL.parseSuperlikeInput(data);
  ok(!!mark, 'parse accepts the built data');
  ok(mark.amount === PRICE, 'round-trip: amount is exactly the price');
  ok(mark.cawId === P1, 'round-trip: cawId survives');
  ok(mark.to.toLowerCase() === MB.BURN_ADDRESS.toLowerCase(), 'round-trip: burn recipient');
  ok(SL.buildSuperlikeData('0x1234') === null, 'bad cawId refused');
  // rejects
  const plain =
    '0xa9059cbb' +
    '0'.repeat(24) +
    '000000000000000000000000000000000000dead' +
    PRICE.toString(16).padStart(64, '0');
  ok(SL.parseSuperlikeInput(plain) === null, 'plain (unmarked) burn is not a SuperLike');
  ok(SL.parseSuperlikeInput(data.slice(0, -2)) === null, 'truncated marker rejected');
  const wrongMagic = data.replace(SL.SUPERLIKE_MAGIC, 'deadbeef');
  ok(SL.parseSuperlikeInput(wrongMagic) === null, 'wrong magic rejected');
  const wrongSel = '0x095ea7b3' + data.slice(10);
  ok(SL.parseSuperlikeInput(wrongSel) === null, 'non-transfer selector rejected');
  ok(SL.parseSuperlikeInput(data + 'ff') === null, 'extra trailing byte rejected');
  // a marked transfer to someone else is not a burn at all
  const toOther =
    '0xa9059cbb' +
    '0'.repeat(24) +
    '1111111111111111111111111111111111111111' +
    PRICE.toString(16).padStart(64, '0') +
    SL.SUPERLIKE_MAGIC +
    P1.slice(2);
  ok(MB.parseMarkedBurnInput(toOther) === null, 'marked transfer to a non-burn address rejected');
  // the SRC1 (SuperRecaw) marker parses in the shared codec but
  // is NOT a SuperLike
  const src = MB.buildMarkedBurnData(MB.SUPERRECAW_MAGIC, P1);
  const srcMark = MB.parseMarkedBurnInput(src);
  ok(!!srcMark && srcMark.magic === MB.SUPERRECAW_MAGIC, 'shared codec parses SRC1');
  ok(SL.parseSuperlikeInput(src) === null, 'an SRC1 burn never parses as a SuperLike');
}

/* ---------- price + tolerance fixture (measured on-chain) ---------- */
{
  ok(
    SL.SUPERLIKE_PRICE_O === 1000000 &&
      SL.SUPERLIKE_PRICE_RAW === PRICE &&
      MB.MARKED_BURN_PRICE_RAW === PRICE,
    'price constants: exactly 1,000,000 O',
  );
  ok(
    MB.BURN_ADDRESS === '0x000000000000000000000000000000000000dEaD',
    'the burn address is the established 0x…dEaD',
  );
  ok(
    CFG.O_TOKEN === '0x6c39b68a28bA90F4EB80032ec0eB32ad81cbbEd4',
    'O token target is the QL1 contract',
  );
  const PLAIN_GAS = 35077;
  const MARKED_GAS = 35281;
  ok(
    MARKED_GAS - PLAIN_GAS === 5 * 16 + 31 * 4,
    'probe fixture: gas delta 204 = intrinsic cost of the marker bytes only',
  );
  ok(
    MB.MARKED_BURN_START_BLOCK === 13400000,
    'scan starts just under the 2026-11-10 QL1 head (no marked burn can predate it)',
  );
}

/* ---------- guard decisions ---------- */
{
  const OWNER = '0x0Cdd1EbbBCb55601b207B384245dDe646882b86B';
  const me = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC';
  ok(
    SL.superlikeBlockReason({
      senderId: 5n,
      myTokenIds: [3n, 5n],
      authorOwner: OWNER,
      myAddress: me,
    }) === 'self',
    'guard: post by one of my names blocked',
  );
  ok(
    SL.superlikeBlockReason({
      senderId: 9n,
      myTokenIds: [3n],
      authorOwner: me.toUpperCase().replace('0X', '0x'),
      myAddress: me,
    }) === 'self',
    'guard: author owner == my address blocked (case-insensitive)',
  );
  ok(
    SL.superlikeBlockReason({
      senderId: 9n,
      myTokenIds: [3n],
      authorOwner: OWNER,
      myAddress: me,
    }) === null,
    'guard: someone else’s post allowed',
  );
  ok(SL.superlikeShortfall(PRICE - 1n) === true, 'shortfall: 999,999.99… O blocked');
  ok(SL.superlikeShortfall(PRICE) === false, 'shortfall: exactly 1,000,000 O ok');
  ok(SL.superlikeShortfall(0n) === true, 'shortfall: 0 blocked');
}

/* ---------- the marked-burn scanner (stubbed QL1 RPC) ---------- */
const word = (n) => '0x' + n.toString(16).padStart(64, '0');
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicAddr = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const SENDER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
function logFor(hash, from, amount) {
  return {
    transactionHash: hash,
    topics: [TRANSFER_TOPIC, topicAddr(from), topicAddr(MB.BURN_ADDRESS)],
    data: word(amount),
  };
}
function fetchStub({ head, chunks, txInputs }) {
  const state = { getLogsCalls: 0 };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (req) => {
      if (req.method === 'eth_blockNumber')
        return { result: '0x' + head.toString(16) };
      if (req.method === 'eth_getLogs') {
        state.getLogsCalls++;
        const from = parseInt(req.params[0].fromBlock, 16);
        return { result: chunks.get(from) ?? [] };
      }
      if (req.method === 'eth_getTransactionByHash')
        return { result: { input: txInputs[req.params[0]] } };
      return { result: null };
    };
    if (Array.isArray(body)) {
      return {
        json: async () =>
          body.map((req) => ({ jsonrpc: '2.0', id: req.id, ...answer(req) })),
      };
    }
    return { json: async () => ({ jsonrpc: '2.0', id: body.id, ...answer(body) }) };
  };
  return state;
}
{
  const START = MB.MARKED_BURN_START_BLOCK;
  const HEAD = START + 9500; // two chunks: 9000 + 500
  // txE: marked SLK1 input at 999,999 O — hand-rewritten amount
  // word; the exactly-the-price rule must exclude it.
  const markedWrongAmt = (() => {
    const d = SL.buildSuperlikeData(P1);
    const amt = (999999n * 10n ** 18n).toString(16).padStart(64, '0');
    return d.slice(0, 74) + amt + d.slice(138);
  })();
  const txInputs = {
    txA: SL.buildSuperlikeData(P1), // counts for P1
    txB: SL.buildSuperlikeData(P1), // log value disagrees -> excluded
    txC: SL.buildSuperlikeData(P2), // counts for P2
    txD:
      '0xa9059cbb' +
      '0'.repeat(24) +
      '000000000000000000000000000000000000dead' +
      PRICE.toString(16).padStart(64, '0'), // plain burn, no marker -> excluded
    txE: markedWrongAmt, // wrong amount -> excluded
    txF: MB.buildMarkedBurnData(MB.SUPERRECAW_MAGIC, P1), // SRC1 -> src index, not a SuperLike
  };
  const chunks = new Map([
    [
      START,
      [
        logFor('txA', SENDER, PRICE),
        logFor('txB', SENDER, 250n * 10n ** 18n),
        logFor('txC', OTHER, PRICE),
        logFor('txD', SENDER, PRICE),
        logFor('txE', SENDER, 999999n * 10n ** 18n),
        logFor('txF', SENDER, PRICE),
      ],
    ],
  ]);
  const kvMem = new Map();
  MB.initMarkedBurnStore({
    getItem: async (k) => kvMem.get(k) ?? null,
    setItem: async (k, v) => void kvMem.set(k, v),
  });
  const stub = fetchStub({ head: HEAD, chunks, txInputs });
  const n1 = await SL.superlikeCount(P1);
  ok(n1 === 1, 'scanner: P1 counts only the exact marked 1M O burn (log-mismatch, plain, wrong-amount and SRC1 all excluded)');
  const n2 = await SL.superlikeCount(P2);
  ok(n2 === 1, 'scanner: P2 counted from the same scan');
  ok(SL.superlikeCountCached(P1) === 1, 'scanner: cached count readable');
  ok(
    MB.superRecawCached(P1, SENDER) === true &&
      MB.superRecawCached(P1, OTHER) === false,
    'scanner: the SRC1 mark is indexed by (cawId, sender) in the same scan',
  );
  const before = stub.getLogsCalls;
  await SL.superlikeCount(P1);
  ok(stub.getLogsCalls === before, 'scanner: cursor current -> no rescan of old chunks');
  const saved = JSON.parse(kvMem.get('caw-marked-burns-v1'));
  ok(saved.to === HEAD, 'scanner: cursor persisted at the scanned head');
  ok(
    saved.sl[P1] === 1 && saved.src[P1 + ':' + SENDER] === 1,
    'scanner: both indexes persisted to the on-device KV',
  );
}

/* ---------- scanner failure: cursor must not advance ---------- */
{
  // A fresh module instance (a copied build tree — the CJS
  // cache keys on file path) so this scenario starts from an
  // empty index, not the one above.
  const OUT2 = ROOT + '/scripts/.build-superlike-fail';
  rmSync(OUT2, { recursive: true, force: true });
  cpSync(OUT, OUT2, { recursive: true });
  const MB2 = await import(OUT2 + '/lib/markedBurns.js');
  const START = MB2.MARKED_BURN_START_BLOCK;
  const HEAD = START + 19000; // chunks: 9000, 9000, 1000
  const chunks = new Map([[START, [logFor('txA', SENDER, PRICE)]]]);
  const txInputs = { txA: MB2.buildMarkedBurnData(MB2.SUPERLIKE_MAGIC, P1) };
  const kvMem = new Map();
  MB2.initMarkedBurnStore({
    getItem: async (k) => kvMem.get(k) ?? null,
    setItem: async (k, v) => void kvMem.set(k, v),
  });
  let poisoned = true;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (req) => {
      if (req.method === 'eth_blockNumber')
        return { result: '0x' + HEAD.toString(16) };
      if (req.method === 'eth_getLogs') {
        const from = parseInt(req.params[0].fromBlock, 16);
        if (poisoned && from === START + 9000) {
          return { error: { code: -32000, message: 'simulated RPC failure' } };
        }
        return { result: chunks.get(from) ?? [] };
      }
      if (req.method === 'eth_getTransactionByHash')
        return { result: { input: txInputs[req.params[0]] } };
      return { result: null };
    };
    if (Array.isArray(body)) {
      return {
        json: async () =>
          body.map((req) => ({ jsonrpc: '2.0', id: req.id, ...answer(req) })),
      };
    }
    return { json: async () => ({ jsonrpc: '2.0', id: body.id, ...answer(body) }) };
  };
  const partial = await MB2.superlikeCount(P1);
  ok(partial === 1, 'failure: count from completed chunks still returned');
  const recMid = JSON.parse(kvMem.get('caw-marked-burns-v1'));
  ok(
    recMid.to === START + 8999,
    'failure: cursor stopped at the last completed chunk',
  );
  poisoned = false;
  const full = await MB2.superlikeCount(P1);
  ok(full === 1, 'failure: rescan after recovery completes, count unchanged');
  const recEnd = JSON.parse(kvMem.get('caw-marked-burns-v1'));
  ok(recEnd.to === HEAD, 'failure: cursor reaches the head after recovery');
}

/* ---------- wiring statics ---------- */
{
  const flowAll = readFileSync(ROOT + '/src/lib/actionFlow.ts', 'utf8');
  const flow = flowAll.slice(
    flowAll.indexOf('export async function performSuperlike'),
    flowAll.indexOf('export async function performSuperRecaw'),
  );
  const iSelf = flow.indexOf("Error('self-superlike')");
  const iShort = flow.indexOf("Error('shortfall')");
  const iSend = flow.indexOf('sendCalldata');
  ok(iSelf > 0 && iSelf < iSend, 'performSuperlike: self block precedes the send');
  ok(iShort > 0 && iShort < iSend, 'performSuperlike: shortfall stop precedes the send');
  ok(flow.includes('oBalanceOf'), 'performSuperlike: fresh O balance read (QL1)');
  ok(flow.includes('buildSuperlikeData'), 'performSuperlike: marked burn calldata built');
  ok(
    flow.includes('sendCalldata(signer, O_TOKEN, data)'),
    'performSuperlike: the ONE send is the O burn',
  );
  ok(flow.includes('requireAuth'), 'performSuperlike: fresh auth gate');
  ok(
    flow.includes('refreshSuperlikesFor'),
    'performSuperlike: marked-burn index nudged after the burn',
  );
  ok(
    !flowAll.includes('recordPendingBurn') &&
      !flowAll.includes('performSuperlikeBurn') &&
      !flow.includes('CAT42'),
    'the CAT42 SuperLike path and its debt store are GONE',
  );
  const tl = readFileSync(ROOT + '/src/screens/TimelineScreen.tsx', 'utf8');
  ok(tl.includes('onSuperlike={handleSuperlike}'), 'TimelineScreen passes the handler');
  ok(tl.includes("tr('sl.body'"), 'TimelineScreen sheet shows price/recipient/balance');
  ok(tl.includes("tr('sl.shortfall')"), 'TimelineScreen surfaces the shortfall guidance');
  ok(tl.includes('SUPERLIKE_PRICE_RAW'), 'TimelineScreen sheet prices from the constant');
  const pf = readFileSync(ROOT + '/src/screens/ProfileScreen.tsx', 'utf8');
  ok(pf.includes('onSuperlike={handleSuperlike}'), 'ProfileScreen passes the handler');
  ok(
    pf.includes('performSuperlike') && pf.includes("tr('sl.body'") &&
      pf.includes("tr('sl.self'") && pf.includes("tr('sl.shortfall'"),
    'ProfileScreen carries the same sheet + guards as the feed',
  );
  const pd = readFileSync(ROOT + '/src/screens/PostDetailScreen.tsx', 'utf8');
  ok(
    (pd.match(/onSuperlike=\{handleSuperlike\}/g) || []).length === 2,
    'PostDetailScreen wires SuperLike on the post and its replies',
  );
  ok(pd.includes('performSuperlike'), 'PostDetailScreen carries the send flow');
  const ui = readFileSync(ROOT + '/src/components/ui.tsx', 'utf8');
  ok(ui.includes('StarIcon'), 'PostCard renders the star treatment');
  ok(ui.includes('superlikeCount('), 'PostCard reads the chain count');
  ok(ui.includes('onSuperlike'), 'PostCard exposes the SuperLike action');
  const ctx = readFileSync(ROOT + '/src/context/AppContext.tsx', 'utf8');
  ok(ctx.includes('initSuperlikeStore(storeKV)'), 'AppContext inits the count store');
}

console.log(`\nsuperlike: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
