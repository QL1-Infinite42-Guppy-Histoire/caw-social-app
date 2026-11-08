/* Verification for v0.4.2 (additions): the QL1 WQOM
 * balance row, the WQOM mid-start, and the app-wide QL1
 * gas keep.
 *
 * The keep (user's final sizing rule, 2026-11-08):
 *   keep = measured processAction cost x 100 actions
 *        + swap-class steps + 10% margin
 * Measured live (gas price 18 QOM/gas): processAction
 * 106,316-136,258 gas over 15 sampled real txs -> unit
 * 150,000 gas; swap 183,917 / bridge-out 233,913 /
 * approve ~46,900 -> unit 250,000 gas; unwrap 36,042 by
 * estimateGas. Keep = (150,000x100 + 250,000x10) x 1.10
 * = 19,250,000 gas = 346,500,000 QOM at 18 QOM/gas.
 *
 * Everything is stubbed or pure: no live chain calls, no
 * keys, no sends. Run: node scripts/verify-wqom.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const BUILD = new URL('./.build-wqom', import.meta.url).pathname;

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
const GAS_PRICE = 18n * E18; // measured QL1 floor: 18 QOM/gas
const KEEP = H.ql1GasKeepWei(GAS_PRICE);
const UNWRAP_COST = GAS_PRICE * H.QL1_UNWRAP_GAS_UNITS;

/* ============ keep sizing (the reported basis) ============ */
console.log('\n--- keep sizing from the measured basis ---');
check('K1 keep gas units = (150k x 100 + 250k x 10) x 1.10 = 19,250,000',
  H.QL1_KEEP_GAS_UNITS === 19250000n, `units=${H.QL1_KEEP_GAS_UNITS}`);
check('K2 keep at 18 QOM/gas = 346,500,000 QOM',
  KEEP === qom(346500000), `keep=${KEEP / E18} QOM`);
check('K3 floor fallback equals the same figure (single definition)',
  H.QL1_GAS_KEEP_FLOOR_WEI === KEEP);
check('K4 the per-swap estimate uses the shared swap unit',
  H.QL1_SWAP_GAS_UNITS === 250000n && H.QL1_ACTION_GAS_UNITS === 150000n);

/* ============ (a) WQOM only, native 0 -> faucet ============ */
console.log('\n--- (a) bootstrap: no native gas at all ---');
{
  const p = H.ql1KeepPlan(0n, qom(44527620288), KEEP, UNWRAP_COST);
  check('a1 native 0 + WQOM present -> faucet guidance decision',
    p.action === 'faucet');
  check('a2 nothing spendable, no unwrap attempted',
    p.spendableWei === 0n && p.unwrapWei === 0n);
  const p2 = H.ql1KeepPlan(qom(100000), qom(1000), KEEP, UNWRAP_COST);
  check('a3 native below the unwrap gas cost -> faucet too',
    p2.action === 'faucet' && p2.spendableWei === 0n);
}

/* ============ (b) small native: unwrap secures the keep ============ */
console.log('\n--- (b) keep secured by unwrap, remainder quotable ---');
{
  const native0 = qom(5000000); // >= unwrap cost (~0.9M), far below keep
  const wqom0 = qom(44527620288);
  const p = H.ql1KeepPlan(native0, wqom0, KEEP, UNWRAP_COST);
  check('b1 action is unwrap', p.action === 'unwrap');
  check('b2 unwrap is exactly the shortfall (keep - native)',
    p.unwrapWei === KEEP - native0, `unwrap=${p.unwrapWei / E18} QOM`);
  check('b3 spendable is the remainder, keep excluded',
    p.spendableWei === wqom0 - (KEEP - native0));
  /* Apply the unwrap: native becomes exactly the keep. */
  const native1 = native0 + p.unwrapWei;
  const wqom1 = wqom0 - p.unwrapWei;
  const pAfter = H.ql1KeepPlan(native1, wqom1, KEEP, UNWRAP_COST);
  check('b4 after the unwrap the keep is secured (ok, no more unwrap)',
    pAfter.action === 'ok' && pAfter.unwrapWei === 0n && native1 === KEEP);
  check('b5 remainder fully quotable, and no more than the remainder',
    pAfter.spendableWei === wqom1 && qom(1) + wqom1 > pAfter.spendableWei);
}

/* ============ reporter state + already-secured ============ */
console.log('\n--- reporter state (2026-11-08, real balances) ---');
{
  const p = H.ql1KeepPlan(qom(76060540), qom(44527620288), KEEP, UNWRAP_COST);
  check('r1 reporter: unwrap 270,439,460 QOM secures the keep',
    p.action === 'unwrap' && p.unwrapWei === qom(270439460),
    `unwrap=${p.unwrapWei / E18}`);
  check('r2 reporter: spendable = 44,257,180,828 QOM',
    p.spendableWei === qom(44257180828), `spendable=${p.spendableWei / E18}`);
  const rich = H.ql1KeepPlan(qom(400000000), qom(1000), KEEP, UNWRAP_COST);
  check('r3 native already above the keep -> ok, full WQOM spendable',
    rich.action === 'ok' && rich.unwrapWei === 0n && rich.spendableWei === qom(1000));
}

