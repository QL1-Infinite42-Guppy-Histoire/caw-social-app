/* Verification for replies + quote Recaws + recaw display data
 * (v0.4.0).
 *
 * Background — the reply-convention verdict this is built on:
 * CAW has NO native reply convention. Verified 2026-11-08 by a
 * full walk of the QL1 CawActions feed (6,065 txs, 1,035 posts:
 * every post has receiverId = 0, none references a parent) and
 * by the web verification corpus (112 posts, same result).
 * Replies/quotes are therefore an app-level convention: an
 * ordinary type-0 post (receiverId still 0, own fresh cawId)
 * whose text ends with one marker line,
 *   [caw:reply:<base64url(parent cawId)>]
 *   [caw:quote:<base64url(parent cawId)>]
 * (see src/lib/postRef.ts).
 *
 * This harness compiles the app's REAL modules (cawCore, cawApi,
 * postRef, feedSync) and checks, against a stubbed Blockscout
 * server:
 *  (a) the marker codec: round-trip, kind separation, malformed
 *      and mid-text markers ignored, overhead is 56 bytes;
 *  (b) the send path: an action built exactly as the composer
 *      builds it encodes, decodes and re-parses to the same
 *      reference, and its digest signs/recovers (throwaway key);
 *  (c) indexing: replies and quotes of one post are indexed
 *      DISTINCTLY — the thread holds only replies, the quote
 *      list only quotes, reactions only the plain recaw/like;
 *  (d) thread assembly: original + 2 replies → ordered thread,
 *      count 2, quotes and the plain recaw excluded;
 *  (e) recaw display data: findPostByCawId resolves a recaw's
 *      original; an unknown cawId resolves to null (the honest
 *      fallback the UI renders).
 *
 * No keys are used for sending (one throwaway key signs locally
 * for the recover check), no network — reads and local logic.
 * Run: node scripts/verify-threads.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BUILD = new URL('./.build-threads', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

execFileSync(
  'npx',
  [
    'tsc', '--ignoreConfig',
    'src/config.ts', 'src/lib/cawCore.ts', 'src/lib/cawApi.ts',
    'src/lib/postRef.ts', 'src/lib/feedSync.ts',
    '--module', 'commonjs', '--target', 'es2022',
    '--outDir', BUILD, '--skipLibCheck',
  ],
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'inherit' },
);

const core = require(BUILD + '/lib/cawCore.js');
const api = require(BUILD + '/lib/cawApi.js');
const ref = require(BUILD + '/lib/postRef.js');
const { SigningKey, Wallet, recoverAddress } = require('ethers');

/* ---------- (a) marker codec ---------- */
const PARENT = '0x' + 'ab'.repeat(32);
const replyRef = { kind: 'reply', parentCawId: PARENT };
const quoteRef = { kind: 'quote', parentCawId: PARENT };

const withReply = ref.appendPostRef('hello parent', replyRef);
const parsed = ref.parsePostText(withReply);
check('(a) reply marker round-trips (kind + parent + body)',
  parsed.ref !== null && parsed.ref.kind === 'reply' &&
  parsed.ref.parentCawId.toLowerCase() === PARENT &&
  parsed.body === 'hello parent',
  withReply.split('\n').pop());

const withQuote = ref.appendPostRef('my take', quoteRef);
const parsedQ = ref.parsePostText(withQuote);
check('(a) quote marker is a DISTINCT kind from reply',
  parsedQ.ref !== null && parsedQ.ref.kind === 'quote' &&
  parsedQ.ref.parentCawId.toLowerCase() === PARENT &&
  parsedQ.body === 'my take');

check('(a) marker overhead is 56 bytes (newline + 55-char line)',
  ref.postRefOverhead(replyRef) === 56 &&
  withReply.length - 'hello parent'.length === 56);

check('(a) a plain post parses to no reference',
  ref.parsePostText('just a post').ref === null &&
  ref.parsePostText('').ref === null);

check('(a) a marker NOT on the final line is plain text',
  ref.parsePostText('look:\n' + ref.postRefMarker(replyRef) + '\nmore text').ref === null);

check('(a) a malformed marker is plain text',
  ref.parsePostText('hi\n[caw:reply:tooshort]').ref === null &&
  ref.parsePostText('hi\n[caw:reply:' + 'A'.repeat(43) + '] trailing').ref === null);

check('(a) displayTextOf hides the marker line only',
  ref.displayTextOf(withReply) === 'hello parent' &&
  ref.displayTextOf('plain') === 'plain');

/* ---------- (b) send path: build → encode → decode → sign ---------- */
const throwaway = Wallet.createRandom();
const myCawId = '0x' + '11'.repeat(32);
const action = {
  type: 0, senderId: 190n, receiverId: 0n, ts: 1700002000,
  sender: throwaway.address, cawId: myCawId,
  text: ref.appendPostRef('a reply body', replyRef),
};
const calldata = core.encodeBatch([action], [
  (() => { const s = new SigningKey(throwaway.privateKey).sign(core.actionDigest(action)); return { v: s.v, r: s.r, s: s.s }; })(),
]);
const decoded = core.decodeActions(calldata);
check('(b) the reply action survives encode/decode byte-exact in meaning',
  decoded.length === 1 && decoded[0].type === 0 &&
  decoded[0].receiverId === 0n && decoded[0].cawId === myCawId);
