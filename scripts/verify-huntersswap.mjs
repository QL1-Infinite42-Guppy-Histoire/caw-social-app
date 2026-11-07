/* Verification for HuntersSwap (v0.3.0). Run:
 *   node scripts/verify-huntersswap.mjs
 *
 * LIVE read-only quotes + pure logic. No keys, no sends.
 *
 * BUY:  $100 / $500 from BSC and $100 from Ethereum -> qCAW
 *       end-to-end via the ported aggregator engine; split must
 *       NOT be offered at $100 and MUST win at $500 (the plan's
 *       measured pattern); the [42] carve-out and BSC $3 gas-keep
 *       math; the ETH $100 minimum gate.
 * SELL: 75B qCAW -> USDT (42) -> bridge out (flat 2 USDT fee,
 *       message fee 0 — re-quoted live) -> BNB / ETH final quotes.
 * Calldata selectors for every send the app can build, cross-
 * checked against the GuppyWallet sources they were ported from.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const BUILD = new URL('./.build-hunters', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};
const fmt = (raw, dec = 18) => {
  const s = BigInt(raw).toString().padStart(dec + 1, '0');
  const whole = s.slice(0, -dec).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = s.slice(-dec).replace(/0+$/, '').slice(0, 4);
  return frac ? whole + '.' + frac : whole;
};

execFileSync(
  'npx',
  [
    'tsc', '--ignoreConfig',
    'src/config.ts', 'src/lib/cawCore.ts', 'src/lib/myActions.ts',
    'src/lib/chains.ts', 'src/lib/aggEngine.ts', 'src/lib/hunters.ts',
    'src/lib/flows.ts',
    '--module', 'commonjs', '--target', 'es2022',
    '--outDir', BUILD, '--skipLibCheck',
  ],
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'inherit' },
);

const H = require(BUILD + '/lib/hunters.js');
const chains = require(BUILD + '/lib/chains.js');
const flows = require(BUILD + '/lib/flows.js');
const { parseUnits, formatUnits } = require('ethers');

const RECIP = '0x000000000000000000000000000000000000dEaD';
const started = new Date().toISOString();
console.log('live run at', started);

/* ---------------- prices + gates ---------------- */
const bnbUsd = await H.nativeUsdPrice('bsc');
const ethUsd = await H.nativeUsdPrice('ethereum');
console.log(`  BNB $${bnbUsd.toFixed(2)}  ETH $${ethUsd.toFixed(2)}`);
check('prices readable', bnbUsd > 100 && ethUsd > 500);

const ethAmt = (usd) => parseUnits((usd / ethUsd).toFixed(18), 18);
check('ETH gate: $99 blocked', H.ethEntryAllowed(ethAmt(99), ethUsd) === false);
check('ETH gate: $101 allowed', H.ethEntryAllowed(ethAmt(101), ethUsd) === true);

const oneBnb = parseUnits('1', 18);
const keep = H.bscGasKeepRaw(oneBnb, bnbUsd);
const keepUsd = Number(formatUnits(keep, 18)) * bnbUsd;
check('BSC gas keep is $3', Math.abs(keepUsd - 3) < 0.05, `keep=$${keepUsd.toFixed(2)}`);
const spendable = H.bscSpendable(oneBnb, bnbUsd);
check('BSC spendable = balance - keep', spendable === oneBnb - keep);

/* ---------------- carve-out math ---------------- */
const fee = parseUnits('2.947', 18);
const c1 = H.planCarveout(1, fee, 0n);
check(
  'carve: 1 leg, empty wallet -> fee + 0.3 margin',
  c1.needFromFlow === fee + parseUnits('0.3', 18),
  `need=${fmt(c1.needFromFlow)}`,
);
const c3 = H.planCarveout(3, fee, 0n);
check('carve: reserve scales with legs', c3.reserveTotal === (fee + parseUnits('0.3', 18)) * 3n);
const cRich = H.planCarveout(2, fee, parseUnits('100', 18));
check('carve: covered wallet needs nothing', cRich.needFromFlow === 0n);

/* ---------------- calldata selectors ---------------- */
const sel = (tx) => tx.data.slice(0, 10);
const usdt100 = parseUnits('100', 18);
check('entry swap selector (swapExactETHForTokens)',
  sel(H.buildEntrySwapTx('bsc', parseUnits('0.1', 18), 1n, RECIP)) === '0x7ff36ab5');
check('approve selector',
  sel(H.buildApproveTx(chains.USDT_ON.bsc.address, RECIP, 1n)) === '0x095ea7b3');
