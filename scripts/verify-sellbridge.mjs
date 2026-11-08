/* Verification for v0.4.4: the sell (cash-out) QL1->42
 * bridge leg's native/wrapped representation mismatch.
 *
 * The bug (2026-11-08 12:13-12:16 JST, on-device): the
 * reporter's sell swapped CAW->QOM on QL1 and approved the
 * bridge router, then NOTHING was ever broadcast. The QL1
 * swap leg built swapExactTokensForETH (its route end —
 * the WQOM contract — resolved by address lookup to the
 * chain's "native" entry), so the proceeds landed as
 * NATIVE QOM, while the bridge step spends the pair's
 * ERC-20 (WQOM) via transferRemote: balance 0, the send
 * could not proceed, the cash-out parked mid-flow.
 *
 * The fix: (1) buildRouteSwapTx takes a toTokOverride
 * (symmetric to fromTokOverride) and the sell leg passes
 * the pair's own QL1 token entry, so proceeds land as
 * WQOM; (2) the bridge step reconciles older flows via
 * the pure ql1BridgePlan + runQl1BridgeBatch: a WQOM
 * shortfall covered by the native surplus above the QL1
 * gas keep is wrapped (WQOM.deposit) exactly once inside
 * the step's own send sequence, then the bridge runs;
 * anything else stops as a classified insufficient.
 *
 * Case (b) replays the reporter's exact parked state:
 * native QOM 11,370,689,767, WQOM 0, the bridge approve
 * already landed on-chain.
 *
 * Everything is stubbed or pure: no live chain calls, no
 * keys, no sends. Run: node scripts/verify-sellbridge.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const BUILD = new URL('./.build-sellbridge', import.meta.url).pathname;

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
const AGG = require(BUILD + '/lib/aggEngine.js');

const ADDR = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC';
const E18 = 10n ** 18n;
const qom = (whole) => BigInt(whole) * E18;
const WQOM_ADDR = AGG.WQOM;
const CAW_ADDR = AGG.tokenById('ql1', 'qcaw').address;
const BABY_ADDR = AGG.tokenById('ql1', 'baby').address;
const SEL_TFT = '0x38ed1739'; // swapExactTokensForTokens
const SEL_TFE = '0x18cbafe5'; // swapExactTokensForETH
const SEL_ETF = '0x7ff36ab5'; // swapExactETHForTokens

/* ============ (a) fresh sell QL1 leg pays out WQOM ============ */
console.log('\n--- (a) sell QL1 swap leg: payout representation ---');
{
  const amtIn = qom(1000000);
  const amtOut = qom(900);
  const route = {
    path: [CAW_ADDR, WQOM_ADDR],
    amounts: [amtIn, amtOut], amountIn: amtIn, amountOut: amtOut,
  };
  const wqomTok = AGG.tokenById('ql1', 'wqom');
  check('a0 the QOM pair\'s QL1 token entry is the WQOM ERC-20 entry',
    wqomTok && wqomTok.isNative === false &&
    wqomTok.address.toLowerCase() === WQOM_ADDR.toLowerCase());

  const legacy = H.buildRouteSwapTx('ql1', route, ADDR, 1);
  check('a1 address-resolved build (pre-fix path) pays NATIVE — documents the bug',
    legacy.data.startsWith(SEL_TFE) && legacy.value === 0n);

  const fixed = H.buildRouteSwapTx('ql1', route, ADDR, 1, undefined, wqomTok);
  check('a2 toTokOverride build is swapExactTokensForTokens (proceeds land as WQOM)',
    fixed.data.startsWith(SEL_TFT) && fixed.value === 0n &&
    fixed.to.toLowerCase() === AGG.CHAINS.ql1.router.toLowerCase());

  const babyTok = AGG.tokenById('ql1', 'baby');
  const babyRoute = {
    path: [CAW_ADDR, BABY_ADDR],
    amounts: [amtIn, amtOut], amountIn: amtIn, amountOut: amtOut,
  };
  const babyFixed = H.buildRouteSwapTx('ql1', babyRoute, ADDR, 1, undefined, babyTok);
  const babyLegacy = H.buildRouteSwapTx('ql1', babyRoute, ADDR, 1);
  check('a3 non-QOM pair end is token-spending with AND without the override (unchanged)',
    babyFixed.data.startsWith(SEL_TFT) && babyLegacy.data.startsWith(SEL_TFT));

  /* Buy-side non-regression: WQOM->CAW with no overrides is
   * still the native-spending build (the finishing batch
   * unwraps first), and the from-side override still spends
   * the ERC-20. */
  const buyRoute = {
    path: [WQOM_ADDR, CAW_ADDR],
    amounts: [amtOut, amtIn], amountIn: amtOut, amountOut: amtIn,
  };
  const buyNative = H.buildRouteSwapTx('ql1', buyRoute, ADDR, 1);
  check('a4 buy leg without overrides still builds swapExactETHForTokens',
    buyNative.data.startsWith(SEL_ETF) && buyNative.value === amtOut);
  const buyToken = H.buildRouteSwapTx('ql1', buyRoute, ADDR, 1, wqomTok);
  check('a5 buy leg with fromTokOverride still builds swapExactTokensForTokens',
    buyToken.data.startsWith(SEL_TFT) && buyToken.value === 0n);

  /* 42-side audit: the 'infinite' native entry uses the
   * 0xeee… placeholder address, shared with NO token entry,
   * so address resolution there can never pick the native
   * entry for a real token end. */
  const infNative = AGG.tokenById('infinite', 'native');
  const qom42 = AGG.tokenById('infinite', 'qom');
  const usdt42 = AGG.tokenById('infinite', 'usdt');
  const route42 = {
    path: [usdt42.address, qom42.address],
    amounts: [amtIn, amtOut], amountIn: amtIn, amountOut: amtOut,
  };
  const tx42 = H.buildRouteSwapTx('infinite', route42, ADDR, 1);
  check('a6 42 Chain native entry is the placeholder (no shared address, no ambiguity)',
    infNative.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' &&
    tx42.data.startsWith(SEL_TFT));
}