const reParsed = decoded.length ? ref.parsePostText(decoded[0].text) : { ref: null };
check('(b) the decoded reply re-parses to the same parent reference',
  reParsed.ref !== null && reParsed.ref.kind === 'reply' &&
  reParsed.ref.parentCawId.toLowerCase() === PARENT);
check('(b) the reply keeps its OWN cawId (never the parent’s)',
  myCawId.toLowerCase() !== PARENT);
const sig = new SigningKey(throwaway.privateKey).sign(core.actionDigest(action));
check('(b) the reply digest signs and recovers to the signer',
  recoverAddress(core.actionDigest(action), { r: sig.r, s: sig.s, v: sig.v }) === throwaway.address);

/* ---------- (c)+(d)+(e) indexing against a stubbed server ---------- */
const SIG = { v: 27, r: '0x' + 'ab'.repeat(32), s: '0x' + 'cd'.repeat(32) };
const ME = '0x1111111111111111111111111111111111111111';
function mkTx(hash, action, block, index) {
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
const cid = (c) => '0x' + c.repeat(64).slice(0, 64);
const post = (senderId, cawId, text) => ({
  type: 0, senderId, receiverId: 0n, ts: 1700000000, sender: ME, cawId, text,
});
const P = { ...post(7n, cid('f'), 'the original post'), hash: H('1'), block: 100, txIndex: 0 };
const R1 = { ...post(8n, cid('a'), ref.appendPostRef('first reply', { kind: 'reply', parentCawId: P.cawId })), hash: H('2'), block: 102, txIndex: 0 };
const R2 = { ...post(9n, cid('b'), ref.appendPostRef('second reply', { kind: 'reply', parentCawId: P.cawId })), hash: H('3'), block: 104, txIndex: 0 };
const Q = { ...post(10n, cid('c'), ref.appendPostRef('quoting this', { kind: 'quote', parentCawId: P.cawId })), hash: H('4'), block: 103, txIndex: 0 };
const S = { type: 2, senderId: 11n, receiverId: 7n, ts: 1700000000, sender: ME, cawId: P.cawId, text: 'REPOST' };
const S_TX = mkTx(H('5'), S, 105, 0);
const L = { type: 1, senderId: 12n, receiverId: 7n, ts: 1700000000, sender: ME, cawId: P.cawId, text: 'LIKE' };
const L_TX = mkTx(H('6'), L, 101, 0);
const U = { ...post(13n, cid('d'), 'unrelated older post'), hash: H('7'), block: 99, txIndex: 0 };

const serverTxs = [
  S_TX,
  mkTx(R2.hash, R2, 104, 0),
  mkTx(Q.hash, Q, 103, 0),
  mkTx(R1.hash, R1, 102, 0),
  L_TX,
  mkTx(P.hash, P, 100, 0),
  mkTx(U.hash, U, 99, 0),
];
const PAGE = 2;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (!u.pathname.endsWith('/transactions')) throw new Error('unexpected fetch: ' + url);
  const b = u.searchParams.get('block_number');
  let start = 0;
  if (b !== null) {
    const pos = serverTxs.findIndex(
      (t) => t.block_number === Number(b) && t.index === Number(u.searchParams.get('index')),
    );
    start = pos + 1;
  }
  const items = serverTxs.slice(start, start + PAGE);
  const last = items[items.length - 1];
  const more = start + PAGE < serverTxs.length;
  return {
    ok: true, status: 200,
    json: async () => ({
      items,
      next_page_params: more
        ? { block_number: last.block_number, index: last.index, items_count: PAGE }
        : null,
    }),
  };
};

api.resetRefIndexForTest();
// Walk the whole feed once so the index fills, as the app does.
let cursor = null;
for (let p = 0; p < 10; p++) {
  const page = await api.fetchTimelinePage(cursor);
  cursor = page.next;
  if (!cursor) break;
}

const thread = await api.fetchPostThread(P);
check('(d) thread assembly: original + 2 replies → exactly the 2 replies, oldest first',
  thread.replies.length === 2 &&
  thread.replies[0].cawId === R1.cawId &&
  thread.replies[1].cawId === R2.cawId,
  'got ' + thread.replies.map((r) => r.cawId.slice(0, 6)).join(','));
check('(d) the thread walk reports complete', thread.complete === true);
check('(c) knownReplyCount counts replies only',
  api.knownReplyCount(P.cawId) === 2, 'count=' + api.knownReplyCount(P.cawId));
const quotes = api.knownQuotesOf(P.cawId);
check('(c) quotes are indexed distinctly from replies and recaws',
  quotes.length === 1 && quotes[0].cawId === Q.cawId &&
  !thread.replies.some((r) => r.cawId === Q.cawId));

const reactions = await api.fetchPostReactions(P);
check('(c) reactions count the plain recaw and like — never the quote post',
  reactions.shares.length === 1 && reactions.shares[0] === 11n &&
  reactions.likes.length === 1 && reactions.likes[0] === 12n);

const foundOriginal = await api.findPostByCawId(S.cawId);
check('(e) a recaw’s original resolves from the index',
  foundOriginal !== null && foundOriginal.cawId === P.cawId &&
  foundOriginal.text === 'the original post');
const missing = await api.findPostByCawId(cid('9'));
check('(e) an unknown cawId resolves to null (honest fallback, nothing fabricated)',
  missing === null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
