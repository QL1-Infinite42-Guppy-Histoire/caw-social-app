/* Verification for v0.4.2: QL1 bridge arrivals are WQOM,
 * not native QOM.
 *
 * The bug (2026-11-08 10:00 JST): a buy part parked at its
 * bridge step watched the NATIVE QOM balance for a delivery
 * that lands as WQOM (ERC-20), so it waited forever even
 * though every leg had executed. The watcher now reads the
 * delivered token's balance and decides through the pure
 * partArrivalVerdict, which also repairs flows saved by
 * v0.4.1 and earlier (baseline captured from the native
 * balance) — cross-asset acceptance, or a one-time rebase.
 *
 * Case (a) replays the reporter's exact stuck state:
 * wallet 0x9035…F8cC, part at step 2, baseline captured from
 * the native balance (77,987,386.694920 QOM), bridged amount
 * 44,527,620,288 QOM, delivered WQOM balance exactly that.
 *
 * Everything is stubbed or pure: no live chain calls, no
 * keys, no sends. Run: node scripts/verify-arrival.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BUILD = new URL('./.build-arrival', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

execFileSync(
  'npx',
  [
    'tsc', '--ignoreConfig',
    'src/config.ts', 'src/lib/cawCore.ts', 'src/lib/myActions.ts',
    'src/lib/chains.ts', 'src/lib/aggEngine.ts', 'src/lib/hunters.ts',
    'src/lib/flows.ts', 'src/lib/faucet.ts', 'src/i18n.ts',
    '--module', 'commonjs', '--target', 'es2022',
    '--outDir', BUILD, '--skipLibCheck',
  ],
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'inherit' },
);

const H = require(BUILD + '/lib/hunters.js');
const F = require(BUILD + '/lib/flows.js');
const AGG = require(BUILD + '/lib/aggEngine.js');

const ADDR = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC';
const E18 = 10n ** 18n;
const qom = (whole) => BigInt(whole) * E18;
/* 77,987,386.694920 QOM in wei (the reporter's native balance
 * when the old code armed the baseline). */
const NATIVE_BASELINE = 77987386694920000000000000n;
const DELIVERED = qom(44527620288); // 44,527,620,288 QOM
const WQOM_ADDR = AGG.WQOM;
const CAW_ADDR = AGG.tokenById('ql1', 'qcaw').address;
const LEG2 = [WQOM_ADDR, CAW_ADDR];

/* A buy flow in its back half with a single part parked at
 * the bridge-wait step — the shape the watcher consumes. */
const stuckFlow = (part) => ({
  v: 1, id: 'test', address: ADDR, direction: 'buy', entry: 'bsc',
  entryAmountRaw: '0', entryUsdtExpected: '0', usdt42Expected: '0',
  confirmedOut: '0', choice: 'single', phase: 'back', carveDone: true,
  parts: [part], createdAt: 0, updatedAt: 0,
});
const qomPart = (over) => ({
  sym: 'QOM', pct: 100, usdtIn: '0', leg1Path: null, leg2Path: LEG2,
  step: 2, bridgedAmount: DELIVERED.toString(),
  /* v0.4.3: the watcher hands the verdict the registry fact
   * (the QOM pair's QL1 token IS the wrapped native) instead
   * of the verdict comparing symbols. */
  deliversWrappedNative: true, ...over,
});

/* Mirror of the screen's step-2 watcher branch: read the
 * delivered token's balance, ask the verdict, persist the
 * outcome. Takes the current WQOM balance as the read. */
const watcherPoll = (flow, wqomNow) => {
  const s = F.nextStep(flow);
  if (s.kind !== 'part' || s.step !== 2) return flow;
  const part = flow.parts[s.partIdx];
  const v = H.partArrivalVerdict(wqomNow, part);
  if (v.action === 'arrived') {
    const parts = flow.parts.slice();
    parts[s.partIdx] = {
      ...part,
      step: part.leg2Path ? 3 : 4,
      bridgedAmount: v.arrived.toString(),
    };
    return { ...flow, parts };
  }
  if (v.action === 'rebase') {
    const parts = flow.parts.slice();
    parts[s.partIdx] = {
      ...part,
      dstBalanceBefore: wqomNow.toString(),
      dstBaseIsToken: true,
    };
    return { ...flow, parts };
  }
  return flow;
};

/* ============ (a) the reporter's exact stuck state ============ */
console.log('\n--- (a) reporter: legacy native baseline, delivery already in ---');
{
  const flow = stuckFlow(qomPart({ dstBalanceBefore: NATIVE_BASELINE.toString() }));
  const after = watcherPoll(flow, DELIVERED);
  check('a1 stuck part advances to the QL1 swap step', after.parts[0].step === 3,
    `step=${after.parts[0].step}`);
  const want = (DELIVERED * 99n) / 100n;
  const arrived = BigInt(after.parts[0].bridgedAmount);
  check('a2 advanced amount is the delivered delta (>= 99% of bridged)',
    arrived >= want && arrived <= DELIVERED, `arrived=${arrived}`);
  const again = watcherPoll(after, DELIVERED);
  check('a3 advance happens exactly once (second poll is a no-op)',
    again.parts[0].step === 3 && again.parts[0].bridgedAmount === after.parts[0].bridgedAmount);
}
{
  /* Cross-asset acceptance: the native baseline is LARGER
   * than the whole delivery, so the mixed-asset delta can
   * never reach the threshold — the WQOM balance alone
   * covering 99% of the bridged amount is the arrival. */
  const flow = stuckFlow(qomPart({ dstBalanceBefore: qom(100000000000).toString() }));
  const v = H.partArrivalVerdict(DELIVERED, flow.parts[0]);
  check('a4 huge native baseline: cross-asset rule accepts the delivery',
    v.action === 'arrived' && v.arrived === DELIVERED);
  const after = watcherPoll(flow, DELIVERED);
  check('a5 cross-asset advance lands on the swap step with the full balance',
    after.parts[0].step === 3 && after.parts[0].bridgedAmount === DELIVERED.toString());
}

