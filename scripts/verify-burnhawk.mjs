#!/usr/bin/env node
/**
 * BurnHawk verification (v0.7.0).
 *
 * The in-app HAWK burn: PHOENIX's burnToMint(uint256) burns
 * the caller's QL1 HAWK and mints PHOENIX at exactly 100:1
 * (verified from real transactions on 2026-11-18; the same
 * flow as the standalone site hawk.qql1.com). This suite
 * pins the pure money rules in lib/burnHawk.ts:
 *   - amounts round DOWN to a multiple of 100 HAWK;
 *   - the receive preview is burn / 100, re-based exactly;
 *   - burnToMint calldata: selector 0x05737aae + one word;
 *   - the approve calldata targets the PHOENIX contract as
 *     spender on the HAWK token, exact amount;
 *   - the allowance gate (approve only when short);
 *   - the allowance read against a stubbed RPC;
 * and the wiring statics: the screen sends approve (only if
 * short) before burnToMint via the app wallet, and the
 * drawer row sits between HuntersDEX and ブックマーク.
 * No keys, no real sends.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = ROOT + '/scripts/.build-burnhawk';
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
      'src/lib/cawApi.ts',
      'src/lib/burnHawk.ts',
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
  ok(true, 'tsc compiles the burnHawk graph');
} catch (e) {
  ok(false, 'tsc: ' + (e.stdout || '').toString().slice(0, 400));
  process.exit(1);
}
writeFileSync(OUT + '/package.json', '{"type":"commonjs"}');

const BH = await import(OUT + '/lib/burnHawk.js');
const CFG = await import(OUT + '/config.js');

const E18 = 10n ** 18n;
const H = (n) => BigInt(n) * E18;

/* ---------- rounding + receive ---------- */
{
  ok(BH.roundDownBurnRaw(H(27500), 18) === H(27500), 'round: an exact multiple stays');
  ok(BH.roundDownBurnRaw(H(27549), 18) === H(27500), 'round: 27,549 -> 27,500 (down to a multiple of 100)');
  ok(BH.roundDownBurnRaw(H(100), 18) === H(100), 'round: the 100 minimum stays');
  ok(BH.roundDownBurnRaw(H(99), 18) === 0n, 'round: below 100 rounds to 0 (refused as too small)');
  ok(BH.roundDownBurnRaw(0n, 18) === 0n, 'round: zero stays zero');
  ok(BH.roundDownBurnRaw(H(27500) + 1n, 18) === H(27500), 'round: raw dust below the step is dropped');
  ok(BH.receiveRawFor(H(27500), 18, 18) === H(275), 'receive: 27,500 HAWK -> 275 PHOENIX (the first real burn\u2019s shape)');
  ok(BH.receiveRawFor(H(100), 18, 18) === H(1), 'receive: 100 HAWK -> 1 PHOENIX');
  ok(BH.receiveRawFor(0n, 18, 18) === 0n, 'receive: zero in, zero out');
}

/* ---------- calldata ---------- */
{
  const data = BH.buildBurnToMintData(H(27500));
  ok(data.startsWith('0x05737aae'), 'burnToMint: selector 0x05737aae');
  ok((data.length - 2) / 2 === 36, 'burnToMint: 36 bytes (selector + one word)');
  ok(BigInt('0x' + data.slice(10)) === H(27500), 'burnToMint: the amount word survives');
  const ap = BH.buildApproveData(CFG.PHOENIX, H(27500));
  ok(ap.startsWith('0x095ea7b3'), 'approve: the ERC-20 approve selector');
  ok(
    '0x' + ap.slice(34, 74) === '0x' + CFG.PHOENIX.slice(2).toLowerCase(),
    'approve: the spender is the PHOENIX contract',
  );
  ok(BigInt('0x' + ap.slice(74, 138)) === H(27500), 'approve: the exact burn amount');
  ok(
    BH.BURN_SPENDER === CFG.PHOENIX && BH.BURN_TOKEN === CFG.HAWK,
    'the burn token is QL1 HAWK and the spender is the PHOENIX contract',
  );
  ok(
    CFG.PHOENIX === '0xDFe660C5a29c8AADF1daA096543D249135e1938A' &&
      CFG.HAWK === '0xbC85F14059d60458b614052b4a84734E463878cc',
    'config: the verified QL1 PHOENIX / HAWK contracts',
  );
}

/* ---------- allowance gate + read ---------- */
{
  ok(BH.allowanceCovers(H(27500), H(27500)) === true, 'gate: an exact allowance covers');
  ok(BH.allowanceCovers(H(27600), H(27500)) === true, 'gate: a larger allowance covers');
  ok(BH.allowanceCovers(H(27400), H(27500)) === false, 'gate: a short allowance does not cover (approve first)');
  const OWNER = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC';
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        result: '0x' + H(123).toString(16).padStart(64, '0'),
      }),
    });
    ok(
      (await BH.hawkAllowanceForPhoenix(OWNER)) === H(123),
      'allowance read resolves the stubbed value',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ---------- wiring statics ---------- */
{
  const screenAll = readFileSync(ROOT + '/src/screens/BurnHawkScreen.tsx', 'utf8');
  const screen = screenAll.slice(screenAll.indexOf('const doBurn'));
  const iAllow = screen.indexOf('hawkAllowanceForPhoenix');
  const iApprove = screen.indexOf('buildApproveData');
  const iBurn = screen.indexOf('buildBurnToMintData');
  ok(
    iAllow > 0 && iApprove > iAllow && iBurn > iApprove,
    'screen order: allowance read -> approve (if short) -> burnToMint',
  );
  ok(
    screen.includes('allowanceCovers(allowance, effective)') &&
      screenAll.includes('roundDownBurnRaw') &&
      screenAll.includes('receiveRawFor') &&
      screen.includes('sendTxReq'),
    'screen: the send runs through the lib rules + the app wallet',
  );
  ok(
    screenAll.includes('CHIP_PCTS') && screenAll.includes('25') && screenAll.includes("'MAX'"),
    'screen: the 25 / 50 / 75 / MAX amount chips',
  );
  const drawer = readFileSync(ROOT + '/src/components/Drawer.tsx', 'utf8');
  const iDex = drawer.indexOf('label="HuntersDEX"');
  const iBh = drawer.indexOf("tr('bh.title')");
  const iBm = drawer.indexOf("tr('bm.title')");
  ok(
    iDex > 0 && iBh > iDex && iBm > iBh,
    'drawer: BurnHawk sits between HuntersDEX and bookmarks',
  );
  ok(drawer.includes('<BurnHawkModal'), 'drawer: the BurnHawk modal is mounted');
}

console.log(`\nburnhawk: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
