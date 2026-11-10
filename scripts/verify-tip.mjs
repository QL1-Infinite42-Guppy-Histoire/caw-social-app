#!/usr/bin/env node
/**
 * Tip （チップ) verification (v0.5.0).
 *
 * A tip is deliberately JUST a plain CAT42 transfer to the
 * post author's owner address — no marker, no counting
 * (SuperLike moved to O burns; CAT42's one job is now tips).
 * This suite pins: the presets (10 / 50 / 100), the custom
 * amount parsing, the 25 / 50 / 75 / MAX balance chips, the
 * plainness of the calldata (a tip must never parse as a
 * marked burn of any kind), the self-tip and shortfall
 * guards, and the wiring statics for performTip + the three
 * surfaces (feed, profile, post detail) + the TipSheet.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = ROOT + '/scripts/.build-tip';
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
      'src/lib/chains.ts',
      'src/lib/cawApi.ts',
      'src/lib/markedBurns.ts',
      'src/lib/superlike.ts',
      'src/lib/tip.ts',
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
  ok(true, 'tsc compiles the tip graph');
} catch (e) {
  ok(false, 'tsc: ' + (e.stdout || '').toString().slice(0, 400));
  process.exit(1);
}
writeFileSync(OUT + '/package.json', '{"type":"commonjs"}');

const TIP = await import(OUT + '/lib/tip.js');
const MB = await import(OUT + '/lib/markedBurns.js');
const SL = await import(OUT + '/lib/superlike.js');
const CFG = await import(OUT + '/config.js');

const AUTHOR = '0x0Cdd1EbbBCb55601b207B384245dDe646882b86B';
const E18 = 10n ** 18n;

/* ---------- presets, parsing, chips ---------- */
{
  ok(
    JSON.stringify(TIP.TIP_PRESETS_CAT42) === '[10,50,100]',
    'presets are 10 / 50 / 100 CAT42',
  );
  ok(TIP.tipPresetRaw(10) === 10n * E18, 'preset raw: 10 CAT42');
  ok(TIP.tipPresetRaw(100) === 100n * E18, 'preset raw: 100 CAT42');
  ok(TIP.parseTipAmount('10') === 10n * E18, 'parse: whole amount');
  ok(TIP.parseTipAmount('0.5') === E18 / 2n, 'parse: fractional amount');
  ok(TIP.parseTipAmount('0') === null, 'parse: zero refused');
  ok(TIP.parseTipAmount('') === null, 'parse: empty refused');
  ok(TIP.parseTipAmount('abc') === null, 'parse: garbage refused');
  ok(TIP.parseTipAmount('-5') === null, 'parse: negative refused');
  const bal = 1000n * E18;
  ok(TIP.tipChipAmount(bal, 25) === 250n * E18, 'chip: 25% of the balance');
  ok(TIP.tipChipAmount(bal, 50) === 500n * E18, 'chip: 50% of the balance');
  ok(TIP.tipChipAmount(bal, 75) === 750n * E18, 'chip: 75% of the balance');
  ok(TIP.tipChipAmount(bal, 100) === bal, 'chip: MAX is the whole balance');
  ok(
    TIP.tipChipAmount(101n, 25) === 25n,
    'chip: fractional results floor (101 raw at 25% = 25)',
  );
}

/* ---------- the calldata is PLAIN ---------- */
{
  const data = TIP.buildTipData(AUTHOR, 50n * E18);
  ok((data.length - 2) / 2 === 68, 'tip calldata is a plain 68-byte transfer (no marker)');
  ok(data.startsWith('0xa9059cbb'), 'tip starts with the transfer selector');
  ok(
    '0x' + data.slice(34, 74) === '0x' + AUTHOR.slice(2).toLowerCase(),
    'tip recipient is the author owner',
  );
  ok(BigInt('0x' + data.slice(74, 138)) === 50n * E18, 'tip amount word survives');
  ok(
    MB.parseMarkedBurnInput(data) === null,
    'a tip NEVER parses as a marked burn',
  );
  ok(SL.parseSuperlikeInput(data) === null, 'a tip is never a SuperLike');
  ok(
    CFG.CAT42 === '0x7386719EBbBeB4d810fF89027Bfb8A1CDf696310',
    'tips move CAT42 on 42 Chain',
  );
}

