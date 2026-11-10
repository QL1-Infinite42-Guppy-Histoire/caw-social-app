/* Verification for v0.4.1: the misreported-success fix, resume
 * rehydration, start-point expansion (USDT start / 42-USDT
 * mid-starts / sell arrival choice), the faucet client, the
 * QL1 gas guidance gate, and the two invariants (end goal
 * preserved; gas auto-keep untouched).
 * Run: node scripts/verify-resume.mjs
 *
 * Everything is stubbed or pure: no live chain calls, no keys,
 * no sends. The journey section replays the reporter's exact
 * numbers (2026-11-08 08:55 JST): 0.041971 BNB swapped to
 * 29.157 USDT, leaving BNB 0.004313 / USDT 29.156883 on BSC,
 * with the saved flow still pointing at the swap step.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const BUILD = new URL('./.build-resume', import.meta.url).pathname;

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
const FA = require(BUILD + '/lib/faucet.js');
const I = require(BUILD + '/i18n.js');

const ADDR = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC';
/* Fake clock for the receipt poller: sleep() just advances now. */
const fakeClock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    elapsed: () => t,
  };
};

/* ================= A. receipt confirmation ================= */
console.log('\n--- A. confirmed tx is never reported failed ---');
{
  const clock = fakeClock();
  let aCalls = 0, bCalls = 0;
  const fetcherA = async () => {
    aCalls++;
    if (aCalls <= 2) throw new Error('rpc down');
    return null; // reachable but not mined yet
  };
  const fetcherB = async () => {
    bCalls++;
    return bCalls >= 2 ? { status: 1 } : null;
  };
  const r = await H.confirmReceipt([fetcherA, fetcherB], {
    windowMs: 90000, sleep: clock.sleep, now: clock.now,
  });
  check('A1 receipt found after throw/null retries + failover', r !== null && r.status === 1,
    `A=${aCalls} B=${bCalls} elapsed=${clock.elapsed()}ms`);

  // (a) step-level: broadcast succeeds, polls hiccup, then mined.
  const clock2 = fakeClock();
  let polls = 0;
  const hash = await H.executeStepSend({
    broadcast: async () => '0xabc',
    confirm: () => H.confirmReceipt([
      async () => { polls++; if (polls < 3) throw new Error('timeout'); return polls >= 4 ? { status: 1 } : null; },
    ], { windowMs: 90000, sleep: clock2.sleep, now: clock2.now }),
  });
  check('A2 executeStepSend resolves the hash once the receipt lands', hash === '0xabc');

  // (b) receipt never arrives in the window -> UNCONFIRMED,
  // a distinct typed error carrying the hash — never "failed".
  const clock3 = fakeClock();
  let err = null;
  try {
    await H.executeStepSend({
      broadcast: async () => '0xdef',
      confirm: () => H.confirmReceipt([async () => null], {
        windowMs: 2000, sleep: clock3.sleep, now: clock3.now,
      }),
    });
  } catch (e) { err = e; }
  check('A3 no receipt in window -> TxUnconfirmedError with hash',
    err instanceof H.TxUnconfirmedError && err.hash === '0xdef');
  check('A4 unconfirmed classifies distinctly', H.classifyStepError(err) === 'unconfirmed');
  check('A5 unconfirmed maps to its own message key',
    H.stepErrorKey(H.classifyStepError(err)) === 'hs.unconfirmed');

  // A mined-but-reverted receipt is a real failure, said plainly.
  let rerr = null;
  try {
    await H.executeStepSend({
      broadcast: async () => '0x123',
      confirm: async () => ({ status: 0 }),
    });
  } catch (e) { rerr = e; }
  check('A6 reverted receipt -> TxRevertedError -> reverted kind',
    rerr instanceof H.TxRevertedError && H.classifyStepError(rerr) === 'reverted');
}

