/* RTL restart-notice decision checks (v0.3.10).
 * Run: node scripts/verify-rtl.mjs
 *
 * The restart notice ("close and reopen the app once…") must fire
 * exactly once per pending-direction change, not on every
 * cross-boundary switch. applyLayoutDirection itself cannot run
 * outside React Native (it calls I18nManager), so this script
 * extracts the pure decision function wantsRestartNotice() from
 * src/lib/rtl.ts and simulates switch sequences through it the
 * same way applyLayoutDirection does (pending := last want).
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(
  new URL('../src/lib/rtl.ts', import.meta.url),
  'utf8',
);

const m = src.match(
  /export function wantsRestartNotice\([\s\S]*?\n\}/,
);
if (!m) {
  console.log('FAIL wantsRestartNotice not found in src/lib/rtl.ts');
  process.exit(1);
}
const body = m[0]
  .replace('export function', 'function')
  .replace(/: boolean/g, '');
const wantsRestartNotice = new Function(
  body + '\nreturn wantsRestartNotice;',
)();

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

/* Simulate a session booted in direction `boot`, then switching
 * through `wants` (true = an RTL language, false = LTR). Mirrors
 * applyLayoutDirection: boot sets pending = session = boot. */
function simulate(boot, wants) {
  let pending = boot;
  return wants.map((want) => {
    const notice = wantsRestartNotice(want, boot, pending);
    pending = want;
    return notice;
  });
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Boot LTR — same-direction switches never notify.
check(
  'boot LTR: en->ja no notice',
  eq(simulate(false, [false, false]), [false, false]),
);
// Boot LTR — crossing to fa notifies once; coming back is silent.
check(
  'boot LTR: ja->fa notice, fa->ko no repeat',
  eq(simulate(false, [false, true, false]), [false, true, false]),
);
// Boot RTL — the v0.3.9 bug: fa->en notified, then en->ja too.
check(
  'boot RTL: fa->en notice, en->ja NO notice',
  eq(simulate(true, [false, false]), [true, false]),
);
// Boot RTL — wandering LTR languages stays silent after the one
// notice; returning to fa (the session direction) is silent too.
check(
  'boot RTL: fa->en notice, en->ja->ko silent, back to fa silent',
  eq(simulate(true, [false, false, false, true]), [true, false, false, false]),
);
// Boot LTR — re-crossing after settling back notifies again
// (it is a NEW pending-direction change).
check(
  'boot LTR: fa notice, back to ja silent, fa again notice',
  eq(simulate(false, [true, false, true]), [true, false, true]),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
