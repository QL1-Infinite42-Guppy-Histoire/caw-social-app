/**
 * Own-post feed synchronisation (v0.3.12).
 *
 * The bug this fixes: after a successful post the tx was on-chain
 * and confirmed, yet the post never appeared in the timeline until
 * the app was restarted / its cache cleared. Two halves:
 *
 *  1. The session page cache in cawApi served the feed's HEAD page
 *     from its first fetch for the whole session (see
 *     fetchActionPage there — the head is now only shared while a
 *     fetch is in flight, never served settled). Head refetches on
 *     mount / pull-to-refresh therefore really reach the network.
 *
 *  2. Even a fresh head fetch can lag a few seconds behind a
 *     just-confirmed transaction (the explorer indexes after the
 *     receipt). So the post path records the confirmed post here
 *     the moment submitAction returns its hash: the timeline
 *     inserts it at the head immediately (optimistic, but built
 *     from CONFIRMED tx data — the send already waited for the
 *     receipt) and every later head fetch reconciles against this
 *     store: once the scanned copy of the same tx arrives it takes
 *     over (same hash, de-duplicated), until then the local copy
 *     stays pinned at the head.
 *
 * The store is module-level, so it survives the timeline screen's
 * unmount/remount cycle on tab switches, exactly like the feed
 * cache it complements.
 */
import type { TimelineItem } from './cawApi';

/** Confirmed own posts not yet seen in a scanned head page,
 *  keyed by lowercase tx hash. */
const pendingOwn = new Map<string, TimelineItem>();

const listeners = new Set<(item: TimelineItem) => void>();

/**
 * Record a just-confirmed own post and notify subscribers (the
 * timeline inserts it at the head and kicks off a reconciling
 * head refetch). Call ONLY after the send has confirmed — this
 * store represents chain truth, not a draft.
 */
export function noteOwnPost(item: TimelineItem): void {
  pendingOwn.set(item.hash.toLowerCase(), item);
  for (const fn of [...listeners]) {
    try {
      fn(item);
    } catch {
      /* a broken listener must not break the post path */
    }
  }
}

/** Subscribe to confirmed own posts. Returns an unsubscribe fn. */
export function subscribeOwnPosts(
  fn: (item: TimelineItem) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Insert one own post at the head of a list (used for the instant
 * optimistic update). De-duplicated by tx hash: an entry with the
 * same hash already present is replaced by the fresh copy.
 */
export function insertOwnPost(
  items: TimelineItem[],
  item: TimelineItem,
): TimelineItem[] {
  const h = item.hash.toLowerCase();
  return [item, ...items.filter((i) => i.hash.toLowerCase() !== h)];
}

/**
 * Merge the pending own posts into a freshly fetched head page.
 * Posts the scan now contains (same tx hash) graduate out of the
 * pending store and appear in their scanned form/position; the
 * rest stay pinned above the fetched items, newest first. The
 * fetched items themselves are returned untouched and in order —
 * this never duplicates a post the scan already has.
 */
export function reconcileOwnPosts(fetched: TimelineItem[]): TimelineItem[] {
  if (pendingOwn.size === 0) return fetched;
  const scanned = new Set(fetched.map((i) => i.hash.toLowerCase()));
  const still: TimelineItem[] = [];
  for (const [h, item] of pendingOwn) {
    if (scanned.has(h)) {
      pendingOwn.delete(h);
    } else {
      still.push(item);
    }
  }
  if (still.length === 0) return fetched;
  still.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return [...still, ...fetched];
}

/**
 * Feed presentation rule (v0.4.0): LIKE actions (type 1) never
 * render as feed rows — not other people's likes, not the user's
 * own. This is display-only: the raw feed walk keeps returning
 * likes (the follow index, reaction lists and the my-actions
 * memory all still consume them), and like COUNTS on posts are
 * read from the contract as before. Both feeds apply this —
 * the Following walk already only collects posts and recaws,
 * so running its items through the same filter keeps the rule
 * uniform and provable in one place.
 */
export function visibleFeedItems(items: TimelineItem[]): TimelineItem[] {
  return items.filter((i) => i.type !== 1);
}

/** Pending own posts, newest first (tests / diagnostics). */
export function pendingOwnPosts(): TimelineItem[] {
  return [...pendingOwn.values()].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
}

/** Drop the store (tests). */
export function resetFeedSyncForTest(): void {
  pendingOwn.clear();
  listeners.clear();
}