/* ---------- guards ---------- */
{
  const me = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC';
  ok(
    TIP.tipBlockReason({
      senderId: 5n,
      myTokenIds: [3n, 5n],
      authorOwner: AUTHOR,
      myAddress: me,
    }) === 'self',
    'guard: tipping my own name’s post blocked',
  );
  ok(
    TIP.tipBlockReason({
      senderId: 9n,
      myTokenIds: [3n],
      authorOwner: me.toUpperCase().replace('0X', '0x'),
      myAddress: me,
    }) === 'self',
    'guard: author owner == my address blocked (case-insensitive)',
  );
  ok(
    TIP.tipBlockReason({
      senderId: 9n,
      myTokenIds: [3n],
      authorOwner: AUTHOR,
      myAddress: me,
    }) === null,
    'guard: tipping someone else allowed',
  );
  ok(TIP.tipShortfall(49n * E18, 50n * E18) === true, 'shortfall: balance below the tip');
  ok(TIP.tipShortfall(50n * E18, 50n * E18) === false, 'shortfall: exact balance ok');
  ok(TIP.tipShortfall(101156n * E18 / 100n, 100n * E18) === false, 'shortfall: the f8cc balance (1,011.56) covers the biggest preset');
}

/* ---------- wiring statics ---------- */
{
  const flowAll = readFileSync(ROOT + '/src/lib/actionFlow.ts', 'utf8');
  const flow = flowAll.slice(flowAll.indexOf('export async function performTip'));
  const iSelf = flow.indexOf("Error('self-tip')");
  const iShort = flow.indexOf("Error('shortfall')");
  const iSend = flow.indexOf('sendCalldata');
  ok(iSelf > 0 && iSelf < iSend, 'performTip: self block precedes the send');
  ok(iShort > 0 && iShort < iSend, 'performTip: shortfall stop precedes the send');
  ok(flow.includes('nameOwner'), 'performTip: author owner resolved fresh');
  ok(flow.includes('cat42BalanceOf'), 'performTip: fresh CAT42 balance read');
  ok(
    flow.includes("signerForHsChain(secret.kind, secret.secret, 'infinite')"),
    'performTip: signs on 42 Chain',
  );
  ok(flow.includes('buildTipData(authorOwner'), 'performTip: pays the author owner');
  ok(
    !flow.includes('buildSuperlikeData') && !flow.includes('buildMarkedBurnData'),
    'performTip: no marker is ever attached',
  );
  ok(flow.includes("Error('bad-amount')"), 'performTip: non-positive amounts refused');
  for (const [file, label] of [
    ['src/screens/TimelineScreen.tsx', 'TimelineScreen'],
    ['src/screens/ProfileScreen.tsx', 'ProfileScreen'],
    ['src/screens/PostDetailScreen.tsx', 'PostDetailScreen'],
  ]) {
    const s = readFileSync(ROOT + '/' + file, 'utf8');
    ok(
      s.includes('performTip') && s.includes('onTip={handleTip}') &&
        s.includes('TipSheet'),
      `${label} wires the tip (handler + sheet)`,
    );
    ok(s.includes("tr('tip.shortfall')") || s.includes("tr('tip.self')"),
       `${label} surfaces the tip guards`);
  }
  const ui = readFileSync(ROOT + '/src/components/ui.tsx', 'utf8');
  ok(ui.includes('export function TipSheet'), 'ui.tsx exports the TipSheet');
  ok(
    ui.includes('TIP_PRESETS_CAT42') && ui.includes('tipChipAmount'),
    'TipSheet uses the presets and the balance chips',
  );
  ok(ui.includes('onTip'), 'PostCard exposes the tip action');
}

console.log(`\ntip: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
