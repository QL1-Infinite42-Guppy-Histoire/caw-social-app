#!/usr/bin/env node
/**
 * SuperLike verification (v0.6.3 — the two-leg design).
 *
 * Since v0.6.3 (user decision 2026-11-13) a SuperLike costs
 * 25,000,000 O IN TOTAL, in two QL1 transactions:
 *   leg 1 — the BURN: 10,000,000 O to 0x…dEaD with trailing
 *           calldata "SLK1" + the post's cawId (defines the
 *           action; the ⭐ count reads these burns);
 *   leg 2 — the AUTHOR PAYMENT: a plain, unmarked transfer of
 *           15,000,000 O to the post author's owner.
 * From v0.5.0 to v0.6.2 a SuperLike was ONE transaction: a
 * burn of exactly 1,000,000 O. Those legacy burns were
 * genuine under their spec and STAY counted: the detection
 * set for SLK1 is {10,000,000, 1,000,000}. (The CAT42 path of
 * v0.4.8/9 left no legacy at all — no SuperLike was ever sent
 * at the CAT42 prices.)
 *
 * This suite tests BEHAVIOUR, not just shapes: the marked-burn
 * codec, the scanner's detection sets against a stubbed QL1
 * RPC (current + legacy amounts counted; the OTHER action's
 * amounts, log mismatches, plain burns and cross-magic marks
 * excluded), the author-pay debt store, and the REAL
 * performSuperlike / performAuthorPay from actionFlow.ts
 * driven against a stubbed wallet + RPC:
 *   burn fails      -> the error propagates, ONE send was
 *                      attempted, NOTHING is recorded;
 *   payment fails   -> 'sl-pay-pending' + a persisted debt;
 *   the retry       -> sends ONLY the plain transfer and
 *                      clears the debt; a short balance is a
 *                      hard stop that keeps the debt;
 *   self / short    -> refused before anything is signed.
 * Statics remain only for the RN-bound wiring (the three
 * screens' sheets and gates).
 *
 * The tolerance fixture: on 2026-11-10 the REAL O token was
 * probed read-only (QL1 head 13,435,401) with a simulated
 * burn transfer from the QomSwap O/WQOM pair (a holder of
 * ~13.28 trillion O):
 *   eth_call plain  -> 0x…01 (true)
 *   eth_call marked -> 0x…01 (true)   (marker = "SLK1" + cawId)
 *   estimateGas plain  = 35,077
 *   estimateGas marked = 35,281  (delta 204 = exactly the
 *   intrinsic calldata charge of the test marker: 5 nonzero
 *   bytes x 16 + 31 zero bytes x 4 — execution untouched)
 * And no transfer tax: 36 real direct transfer() txs sampled
 * over ~1.46M blocks each had input amount == Transfer log
 * amount (0 mismatches). The marker mechanics are
 * amount-independent, so the fixture stands for the new burn
 * amounts too.
 */
import { execFileSync, spawnSync } from 'node:child_process';
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

/* ---------- compile the graph (incl. the real flows) ---------- */
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
{
  // The flow files pull the app's wider type graph in; under
  // this standalone flag set tsc prints pre-existing type
  // noise from unrelated modules but still EMITS. The gate
  // here is that the needed modules were emitted — the app's
  // own `tsc -p tsconfig.json` is the type gate.
  spawnSync(
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
      'src/lib/superRecaw.ts',
      'src/lib/authorPay.ts',
      'src/lib/tip.ts',
      'src/lib/actionFlow.ts',
      '--outDir',
      OUT,
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--esModuleInterop',
      '--skipLibCheck',
      '--jsx',
      'react',
      '--noImplicitAny',
      'false',
    ],
    { cwd: ROOT, stdio: 'pipe' },
  );
  const needed = [
    'lib/markedBurns.js',
    'lib/superlike.js',
    'lib/superRecaw.js',
    'lib/authorPay.js',
    'lib/actionFlow.js',
    'lib/wallet.js',
    'config.js',
  ];
  ok(
    needed.every((f) => existsSync(OUT + '/' + f)),
    'tsc emits the marked-burn graph + authorPay + actionFlow',
  );
  if (!needed.every((f) => existsSync(OUT + '/' + f))) process.exit(1);
}
writeFileSync(OUT + '/package.json', '{"type":"commonjs"}');

