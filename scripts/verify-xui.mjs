#!/usr/bin/env node
/**
 * X-style UI overhaul verification (v0.6.0, Phase 1).
 *
 * What this pins, beyond the adapted display/fixes suites:
 *
 *  1. Bookmarks store (lib/bookmarks.ts): toggle add/remove,
 *     newest-first order, persistence across instances,
 *     per-wallet scoping, corrupt-data tolerance, reset.
 *  2. Compose cost line (lib/actionCosts.ts): the cost table
 *     matches the CawActions economics (post 5000 / like 2000
 *     / recaw 4000 / follow 30000 / unfollow 0) and every
 *     composer kind (post / reply / quote) costs the post
 *     price in raw units.
 *  3. Views (lib/views.ts + worker/views/countsCore.js):
 *     X-style count formatting; the once-per-day-per-device
 *     plan; the Worker's dedupe (same device+day+post counts
 *     once, a new day or a new device counts again); counts
 *     reads; malformed id/token rejection; and the GATING —
 *     the shipped config has an empty endpoint and ui.tsx
 *     renders the element only when the counter is enabled
 *     AND has answered, so no fake numbers can appear.
 *  4. Structure / reachability statics: exactly three tabs
 *     (home/search/profile, icon-only, no DM, no
 *     notifications tab); every v0.5.1 destination reachable
 *     from the Profile hub (MeScreen) or the app header;
 *     no setTab() calls to removed tabs anywhere; the
 *     compose chip + cost line wiring; the PostCard action
 *     row element order (Reply < Recaw < Like < Views <
 *     SuperLike < Tip < Bookmark); accent = X blue; the
 *     SuperLike star = gold; the Settings About carries the
 *     views-aggregation note in the source language.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = ROOT + '/scripts/.build-xui';
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
const read = (p) => readFileSync(ROOT + '/' + p, 'utf8');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
try {
  execFileSync(
    'npx',
    [
      'tsc',
      '--ignoreConfig',
      'src/config.ts',
      'src/lib/myActions.ts',
      'src/lib/bookmarks.ts',
      'src/lib/actionCosts.ts',
      'src/lib/views.ts',
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
  ok(true, 'tsc compiles the xui graph');
} catch (e) {
  ok(false, 'tsc compiles the xui graph: ' + String(e.stdout || e).slice(0, 300));
}

const require = createRequire(import.meta.url);
const { BookmarkStore, bookmarkStorageKey, normBookmarkId } = require(
  OUT + '/lib/bookmarks.js',
);
const { ACTION_COST_CAW, POST_COST_RAW, composeCostRaw } = require(
  OUT + '/lib/actionCosts.js',
);
const views = require(OUT + '/lib/views.js');
const config = require(OUT + '/config.js');
const core = await import(ROOT + '/worker/views/countsCore.js');

/* ---------- 1. bookmarks ---------- */
console.log('\n-- bookmarks store --');
function memKV() {
  const m = new Map();
  return {
    map: m,
    async getItem(k) {
      return m.has(k) ? m.get(k) : null;
    },
    async setItem(k, v) {
      m.set(k, v);
    },
    async removeItem(k) {
      m.delete(k);
    },
  };
}
const ID1 = '0x' + '11'.repeat(32);
const ID2 = '0x' + '22'.repeat(32);
const ID3 = '0x' + '33'.repeat(32);
const WALLET_A = '0xAAAA00000000000000000000000000000000aaaA';
const WALLET_B = '0xBBBB00000000000000000000000000000000bbbB';
{
  const kv = memKV();
  const store = new BookmarkStore();
  await store.init(kv, WALLET_A);
  ok(store.list().length === 0, 'fresh store is empty');
  ok((await store.toggle(ID1)) === true, 'toggle adds the first bookmark');
  ok((await store.toggle(ID2)) === true, 'toggle adds a second');
  ok(
    JSON.stringify(store.list()) === JSON.stringify([ID2, ID1]),
    'list is newest-first',
  );
  ok(store.has(ID1) && store.has(ID2) && !store.has(ID3), 'has() agrees');
  ok(
    (await store.toggle(ID1)) === false,
    'toggling a saved post removes it (and reports the new state)',
  );
  ok(JSON.stringify(store.list()) === JSON.stringify([ID2]), 'removal sticks');
  ok(
    kv.map.get(bookmarkStorageKey(WALLET_A)) !== undefined,
    'the list persisted under the per-wallet key',
  );
  ok(
    normBookmarkId('  ' + ID1.toUpperCase() + ' ') ===
      ID1.toLowerCase().replace('0x', '0x') &&
      normBookmarkId(ID1) === ID1,
    'ids normalise (trim + lowercase) so case spellings cannot split a bookmark',
  );
  ok(
    (await store.toggle('')) === false && !store.has(''),
    'an empty id is refused by toggle and never reads as saved',
  );

  const reopened = new BookmarkStore();
  await reopened.init(kv, WALLET_A);
  ok(
    JSON.stringify(reopened.list()) === JSON.stringify([ID2]),
    'a fresh instance re-reads the persisted list',
  );

  const other = new BookmarkStore();
  await other.init(kv, WALLET_B);
  ok(other.list().length === 0, 'a different wallet sees none of them');
  await other.toggle(ID3);
  ok(
    JSON.stringify(reopened.list()) === JSON.stringify([ID2]) &&
      JSON.stringify(other.list()) === JSON.stringify([ID3]),
    'per-wallet lists stay independent',
  );

  const corruptKV = memKV();
  corruptKV.map.set(bookmarkStorageKey(WALLET_A), '{broken json');
  const corrupt = new BookmarkStore();
  await corrupt.init(corruptKV, WALLET_A);
  ok(corrupt.list().length === 0, 'corrupt stored data reads as empty, no crash');
  ok((await corrupt.toggle(ID1)) === true, 'and the store recovers on toggle');

  let ticks = 0;
  const unsub = reopened.subscribe(() => ticks++);
  await reopened.toggle(ID3);
  unsub();
  ok(ticks >= 1, 'subscribers are notified on change');
  reopened.reset();
  ok(reopened.list().length === 0, 'reset() clears the in-memory list');
}

