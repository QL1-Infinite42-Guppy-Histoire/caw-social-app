/* Verification for the v0.1.1 fixes. Run: node scripts/verify-fixes.mjs
 *
 * Bug 1 (likes/shares never lit up): the on-device MyActionStore —
 *   optimistic set, persistence across a simulated restart, seeding
 *   from observed feed actions, per-acting-name keying.
 * Bug 2 (post content missing): decodeActions must reproduce EVERY
 *   action of every corpus batch (not just the first); live —
 *   fetchProfilePosts must actually find a quiet name's actions
 *   (measured before the fix: name #189 → 0 found, first hit on feed
 *   page 21) and findPostByCawId must locate a share's target post.
 * Bug 3 (profile pages wrong/unreachable): live — resolveName and
 *   tokensOf must agree with the tokens' CARDS (tokenURI names,
 *   which match the mint records; the chain's usernames() mapping
 *   is the shifted one — #189 is "dreamin", not the "neptune" that
 *   usernames(189) returns), and name → id → name must round-trip.
 * Profile customization (off-chain): ProfileCustomStore merge,
 *   persistence across a simulated restart, clear, and the
 *   unset-fallback label logic.
 *
 * No keys, no sends — reads and local logic only.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BUILD = new URL('./.build-fixes', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

/* ---- build the modules under test ---- */
execFileSync(
  'npx',
  [
    'tsc', '--ignoreConfig',
    'src/config.ts', 'src/lib/cawCore.ts', 'src/lib/cawApi.ts',
    'src/lib/myActions.ts', 'src/lib/profileCustom.ts',
    '--outDir', BUILD, '--module', 'commonjs', '--target', 'es2022',
    '--esModuleInterop', '--skipLibCheck',
  ],
  { stdio: 'inherit', cwd: new URL('..', import.meta.url).pathname },
);
const core = require(BUILD + '/lib/cawCore.js');
const api = require(BUILD + '/lib/cawApi.js');
const { MyActionStore } = require(BUILD + '/lib/myActions.js');
const {
  ProfileCustomStore, hasCustom, displayLabel,
} = require(BUILD + '/lib/profileCustom.js');

/* ---- fake on-device storage ---- */
function fakeKV() {
  const m = new Map();
  return {
    getItem: async (k) => (m.has(k) ? m.get(k) : null),
    setItem: async (k, v) => { m.set(k, v); },
  };
}

/* ================= Bug 1: MyActionStore ================= */
{
  const kv = fakeKV();
  const addr = '0x75bb70588b1de571487c4e6dd62546765b7c55e2';
  const post = { cawId: '0xABC' };
  const s1 = new MyActionStore();
  await s1.init(kv, addr);
  check('myactions: nothing lit before any action', !s1.has(1, 189n, post.cawId));
  await s1.set(1, 189n, post.cawId, true);
  check('myactions: like lights up after set', s1.has(1, 189n, post.cawId));
  check('myactions: like is per acting name', !s1.has(1, 190n, post.cawId));
  check('myactions: like does not light the share button', !s1.has(2, 189n, post.cawId));
  await s1.set(3, 189n, '42', true);
  check('myactions: follow remembered separately', s1.has(3, 189n, '42') && !s1.has(3, 189n, '43'));

  // simulated restart: a fresh store over the same storage
  const s2 = new MyActionStore();
  await s2.init(kv, addr);
  check('myactions: like survives restart', s2.has(1, 189n, post.cawId));
  check('myactions: follow survives restart', s2.has(3, 189n, '42'));
  const s3 = new MyActionStore();
  await s3.init(kv, '0x0000000000000000000000000000000000000001');
  check('myactions: another wallet sees none of it', !s3.has(1, 189n, post.cawId));

  // undo works and persists
  await s2.set(1, 189n, post.cawId, false);
  const s4 = new MyActionStore();
  await s4.init(kv, addr);
  check('myactions: undo persists', !s4.has(1, 189n, post.cawId));

  // feed seeding: only own names' actions are remembered
  s4.registerOwnIds([189n]);
  s4.observe({ type: 2, senderId: 189n, receiverId: 7n, cawId: '0xDEF' });
  s4.observe({ type: 1, senderId: 555n, receiverId: 7n, cawId: '0x999' });
  check('myactions: own share seeded from feed', s4.has(2, 189n, '0xDEF'));
  check('myactions: stranger action not seeded', !s4.has(1, 555n, '0x999'));
}