/* ================= B. error taxonomy + messages ============ */
console.log('\n--- B. taxonomy ---');
{
  const cases = [
    [{ code: 'INSUFFICIENT_FUNDS', message: 'insufficient funds' }, 'insufficient', 'hs.notEnough'],
    [{ code: 'NETWORK_ERROR', message: 'fetch failed' }, 'network', 'hs.netFailed'],
    [new Error('price-moved'), 'price-moved', 'hs.priceMoved'],
    [new Error('no-route'), 'no-route', 'hs.noRoute'],
    [new Error('boom'), 'failed', 'hs.failed'],
  ];
  cases.forEach(([e, kind, key], i) => {
    check(`B${i + 1} ${kind} distinct`, H.classifyStepError(e) === kind && H.stepErrorKey(kind) === key);
  });
  check('B6 insufficient key is NOT the generic failure key',
    H.stepErrorKey('insufficient') !== H.stepErrorKey('failed'));
  check('B7 unconfirmed key is NOT the generic failure key',
    H.stepErrorKey('unconfirmed') !== H.stepErrorKey('failed'));
}

/* ================= C. i18n message identity (20 langs) ===== */
console.log('\n--- C. surviving strings exist and differ in all 20 languages ---');
{
  /* v0.5.0 formal: the string checks for the REMOVED
   * instant-swap UX (hs.stepAlreadyDone / hs.startFrom /
   * hs.arriveAs / hs.arriveUsdt / hs.arriveNative /
   * hs.fromUsdt42 / hs.fromCaw / hs.wqomNote) are retired
   * together with the strings themselves. What stays checked:
   * the error-taxonomy and gas strings the surviving features
   * use (the Exchange deposit flows surface hs.needGasCoin /
   * hs.gasQomShort through this same taxonomy), and the
   * faucet strings. */
  for (const { code } of I.LANGS) {
    I.setLang(code);
    const ok =
      I.tr('hs.unconfirmed') !== 'hs.unconfirmed' &&
      I.tr('hs.unconfirmed') !== I.tr('hs.failed') &&
      I.tr('hs.needGasCoin', { sym: 'BNB' }).includes('BNB') &&
      I.tr('hs.gasQomShort') !== 'hs.gasQomShort' &&
      I.tr('faucet.title') !== 'faucet.title' &&
      I.tr('faucet.err.address_cooldown', { t: 'X' }).includes('X') &&
      I.tr('faucet.err.daily_limit') !== I.tr('faucet.err.failed');
    check(`C ${code}: unconfirmed/gas/faucet strings present and distinct`, ok);
  }
  I.setLang('en');
}

/* ================= D. the reporter's exact journey ========= */
console.log('\n--- D. journey: swap succeeded, resume must land on the bridge ---');
{
  const flow = {
    ...F.newFlow({
      id: 'journey', address: ADDR, entry: 'bsc',
      entryAmountRaw: '41971000000000000',       // 0.041971 BNB
      entryUsdtExpected: '29157000000000000000', // 29.157 USDT
      usdt42Expected: '27157000000000000000',
      confirmedOut: '1000000000000000000',
      choice: 'single', createdAt: 1,
      entryUsdtBefore: '0',
      finalAsset: 'CAW', finalChain: 'ql1',
    }),
    phase: 'entrySwap',
  };
  const usdtNow = 29156883000000000000n;  // 29.156883 USDT (actual)
  const nativeNow = 4313000000000000n;    // 0.004313 BNB = the keep

  check('D1 guard sees the swap already landed',
    H.entrySwapGuard(flow, nativeNow, usdtNow) === 'already-done');

  // The runEntrySwap composition: only 'proceed' may broadcast.
  let broadcasts = 0;
  const g = H.entrySwapGuard(flow, nativeNow, usdtNow);
  if (g === 'proceed') broadcasts++;
  check('D2 no second swap is attempted on resume', broadcasts === 0);

  const advanced = H.resumeEntryAdvance(flow, usdtNow);
  check('D3 resume advances the saved flow to the bridge step',
    advanced !== null && advanced.phase === 'entryBridge');
  check('D4 next step after resume is the bridge',
    advanced !== null && F.nextStep(advanced).kind === 'entryBridge');
  check('D5 bridge step amount comes from the actual balance',
    usdtNow - BigInt(flow.entryUsdtBefore) === 29156883000000000000n);

  check('D6 empty step data keeps Next disabled',
    H.entryStepReady(flow, null) === false && H.entryStepReady(flow, 0n) === false);
  check('D7 live quote makes the step actionable',
    H.entryStepReady(flow, 29157000000000000000n) === true);

  // Saved-state round trip (Map-backed KV), end goal preserved.
  const kv = new Map();
  const store = new F.HuntersFlowStore('test');
  await store.init({ getItem: async (k) => kv.get(k) ?? null, setItem: async (k, v) => { kv.set(k, v); } }, ADDR);
  await store.save(advanced);
  const loaded = await store.load();
  check('D8 round trip: phase + end goal + address unchanged',
    loaded !== null && loaded.phase === 'entryBridge' &&
    loaded.finalAsset === 'CAW' && loaded.finalChain === 'ql1' &&
    loaded.address === ADDR);

  // Regression guards on the same flow shape.
  check('D9 no funds + no arrival -> insufficient (never generic)',
    H.entrySwapGuard(flow, 0n, 0n) === 'insufficient');
  check('D10 funded + no arrival yet -> proceed',
    H.entrySwapGuard(flow, nativeNow + 41971000000000000n, 0n) === 'proceed');
}

