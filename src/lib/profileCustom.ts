/**
 * Off-chain profile customization (v0.1.1, user-approved): a display
 * name, a profile picture, a header picture and (v0.4.5) a short bio
 * text that live ONLY on this device. Usernames on the chain are
 * fixed at mint and never change —
 * this store never touches chain data; it only changes how this phone
 * shows the user's own names.
 *
 * Stored per name token id in one AsyncStorage object. Image values
 * are file URIs of copies kept in the app's document directory (the
 * copying itself lives in profileImage.ts, which is React-Native-only;
 * this module is pure so it can be verified in Node).
 */

import type { KVStorage } from './myActions';

export interface ProfileCustom {
  displayName?: string;
  /** file:// URI of the stored profile picture copy */
  avatarPath?: string;
  /** file:// URI of the stored header picture copy */
  headerPath?: string;
  /** Short self-introduction text for this name (v0.4.5). Like the
   *  other fields it lives only on this device — the chain has no
   *  bio field — and it is keyed per name token id, like the rest. */
  bio?: string;
}

const STORAGE_KEY = 'caw-profile-customs';

export function hasCustom(c: ProfileCustom | undefined | null): boolean {
  return !!(c && (c.displayName || c.avatarPath || c.headerPath || c.bio));
}

/** The name to show: the custom display name when set, else "@username". */
export function displayLabel(
  c: ProfileCustom | undefined | null,
  username: string,
): string {
  if (c && c.displayName) return c.displayName;
  return username ? '@' + username : '';
}

export class ProfileCustomStore {
  private map = new Map<string, ProfileCustom>();
  private listeners = new Set<() => void>();
  private kv: KVStorage | null = null;
  version = 0;

  async init(kv: KVStorage): Promise<void> {
    this.kv = kv;
    this.map = new Map();
    try {
      const raw = await kv.getItem(STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj)) {
            if (v && typeof v === 'object') {
              const c = v as ProfileCustom;
              const clean: ProfileCustom = {};
              if (typeof c.displayName === 'string' && c.displayName)
                clean.displayName = c.displayName;
              if (typeof c.avatarPath === 'string' && c.avatarPath)
                clean.avatarPath = c.avatarPath;
              if (typeof c.headerPath === 'string' && c.headerPath)
                clean.headerPath = c.headerPath;
              if (typeof c.bio === 'string' && c.bio) clean.bio = c.bio;
              if (hasCustom(clean)) this.map.set(k, clean);
            }
          }
        }
      }
    } catch {
      /* corrupt data — start clean rather than break the app */
    }
    this.emit();
  }

  reset(): void {
    this.map = new Map();
    this.kv = null;
    this.emit();
  }

  get(id: bigint): ProfileCustom | undefined {
    return this.map.get(id.toString());
  }

  /** Merge a patch into one name's custom look. Empty strings remove a field. */
  async set(id: bigint, patch: Partial<ProfileCustom>): Promise<ProfileCustom> {
    const key = id.toString();
    const next: ProfileCustom = { ...(this.map.get(key) || {}) };
    if (patch.displayName !== undefined) {
      if (patch.displayName) next.displayName = patch.displayName;
      else delete next.displayName;
    }
    if (patch.avatarPath !== undefined) {
      if (patch.avatarPath) next.avatarPath = patch.avatarPath;
      else delete next.avatarPath;
    }
    if (patch.headerPath !== undefined) {
      if (patch.headerPath) next.headerPath = patch.headerPath;
      else delete next.headerPath;
    }
    if (patch.bio !== undefined) {
      if (patch.bio) next.bio = patch.bio;
      else delete next.bio;
    }
    if (hasCustom(next)) this.map.set(key, next);
    else this.map.delete(key);
    await this.persist();
    this.emit();
    return next;
  }

  /** Remove one name's customization entirely. Returns the removed entry. */
  async clear(id: bigint): Promise<ProfileCustom | undefined> {
    const key = id.toString();
    const old = this.map.get(key);
    if (!old) return undefined;
    this.map.delete(key);
    await this.persist();
    this.emit();
    return old;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private async persist(): Promise<void> {
    if (!this.kv) return;
    try {
      const obj: Record<string, ProfileCustom> = {};
      for (const [k, v] of this.map) obj[k] = v;
      await this.kv.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {
      /* ignore — the in-memory value still applies for this session */
    }
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}
