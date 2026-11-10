/**
 * X mirror — the on-device record of what has been engraved
 * (v0.5.0-x).
 *
 * The app is the source of truth for engraved state: when a
 * mirror post lands on CAW, the mapping X post id → CAW cawId
 * is written here, per X account. The mirror inbox is "what X
 * returned" minus "what this store holds" — so a post can
 * never be offered twice, and the Worker (which only remembers
 * what it has NOTIFIED about) can never mark anything
 * engraved. Pure logic + injected storage, like MyActionStore,
 * so the Node harness can verify it.
 */
import type { KVStorage } from './myActions';

export interface EngravedMap {
  [xPostId: string]: string; // → cawId (0x…)
}

export class XMirrorStore {
  private map: EngravedMap = {};
  private kv: KVStorage | null = null;
  private storageKey: string | null = null;
  private listeners = new Set<() => void>();
  version = 0;

  /** Load the mapping for one X account. A different account
   *  gets a clean map — engraved state never leaks across
   *  accounts. */
  async init(kv: KVStorage, xUserId: string): Promise<void> {
    this.kv = kv;
    this.storageKey = 'caw-xmirror-engraved-' + xUserId;
    this.map = {};
    try {
      const raw = await kv.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const clean: EngravedMap = {};
          for (const [k, v] of Object.entries(
            parsed as Record<string, unknown>,
          )) {
            if (typeof v === 'string') clean[k] = v;
          }
          this.map = clean;
        }
      }
    } catch {
      /* a broken record means "nothing engraved yet", never a crash */
    }
    this.bump();
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

  has(xPostId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.map, xPostId);
  }

  cawIdOf(xPostId: string): string | null {
    return this.map[xPostId] ?? null;
  }

  ids(): Set<string> {
    return new Set(Object.keys(this.map));
  }

  snapshot(): EngravedMap {
    return { ...this.map };
  }

  /** Record one engraving. Called ONLY after the CAW post's
   *  transaction has confirmed (submitAction resolves on the
   *  receipt) — a failed post must stay in the inbox. */
  async record(xPostId: string, cawId: string): Promise<void> {
    if (this.has(xPostId)) return;
    this.map = { ...this.map, [xPostId]: cawId };
    this.bump();
    if (this.kv && this.storageKey) {
      await this.kv.setItem(this.storageKey, JSON.stringify(this.map));
    }
  }

  /** Forget everything (X disconnect): the next account — or
   *  the same one reconnected — starts from the chain's own
   *  truth, and its posts are offered again. */
  async reset(): Promise<void> {
    this.map = {};
    this.bump();
    if (this.kv && this.storageKey) {
      await this.kv.setItem(this.storageKey, '{}');
    }
  }
}
