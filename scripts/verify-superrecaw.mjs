#!/usr/bin/env node
/**
 * SuperRecaw verification (v0.5.0).
 *
 * A SuperRecaw = the NORMAL Recaw action first; only after it
 * lands, a burn of exactly 1,000,000 O (QL1) carrying the
 * "SRC1" trailing-calldata marker for the ORIGINAL post's
 * cawId. This suite pins:
 *  - the SRC1 codec (shared marked-burn codec, distinct magic;
 *    an SRC1 burn is never a SuperLike and vice versa);
 *  - the display detection: an SRC1 mark indexed by
 *    (cawId, sender) from the chain-wide marked-burn scan
 *    (stubbed QL1 RPC) drives superRecawCachedFor /
 *    hasSuperRecawFor — chain data only, no local tally;
 *  - the pending-burn debt store (record / read / clear,
 *    persisted on-device) for a burn that failed after the
 *    recaw landed;
 *  - the wiring statics that enforce ORDER: in
 *    performSuperRecaw the fresh O-balance gate precedes the
 *    recaw, the recaw (submitAction) precedes the burn
 *    (sendCalldata), a burn failure records the debt and
 *    throws 'src-burn-pending'; and performSuperRecawBurn —
 *    the only retry — contains no recaw construction at all,
 *    so it can never resend one.
 */
import { execFileSync } from 'node:child_process';
import {
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
      'src/lib/superRecaw.ts',
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
  ok(true, 'tsc compiles the marked-burn graph + superRecaw');
} catch (e) {
  ok(false, 'tsc: ' + (e.stdout || '').toString().slice(0, 400));
  process.exit(1);
}
writeFileSync(OUT + '/package.json', '{"type":"commonjs"}');

const MB = await import(OUT + '/lib/markedBurns.js');
const SR = await import(OUT + '/lib/superRecaw.js');
const SL = await import(OUT + '/lib/superlike.js');

/* ---------- the SRC1 codec ---------- */
const P1 = '0x' + '11'.repeat(32);
const P2 = '0x' + '22'.repeat(32);
const PRICE = 1000000n * 10n ** 18n;
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
      mark.amount === PRICE,
    'shared codec parses it as an SRC1 burn of exactly the price',
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
    txS: SR.buildSuperRecawData(P1), // SRC1 by RECAWER for P1
    txL: SL.buildSuperlikeData(P1), // SLK1 by RECAWER for P1 (not a recaw mark)
    txO: SR.buildSuperRecawData(P2), // SRC1 by BYSTANDER for P2
  };
  const logs = [
    { transactionHash: 'txS', topics: [TRANSFER_TOPIC, topicAddr(RECAWER), topicAddr(MB.BURN_ADDRESS)], data: word(PRICE) },
    { transactionHash: 'txL', topics: [TRANSFER_TOPIC, topicAddr(RECAWER), topicAddr(MB.BURN_ADDRESS)], data: word(PRICE) },
    { transactionHash: 'txO', topics: [TRANSFER_TOPIC, topicAddr(BYSTANDER), topicAddr(MB.BURN_ADDRESS)], data: word(PRICE) },
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
    'detection: the recawer’s SRC1 mark shows the flashy treatment',
  );
  ok(
    SR.superRecawCachedFor(P1, BYSTANDER) === false,
    'detection: someone else’s mark does not light up this recaw',
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

/* ---------- the pending-burn debt store ---------- */
{
  const kvMem = new Map();
  SR.initSuperRecawStore({
    getItem: async (k) => kvMem.get(k) ?? null,
    setItem: async (k, v) => void kvMem.set(k, v),
  });
  ok(
    (await SR.pendingSrcBurnFor(RECAWER, P1)) === null,
    'debt: none recorded initially',
  );
  await SR.recordSrcBurn(RECAWER, { cawId: P1, ts: 1794300000 });
  const rec = await SR.pendingSrcBurnFor(RECAWER, P1);
  ok(!!rec && rec.cawId === P1 && rec.ts === 1794300000, 'debt: readable after recording');
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
    sup.includes('recordSrcBurn') && sup.includes("Error('src-burn-pending')"),
    'performSuperRecaw: a failed burn records the debt and reports src-burn-pending',
  );
  ok(
    sup.includes('buildSuperRecawData') && sup.includes('MARKED_BURN_PRICE_RAW'),
    'performSuperRecaw: SRC1 calldata + the exact price gate',
  );
  const burn = flowAll.slice(
    flowAll.indexOf('export async function performSuperRecawBurn'),
    flowAll.indexOf('export async function performTip'),
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
    burn.includes('oBalanceOf') && burn.includes('requireAuth'),
    'performSuperRecawBurn: fresh balance gate + auth gate',
  );
  const tl = readFileSync(ROOT + '/src/screens/TimelineScreen.tsx', 'utf8');
  ok(
    tl.includes('performSuperRecaw') && tl.includes("tr('src.body'"),
    'TimelineScreen offers SuperRecaw with the cost shown first',
  );
  ok(
    tl.includes('pendingSrcBurnFor') && tl.includes('performSuperRecawBurn') &&
      tl.includes("tr('src.burnBody'"),
    'TimelineScreen offers the burn-only retry when a debt exists',
  );
  ok(
    tl.includes("tr('tl.superRecaw')"),
    'TimelineScreen labels the SuperRecaw choice with its price',
  );
  const pf = readFileSync(ROOT + '/src/screens/ProfileScreen.tsx', 'utf8');
  ok(
    pf.includes('performSuperRecaw') && pf.includes('performSuperRecawBurn'),
    'ProfileScreen carries the same SuperRecaw + retry flow',
  );
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
  ok(ctx.includes('initSuperRecawStore(storeKV)'), 'AppContext inits the debt store');
}

console.log(`\nsuperrecaw: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
