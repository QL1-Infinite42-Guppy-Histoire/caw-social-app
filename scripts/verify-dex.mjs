#!/usr/bin/env node
/**
 * HuntersDEX verification (v0.7.0).
 *
 * The HuntersExchange order book is replaced by a normal DEX
 * flow over the app's aggregator engine (lib/aggEngine) on
 * QL1, limited to six tokens: QOM (native), O, qCAW, KET,
 * HAWK, PHOENIX. This suite pins:
 *   - the engine's QL1 table carries exactly the six tokens
 *     for the DEX (PHOENIX registered at the verified
 *     burnToMint contract);
 *   - LIVE read-only quotes through the engine for every
 *     ordered pair at probe amounts (the 2026-11-18 probe:
 *     all 30 ordered pairs routed; a pair that loses its
 *     route fails here loudly rather than in the app);
 *   - the wiring statics: DexSwapSection quotes via
 *     fetchBestRoute, re-quotes before signing, approves the
 *     router only when short, builds the swap with
 *     buildSwapTx, holds the QL1 gas keep back on native
 *     QOM, and shows the honest no-pool note with the swap
 *     disabled when there is no route;
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

const DEX_IDS = ['native', 'o', 'qcaw', 'ket', 'hawk', 'phoenix'];
const PROBES = {
  native: 10n,
  o: 10n,
  qcaw: 1000000n,
  ket: 10n,
  hawk: 100n,
  phoenix: 10n,
};
const E18 = 10n ** 18n;

/* ---------- the six tokens ---------- */
{
  for (const id of DEX_IDS) {
    ok(AGG.tokenById('ql1', id) !== null, `engine table: '${id}' exists on QL1`);
  }
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
    `live quotes: all ${total} ordered pairs route at probe amounts (${routed}/${total})`,
  );
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
    'DEX section offers ONLY the six tokens',
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