check('bridge-in selector (transferRemote)',
  sel(H.buildBridgeInTx('bsc', usdt100, RECIP, 0n)) === '0x81b4e8b4');
check('bridge-out selector (transferRemote)',
  sel(H.buildBridgeOut42Tx('bsc', RECIP, usdt100, 0n)) === '0x81b4e8b4');
check('final swap selector (swapExactTokensForETH)',
  sel(H.buildFinalSwapTx('bsc', usdt100, 1n, RECIP)) === '0x18cbafe5');
const gwZap = readFileSync(process.env.HOME + '/workspace/infinite-ql1-wallet/src/lib/zaphod.ts', 'utf8');
const gwBsc = readFileSync(process.env.HOME + '/workspace/infinite-ql1-wallet/src/lib/bscSwap.ts', 'utf8');
check('GuppyWallet sources carry the same bridge/swap functions',
  gwZap.includes('transferRemote') && gwBsc.includes('swapExactETHForTokens'));

/* ---------------- BUY: BSC $100 / $500 ---------------- */
for (const usd of [100, 500]) {
  const bnbIn = parseUnits((usd / bnbUsd).toFixed(18), 18);
  const entryUsdt = await H.quoteEntrySwap('bsc', bnbIn);
  const usdt42 = H.expected42Usdt(entryUsdt, 18);
  check(`BUY BSC $${usd}: entry swap sane`, entryUsdt > usdt42 && usdt42 > parseUnits('50', 18),
    `entry=${fmt(entryUsdt)} USDT, on42=${fmt(usdt42)}`);
  const back = await H.quoteBackHalf(usdt42);
  const out = back.bestSingle.finalOut;
  console.log(`  BUY BSC $${usd}: best single -> ${fmt(out)} qCAW via ${back.bestSingle.pair.sym}`);
  if (usd === 100) {
    check('BUY $100: end-to-end qCAW in plan ballpark (40B..120B)',
      out > 40n * 10n ** 27n && out < 120n * 10n ** 27n, fmt(out));
    check('BUY $100: split NOT offered', back.split === null,
      back.split ? 'split was offered' : 'single only');
  } else {
    check('BUY $500: split offered and beats single (net of fees)',
      back.split !== null && back.split.netOut > out,
      back.split ? `net=${fmt(back.split.netOut)} (+${back.split.netGainPct.toFixed(1)}%)` : 'no split');
  }
  check(`BUY BSC $${usd}: bridge fee per leg > 0`, back.feePerLeg42 > 0n,
    `${fmt(back.feePerLeg42)} [42]`);
}

/* ---------------- BUY: ETH $100 ---------------- */
{
  const entryUsdt = await H.quoteEntrySwap('ethereum', ethAmt(100));
  const usdt42 = H.expected42Usdt(entryUsdt, 6);
  const back = await H.quoteBackHalf(usdt42);
  console.log(`  BUY ETH $100: entry=${fmt(entryUsdt, 6)} USDT(6dec) on42=${fmt(usdt42)} -> ${fmt(back.bestSingle.finalOut)} qCAW`);
  check('BUY ETH $100: end-to-end qCAW sane', back.bestSingle.finalOut > 30n * 10n ** 27n);
  const g = await H.ethGasInfo();
  console.log(`  ETH gas now: ${(Number(g.gasPriceWei) / 1e9).toFixed(3)} gwei, ~$${g.totalUsd450k.toFixed(2)} for the entry`);
  check('ETH gas info readable', g.totalUsd450k > 0);
}

/* ---------------- SELL: 75B qCAW ---------------- */
{
  const qcawIn = 75n * 10n ** 9n * 10n ** 18n;
  const back = await H.quoteBackHalfReverse(qcawIn);
  const usdt42 = back.bestSingle.finalOut;
  console.log(`  SELL 75B qCAW -> ${fmt(usdt42)} USDT(42) via ${back.bestSingle.pair.sym}` +
    (back.split ? `; split net=${fmt(back.split.netOut)} (+${back.split.netGainPct.toFixed(1)}%)` : '; no split'));
  check('SELL: USDT out in measured ballpark (50..120)', usdt42 > parseUnits('50', 18) && usdt42 < parseUnits('120', 18), fmt(usdt42));
  check('SELL: split invariant (offered only when it beats single)',
    back.split === null || back.split.netOut > usdt42);
  for (const t of ['bsc', 'ethereum']) {
    const q = await H.quoteBridgeOut42(t, usdt42);
    check(`SELL bridge-out (${t}): flat 2 USDT fee, message fee 0`,
      q.tokenFee === parseUnits('2', 18) && q.forward === usdt42 - q.tokenFee && q.totalNative === 0n,
      `forward=${fmt(q.forward)}`);
    const fwdT = H.toTargetUsdtRaw(q.forward, t);
    const nativeOut = await H.quoteFinalSwap(t, fwdT);
    console.log(`  SELL -> ${t}: ${fmt(fwdT, chains.USDT_ON[t].decimals)} USDT -> ${fmt(nativeOut)} ${t === 'bsc' ? 'BNB' : 'ETH'}`);
    check(`SELL final quote (${t}) > 0`, nativeOut > 0n);
  }
}


