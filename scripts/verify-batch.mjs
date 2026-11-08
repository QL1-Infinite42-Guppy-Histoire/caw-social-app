/* Verification for v0.4.3: the QL1 finishing batch.
 *
 * What v0.4.2 did wrong (on-device 2026-11-08 11:16–11:18
 * JST): the QL1 swap step offered the gas-securing unwrap
 * as a standalone sheet that unwrapped only the keep
 * SHORTFALL. The withdraw's own gas is paid from the same
 * native balance the gate measures, so each unwrap landed
 * native at (keep − one withdraw's gas), the plan still
 * reported a shortfall, and the sheet re-fired — THREE
 * WQOM.withdraw txs, the swap never reached.
 *
 * v0.4.3: the step's whole finishing sequence (one unwrap
 * of the FULL working amount, any approval, the swap) is
 * ONE batch under the step's single confirmation, planned
 * from fresh balances by ql1FinishPlan and executed by
 * runQl1FinishBatch. Token-generic: the input's nature
 * comes from the registries (resolveQl1Input /
 * isWrappedNativeToken), never a symbol branch; holdings
 * drive display via fetchHeldTokens.
 *
 * Cases: (a) WQOM-funded step, native below keep -> exactly
 * ONE withdraw of the full working amount, then the swap —
 * withdraw count == 1 across the step including a simulated
 * confirmation-poll hiccup; (b) interrupt after the unwrap
 * confirms -> resume performs ZERO further withdraws and
 * completes the swap; (c) the reporter's exact current
 * balances (native 345,850,812 QOM, WQOM
 * 44,250,688,516.779217) resume to a single-withdraw +
 * swap; (d) native-0 + WQOM -> faucet guidance (unchanged);
 * (e) the keep is never breached by a planned swap input;
 * (f) a BABY-delivered part finishes in one batch
 * (approve + swap, zero intermediate prompts, exact
 * broadcast sequence); (g) registry extension: a token
 * present ONLY as a registry entry passes the
 * arrival-verdict + finishing-plan paths; (h) holdings
 * parsing/discovery.
 *
 * Everything is stubbed or pure: no live chain calls, no
 * keys, no sends. Run: node scripts/verify-batch.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const BUILD = new URL('./.build-batch', import.meta.url).pathname;

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
const GP = 18n * E18; // measured QL1 gas price: 18 QOM/gas
const KEEP = H.ql1GasKeepWei(GP);
const UCOST = GP * H.QL1_UNWRAP_GAS_UNITS;
const SCOST = GP * H.QL1_SWAP_GAS_UNITS;
/* The withdraw gas the reporter's wallet actually paid per
 * WQOM.withdraw on-device (native ended at exactly
 * KEEP - 649,188 after the shortfall unwrap). */
const WITHDRAW_GAS = 649188n * E18;
const WQOM = H.WQOM_ADDR;
const BABY_QL1 = AGG.tokenById('ql1', 'baby').address;

check('k0 the shared keep is 346,500,000 QOM at the measured price',
  KEEP === qom(346500000), `keep=${KEEP / E18}`);

/* ---------- plan-level cases ---------- */
const plan = (over) =>
  H.ql1FinishPlan({
    kind: 'nativeAsset',
    fundsWei: 0n,
    convertedWei: 0n,
    nativeNow: 0n,
    tokenNow: 0n,
    allowanceNow: 0n,
    tokenAddr: WQOM,
    keepWei: KEEP,
    unwrapCostWei: UCOST,
    swapGasCostWei: SCOST,
    ...over,
  });

console.log('\n--- (a) plan: WQOM-funded step, native below keep ---');
{
  const B = qom(44527620288); // the reporter's delivered total
  const p = plan({ fundsWei: B, nativeNow: qom(76060540), tokenNow: B });
  check('a1 action run', p.action === 'run');
  check('a2 legs are exactly [unwrap(full), swap(native)]',
    p.legs.length === 2 &&
    p.legs[0].kind === 'unwrap' && p.legs[0].amount === B &&
    p.legs[1].kind === 'swap' && p.legs[1].spendNative === true,
    `legs=${p.legs.map((l) => l.kind).join(',')}`);
  check('a3 swap input = delivered - shortfall (44,257,180,828)',
    p.swapInput === qom(44257180828), `input=${p.swapInput / E18}`);
  check('a4 the unwrap is the FULL working amount, never the shortfall',
    p.legs[0].amount !== qom(270439460) && p.legs[0].amount === B);
}

