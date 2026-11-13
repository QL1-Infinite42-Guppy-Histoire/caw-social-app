#!/usr/bin/env node
/**
 * SuperRecaw verification (v0.6.3 — Recaw + two money legs).
 *
 * A SuperRecaw = the NORMAL Recaw action first; only after it
 * lands, the money legs: a burn of 20,000,000 O (QL1) carrying
 * the "SRC1" trailing-calldata marker for the ORIGINAL post's
 * cawId, then a plain, unmarked transfer of 5,000,000 O to
 * the original author. Total 25,000,000 O. From v0.5.0 to
 * v0.6.2 the burn alone was 1,000,000 O; those legacy burns
 * stay detected (the SRC1 detection set is
 * {20,000,000, 1,000,000}).
 *
 * This suite pins:
 *  - the SRC1 codec at the new burn amount (shared marked-burn
 *    codec, distinct magic; an SRC1 burn is never a SuperLike
 *    and vice versa);
 *  - the display detection: an SRC1 mark indexed by
 *    (cawId, sender) from the chain-wide marked-burn scan
 *    (stubbed QL1 RPC) — current AND legacy amounts count,
 *    the SuperLike's 10M under SRC1 counts for nobody;
 *  - the pending-burn debt store, now also pinning the author
 *    for the payment handover, and tolerant of pre-v0.6.3
 *    records without the author field;
 *  - BEHAVIOUR of the real flows against a stubbed wallet +
 *    RPC: recaw failure stops everything; burn failure leaves
 *    the burn debt only; the burn retry hands the debt over
 *    to a 5M author-pay record; payment failure leaves the
 *    pay debt only; a SELF SuperRecaw (never blocked) skips
 *    the author leg and gates on the burn alone;
 *  - the wiring statics that enforce ORDER in the screens.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = ROOT + '/scripts/.build-superrecaw';
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
  // Same approach as verify-superlike: the flow files pull
  // the wider type graph in; tsc may print pre-existing type
  // noise from unrelated modules but still EMITS. The gate
  // is that the needed modules were emitted — the app's own
  // `tsc -p tsconfig.json` is the type gate.
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

const MB = await import(OUT + '/lib/markedBurns.js');
const SR = await import(OUT + '/lib/superRecaw.js');
const SL = await import(OUT + '/lib/superlike.js');
const AP = await import(OUT + '/lib/authorPay.js');
const FLOW = await import(OUT + '/lib/actionFlow.js');
const WALLET = await import(OUT + '/lib/wallet.js');

const O = (n) => BigInt(n) * 10n ** 18n;
const SRC_BURN = O(20_000_000);
const SRC_AUTHOR = O(5_000_000);
const SL_BURN = O(10_000_000);
const LEGACY = O(1_000_000);
const P1 = '0x' + '11'.repeat(32);
const P2 = '0x' + '22'.repeat(32);

/* ---------- the SRC1 codec ---------- */
{
  const data = SR.buildSuperRecawData(P1);
  ok(typeof data === 'string', 'buildSuperRecawData returns data');
  ok((data.length - 2) / 2 === 104, 'SRC1 burn is exactly 104 bytes');
  ok(data.toLowerCase().includes(SR.SUPERRECAW_MAGIC), 'carries the SRC1 magic');
  ok(
    !data.toLowerCase().includes(SL.SUPERLIKE_MAGIC),
    'carries no SLK1 magic',
  );
  const mark = MB.parseMarkedBurnInput(data);
  ok(
    !!mark && mark.magic === MB.SUPERRECAW_MAGIC && mark.cawId === P1 &&
      mark.amount === SRC_BURN,
    'shared codec parses it as an SRC1 burn of exactly 20,000,000 O (v0.6.3)',
  );
  ok(SL.parseSuperlikeInput(data) === null, 'an SRC1 burn is NOT a SuperLike');
  const slk = SL.buildSuperlikeData(P1);
  ok(
    MB.parseMarkedBurnInput(slk).magic === MB.SUPERLIKE_MAGIC,
    'an SLK1 burn is not an SRC1 burn either',
  );
  ok(SR.buildSuperRecawData('0x1234') === null, 'bad cawId refused');
}

