/**
 * Read layer for CAW on QL1 — public RPC + Blockscout API, ported from
 * the verified web front end. No keys are handled here; writes go
 * through src/lib/wallet.ts with the in-app signer.
 */
import { decodeBase64, toUtf8String } from 'ethers';

import { API, CAW_ACTIONS, CAW_NAME, EXPLORER, MINTER, QCAW, RPC, SEL } from '../config';
import {
  CawAction,
  NameToken,
  decodeActions,
  decAddrRet,
  decStringRet,
  decUintRet,
  encAddr,
  encStr,
  strip,
  word,
} from './cawCore';
import { parsePostText, type PostRefKind } from './postRef';

export interface TimelineItem extends CawAction {
  hash: string;
  blockTs?: string;
  /** Block number + transaction index inside the block — the exact
   *  on-chain order of the action (the follow index sorts by these). */
  block?: number;
  txIndex?: number;
}

export interface Page<T> {
  items: T[];
  next: Record<string, unknown> | null;
}

/* ---------- read-only RPC ---------- */
let rpcSeq = 0;
export async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSeq, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

export const ethCall = (to: string, data: string): Promise<string> =>
  rpc('eth_call', [{ to, data }, 'latest']);

/**
 * Many eth_calls in ONE HTTP request (JSON-RPC batch). Public RPCs
 * accept batches; if this one refuses, fall back to sequential calls
 * so a search/index build still works, just slower.
 */
export async function ethCallBatch(
  calls: { to: string; data: string }[],
): Promise<(string | null)[]> {
  if (calls.length === 0) return [];
  try {
    const payload = calls.map((c, i) => ({
      jsonrpc: '2.0',
      id: i + 1,
      method: 'eth_call',
      params: [{ to: c.to, data: c.data }, 'latest'],
    }));
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    if (!Array.isArray(j)) throw new Error('batch not supported');
    const out: (string | null)[] = new Array(calls.length).fill(null);
    for (const r of j) {
      if (r && typeof r.id === 'number' && r.result) {
        out[r.id - 1] = r.result;
      }
    }
    return out;
  } catch {
    const out: (string | null)[] = [];
    for (const c of calls) {
      try {
        out.push(await ethCall(c.to, c.data));
      } catch {
        out.push(null);
      }
    }
    return out;
  }
}
export const readUint = async (to: string, data: string): Promise<bigint> =>
  decUintRet(await ethCall(to, data));
export const readAddr = async (to: string, data: string): Promise<string> =>
  decAddrRet(await ethCall(to, data));
export const readStr = async (to: string, data: string): Promise<string> =>
  decStringRet(await ethCall(to, data));

/** Retry a read a few times (public RPCs can hiccup). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  tries = 3,
  delayMs = 700,
): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/* ---------- names ---------- */
/** Parse the JSON metadata a tokenURI returns (data: base64). */
function metaFromUri(uri: string): Record<string, unknown> | null {
  try {
    if (uri.startsWith('data:application/json;base64,')) {
      return JSON.parse(toUtf8String(decodeBase64(uri.split(',')[1])));
    }
    if (uri.startsWith('data:application/json')) {
      return JSON.parse(decodeURIComponent(uri.split(',').slice(1).join(',')));
    }
  } catch {
    /* not parseable metadata */
  }
  return null;
}

/**
 * The name of a token — from its CARD (the tokenURI name field).
 *
 * Which source is true was settled by the mint transactions
 * themselves (verified on-chain): Minter.mint("dreamin") created
 * token 189 (tx 0xc4ac11ad…, block 5189285) and Minter.mint(
 * "neptune") created token 190 (tx 0x9c374074…, block 5189287) —
 * exactly the names the two tokens' cards carry. The one broken
 * getter is usernames(): usernames(n) returns the minted name of
 * token n+1 (it is a 0-based list read against 1-based token ids;
 * slot 0 holds token 1's name, "elonmusk"). tokenURI, tokens() and
 * idByUsername all agree with the mint records; only usernames()
 * is shifted, so it is used solely as a fallback in its corrected
 * form usernames(id − 1), which returns this token's minted name.
 *
 * (v0.1.2 had this backwards — it treated usernames(id) as the
 * truth — which is why the user's own "neptune" (#190) was shown
 * to him as "loveforqom". Corrected in v0.1.3.)
 */