/* ================= ProfileCustomStore ================= */
{
  const kv = fakeKV();
  const c1 = new ProfileCustomStore();
  await c1.init(kv);
  check('custom: unset name has no custom look', !hasCustom(c1.get(189n)));
  check('custom: unset label falls back to @name', displayLabel(c1.get(189n), 'neptune') === '@neptune');
  await c1.set(189n, { displayName: 'Nepi' });
  await c1.set(189n, { avatarPath: 'file:///docs/profile-images/189-avatar.jpg' });
  const merged = c1.get(189n);
  check('custom: patches merge', !!merged && merged.displayName === 'Nepi' && !!merged.avatarPath);
  check('custom: label prefers display name', displayLabel(merged, 'neptune') === 'Nepi');

  const c2 = new ProfileCustomStore();
  await c2.init(kv);
  const after = c2.get(189n);
  check('custom: survives restart', !!after && after.displayName === 'Nepi' && after.avatarPath === merged.avatarPath);
  check('custom: other names untouched', !hasCustom(c2.get(190n)));

  await c2.set(189n, { displayName: '' });
  check('custom: empty display name removes just that field',
    !!c2.get(189n) && !c2.get(189n).displayName && !!c2.get(189n).avatarPath);
  await c2.clear(189n);
  const c3 = new ProfileCustomStore();
  await c3.init(kv);
  check('custom: clear persists across restart', !hasCustom(c3.get(189n)));

  // Bio (v0.4.5): per-name text in the same device-local store.
  await c3.set(189n, { bio: 'Guide collector. QL1 / 42.' });
  const withBio = c3.get(189n);
  check('custom: bio sets and counts as a customization',
    !!withBio && withBio.bio === 'Guide collector. QL1 / 42.' && hasCustom(withBio));
  check('custom: bio is per-name', !hasCustom(c3.get(190n)));
  const c4 = new ProfileCustomStore();
  await c4.init(kv);
  check('custom: bio survives restart',
    !!c4.get(189n) && c4.get(189n).bio === 'Guide collector. QL1 / 42.');
  await c4.set(189n, { displayName: 'Nepi' });
  await c4.set(189n, { bio: '' });
  check('custom: empty bio removes just the bio',
    !!c4.get(189n) && !c4.get(189n).bio && c4.get(189n).displayName === 'Nepi');
  await c4.clear(189n);
  check('custom: clear removes the bio too', !hasCustom(c4.get(189n)));
}

/* ================= Bug 2a: full-batch decoding on the corpus ================= */
const corpusPath =
  process.env.CAW_CORPUS || '/home/hatch/workspace/.scratch-caw/work/txs.json';
if (!existsSync(corpusPath)) {
  console.log('SKIP corpus decode check (file not found: ' + corpusPath + ')');
} else {
  const txs = JSON.parse(readFileSync(corpusPath, 'utf8'));
  function parseAll(raw) {
    const body = raw.slice(10);
    const word = (i) => body.slice(i * 64, i * 64 + 64);
    const wi = (i) => parseInt(word(i), 16);
    const sAt = wi(1) / 32;
    const aOff = sAt + wi(sAt) / 32;
    const n = wi(aOff);
    const acts = [];
    for (let k = 0; k < n; k++) {
      const tOff = aOff + 1 + wi(aOff + 1 + k) / 32;
      const f = (i) => word(tOff + i);
      const fi = (i) => parseInt(f(i), 16);
      const textWord = tOff + fi(8) / 32;
      const textLen = wi(textWord);
      const textHex = body.slice((textWord + 1) * 64, (textWord + 1) * 64 + textLen * 2);
      acts.push({
        type: fi(0), senderId: BigInt(fi(1)), receiverId: BigInt(fi(2)),
        ts: fi(4), sender: '0x' + f(5).slice(24), cawId: '0x' + f(7),
        text: Buffer.from(textHex, 'hex').toString('utf8'),
      });
    }
    return acts;
  }
  let batches = 0, actions = 0, matched = 0;
  for (const t of txs) {
    if (!t.raw.startsWith('0x84e33f2f')) continue;
    let want;
    try { want = parseAll(t.raw); } catch { continue; }
    batches++;
    const got = core.decodeActions(t.raw);
    if (got.length !== want.length) continue;
    let all = true;
    for (let i = 0; i < want.length; i++) {
      actions++;
      const a = got[i], b = want[i];
      if (!(a.type === b.type && a.senderId === b.senderId &&
        a.receiverId === b.receiverId && a.ts === b.ts &&
        a.sender.toLowerCase() === b.sender.toLowerCase() &&
        a.cawId.toLowerCase() === b.cawId.toLowerCase() && a.text === b.text)) all = false;
    }
    if (all) matched++;
  }
  check('decodeActions reproduces every corpus action',
    matched === batches && batches > 0,
    matched + '/' + batches + ' batches, ' + actions + ' actions');
  check('decodeAction still returns the first action',
    (() => {
      const t = txs.find((x) => x.raw.startsWith('0x84e33f2f') && core.decodeActions(x.raw).length > 0);
      if (!t) return false;
      const one = core.decodeAction(t.raw);
      const first = core.decodeActions(t.raw)[0];
      return !!one && one.cawId === first.cawId && one.text === first.text;
    })());
}