/* The wallet is replaced by a programmable stub: the flows
 * under test run for real; only signing/transport is fake. */
writeFileSync(
  OUT + '/lib/wallet.js',
  `'use strict';
const state = { sends: [], submitCalls: [], failSend: null, failSubmit: false, sendCount: 0 };
exports.__state = state;
exports.__reset = () => { state.sends = []; state.submitCalls = []; state.failSend = null; state.failSubmit = false; state.sendCount = 0; };
exports.nowSec = () => 1700000000;
exports.randomCawId = () => '0x' + 'ab'.repeat(32);
exports.signerFor = (kind, secret) => ({ kind, secret });
exports.signerForHsChain = (kind, secret) => ({ kind, secret });
exports.sendCalldata = async (signer, to, data) => {
  state.sendCount++;
  if (state.failSend && state.failSend(data, state.sendCount)) throw new Error('stubbed send failure');
  state.sends.push({ to, data });
  return '0xhash' + state.sendCount;
};
exports.submitAction = async (kind, secret, action) => {
  if (state.failSubmit) throw new Error('stubbed submit failure');
  state.submitCalls.push(action);
  return '0xrecawhash';
};
`,
);

const SL = await import(OUT + '/lib/superlike.js');
const MB = await import(OUT + '/lib/markedBurns.js');
const AP = await import(OUT + '/lib/authorPay.js');
const FLOW = await import(OUT + '/lib/actionFlow.js');
const WALLET = await import(OUT + '/lib/wallet.js');
const CFG = await import(OUT + '/config.js');

const O = (n) => BigInt(n) * 10n ** 18n;
const SL_BURN = O(10_000_000);
const SL_AUTHOR = O(15_000_000);
const SL_TOTAL = O(25_000_000);
const SRC_BURN = O(20_000_000);
const LEGACY = O(1_000_000);
const P1 = '0x' + '11'.repeat(32);
const P2 = '0x' + '22'.repeat(32);

/* ---------- the money constants: one source of truth ---------- */
{
  ok(
    MB.SUPERLIKE_TOTAL_RAW === SL_TOTAL &&
      MB.SUPERLIKE_BURN_RAW === SL_BURN &&
      MB.SUPERLIKE_AUTHOR_RAW === SL_AUTHOR &&
      SL.SUPERLIKE_TOTAL_RAW === SL_TOTAL &&
      SL.SUPERLIKE_BURN_RAW === SL_BURN &&
      SL.SUPERLIKE_AUTHOR_RAW === SL_AUTHOR,
    'constants: SuperLike total 25,000,000 = author 15,000,000 + burn 10,000,000 (markedBurns + superlike agree)',
  );
  ok(
    MB.SUPERRECAW_TOTAL_RAW === SL_TOTAL &&
      MB.SUPERRECAW_BURN_RAW === SRC_BURN &&
      MB.SUPERRECAW_AUTHOR_RAW === O(5_000_000),
    'constants: SuperRecaw total 25,000,000 = author 5,000,000 + burn 20,000,000',
  );
  ok(
    MB.LEGACY_MARKED_BURN_RAW === LEGACY,
    'constants: the legacy burn (v0.5.0–v0.6.2) is exactly 1,000,000 O',
  );
  ok(
    MB.SUPERLIKE_BURN_AMOUNTS.length === 2 &&
      MB.SUPERLIKE_BURN_AMOUNTS.includes(SL_BURN) &&
      MB.SUPERLIKE_BURN_AMOUNTS.includes(LEGACY) &&
      !MB.SUPERLIKE_BURN_AMOUNTS.includes(SRC_BURN),
    'detection set SLK1 = {10,000,000 current, 1,000,000 legacy} — the SuperRecaw burn is NOT in it',
  );
  ok(
    MB.SUPERRECAW_BURN_AMOUNTS.length === 2 &&
      MB.SUPERRECAW_BURN_AMOUNTS.includes(SRC_BURN) &&
      MB.SUPERRECAW_BURN_AMOUNTS.includes(LEGACY) &&
      !MB.SUPERRECAW_BURN_AMOUNTS.includes(SL_BURN),
    'detection set SRC1 = {20,000,000 current, 1,000,000 legacy} — the SuperLike burn is NOT in it',
  );
  ok(
    AP.authorPayAmountFor('sl') === SL_AUTHOR &&
      AP.authorPayAmountFor('src') === O(5_000_000),
    'authorPay legs price from the same constants (15M / 5M)',
  );
  ok(
    MB.BURN_ADDRESS === '0x000000000000000000000000000000000000dEaD',
    'the burn address is the established 0x…dEaD',
  );
  ok(
    CFG.O_TOKEN === '0x6c39b68a28bA90F4EB80032ec0eB32ad81cbbEd4',
    'O token target is the QL1 contract',
  );
  ok(
    MB.MARKED_BURN_START_BLOCK === 13400000,
    'scan starts just under the 2026-11-10 QL1 head (no marked burn can predate it)',
  );
  const PLAIN_GAS = 35077;
  const MARKED_GAS = 35281;
  ok(
    MARKED_GAS - PLAIN_GAS === 5 * 16 + 31 * 4,
    'probe fixture: gas delta 204 = intrinsic cost of the marker bytes only',
  );
}

