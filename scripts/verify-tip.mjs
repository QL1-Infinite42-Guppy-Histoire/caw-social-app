#!/usr/bin/env node
/**
 * Tip （チップ) verification (v0.5.0; currency changes
 * v0.7.0 and v0.7.8).
 *
 * A tip is deliberately JUST a plain token transfer to the
 * post author's owner address — no marker, no counting.
 * Through v0.6.7 the token was CAT42 on 42 Chain; in
 * v0.7.0–v0.7.7 it was PHOENIX on QL1; since v0.7.8 (user
 * decision 2026-11-19) it is HAWK on QL1. Because a tip
 * has no marker, past PHOENIX/CAT42 tips need nothing:
 * there is no tip detection or display to migrate, and
 * PHOENIX stays live in HuntersDEX, the wallet display
 * and BurnHawk. This suite pins: the presets
 * (1,000 / 5,000 / 10,000 HAWK — DECIDED by the user
 * 2026-11-19, the same value steps as 10 / 50 / 100
 * PHOENIX at the 100:1 burnToMint anchor, kept in the
 * one TIP_PRESETS constant),
 * the custom amount parsing, the 25 / 50 / 75 / MAX balance
 * chips, the plainness of the calldata (a tip must never
 * parse as a marked burn of any kind), the self-tip and
 * shortfall guards, and the wiring statics for performTip +
 * the three surfaces (feed, profile, post detail) + the
 * TipSheet (which is fed the HAWK balance).
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
    JSON.stringify(TIP.TIP_PRESETS) === '[1000,5000,10000]',
    'presets are 1,000 / 5,000 / 10,000 HAWK (user-decided 2026-11-19)',
  );
  ok(TIP.tipPresetRaw(1000) === 1000n * E18, 'preset raw: 1,000 HAWK');
  ok(TIP.tipPresetRaw(10000) === 10000n * E18, 'preset raw: 10,000 HAWK');
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
    CFG.HAWK === '0xbC85F14059d60458b614052b4a84734E463878cc',
    'tips move HAWK on QL1 (the plain ERC-20, no burn function)',
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
  ok(TIP.tipShortfall(10001n * E18, 10000n * E18) === false, 'shortfall: a balance above the biggest preset (10,000) covers it');
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
  ok(flow.includes('hawkBalanceOf'), 'performTip: fresh HAWK balance read');
  ok(
    flow.includes('signerFor(secret.kind, secret.secret)') &&
      flow.includes('HAWK') &&
      !flow.includes('PHOENIX') &&
      !flow.includes('signerForHsChain'),
    'performTip: signs on QL1 (HAWK lives there), sends to the HAWK contract, no PHOENIX left in the flow',
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
    ui.includes('TIP_PRESETS') && ui.includes('tipChipAmount') &&
      ui.includes("toLocaleString('en-US')") && ui.includes('HAWK'),
    'TipSheet uses the presets and the balance chips, labelled in HAWK with grouped amounts',
  );
  ok(ui.includes('onTip'), 'PostCard exposes the tip action');
  for (const [file, label, needle] of [
    ['src/screens/TimelineScreen.tsx', 'TimelineScreen', 'balanceRaw={hawk ? hawk.raw : null}'],
    ['src/screens/ProfileScreen.tsx', 'ProfileScreen', 'balanceRaw={app.hawk ? app.hawk.raw : null}'],
    ['src/screens/PostDetailScreen.tsx', 'PostDetailScreen', 'balanceRaw={app.hawk ? app.hawk.raw : null}'],
  ]) {
    const s = readFileSync(ROOT + '/' + file, 'utf8');
    ok(
      s.includes(needle) &&
        !s.includes('balanceRaw={app.phoenix') &&
        !s.includes('balanceRaw={phoenix'),
      `${label} feeds the TipSheet the HAWK balance (not PHOENIX)`,
    );
  }
}

/* ---------- M1: recipient cross-check + sheet display
 * (v0.5.0-fix) ---------- */
{
  const OTHER = '0x000000000000000000000000000000000000dEaD';
  ok(
    TIP.tipRecipientVerdict(AUTHOR, AUTHOR) === 'ok' &&
      TIP.tipRecipientVerdict(AUTHOR, AUTHOR.toLowerCase()) === 'ok',
    'M1 verdict: both endpoints agree (case-insensitive) → ok',
  );
  ok(
    TIP.tipRecipientVerdict(AUTHOR, null) === 'primary',
    'M1 verdict: an unreachable second endpoint leaves the primary resolution standing',
  );
  ok(
    TIP.tipRecipientVerdict(AUTHOR, OTHER) === 'mismatch',
    'M1 verdict: two different answers → mismatch (the tip must be refused)',
  );
  ok(
    CFG.RPC_ALT && CFG.RPC_ALT !== CFG.RPC,
    'M1: the cross-check endpoint is configured and distinct from the primary RPC',
  );

  const CAW = await import(OUT + '/lib/cawApi.js');
  const enc = (addr) => '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase();
  const realFetch = globalThis.fetch;
  try {
    // Both endpoints answer; the ALT one is stubbed to a
    // DIFFERENT owner — the composition performTip uses must
    // yield 'mismatch' (a hard stop before any signing).
    globalThis.fetch = async (url) => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        result: enc(String(url).includes('scan.qom.network') ? OTHER : AUTHOR),
      }),
    });
    const primary = await CAW.nameOwner(190n);
    const alt = await CAW.nameOwnerAlt(190n).catch(() => null);
    ok(
      primary.toLowerCase() === AUTHOR.toLowerCase() &&
        alt !== null &&
        alt.toLowerCase() === OTHER.toLowerCase() &&
        TIP.tipRecipientVerdict(primary, alt) === 'mismatch',
      'M1: a disagreeing second endpoint produces the hard-stop verdict (stubbed RPCs)',
    );
    // The second endpoint down: the read rejects, the
    // catch-to-null composition yields 'primary'.
    globalThis.fetch = async (url) => {
      if (String(url).includes('scan.qom.network')) throw new Error('down');
      return {
        ok: true,
        json: async () => ({ jsonrpc: '2.0', result: enc(AUTHOR) }),
      };
    };
    const altDown = await CAW.nameOwnerAlt(190n).catch(() => null);
    ok(
      altDown === null && TIP.tipRecipientVerdict(AUTHOR, altDown) === 'primary',
      'M1: a failed cross-check read degrades to the primary verdict, never to a fake agreement',
    );
    /* L1: qCAW reads follow the null discipline. */
    globalThis.fetch = async () => { throw new Error('down'); };
    ok(
      (await CAW.qcawBalance(AUTHOR)) === null &&
        (await CAW.qcawAllowance(AUTHOR, AUTHOR)) === null,
      'L1: failed qCAW balance/allowance reads resolve null — never a fake 0',
    );
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        result: '0x' + (1000n).toString(16).padStart(64, '0'),
      }),
    });
    ok(
      (await CAW.qcawBalance(AUTHOR)) === 1000n &&
        (await CAW.qcawAllowance(AUTHOR, AUTHOR)) === 1000n,
      'L1: healthy qCAW reads still resolve their real values',
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  const flowAll = readFileSync(ROOT + '/src/lib/actionFlow.ts', 'utf8');
  const flow = flowAll.slice(flowAll.indexOf('export async function performTip'));
  const iMismatch = flow.indexOf("Error('recipient-mismatch')");
  const iSend = flow.indexOf('sendCalldata');
  ok(
    flow.includes('nameOwnerAlt') && iMismatch > 0 && iMismatch < iSend,
    'M1 wiring: performTip cross-checks via the second endpoint and refuses BEFORE the send on disagreement',
  );
  const ui = readFileSync(ROOT + '/src/components/ui.tsx', 'utf8');
  ok(
    ui.includes('recipient?: string | null') &&
      ui.includes("tr('tip.to')") &&
      ui.includes('recipient.slice(-4)'),
    'M1 wiring: the TipSheet shows the resolved recipient with the last-4 emphasis',
  );
  for (const [file, label] of [
    ['src/screens/TimelineScreen.tsx', 'TimelineScreen'],
    ['src/screens/ProfileScreen.tsx', 'ProfileScreen'],
    ['src/screens/PostDetailScreen.tsx', 'PostDetailScreen'],
  ]) {
    const s = readFileSync(ROOT + '/' + file, 'utf8');
    ok(
      s.includes('recipient={tipRecipient}') && s.includes("tr('tip.mismatch')"),
      `M1 wiring: ${label} passes the recipient to the sheet and surfaces the mismatch stop`,
    );
  }
}

console.log(`\ntip: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
