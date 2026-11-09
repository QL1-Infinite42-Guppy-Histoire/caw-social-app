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
  check('v0.4.6+v0.4.8: Home card renders its balances as frames with fmtAmountCard (3 -> 5)',
    (tlSrc.match(/<BalanceFrame/g) || []).length === 5 &&
    /fmtAmountCard\(qcaw\)/.test(tlSrc) &&
    /fmtAmountCard\(acting\.balance\)/.test(tlSrc));
  check('v0.4.6+v0.4.8: name card renders its balances as frames with fmtAmountCard (3 -> 5)',
    (appSrc.match(/<BalanceFrame/g) || []).length === 5 &&
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
  check('v0.4.6: name-card overlay is NOT measured/anchored to the SafeAreaView (no headerH)',
    !/headerH/.test(appSrc));
  check('v0.4.6: card overlay anchors to the content column top (top: 0 below the header)',
    /cardOverlay: \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*position: 'absolute',\s*\n\s*top: 0,/.test(appSrc) ||
    /cardOverlay: \{[^}]*position: 'absolute',[^}]*top: 0,/.test(appSrc));
  check('v0.4.6: overlay renders after the tab screens, inside their container (header outside it)',
    appSrc.indexOf('styles.cardOverlay') > appSrc.indexOf("tab === 'settings'"));
  check('v0.4.6: header brand tap toggles the card (re-tap closes it while open)',
    /setCardOpen\(\(o\) => !o\)/.test(appSrc));
  check('v0.4.6: card keeps a visible gap under the header (marginTop 10, slide -6 max)',
    /nameCard: \{\s*\n\s*marginHorizontal: 12,\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*marginTop: 10,/.test(appSrc) ||
    /nameCard: \{[^}]*marginTop: 10,/.test(appSrc));
}