/* ---------- the marker codec ---------- */
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
  ok(
    BigInt('0x' + data.slice(74, 138)) === SL_BURN,
    'the burn leg is exactly 10,000,000 O (v0.6.3 — no longer 1,000,000)',
  );
  const mark = SL.parseSuperlikeInput(data);
  ok(!!mark, 'parse accepts the built data');
  ok(mark.amount === SL_BURN, 'round-trip: amount is the burn leg');
  ok(mark.cawId === P1, 'round-trip: cawId survives');
  ok(mark.to.toLowerCase() === MB.BURN_ADDRESS.toLowerCase(), 'round-trip: burn recipient');
  ok(SL.buildSuperlikeData('0x1234') === null, 'bad cawId refused');
  // rejects
  const plain =
    '0xa9059cbb' +
    '0'.repeat(24) +
    '000000000000000000000000000000000000dead' +
    SL_BURN.toString(16).padStart(64, '0');
  ok(SL.parseSuperlikeInput(plain) === null, 'plain (unmarked) burn is not a SuperLike');
  ok(SL.parseSuperlikeInput(data.slice(0, -2)) === null, 'truncated marker rejected');
  const wrongMagic = data.replace(SL.SUPERLIKE_MAGIC, 'deadbeef');
  ok(SL.parseSuperlikeInput(wrongMagic) === null, 'wrong magic rejected');
  const wrongSel = '0x095ea7b3' + data.slice(10);
  ok(SL.parseSuperlikeInput(wrongSel) === null, 'non-transfer selector rejected');
  ok(SL.parseSuperlikeInput(data + 'ff') === null, 'extra trailing byte rejected');
  const toOther =
    '0xa9059cbb' +
    '0'.repeat(24) +
    '1111111111111111111111111111111111111111' +
    SL_BURN.toString(16).padStart(64, '0') +
    SL.SUPERLIKE_MAGIC +
    P1.slice(2);
  ok(MB.parseMarkedBurnInput(toOther) === null, 'marked transfer to a non-burn address rejected');
  const src = MB.buildMarkedBurnData(MB.SUPERRECAW_MAGIC, P1, SRC_BURN);
  const srcMark = MB.parseMarkedBurnInput(src);
  ok(!!srcMark && srcMark.magic === MB.SUPERRECAW_MAGIC, 'shared codec parses SRC1');
  ok(SL.parseSuperlikeInput(src) === null, 'an SRC1 burn never parses as a SuperLike');
  // the author leg is a PLAIN transfer: no marker, 68 bytes,
  // and it must never parse as a marked burn
  const pay = AP.buildAuthorPayData(
    '0x0Cdd1EbbBCb55601b207B384245dDe646882b86B',
    SL_AUTHOR,
  );
  ok(
    (pay.length - 2) / 2 === 68 && MB.parseMarkedBurnInput(pay) === null,
    'the author leg is a plain 68-byte transfer with NO marker',
  );
  ok(
    BigInt('0x' + pay.slice(74, 138)) === SL_AUTHOR,
    'the author leg carries exactly 15,000,000 O',
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
  ok(SL.superlikeShortfall(SL_TOTAL - 1n) === true, 'precheck: 24,999,999.99… O blocked (the TOTAL gates, not one leg)');
  ok(SL.superlikeShortfall(SL_TOTAL) === false, 'precheck: exactly 25,000,000 O ok');
  ok(SL.superlikeShortfall(SL_BURN) === true, 'precheck: burn-only money (10M) is NOT enough anymore');
  ok(SL.superlikeShortfall(0n) === true, 'precheck: 0 blocked');
}