/* ---------------- fee stack: 42 -> QL1 (user emphasis) -------- */
{
  const agg = require(BUILD + '/lib/aggEngine.js');
  const p42 = await H.price42Usd();
  console.log(`  [42] price (DEX reserves): $${p42?.toFixed(4)}`);
  let stackOk = true;
  for (const pair of agg.BRIDGE_PAIRS) {
    if (!pair.enabledFromInf) continue;
    const q = await agg.fetchBridgeNativeQuote(pair);
    const feeTok = await H.quotePairTokenFee(pair, parseUnits('1000000', 18), 'infinite');
    const usd = q ? Number(formatUnits(q.totalNative, 18)) * (p42 ?? 0) : 0;
    console.log(
      `  pair ${pair.sym}: quoteNative=${q ? formatUnits(q.totalNative, 18) : '?'} [42] ($${usd.toFixed(3)}), tokenFee=${feeTok === null ? 'no quote fn (1:1)' : formatUnits(feeTok, 18)}`,
    );
    if (!q || Math.abs(usd - 2) > 0.2) stackOk = false;
    if (feeTok !== null && feeTok !== 0n) stackOk = false;
  }
  check('fee stack: quoteNative ~= $2.00 per leg on every enabled pair, token fee 0', stackOk);
  const five = parseUnits('2.946987', 18) * 5n;
  console.log(`  5-part split fee stack: 5 x ~2.947 = ${formatUnits(five, 18)} [42] (~$${(Number(formatUnits(five, 18)) * (p42 ?? 0)).toFixed(2)}) + gas`);
  const gas = await H.quoteGasEstimates();
  console.log(`  gas estimates: 42-side per leg=${gas ? formatUnits(gas.gas42PerLeg, 18) : '?'} [42], QL1 swap=${gas ? formatUnits(gas.gasQomPerSwap, 18) : '?'} QOM`);
  check('gas estimates live', !!gas && gas.gas42PerLeg > 0n && gas.gasQomPerSwap > 0n);
  // Net headline: $100 BSC buy — carve cost converts to a strictly
  // smaller, fee-sized reduction of the gross engine output.
  const bnbIn = parseUnits((100 / bnbUsd).toFixed(18), 18);
  const entryUsdt = await H.quoteEntrySwap('bsc', bnbIn);
  const usdt42 = H.expected42Usdt(entryUsdt, 18);
  const back = await H.quoteBackHalf(usdt42);
  const carve = H.planCarveout(1, back.feePerLeg42, 0n);
  const cq = await H.quoteCarveUsdtCost(carve.needFromFlow);
  const net = H.netHeadline(back.bestSingle.finalOut, usdt42, cq.usdtCost);
  const dropPct = (1 - Number(net) / Number(back.bestSingle.finalOut)) * 100;
  console.log(
    `  net headline: gross=${fmt(back.bestSingle.finalOut)} qCAW, carveCost=${fmt(cq.usdtCost)} USDT, net=${fmt(net)} qCAW (-${dropPct.toFixed(2)}%)`,
  );
  check('net headline < gross by ~the converted fee (0.3%..6%)',
    net < back.bestSingle.finalOut && dropPct > 0.3 && dropPct < 6,
    `-${dropPct.toFixed(2)}%`);
}

/* ---------------- flow machine (sell phases) ---------------- */
{
  const f = flows.newFlow({
    id: 'test', address: RECIP, entry: 'bsc', direction: 'sell', exitTarget: 'bsc',
    entryAmountRaw: '1', entryUsdtExpected: '0', usdt42Expected: '1',
    confirmedOut: '1', choice: 'single', createdAt: Date.now(),
  });
  const kinds = ['exitBridge', 'waitTarget', 'pausedTarget', 'finalSwap', 'done'];
  let okAll = true;
  for (const ph of kinds) {
    if (flows.nextStep({ ...f, phase: ph }).kind !== ph) okAll = false;
  }
  check('flow machine: sell phases map to their step kinds', okAll);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
