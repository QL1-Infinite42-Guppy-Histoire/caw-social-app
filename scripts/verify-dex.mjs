#!/usr/bin/env node
/**
 * HuntersDEX verification (v0.7.7).
 *
 * The HuntersExchange order book is replaced by a normal DEX
 * flow over the app's aggregator engine (lib/aggEngine) on
 * QL1, limited to seven tokens: QOM (native), WQOM, O,
 * qCAW, KET, HAWK, PHOENIX (WQOM added by user decision
 * 2026-11-19, v0.7.7). This suite pins:
 *   - the engine's QL1 table carries the DEX tokens
 *     (PHOENIX registered at the verified burnToMint
 *     contract; WQOM is the engine's own wrapped-native
 *     entry at the same address as the native anchor);
 *   - LIVE read-only quotes through the engine for every
 *     ordered SWAP pair at probe amounts (the 2026-11-18
 *     probe: all 30 ordered pairs routed; the 2026-11-19
 *     probe: all 10 WQOM swap pairs routed; a pair that
 *     loses its route fails here loudly rather than in
 *     the app);
 *   - the QOM ⇄ WQOM pair is NOT a swap: it is served by
 *     the WQOM contract's deposit()/withdraw() 1:1 (the
 *     engine returns no route for it — same address both
 *     sides), verified here by read-only eth_call
 *     simulations of both calls, and the section's wiring
 *     to lib/hunters' buildWrapTx / buildUnwrapTx;
 *   - the wiring statics: DexSwapSection quotes via
 *     fetchBestRoute, re-quotes before signing, approves the
 *     router only when short, builds the swap with
 *     buildSwapTx, holds the QL1 gas keep back on native
 *     QOM, reads its own WQOM balance (the wallet display
 *     list is separate and unchanged), and shows the honest
 *     no-pool note with the swap disabled when there is
 *     no route;
 *   - the rename: no user-facing "HuntersExchange" label
 *     remains in the drawer or the screen header.
 * No keys, no sends.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = ROOT + '/scripts/.build-dex';
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
      'src/lib/aggEngine.ts',
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
  ok(true, 'tsc compiles the dex graph');
} catch (e) {
  ok(false, 'tsc: ' + (e.stdout || '').toString().slice(0, 400));
  process.exit(1);
}
writeFileSync(OUT + '/package.json', '{"type":"commonjs"}');

const AGG = await import(OUT + '/lib/aggEngine.js');
const CFG = await import(OUT + '/config.js');

const DEX_IDS = ['native', 'wqom', 'o', 'qcaw', 'ket', 'hawk', 'phoenix'];
const PROBES = {
  native: 10n,
  wqom: 10n,
  o: 10n,
  qcaw: 1000000n,
  ket: 10n,
  hawk: 100n,
  phoenix: 10n,
};
const E18 = 10n ** 18n;

/* ---------- the seven tokens ---------- */
{
  for (const id of DEX_IDS) {
    ok(AGG.tokenById('ql1', id) !== null, `engine table: '${id}' exists on QL1`);
  }
  const wqom = AGG.tokenById('ql1', 'wqom');
  const native = AGG.tokenById('ql1', 'native');
  ok(
    wqom.address.toLowerCase() === AGG.WQOM.toLowerCase() &&
      wqom.address.toLowerCase() === native.address.toLowerCase() &&
      wqom.isNative === false && wqom.decimals === 18,
    'engine table: WQOM is the wrapped native at the anchor address (not itself native)',
  );
  const phoenix = AGG.tokenById('ql1', 'phoenix');
  ok(
    phoenix.address.toLowerCase() === CFG.PHOENIX.toLowerCase(),
    'engine table: PHOENIX is the verified burnToMint contract',
  );
  const ket = AGG.tokenById('ql1', 'ket');
  ok(
    ket.address.toLowerCase() === '0x034c1fe794ab9d30e27e1ce0d89a4591fc9f1fb4',
    'engine table: KET is the QL1-side address the app already uses',
  );
  const hawk = AGG.tokenById('ql1', 'hawk');
  ok(
    hawk.address.toLowerCase() === CFG.HAWK.toLowerCase(),
    'engine table: HAWK is the QL1 HAWK contract',
  );
}

/* ---------- live pair quotes (read-only) ---------- */
{
  const chain = AGG.CHAINS.ql1;
  let routed = 0;
  let total = 0;
  for (const a of DEX_IDS) {
    for (const b of DEX_IDS) {
      if (a === b) continue;
      /* The QOM ⇄ WQOM pair is wrap/unwrap, never a router
       * swap — it is verified by eth_call below, not here. */
      if (
        (a === 'native' && b === 'wqom') ||
        (a === 'wqom' && b === 'native')
      ) {
        continue;
      }
      total++;
      const route = await AGG.fetchBestRoute(
        chain,
        AGG.tokenById('ql1', a),
        AGG.tokenById('ql1', b),
        PROBES[a] * E18,
      );
      if (route && route.amountOut > 0n) routed++;
      else console.log(`  --  no route: ${a} -> ${b}`);
    }
  }
  ok(
    routed === total,
    `live quotes: all ${total} ordered swap pairs route at probe amounts (${routed}/${total})`,
  );
}