console.log('\n--- (c) plan: reporter current state (post-3-withdraws) ---');
{
  /* Native already ≈ keep (one withdraw's gas under),
   * the swap input still sitting in WQOM, and NOTHING about
   * the earlier unwraps recorded on the part (v0.4.2 never
   * persisted them): converted = 0, funds = delivered. */
  const W = 44250688516779217n * 10n ** 12n; // 44,250,688,516.779217 QOM
  const N = qom(345850812);
  const p = plan({ fundsWei: qom(44527620288), nativeNow: N, tokenNow: W });
  check('c1 action run', p.action === 'run');
  check('c2 exactly one unwrap, of the whole remaining WQOM',
    p.legs.length === 2 && p.legs[0].kind === 'unwrap' && p.legs[0].amount === W);
  check('c3 swap input = native + WQOM - keep (the keep survives)',
    p.swapInput === N + W - KEEP, `input=${p.swapInput / E18}`);
  const p2 = plan({ fundsWei: qom(44257180828), nativeNow: N, tokenNow: W });
  check('c4 same verdict if v0.4.2 had cap-persisted bridgedAmount',
    p2.action === 'run' && p2.legs[0].kind === 'unwrap' && p2.legs[0].amount === W);
}

console.log('\n--- (d) faucet + blocked + direct starts ---');
{
  const B = qom(44527620288);
  check('d1 native 0 + WQOM: faucet (bootstrap unpayable)',
    plan({ fundsWei: B, nativeNow: 0n, tokenNow: B }).action === 'faucet');
  check('d2 native under the unwrap cost: faucet',
    plan({ fundsWei: B, nativeNow: UCOST - 1n, tokenNow: B }).action === 'faucet');
  /* WQOM direct start: fixed input, keep secured on top. */
  const fixed = plan({
    fundsWei: qom(44257180828), fixedInputWei: qom(44257180828),
    nativeNow: qom(76060540), tokenNow: B,
  });
  check('d3 WQOM start: one full unwrap, input = the chosen amount',
    fixed.action === 'run' && fixed.legs[0].kind === 'unwrap' &&
    fixed.legs[0].amount === B && fixed.swapInput === qom(44257180828));
  const partial = plan({
    fundsWei: qom(1000000000), fixedInputWei: qom(1000000000),
    nativeNow: qom(76060540), tokenNow: B,
  });
  check('d4 WQOM start (partial): unwrap = chosen + shortfall only, pile untouched',
    partial.action === 'run' &&
    partial.legs[0].amount === qom(1000000000) + qom(270439460) &&
    partial.swapInput === qom(1000000000),
    `unwrap=${partial.legs[0].amount / E18}`);
  /* Native direct start: funds ARE native (converted = all). */
  const nat = plan({
    fundsWei: qom(500000000), fixedInputWei: qom(500000000),
    convertedWei: qom(500000000), nativeNow: KEEP + qom(500000000), tokenNow: 0n,
  });
  check('d5 native start: no unwrap leg, native swap of the chosen amount',
    nat.action === 'run' && nat.legs.length === 1 &&
    nat.legs[0].kind === 'swap' && nat.swapInput === qom(500000000));
  const natBlocked = plan({
    fundsWei: qom(500000000), fixedInputWei: qom(500000000),
    convertedWei: qom(500000000), nativeNow: KEEP, tokenNow: 0n,
  });
  check('d6 native == keep only: blocked, the keep is never principal',
    natBlocked.action === 'blocked');
  /* Token kind gas gate: no native for the swap's gas. */
  const tokShort = plan({
    kind: 'token', fundsWei: qom(1000), nativeNow: SCOST - 1n,
    tokenNow: qom(1000), tokenAddr: BABY_QL1,
  });
  check('d7 token part without swap gas: faucet', tokShort.action === 'faucet');
}