/* ============ (b) the reporter's parked state reconciles ============ */
console.log('\n--- (b) bridge reconcile plan: reporter\'s exact state ---');
{
  const KEEP = H.QL1_GAS_KEEP_FLOOR_WEI;
  check('b0 keep floor is 346,500,000 QOM (unchanged arithmetic)',
    KEEP === qom(346500000));
  const wrapCost = H.QL1_GAS_PRICE_FLOOR * H.QL1_WRAP_GAS_UNITS;
  check('b1 wrap cost at floor price is 900,000 QOM', wrapCost === qom(900000));

  const NATIVE = qom(11370689767); // the reporter's native QOM
  const surplus = NATIVE - KEEP - wrapCost; // 11,023,289,767 QOM
  const base = {
    erc20: true, wrappedNative: true,
    nativeBal: NATIVE, keepWei: KEEP, wrapCostWei: wrapCost,
  };

  const p1 = H.ql1BridgePlan({ ...base, amt: qom(11000000000), tokenBal: 0n, allowance: qom(11000000000) });
  check('b2 WQOM 0 + native-held proceeds -> wrap the full amount, no approve needed',
    p1.action === 'run' && p1.wrapWei === qom(11000000000) && p1.needsApprove === false);

  const p2 = H.ql1BridgePlan({ ...base, amt: surplus, tokenBal: 0n, allowance: surplus });
  check('b3 amount exactly at the surplus boundary still runs',
    p2.action === 'run' && p2.wrapWei === surplus);

  const p3 = H.ql1BridgePlan({ ...base, amt: surplus + qom(1), tokenBal: 0n, allowance: surplus + qom(1) });
  check('b4 one QOM past the surplus -> classified insufficient (keep never converted)',
    p3.action === 'insufficient' && p3.wrapWei === 0n);

  const p4 = H.ql1BridgePlan({ ...base, amt: qom(11000000000), tokenBal: qom(4000000000), allowance: qom(11000000000) });
  check('b5 partial WQOM -> wrap exactly the shortfall',
    p4.action === 'run' && p4.wrapWei === qom(7000000000));

  const p5 = H.ql1BridgePlan({ ...base, amt: qom(500), tokenBal: qom(500), allowance: qom(500) });
  check('b6 WQOM already covers the amount -> no wrap',
    p5.action === 'run' && p5.wrapWei === 0n && p5.needsApprove === false);

  const p6 = H.ql1BridgePlan({ ...base, amt: qom(500), tokenBal: qom(500), allowance: 0n });
  check('b7 missing allowance -> approve leg planned',
    p6.action === 'run' && p6.needsApprove === true);

  const p7 = H.ql1BridgePlan({
    amt: qom(500), erc20: true, wrappedNative: false,
    tokenBal: 0n, nativeBal: NATIVE, allowance: 0n,
    keepWei: KEEP, wrapCostWei: wrapCost,
  });
  check('b8 ordinary token part: no reconcile, runs as before (approve + bridge)',
    p7.action === 'run' && p7.wrapWei === 0n && p7.needsApprove === true);

  const wx = H.buildWrapTx(qom(5));
  check('b9 buildWrapTx is WQOM.deposit() with the amount as value',
    wx.to.toLowerCase() === WQOM_ADDR.toLowerCase() &&
    wx.data === '0xd0e30db0' && wx.value === qom(5));
}