/* ---------- 2. action costs ---------- */
console.log('\n-- compose cost line --');
{
  ok(
    ACTION_COST_CAW.post === 5000 &&
      ACTION_COST_CAW.like === 2000 &&
      ACTION_COST_CAW.recaw === 4000 &&
      ACTION_COST_CAW.follow === 30000 &&
      ACTION_COST_CAW.unfollow === 0,
    'cost table matches the CawActions economics',
  );
  ok(POST_COST_RAW === 5000n * 10n ** 18n, 'post cost in raw units');
  for (const kind of ['post', 'reply', 'quote']) {
    ok(
      composeCostRaw(kind) === POST_COST_RAW,
      `composer kind "${kind}" costs the post price (all are type-0 posts)`,
    );
  }
}

/* ---------- 3. views ---------- */
console.log('\n-- views: formatting + device gate --');
{
  const fmt = views.formatViewCount;
  ok(fmt(0) === '0' && fmt(285) === '285' && fmt(999) === '999', 'small counts are exact');
  ok(fmt(1000) === '1K' && fmt(1234) === '1.2K' && fmt(1999) === '1.9K', 'K range truncates to one decimal');
  ok(fmt(999949) === '999.9K' && fmt(1000000) === '1M' && fmt(1234567) === '1.2M', 'M range');
  ok(fmt(2500000000) === '2.5B', 'B range');
  ok(views.viewDayKey(Date.UTC(2026, 10, 13, 23, 59)) === '2026-11-13', 'day key is the UTC date');

  const plan1 = views.planViewHit({}, ID1, '2026-11-13');
  ok(plan1.send === true, 'first view of the day plans a send');
  const plan2 = views.planViewHit(plan1.record, ID1, '2026-11-13');
  ok(plan2.send === false, 'a second view the same day does not');
  const plan3 = views.planViewHit(plan1.record, ID1, '2026-11-14');
  ok(plan3.send === true, 'the next day it does again');
  const plan4 = views.planViewHit(plan1.record, 'garbage', '2026-11-13');
  ok(plan4.send === false, 'a malformed id never plans a send');
  const pruned = views.pruneHitRecord(
    { [ID1]: '2026-11-01', [ID2]: '2026-11-13' },
    '2026-11-07',
  );
  ok(!(ID1 in pruned) && ID2 in pruned, 'old day entries prune away');

  ok(
    config.VIEWS_COUNTER_URL === '',
    'SHIPPED STATE: the counter endpoint is empty (activation is a deploy + rebuild)',
  );
  ok(views.VIEWS_ENABLED === false, 'and the app-side module reports disabled');
  views.registerView(ID1);
  views.ensureViewCounts([ID1]);
  ok(
    views.viewCountCached(ID1) === null,
    'with no endpoint, no count ever materialises (absent, never a fake 0)',
  );
}