console.log('\n--- (e) the keep is never breached, across a matrix ---');
{
  let ok = true, runs = 0;
  const cases = [];
  for (const n of [0n, qom(1000000), KEEP - 1n, KEEP, KEEP + qom(500000000), qom(40000000000)]) {
    for (const w of [0n, qom(1000), qom(44527620288)]) {
      for (const funds of [w, qom(44527620288)]) {
        cases.push({ fundsWei: funds, nativeNow: n, tokenNow: w });
        cases.push({ fundsWei: funds, fixedInputWei: w / 2n, nativeNow: n, tokenNow: w });
        cases.push({ fundsWei: funds, convertedWei: w / 3n, nativeNow: n + w / 3n, tokenNow: w - w / 3n });
      }
    }
  }
  for (const c of cases) {
    const p = plan(c);
    if (p.action !== 'run') continue;
    runs++;
    /* Invariant: the planned input + the keep fit inside
       everything the wallet would hold after full
       conversion (native + this step's wrapped funds), and
       inside the step's own funds (+ what was already
       native beyond them is never spent twice over). */
    const stillMax = c.tokenNow;
    if (p.swapInput + KEEP > c.nativeNow + stillMax && c.fixedInputWei === undefined) ok = false;
    if (p.swapInput > (c.fixedInputWei ?? p.swapInput)) ok = false;
    if (p.legs.filter((l) => l.kind === 'unwrap').length > 1) ok = false;
  }
  check(`e1 ${runs} runnable plans: input + keep <= post-conversion native; <= 1 unwrap leg`, ok);
  const tok = plan({
    kind: 'token', fundsWei: qom(1000), nativeNow: KEEP,
    tokenNow: qom(900), tokenAddr: BABY_QL1,
  });
  check('e2 token plans never carve the keep and never unwrap',
    tok.action === 'run' && tok.swapInput === qom(900) &&
    tok.legs.every((l) => l.kind !== 'unwrap'));
}

/* ---------- executor cases (real batch + real executeStepSend) ---------- */
const mkWorld = (init) => ({
  native: init.native, token: init.token,
  allowance: init.allowance ?? 0n,
  txs: [], polls: 0,
});
const mkSend = (world, opts = {}) => async (tx) => {
  return H.executeStepSend({
    broadcast: async () => {
      if (opts.failOn === tx.kind) throw new Error('network');
      world.txs.push(tx);
      if (tx.kind === 'unwrap') {
        world.token -= tx.amount;
        world.native += tx.amount - WITHDRAW_GAS;
      } else if (tx.kind === 'approve') {
        world.allowance = tx.amount;
      } else if (tx.kind === 'swap') {
        if (tx.spendNative) world.native -= tx.amount;
        else world.token -= tx.amount;
      }
      return '0xh' + world.txs.length;
    },
    confirm: async () => {
      /* The robust confirmer's internal polling, stubbed:
       * `hiccup` empty polls before the receipt appears. */
      let tries = 0;
      while (true) {
        tries++;
        world.polls++;
        if (opts.unconfirmable) {
          if (tries >= 3) return null;
          continue;
        }
        if (tries <= (opts.hiccup ?? 0)) continue;
        return { status: 1 };
      }
    },
  });
};
const mkBatch = (world, args, part, opts = {}) => ({
  plan: async () =>
    H.ql1FinishPlan({
      kind: args.kind ?? 'nativeAsset',
      fundsWei: args.fundsWei,
      fixedInputWei: args.fixedInputWei,
      convertedWei: BigInt(part.ql1Unwrapped ?? '0'),
      nativeNow: world.native,
      tokenNow: world.token,
      allowanceNow: world.allowance,
      tokenAddr: args.tokenAddr ?? WQOM,
      keepWei: KEEP,
      unwrapCostWei: UCOST,
      swapGasCostWei: SCOST,
    }),
  buildTx: async (leg, swapInput) => ({
    kind: leg.kind,
    amount: leg.kind === 'swap' ? swapInput : leg.amount,
    spendNative: leg.kind === 'swap' ? leg.spendNative : false,
    token: leg.token,
  }),
  send: mkSend(world, opts),
  onUnwrapConfirmed: (amount) => {
    part.ql1Unwrapped = (BigInt(part.ql1Unwrapped ?? '0') + amount).toString();
  },
});

