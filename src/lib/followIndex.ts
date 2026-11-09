/**
 * Follow index — who follows whom, rebuilt from the public record.
 *
 * CawActions keeps only a follower COUNT per name (followerCount);
 * there is no "list followers" read. The lists are therefore
 * reconstructed from the follow / unfollow actions themselves
 * (types 3 / 4 in the same Blockscout transaction feed the timeline
 * uses), keeping, for each (sender, receiver) pair, the pair's
 * LATEST action: a pair is "following" when its latest action is a
 * follow.
 *
 * Two refinements, both measured against the real chain data
 * (scripts/verify-follow.mjs re-runs the comparison):
 *  - Unfollows (type 4) are real and must close a pair — ignoring
 *    them (as every earlier version did, the decoder dropped type 4
 *    entirely) leaves stale follows in the lists.
 *  - Some follows never registered on-chain: the sender name held
 *    no CAW in its name balance. (Measured on name #10: its two
 *    non-registering follows were exactly the ones from names with
 *    a zero name balance, and adding a zero-balance exclusion to
 *    the state rule raised exact followerCount matches from 52/73
 *    to 59/73 profiles sampled.) The balance at the follow's own
 *    block cannot be re-read — the public QL1 RPC prunes old state
 *    ("header not found") — so the check uses the sender's CURRENT
 *    name balance: a name that never funded its balance still sits
 *    at zero, which is the population this exclusion exists for.
 *    A failed read keeps the pair (fail-open: a missing refinement
 *    must not hide a real follow).
 *
 * The profile header still shows the chain's own followerCount as
 * THE follower number — exact by construction. The lists are the
 * best reconstruction the public record allows.
 *
 * The pair map is persisted on the device (injected KV) with a
 * block watermark: the first build walks the whole feed once
 * (~6,000 transactions), later builds only walk the pages newer
 * than the watermark.
 */
import { fetchTimelinePage, nameBalance, type TimelineItem } from './cawApi';
import type { KVStorage } from './myActions';

export interface PairRec {
  /** 3 = follow, 4 = unfollow (the pair's latest action) */
  t: 3 | 4;
  b: number;
  x: number;
  k: number;
}

const INDEX_KEY = 'caw-follow-index-v1';

let kv: KVStorage | null = null;
let pairs = new Map<string, PairRec>();
let watermark = 0;
let building: Promise<void> | null = null;
let hydrated = false;
/** Resume state of an interrupted full build (v0.3.0): the feed
 *  cursor to continue from, and the head block of that build. */
let buildCursor: Record<string, unknown> | null = null;
let buildHead = 0;
let pagesWalked = 0;
const listeners = new Set<() => void>();

/** Subscribe to index updates (per merged page, on hydrate, on
 *  completion). Returns an unsubscribe function. Lets screens
 *  render progressively instead of waiting for a full build. */
export function subscribeFollowIndex(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a broken listener must not break the build */
    }
  }
}

/** Snapshot for the slim progress note in the UI. */
export function followIndexProgress(): { building: boolean; pages: number } {
  return { building: building !== null, pages: pagesWalked };
}
/** pairKey -> sender balance at the pair's follow block was zero */
const zeroVerdicts = new Map<string, boolean>();

export function initFollowIndex(storage: KVStorage): void {
  kv = storage;
}

const pairKey = (s: bigint, r: bigint): string => s.toString() + '->' + r.toString();

function newer(a: PairRec, b: PairRec): boolean {
  return (
    a.b > b.b ||
    (a.b === b.b && (a.x > b.x || (a.x === b.x && a.k > b.k)))
  );
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  if (!kv) return;
  try {
    const raw = await kv.getItem(INDEX_KEY);
    if (!raw) return;
    const j = JSON.parse(raw);
    if (j && typeof j.watermark === 'number' && j.pairs) {
      watermark = j.watermark;
      pairs = new Map(Object.entries(j.pairs) as [string, PairRec][]);
      if (j.buildCursor && typeof j.buildCursor === 'object') {
        buildCursor = j.buildCursor as Record<string, unknown>;
        buildHead = typeof j.buildHead === 'number' ? j.buildHead : 0;
      }
    }
    notify();
  } catch {
    /* a broken cache just means a fresh build */
  }
}

async function persist(): Promise<void> {
  if (!kv) return;
  try {
    const obj: Record<string, PairRec> = {};
    for (const [k, v] of pairs) obj[k] = v;
    await kv.setItem(
      INDEX_KEY,
      JSON.stringify({ watermark, pairs: obj, buildCursor, buildHead }),
    );
  } catch {
    /* persistence is an optimisation, never a blocker */
  }
}

function mergeItem(it: TimelineItem): void {
  if ((it.type !== 3 && it.type !== 4) || it.block === undefined) return;
  const key = pairKey(it.senderId, it.receiverId);
  const rec: PairRec = {
    t: it.type as 3 | 4,
    b: it.block,
    x: it.txIndex ?? 0,
    k: 0,
  };
  const cur = pairs.get(key);
  // Items arrive in chain order within a transaction, so for an
  // equal (block, txIndex) the item seen later in the scan is the
  // pair's later action and wins; only a strictly older record is
  // ignored. (Scans walk newest-first, and re-merging the same
  // transaction replays the same order, so this stays idempotent.)
  if (!cur || !newer(cur, rec)) pairs.set(key, rec);
}

/**
 * Build / refresh the index. The first build walks the full feed;
 * later builds stop as soon as a whole page is at or below the
 * stored watermark (everything older is already merged). Concurrent
 * calls share one run.
 */