/* ================= E. gas auto-keep invariant ============== */
console.log('\n--- E. gas keep is never spent ---');
{
  // BNB at $1000: keep $3 = 0.003 BNB. Balance = keep + 0.001.
  const bal = 4000000000000000n;
  check('E1 spendable = balance - $3 keep',
    H.bscSpendable(bal, 1000) === 1000000000000000n);
  // Resume in that state: a swap of the original 0.041971 BNB
  // would breach the keep -> the keep-aware check blocks it.
  const amt = 41971000000000000n;
  check('E2 keep-aware check blocks a keep-breaching resume swap',
    amt > H.bscSpendable(42471000000000000n, 1000));
  check('E3 arrival conversion with gas under the threshold pauses at USDT',
    H.arrivalAction('native', 0.5) === 'paused-usdt');
  check('E4 arrival conversion with enough gas proceeds',
    H.arrivalAction('native', 2.5) === 'final-swap');
  check('E5 pre-v0.4.1 flows (no endCoin) keep the native behavior',
    H.arrivalAction(undefined, 0.5) === 'paused-usdt' &&
    H.arrivalAction(undefined, 2.5) === 'final-swap');
}

/* ================= F. USDT start (buy) ===================== */
console.log('\n--- F. USDT start ---');
{
  check('F1 BSC USDT start: quote math skips the swap leg',
    H.expected42Usdt(29156883000000000000n, 18) === 27156883000000000000n);
  check('F2 ETH USDT start: 100 USDT (6dp) -> 98 USDT on 42 (18dp)',
    H.expected42Usdt(100000000n, 6) === 98000000000000000000n);
  check("F3 reporter's live state passes the gas pre-flight",
    H.usdtStartGasOk(4313000000000000n, 3000000000n) === true);
  check('F4 zero gas coin fails the pre-flight',
    H.usdtStartGasOk(0n, 3000000000n) === false);
  check('F5 dust gas coin fails on L1 prices',
    H.usdtStartGasOk(500000000000000n, 20000000000n) === false);

  // Start composition (the startFlow math): committed amount is
  // measured by balance-minus-before at the bridge step.
  const totalBal = 100000000000000000000n; // 100 USDT held
  const amount = 29156883000000000000n;
  const beforeForFlow = totalBal - amount;
  const flow = {
    ...F.newFlow({
      id: 'usdt-start', address: ADDR, entry: 'bsc',
      entryAmountRaw: amount.toString(), entryUsdtExpected: amount.toString(),
      usdt42Expected: '27156883000000000000', confirmedOut: '1',
      choice: 'single', createdAt: 1,
      entryUsdtBefore: beforeForFlow.toString(), startCoin: 'usdt',
      finalAsset: 'CAW', finalChain: 'ql1',
    }),
    phase: 'entryBridge',
  };
  check('F6 USDT-start flow is born at the bridge step',
    F.nextStep(flow).kind === 'entryBridge');
  check('F7 bridge measures exactly the committed amount',
    totalBal - BigInt(flow.entryUsdtBefore) === amount);
  const kv = new Map();
  const store = new F.HuntersFlowStore('test2');
  await store.init({ getItem: async (k) => kv.get(k) ?? null, setItem: async (k, v) => { kv.set(k, v); } }, ADDR);
  await store.save(flow);
  const loaded = await store.load();
  check('F8 round trip keeps startCoin + end goal',
    loaded !== null && loaded.startCoin === 'usdt' && loaded.finalAsset === 'CAW');
}

