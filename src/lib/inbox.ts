/**
 * Reactions inbox (v0.2.0) — "who reacted to me", gathered on the
 * phone. There is no server and there are no push notifications:
 * this module walks the same public action feed the timeline uses
 * and picks out the likes / shares aimed at MY names' posts and
 * the follows / unfollows aimed at my names, newer than the read
 * position the phone remembers. The UI says exactly that.
 *
 * Read position = (block, index) of the newest feed item the user
 * has already been shown here, stored per wallet address.
 */

import type { KVStorage } from './myActions';
import { fetchTimelinePage, type TimelineItem } from './cawApi';

export interface SeenMark {
  b: number;
  i: number;
}

export interface Reaction {
  /** 1 like / 2 share / 3 follow / 4 unfollow */
  kind: 1 | 2 | 3 | 4;
  actorId: bigint;
  ts: number;
  hash: string;
  /** For likes/shares: the post of mine that was reacted to. */
  post?: TimelineItem;
  /** For follows/unfollows: which of my names was targeted. */
  targetNameId?: bigint;
}

const seenKey = (address: string) =>
  'caw-inbox-seen-' + address.toLowerCase();

export async function loadSeen(
  kv: KVStorage,
  address: string,
): Promise<SeenMark | null> {
  try {
    const raw = await kv.getItem(seenKey(address));
    if (!raw) return null;
    const m = JSON.parse(raw) as SeenMark;
    return typeof m.b === 'number' ? m : null;
  } catch {
    return null;
  }
}

export async function saveSeen(
  kv: KVStorage,
  address: string,
  mark: SeenMark,
): Promise<void> {
  try {
    await kv.setItem(seenKey(address), JSON.stringify(mark));
  } catch {
    /* ignore */
  }
}

const posOf = (it: TimelineItem): SeenMark => ({
  b: it.block ?? 0,
  i: it.txIndex ?? 0,
});
const isAfter = (p: SeenMark, seen: SeenMark | null): boolean =>
  !seen || p.b > seen.b || (p.b === seen.b && p.i > seen.i);

/**
 * Walk the feed from the newest item down to (and including) the
 * read position, collecting reactions to `myIds`. Posts by my
 * names are indexed as they pass so likes/shares pointing at them
 * can be matched even when the reaction is newer than the post
 * (reactions are buffered until their post shows up — or the walk
 * ends, in which case an unmatched reaction is dropped rather than
 * shown without its post).
 *
 * `maxPages` bounds the walk; `capped` reports that the bound (not
 * the read position or the end of the feed) stopped it.
 */
export async function scanReactions(
  myIds: Set<string>,
  seen: SeenMark | null,
  maxPages = 40,
): Promise<{
  items: Reaction[];
  newest: SeenMark | null;
  capped: boolean;
}> {
  const items: Reaction[] = [];
  const myPosts = new Map<string, TimelineItem>();
  const buffered: TimelineItem[] = [];
  let cursor: Record<string, unknown> | null = null;
  let newest: SeenMark | null = null;
  let capped = false;

  const flushBuffered = () => {
    for (let k = buffered.length - 1; k >= 0; k--) {
      const it = buffered[k];
      const post = myPosts.get(it.cawId);
      if (post) {
        items.push({
          kind: it.type as 1 | 2,
          actorId: it.senderId,
          ts: it.ts,
          hash: it.hash,
          post,
        });
        buffered.splice(k, 1);
      }
    }
  };

  for (let page = 0; page < maxPages; page++) {
    const { items: pageItems, next } = await fetchTimelinePage(cursor);
    if (pageItems.length === 0) break;
    if (!newest) newest = posOf(pageItems[0]);
    let passedSeen = false;
    for (const it of pageItems) {
      const pos = posOf(it);
      if (!isAfter(pos, seen)) {
        passedSeen = true;
        break;
      }
      if (it.type === 0 && myIds.has(it.senderId.toString())) {
        if (!myPosts.has(it.cawId)) myPosts.set(it.cawId, it);
      } else if (
        (it.type === 1 || it.type === 2) &&
        !myIds.has(it.senderId.toString())
      ) {
        buffered.push(it);
      } else if (
        (it.type === 3 || it.type === 4) &&
        myIds.has(it.receiverId.toString()) &&
        !myIds.has(it.senderId.toString())
      ) {
        items.push({
          kind: it.type as 3 | 4,
          actorId: it.senderId,
          ts: it.ts,
          hash: it.hash,
          targetNameId: it.receiverId,
        });
      }
    }
    flushBuffered();
    if (passedSeen || !next) {
      cursor = next;
      break;
    }
    cursor = next;
    if (page === maxPages - 1) capped = true;
  }
  flushBuffered();
  items.sort((a, b) => b.ts - a.ts);
  return { items, newest, capped };
}
