/* Verification for the v0.7.1 feed-swipe fix.
 *
 * Field report (user, 2026-11-18, on the v0.7.0 release build):
 * swiping left/right on Home does not switch Latest ⇄ Following.
 *
 * Isolation, before any fix:
 *  - the swipe code IS in the shipped commit (20f8c8c) — not a
 *    build omission;
 *  - the Following feed is wired (same FlatList, mode-switched
 *    data + loader) — not an empty-target problem;
 *  - NO verify script exercised the swipe at all in v0.7.0.
 *
 * This harness first REPRODUCES the fault with v0.7.0's exact
 * decision code (touch start/end pageX diff, |dx| >= 60 and
 * |dx| >= 1.6|dy|) fed the touch sequences a device delivers for
 * a horizontal flick over a scrolling list:
 *  (S1) the native scroller claims the gesture -> JS receives a
 *       touch CANCEL, never an end -> the old handler never even
 *       evaluates. ** reproduces the symptom **
 *  (S2) the end event arrives with unmoved coordinates (the
 *       scroller owned the gesture; the end JS sees carries the
 *       start point) -> dx = 0 -> no switch. ** reproduces **
 *  (S3) a clean start/end pair with real travel -> the old code
 *       DOES switch — the math was right; the delivery was not.
 *
 * Then it validates the v0.7.1 mechanism — a PanResponder whose
 * capture-phase claim + release decision run the REAL functions
 * from src/lib/feedSwipe.ts — against the same physical flicks
 * expressed as move streams (gestureState accumulation, which is
 * what PanResponder tracks on device):
 *  (a) left flick (LTR) claims mid-gesture and releases to
 *      'following'; (b) right flick releases to 'latest';
 *  (c) a vertical scroll never claims; (d) a diagonal scroll
 *      never claims; (e) a tap never claims; (f) RTL inverts;
 *  (g) a claimed-but-short drag (< 60px total) switches nothing.
 *
 * Finally it pins the wiring in TimelineScreen.tsx: PanResponder
 * + feedSwipe in use, panHandlers spread on every render branch's
 * root, and no onTouchStart/onTouchEnd left on the FlatList.
 *
 * No keys, no sends, no network. Run: node scripts/verify-swipe.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname;
const BUILD = new URL('./.build-swipe', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

/* ---- v0.7.0's decision, copied verbatim from the shipped code ---- */
function makeOldHandler(isRTL) {
  let start = null;
  let mode = 'latest';
  return {
    touchStart(x, y) { start = { x, y }; },
    touchEnd(x, y) {
      const s = start; start = null;
      if (!s) return;
      const dx = x - s.x, dy = y - s.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
      const toFollowing = isRTL ? dx > 0 : dx < 0;
      mode = toFollowing ? 'following' : 'latest';
    },
    touchCancel() { /* v0.7.0 registered no cancel handler */ },
    get mode() { return mode; },
  };
}

/* S1: scroller claims -> cancel, no end */
{
  const h = makeOldHandler(false);
  h.touchStart(500, 800);
  h.touchCancel();
  check('S1 old: cancel instead of end -> no switch (fault reproduced)', h.mode === 'latest');
}
/* S2: end arrives with unmoved coordinates */
{
  const h = makeOldHandler(false);
  h.touchStart(500, 800);
  h.touchEnd(500, 800);
  check('S2 old: end with start coords (dx=0) -> no switch (fault reproduced)', h.mode === 'latest');
}
/* S3: clean delivery switches — math was right */
{
  const h = makeOldHandler(false);
  h.touchStart(500, 800);
  h.touchEnd(310, 815);
  check('S3 old: clean end with real travel -> switches', h.mode === 'following');
}

/* ---- build the real module under test ---- */
execFileSync(
  'npx',
  ['tsc', '--ignoreConfig', 'src/lib/feedSwipe.ts',
   '--module', 'commonjs', '--target', 'es2022',
   '--outDir', BUILD, '--skipLibCheck'],
  { cwd: ROOT, stdio: 'inherit' },
);
const swipe = require(BUILD + '/feedSwipe.js');

/* Simulate PanResponder: moves arrive as cumulative (dx, dy);
 * the first move where swipeShouldClaim is true claims the
 * gesture; on release, swipeTargetMode decides. */
function runGesture(moves, isRTL) {
  let claimedAt = -1;
  for (let i = 0; i < moves.length; i++) {
    if (swipe.swipeShouldClaim(moves[i][0], moves[i][1])) { claimedAt = i; break; }
  }
  if (claimedAt < 0) return { claimedAt, target: null };
  const [dx] = moves[moves.length - 1];
  return { claimedAt, target: swipe.swipeTargetMode(dx, isRTL) };
}
const flick = (dxTotal, dyTotal, steps = 6) =>
  Array.from({ length: steps }, (_, i) => [dxTotal * (i + 1) / steps, dyTotal * (i + 1) / steps]);

{
  const r = runGesture(flick(-180, 12), false);
  check('(a) left flick claims and releases to following', r.claimedAt >= 0 && r.target === 'following', 'claimedAt=' + r.claimedAt);
}
{
  const r = runGesture(flick(170, -8), false);
  check('(b) right flick claims and releases to latest', r.claimedAt >= 0 && r.target === 'latest');
}
{
  const r = runGesture(flick(8, -320), false);
  check('(c) vertical scroll never claims', r.claimedAt === -1 && r.target === null);
}
{
  const r = runGesture(flick(60, -210), false);
  check('(d) diagonal scroll never claims', r.claimedAt === -1 && r.target === null);
}
{
  const r = runGesture(flick(2, 3, 2), false);
  check('(e) tap never claims', r.claimedAt === -1 && r.target === null);
}
{
  const r = runGesture(flick(-180, 10), true);
  check('(f) RTL: left flick releases to latest (inverted)', r.claimedAt >= 0 && r.target === 'latest');
}
{
  /* claims at >24px but ends at 45px total: below the switch bar */
  const r = runGesture(flick(-45, 4), false);
  check('(g) claimed but short (<60px) switches nothing', r.claimedAt >= 0 && r.target === null);
}

/* ---- wiring pins in TimelineScreen.tsx ---- */
const tl = readFileSync(ROOT + 'src/screens/TimelineScreen.tsx', 'utf8');
check('wiring: PanResponder created from feedSwipe decisions',
  tl.includes('PanResponder.create') && tl.includes("from '../lib/feedSwipe'") &&
  tl.includes('swipeShouldClaim') && tl.includes('swipeTargetMode'));
check('wiring: capture-phase claim + no termination yield',
  tl.includes('onMoveShouldSetPanResponderCapture') && tl.includes('onPanResponderTerminationRequest'));
check('wiring: panHandlers on all three render roots',
  (tl.match(/\{\.\.\.feedPanHandlers\}/g) || []).length === 3);
check('wiring: old touch handlers gone from the FlatList',
  !tl.includes('onFeedTouchStart') && !tl.includes('onFeedTouchEnd') &&
  !/FlatList[\s\S]{0,400}?onTouchEnd/.test(tl));

console.log('\nverify-swipe: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
