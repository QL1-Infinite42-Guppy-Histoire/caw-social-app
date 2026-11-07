/* Verification for the v0.3.12 feed-freshness fix.
 *
 * Bug (user report 2026-11-08): a post confirms on-chain but never
 * appears in the timeline until the app cache is cleared. Root
 * cause: the session page cache in cawApi kept the feed's HEAD
 * page from its first fetch for the whole session, so every
 * "refresh" (mount, pull-to-refresh, the Following walk) was
 * served the same stale first page. On top of that, the post path
 * had no optimistic insertion, unlike likes/recaws.
 *
 * This harness stubs the Blockscout API with a mutable in-memory
 * "server", compiles the app's REAL modules (cawApi + feedSync)
 * and checks:
 *  (a) the first head fetch returns the seeded head;
 *  (b) after the server gains a new post, a head refetch returns
 *      it — WITHOUT any invalidation call (mount / pull-to-refresh
 *      must always refetch the head).  ** fails pre-fix **
 *  (c) cursor (deeper) pages stay session-cached (the perf reason
 *      the cache exists) and in-flight head fetches still dedupe;
 *  (d) the post path: noteOwnPost notifies subscribers,
 *      insertOwnPost de-dupes by hash, and reconcileOwnPosts pins
 *      a confirmed-but-not-yet-indexed post at the head exactly
 *      once, then hands over to the scanned copy (same hash,
 *      no duplicate) once the explorer catches up;
 *  (e) a Following-style walk from the head picks up a followed
 *      name's new post on a fresh walk.
 *
 * No keys, no sends, no network — reads and local logic only.
 * Run: node scripts/verify-feed.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BUILD = new URL('./.build-feed', import.meta.url).pathname;

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
    'src/lib/feedSync.ts',
    '--module', 'commonjs', '--target', 'es2022',
    '--outDir', BUILD, '--skipLibCheck',
  ],
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'inherit' },
);

const core = require(BUILD + '/lib/cawCore.js');

/* ---- a mutable fake Blockscout server ---- */
const SIG = { v: 27, r: '0x' + 'ab'.repeat(32), s: '0x' + 'cd'.repeat(32) };
const ME = '0x1111111111111111111111111111111111111111';
function mkTx(hash, senderId, text, block, index) {
  const action = {
    type: 0, senderId, receiverId: 0n, ts: 1700000000 + block,
    sender: ME, cawId: '0x' + hash.slice(2, 10).padEnd(64, '0'), text,
  };
  return {
    hash,
    raw_input: core.encodeBatch([action], [SIG]),
    status: 'ok',
    timestamp: new Date(1700000000000 + block * 1000).toISOString(),
    block_number: block,
    index,
  };
}
const H = (c) => '0x' + c.repeat(64).slice(0, 64);
const txA = mkTx(H('a'), 7n, 'older post A', 100, 0);
const txB = mkTx(H('b'), 8n, 'older post B', 99, 1);
const txC = mkTx(H('c'), 7n, 'older post C', 98, 0);
const txNew = mkTx(H('d'), 190n, 'fresh post from a followed name', 101, 0);
const txMine = mkTx(H('e'), 190n, 'my brand new post', 102, 0);

let serverTxs = [txA, txB, txC]; // newest first
const hits = { head: 0, page: 0 };
const PAGE = 2;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (!u.pathname.endsWith('/transactions')) {
    throw new Error('unexpected fetch: ' + url);
  }
  const b = u.searchParams.get('block_number');
  let start = 0;
  if (b !== null) {
    hits.page++;
    const pos = serverTxs.findIndex(
      (t) => t.block_number === Number(b) && t.index === Number(u.searchParams.get('index')),
    );
    start = pos + 1;
  } else {
    hits.head++;
  }
  const items = serverTxs.slice(start, start + PAGE);
  const last = items[items.length - 1];
  const more = start + PAGE < serverTxs.length;
  const body = {
    items,
    next_page_params: more
      ? { block_number: last.block_number, index: last.index, items_count: PAGE }
      : null,
  };
  return { ok: true, status: 200, json: async () => body };
};

const api = require(BUILD + '/lib/cawApi.js');
const sync = require(BUILD + '/lib/feedSync.js');

const hashes = (items) => items.map((i) => i.hash);

/* ---- (a) seeded head ---- */
const head1 = await api.fetchTimelinePage(null);
check('(a) first head fetch returns the seeded head',
  JSON.stringify(hashes(head1.items)) === JSON.stringify([txA.hash, txB.hash]));

/* ---- (b) head refetch after the server gains a post ---- */
serverTxs = [txNew, txA, txB, txC];
const head2 = await api.fetchTimelinePage(null);
check('(b) head refetch returns the new post at the head (no invalidation call)',
  head2.items.length > 0 && head2.items[0].hash === txNew.hash,
  'got head ' + (head2.items[0] ? head2.items[0].hash.slice(0, 8) : 'none'));

/* ---- (c) deeper pages stay cached; in-flight head dedupe ---- */
const cur = head2.next;
const page2a = await api.fetchTimelinePage(cur);
const pageHitsBefore = hits.page;
await api.fetchTimelinePage(cur);
check('(c) cursor page is served from the session cache on re-fetch',
  hits.page === pageHitsBefore && page2a.items.length > 0);
hits.head = 0;
await Promise.all([api.fetchTimelinePage(null), api.fetchTimelinePage(null)]);
check('(c) two concurrent head fetches share one network request', hits.head === 1,
  'head hits=' + hits.head);

