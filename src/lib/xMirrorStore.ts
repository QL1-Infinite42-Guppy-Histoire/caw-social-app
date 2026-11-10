/**
 * X mirror — the on-device record for one X account
 * (v0.5.0-x).
 *
 * Three things live in one KV record per X account:
 *  - `map`: X post id → cawId for everything ENGRAVED. The
 *    app is the source of truth for engraved state — the
 *    Worker only remembers what it has NOTIFIED about and
 *    can never mark anything engraved.
 *  - `cache`: the mirror-candidate posts fetched so far
 *    (newest first, capped). This is what makes cheap polls
 *    possible: once a post has been fetched once, it never
 *    needs fetching again just to sit in the inbox.
 *  - `wm` (watermark): the newest X post id ever fetched.
 *    Later fetches pass it as `since_id`, so a check that
 *    finds nothing new returns an empty page — and X reads
 *    are pay-per-use ($0.001 per returned post for your own
 *    posts), so an idle check costs exactly zero.
 *
 * Pure logic + injected storage, like MyActionStore, so the
 * Node harness can verify it.
 */
import type { KVStorage } from './myActions';
import { maxPostId, type XPost } from './xmirror';

export interface EngravedMap {
  [xPostId: string]: string; // → cawId (0x…)
}

const CACHE_CAP = 200;

interface StoredRecord {
  map: EngravedMap;
  cache: XPost[];
  wm: string | null;
}

function emptyRecord(): StoredRecord {
  return { map: {}, cache: [], wm: null };
}

function cleanMap(v: unknown): EngravedMap {
  const out: EngravedMap = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
  }
  return out;
}

function cleanCache(v: unknown): XPost[] {
  if (!Array.isArray(v)) return [];
  const out: XPost[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.id === 'string' && typeof p.text === 'string') {
      out.push({
        id: p.id,
        text: p.text,
        createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
      });
    }
  }
  return out.slice(0, CACHE_CAP);
}

export class XMirrorStore {
  private rec: StoredRecord = emptyRecord();
  private kv: KVStorage | null = null;
  private storageKey: string | null = null;
  private listeners = new Set<() => void>();
  version = 0;

  /** Load the record for one X account. A different account
   *  gets a clean record — nothing leaks across accounts. A
   *  legacy flat engraved map (the first build's shape) is
   *  still read as the map. */
  async init(kv: KVStorage, xUserId: string): Promise<void> {
    this.kv = kv;
    this.storageKey = 'caw-xmirror-engraved-' + xUserId;
    this.rec = emptyRecord();
    try {
      const raw = await kv.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const p = parsed as Record<string, unknown>;
          if ('map' in p || 'cache' in p || 'wm' in p) {
            this.rec = {
              map: cleanMap(p.map),
              cache: cleanCache(p.cache),
              wm: typeof p.wm === 'string' ? p.wm : null,
            };
          } else {
            this.rec = { map: cleanMap(p), cache: [], wm: null };
          }
        }
      }
    } catch {
      /* a broken record means "nothing known yet", never a crash */
    }
    this.bump();
  }

  private async persist(): Promise<void> {
    if (this.kv && this.storageKey) {
      await this.kv.setItem(this.storageKey, JSON.stringify(this.rec));
    }
  }

  private bump(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /* ---------------- engraved map ---------------- */

  has(xPostId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.rec.map, xPostId);
  }

  cawIdOf(xPostId: string): string | null {
    return this.rec.map[xPostId] ?? null;
  }

  ids(): Set<string> {
    return new Set(Object.keys(this.rec.map));
  }

  snapshot(): EngravedMap {
    return { ...this.rec.map };
  }

  /** Record one engraving. Called ONLY after the CAW post's
   *  transaction has confirmed (submitAction resolves on the
   *  receipt) — a failed post must stay in the inbox. */
  async record(xPostId: string, cawId: string): Promise<void> {
    if (this.has(xPostId)) return;
    this.rec = { ...this.rec, map: { ...this.rec.map, [xPostId]: cawId } };
    this.bump();
    await this.persist();
  }

  /* ---------------- candidate cache + watermark ---------------- */

  /** The newest post id ever fetched for this account — the
   *  `since_id` for the next fetch. Null until the first
   *  (full-window) fetch. */
  watermark(): string | null {
    return this.rec.wm;
  }

  /** Every candidate post fetched so far, newest first. */
  cachedPosts(): XPost[] {
    return [...this.rec.cache];
  }

  /**
   * Merge freshly fetched posts into the cache (new copies
   * win, order stays newest-first as fetched) and advance
   * the watermark to the newest post ever seen. Called with
   * each fetch — including an empty one (a no-op merge, so
   * an idle since_id check records nothing and costs
   * nothing).
   */
  async mergeFetched(posts: XPost[]): Promise<void> {
    if (posts.length === 0) return;
    const freshIds = new Set(posts.map((p) => p.id));
    const merged = [
      ...posts,
      ...this.rec.cache.filter((p) => !freshIds.has(p.id)),
    ].slice(0, CACHE_CAP);
    const newest = maxPostId(posts);
    let wm = this.rec.wm;
    if (newest !== null) {
      if (wm === null) wm = newest;
      else {
        try {
          if (BigInt(newest) > BigInt(wm)) wm = newest;
        } catch {
          wm = newest;
        }
      }
    }
    this.rec = { ...this.rec, cache: merged, wm };
    this.bump();
    await this.persist();
  }

  /** Forget everything (X disconnect): the next account — or
   *  the same one reconnected — starts from a clean record,
   *  and its posts are offered again. */
  async reset(): Promise<void> {
    this.rec = emptyRecord();
    this.bump();
    await this.persist();
  }
}