/* ============ (b) fresh QOM bridge (v0.4.2-armed baseline) ============ */
console.log('\n--- (b) fresh flow: baseline armed from WQOM ---');
{
  const pre = qom(5000000); // WQOM already held before this bridge
  const bridged = qom(10000000);
  const part = qomPart({
    dstBalanceBefore: pre.toString(), bridgedAmount: bridged.toString(),
    dstBaseIsToken: true,
  });
  const v98 = H.partArrivalVerdict(pre + (bridged * 98n) / 100n, part);
  check('b1 delivery at 98% does not advance', v98.action === 'wait');
  const v995 = H.partArrivalVerdict(pre + (bridged * 995n) / 1000n, part);
  check('b2 delivery at 99.5% advances with the delta as the amount',
    v995.action === 'arrived' && v995.arrived === (bridged * 995n) / 1000n);
  /* A pre-existing WQOM pile bigger than the whole bridged
   * amount must NOT trigger the legacy cross-asset rule on a
   * correctly-armed baseline: nothing delivered yet = wait. */
  const rich = qomPart({
    dstBalanceBefore: qom(20000000).toString(), bridgedAmount: bridged.toString(),
    dstBaseIsToken: true,
  });
  check('b3 pre-existing balance alone never advances a fresh baseline',
    H.partArrivalVerdict(qom(20000000), rich).action === 'wait');
}

/* ============ (c) non-QOM parts are unchanged ============ */
console.log('\n--- (c) non-QOM parts: delta rule only, never rebase ---');
{
  const fish = {
    sym: 'FISH', pct: 100, usdtIn: '0', leg1Path: null, leg2Path: [ADDR, ADDR],
    step: 2, bridgedAmount: qom(100).toString(), dstBalanceBefore: qom(1000).toString(),
  };
  check('c1 partial delivery waits (no rebase for non-QOM)',
    H.partArrivalVerdict(qom(1050), fish).action === 'wait');
  const vFull = H.partArrivalVerdict(qom(1000) + (qom(100) * 99n) / 100n, fish);
  check('c2 full delivery advances by delta, as before',
    vFull.action === 'arrived' && vFull.arrived === (qom(100) * 99n) / 100n);
}

/* ============ (d) legacy rebase fires once, then deltas rule ============ */
console.log('\n--- (d) rebase: once only, then honest deltas ---');
{
  /* Native baseline huge, WQOM still tiny (delivery has not
   * landed): neither rule can accept — rebase once. */
  let flow = stuckFlow(qomPart({ dstBalanceBefore: qom(100000000000).toString() }));
  const tiny = qom(1000000);
  flow = watcherPoll(flow, tiny);
  check('d1 first poll rebases the baseline onto the WQOM balance',
    flow.parts[0].step === 2 &&
    flow.parts[0].dstBalanceBefore === tiny.toString() &&
    flow.parts[0].dstBaseIsToken === true);
  const before2 = JSON.stringify(flow.parts[0]);
  flow = watcherPoll(flow, tiny);
  check('d2 second poll does NOT rebase again (waits)',
    JSON.stringify(flow.parts[0]) === before2 && flow.parts[0].step === 2);
  const landed = tiny + (DELIVERED * 995n) / 1000n;
  flow = watcherPoll(flow, landed);
  check('d3 post-rebase delivery advances, measured from the rebased baseline',
    flow.parts[0].step === 3 &&
    flow.parts[0].bridgedAmount === ((DELIVERED * 995n) / 1000n).toString());
  /* A partial delivery after rebase stays below threshold. */
  let flow2 = stuckFlow(qomPart({
    dstBalanceBefore: tiny.toString(), dstBaseIsToken: true,
  }));
  flow2 = watcherPoll(flow2, tiny + (DELIVERED * 50n) / 100n);
  check('d4 partial delivery after rebase does not advance',
    flow2.parts[0].step === 2);
}

/* ============ (e) step-3 swap spends the ERC-20, not native ============ */
console.log('\n--- (e) QL1 swap tx for the arrived WQOM ---');
{
  const amt = DELIVERED;
  const route = {
    path: LEG2, amounts: [amt, amt * 450n], amountIn: amt, amountOut: amt * 450n,
  };
  const wqomTok = AGG.tokenById('ql1', 'wqom');
  check('e0 the pair token entry for QOM on QL1 is the WQOM ERC-20 entry',
    wqomTok && wqomTok.isNative === false &&
    wqomTok.address.toLowerCase() === WQOM_ADDR.toLowerCase());
  const txDefault = H.buildRouteSwapTx('ql1', route, ADDR, 1);
  check('e1 address-resolved build (pre-fix path) spends NATIVE — documents the old bug',
    txDefault.value === amt && txDefault.data.startsWith('0x7ff36ab5'));
  const txFixed = H.buildRouteSwapTx('ql1', route, ADDR, 1, wqomTok);
  check('e2 delivered-token build is swapExactTokensForTokens with value 0',
    txFixed.value === 0n && txFixed.data.startsWith('0x38ed1739') &&
    txFixed.to.toLowerCase() === AGG.CHAINS.ql1.router.toLowerCase());
}

console.log(`\nverify-arrival: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