/* ============ (c) repeated steps cannot plan the keep away ============ */
console.log('\n--- (c) the reserve survives repeated planning ---');
{
  let native = qom(5000000);
  let wqom = qom(44527620288);
  let okAll = true;
  for (let round = 0; round < 5; round++) {
    const p = H.ql1KeepPlan(native, wqom, KEEP, UNWRAP_COST);
    /* The plan may never offer principal + unwrap beyond the
       WQOM that exists, and after securing, native >= keep
       whenever WQOM could cover the shortfall. */
    if (p.spendableWei + p.unwrapWei > wqom) okAll = false;
    if (p.action === 'unwrap') {
      native += p.unwrapWei;
      wqom -= p.unwrapWei;
      if (native < KEEP && wqom > 0n) okAll = false; // covered shortfall must land ON the keep
    }
    /* Spend half the spendable as this round's swap, pay a
       swap's gas from native, and re-plan. */
    const spend = p.spendableWei / 2n;
    wqom -= spend;
    native -= GAS_PRICE * 250000n; // one swap-class gas draw
    if (p.action !== 'faucet' && native + wqom < 0n) okAll = false;
  }
  check('c1 five plan/spend rounds never breach the reserve arithmetic', okAll);
  /* Once WQOM is gone, no plan can manufacture spendable
     principal against the native reserve. */
  const drained = H.ql1KeepPlan(KEEP - GAS_PRICE * 250000n, 0n, KEEP, UNWRAP_COST);
  check('c2 WQOM exhausted: spendable stays 0 (reserve is not principal)',
    drained.spendableWei === 0n && drained.unwrapWei === 0n);
}

/* ============ unwrap tx + WQOM-start execution path ============ */
console.log('\n--- unwrap tx and the WQOM-start flow ---');
{
  const amt = qom(270439460);
  const tx = H.buildUnwrapTx(amt);
  check('u1 unwrap tx targets WQOM with withdraw() calldata, value 0',
    tx.to.toLowerCase() === H.WQOM_ADDR.toLowerCase() &&
    tx.value === 0n &&
    tx.data === '0x2e1a7d4d' + amt.toString(16).padStart(64, '0'));

  /* The flow a WQOM start creates (same shape startWqomFlow
     persists): born at the QL1 swap step, finalAsset CAW. */
  const wqomTok = AGG.tokenById('ql1', 'wqom');
  const cawTok = AGG.tokenById('ql1', 'qcaw');
  const spendable = qom(44257180828);
  const flow = {
    ...F.newFlow({
      id: 'wqom-test', address: ADDR, entry: 'bsc',
      entryAmountRaw: '0', entryUsdtExpected: '0', usdt42Expected: '0',
      confirmedOut: '19900000000000000000000000000', choice: 'single',
      createdAt: 0, finalAsset: 'CAW', finalChain: 'ql1',
    }),
    phase: 'back',
    carveDone: true,
    parts: [{
      sym: 'QOM', pct: 100, usdtIn: '0', leg1Path: null,
      leg2Path: [wqomTok.address, cawTok.address], step: 3,
      bridgedAmount: spendable.toString(), dstBaseIsToken: true,
    }],
  };
  const s = F.nextStep(flow);
  check('u2 WQOM-start flow resumes at the QL1 swap step (part 3)',
    s.kind === 'part' && s.step === 3 && flow.finalAsset === 'CAW');
  const route = {
    path: [wqomTok.address, cawTok.address],
    amounts: [spendable, spendable * 450n],
    amountIn: spendable, amountOut: spendable * 450n,
  };
  const swapTx = H.buildRouteSwapTx('ql1', route, ADDR, 1, wqomTok);
  check('u3 quoted WQOM->CAW executes as a token swap (no native spent)',
    swapTx.value === 0n && swapTx.data.startsWith('0x38ed1739'));
  const done = { ...flow, parts: [{ ...flow.parts[0], step: 4 }] };
  check('u4 after the swap step the flow completes (same shape as organic)',
    F.flowComplete(done) === true);
}

/* ============ screen wiring: WQOM row + start card ============ */
console.log('\n--- screen wiring (source-level) ---');
{
  const src = readFileSync(new URL('../src/screens/HuntersSwapScreen.tsx', import.meta.url), 'utf8');
  const rows = src.match(/name="WQOM" chain="QL1"/g) || [];
  check('w1 WQOM balance row present in BOTH coin lists', rows.length === 2,
    `rows=${rows.length}`);
  check('w2 WQOM start card is balance-gated (non-zero only)',
    src.includes("(balances?.ql1Wqom ?? 0n) > 0n") && src.includes("tr('hs.fromWqom')"));
  check('w3 balances are read from the extended fetch (ql1Wqom threaded)',
    src.includes('balances?.ql1Wqom'));
  check('w4 gas-short WQOM start routes to the faucet guidance block',
    src.includes("wqomPlan?.action === 'faucet'") && src.includes("tr('hs.gasQomShort')"));
}

console.log(`\nverify-wqom: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