/* ---- v0.4.7 (static + stubbed-fetch behaviour): a failed
 * balance read must surface as "no read yet" (null -> the cards
 * render "—"), NEVER as a numeric 0. Regression: in v0.4.6 the
 * Home card showed "0 QOM" for a wallet holding ~594M QOM —
 * walletBalances caught an eth_getBalance failure into 0n and
 * refreshBalances stored it as if it were a real balance. ---- */
{
  const ROOT = new URL('..', import.meta.url).pathname;
  const apiSrc = readFileSync(ROOT + 'src/lib/cawApi.ts', 'utf8');
  const ctxSrc = readFileSync(ROOT + 'src/context/AppContext.tsx', 'utf8');
  const tlSrc = readFileSync(ROOT + 'src/screens/TimelineScreen.tsx', 'utf8');
  const appSrc = readFileSync(ROOT + 'App.tsx', 'utf8');

  const wbAt = apiSrc.indexOf('export async function walletBalances');
  const wbEnd = apiSrc.indexOf('export const followerCount');
  const wbRegion = apiSrc.slice(wbAt, wbEnd > wbAt ? wbEnd : wbAt + 1400);
  check('v0.4.7: walletBalances types its fields bigint | null (null = no successful read)',
    /Promise<\{\s*qom: bigint \| null;\s*qcaw: bigint \| null;/.test(wbRegion));
  check('v0.4.7: walletBalances never converts a failed read into 0n',
    wbAt >= 0 && !/catch\(\(\) => 0n\)/.test(wbRegion) &&
    /catch\(\(\) => null\)/.test(wbRegion));
  check('v0.4.7: refreshBalances stores only successful reads (a failure cannot clobber)',
    /if \(b\.qom !== null\) setQom\(b\.qom\)/.test(ctxSrc) &&
    /if \(b\.qcaw !== null\) setQcaw\(b\.qcaw\)/.test(ctxSrc));
  check('v0.4.7: Home + name card QOM frames are fed by the live qom state, dash when unread',
    /amount=\{qom !== null \? fmtAmountCard\(qom\) : null\}/.test(tlSrc) &&
    /amount=\{qom !== null \? fmtAmountCard\(qom\) : null\}/.test(appSrc));

  const realFetch = globalThis.fetch;
  const ADDR = '0x0000000000000000000000000000000000000001';
  const word = (n) => '0x' + n.toString(16).padStart(64, '0');
  const stubFetch = (mode) => async (_url, opts) => {
    if (mode === 'down') throw new Error('network down');
    const body = JSON.parse(opts.body);
    if (body.method === 'eth_getBalance') {
      return {
        json: async () =>
          mode === 'rpcError'
            ? { jsonrpc: '2.0', id: body.id, error: { message: 'boom' } }
            : {
                jsonrpc: '2.0',
                id: body.id,
                result: mode === 'zero' ? '0x0' : '0xde0b6b3a7640000',
              },
      };
    }
    return {
      json: async () =>
        mode === 'rpcError'
          ? { jsonrpc: '2.0', id: body.id, error: { message: 'boom' } }
          : { jsonrpc: '2.0', id: body.id, result: word(2000000000000000000n) },
    };
  };
  try {
    globalThis.fetch = stubFetch('ok');
    const ok = await api.walletBalances(ADDR);
    check('v0.4.7: successful reads return the real balances',
      ok.qom === 1000000000000000000n && ok.qcaw === 2000000000000000000n,
      'qom=' + String(ok.qom) + ' qcaw=' + String(ok.qcaw));
    globalThis.fetch = stubFetch('zero');
    const zero = await api.walletBalances(ADDR);
    check('v0.4.7: a real on-chain zero stays a numeric 0 (not null, not a dash)',
      zero.qom === 0n, 'qom=' + String(zero.qom));
    globalThis.fetch = stubFetch('down');
    const down = await api.walletBalances(ADDR);
    check('v0.4.7: a failed read returns null — NEVER a numeric 0',
      down.qom === null && down.qcaw === null,
      'qom=' + String(down.qom) + ' qcaw=' + String(down.qcaw));
    globalThis.fetch = stubFetch('rpcError');
    const rerr = await api.walletBalances(ADDR);
    check('v0.4.7: an RPC-error read returns null — NEVER a numeric 0',
      rerr.qom === null && rerr.qcaw === null,
      'qom=' + String(rerr.qom) + ' qcaw=' + String(rerr.qcaw));
  } catch (e) {
    check('v0.4.7: walletBalances failure semantics', false, String((e && e.message) || e));
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ---- v0.4.8 (static + stubbed-fetch behaviour): the two new
 * 42 Chain balance frames — native [42] and CAT42 (the
 * SuperLike currency) — on BOTH cards, under the exact v0.4.7
 * rule: unread/failed -> null -> "—", never a numeric 0; a
 * real on-chain zero stays 0. Reads go through the HuntersSwap
 * endpoint table (HS_CHAINS.infinite), no new endpoint. ---- */
{
  const ROOT = new URL('..', import.meta.url).pathname;
  const apiSrc = readFileSync(ROOT + 'src/lib/cawApi.ts', 'utf8');
  const cfgSrc = readFileSync(ROOT + 'src/config.ts', 'utf8');
  const ctxSrc = readFileSync(ROOT + 'src/context/AppContext.tsx', 'utf8');
  const tlSrc = readFileSync(ROOT + 'src/screens/TimelineScreen.tsx', 'utf8');
  const appSrc = readFileSync(ROOT + 'App.tsx', 'utf8');
  const i18nSrc = readFileSync(ROOT + 'src/i18n.ts', 'utf8');
  const uiSrc = readFileSync(ROOT + 'src/components/ui.tsx', 'utf8');

  const wbAt = apiSrc.indexOf('export async function walletBalances');
  const wbEnd = apiSrc.indexOf('export const followerCount');
  const wbRegion = apiSrc.slice(wbAt, wbEnd > wbAt ? wbEnd : wbAt + 3200);
  check('v0.4.8: walletBalances types the 42 Chain fields bigint | null',
    /f42: bigint \| null;\s*cat42: bigint \| null;/.test(wbRegion));
  check('v0.4.8: [42] is a native eth_getBalance over the 42 Chain RPC helper',
    /rpc42\('eth_getBalance'/.test(wbRegion));
  check('v0.4.8: CAT42 is an ERC-20 balanceOf over the 42 Chain call helper',
    /ethCall42\(CAT42, SEL\.balanceOf/.test(wbRegion));
  check('v0.4.8: the 42 Chain RPC helper reads the HuntersSwap endpoint table',
    /HS_CHAINS\.infinite\.rpcs/.test(apiSrc));
  check('v0.4.8: CAT42 contract is the SuperLike token address in config',
    /CAT42 = '0x7386719EBbBeB4d810fF89027Bfb8A1CDf696310'/.test(cfgSrc));
  check('v0.4.8: refreshBalances stores the 42 Chain reads only on success',
    /if \(b\.f42 !== null\) setF42\(b\.f42\)/.test(ctxSrc) &&
    /if \(b\.cat42 !== null\) setCat42\(b\.cat42\)/.test(ctxSrc));
  check('v0.4.8: Home card [42] + CAT42 frames are fed by live state, dash when unread',
    /amount=\{f42 !== null \? fmtAmountCard\(f42\) : null\}/.test(tlSrc) &&
    /amount=\{cat42 !== null \? fmtAmountCard\(cat42\) : null\}/.test(tlSrc));
  check('v0.4.8: name card [42] + CAT42 frames are fed by live state, dash when unread',
    /amount=\{f42 !== null \? fmtAmountCard\(f42\) : null\}/.test(appSrc) &&
    /amount=\{cat42 !== null \? fmtAmountCard\(cat42\) : null\}/.test(appSrc));
  check('v0.4.8: both cards use the shared SuperLike label key',
    /tr\('card\.cat42'\)/.test(tlSrc) && /tr\('card\.cat42'\)/.test(appSrc));
  check('v0.4.8: new label keys exist in all 13 language dicts',
    (i18nSrc.match(/'card\.cat42'/g) || []).length === 13 &&
    (i18nSrc.match(/'card\.f42'/g) || []).length === 13);
  check('v0.4.8: name card content scrolls inside a height-capped card',
    /maxHeight: cardMaxH/.test(appSrc) &&
    /<ScrollView[^>]*>[\s\S]{0,200}<NameCard/.test(appSrc));

  /* v0.4.9: the five frames are compacted (user: they ate too
   * much vertical space). Pin the compact metrics inside the
   * balanceStyles block specifically, and that BOTH cards keep
   * all five frames in the same order with a tightened stack. */
  const balBlock = uiSrc.slice(
    uiSrc.indexOf('const balanceStyles'),
    uiSrc.indexOf('const balanceStyles') + 900,
  );
  check('v0.4.9: BalanceFrame compacted (paddingVertical 5, amount 17, label 11.5)',
    /paddingVertical: 5/.test(balBlock) &&
    /fontSize: 17/.test(balBlock) &&
    /fontSize: 11\.5/.test(balBlock) &&
    /paddingHorizontal: 12/.test(balBlock));
  check('v0.4.9: BalanceFrame keeps the bordered look + unread dash rule',
    /borderColor: '#d9dee2'/.test(balBlock) &&
    /amount === null \? '—'/.test(uiSrc));
  check('v0.4.9: both cards still render all five frames, stack gap tightened to 6',
    (tlSrc.match(/<BalanceFrame/g) || []).length === 5 &&
    (appSrc.match(/<BalanceFrame/g) || []).length === 5 &&
    /marginTop: 12, gap: 6/.test(tlSrc) && /marginTop: 14, gap: 6/.test(appSrc));

  const realFetch = globalThis.fetch;
  const ADDR = '0x0000000000000000000000000000000000000001';
  const word = (n) => '0x' + n.toString(16).padStart(64, '0');
  const stubFetch = (mode) => async (_url, opts) => {
    if (mode === 'down') throw new Error('network down');
    const body = JSON.parse(opts.body);
    if (body.method === 'eth_getBalance') {
      return {
        json: async () =>
          mode === 'rpcError'
            ? { jsonrpc: '2.0', id: body.id, error: { message: 'boom' } }
            : {
                jsonrpc: '2.0',
                id: body.id,
                result: mode === 'zero' ? '0x0' : '0xde0b6b3a7640000',
              },
      };
    }
    return {
      json: async () =>
        mode === 'rpcError'
          ? { jsonrpc: '2.0', id: body.id, error: { message: 'boom' } }
          : {
              jsonrpc: '2.0',
              id: body.id,
              result: word(mode === 'zero' ? 0n : 2000000000000000000n),
            },
    };
  };
  try {
    globalThis.fetch = stubFetch('ok');
    const ok = await api.walletBalances(ADDR);
    check('v0.4.8: successful reads return the real 42 Chain balances',
      ok.f42 === 1000000000000000000n && ok.cat42 === 2000000000000000000n,
      'f42=' + String(ok.f42) + ' cat42=' + String(ok.cat42));
    globalThis.fetch = stubFetch('zero');
    const zero = await api.walletBalances(ADDR);
    check('v0.4.8: a real on-chain zero stays a numeric 0 for [42] and CAT42',
      zero.f42 === 0n && zero.cat42 === 0n,
      'f42=' + String(zero.f42) + ' cat42=' + String(zero.cat42));
    globalThis.fetch = stubFetch('down');
    const down = await api.walletBalances(ADDR);
    check('v0.4.8: failed 42 Chain reads return null — NEVER a numeric 0',
      down.f42 === null && down.cat42 === null,
      'f42=' + String(down.f42) + ' cat42=' + String(down.cat42));
    globalThis.fetch = stubFetch('rpcError');
    const rerr = await api.walletBalances(ADDR);
    check('v0.4.8: RPC-error 42 Chain reads return null — NEVER a numeric 0',
      rerr.f42 === null && rerr.cat42 === null,
      'f42=' + String(rerr.f42) + ' cat42=' + String(rerr.cat42));
  } catch (e) {
    check('v0.4.8: walletBalances 42 Chain failure semantics', false, String((e && e.message) || e));
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
