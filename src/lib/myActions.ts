/**
 * "My actions" — which posts THIS wallet has liked / shared, and which
 * names it has followed, remembered on the device.
 *
 * Why this exists (v0.1.1 fix): the chain records like/share/follow
 * actions, but CawActions offers no "did name X like post Y" read, and
 * v0.1.0 kept no state at all — the like button never lit up and nothing
 * survived a reload. So the app remembers its own actions locally:
 * optimistic the moment the user confirms, persisted per wallet
 * address, and also seeded by watching the public feed for actions
 * whose sender is one of the wallet's own names (so actions taken
 * before this version, or from another device, light up too once they
 * scroll by).
 *
 * Keys are `${kind}:${actingTokenId}:${target}` where target is the
 * post's cawId for like (1) / share (2), and the followed name's token
 * id for follow (3). Pure logic + injected storage so it can be
 * verified in Node (see scripts/verify-fixes.mjs).
 */

export interface KVStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export type MyActionKind = 1 | 2 | 3;

export function myActionKey(
  kind: MyActionKind,
  actingId: bigint,
  target: string,
): string {
  return kind + ':' + actingId.toString() + ':' + String(target).toLowerCase();
}

interface ObservedAction {
  type: number;
  senderId: bigint;
  receiverId: bigint;
  cawId: string;
}

export class MyActionStore {
  private entries = new Set<string>();
  private ownIds = new Set<string>();
  private listeners = new Set<() => void>();
  private kv: KVStorage | null = null;
  private storageKey: string | null = null;
  /** Monotonic version for useSyncExternalStore-style subscriptions. */
  version = 0;

  async init(kv: KVStorage, address: string): Promise<void> {
    this.kv = kv;
    this.storageKey = 'caw-myactions-' + address.toLowerCase();
    this.entries = new Set();
    try {
      const raw = await kv.getItem(this.storageKey);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          for (const k of arr) if (typeof k === 'string') this.entries.add(k);
        }
      }
    } catch {
      /* a corrupt store must never break the app — start empty */
    }
    this.emit();
  }

  reset(): void {
    this.entries = new Set();
    this.ownIds = new Set();
    this.kv = null;
    this.storageKey = null;
    this.emit();
  }

  registerOwnIds(ids: bigint[]): void {
    for (const id of ids) this.ownIds.add(id.toString());
  }

  has(kind: MyActionKind, actingId: bigint | null, target: string): boolean {
    if (actingId === null) return false;
    return this.entries.has(myActionKey(kind, actingId, target));
  }

  /** Set (or clear) one entry. Persists and notifies. */
  async set(
    kind: MyActionKind,
    actingId: bigint,
    target: string,
    on: boolean,
  ): Promise<void> {
    const key = myActionKey(kind, actingId, target);
    const had = this.entries.has(key);
    if (on === had) return;
    if (on) this.entries.add(key);
    else this.entries.delete(key);
    await this.persist();
    this.emit();
  }

  /**
   * Seed from a decoded feed action: if one of this wallet's own names
   * liked / shared / followed something, remember it. Fire-and-forget.
   */
  observe(a: ObservedAction): void {
    if (!this.ownIds.has(a.senderId.toString())) return;
    let key: string | null = null;
    if (a.type === 1 || a.type === 2) {
      key = myActionKey(a.type, a.senderId, a.cawId);
    } else if (a.type === 3) {
      key = myActionKey(3, a.senderId, a.receiverId.toString());
    } else if (a.type === 4) {
      // An unfollow by one of my names (e.g. sent from another
      // client) clears the remembered follow.
      const k = myActionKey(3, a.senderId, a.receiverId.toString());
      if (this.entries.delete(k)) {
        void this.persist();
        this.emit();
      }
      return;
    }
    if (!key || this.entries.has(key)) return;
    this.entries.add(key);
    void this.persist();
    this.emit();
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
      await this.kv.setItem(this.storageKey, JSON.stringify([...this.entries]));
    } catch {
      /* storage trouble must not break the action itself */
    }
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}
