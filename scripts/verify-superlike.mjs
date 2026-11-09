#!/usr/bin/env node
/**
 * SuperLike verification (v0.4.8; price/split v0.4.9). Behaviour
 * where the module allows it (marker codec, burn codec, guard
 * decisions, the pending-burn store, the count scanner against
 * a stubbed 42 Chain RPC), statics for the RN-bound wiring
 * (performSuperlike / performSuperlikeBurn / TimelineScreen /
 * ProfileScreen / PostDetailScreen / PostCard), and the live
 * tolerance probe's numbers as a fixture.
 *
 * v0.4.9 price: 1,000 CAT42 total = 500 to the author (marked
 * leg, sent first) + 500 burned (plain leg). The count rule is
 * exactly-500: no SuperLike exists on-chain at the old v0.4.8
 * price (the shipped scanner verified count 0), so there is
 * no legacy 100 rule to honour — a marked 100 transfer must
 * NOT count, and this suite pins that.
 *
 * The tolerance fixture: on 2026-11-09 both production 42
 * Chain RPCs were probed with a simulated 100 CAT42 transfer
 * from the CAT42/ZAP pair (balance ~5.07M CAT42):
 *   eth_call plain  -> 0x…01 (true)
 *   eth_call marked -> 0x…01 (true)   (marker = "SLK1" + cawId)
 *   estimateGas plain  = 51,542
 *   estimateGas marked = 52,118  (delta 576 = 36 nonzero
 *   calldata bytes x 16 — intrinsic calldata cost only; the
 *   execution is identical, the trailing bytes never read)
 * eth_simulateV1 and debug_traceCall are disabled on both
 * endpoints, so logs could not be captured from simulation;
 * the Transfer log is emitted by the same untouched execution.
 * (The probe predates the v0.4.9 price change; the marker
 * mechanics are amount-independent.)
 */
import { execFileSync } from 'node:child_process';
import {
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
  ok(true, 'tsc compiles config/cawCore/chains/cawApi/superlike');
} catch (e) {
  ok(false, 'tsc: ' + (e.stdout || '').toString().slice(0, 400));
  process.exit(1);
}
writeFileSync(OUT + '/package.json', '{"type":"commonjs"}');

const SL = await import(OUT + '/lib/superlike.js');
const CFG = await import(OUT + '/config.js');

/* ---------- the marker codec ---------- */
const OWNER = '0x0Cdd1EbbBCb55601b207B384245dDe646882b86B';
const P1 = '0x' + '11'.repeat(32);
const P2 = '0x' + '22'.repeat(32);
{
  const data = SL.buildSuperlikeData(OWNER, P1);
  ok(typeof data === 'string', 'buildSuperlikeData returns data');
  ok(
    (data.length - 2) / 2 === 104,
    'marked transfer is exactly 104 bytes (68 + 4 magic + 32 cawId)',
  );
  ok(data.startsWith('0xa9059cbb'), 'starts with the transfer selector');
  ok(
    data.toLowerCase().includes(SL.SUPERLIKE_MAGIC),
    'carries the SLK1 magic',
  );
  const mark = SL.parseSuperlikeInput(data);
  ok(!!mark, 'parse accepts the built data');
  ok(
    mark.to.toLowerCase() === OWNER.toLowerCase(),
    'round-trip: recipient survives',
  );
  ok(mark.amount === 500n * 10n ** 18n, 'round-trip: amount is the 500 CAT42 author share');
  ok(mark.cawId === P1, 'round-trip: cawId survives');
  ok(SL.buildSuperlikeData(OWNER, '0x1234') === null, 'bad cawId refused');
  // the EXACT calldata shape used in the live tolerance probe
  const probeCawId = '0x' + 'ab'.repeat(32);
  const probe = SL.buildSuperlikeData(OWNER, probeCawId);
  const pm = SL.parseSuperlikeInput(probe);
  ok(pm && pm.cawId === probeCawId, 'probe fixture calldata parses back');
  // rejects
  const plain =
    '0xa9059cbb' +
    '0'.repeat(24) +
    OWNER.slice(2).toLowerCase() +
    (100n * 10n ** 18n).toString(16).padStart(64, '0');
  ok(SL.parseSuperlikeInput(plain) === null, 'plain transfer is not a SuperLike');
  ok(
    SL.parseSuperlikeInput(data.slice(0, -2)) === null,
    'truncated marker rejected',
  );
  const wrongMagic = data.replace(SL.SUPERLIKE_MAGIC, 'deadbeef');
  ok(SL.parseSuperlikeInput(wrongMagic) === null, 'wrong magic rejected');
  const wrongSel = '0x095ea7b3' + data.slice(10);
  ok(SL.parseSuperlikeInput(wrongSel) === null, 'non-transfer selector rejected');
  const extra = data + 'ff';
  ok(SL.parseSuperlikeInput(extra) === null, 'extra trailing byte rejected');
}