export function buildFollowIndex(
  onProgress?: (pages: number) => void,
  opts?: { maxPages?: number },
): Promise<void> {
  if (!building) {
    building = (async () => {
      try {
        await hydrate();
        // Resume an interrupted build from its stored cursor
        // instead of restarting at page 1 (v0.3.0). The pairs
        // merged so far are already in memory / on disk, and the
        // merge rule (latest action wins) makes re-walking safe.
        let cursor: Record<string, unknown> | null = buildCursor;
        let pages = 0;
        let headBlock = buildHead;
        pagesWalked = 0;
        while (true) {
          const page = await fetchTimelinePage(cursor);
          pages++;
          pagesWalked = pages;
          if (onProgress) onProgress(pages);
          let pageMax = 0;
          for (const it of page.items) {
            if (it.block !== undefined && it.block > pageMax) {
              pageMax = it.block;
            }
            mergeItem(it);
          }
          if (pages === 1 && headBlock === 0) headBlock = pageMax;
          cursor = page.next;
          notify();
          if (!cursor) break;
          // Everything on this page is at/below the watermark: the
          // rest of the feed is older still, so we are caught up.
          if (pageMax > 0 && pageMax <= watermark) break;
          if (opts?.maxPages && pages >= opts.maxPages) {
            // Pause point: save pairs + cursor so the next build
            // (or the next app launch) continues from here.
            buildCursor = cursor;
            buildHead = headBlock;
            await persist();
            return;
          }
          // Incremental persistence every 10 pages, so closing the
          // app mid-build keeps the progress made so far.
          if (pages % 10 === 0) {
            buildCursor = cursor;
            buildHead = headBlock;
            await persist();
          }
        }
        if (headBlock > watermark) watermark = headBlock;
        buildCursor = null;
        buildHead = 0;
        await persist();
        notify();
      } finally {
        building = null;
      }
    })();
  }
  return building;
}

export function followIndexReady(): boolean {
  return pairs.size > 0;
}

export interface FollowLists {
  following: bigint[];
  followers: bigint[];
}

/** Latest-state lists (no balance refinement), newest action first. */
export function followListsOf(idIn: bigint): FollowLists {
  const id = idIn.toString();
  const following: { id: bigint; rec: PairRec }[] = [];
  const followers: { id: bigint; rec: PairRec }[] = [];
  for (const [key, rec] of pairs) {
    if (rec.t !== 3) continue;
    const [s, r] = key.split('->');
    // Self-follows (a name following itself) exist on-chain from
    // before the app blocked them (v0.4.5); they are display noise
    // — the name is neither its own follower nor its own follow —
    // so derived lists never show them.
    if (s === r) continue;
    if (s === id) following.push({ id: BigInt(r), rec });
    if (r === id) followers.push({ id: BigInt(s), rec });
  }
  const byRecency = (a: { rec: PairRec }, b: { rec: PairRec }) =>
    b.rec.b - a.rec.b || b.rec.x - a.rec.x;
  following.sort(byRecency);
  followers.sort(byRecency);
  return {
    following: following.map((f) => f.id),
    followers: followers.map((f) => f.id),
  };
}

/** Is (sender -> receiver) currently a follow, per the index? */
export function isFollowingIndexed(sender: bigint, receiver: bigint): boolean {
  if (sender === receiver) return false; // self-follows never count
  const rec = pairs.get(pairKey(sender, receiver));
  return !!rec && rec.t === 3;
}

/**
 * Check one pair's registration: true when the sender name holds
 * CAW in its name balance (current balance — see the header note
 * on why the follow-time balance cannot be re-read). Verdicts are
 * cached for the session only, since balances change. Fail-open
 * (true) on read errors.
 */
async function followRegistered(s: bigint, r: bigint): Promise<boolean> {
  const key = pairKey(s, r);
  const rec = pairs.get(key);
  if (!rec || rec.t !== 3) return false;
  const cached = zeroVerdicts.get(key);
  if (cached !== undefined) return !cached;
  let registered = true;
  try {
    const bal = await nameBalance(s);
    registered = bal > 0n;
  } catch {
    registered = true; // fail-open
  }
  zeroVerdicts.set(key, !registered);
  return registered;
}

/**
 * Refined lists: latest-state pairs minus the follows that never
 * registered (zero sender name balance). Balance checks run in
 * small parallel chunks.
 */
export async function refinedFollowListsOf(
  idIn: bigint,
): Promise<FollowLists> {
  const base = followListsOf(idIn);
  const refine = async (
    ids: bigint[],
    asSender: boolean,
  ): Promise<bigint[]> => {
    const out: bigint[] = [];
    for (let i = 0; i < ids.length; i += 8) {
      const chunk = ids.slice(i, i + 8);
      const verdicts = await Promise.all(
        chunk.map((other) =>
          asSender
            ? followRegistered(idIn, other)
            : followRegistered(other, idIn),
        ),
      );
      chunk.forEach((other, j) => {
        if (verdicts[j]) out.push(other);
      });
    }
    return out;
  };
  const [following, followers] = await Promise.all([
    refine(base.following, true),
    refine(base.followers, false),
  ]);
  return { following, followers };
}

/** Feed items through the pair merge directly (tests — the live
 *  build path goes through buildFollowIndex's page walk). */
export function mergeFollowItemsForTest(items: TimelineItem[]): void {
  for (const it of items) mergeItem(it);
}

/** Drop the in-memory index (tests). */
export function resetFollowIndexForTest(): void {
  pairs = new Map();
  watermark = 0;
  building = null;
  hydrated = false;
  buildCursor = null;
  buildHead = 0;
  pagesWalked = 0;
  zeroVerdicts.clear();
}
