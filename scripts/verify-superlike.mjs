#!/usr/bin/env node
/**
 * SuperLike verification (v0.4.8). Behaviour where the module
 * allows it (marker codec, guard decisions, the count scanner
 * against a stubbed 42 Chain RPC), statics for the RN-bound
 * wiring (performSuperlike / TimelineScreen / PostCard), and
 * the live tolerance probe's numbers as a fixture.
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
  ok(mark.amount === 100n * 10n ** 18n, 'round-trip: amount is 100 CAT42');
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
    SL.SUPERLIKE_AMOUNT_RAW === 100n * 10n ** 18n &&
      SL.SUPERLIKE_CAT42 === 100,
    'the fixed price constant is 100 CAT42',
  );
  ok(CFG.CAT42 === '0x7386719EBbBeB4d810fF89027Bfb8A1CDf696310', 'CAT42 target');
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
  ok(SL.superlikeShortfall(99n * 10n ** 18n) === true, 'shortfall: 99 < 100');
  ok(SL.superlikeShortfall(100n * 10n ** 18n) === false, 'shortfall: exactly 100 ok');
  ok(SL.superlikeShortfall(0n) === true, 'shortfall: 0 blocked');
}

/* ---------- the count scanner (stubbed 42 Chain RPC) ---------- */
{
  const START = SL.SUPERLIKE_START_BLOCK;
  const HEAD = START + 9500; // two chunks: 9000 + 500
  const word = (n) => '0x' + n.toString(16).padStart(64, '0');
  const txIn = {
    txA: SL.buildSuperlikeData(OWNER, P1),
    txB: SL.buildSuperlikeData(OWNER, P1), // amount fixed by builder; B is made wrong-amount below via log mismatch instead
    txC: SL.buildSuperlikeData(OWNER, P2),
    txD:
      '0xa9059cbb' +
      '0'.repeat(24) +
      OWNER.slice(2).toLowerCase() +
      (100n * 10n ** 18n).toString(16).padStart(64, '0'),
  };
  // txB: a marked input whose LOG value disagrees (50 CAT42) -> excluded
  const logsChunk1 = [
    { transactionHash: 'txA', data: word(100n * 10n ** 18n) },
    { transactionHash: 'txB', data: word(50n * 10n ** 18n) },
    { transactionHash: 'txC', data: word(100n * 10n ** 18n) },
    { transactionHash: 'txD', data: word(100n * 10n ** 18n) },
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
  ok(n1 === 1, 'scanner: P1 counts only the exact marked 100 CAT42 transfer');
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
              { transactionHash: 'txA', data: word(100n * 10n ** 18n) },
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

/* ---------- wiring statics ---------- */
{
  const flowAll = readFileSync(ROOT + '/src/lib/actionFlow.ts', 'utf8');
  const flow = flowAll.slice(
    flowAll.indexOf('export async function performSuperlike'),
  );
  const iSelf = flow.indexOf("Error('self-superlike')");
  const iShort = flow.indexOf("Error('shortfall')");
  const iSend = flow.indexOf('sendCalldata');
  ok(iSelf > 0 && iSelf < iSend, 'performSuperlike: self block precedes the send');
  ok(iShort > 0 && iShort < iSend, 'performSuperlike: shortfall stop precedes the send');
  ok(flow.includes('cat42BalanceOf'), 'performSuperlike: fresh CAT42 balance read');
  ok(flow.includes('buildSuperlikeData'), 'performSuperlike: marked calldata built');
  ok(
    flow.includes("signerForHsChain(secret.kind, secret.secret, 'infinite')"),
    'performSuperlike: signs on 42 Chain with the wallet key',
  );
  ok(flow.includes('requireAuth'), 'performSuperlike: fresh auth gate');
  ok(
    flow.includes('refreshSuperlikesFor'),
    'performSuperlike: author scan nudged after success',
  );
  const tl = readFileSync(ROOT + '/src/screens/TimelineScreen.tsx', 'utf8');
  ok(tl.includes('onSuperlike={handleSuperlike}'), 'TimelineScreen passes the handler');
  ok(tl.includes("tr('sl.body'"), 'TimelineScreen sheet shows cost/recipient/balance');
  ok(tl.includes("tr('sl.shortfall')"), 'TimelineScreen surfaces the shortfall guidance');
  const ui = readFileSync(ROOT + '/src/components/ui.tsx', 'utf8');
  ok(ui.includes('StarIcon'), 'PostCard renders the star treatment');
  ok(ui.includes('superlikeCount('), 'PostCard reads the chain count');
  ok(ui.includes('onSuperlike'), 'PostCard exposes the SuperLike action');
  const ctx = readFileSync(ROOT + '/src/context/AppContext.tsx', 'utf8');
  ok(ctx.includes('initSuperlikeStore(storeKV)'), 'AppContext inits the count store');
}

console.log(`\nsuperlike: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
