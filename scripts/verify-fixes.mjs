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
 *   tokensOf must agree with the usernames() mapping (the chain's
 *   tokens() rows carry shifted usernames; #189 is "neptune", not
 *   "dreamin"), and name → id → name must round-trip.
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
  check('live resolveName(189) is neptune (not the shifted dreamin)', n189 === 'neptune', String(n189));
  const owner189 = await api.nameOwner(189n);
  const toks = await api.tokensOf(owner189);
  const row = toks.find((t) => t.id === 189n);
  check('live tokensOf gives id 189 the name neptune', !!row && row.username === 'neptune',
    row ? row.username : 'row missing');
  const r1 = await api.resolveNameId('neptune');
  const r2 = await api.resolveNameId('dreamin');
  check('live name round-trip: neptune→189, dreamin→188',
    r1.status === 'ok' && r1.id === 189n && r2.status === 'ok' && r2.id === 188n,
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