/* ============ (c) batch executor: one sequence, wrap once ============ */
console.log('\n--- (c) runQl1BridgeBatch sequences ---');
{
  const KEEP = H.QL1_GAS_KEEP_FLOOR_WEI;
  const wrapCost = H.QL1_GAS_PRICE_FLOOR * H.QL1_WRAP_GAS_UNITS;
  const reporterPlan = H.ql1BridgePlan({
    amt: qom(11000000000), erc20: true, wrappedNative: true,
    tokenBal: 0n, nativeBal: qom(11370689767), allowance: qom(11000000000),
    keepWei: KEEP, wrapCostWei: wrapCost,
  });

  const run = async (plan, sendImpl) => {
    const built = [];
    const sent = [];
    await H.runQl1BridgeBatch({
      plan, amt: qom(11000000000),
      buildTx: async (leg) => {
        built.push(leg.kind);
        if (leg.kind === 'wrap') return H.buildWrapTx(leg.amount);
        return { to: '0x' + leg.kind, data: '0x', value: 0n };
      },
      send: async (tx) => { sent.push(tx); if (sendImpl) await sendImpl(tx); },
    });
    return { built, sent };
  };

  const r1 = await run(reporterPlan, null);
  check('c1 reporter state broadcasts exactly [wrap, bridge] in one sequence',
    r1.built.join(',') === 'wrap,bridge' && r1.sent.length === 2);
  check('c2 the wrap leg is a single deposit of the full shortfall',
    r1.sent[0].data === '0xd0e30db0' && r1.sent[0].value === qom(11000000000));

  const needApprove = { ...reporterPlan, needsApprove: true };
  const r2 = await run(needApprove, null);
  check('c3 with a missing allowance the sequence is [wrap, approve, bridge]',
    r2.built.join(',') === 'wrap,approve,bridge');

  let builtCount = 0;
  let aborted = false;
  try {
    await H.runQl1BridgeBatch({
      plan: reporterPlan, amt: qom(11000000000),
      buildTx: async (leg) => { builtCount++; return { to: '0x0', data: '0x', value: 0n }; },
      send: async () => { throw new H.TxUnconfirmedError('0xabc'); },
    });
  } catch (e) {
    aborted = e instanceof H.TxUnconfirmedError;
  }
  check('c4 an unconfirmed wrap aborts the sequence — bridge never built',
    aborted && builtCount === 1);

  let touched = 0;
  let insuff = false;
  try {
    await H.runQl1BridgeBatch({
      plan: { action: 'insufficient', wrapWei: 0n, needsApprove: false },
      amt: qom(1),
      buildTx: async () => { touched++; return {}; },
      send: async () => { touched++; },
    });
  } catch (e) {
    insuff = e instanceof Error && e.message === 'insufficient';
  }
  check('c5 an insufficient plan throws before anything is built or sent',
    insuff && touched === 0);

  /* Resume after a confirmed wrap: fresh balances show the
   * token covering the amount, so the re-plan wraps ZERO —
   * the sequence is the bridge alone. */
  const resumed = H.ql1BridgePlan({
    amt: qom(11000000000), erc20: true, wrappedNative: true,
    tokenBal: qom(11000000000), nativeBal: qom(370689767),
    allowance: qom(11000000000), keepWei: KEEP, wrapCostWei: wrapCost,
  });
  const r3 = await run(resumed, null);
  check('c6 resume after the wrap landed plans no second wrap ([bridge] only)',
    resumed.wrapWei === 0n && r3.built.join(',') === 'bridge');
}

/* ============ (d) screen wiring ============ */
console.log('\n--- (d) screen wiring ---');
{
  const src = readFileSync(new URL('../src/screens/HuntersSwapScreen.tsx', import.meta.url), 'utf8');
  check('d1 sell QL1 leg passes the pair token as toTokOverride',
    src.includes("buildRouteSwapTx('ql1', route, address, 1, undefined, dstTok)"));
  check('d2 sell bridge step plans through ql1BridgePlan and runs runQl1BridgeBatch',
    src.includes('ql1BridgePlan({') && src.includes('runQl1BridgeBatch({'));
  check('d3 sell bridge step wraps through buildWrapTx with the hs.stepWrap sub-status',
    src.includes('buildWrapTx(leg.amount)') && src.includes("'hs.stepWrap'"));
  const i18n = readFileSync(new URL('../src/i18n.ts', import.meta.url), 'utf8');
  const langs = (i18n.match(/'hs\.stepWrap':/g) || []).length;
  check('d4 hs.stepWrap exists in all 13 languages', langs === 13, `found ${langs}`);
}

console.log(`\nverify-sellbridge: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