/* ---------- tolerance fixture (measured on-chain) ---------- */
{
  const PLAIN_GAS = 51542;
  const MARKED_GAS = 52118;
  ok(
    MARKED_GAS - PLAIN_GAS === 36 * 16,
    'probe fixture: gas delta = intrinsic cost of 36 nonzero bytes only',
  );
  ok(
    SL.SUPERLIKE_TOTAL_CAT42 === 1000 &&
      SL.SUPERLIKE_AUTHOR_CAT42 === 500 &&
      SL.SUPERLIKE_BURN_CAT42 === 500 &&
      SL.SUPERLIKE_TOTAL_RAW === 1000n * 10n ** 18n &&
      SL.SUPERLIKE_AUTHOR_RAW === 500n * 10n ** 18n &&
      SL.SUPERLIKE_BURN_RAW === 500n * 10n ** 18n &&
      SL.SUPERLIKE_AUTHOR_RAW + SL.SUPERLIKE_BURN_RAW ===
        SL.SUPERLIKE_TOTAL_RAW,
    'v0.4.9 price constants: 1,000 total = 500 author + 500 burn',
  );
  ok(
    SL.SUPERLIKE_BURN_ADDRESS ===
      '0x000000000000000000000000000000000000dEaD',
    'the burn address is the established 0x…dEaD',
  );
  ok(CFG.CAT42 === '0x7386719EBbBeB4d810fF89027Bfb8A1CDf696310', 'CAT42 target');
}

/* ---------- the burn leg codec ---------- */
{
  const burn = SL.buildBurnData();
  ok(
    (burn.length - 2) / 2 === 68,
    'burn transfer is a plain 68-byte transfer (no marker)',
  );
  ok(burn.startsWith('0xa9059cbb'), 'burn data starts with the transfer selector');
  ok(
    '0x' + burn.slice(34, 74) ===
      '0x000000000000000000000000000000000000dead',
    'burn recipient is 0x…dEaD',
  );
  ok(
    BigInt('0x' + burn.slice(74, 138)) === 500n * 10n ** 18n,
    'burn amount is exactly 500 CAT42',
  );
  ok(
    SL.parseSuperlikeInput(burn) === null,
    'the burn leg never parses as a SuperLike (no marker)',
  );
}

/* ---------- guard decisions ---------- */
{
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
    'guard: someone else\u2019s post allowed',
  );
  ok(SL.superlikeShortfall(999n * 10n ** 18n) === true, 'shortfall: 999 < 1,000 total');
  ok(SL.superlikeShortfall(1000n * 10n ** 18n) === false, 'shortfall: exactly 1,000 ok');
  ok(
    SL.superlikeShortfall(500n * 10n ** 18n) === true,
    'shortfall: the author share alone (500) is NOT enough — the burn must be covered too',
  );
  ok(SL.superlikeShortfall(0n) === true, 'shortfall: 0 blocked');
  ok(SL.superlikeBurnShortfall(499n * 10n ** 18n) === true, 'burn shortfall: 499 < 500');
  ok(SL.superlikeBurnShortfall(500n * 10n ** 18n) === false, 'burn shortfall: exactly 500 ok');
}