export async function readCardName(idIn: bigint): Promise<string> {
  const id = BigInt(idIn);
  try {
    const uri = await withRetry(
      () => readStr(CAW_NAME, SEL.tokenURI + word(id)),
      2,
      400,
    );
    const meta = metaFromUri(uri);
    const n = meta && typeof meta.name === 'string' ? meta.name : '';
    if (n) return n;
  } catch {
    /* fall through to the corrected usernames slot */
  }
  if (id >= 1n) {
    const n = await withRetry(
      () => readStr(CAW_NAME, SEL.usernames + word(id - 1n)),
      2,
      400,
    );
    if (n) return n;
  }
  return '';
}

/**
 * IMPORTANT — identity ("which names are MINE") is built ONLY from
 * the ERC-721 enumeration, cross-checked against ownerOf:
 *
 *   balanceOf(owner) → tokenOfOwnerByIndex(owner, i) → ownerOf(id)
 *
 * Names come from each token's card (see readCardName), balances
 * from cawBalanceOf(id). An id is included ONLY when ownerOf(id)
 * really returns this wallet — somebody else's name can never
 * appear in the list, whatever any helper view returns. A failed
 * name read leaves the username empty (the UI shows "#id") rather
 * than somebody else's name.
 */
async function enumerateOwnedTokens(owner: string): Promise<NameToken[]> {
  const count = Number(
    await withRetry(() =>
      readUint(CAW_NAME, SEL.balanceOf + encAddr(owner)),
    ),
  );
  const out: NameToken[] = [];
  const seen = new Set<string>();
  const limit = Math.min(count, 1000);
  // One token's full check (index → ownerOf proof → card name →
  // balance). The checks for different tokens are independent, so
  // they run in parallel chunks — a wallet with dozens of names used
  // to need 4 sequential round trips per name.
  const oneToken = async (i: number): Promise<NameToken | null> => {
    let id: bigint;
    try {
      id = await withRetry(
        () =>
          readUint(
            CAW_NAME,
            SEL.tokenOfOwnerByIndex + encAddr(owner) + word(i),
          ),
        2,
        400,
      );
    } catch {
      return null; // a hole in the list must not kill the whole list
    }
    let realOwner: string;
    try {
      realOwner = await withRetry(
        () => readAddr(CAW_NAME, SEL.ownerOf + word(id)),
        2,
        400,
      );
    } catch {
      return null; // cannot prove ownership — leave it out
    }
    if (realOwner.toLowerCase() !== owner.toLowerCase()) return null;
    let username = '';
    try {
      username = (await readCardName(id)) || '';
    } catch {
      username = '';
    }
    let balance = 0n;
    try {
      balance = await readUint(CAW_NAME, SEL.cawBalanceOf + word(id));
    } catch {
      balance = 0n; // a balance hiccup must not drop the name itself
    }
    return { id, balance, username };
  };
  for (let base = 0; base < limit; base += 6) {
    const chunk: Promise<NameToken | null>[] = [];
    for (let i = base; i < Math.min(base + 6, limit); i++) {
      chunk.push(oneToken(i));
    }
    for (const t of await Promise.all(chunk)) {
      if (!t) continue;
      const k = t.id.toString();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

const ownerTokensCache = new Map<string, Promise<NameToken[]>>();
export function tokensOf(owner: string): Promise<NameToken[]> {
  const key = owner.toLowerCase();
  if (!ownerTokensCache.has(key)) {
    const p = (async (): Promise<NameToken[]> => {
      try {
        return await enumerateOwnedTokens(owner);
      } catch {
        // Do not let one transient RPC failure poison the whole
        // session: drop the cache entry so the next call retries.
        ownerTokensCache.delete(key);
        return [];
      }
    })();
    ownerTokensCache.set(key, p);
  }
  return ownerTokensCache.get(key)!;
}
export function clearNameCaches(): void {
  ownerTokensCache.clear();
  nameCache.clear();
  avatarCache.clear();
}

const nameCache = new Map<bigint, Promise<string | null>>();
export function resolveName(idIn: bigint): Promise<string | null> {
  const id = BigInt(idIn);
  if (!nameCache.has(id)) {
    const p = (async (): Promise<string | null> => {
      let result: string | null = null;
      // The token's card (tokenURI name) is the authoritative name
      // source — it matches the mint records (see readCardName).
      try {
        const n = await readCardName(id);
        if (n) result = n;
      } catch {
        /* fall through to the token list */
      }
      if (!result) {
        try {
          const owner = await readAddr(CAW_NAME, SEL.ownerOf + word(id));
          const toks = await tokensOf(owner);
          const hit = toks.find((t) => t.id === id);
          if (hit && hit.username) result = hit.username;
        } catch {
          /* fall through */
        }
      }
      // A miss caused by a transient read failure must not stick for
      // the whole session — evict so the next render retries.
      if (!result) nameCache.delete(id);
      return result;
    })();
    nameCache.set(id, p);
  }
  return nameCache.get(id)!;
}

export type ResolveResult =
  | { status: 'ok'; id: bigint; username: string }
  | { status: 'notfound' };

/**
 * Resolve a username to its token id, verified against the token's
 * card. idByUsername(name) returns the TRUE token id (it agrees with
 * the mint records and the cards — the "+1" once suspected here was
 * an artifact of comparing it against the shifted usernames()).
 * The answer is still never trusted on its own: the id (and, as a
 * belt-and-braces measure, its neighbours) must carry exactly this
 * name on its card. Returns 'notfound' for a genuinely free/unknown
 * name and THROWS when the reads themselves failed (callers show a
 * load error, never a false "not found").
 */
export async function resolveNameId(rawName: string): Promise<ResolveResult> {
  const q = String(rawName || '').trim().toLowerCase();
  if (!q) return { status: 'notfound' };
  const id0 = await withRetry(() => readUint(MINTER, SEL.idByUsername + encStr(q)));
  if (id0 === 0n) return { status: 'notfound' };
  const cands = [id0, id0 - 1n, id0 + 1n].filter((c) => c >= 1n);
  let readFailed = false;
  for (const c of cands) {
    let uname: string | null = null;
    try {
      uname = await readCardName(c);
    } catch {
      readFailed = true;
    }
    if (uname === q) return { status: 'ok', id: c, username: uname };
  }
  if (readFailed) throw new Error('name lookup reads failed');
  return { status: 'notfound' };
}

/* ---------- avatars ---------- */
const avatarCache = new Map<bigint, Promise<string | null>>();
/**
 * Avatar image for a name id, from its card (tokenURI) metadata.
 * The card picture belongs to the same metadata whose name field
 * matches the mint records, so the picture and the displayed name
 * always describe the same name. (The brief v0.1.3 detour that
 * dropped this reader rested on the same backwards reading of
 * usernames() as v0.1.2; the mint transactions settled it.)
 */
export function avatarFor(idIn: bigint): Promise<string | null> {
  const id = BigInt(idIn);
  if (!avatarCache.has(id)) {
    const p = (async (): Promise<string | null> => {
      let result: string | null = null;
      try {
        const uri = await withRetry(
          () => readStr(CAW_NAME, SEL.tokenURI + word(id)),
          2,
          400,
        );
        const meta = metaFromUri(uri);
        const image =
          meta && typeof meta.image === 'string' ? meta.image : '';
        if (image) {
          result = image.startsWith('ipfs://')
            ? 'https://ipfs.io/ipfs/' + image.slice(7)
            : image;
        } else if (uri.startsWith('http')) {
          result = uri;
        }
      } catch {
        /* no picture, or a transient failure */
      }
      // Same rule as names: a failure-driven null must not stick.
      if (!result) avatarCache.delete(id);
      return result;
    })();
    avatarCache.set(id, p);
  }
  return avatarCache.get(id)!;
}

/* ---------- balances & counts ---------- */
export async function walletBalances(
  address: string,
): Promise<{ qom: bigint; qcaw: bigint }> {
  const [qom, qcaw] = await Promise.all([
    rpc('eth_getBalance', [address, 'latest'])
      .then((h: string) => BigInt(h))
      .catch(() => 0n),
    readUint(QCAW, SEL.balanceOf + encAddr(address)).catch(() => 0n),
  ]);
  return { qom, qcaw };
}

export const followerCount = (id: bigint): Promise<bigint> =>
  readUint(CAW_ACTIONS, SEL.followerCount + word(id));

export const nameBalance = (id: bigint): Promise<bigint> =>
  readUint(CAW_NAME, SEL.cawBalanceOf + word(id));

export const totalSupply = (): Promise<bigint> =>
  readUint(CAW_NAME, SEL.totalSupply);

export const likesCount = (a: CawAction): Promise<bigint> =>
  readUint(CAW_ACTIONS, SEL.likes + word(a.senderId) + strip(a.cawId));

export const nameOwner = (id: bigint): Promise<string> =>
  readAddr(CAW_NAME, SEL.ownerOf + word(id));

/* ---------- name check (for minting) ---------- */
export interface NameCheck {
  valid: boolean;
  taken: boolean;
  cost: bigint;
}
export async function checkName(name: string): Promise<NameCheck> {
  const enc = encStr(name);
  const [valid, res, cost] = await Promise.all([
    ethCall(MINTER, SEL.isValidUsername + enc).then(
      (h) => decUintRet(h) !== 0n,
    ),
    resolveNameId(name).catch(() => ({ status: 'error' as const })),
    readUint(MINTER, SEL.costOfName + enc),
  ]);
  if (valid && res.status === 'error') throw new Error('lookup failed');
  return { valid, taken: res.status === 'ok', cost };
}

export const qcawAllowance = (owner: string, spender: string): Promise<bigint> =>
  readUint(QCAW, SEL.allowance + encAddr(owner) + encAddr(spender)).catch(
    () => 0n,
  );
export const qcawBalance = (owner: string): Promise<bigint> =>
  readUint(QCAW, SEL.balanceOf + encAddr(owner)).catch(() => 0n);

/* ---------- timeline & profile posts (Blockscout) ---------- */
function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

/**
 * In-memory index of posts (type 0) seen while reading the feed, by
 * cawId. Like/share entries carry the target post's cawId, so this is
 * how their content gets found for display.
 */
const postIndex = new Map<string, TimelineItem>();

/* ---------- reply / quote reference index (v0.4.0) ----------
 * Replies and quote Recaws are ordinary posts whose text ends
 * with a parent-reference marker (see lib/postRef.ts). Every
 * type-0 action the feed reads pass through here, so the
 * children of a post can be found without a contract getter
 * (none exists). Keyed by the PARENT's cawId, then the child's
 * own cawId; plain recaws (type 2) never enter this index —
 * they are counted by fetchPostReactions instead, which keeps
 * quotes and recaws cleanly separate. */
export interface RefChild extends TimelineItem {
  refKind: PostRefKind;
}

const refIndex = new Map<string, Map<string, RefChild>>();

/** Index one post's parent reference, when it carries one. */
export function indexPostRef(item: TimelineItem): void {
  if (item.type !== 0) return;
  const { ref } = parsePostText(item.text);
  if (!ref) return;
  const parentKey = ref.parentCawId.toLowerCase();
  let kids = refIndex.get(parentKey);
  if (!kids) {
    kids = new Map();
    refIndex.set(parentKey, kids);
  }
  kids.set(item.cawId.toLowerCase(), { ...item, refKind: ref.kind });
}

function refChildren(cawId: string, kind: PostRefKind): RefChild[] {
  const kids = refIndex.get((cawId || '').toLowerCase());
  if (!kids) return [];
  return [...kids.values()].filter((k) => k.refKind === kind);
}

/** Replies to a post that the feed reads have indexed so far. */
export const knownRepliesOf = (cawId: string): RefChild[] =>
  refChildren(cawId, 'reply');

/** Quote Recaws of a post indexed so far (distinct from recaws). */
export const knownQuotesOf = (cawId: string): RefChild[] =>
  refChildren(cawId, 'quote');

/** Reply count from what has been indexed so far (rows display). */
export const knownReplyCount = (cawId: string): number =>
  refChildren(cawId, 'reply').length;

/** Drop the reference index (tests). */
export function resetRefIndexForTest(): void {
  refIndex.clear();
}

/** Optional hook: notified for every decoded action (used to seed the
 *  on-device "my actions" memory without a circular import). */
let actionObserver: ((a: CawAction) => void) | null = null;
export function setActionObserver(fn: ((a: CawAction) => void) | null): void {
  actionObserver = fn;
}

/**
 * Session page cache: the timeline, profile scans and the follow
 * index all walk the same newest-first transaction pages. Caching
 * each fetched page (by its cursor) for the session means a profile
 * visit reuses what the timeline already downloaded instead of
 * re-fetching the same 50-transaction pages again and again.
 *
 * The HEAD page (cursor null) is the one exception — and the
 * v0.3.12 bug: caching it settled for the whole session meant
 * every later "refresh" (timeline mount, pull-to-refresh, the
 * Following walk) was served the first page exactly as it looked
 * at the session's first fetch, so a post confirmed on-chain
 * never appeared until the app process restarted. The head is
 * therefore only shared while its fetch is IN FLIGHT (concurrent
 * walks still dedupe to one request) and is never served once
 * settled: any caller asking for the head gets a fresh read.
 */
const pageCache = new Map<string, Promise<Page<TimelineItem>>>();
const PAGE_CACHE_MAX = 160;
const HEAD_KEY = '__first__';

/**
 * Drop any in-flight head-page fetch from the cache, so the next
 * head read starts a new request. The post path calls this when a
 * send confirms; with the head never served settled it is a
 * belt-and-braces no-op in most timings, kept so the invalidation
 * intent is explicit at the call site.
 */
export function invalidateFeedHead(): void {
  pageCache.delete(HEAD_KEY);
}

async function fetchActionPageUncached(
  next: Record<string, unknown> | null,
): Promise<Page<TimelineItem>> {
  let url = API + '/addresses/' + CAW_ACTIONS + '/transactions';
  if (next) url += qs(next);
  const res = await fetch(url);
  if (!res.ok) throw new Error('api ' + res.status);
  const j = await res.json();
  const items: TimelineItem[] = [];
  for (const it of j.items || []) {
    if (!it.raw_input || (it.status && it.status !== 'ok')) continue;
    // A batch can carry several actions — render every one of them,
    // not just the first.
    for (const a of decodeActions(it.raw_input)) {
      const item: TimelineItem = {
        ...a,
        hash: it.hash,
        blockTs: it.timestamp,
        block: typeof it.block_number === 'number' ? it.block_number : undefined,
        txIndex: typeof it.index === 'number' ? it.index : undefined,
      };
      items.push(item);
      if (a.type === 0) {
        postIndex.set(a.cawId.toLowerCase(), item);
        indexPostRef(item);
      }
      if (actionObserver) {
        try {
          actionObserver(a);
        } catch {
          /* the observer must never break the feed */
        }
      }
    }
  }
  return { items, next: j.next_page_params || null };
}

function fetchActionPage(
  next: Record<string, unknown> | null,
): Promise<Page<TimelineItem>> {
  const key = next ? JSON.stringify(next) : HEAD_KEY;
  const hit = pageCache.get(key);
  if (hit) return hit;
  const p = fetchActionPageUncached(next).catch((e) => {
    pageCache.delete(key); // a failed page must not stick
    throw e;
  });
  if (next === null) {
    // Head page: share the in-flight promise only. The moment it
    // settles it leaves the cache, so the next head read is a
    // genuine refetch — the feed's head can never go stale for
    // the rest of the session again.
    pageCache.set(key, p);
    const evict = () => {
      if (pageCache.get(key) === p) pageCache.delete(key);
    };
    p.then(evict, evict);
    return p;
  }
  if (pageCache.size >= PAGE_CACHE_MAX) {
    const oldest = pageCache.keys().next().value;
    if (oldest) pageCache.delete(oldest);
  }
  pageCache.set(key, p);
  return p;
}

export const fetchTimelinePage = fetchActionPage;

/**
 * Find the original post for a cawId (the target of a like / share).
 * Checks everything the feed reads have already indexed, then scans
 * up to 12 fresh pages. Returns null when it cannot be found nearby —
 * the entry then simply shows without the quoted post.
 */
export async function findPostByCawId(
  cawId: string,
): Promise<TimelineItem | null> {
  const key = (cawId || '').toLowerCase();
  const hit = postIndex.get(key);
  if (hit) return hit;
  let cursor: Record<string, unknown> | null = null;
  for (let p = 0; p < 12; p++) {
    const page = await fetchActionPage(cursor);
    const h2 = postIndex.get(key);
    if (h2) return h2;
    cursor = page.next;
    if (!cursor) break;
  }
  return null;
}

/**
 * Who liked / shared one post (v0.2.0 post detail). A reaction can
 * only exist after its post does, so the walk starts at the newest
 * feed item and stops once a whole page is older than the post —
 * every reaction to it sits inside that window. Sender ids are
 * de-duplicated (a name's repeated identical action adds nothing
 * to a "who" list). `complete` is false when the page cap stopped
 * the walk first — possible only for extremely reacted-to old
 * posts.
 */
export async function fetchPostReactions(
  post: TimelineItem,
  maxPages = 80,
): Promise<{ likes: bigint[]; shares: bigint[]; complete: boolean }> {
  const likes: bigint[] = [];
  const shares: bigint[] = [];
  const seenLikes = new Set<string>();
  const seenShares = new Set<string>();
  let cursor: Record<string, unknown> | null = null;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const { items, next } = await fetchActionPage(cursor);
    if (items.length === 0) {
      complete = true;
      break;
    }
    for (const it of items) {
      if (it.cawId !== post.cawId) continue;
      if (it.type === 1 && !seenLikes.has(it.senderId.toString())) {
        seenLikes.add(it.senderId.toString());
        likes.push(it.senderId);
      } else if (it.type === 2 && !seenShares.has(it.senderId.toString())) {
        seenShares.add(it.senderId.toString());
        shares.push(it.senderId);
      }
    }
    const lastBlock = items[items.length - 1].block ?? 0;
    if ((post.block ?? 0) > 0 && lastBlock < (post.block ?? 0)) {
      complete = true;
      break;
    }
    if (!next) {
      complete = true;
      break;
    }
    cursor = next;
  }
  return { likes, shares, complete };
}

/**
 * The reply thread of one post (v0.4.0): every type-0 post whose
 * parent-reference marker names this post, oldest first. A reply
 * can only exist after its parent, so — exactly like
 * fetchPostReactions — the walk starts at the newest feed item
 * and stops once a whole page is older than the post. Children
 * the session already indexed (including ones this walk passes
 * again) are merged and de-duplicated by their own cawId.
 * `complete` is false when the page cap stopped the walk first.
 * Quote children are NOT replies and never appear here; plain
 * recaws (type 2) neither.
 */
export async function fetchPostThread(
  post: TimelineItem,
  maxPages = 80,
): Promise<{ replies: RefChild[]; complete: boolean }> {
  const found = new Map<string, RefChild>();
  const key = post.cawId.toLowerCase();
  const consider = (it: TimelineItem) => {
    if (it.type !== 0) return;
    const { ref } = parsePostText(it.text);
    if (
      ref &&
      ref.kind === 'reply' &&
      ref.parentCawId.toLowerCase() === key &&
      it.cawId.toLowerCase() !== key
    ) {
      found.set(it.cawId.toLowerCase(), { ...it, refKind: 'reply' });
    }
  };
  let cursor: Record<string, unknown> | null = null;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const { items, next } = await fetchActionPage(cursor);
    if (items.length === 0) {
      complete = true;
      break;
    }
    for (const it of items) consider(it);
    const lastBlock = items[items.length - 1].block ?? 0;
    if ((post.block ?? 0) > 0 && lastBlock < (post.block ?? 0)) {
      complete = true;
      break;
    }
    if (!next) {
      complete = true;
      break;
    }
    cursor = next;
  }
  for (const kid of knownRepliesOf(post.cawId)) {
    if (!found.has(kid.cawId.toLowerCase())) {
      found.set(kid.cawId.toLowerCase(), kid);
    }
  }
  const replies = [...found.values()].sort(
    (a, b) =>
      (a.block ?? 0) - (b.block ?? 0) ||
      (a.txIndex ?? 0) - (b.txIndex ?? 0) ||
      a.ts - b.ts,
  );
  return { replies, complete };
}

/**
 * Up to 10 actions by one name. Almost every action on QL1 is
 * submitted by a relay address, so a profile cannot be read from the
 * owner's own transaction list — the contract feed itself has to be
 * scanned. The old budget of 4 pages (200 txs) found NOTHING for
 * less-active names (measured: name #189's first action sits on page
 * 21), so profiles looked empty. One call now scans up to 30 pages,
 * and "see more" continues from the returned cursor.
 */
export async function fetchProfilePosts(
  nameId: bigint,
  next: Record<string, unknown> | null,
): Promise<Page<TimelineItem> & { done: boolean }> {
  const found: TimelineItem[] = [];
  let cursor = next;
  let pages = 0;
  let done = false;
  while (found.length < 10 && pages < 30 && !done) {
    const page = await fetchActionPage(cursor);
    cursor = page.next;
    if (!cursor) done = true;
    pages++;
    for (const a of page.items) {
      if (a.senderId === nameId) found.push(a);
    }
  }
  return { items: found, next: cursor, done };
}

/** ISO timestamp of the day a name was made (first mint transfer), or null. */
export async function mintDateOf(id: bigint): Promise<string | null> {
  let url: string | null =
    API + '/tokens/' + CAW_NAME + '/instances/' + id.toString() + '/transfers';
  for (let page = 0; page < 8 && url; page++) {
    try {
      const res: Response = await fetch(url);
      if (!res.ok) return null;
      const j: any = await res.json();
      for (const it of j.items || []) {
        const from = (it.from && it.from.hash) || '';
        if (from.toLowerCase() === '0x0000000000000000000000000000000000000000') {
          return it.timestamp as string;
        }
      }
      url = j.next_page_params
        ? API +
          '/tokens/' +
          CAW_NAME +
          '/instances/' +
          id.toString() +
          '/transfers' +
          qs(j.next_page_params)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

export const txUrl = (hash: string): string => EXPLORER + '/tx/' + hash;
export const addressUrl = (addr: string): string =>
  EXPLORER + '/address/' + addr;