console.log('\n-- views: the counter Worker core --');
{
  function fakeKV() {
    const m = new Map();
    return {
      map: m,
      async get(k) {
        return m.has(k) ? m.get(k) : null;
      },
      async put(k, v, opts) {
        m.set(k, v);
        if (opts) this.lastOpts = opts;
      },
    };
  }
  const kv = fakeKV();
  const TOK_A = 'a'.repeat(32);
  const TOK_B = 'b'.repeat(32);
  const T0 = Date.UTC(2026, 10, 13, 10, 0, 0);

  let r = await core.registerHits(kv, { ids: [ID1, ID2], deviceToken: TOK_A }, T0);
  ok(r.ok === true && r.counted.length === 2, 'first hits count');
  ok(r.counts[ID1] === 1 && r.counts[ID2] === 1, 'counts start at 1');
  r = await core.registerHits(kv, { ids: [ID1], deviceToken: TOK_A }, T0 + 3600_000);
  ok(r.counted.length === 0 && r.counts[ID1] === 1, 'same device, same day: no double count');
  r = await core.registerHits(kv, { ids: [ID1], deviceToken: TOK_B }, T0);
  ok(r.counted.length === 1 && r.counts[ID1] === 2, 'a different device counts');
  r = await core.registerHits(kv, { ids: [ID1], deviceToken: TOK_A }, T0 + 86400_000);
  ok(r.counted.length === 1 && r.counts[ID1] === 3, 'the same device on a new day counts again');

  const got = await core.getCounts(kv, [ID1, ID2, ID3]);
  ok(
    got.counts[ID1] === 3 && got.counts[ID2] === 1 && got.counts[ID3] === 0,
    'reads agree with the hits (an unseen post reads a real 0)',
  );
  const bad = await core.registerHits(kv, { ids: [ID1], deviceToken: 'nope' }, T0);
  ok(bad.error !== undefined, 'a malformed device token is rejected');
  const messy = await core.getCounts(kv, ['junk', ID1, ID1, 42]);
  ok(
    Object.keys(messy.counts).length === 1 && messy.counts[ID1] === 3,
    'malformed/duplicate ids are sanitised out of reads',
  );
  const capped = await core.getCounts(
    kv,
    Array.from({ length: 150 }, (_, i) => '0x' + String(i).padStart(64, '0')),
  );
  ok(
    Object.keys(capped.counts).length === 100,
    'a batch is capped at 100 ids',
  );
  ok(
    kv.lastOpts && kv.lastOpts.expirationTtl === 3 * 24 * 3600,
    'dedupe keys expire (3 days) instead of accumulating forever',
  );
}