/* ---------- the count scanner (stubbed 42 Chain RPC) ---------- */
{
  const START = SL.SUPERLIKE_START_BLOCK;
  const HEAD = START + 9500; // two chunks: 9000 + 500
  const word = (n) => '0x' + n.toString(16).padStart(64, '0');
  // txE: a marked input at the OLD v0.4.8 amount (100 CAT42),
  // amount word rewritten by hand — under the v0.4.9
  // exactly-500 rule it must NOT count (no SuperLike was ever
  // sent at 100, so there is no legacy to honour).
  const marked100 = (() => {
    const d = SL.buildSuperlikeData(OWNER, P1);
    const amt = (100n * 10n ** 18n).toString(16).padStart(64, '0');
    return d.slice(0, 74) + amt + d.slice(138);
  })();
  const txIn = {
    txA: SL.buildSuperlikeData(OWNER, P1),
    txB: SL.buildSuperlikeData(OWNER, P1), // amount fixed by builder; B is made wrong-amount below via log mismatch instead
    txC: SL.buildSuperlikeData(OWNER, P2),
    txD:
      '0xa9059cbb' +
      '0'.repeat(24) +
      OWNER.slice(2).toLowerCase() +
      (500n * 10n ** 18n).toString(16).padStart(64, '0'),
    txE: marked100,
  };
  // txB: a marked input whose LOG value disagrees (250 CAT42) -> excluded
  const logsChunk1 = [
    { transactionHash: 'txA', data: word(500n * 10n ** 18n) },
    { transactionHash: 'txB', data: word(250n * 10n ** 18n) },
    { transactionHash: 'txC', data: word(500n * 10n ** 18n) },
    { transactionHash: 'txD', data: word(500n * 10n ** 18n) },
    { transactionHash: 'txE', data: word(100n * 10n ** 18n) },
  ];
  let getLogsCalls = 0;
  const kvMem = new Map();
  SL.initSuperlikeStore({
    getItem: async (k) => kvMem.get(k) ?? null,
    setItem: async (k, v) => void kvMem.set(k, v),
  });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (req) => {
      if (req.method === 'eth_blockNumber')
        return { result: '0x' + HEAD.toString(16) };
      if (req.method === 'eth_getLogs') {
        getLogsCalls++;
        const from = parseInt(req.params[0].fromBlock, 16);
        return { result: from === START ? logsChunk1 : [] };
      }
      if (req.method === 'eth_getTransactionByHash')
        return { result: { input: txIn[req.params[0]] } };
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
  const n1 = await SL.superlikeCount(OWNER, P1);
  ok(n1 === 1, 'scanner: P1 counts only the exact marked 500 CAT42 transfer (log-mismatch, plain and legacy-100 all excluded)');
  const n2 = await SL.superlikeCount(OWNER, P2);
  ok(n2 === 1, 'scanner: P2 counted from the same scan');
  ok(SL.superlikeCountCached(OWNER, P1) === 1, 'scanner: cached count readable');
  const before = getLogsCalls;
  await SL.superlikeCount(OWNER, P1);
  ok(getLogsCalls === before, 'scanner: cursor current -> no rescan of old chunks');
  const saved = JSON.parse(kvMem.get('caw-superlike-v1'));
  ok(
    saved[OWNER.toLowerCase()].to === HEAD,
    'scanner: cursor persisted at the scanned head',
  );
}

/* ---------- scanner failure: cursor must not advance ---------- */
{
  const START = SL.SUPERLIKE_START_BLOCK;
  const HEAD = START + 19000; // chunks: 9000, 9000, 1000
  const OWNER2 = '0x1111111111111111111111111111111111111111';
  const word = (n) => '0x' + n.toString(16).padStart(64, '0');
  let poisoned = true;
  const kvMem = new Map();
  SL.initSuperlikeStore({
    getItem: async (k) => kvMem.get(k) ?? null,
    setItem: async (k, v) => void kvMem.set(k, v),
  });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const one = async (req) => {
      if (req.method === 'eth_blockNumber')
        return { result: '0x' + HEAD.toString(16) };
      if (req.method === 'eth_getLogs') {
        const from = parseInt(req.params[0].fromBlock, 16);
        if (poisoned && from === START + 9000) {
          throw new Error('simulated RPC failure');
        }
        if (from === START) {
          return {
            result: [
              { transactionHash: 'txA', data: word(500n * 10n ** 18n) },
            ],
          };
        }
        return { result: [] };
      }
      if (req.method === 'eth_getTransactionByHash')
        return { result: { input: SL.buildSuperlikeData(OWNER2, P1) } };
      return { result: null };
    };
    if (Array.isArray(body)) {
      const out = [];
      for (const req of body) out.push({ jsonrpc: '2.0', id: req.id, ...(await one(req)) });
      return { json: async () => out };
    }
    return { json: async () => ({ jsonrpc: '2.0', id: body.id, ...(await one(body)) }) };
  };
  // rpc42 tries both endpoints; both are the same stub, so the
  // poisoned chunk fails everywhere and the scan must stop.
  const partial = await SL.superlikeCount(OWNER2, P1);
  ok(partial === 1, 'failure: count from completed chunks still returned');
  const recMid = JSON.parse(kvMem.get('caw-superlike-v1'))[OWNER2.toLowerCase()];
  ok(
    recMid.to === START + 8999,
    'failure: cursor stopped at the last completed chunk',
  );
  poisoned = false;
  const full = await SL.superlikeCount(OWNER2, P1);
  ok(full === 1, 'failure: rescan after recovery completes, count unchanged');
  const recEnd = JSON.parse(kvMem.get('caw-superlike-v1'))[OWNER2.toLowerCase()];
  ok(recEnd.to === HEAD, 'failure: cursor reaches the head after recovery');
}