/* ---- (d) post path: optimistic note + reconcile ---- */
sync.resetFeedSyncForTest();
let notified = null;
const unsub = sync.subscribeOwnPosts((item) => { notified = item; });
const optimistic = {
  type: 0, senderId: 190n, receiverId: 0n, ts: 1700000102, sender: ME,
  cawId: '0x' + txMine.hash.slice(2, 10).padEnd(64, '0'), text: 'my brand new post',
  hash: txMine.hash, blockTs: new Date().toISOString(),
};
sync.noteOwnPost(optimistic);
check('(d) noteOwnPost notifies subscribers with the confirmed post',
  notified !== null && notified.hash === txMine.hash);
unsub();

// Explorer lag: the scanned head does not have the post yet.
const lagging = await api.fetchTimelinePage(null);
const merged = sync.reconcileOwnPosts(lagging.items);
check('(d) reconcile pins the un-indexed own post at the head, exactly once',
  merged[0].hash === txMine.hash &&
  merged.filter((i) => i.hash === txMine.hash).length === 1 &&
  sync.pendingOwnPosts().length === 1);

// Explorer catches up: the scanned copy takes over, no duplicate.
serverTxs = [txMine, txNew, txA, txB, txC];
if (typeof api.invalidateFeedHead === 'function') api.invalidateFeedHead();
const caught = await api.fetchTimelinePage(null);
const merged2 = sync.reconcileOwnPosts(caught.items);
check('(d) after indexing, reconcile yields the scanned copy once and clears pending',
  merged2.filter((i) => i.hash === txMine.hash).length === 1 &&
  merged2[0].hash === txMine.hash &&
  sync.pendingOwnPosts().length === 0);

// insertOwnPost de-dupes by hash.
const ins = sync.insertOwnPost(merged2, { ...optimistic });
check('(d) insertOwnPost replaces a same-hash entry instead of duplicating',
  ins.filter((i) => i.hash === txMine.hash).length === 1 && ins[0].hash === txMine.hash);

/* ---- (e) Following-style walk picks up the new post ---- */
const followSet = new Set(['190']);
const found = [];
let cursor = null;
for (let p = 0; p < 5; p++) {
  const page = await api.fetchTimelinePage(cursor);
  for (const it of page.items) {
    if ((it.type === 0 || it.type === 2) && followSet.has(it.senderId.toString())) {
      found.push(it);
    }
  }
  cursor = page.next;
  if (!cursor) break;
}
check('(e) a fresh Following walk from the head finds the followed name’s posts',
  found.some((i) => i.hash === txMine.hash) && found.some((i) => i.hash === txNew.hash),
  'found ' + found.length);

/* ---------- (f) v0.4.0: likes never render as feed rows ----------
 * Presentation rule only: the RAW page still carries the like
 * (counts / liked-by / inbox read it elsewhere), but
 * visibleFeedItems — applied by both the Latest feed and the
 * Following feed — yields no type-1 row, while posts and recaws
 * still render. The Following collector itself also only picks
 * type 0/2, so a followed name's like cannot enter there either. */
function mkActionTx(hash, action, block, index) {
  return {
    hash,
    raw_input: core.encodeBatch([action], [SIG]),
    status: 'ok',
    timestamp: new Date(1700000000000 + block * 1000).toISOString(),
    block_number: block,
    index,
  };
}
const L_HASH = '0x' + '1'.repeat(64);
const P_HASH = '0x' + '2'.repeat(64);
const R_HASH = '0x' + '3'.repeat(64);
const likeAction = { type: 1, senderId: 42n, receiverId: 7n, ts: 1700000000, sender: ME, cawId: '0x' + P_HASH.slice(2, 10).padEnd(64, '0'), text: 'LIKE' };
const recawAction = { type: 2, senderId: 42n, receiverId: 7n, ts: 1700000000, sender: ME, cawId: '0x' + P_HASH.slice(2, 10).padEnd(64, '0'), text: 'REPOST' };
const likeTxs = [
  mkActionTx(L_HASH, likeAction, 913, 0),
  mkTx(P_HASH, 42n, 'a plain post', 912, 0),
  mkActionTx(R_HASH, recawAction, 911, 0),
];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (!u.pathname.endsWith('/transactions')) throw new Error('unexpected fetch: ' + url);
  return {
    ok: true,
    status: 200,
    json: async () => ({ items: likeTxs, next_page_params: null }),
  };
};
const likePage = await api.fetchTimelinePage(null);
check('(f) the raw feed page still carries the like (data untouched)',
  likePage.items.some((i) => i.type === 1 && i.hash === L_HASH) &&
    likePage.items.length === 3);
const visible = sync.visibleFeedItems(likePage.items);
check('(f) Latest feed: the like produces NO row; post and recaw still do',
  visible.length === 2 &&
    !visible.some((i) => i.type === 1) &&
    visible.some((i) => i.hash === P_HASH) &&
    visible.some((i) => i.hash === R_HASH),
  'rows=' + visible.map((i) => 'type' + i.type).join(','));
/* Following: the collector keeps only type 0/2 from followed
 * senders; running its output through the same visibility rule
 * must also hold no like row. */
const followedOnly = likePage.items.filter(
  (i) => (i.type === 0 || i.type === 2) && i.senderId === 42n,
);
const fVisible = sync.visibleFeedItems(followedOnly);
check('(f) Following feed: no like row either (collector + visibility rule)',
  !fVisible.some((i) => i.type === 1) &&
    fVisible.some((i) => i.hash === R_HASH));
check("(f) the user's OWN like is filtered by the same rule (sender = me)",
  sync.visibleFeedItems([
    { type: 1, sender: ME, hash: '0xown' },
    { type: 0, sender: ME, hash: '0xother' },
  ]).length === 1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