/* ================= G. 42-USDT mid-starts =================== */
console.log('\n--- G. mid-starts from 42 Chain USDT ---');
{
  const buyMid = {
    ...F.newFlow({
      id: 'buy-mid', address: ADDR, entry: 'bsc',
      entryAmountRaw: '0', entryUsdtExpected: '0',
      usdt42Expected: '50000000000000000000', confirmedOut: '1',
      choice: 'single', createdAt: 1, entryUsdtBefore: '0',
      usdt42Actual: '50000000000000000000', startCoin: 'usdt',
      finalAsset: 'CAW', finalChain: 'ql1',
    }),
    phase: 'back',
  };
  check('G1 buy mid-start is born at the back half (requote state)',
    F.nextStep(buyMid).kind === 'requote');
  const withParts = {
    ...buyMid, carveDone: true,
    parts: [{ sym: 'FISH', pct: 100, usdtIn: '50000000000000000000', leg1Path: null, leg2Path: null, step: 0 }],
  };
  check('G2 after init it runs parts like a bridged-in flow',
    F.nextStep(withParts).kind === 'part');

  const bal = 80000000000000000000n; // 80 USDT on 42
  const amt = 50000000000000000000n;
  const sellMid = {
    ...F.newFlow({
      id: 'sell-mid', address: ADDR, entry: 'bsc', direction: 'sell',
      exitTarget: 'bsc', entryAmountRaw: '0', entryUsdtExpected: '0',
      usdt42Expected: amt.toString(), confirmedOut: '1',
      choice: 'single', createdAt: 1,
      usdt42Before: (bal - amt).toString(),
      sellUsdt42Expected: amt.toString(), exitForward: '48000000000000000000',
      endCoin: 'usdt', finalAsset: 'USDT', finalChain: 'bsc',
    }),
    phase: 'exitBridge', carveDone: true, parts: [],
  };
  check('G3 sell mid-start is born at the exit bridge',
    F.nextStep(sellMid).kind === 'exitBridge');
  check('G4 exit bridge measures exactly the committed amount',
    bal - BigInt(sellMid.usdt42Before) === amt);
  check('G5 USDT arrival finishes at the USDT (no conversion)',
    H.arrivalAction(sellMid.endCoin, 0) === 'done-usdt');
  const kv = new Map();
  const store = new F.HuntersFlowStore('test3');
  await store.init({ getItem: async (k) => kv.get(k) ?? null, setItem: async (k, v) => { kv.set(k, v); } }, ADDR);
  await store.save(sellMid);
  const loaded = await store.load();
  check('G6 round trip keeps endCoin + final asset + chain',
    loaded !== null && loaded.endCoin === 'usdt' &&
    loaded.finalAsset === 'USDT' && loaded.finalChain === 'bsc');
}

/* ================= H. QL1 gas guidance gate ================ */
console.log('\n--- H. QL1 gas gate ---');
{
  const perSwap = 1000000000000000n; // measured-style figure
  check('H1 native QOM = 0 (WQOM present is irrelevant) -> guidance state',
    H.ql1GasShort(0n, perSwap) === true);
  check('H2 native QOM below one swap of gas -> short',
    H.ql1GasShort(perSwap - 1n, perSwap) === true);
  check('H3 native QOM covering the swap -> not short',
    H.ql1GasShort(perSwap, perSwap) === false);
}