console.log('\n--- (a) executor: one withdraw across the step, hiccup included ---');
{
  const B = qom(44527620288);
  const world = mkWorld({ native: qom(76060540), token: B });
  const part = {};
  const res = await H.runQl1FinishBatch(
    mkBatch(world, { fundsWei: B }, part, { hiccup: 2 }),
  );
  const kinds = world.txs.map((t) => t.kind);
  check('a5 broadcast sequence is exactly [unwrap, swap]',
    JSON.stringify(kinds) === '["unwrap","swap"]', kinds.join(','));
  check('a6 withdraw count == 1 despite the confirmation hiccup',
    world.txs.filter((t) => t.kind === 'unwrap').length === 1 &&
    world.polls >= 3, `polls=${world.polls}`);
  check('a7 the single withdraw moved the FULL working amount',
    world.txs[0].amount === B && world.token === 0n);
  check('a8 re-planned swap input absorbs the withdraw gas; native lands EXACTLY on the keep',
    res.swapInput === qom(44257180828) - WITHDRAW_GAS &&
    world.native === KEEP,
    `input=${res.swapInput / E18} native=${world.native / E18}`);
  check('a9 the converted amount was persisted on the part',
    part.ql1Unwrapped === B.toString());
}

console.log('\n--- (b) executor: interrupt after unwrap -> resume, zero new withdraws ---');
{
  const B = qom(44527620288);
  const world = mkWorld({ native: qom(76060540), token: B });
  const part = {};
  let threw = null;
  try {
    await H.runQl1FinishBatch(mkBatch(world, { fundsWei: B }, part, { failOn: 'swap' }));
  } catch (e) {
    threw = e;
  }
  check('b1 first run stops at the failed swap leg', threw?.message === 'network');
  check('b2 the unwrap is already persisted when the interruption hits',
    part.ql1Unwrapped === B.toString() && world.token === 0n);
  const before = world.txs.length;
  const res = await H.runQl1FinishBatch(mkBatch(world, { fundsWei: B }, part));
  const run2 = world.txs.slice(before).map((t) => t.kind);
  check('b3 resume broadcasts ONLY the swap (zero further withdraws)',
    JSON.stringify(run2) === '["swap"]', run2.join(','));
  check('b4 total withdraws across both runs == 1',
    world.txs.filter((t) => t.kind === 'unwrap').length === 1);
  check('b5 resume swap input re-derived post-unwrap (spendable - withdraw gas)',
    res.swapInput === qom(44257180828) - WITHDRAW_GAS,
    `input=${res.swapInput / E18}`);
}

console.log('\n--- (c) executor: reporter exact current balances ---');
{
  const W = 44250688516779217n * 10n ** 12n;
  const world = mkWorld({ native: qom(345850812), token: W });
  const part = {}; // v0.4.2's flow: no ql1Unwrapped recorded
  const res = await H.runQl1FinishBatch(
    mkBatch(world, { fundsWei: qom(44527620288) }, part),
  );
  const kinds = world.txs.map((t) => t.kind);
  check('c5 single withdraw + swap completes the stuck buy',
    JSON.stringify(kinds) === '["unwrap","swap"]', kinds.join(','));
  check('c6 the withdraw is the entire remaining WQOM, once',
    world.txs[0].amount === W && world.token === 0n);
  check('c7 swap input leaves exactly the keep behind (re-plan absorbs the withdraw gas)',
    res.swapInput === qom(345850812) + W - KEEP - WITHDRAW_GAS &&
    world.native === KEEP);
}

console.log('\n--- unconfirmed unwrap aborts the batch ---');
{
  const B = qom(44527620288);
  const world = mkWorld({ native: qom(76060540), token: B });
  const part = {};
  let threw = null;
  try {
    await H.runQl1FinishBatch(
      mkBatch(world, { fundsWei: B }, part, { unconfirmable: true }),
    );
  } catch (e) {
    threw = e;
  }
  check('u1 a landed-but-unconfirmed unwrap surfaces as UNCONFIRMED',
    threw instanceof H.TxUnconfirmedError,
    threw ? threw.name : 'no throw');
  check('u2 the swap is never attempted on an unproven state',
    world.txs.length === 1 && world.txs[0].kind === 'unwrap');
  check('u3 nothing is credited as converted (resume will re-check the tx)',
    part.ql1Unwrapped === undefined);
  const fauc = mkWorld({ native: 0n, token: B });
  let fThrew = null;
  try {
    await H.runQl1FinishBatch(mkBatch(fauc, { fundsWei: B }, {}));
  } catch (e) {
    fThrew = e;
  }
  check('u4 native-0 batch stops typed faucet before any broadcast',
    fThrew?.message === 'faucet' && fauc.txs.length === 0);
}