/* ================= live: bug 3 (names) ================= */
try {
  const n189 = await api.resolveName(189n);
  check('live resolveName(189) is dreamin (its card name; usernames(189)="neptune" is the shifted one)', n189 === 'dreamin', String(n189));
  const owner189 = await api.nameOwner(189n);
  const toks = await api.tokensOf(owner189);
  const row = toks.find((t) => t.id === 189n);
  check('live tokensOf gives id 189 the card name dreamin', !!row && row.username === 'dreamin',
    row ? row.username : 'row missing');
  const r1 = await api.resolveNameId('neptune');
  const r2 = await api.resolveNameId('dreamin');
  check('live name round-trip: neptune→190, dreamin→189',
    r1.status === 'ok' && r1.id === 190n && r2.status === 'ok' && r2.id === 189n,
    JSON.stringify({ neptune: r1.status === 'ok' ? r1.id.toString() : r1.status, dreamin: r2.status === 'ok' ? r2.id.toString() : r2.status }));
} catch (e) {
  check('live name checks', false, String((e && e.message) || e));
}

/* ================= live: bug 2 (profile posts + quote lookup) ================= */
try {
  const prof = await api.fetchProfilePosts(189n, null);
  check('live fetchProfilePosts(189) finds actions (was 0 before the fix)',
    prof.items.length > 0, prof.items.length + ' found');
} catch (e) {
  check('live fetchProfilePosts(189)', false, String((e && e.message) || e));
}
try {
  const page = await api.fetchTimelinePage(null);
  const recaw = page.items.find((i) => i.type === 2) || page.items.find((i) => i.type === 1);
  if (recaw) {
    const target = await api.findPostByCawId(recaw.cawId);
    check('live findPostByCawId locates a like/share target post',
      !!target && target.type === 0 && target.cawId.toLowerCase() === recaw.cawId.toLowerCase(),
      target ? 'found: ' + target.text.slice(0, 24) : 'not found');
  } else {
    check('live findPostByCawId', false, 'no like/share in first page to test with');
  }
} catch (e) {
  check('live findPostByCawId', false, String((e && e.message) || e));
}

/* ---- v0.4.6 wiring (static): balance frames, Deposit button,
 * tab icons. The v0.4.5 device failures were all in the view
 * layer (a 3-across stat row wrapping its labels, a faucet
 * button collapsing), so the guards live here as source checks
 * alongside the runtime suites. ---- */
{
  const ROOT = new URL('..', import.meta.url).pathname;
  const tlSrc = readFileSync(ROOT + 'src/screens/TimelineScreen.tsx', 'utf8');
  const appSrc = readFileSync(ROOT + 'App.tsx', 'utf8');
  const uiSrc = readFileSync(ROOT + 'src/components/ui.tsx', 'utf8');
  const mineSrc = readFileSync(ROOT + 'src/screens/MyNamesScreen.tsx', 'utf8');
  const ctxSrc = readFileSync(ROOT + 'src/context/AppContext.tsx', 'utf8');

  check('v0.4.6: BalanceFrame component exists (bordered frame, label over amount)',
    /export function BalanceFrame/.test(uiSrc) &&
    /borderColor: '#d9dee2'/.test(uiSrc) && /borderRadius: 12/.test(uiSrc));
  check('v0.4.6: Home card renders the three balances as frames with fmtAmountCard',
    (tlSrc.match(/<BalanceFrame/g) || []).length === 3 &&
    /fmtAmountCard\(qcaw\)/.test(tlSrc) &&
    /fmtAmountCard\(acting\.balance\)/.test(tlSrc));
  check('v0.4.6: name card renders the three balances as frames with fmtAmountCard',
    (appSrc.match(/<BalanceFrame/g) || []).length === 3 &&
    /fmtAmountCard\(acting\.balance\)/.test(appSrc));
  check('v0.4.6: Home card has no faucet button (Deposit replaced it)',
    !/FaucetButton/.test(tlSrc) && !/faucet\.title/.test(tlSrc));
  check('v0.4.6: Home Deposit button is wired (focusMine with a name, Get-a-name without)',
    /tr\('home\.deposit'\)/.test(tlSrc) &&
    /app\.focusMine\(acting\.id\)/.test(tlSrc) &&
    /app\.setTab\('get'\)/.test(tlSrc));
  check('v0.4.6: focus hand-off round-trips (context exposes it, My names consumes it)',
    /focusMine/.test(ctxSrc) && /mineFocusId/.test(ctxSrc) &&
    /app\.mineFocusId/.test(mineSrc) && /app\.clearMineFocus\(\)/.test(mineSrc));
  check('v0.4.6: every tab carries an icon (home/search/user/settings vectors)',
    /Icon: HomeIcon/.test(appSrc) && /Icon: SearchIcon/.test(appSrc) &&
    /Icon: UserIcon/.test(appSrc) && /Icon: SettingsIcon/.test(appSrc) &&
    /export function HomeIcon/.test(uiSrc) &&
    /export function SettingsIcon/.test(uiSrc));
  check('v0.4.6: Home card button labels are single-line shrink-to-fit (no vertical split)',
    (tlSrc.match(/numberOfLines=\{1\}/g) || []).length >= 3);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