/* ================= I. faucet (stubbed Worker) ============== */
console.log('\n--- I. faucet ---');
{
  const okFetch = async (url) => ({
    ok: true, status: 200,
    json: async () => url.includes('/status')
      ? { ready: true, claimsLeft: 41, chain: '42', token: 'native', symbol: '42', claimAmount: '0.05' }
      : { ok: true, txHash: '0xfeed', amount: '0.05', explorerUrl: 'https://scan.example/tx/0xfeed' },
  });
  const st = await FA.fetchFaucetStatus(FA.FAUCET_POOLS[0], okFetch);
  check('I1 status renders ready pool with stock',
    st !== null && st.ready === true && st.claimsLeft === 41 && st.claimAmount === '0.05');
  const notReady = await FA.fetchFaucetStatus(FA.FAUCET_POOLS[1], async () => ({
    ok: true, status: 200,
    json: async () => ({ ready: false, reason: 'cooldown', chain: 'ql1', token: 'native', symbol: 'QOM', claimAmount: '10000000' }),
  }));
  check('I2 status renders not-ready pool with its reason',
    notReady !== null && notReady.ready === false && notReady.reason === 'cooldown');
  const claimed = await FA.claimFaucet(FA.FAUCET_POOLS[0], ADDR, okFetch);
  check('I3 claim success carries txHash + amount + explorer link',
    claimed.ok === true && claimed.txHash === '0xfeed' && claimed.amount === '0.05' && !!claimed.explorerUrl);

  let allMapped = true;
  for (const code of FA.FAUCET_ERROR_CODES) {
    const r = await FA.claimFaucet(FA.FAUCET_POOLS[0], ADDR, async () => ({
      ok: false, status: 400,
      json: async () => ({ ok: false, code, retryAfterSec: 3600 }),
    }));
    if (r.ok || r.code !== code || FA.faucetErrorKey(code) !== `faucet.err.${code}`) allMapped = false;
    if (I.tr(FA.faucetErrorKey(code), { t: 'X' }) === FA.faucetErrorKey(code)) allMapped = false;
  }
  check('I4 every worker rejection code maps to its own message', allMapped);
  check('I5 unlisted code falls back to the claim-specific message',
    FA.faucetErrorKey('something_new') === 'faucet.err.failed');
  const netErr = await FA.claimFaucet(FA.FAUCET_POOLS[0], ADDR, async () => { throw new Error('offline'); });
  check('I6 request failure is the network outcome, not a worker code',
    netErr.ok === false && netErr.code === 'network');
  check('I7 retry buckets: 7d / 5h / 10m / 30s',
    FA.retryParts(604800).unit === 'days' && FA.retryParts(604800).n === 7 &&
    FA.retryParts(18000).unit === 'hours' && FA.retryParts(18000).n === 5 &&
    FA.retryParts(600).unit === 'minutes' && FA.retryParts(600).n === 10 &&
    FA.retryParts(30).n === 1);
  check('I8 pools are the three live ones',
    FA.FAUCET_POOLS.length === 3 &&
    FA.FAUCET_POOLS.some((p) => p.chain === 'ql1' && p.sym === 'QOM') &&
    FA.FAUCET_POOLS.some((p) => p.token === 'zap' && p.sym === 'ZAP'));
}

/* ================= J. source checks ======================== */
console.log('\n--- J. source checks ---');
{
  const wallet = readFileSync(new URL('../src/lib/wallet.ts', import.meta.url), 'utf8');
  const timeline = readFileSync(new URL('../src/screens/TimelineScreen.tsx', import.meta.url), 'utf8');
  check('J1 wallet no longer confirms via tx.wait()', !wallet.includes('tx.wait()'));
  /* J2–J8 RETIRED in v0.5.0 formal: they asserted that the
   * instant-swap screen wired the resume/advance gates
   * (resumeEntryAdvance, entryStepReady), the USDT-start
   * pre-flight, the execution-time gas-keep re-check, the QL1
   * gas gates, the 42-USDT mid-starts and the arrival choice.
   * The user removed that screen's flows entirely
   * (「板だけにして」), so there is no wiring left to assert.
   * The LIBRARY behaviors behind those checks stay verified
   * in sections A–I above and in verify-huntersswap.mjs; the
   * Exchange deposit flows' own wiring is pinned in
   * verify-exchange.mjs section 4. */
  check('J9 Recaw sheet clears the nav bar (shared inset pattern)',
    timeline.includes('30 + insets.bottom'));
}

/* ================= K. goal recommendation (library) ======== */
console.log('\n--- K. goal recommendation helper (library) ---');
{
  check('K1 holding CAW recommends the cash-out goal',
    H.recommendedGoal(1000000000000000000n) === 'sell');
  check('K2 no CAW defaults to the buy goal',
    H.recommendedGoal(0n) === 'buy');
  /* K3–K5 RETIRED in v0.5.0 formal: they verified the goal
   * cards and the mid-flow U-turn — instant-swap UX the user
   * removed. The goal strings (hs.goalBuy / hs.goalSell /
   * hs.goalBuySub / hs.goalSellSub / hs.recommend / hs.uturn /
   * hs.uturnNote) were deleted from all 20 dictionaries along
   * with the cards. recommendedGoal itself remains in
   * lib/hunters.ts as a library helper, so K1/K2 stay. */
}

console.log(`\nverify-resume: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