/* ---------- (f) BABY-delivered part: one batch ---------- */
console.log('\n--- (f) BABY part finishes in one batch ---');
{
  const facts = H.resolveQl1Input({
    sym: 'BABY', pct: 100, usdtIn: '0', leg1Path: null,
    leg2Path: [BABY_QL1, AGG.tokenById('ql1', 'qcaw').address],
    step: 3, bridgedAmount: qom(1000).toString(),
  });
  check('f1 the BABY part resolves from the registry as a token input',
    facts && facts.kind === 'token' && facts.tokenAddr === BABY_QL1.toLowerCase());
  const world = mkWorld({ native: KEEP + SCOST, token: qom(1000) });
  const part = {};
  const res = await H.runQl1FinishBatch(
    mkBatch(world, { kind: 'token', fundsWei: qom(1000), tokenAddr: BABY_QL1 }, part),
  );
  const kinds = world.txs.map((t) => t.kind);
  check('f2 broadcast sequence is exactly [approve, swap] — no sheets between',
    JSON.stringify(kinds) === '["approve","swap"]', kinds.join(','));
  check('f3 approve covers the swap input; the swap spends the full delivery',
    world.txs[0].amount === qom(1000) && res.swapInput === qom(1000) &&
    world.token === 0n);
  check('f4 no unwrap leg for a non-native token, ever',
    world.txs.every((t) => t.kind !== 'unwrap'));
  const world2 = mkWorld({ native: KEEP + SCOST, token: qom(1000), allowance: qom(1000) });
  await H.runQl1FinishBatch(
    mkBatch(world2, { kind: 'token', fundsWei: qom(1000), tokenAddr: BABY_QL1 }, {}),
  );
  check('f5 an existing allowance skips the approve leg (still one batch)',
    JSON.stringify(world2.txs.map((t) => t.kind)) === '["swap"]');
}

/* ---------- (g) registry extension smoke ---------- */
console.log('\n--- (g) a token that exists ONLY as a registry entry ---');
{
  const FAKE = '0x1111111111111111111111111111111111111111';
  const entry = H.ensureAggToken({
    chain: 'ql1', address: FAKE, symbol: 'XTK', decimals: 6, balance: 5000000n,
  });
  check('g1 ensureAggToken registers the held token', !!entry && entry.decimals === 6);
  const facts = H.resolveQl1Input({
    sym: 'XTK', pct: 100, usdtIn: '0', leg1Path: null, leg2Path: null,
    step: 3, bridgedAmount: '5000000', ql1TokenAddr: FAKE, ql1TokenDec: 6,
  });
  check('g2 resolveQl1Input: token kind, its own decimals, no code mention',
    facts && facts.kind === 'token' && facts.decimals === 6 &&
    facts.tokenAddr === FAKE);
  const p = plan({
    kind: facts.kind, fundsWei: 5000000n, nativeNow: KEEP + SCOST,
    tokenNow: 5000000n, tokenAddr: FAKE,
  });
  check('g3 finishing plan runs for the registry-only token',
    p.action === 'run' && p.swapInput === 5000000n &&
    p.legs.map((l) => l.kind).join(',') === 'approve,swap');
  check('g4 wrapped-native is a registry property, not a symbol',
    H.isWrappedNativeToken('ql1', AGG.tokenById('ql1', 'wqom')) === true &&
    H.isWrappedNativeToken('ql1', AGG.tokenById('ql1', 'native')) === false &&
    H.isWrappedNativeToken('ql1', AGG.tokenById('ql1', 'baby')) === false &&
    H.isWrappedNativeToken('ql1', entry) === false);
  /* Arrival verdict: the repair follows the registry FLAG,
   * not the symbol — an unknown symbol WITH the flag gets
   * the legacy-baseline repair; the QOM symbol WITHOUT it
   * does not. */
  const huge = qom(100000000000);
  const vFlag = H.partArrivalVerdict(qom(100), {
    sym: 'ZZZ', bridgedAmount: qom(100).toString(),
    dstBalanceBefore: huge.toString(), deliversWrappedNative: true,
  });
  check('g5 verdict repair follows the flag (unknown symbol, flag set)',
    vFlag.action === 'arrived' && vFlag.arrived === qom(100));
  const vNoFlag = H.partArrivalVerdict(qom(50), {
    sym: 'QOM', bridgedAmount: qom(100).toString(),
    dstBalanceBefore: huge.toString(),
  });
  check('g6 no flag -> no repair, even for the QOM symbol',
    vNoFlag.action === 'wait');
  const qomFacts = H.resolveQl1Input({
    sym: 'QOM', pct: 100, usdtIn: '0', leg1Path: null, leg2Path: null,
    step: 3, bridgedAmount: '1',
  });
  check('g7 the QOM pair resolves as the native asset via the anchor',
    qomFacts && qomFacts.kind === 'nativeAsset' && qomFacts.tokenAddr === WQOM.toLowerCase());
}