/* ---------- pending burns: the debt record ---------- */
{
  const me = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC';
  const kvMem = new Map();
  SL.initSuperlikeStore({
    getItem: async (k) => kvMem.get(k) ?? null,
    setItem: async (k, v) => void kvMem.set(k, v),
  });
  ok(
    (await SL.pendingBurnFor(me, P1)) === null,
    'pending burn: none recorded initially',
  );
  await SL.recordPendingBurn(me, { cawId: P1, author: OWNER, ts: 1794300000 });
  const rec = await SL.pendingBurnFor(me, P1);
  ok(
    !!rec && rec.author === OWNER && rec.cawId === P1,
    'pending burn: the debt is readable after recording',
  );
  ok(
    (await SL.pendingBurnFor(me, P2)) === null,
    'pending burn: a different post owes nothing',
  );
  ok(
    (await SL.pendingBurnFor(OWNER, P1)) === null,
    'pending burn: a different sender owes nothing',
  );
  const savedBurns = JSON.parse(kvMem.get('caw-superlike-burn-v1'));
  ok(
    Object.values(savedBurns).some((v) => v.cawId === P1 && v.author === OWNER),
    'pending burn: persisted to the on-device KV (survives restarts)',
  );
  await SL.clearPendingBurn(me, P1);
  ok(
    (await SL.pendingBurnFor(me, P1)) === null,
    'pending burn: cleared once the burn lands',
  );
}

