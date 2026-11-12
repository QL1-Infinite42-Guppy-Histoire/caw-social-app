/**
 * Bookmarks — posts THIS wallet saved, remembered on the
 * device (v0.6.0, X-style overhaul).
 *
 * CAW has no on-chain bookmark action, so — exactly like the
 * "my actions" memory (lib/myActions.ts) — the list lives
 * only on this phone: an AsyncStorage list of post cawIds,
 * newest first, scoped per WALLET ADDRESS (the same scope
 * the my-actions store uses). Nothing is signed or sent;
 * removing the app or the wallet forgets the list.
 *
 * The store keeps cawIds, never post content: the Bookmarks
 * screen resolves each id against the live chain readers
 * (findPostByCawId), so what renders is the post as it stands
 * now. An id that no longer resolves renders an honest
 * placeholder row there, not a cached copy here.
 *
 * Pure logic + injected storage (same KVStorage shape as
 * myActions) so it can be verified in Node
 * (scripts/verify-xui.mjs).
 */
import type { KVStorage } from './myActions';

const KEY_PREFIX = 'caw-bookmarks-v1-';

export const bookmarkStorageKey = (address: string): string =>
  KEY_PREFIX + address.toLowerCase();

/** Normalise a cawId for storage/comparison: lowercase hex,
 *  no 0x prefix assumptions — ids arrive as the feed spells
 *  them ('0x…' from the chain, bare hex in markers). */
export function normBookmarkId(cawId: string): string {
  return (cawId || '').trim().toLowerCase();
}

export class BookmarkStore {
  /** Newest first. */
  private ids: string[] = [];
  private listeners = new Set<() => void>();
  private kv: KVStorage | null = null;
  private storageKey: string | null = null;
  /** Monotonic version for subscribe-style consumers. */
  version = 0;

  async init(kv: KVStorage, address: string): Promise<void> {
    this.kv = kv;
    this.storageKey = bookmarkStorageKey(address);
    this.ids = [];
    try {
      const raw = await kv.getItem(this.storageKey);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          const seen = new Set<string>();
          for (const v of arr) {
            if (typeof v !== 'string') continue;
            const id = normBookmarkId(v);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            this.ids.push(id);
          }
        }
      }
    } catch {
      /* a corrupt store must never break the app — start empty */
    }
    this.emit();
  }

  reset(): void {
    this.ids = [];
    this.kv = null;
    this.storageKey = null;
    this.emit();
  }

  has(cawId: string): boolean {
    return this.ids.includes(normBookmarkId(cawId));
  }

  /** The saved cawIds, newest first (a copy). */
  list(): string[] {
    return [...this.ids];
  }

  /**
   * Toggle one post. Returns the NEW state (true = now
   * bookmarked). Persists and notifies. Adding puts the id
   * at the head (newest first); removing drops it wherever
   * it sat.
   */
  async toggle(cawId: string): Promise<boolean> {
    const id = normBookmarkId(cawId);
    if (!id) return false;
    const at = this.ids.indexOf(id);
    let now: boolean;
    if (at >= 0) {
      this.ids.splice(at, 1);
      now = false;
    } else {
      this.ids.unshift(id);
      now = true;
    }
    await this.persist();
    this.emit();
    return now;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private async persist(): Promise<void> {
    if (!this.kv || !this.storageKey) return;
    try {
      await this.kv.setItem(this.storageKey, JSON.stringify(this.ids));
    } catch {
      /* storage trouble must not break the toggle itself */
    }
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}