/* ---------- (h) holdings discovery ---------- */
console.log('\n--- (h) holdings-driven display ---');
{
  const payload = [
    { token: { address_hash: WQOM, symbol: 'WQOM', decimals: '18' }, value: '123' },
    { token: { address_hash: '0xd2140E16aDf37194036865E90BbCA1139b739d0D', symbol: 'CAW', decimals: '18' }, value: '5' },
    { token: { address_hash: BABY_QL1, symbol: 'BABY', decimals: '18' }, value: '0' },
    { token: { address_hash: '0x2222222222222222222222222222222222222222', symbol: 'XTK', decimals: '6' }, value: '5000000' },
    { token: { address_hash: '0x3333333333333333333333333333333333333333', decimals: '18' }, value: '7' },
    { token: { address_hash: 'not-an-address', symbol: 'BAD', decimals: '18' }, value: '7' },
    { token: { address_hash: '0x4444444444444444444444444444444444444444', symbol: 'WEIRD', decimals: '99' }, value: '7' },
  ];
  const held = H.parseHeldTokenBalances('ql1', payload, H.heldTokenExclude('ql1'));
  check('h1 curated duplicates, zero balances, junk and bad decimals are filtered',
    held.length === 2 && held[0].symbol === 'XTK' && held[0].decimals === 6 &&
    held[0].balance === 5000000n,
    `held=${held.map((h) => h.symbol).join(',')}`);
  check('h2 a missing symbol falls back to the short address',
    held[1].symbol === '…3333');
  const fetcher = async (url) => {
    if (url.includes('scan.qom.network')) {
      return [
        { token: { address_hash: BABY_QL1, symbol: 'BABY', decimals: '18' }, value: '42' },
      ];
    }
    throw new Error('boom');
  };
  const got = await H.fetchHeldTokens(ADDR, fetcher);
  check('h3 one chain failing leaves the other chain\u2019s holdings intact',
    got.length === 1 && got[0].chain === 'ql1' && got[0].symbol === 'BABY');
  check('h4 start candidacy is holdings-only (chain + balance)',
    H.ql1HeldStartCandidate(got[0]) === true &&
    H.ql1HeldStartCandidate({ ...got[0], chain: 'infinite' }) === false);
}

/* ---------- screen wiring (source level) ---------- */
console.log('\n--- screen wiring ---');
{
  const src = readFileSync(
    new URL('../src/screens/HuntersSwapScreen.tsx', import.meta.url).pathname,
    'utf8',
  );
  const buy = src.slice(
    src.indexOf('function BuySection'),
    src.indexOf('function SellSection'),
  );
  check('w1 the buy step 3 runs the finishing batch',
    buy.includes('runQl1FinishBatch') && buy.includes('prepareFinish'));
  check('w2 NO standalone unwrap sheet exists anywhere in the screen',
    !src.includes("askSend(tr('hs.stepUnwrap')"));
  check('w3 no symbol branch for QOM remains in the buy section',
    !buy.includes("sym === 'QOM'"));
  check('w4 the WQOM start persists its chosen amount as the fixed input',
    buy.includes('ql1FixedInput: amt.toString()'));
  check('w5 held tokens render in the balance card and as start cards',
    buy.includes('heldTokens.map') && buy.includes("tr('hs.fromToken'"));
  check('w6 the batch persists the converted amount on unwrap confirm',
    buy.includes('onUnwrapConfirmed') && buy.includes('ql1Unwrapped'));
}

console.log(`\nverify-batch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