/* ---------- wiring statics ---------- */
{
  const flowAll = readFileSync(ROOT + '/src/lib/actionFlow.ts', 'utf8');
  const flow = flowAll.slice(
    flowAll.indexOf('export async function performSuperlike'),
    flowAll.indexOf('export async function performSuperlikeBurn'),
  );
  const iSelf = flow.indexOf("Error('self-superlike')");
  const iShort = flow.indexOf("Error('shortfall')");
  const iSend = flow.indexOf('sendCalldata');
  ok(iSelf > 0 && iSelf < iSend, 'performSuperlike: self block precedes the send');
  ok(iShort > 0 && iShort < iSend, 'performSuperlike: shortfall stop precedes the send');
  ok(flow.includes('cat42BalanceOf'), 'performSuperlike: fresh CAT42 balance read');
  ok(flow.includes('buildSuperlikeData'), 'performSuperlike: marked calldata built');
  ok(flow.includes('buildBurnData'), 'performSuperlike: burn calldata built');
  ok(
    flow.includes("signerForHsChain(secret.kind, secret.secret, 'infinite')"),
    'performSuperlike: signs on 42 Chain with the wallet key',
  );
  ok(flow.includes('requireAuth'), 'performSuperlike: fresh auth gate');
  ok(
    flow.includes('refreshSuperlikesFor'),
    'performSuperlike: author scan nudged after the author leg',
  );
  const iAuthorSend = flow.indexOf('sendCalldata(signer, CAT42, authorData)');
  const iBurnSend = flow.indexOf('sendCalldata(signer, CAT42, burnData)');
  ok(
    iAuthorSend > 0 && iBurnSend > iAuthorSend,
    'performSuperlike: the author leg is sent BEFORE the burn leg',
  );
  ok(
    flow.includes('recordPendingBurn') && flow.includes("Error('burn-pending')"),
    'performSuperlike: a failed burn leg records the debt and reports burn-pending',
  );
  const burnFlow = flowAll.slice(
    flowAll.indexOf('export async function performSuperlikeBurn'),
  );
  ok(
    burnFlow.includes('pendingBurnFor') &&
      burnFlow.includes("Error('no-pending-burn')"),
    'performSuperlikeBurn: refuses without a recorded debt',
  );
  ok(
    burnFlow.includes('buildBurnData()') && burnFlow.includes('clearPendingBurn'),
    'performSuperlikeBurn: sends the burn and clears the debt',
  );
  ok(
    !burnFlow.includes('buildSuperlikeData'),
    'performSuperlikeBurn: can NEVER rebuild/resend the author leg',
  );
  ok(
    burnFlow.includes('superlikeBurnShortfall') && burnFlow.includes('requireAuth'),
    'performSuperlikeBurn: fresh burn-share balance gate + auth gate',
  );
  const tl = readFileSync(ROOT + '/src/screens/TimelineScreen.tsx', 'utf8');
  ok(tl.includes('onSuperlike={handleSuperlike}'), 'TimelineScreen passes the handler');
  ok(tl.includes("tr('sl.body'"), 'TimelineScreen sheet shows cost/recipient/balance');
  ok(tl.includes("tr('sl.shortfall')"), 'TimelineScreen surfaces the shortfall guidance');
  ok(
    tl.includes('SUPERLIKE_TOTAL_CAT42') && tl.includes('SUPERLIKE_AUTHOR_CAT42') &&
      tl.includes('SUPERLIKE_BURN_CAT42'),
    'TimelineScreen sheet shows the split (total / author / burn)',
  );
  ok(
    tl.includes('pendingBurnFor') && tl.includes('performSuperlikeBurn') &&
      tl.includes("tr('sl.burnBody'"),
    'TimelineScreen offers the burn-only retry sheet',
  );
  const pf = readFileSync(ROOT + '/src/screens/ProfileScreen.tsx', 'utf8');
  ok(
    pf.includes('onSuperlike={handleSuperlike}'),
    'ProfileScreen post list passes the SuperLike handler (v0.4.9)',
  );
  ok(
    pf.includes('performSuperlike') && pf.includes("tr('sl.body'") &&
      pf.includes("tr('sl.self'") && pf.includes("tr('sl.shortfall'"),
    'ProfileScreen carries the same sheet + guards as the feed',
  );
  ok(
    pf.includes('pendingBurnFor') && pf.includes('performSuperlikeBurn'),
    'ProfileScreen offers the burn-only retry too',
  );
  const pd = readFileSync(ROOT + '/src/screens/PostDetailScreen.tsx', 'utf8');
  ok(
    (pd.match(/onSuperlike=\{handleSuperlike\}/g) || []).length === 2,
    'PostDetailScreen wires SuperLike on the post and its replies (v0.4.9)',
  );
  ok(
    pd.includes('performSuperlike') && pd.includes('performSuperlikeBurn'),
    'PostDetailScreen carries the send + burn-retry flow',
  );
  const ui = readFileSync(ROOT + '/src/components/ui.tsx', 'utf8');
  ok(ui.includes('StarIcon'), 'PostCard renders the star treatment');
  ok(ui.includes('superlikeCount('), 'PostCard reads the chain count');
  ok(ui.includes('onSuperlike'), 'PostCard exposes the SuperLike action');
  const ctx = readFileSync(ROOT + '/src/context/AppContext.tsx', 'utf8');
  ok(ctx.includes('initSuperlikeStore(storeKV)'), 'AppContext inits the count store');
}

console.log(`\nsuperlike: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
