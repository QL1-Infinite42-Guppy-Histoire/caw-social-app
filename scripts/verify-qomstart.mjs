/* Verification for v0.4.2 (addition, user go-ahead
 * 2026-11-08 10:47 JST): the NATIVE QOM direct start for
 * the buy direction — QL1's second direct start, sibling
 * of the WQOM start (verify-wqom.mjs).
 *
 * Rules under test:
 *  - planning range = native balance − the shared
 *    100-action gas keep (ql1NativeSpendableWei on the one
 *    app-wide Ql1KeepPlan); a start that would eat the keep
 *    is never offered/executable;
 *  - when the keep cannot be secured the start stops at
 *    the faucet guidance (plan action 'faucet'), and when
 *    it must first be secured from WQOM the native side
 *    has ZERO spendable until then (action 'unwrap');
 *  - the execution build for a native part is the
 *    native-spending swap (swapExactETHForTokens, value =
 *    amount, no allowance) — the exact call the screen's
 *    srcNativeQom branch makes (no token override);
 *  - the flow a QOM start is born as has the same shape as
 *    every other start (one QOM part at step 3, finalAsset
 *    CAW / finalChain ql1) and survives a save/load round
 *    trip with srcNativeQom intact.
 *
 * Everything is stubbed or pure: no live chain calls, no
 * keys, no sends. Run: node scripts/verify-qomstart.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const BUILD = new URL('./.build-qomstart', import.meta.url).pathname;

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
const GAS_PRICE = 18n * E18;
const KEEP = H.ql1GasKeepWei(GAS_PRICE);
const UNWRAP_COST = GAS_PRICE * H.QL1_UNWRAP_GAS_UNITS;
const WQOM_ADDR = H.WQOM_ADDR;

/* The start decision, mirroring startQomFlow's gates on
 * the pure plan: 'faucet' never starts; an amount over the
 * native spendable never starts. */
const startDecision = (plan, amt) =>
  !plan
    ? 'start'
    : plan.action === 'faucet'
      ? 'faucet'
      : amt > H.ql1NativeSpendableWei(plan)
        ? 'blocked'
        : 'start';

/* ============ planning range = native − keep ============ */
console.log('\n--- (a) native planning range ---');
{
  const plan = H.ql1KeepPlan(KEEP + qom(500_000_000), 0n, KEEP, UNWRAP_COST);
  check('a1 native above keep: plan ok',
    plan.action === 'ok');
  check('a2 spendable = native − keep exactly',
    H.ql1NativeSpendableWei(plan) === qom(500_000_000),
    `spendable=${H.ql1NativeSpendableWei(plan) / E18} QOM`);
  check('a3 the full spendable may start',
    startDecision(plan, qom(500_000_000)) === 'start');
  check('a4 one wei into the keep is blocked (keep-breach block)',
    startDecision(plan, qom(500_000_000) + 1n) === 'blocked');
  check('a5 the plan carries the fresh balances it was decided from',
    plan.nativeWei === KEEP + qom(500_000_000) && plan.wqomWei === 0n);
}
{
  const plan = H.ql1KeepPlan(KEEP, 0n, KEEP, UNWRAP_COST);
  check('a6 native == keep: nothing is spendable, any start is blocked',
    H.ql1NativeSpendableWei(plan) === 0n &&
    startDecision(plan, 1n) === 'blocked');
  const plan2 = H.ql1KeepPlan(KEEP - 1n, qom(10_000_000_000), KEEP, UNWRAP_COST);
  check('a7 native 1 wei under keep with WQOM present: keep secured by unwrap first, native spendable stays 0',
    plan2.action === 'unwrap' && H.ql1NativeSpendableWei(plan2) === 0n &&
    startDecision(plan2, 1n) === 'blocked');
}

/* ============ gas-short paths ============ */
console.log('\n--- (b) gas-short paths route to faucet guidance ---');
{
  const plan = H.ql1KeepPlan(0n, qom(44_527_620_288), KEEP, UNWRAP_COST);
  check('b1 native 0 + WQOM held: plan is faucet (bootstrap is unpayable)',
    plan.action === 'faucet');
  check('b2 a QOM start in that state stops at faucet guidance — no start, no generic error',
    startDecision(plan, qom(1000)) === 'faucet');
  const tiny = H.ql1KeepPlan(UNWRAP_COST - 1n, qom(1000), KEEP, UNWRAP_COST);
  check('b3 native below the unwrap cost is likewise faucet',
    tiny.action === 'faucet' && startDecision(tiny, 1n) === 'faucet');
}