/* ---------- the marked-burn scanner: detection sets ---------- */
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
const burnData = (magic, cawId, amount) => {
  // a marked burn at an ARBITRARY amount (legacy / wrong-set fixtures)
  const base = MB.buildMarkedBurnData(magic, cawId, amount);
  return base;
};
{
  const START = MB.MARKED_BURN_START_BLOCK;
  const HEAD = START + 9500; // two chunks: 9000 + 500
  const txInputs = {
    txA: SL.buildSuperlikeData(P1), // SLK1 10M — counts (current)
    txB: SL.buildSuperlikeData(P1), // SLK1 10M input but the LOG value disagrees -> excluded
    txC: SL.buildSuperlikeData(P2), // SLK1 10M for P2 — counts
    txD:
      '0xa9059cbb' +
      '0'.repeat(24) +
      '000000000000000000000000000000000000dead' +
      SL_BURN.toString(16).padStart(64, '0'), // plain burn, no marker -> excluded
    txE: burnData(MB.SUPERLIKE_MAGIC, P1, O(999_999)), // SLK1 at a non-set amount -> excluded
    txF: burnData(MB.SUPERRECAW_MAGIC, P1, SRC_BURN), // SRC1 20M -> src index, not a SuperLike
    txG: burnData(MB.SUPERLIKE_MAGIC, P1, LEGACY), // SLK1 legacy 1M -> COUNTS (no cut-off)
    txH: burnData(MB.SUPERLIKE_MAGIC, P1, SRC_BURN), // SLK1 at the SRC amount -> excluded (wrong set)
    txI: burnData(MB.SUPERRECAW_MAGIC, P1, SL_BURN), // SRC1 at the SL amount -> excluded everywhere
    txJ: burnData(MB.SUPERRECAW_MAGIC, P1, LEGACY), // SRC1 legacy 1M -> src index
  };
  const chunks = new Map([
    [
      START,
      [
        logFor('txA', SENDER, SL_BURN),
        logFor('txB', SENDER, O(250)),
        logFor('txC', OTHER, SL_BURN),
        logFor('txD', SENDER, SL_BURN),
        logFor('txE', SENDER, O(999_999)),
        logFor('txF', SENDER, SRC_BURN),
        logFor('txG', OTHER, LEGACY),
        logFor('txH', SENDER, SRC_BURN),
        logFor('txI', SENDER, SL_BURN),
        logFor('txJ', SENDER, LEGACY),
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
  ok(
    n1 === 2,
    'scanner: P1 counts the current 10M burn AND the legacy 1M burn (log-mismatch, plain, wrong-amount, SRC-amount and SRC1 all excluded)',
  );
  const n2 = await SL.superlikeCount(P2);
  ok(n2 === 1, 'scanner: P2 counted from the same scan');
  ok(SL.superlikeCountCached(P1) === 2, 'scanner: cached count readable');
  ok(
    MB.superRecawCached(P1, SENDER) === true &&
      MB.superRecawCached(P1, OTHER) === false,
    'scanner: SRC1 marks (20M current + 1M legacy) index by (cawId, sender); the SRC1-at-10M mark counts for nobody',
  );
  const before = stub.getLogsCalls;
  await SL.superlikeCount(P1);
  ok(stub.getLogsCalls === before, 'scanner: cursor current -> no rescan of old chunks');
  const saved = JSON.parse(kvMem.get('caw-marked-burns-v1'));
  ok(saved.to === HEAD, 'scanner: cursor persisted at the scanned head');
  ok(
    saved.sl[P1] === 2 && saved.src[P1 + ':' + SENDER] === 2,
    'scanner: both indexes persisted to the on-device KV (src counts current + legacy)',
  );
}

/* ---------- scanner failure: cursor must not advance ---------- */
{
  const OUT2 = ROOT + '/scripts/.build-superlike-fail';
  rmSync(OUT2, { recursive: true, force: true });
  cpSync(OUT, OUT2, { recursive: true });
  const MB2 = await import(OUT2 + '/lib/markedBurns.js');
  const START = MB2.MARKED_BURN_START_BLOCK;
  const HEAD = START + 19000; // chunks: 9000, 9000, 1000
  const chunks = new Map([[START, [logFor('txA', SENDER, SL_BURN)]]]);
  const txInputs = { txA: MB2.buildMarkedBurnData(MB2.SUPERLIKE_MAGIC, P1, SL_BURN) };
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

/* ---------- the author-pay debt store ---------- */
{
  const ME = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC';
  const AUTHOR = '0x0Cdd1EbbBCb55601b207B384245dDe646882b86B';
  const kvMem = new Map();
  const kv = {
    getItem: async (k) => kvMem.get(k) ?? null,
    setItem: async (k, v) => void kvMem.set(k, v),
  };
  AP.initAuthorPayStore(kv);
  ok(
    (await AP.pendingAuthorPayFor(ME, 'sl', P1)) === null,
    'pay debt: none recorded initially',
  );
  await AP.recordAuthorPay(ME, 'sl', {
    cawId: P1,
    author: AUTHOR,
    amountRaw: SL_AUTHOR,
    ts: 1700000000,
  });
  const rec = await AP.pendingAuthorPayFor(ME, 'sl', P1);
  ok(
    !!rec && rec.author === AUTHOR && rec.amountRaw === SL_AUTHOR,
    'pay debt: readable with the pinned author + amount',
  );
  ok(
    (await AP.pendingAuthorPayFor(ME, 'src', P1)) === null &&
      (await AP.pendingAuthorPayFor(ME, 'sl', P2)) === null &&
      (await AP.pendingAuthorPayFor(AUTHOR, 'sl', P1)) === null,
    'pay debt: scoped per (sender, kind, post)',
  );
  const saved = JSON.parse(kvMem.get('caw-author-pay-v1'));
  ok(
    Object.values(saved).some(
      (v) => v.cawId === P1 && v.amount === SL_AUTHOR.toString(),
    ),
    'pay debt: persisted to the on-device KV (survives restarts)',
  );
  // a "restart": a fresh module instance over the same KV
  const OUT3 = ROOT + '/scripts/.build-superlike-restart';
  rmSync(OUT3, { recursive: true, force: true });
  cpSync(OUT, OUT3, { recursive: true });
  const AP3 = await import(OUT3 + '/lib/authorPay.js');
  AP3.initAuthorPayStore(kv);
  const rec3 = await AP3.pendingAuthorPayFor(ME, 'sl', P1);
  ok(
    !!rec3 && rec3.amountRaw === SL_AUTHOR,
    'pay debt: a fresh module instance (app restart) still sees it',
  );
  await AP.clearAuthorPay(ME, 'sl', P1);
  ok(
    (await AP.pendingAuthorPayFor(ME, 'sl', P1)) === null,
    'pay debt: cleared only by an explicit clear (the confirmed retry)',
  );
}

/* ---------- BEHAVIOUR: the real SuperLike flow ---------- */
{
  const ME = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC';
  const AUTHOR = '0x0Cdd1EbbBCb55601b207B384245dDe646882b86B';
  let oBal = O(100_000_000);
  const addrWord = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (req) => {
      if (req.method === 'eth_call') {
        const data = req.params[0].data;
        if (data.startsWith('0x6352211e')) return { result: addrWord(AUTHOR) }; // ownerOf
        if (data.startsWith('0x70a08231')) return { result: word(oBal) }; // balanceOf
        return { result: '0x' };
      }
      if (req.method === 'eth_blockNumber')
        return { result: '0x' + (MB.MARKED_BURN_START_BLOCK + 10).toString(16) };
      if (req.method === 'eth_getLogs') return { result: [] };
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
  const kvMem = new Map();
  const kv = {
    getItem: async (k) => kvMem.get(k) ?? null,
    setItem: async (k, v) => void kvMem.set(k, v),
  };
  SL.initSuperlikeStore(kv);
  AP.initAuthorPayStore(kv);
  const app = {
    address: ME,
    myTokens: [{ id: 7n }],
    actingId: 7n,
    requireAuth: async () => true,
    getSecret: () => ({ kind: 'phrase', secret: 'test' }),
    refreshBalances: async () => {},
  };
  const target = { senderId: 5n, cawId: P1, hash: 'h1' };
  const amtOf = (d) => BigInt('0x' + d.slice(74, 138));
  const toOf = (d) => '0x' + d.slice(34, 74);

  // happy path: burn first, payment second, nothing owed
  WALLET.__reset();
  await FLOW.performSuperlike(app, { target });
  {
    const s = WALLET.__state.sends;
    ok(s.length === 2, 'flow: a SuperLike sends exactly two transactions');
    const m = SL.parseSuperlikeInput(s[0].data);
    ok(!!m && m.amount === SL_BURN, 'flow: leg 1 is the marked 10M burn');
    ok(
      (s[1].data.length - 2) / 2 === 68 &&
        toOf(s[1].data).toLowerCase() === AUTHOR.toLowerCase() &&
        amtOf(s[1].data) === SL_AUTHOR,
      'flow: leg 2 is a plain 15M transfer to the author',
    );
    ok(
      (await AP.pendingAuthorPayFor(ME, 'sl', P1)) === null,
      'flow: nothing owed after a clean SuperLike',
    );
  }
  // burn fails: one attempt, error propagates, NO debt
  WALLET.__reset();
  WALLET.__state.failSend = () => true;
  {
    let err = null;
    try {
      await FLOW.performSuperlike(app, { target });
    } catch (e) {
      err = e;
    }
    ok(
      !!err && err.message === 'stubbed send failure',
      'flow: a failed burn is an ordinary failure (no pending code)',
    );
    ok(
      WALLET.__state.sendCount === 1 && WALLET.__state.sends.length === 0,
      'flow: burn failure -> the payment is NEVER attempted',
    );
    ok(
      (await AP.pendingAuthorPayFor(ME, 'sl', P1)) === null,
      'flow: burn failure records NO debt',
    );
  }
  // payment fails: sl-pay-pending + debt; retry sends ONLY the transfer
  WALLET.__reset();
  WALLET.__state.failSend = (d, n) => n === 2;
  {
    let err = null;
    try {
      await FLOW.performSuperlike(app, { target });
    } catch (e) {
      err = e;
    }
    ok(
      !!err && err.message === 'sl-pay-pending',
      'flow: a failed payment after the burn reports sl-pay-pending',
    );
    const pend = await AP.pendingAuthorPayFor(ME, 'sl', P1);
    ok(
      !!pend && pend.amountRaw === SL_AUTHOR &&
        pend.author.toLowerCase() === AUTHOR.toLowerCase(),
      'flow: the debt pins the author + the 15M amount',
    );
    WALLET.__reset();
    await FLOW.performAuthorPay(app, { target, kind: 'sl' });
    const s = WALLET.__state.sends;
    ok(
      s.length === 1 && (s[0].data.length - 2) / 2 === 68 &&
        amtOf(s[0].data) === SL_AUTHOR &&
        SL.parseSuperlikeInput(s[0].data) === null,
      'flow: the retry sends ONLY the plain transfer (no second burn)',
    );
    ok(
      (await AP.pendingAuthorPayFor(ME, 'sl', P1)) === null,
      'flow: the debt clears on the retry’s confirmed success',
    );
  }
  // retry with a short balance: hard stop, debt kept, no send
  await AP.recordAuthorPay(ME, 'sl', {
    cawId: P1,
    author: AUTHOR,
    amountRaw: SL_AUTHOR,
    ts: 1700000000,
  });
  oBal = SL_AUTHOR - 1n;
  WALLET.__reset();
  {
    let err = null;
    try {
      await FLOW.performAuthorPay(app, { target, kind: 'sl' });
    } catch (e) {
      err = e;
    }
    ok(
      !!err && err.message === 'shortfall' && WALLET.__state.sendCount === 0,
      'flow: a short retry balance is a hard stop — nothing attempted',
    );
    ok(
      (await AP.pendingAuthorPayFor(ME, 'sl', P1)) !== null,
      'flow: the debt survives the refused retry',
    );
  }
  oBal = O(100_000_000);
  await AP.clearAuthorPay(ME, 'sl', P1);
  // retry without a debt refuses
  {
    let err = null;
    try {
      await FLOW.performAuthorPay(app, { target, kind: 'sl' });
    } catch (e) {
      err = e;
    }
    ok(
      !!err && err.message === 'no-pending-author-pay',
      'flow: performAuthorPay refuses without a recorded debt',
    );
  }
  // short precheck: 24M refuses before auth/sends
  oBal = O(24_000_000);
  WALLET.__reset();
  {
    let err = null;
    try {
      await FLOW.performSuperlike(app, { target });
    } catch (e) {
      err = e;
    }
    ok(
      !!err && err.message === 'shortfall' && WALLET.__state.sendCount === 0,
      'flow: 24M (< the 25M total) refuses before anything is signed',
    );
  }
  oBal = O(100_000_000);
  // self: the author IS me -> blocked before any send
  {
    const selfApp = { ...app, myTokens: [{ id: 5n }] };
    let err = null;
    try {
      await FLOW.performSuperlike(selfApp, { target });
    } catch (e) {
      err = e;
    }
    ok(
      !!err && err.message === 'self-superlike',
      'flow: a SuperLike on my own name’s post is blocked — so a self-payment can never arise',
    );
  }
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
  const iBurn = flow.indexOf('sendCalldata(signer, O_TOKEN, data)');
  const iPay = flow.indexOf('buildAuthorPayData(authorOwner, SUPERLIKE_AUTHOR_RAW)');
  ok(iSelf > 0 && iSelf < iBurn, 'performSuperlike: self block precedes every send');
  ok(iShort > 0 && iShort < iBurn, 'performSuperlike: shortfall stop precedes every send');
  ok(
    iBurn > 0 && iPay > iBurn,
    'performSuperlike: ORDER — the burn leg is sent before the author leg',
  );
  ok(
    flow.includes('recordAuthorPay') && flow.includes("Error('sl-pay-pending')"),
    'performSuperlike: a failed payment records the debt and reports sl-pay-pending',
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
    'the CAT42 SuperLike path and its debt store stay GONE',
  );
  const payFlow = flowAll.slice(
    flowAll.indexOf('export async function performAuthorPay'),
    flowAll.indexOf('export async function performTip'),
  );
  ok(
    payFlow.includes('pendingAuthorPayFor') &&
      payFlow.includes("Error('no-pending-author-pay')") &&
      !payFlow.includes('submitAction') &&
      !payFlow.includes('buildSuperlikeData') &&
      !payFlow.includes('buildSuperRecawData'),
    'performAuthorPay: debt-gated and can build ONLY the transfer — no burn, no recaw',
  );
  for (const [file, label] of [
    ['src/screens/TimelineScreen.tsx', 'TimelineScreen'],
    ['src/screens/ProfileScreen.tsx', 'ProfileScreen'],
    ['src/screens/PostDetailScreen.tsx', 'PostDetailScreen'],
  ]) {
    const s = readFileSync(ROOT + '/' + file, 'utf8');
    ok(s.includes('onSuperlike={handleSuperlike}'), label + ' passes the handler');
    ok(
      s.includes("tr('sl.body'") &&
        s.includes('SUPERLIKE_TOTAL_RAW') &&
        s.includes('SUPERLIKE_AUTHOR_RAW') &&
        s.includes('SUPERLIKE_BURN_RAW'),
      label + ' sheet shows the TOTAL + the split from the constants',
    );
    ok(
      s.includes("tr('sl.payPending')") && s.includes('performAuthorPay') &&
        s.includes("tr('pay.body'") && s.includes('pendingAuthorPayFor'),
      label + ' surfaces the payment-only retry (debt check, sheet, flow)',
    );
    ok(s.includes("tr('sl.shortfall')"), label + ' surfaces the shortfall guidance');
    ok(
      !s.includes('SUPERLIKE_PRICE_RAW') && !s.includes('MARKED_BURN_PRICE_RAW'),
      label + ': no stale 1M price constant remains',
    );
  }
  const ui = readFileSync(ROOT + '/src/components/ui.tsx', 'utf8');
  ok(ui.includes('StarIcon'), 'PostCard renders the star treatment');
  ok(ui.includes('superlikeCount('), 'PostCard reads the chain count');
  ok(ui.includes('onSuperlike'), 'PostCard exposes the SuperLike action');
  const ctx = readFileSync(ROOT + '/src/context/AppContext.tsx', 'utf8');
  ok(ctx.includes('initSuperlikeStore(storeKV)'), 'AppContext inits the count store');
  ok(ctx.includes('initAuthorPayStore(storeKV)'), 'AppContext inits the author-pay store');
}

console.log(`\nsuperlike: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