/* ---------- display detection from the chain index ---------- */
const word = (n) => '0x' + n.toString(16).padStart(64, '0');
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicAddr = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const RECAWER = '0x1111111111111111111111111111111111111111';
const BYSTANDER = '0x2222222222222222222222222222222222222222';
{
  const START = MB.MARKED_BURN_START_BLOCK;
  const HEAD = START + 100;
  const txInputs = {
    txS: SR.buildSuperRecawData(P1), // SRC1 20M by RECAWER for P1 (current)
    txL: SL.buildSuperlikeData(P1), // SLK1 10M by RECAWER for P1 (not a recaw mark)
    txO: SR.buildSuperRecawData(P2), // SRC1 20M by BYSTANDER for P2
    txG: MB.buildMarkedBurnData(MB.SUPERRECAW_MAGIC, P1, LEGACY), // SRC1 legacy 1M by BYSTANDER for P1
    txX: MB.buildMarkedBurnData(MB.SUPERRECAW_MAGIC, P1, SL_BURN), // SRC1 at the SL amount — counts for nobody
  };
  const logs = [
    { transactionHash: 'txS', topics: [TRANSFER_TOPIC, topicAddr(RECAWER), topicAddr(MB.BURN_ADDRESS)], data: word(SRC_BURN) },
    { transactionHash: 'txL', topics: [TRANSFER_TOPIC, topicAddr(RECAWER), topicAddr(MB.BURN_ADDRESS)], data: word(SL_BURN) },
    { transactionHash: 'txO', topics: [TRANSFER_TOPIC, topicAddr(BYSTANDER), topicAddr(MB.BURN_ADDRESS)], data: word(SRC_BURN) },
    { transactionHash: 'txG', topics: [TRANSFER_TOPIC, topicAddr(BYSTANDER), topicAddr(MB.BURN_ADDRESS)], data: word(LEGACY) },
    { transactionHash: 'txX', topics: [TRANSFER_TOPIC, topicAddr(RECAWER), topicAddr(MB.BURN_ADDRESS)], data: word(SL_BURN) },
  ];
  const kvMem = new Map();
  MB.initMarkedBurnStore({
    getItem: async (k) => kvMem.get(k) ?? null,
    setItem: async (k, v) => void kvMem.set(k, v),
  });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (req) => {
      if (req.method === 'eth_blockNumber')
        return { result: '0x' + HEAD.toString(16) };
      if (req.method === 'eth_getLogs') {
        const from = parseInt(req.params[0].fromBlock, 16);
        return { result: from === START ? logs : [] };
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
  ok(
    (await SR.hasSuperRecawFor(P1, RECAWER)) === true,
    'detection: the recawer’s current 20M SRC1 mark shows the SuperRecaw treatment',
  );
  ok(
    SR.superRecawCachedFor(P1, BYSTANDER) === true,
    'detection: a LEGACY 1M SRC1 mark still shows it too (no cut-off)',
  );
  ok(
    SR.superRecawCachedFor(P2, RECAWER) === false &&
      SR.superRecawCachedFor(P2, BYSTANDER) === true,
    'detection: marks are per (post, sender)',
  );
  ok(
    (await SL.superlikeCount(P1)) === 1,
    'detection: the SLK1 mark in the same scan counts as a SuperLike only',
  );
}

/* ---------- the pending-burn debt store (+ author handover) ---------- */
{
  const kvMem = new Map();
  const AUTHOR = '0x0Cdd1EbbBCb55601b207B384245dDe646882b86B';
  SR.initSuperRecawStore({
    getItem: async (k) => kvMem.get(k) ?? null,
    setItem: async (k, v) => void kvMem.set(k, v),
  });
  ok(
    (await SR.pendingSrcBurnFor(RECAWER, P1)) === null,
    'debt: none recorded initially',
  );
  await SR.recordSrcBurn(RECAWER, { cawId: P1, ts: 1794300000, author: AUTHOR });
  const rec = await SR.pendingSrcBurnFor(RECAWER, P1);
  ok(
    !!rec && rec.cawId === P1 && rec.ts === 1794300000 && rec.author === AUTHOR,
    'debt: readable after recording — WITH the author pinned for the payment handover (v0.6.3)',
  );
  ok(
    (await SR.pendingSrcBurnFor(RECAWER, P2)) === null,
    'debt: a different post owes nothing',
  );
  ok(
    (await SR.pendingSrcBurnFor(BYSTANDER, P1)) === null,
    'debt: a different sender owes nothing',
  );
  const saved = JSON.parse(kvMem.get('caw-superrecaw-burn-v1'));
  ok(
    Object.values(saved).some((v) => v.cawId === P1),
    'debt: persisted to the on-device KV (survives restarts)',
  );
  await SR.clearSrcBurn(RECAWER, P1);
  ok(
    (await SR.pendingSrcBurnFor(RECAWER, P1)) === null,
    'debt: cleared once the burn lands',
  );
  // pre-v0.6.3 records have NO author field — they must load
  kvMem.set(
    'caw-superrecaw-burn-v1',
    JSON.stringify({
      [RECAWER.toLowerCase() + ':' + P1]: { cawId: P1, ts: 1794300001 },
    }),
  );
  const OUT2 = ROOT + '/scripts/.build-superrecaw-old';
  rmSync(OUT2, { recursive: true, force: true });
  cpSync(OUT, OUT2, { recursive: true });
  const SR2 = await import(OUT2 + '/lib/superRecaw.js');
  SR2.initSuperRecawStore({
    getItem: async (k) => kvMem.get(k) ?? null,
    setItem: async (k, v) => void kvMem.set(k, v),
  });
  const old = await SR2.pendingSrcBurnFor(RECAWER, P1);
  ok(
    !!old && old.cawId === P1 && (old.author ?? '') === '',
    'debt: a pre-v0.6.3 record (no author field) still loads — the retry resolves the author fresh',
  );
}

/* ---------- BEHAVIOUR: the real SuperRecaw flows ---------- */
{
  const ME = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC';
  const AUTHOR = '0x0Cdd1EbbBCb55601b207B384245dDe646882b86B';
  let oBal = O(100_000_000);
  let ownerAddr = AUTHOR;
  const addrWord = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (req) => {
      if (req.method === 'eth_call') {
        const data = req.params[0].data;
        if (data.startsWith('0x6352211e')) return { result: addrWord(ownerAddr) }; // ownerOf
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
  SR.initSuperRecawStore(kv);
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
  const isSrcBurn = (d) =>
    d.toLowerCase().includes(MB.SUPERRECAW_MAGIC) && amtOf(d) === SRC_BURN;

  // happy path: recaw, then the marked 20M burn, then the plain 5M payment
  WALLET.__reset();
  await FLOW.performSuperRecaw(app, { target });
  {
    const s = WALLET.__state;
    ok(s.submitCalls.length === 1, 'flow: the Recaw is submitted exactly once');
    ok(
      s.sends.length === 2 && isSrcBurn(s.sends[0].data),
      'flow: money leg 1 is the marked 20M burn',
    );
    ok(
      (s.sends[1].data.length - 2) / 2 === 68 && amtOf(s.sends[1].data) === SRC_AUTHOR,
      'flow: money leg 2 is a plain 5M transfer to the author',
    );
    ok(
      (await SR.pendingSrcBurnFor(ME, P1)) === null &&
        (await AP.pendingAuthorPayFor(ME, 'src', P1)) === null,
      'flow: nothing owed after a clean SuperRecaw',
    );
  }
  // recaw fails: NO money legs, NO debts
  WALLET.__reset();
  WALLET.__state.failSubmit = true;
  {
    let err = null;
    try {
      await FLOW.performSuperRecaw(app, { target });
    } catch (e) {
      err = e;
    }
    ok(!!err, 'flow: a failed Recaw propagates');
    ok(
      WALLET.__state.sends.length === 0,
      'flow: recaw failure -> NO burn and NO payment attempted',
    );
    ok(
      (await SR.pendingSrcBurnFor(ME, P1)) === null &&
        (await AP.pendingAuthorPayFor(ME, 'src', P1)) === null,
      'flow: recaw failure records NO debt of either kind',
    );
  }
  WALLET.__state.failSubmit = false;
  // burn fails: burn debt only (author pinned), no pay debt;
  // the burn retry then hands over to the pay debt
  WALLET.__reset();
  WALLET.__state.failSend = (d, n) => n === 1;
  {
    let err = null;
    try {
      await FLOW.performSuperRecaw(app, { target });
    } catch (e) {
      err = e;
    }
    ok(
      !!err && err.message === 'src-burn-pending',
      'flow: a failed burn after the Recaw reports src-burn-pending',
    );
    const debt = await SR.pendingSrcBurnFor(ME, P1);
    ok(
      !!debt && debt.author.toLowerCase() === AUTHOR.toLowerCase(),
      'flow: the burn debt pins the author for the handover',
    );
    ok(
      (await AP.pendingAuthorPayFor(ME, 'src', P1)) === null,
      'flow: while the burn is owed, NO pay debt exists yet',
    );
    WALLET.__reset();
    await FLOW.performSuperRecawBurn(app, { target });
    const s = WALLET.__state;
    ok(
      s.sends.length === 1 && isSrcBurn(s.sends[0].data) && s.submitCalls.length === 0,
      'flow: the burn retry sends ONLY the burn — never a second Recaw',
    );
    ok(
      (await SR.pendingSrcBurnFor(ME, P1)) === null,
      'flow: the burn debt clears when the retry lands',
    );
    const pay = await AP.pendingAuthorPayFor(ME, 'src', P1);
    ok(
      !!pay && pay.amountRaw === SRC_AUTHOR &&
        pay.author.toLowerCase() === AUTHOR.toLowerCase(),
      'flow: the landed burn hands the debt over — the 5M author payment is now owed',
    );
    WALLET.__reset();
    await FLOW.performAuthorPay(app, { target, kind: 'src' });
    ok(
      WALLET.__state.sends.length === 1 &&
        (WALLET.__state.sends[0].data.length - 2) / 2 === 68 &&
        amtOf(WALLET.__state.sends[0].data) === SRC_AUTHOR &&
        (await AP.pendingAuthorPayFor(ME, 'src', P1)) === null,
      'flow: the payment retry sends ONLY the transfer and clears the debt',
    );
  }
  // payment fails in the main flow: pay debt only, burn stands
  WALLET.__reset();
  WALLET.__state.failSend = (d, n) => n === 2;
  {
    let err = null;
    try {
      await FLOW.performSuperRecaw(app, { target });
    } catch (e) {
      err = e;
    }
    ok(
      !!err && err.message === 'src-pay-pending',
      'flow: a failed payment after the burn reports src-pay-pending',
    );
    ok(
      WALLET.__state.sends.length === 1 &&
        (await SR.pendingSrcBurnFor(ME, P1)) === null &&
        (await AP.pendingAuthorPayFor(ME, 'src', P1)) !== null,
      'flow: the burn stands, no burn debt — only the payment is owed',
    );
    await AP.clearAuthorPay(ME, 'src', P1);
  }
  WALLET.__state.failSend = null;
  // SELF SuperRecaw: allowed (never blocked); the author leg
  // is skipped and the gate drops to the burn alone
  ownerAddr = ME;
  oBal = O(21_000_000);
  WALLET.__reset();
  {
    await FLOW.performSuperRecaw(app, { target });
    const s = WALLET.__state;
    ok(
      s.submitCalls.length === 1 && s.sends.length === 1 && isSrcBurn(s.sends[0].data),
      'flow: a self SuperRecaw sends the Recaw + the burn ONLY (no payment to oneself)',
    );
    ok(
      (await AP.pendingAuthorPayFor(ME, 'src', P1)) === null,
      'flow: a self SuperRecaw can never leave a pay debt',
    );
  }
  oBal = O(19_000_000);
  WALLET.__reset();
  {
    let err = null;
    try {
      await FLOW.performSuperRecaw(app, { target });
    } catch (e) {
      err = e;
    }
    ok(
      !!err && err.message === 'shortfall' && WALLET.__state.submitCalls.length === 0,
      'flow: a self SuperRecaw still needs the 20M burn — 19M refuses before the Recaw',
    );
  }
  // non-self shortfall: 24M refuses the whole Super path
  ownerAddr = AUTHOR;
  oBal = O(24_000_000);
  WALLET.__reset();
  {
    let err = null;
    try {
      await FLOW.performSuperRecaw(app, { target });
    } catch (e) {
      err = e;
    }
    ok(
      !!err && err.message === 'shortfall' && WALLET.__state.submitCalls.length === 0,
      'flow: 24M (< the 25M total) refuses before the Recaw is signed',
    );
  }
  oBal = O(100_000_000);
}

/* ---------- wiring statics: ORDER is the whole point ---------- */
{
  const flowAll = readFileSync(ROOT + '/src/lib/actionFlow.ts', 'utf8');
  const sup = flowAll.slice(
    flowAll.indexOf('export async function performSuperRecaw'),
    flowAll.indexOf('export async function performSuperRecawBurn'),
  );
  const iBalance = sup.indexOf('oBalanceOf');
  const iShort = sup.indexOf("Error('shortfall')");
  const iRecaw = sup.indexOf('submitAction');
  const iBurn = sup.indexOf('sendCalldata');
  const iPay = sup.indexOf('buildAuthorPayData(authorOwner, SUPERRECAW_AUTHOR_RAW)');
  ok(iBalance > 0 && iShort > iBalance, 'performSuperRecaw: fresh O balance gate comes first');
  ok(
    iShort > 0 && iShort < iRecaw,
    'performSuperRecaw: shortfall refuses the WHOLE Super path before any recaw',
  );
  ok(
    iRecaw > 0 && iBurn > iRecaw,
    'performSuperRecaw: the recaw is submitted BEFORE the burn is sent',
  );
  ok(
    iPay > iBurn,
    'performSuperRecaw: the author payment is sent AFTER the burn',
  );
  ok(
    sup.includes('recordSrcBurn') && sup.includes("Error('src-burn-pending')"),
    'performSuperRecaw: a failed burn records the debt and reports src-burn-pending',
  );
  ok(
    sup.includes('recordAuthorPay') && sup.includes("Error('src-pay-pending')"),
    'performSuperRecaw: a failed payment records the pay debt and reports src-pay-pending',
  );
  ok(
    sup.includes('SUPERRECAW_BURN_RAW') && sup.includes('SUPERRECAW_AUTHOR_RAW') &&
      !sup.includes('MARKED_BURN_PRICE_RAW') && !sup.includes('1000000'),
    'performSuperRecaw: gates price from the new constants — no 1M assumption remains',
  );
  const burn = flowAll.slice(
    flowAll.indexOf('export async function performSuperRecawBurn'),
    flowAll.indexOf('export async function performAuthorPay'),
  );
  ok(
    burn.includes('pendingSrcBurnFor') &&
      burn.includes("Error('no-pending-src-burn')"),
    'performSuperRecawBurn: refuses without a recorded debt',
  );
  ok(
    burn.includes('buildSuperRecawData') && burn.includes('clearSrcBurn'),
    'performSuperRecawBurn: sends the burn and clears the debt',
  );
  ok(
    !burn.includes('submitAction') && !burn.includes('type: 2') &&
      !burn.includes('CawAction'),
    'performSuperRecawBurn: contains NO recaw construction — it can never resend one',
  );
  ok(
    burn.includes('recordAuthorPay') && burn.includes('SUPERRECAW_AUTHOR_RAW'),
    'performSuperRecawBurn: hands the debt over to the author payment once the burn lands',
  );
  ok(
    burn.includes('oBalanceOf') && burn.includes('requireAuth'),
    'performSuperRecawBurn: fresh balance gate + auth gate',
  );
  for (const [file, label] of [
    ['src/screens/TimelineScreen.tsx', 'TimelineScreen'],
    ['src/screens/ProfileScreen.tsx', 'ProfileScreen'],
  ]) {
    const s = readFileSync(ROOT + '/' + file, 'utf8');
    ok(
      s.includes('performSuperRecaw') && s.includes("tr('src.body'"),
      label + ' offers SuperRecaw with the total + split shown first',
    );
    ok(
      s.includes('SUPERRECAW_TOTAL_RAW') && s.includes('SUPERRECAW_AUTHOR_RAW') &&
        s.includes('SUPERRECAW_BURN_RAW'),
      label + ' prices the sheets/gate from the new constants',
    );
    ok(
      s.includes("tr('src.bodySelf'"),
      label + ' shows the honest burn-only sheet for one’s own post',
    );
    ok(
      s.includes('pendingSrcBurnFor') && s.includes('performSuperRecawBurn') &&
        s.includes("tr('src.burnBody'"),
      label + ' offers the burn-only retry when a burn debt exists',
    );
    ok(
      s.includes('pendingAuthorPayFor') && s.includes('performAuthorPay') &&
        s.includes("tr('src.payPending')") && s.includes("tr('pay.body'"),
      label + ' offers the payment-only retry when a pay debt exists',
    );
    ok(
      s.includes("code !== 'src-burn-pending' && code !== 'src-pay-pending'"),
      label + ': a pay debt keeps the recaw lit, like a burn debt does',
    );
    ok(
      s.includes("tr('tl.superRecaw')"),
      label + ' labels the SuperRecaw choice with its price',
    );
    ok(
      !s.includes('MARKED_BURN_PRICE_RAW') && !s.includes('SUPERLIKE_PRICE_RAW'),
      label + ': no stale 1M price constant remains',
    );
  }
  const ui = readFileSync(ROOT + '/src/components/ui.tsx', 'utf8');
  ok(
    ui.includes('superRecawCachedFor') && ui.includes('hasSuperRecawFor'),
    'RecawCard detects the SuperRecaw mark from the chain index',
  );
  ok(
    !ui.includes('superFrame') &&
      !ui.includes('LinearGradient') &&
      ui.includes("tr('tl.superRecaw')") &&
      ui.includes('SUPERLIKE_ON'),
    'RecawCard renders FLAT with the gold SuperRecaw attribution line (v0.6.1; the gradient frame + badge are gone)',
  );
  const ctx = readFileSync(ROOT + '/src/context/AppContext.tsx', 'utf8');
  ok(ctx.includes('initSuperRecawStore(storeKV)'), 'AppContext inits the burn-debt store');
  ok(ctx.includes('initAuthorPayStore(storeKV)'), 'AppContext inits the author-pay store');
}

console.log(`\nsuperrecaw: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