/* ---------- 4. structure + reachability statics ---------- */
console.log('\n-- structure / reachability --');
{
  const appSrc = read('App.tsx');
  const meSrc = read('src/screens/MeScreen.tsx');
  const uiSrc = read('src/components/ui.tsx');
  const tlSrc = read('src/screens/TimelineScreen.tsx');
  const composeSrc = read('src/screens/ComposeScreen.tsx');
  const settingsSrc = read('src/screens/SettingsScreen.tsx');
  const configSrc = read('src/config.ts');

  ok(
    appSrc.includes("{ key: 'home'") &&
      appSrc.includes("{ key: 'search'") &&
      appSrc.includes("{ key: 'profile'") &&
      !appSrc.includes("{ key: 'get'") &&
      !appSrc.includes("{ key: 'mine'") &&
      !appSrc.includes("{ key: 'settings'"),
    'the tab bar is exactly Home / Search / Profile',
  );
  ok(
    !/key: '(dm|messages|notifications|inbox)'/.test(appSrc),
    'no DM tab and no notifications tab (the stretch derivation did not verify complete)',
  );
  ok(
    appSrc.includes("{tab === 'search' && <SearchScreen />}") &&
      appSrc.includes("{tab === 'profile' && <MeScreen />}"),
    'Search renders as a tab (no onClose) and Profile renders the hub',
  );
  const tabBlock = appSrc.slice(
    appSrc.indexOf('const renderTab'),
    appSrc.indexOf('const renderTab') + 500,
  );
  ok(
    tabBlock.includes('accessibilityLabel={t.label}') &&
      !tabBlock.includes('<Text'),
    'tab buttons are icon-only (labels live on as accessibility labels)',
  );
  ok(
    appSrc.includes("<Text style={styles.fabText}>+</Text>"),
    'the compose FAB is the blue + button',
  );
  ok(
    !appSrc.includes('setHsOpen') && !appSrc.includes('tradeBtnText'),
    'the tab-bar center trade button is gone from App',
  );

  // Reachability: every section/entry the hub must hold.
  for (const [needle, label] of [
    ['<MyNamesScreen />', 'My names section'],
    ['<GetNameScreen />', 'Get a name section'],
    ['<SettingsScreen />', 'Settings section'],
    ['<SendScreen', 'Send modal'],
    ['<InboxScreen', 'reactions inbox modal'],
    ['<BookmarksScreen', 'Bookmarks modal'],
    ['<HuntersSwapModal', 'HuntersExchange modal'],
    ['<BalanceGrid', 'the wallet balance grid'],
    ["openHub('mine')", 'My names entry'],
    ["openHub('get')", 'Get a name entry'],
    ["openHub('settings')", 'Settings entry'],
    ['app.focusMine(acting.id)', 'Deposit button keeps the focusMine route'],
    ["app.openProfile(acting.username)", 'Profile button keeps the openProfile route'],
  ]) {
    ok(meSrc.includes(needle), 'hub reaches: ' + label);
  }
  {
    const cellOrder = [
      "tr('home.qcaw')",
      "tr('home.qom')",
      "tr('card.inName')",
      "tr('card.f42')",
      "tr('card.cat42')",
    ].map((n) => meSrc.indexOf(n));
    ok(
      cellOrder.every((v) => v >= 0) &&
        cellOrder.every((v, i) => i === 0 || v > cellOrder[i - 1]),
      'hub card keeps the Home balance cells and their order',
    );
  }
  // No stale navigation to removed tabs anywhere in the app.
  const allSrc =
    appSrc + meSrc + tlSrc + composeSrc + read('src/context/AppContext.tsx');
  ok(
    !/setTab\('(get|mine|settings)'\)/.test(allSrc) &&
      !allSrc.includes("tab === 'get'") &&
      !allSrc.includes("tab === 'mine'"),
    'no code navigates to a removed tab',
  );
  ok(
    tlSrc.includes("onBookmark={app.toggleBookmark}") &&
      tlSrc.includes("isBookmarked={app.isBookmarked}"),
    'timeline rows carry the bookmark toggle',
  );
  ok(
    !tlSrc.includes('styles.walletCard') &&
      !tlSrc.includes('styles.searchPill') &&
      !tlSrc.includes('<BalanceGrid') &&
      !tlSrc.includes("tr('home.deposit')"),
    'the wallet card and search pill left the Home header (styles, grid and buttons all gone)',
  );
  ok(
    tlSrc.includes("tr('tl.tabLatest')") && tlSrc.includes("tr('tl.tabFollowing')"),
    'the Latest / Following segments remain the Home header',
  );

  // Compose: chip + picker + cost line, header pill, no dead buttons.
  ok(
    composeSrc.includes('@{acting.username} ▾') &&
      composeSrc.includes('chooseActing(t.id)'),
    'compose has the @name switch chip and picker (existing chooseActing)',
  );
  ok(
    composeSrc.includes("tr('compose.cost'") &&
      composeSrc.includes("tr('compose.costFrom'") &&
      composeSrc.includes('fmtAmountCard(acting.balance)'),
    'the cost line shows the price and the ACTIVE name balance',
  );
  ok(
    composeSrc.includes("tr('compose.post')") &&
      composeSrc.includes('setConfirmOpen(true)') &&
      !composeSrc.includes('S.bigBtn'),
    'the header Post pill opens the same confirmation sheet; the bottom button is gone',
  );
  ok(
    !composeSrc.includes('ImagePicker') &&
      !composeSrc.includes('launchImageLibrary') &&
      !composeSrc.includes('expo-image-picker'),
    'no image attach wiring in the composer (a separate phase — no dead buttons)',
  );

  // PostCard action row: element order + views gating + gold star.
  const rowStart = uiSrc.indexOf('X-style action row (v0.6.0)');
  const row = uiSrc.slice(rowStart, rowStart + 9000);
  const order = [
    'ReplyIcon',
    'RepeatIcon',
    'HeartIcon',
    'ViewsIcon',
    'StarIcon',
    'TipIcon',
    'BookmarkIcon',
  ].map((n) => row.indexOf(n));
  ok(
    order.every((v) => v >= 0) &&
      order.every((v, i) => i === 0 || v > order[i - 1]),
    'action row order: Reply < Recaw < Like < Views < SuperLike < Tip < Bookmark',
  );
  ok(
    row.includes('VIEWS_ENABLED && viewCount !== null'),
    'views renders ONLY when the counter is enabled and has answered',
  );
  ok(
    uiSrc.includes('const SUPERLIKE_ON = X_GOLD') &&
      configSrc.includes("X_GOLD = '#FFAC33'") &&
      configSrc.includes("ACCENT = '#1D9BF0'"),
    'accent is X blue; the SuperLike star keeps the gold',
  );
  ok(
    settingsSrc.includes("tr('views.note')"),
    'Settings About states that view counts are aggregated from in-app views',
  );
  ok(
    read('src/screens/BookmarksScreen.tsx').includes("tr('bm.unavailable')") &&
      read('src/screens/BookmarksScreen.tsx').includes('findPostByCawId'),
    'the Bookmarks list resolves live and placeholders unresolvable posts honestly',
  );

  /* ---------- 9. v0.6.1 finish: header, flat SuperRecaw,
   * one record link, one-line action row, hub + screens ---- */
  const mineSrc = read('src/screens/MyNamesScreen.tsx');
  const searchSrc = read('src/screens/SearchScreen.tsx');
  const hsSrc = read('src/screens/HuntersSwapScreen.tsx');
  const exchSrc = read('src/screens/ExchangeSection.tsx');
  ok(
    !appSrc.includes('🔔') && !appSrc.includes('🌐') &&
      !appSrc.includes('LangToggle') && !appSrc.includes('NameCard') &&
      !appSrc.includes("tr('app.tagline')"),
    'header: no emoji bell, no globe cycle button, no brand title block, no name card',
  );
  ok(
    appSrc.includes('BellIcon') && appSrc.includes("setTab('profile')") &&
      appSrc.includes('headerMark'),
    'header: avatar tap -> Profile hub, centered CAW mark, vector bell for the inbox',
  );
  ok(
    meSrc.includes("openHub('wallet')") && meSrc.includes("tr('hub.wallet')") &&
      meSrc.includes("tr('hub.balanceNote')") &&
      meSrc.includes('fmtAmountCard(acting.balance)') &&
      meSrc.includes('WalletIcon') && meSrc.includes('SendIcon') &&
      meSrc.includes('BellIcon') && meSrc.includes('DownloadIcon'),
    'hub: profile summary + hero deposited-CAW card + icon rows (wallet/mine/get/exchange/send/deposit/bookmarks/inbox/settings)',
  );
  ok(
    !uiSrc.includes('superFrame') && !uiSrc.includes('LinearGradient') &&
      !uiSrc.includes('⭐'),
    'SuperRecaw renders FLAT: no gradient frame, no badge, no star emoji in ui.tsx',
  );
  ok(
    (uiSrc.match(/tr\('tl\.viewTx'\)/g) || []).length === 2 &&
      uiSrc
        .slice(uiSrc.indexOf('{!nested ? ('), uiSrc.indexOf('{!nested ? (') + 500)
        .includes("tr('tl.viewTx')"),
    'exactly ONE record link per post row: two render sites total (plain rows + the recaw row), the plain-row one guarded by !nested so nested rows render none',
  );
  ok(
    /actionRow: \{[^}]*justifyContent: 'space-between'/.test(uiSrc) &&
      !uiSrc.includes("flexWrap: 'wrap'") &&
      uiSrc.includes('formatViewCount(Number(likes))') &&
      uiSrc.includes('formatViewCount(replyCount)') &&
      uiSrc.includes('formatViewCount(recawCount)'),
    'action row: single line (space-between, no wrap) with compact counts',
  );
  ok(
    mineSrc.includes('fmtCardDisplay(token.balance') &&
      !mineSrc.includes('fmtAmount(token.balance)') &&
      mineSrc.includes('fmtCardDisplay(totalInNames, 18)'),
    'My names: in-name balances are abbreviated (fmtCardDisplay), never raw decimal strings',
  );
  ok(
    hsSrc.includes('adjustsFontSizeToFit') && hsSrc.includes('numberOfLines={1}') &&
      exchSrc.includes('borderBottomColor') && !exchSrc.includes('borderRadius: 16'),
    'Exchange: title on one fit-to-width line; sections are flat hairline blocks',
  );
  ok(
    searchSrc.includes('<SearchIcon') && !searchSrc.includes('🔍') &&
      searchSrc.includes('hintTop'),
    'Search: vector icon in the bar (no emoji), hint in the upper area',
  );
}

console.log(`\nxui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