/* ---------- wrap / unwrap (read-only eth_call) ---------- */
{
  const chain = AGG.CHAINS.ql1;
  const rpc = chain.rpcs[0];
  const WQOM = AGG.WQOM;
  const pad = (h) => h.padStart(64, '0');
  let rpcId = 0;
  const ethCall = async (tx) => {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'eth_call',
        params: [tx, 'latest'],
      }),
    });
    return res.json();
  };
  /* deposit(): payable — a 1-wei call from a codeless
   * address must succeed (it only needs the value). */
  const dep = await ethCall({
    from: '0x000000000000000000000000000000000000dEaD',
    to: WQOM,
    data: '0xd0e30db0',
    value: '0x1',
  });
  ok(!dep.error, 'wrap: WQOM.deposit() eth_call simulation succeeds');
  /* withdraw(1): needs a sender that actually holds WQOM
   * and can receive native — the burn address holds a
   * large burned WQOM balance and has no code. */
  const holder = '0x000000000000000000000000000000000000dEaD';
  const bal = await ethCall({
    to: WQOM,
    data: '0x70a08231' + pad(holder.slice(2)),
  });
  const holderBal = bal.result ? BigInt(bal.result) : 0n;
  ok(holderBal > 0n, 'unwrap: the simulation holder holds WQOM');
  const wd = await ethCall({
    from: holder,
    to: WQOM,
    data: '0x2e1a7d4d' + pad('1'),
  });
  ok(!wd.error, 'unwrap: WQOM.withdraw(1) eth_call simulation succeeds');
}

/* ---------- wiring statics ---------- */
{
  const section = readFileSync(ROOT + '/src/screens/DexSwapSection.tsx', 'utf8');
  for (const id of DEX_IDS) {
    ok(section.includes(`id: '${id}'`), `DEX section offers '${id}'`);
  }
  ok(
    !section.includes("'qusdt'") && !section.includes("'baby'") &&
      !section.includes("'father'") && !section.includes("'zap'"),
    'DEX section offers ONLY the seven tokens',
  );
  ok(
    section.includes('isWrapPair') &&
      section.includes('buildWrapTx') &&
      section.includes('buildUnwrapTx') &&
      section.includes('wrap: true'),
    'QOM ⇄ WQOM is served by wrap/unwrap (lib/hunters builders), not a router swap',
  );
  ok(
    section.includes('erc20Balance') && section.includes('refreshWqomBal'),
    'the section reads its own WQOM balance (wallet display list unchanged)',
  );
  ok(section.includes('fetchBestRoute'), 'quotes come from the engine (fetchBestRoute)');
  ok(
    section.indexOf('fetchBestRoute', section.indexOf('const doSwap')) >
      section.indexOf('const doSwap'),
    'the send re-quotes before signing',
  );
  ok(section.includes('hs.priceMoved'), 'a >5% adverse re-quote stops the send (price-moved)');
  ok(
    section.includes('buildSwapTx') && section.includes('buildApproveTx'),
    'the swap + approve txs are built by the engine',
  );
  ok(
    section.includes('QL1_GAS_KEEP_FLOOR_WEI'),
    'native QOM keeps the QL1 gas keep back',
  );
  ok(
    section.includes("tr('dex.noPool')") && section.includes('quoteState === \'none\''),
    'no route at quote time -> the honest no-pool note (never a fake quote)',
  );
  ok(
    section.includes('canSwap') && section.includes("quoteState === 'ok'"),
    'the swap button is gated on a live quote',
  );
  const screen = readFileSync(ROOT + '/src/screens/HuntersSwapScreen.tsx', 'utf8');
  ok(
    screen.includes('<DexSwapSection />') && !screen.includes('<ExchangeSection />'),
    'the HuntersDEX screen mounts the DEX section, not the order book',
  );
  ok(
    screen.includes('Hunters') && screen.includes('DEX') &&
      !screen.includes('>Exchange<') && screen.includes("tr('dex.caption')"),
    'the screen header says HuntersDEX with the swap caption',
  );
  const drawer = readFileSync(ROOT + '/src/components/Drawer.tsx', 'utf8');
  ok(
    drawer.includes('label="HuntersDEX"') && !drawer.includes('label="HuntersExchange"'),
    'the drawer row is renamed HuntersDEX',
  );
}

console.log(`\ndex: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