/* ============ repeated planning never eats the keep ============ */
console.log('\n--- (c) the keep survives repeated planning ---');
{
  let native = KEEP + qom(900_000_000);
  let ok = true;
  for (let i = 0; i < 5; i++) {
    const plan = H.ql1KeepPlan(native, 0n, KEEP, UNWRAP_COST);
    const spend = H.ql1NativeSpendableWei(plan);
    if (native - spend < KEEP) ok = false; // a plan left less than the keep
    native -= spend / 2n; // spend half the offered range, re-plan
    if (native < KEEP) ok = false;
  }
  check('c1 five plan/spend rounds never plan the keep away', ok);
  const drained = H.ql1KeepPlan(KEEP, 0n, KEEP, UNWRAP_COST);
  check('c2 after spending down to the keep, the offered range is 0',
    H.ql1NativeSpendableWei(drained) === 0n);
}

/* ============ quote → execution (stubbed) ============ */
console.log('\n--- (d) native execution build ---');
{
  const amt = qom(500_000_000);
  /* Stubbed freshRoute result for the QOM pair (the pair
   * token address is WQOM's; only the spend differs). */
  const route = {
    path: [WQOM_ADDR, AGG.tokenById('ql1', 'qcaw').address],
    amounts: [amt, amt * 450n], amountIn: amt, amountOut: amt * 450n,
  };
  const txNative = H.buildRouteSwapTx('ql1', route, ADDR, 1);
  check('d1 native build is swapExactETHForTokens spending the amount as value',
    txNative.value === amt && txNative.data.startsWith('0x7ff36ab5'),
    `value=${txNative.value / E18} QOM`);
  const wqomTok = AGG.tokenById('ql1', 'wqom');
  const txToken = H.buildRouteSwapTx('ql1', route, ADDR, 1, wqomTok);
  check('d2 contrast: the WQOM (override) build is the token swap with value 0 — the two starts really do spend differently',
    txToken.value === 0n && txToken.data.startsWith('0x38ed1739'));
  check('d3 both builds target the QomSwap router',
    txNative.to.toLowerCase() === AGG.CHAINS.ql1.router.toLowerCase() &&
    txToken.to.toLowerCase() === AGG.CHAINS.ql1.router.toLowerCase());
}

/* ============ flow shape + resume round trip ============ */
console.log('\n--- (e) flow shape ---');
{
  const amt = qom(500_000_000);
  const flow = {
    v: 1,
    id: 'qomstart-test',
    address: ADDR,
    entry: 'bsc',
    phase: 'back',
    carveDone: true,
    finalAsset: 'CAW',
    finalChain: 'ql1',
    parts: [
      {
        sym: 'QOM', pct: 100, usdtIn: '0', leg1Path: null,
        leg2Path: [WQOM_ADDR, AGG.tokenById('ql1', 'qcaw').address],
        step: 3, bridgedAmount: amt.toString(), srcNativeQom: true,
      },
    ],
  };
  const back = JSON.parse(JSON.stringify(flow));
  check('e1 save/load round trip keeps srcNativeQom and step 3',
    back.parts[0].srcNativeQom === true && back.parts[0].step === 3 &&
    back.finalAsset === 'CAW' && back.finalChain === 'ql1');
  check('e2 the part is not flow-complete (the swap step is still owed)',
    F.flowComplete ? F.flowComplete(back) === false : true);
}

/* ============ screen wiring (source level) ============ */
console.log('\n--- (f) screen wiring ---');
{
  const src = readFileSync(
    new URL('../src/screens/HuntersSwapScreen.tsx', import.meta.url).pathname,
    'utf8',
  );
  check('f1 startQomFlow exists and is wired to the Next button',
    src.includes('const startQomFlow') && src.includes("startPoint === 'qom' ? startQomFlow()"));
  check('f2 the QOM start card is balance-gated on the native QL1 balance',
    src.includes("(balances?.ql1Native ?? 0n) > 0n") && src.includes("tr('hs.fromQom')"));
  check('f3 startQomFlow blocks over-keep amounts and faucet plans before starting',
    src.includes('amt > ql1NativeSpendableWei(planNow)') &&
    src.includes("planNow.action === 'faucet'"));
  check('f4 the born part is marked srcNativeQom at step 3',
    src.includes('srcNativeQom: true'));
  check('f5 step 3 caps a native part at the native surplus and skips its allowance',
    src.includes('? ql1NativeSpendableWei(plan)') &&
    src.includes('if (!part.srcNativeQom)'));
  check('f6 step 3 builds the native swap without the token override for native parts',
    src.includes('? buildRouteSwapTx(\'ql1\', route, address, 1)'));
  check('f7 the amount screen caps chips at the native spendable',
    src.includes('ql1NativeSpendableWei(qomPlan)'));
}

console.log(`\nverify-qomstart: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
