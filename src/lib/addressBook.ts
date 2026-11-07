/**
 * Address book (v0.3.5) — frequently used send destinations.
 *
 * On-device only: entries live in one AsyncStorage record (via the
 * injected KV), shared across wallets because destinations are
 * external (an exchange, a second account, …), not per-wallet.
 * Addresses are public data; labels are free text the user types
 * and never leave the phone.
 *
 * Pure logic + injected storage (same pattern as MyActionStore),
 * so scripts/verify-send.mjs can test add/edit/delete, duplicate
 * prevention and the persistence round-trip in node.
 */
import { getAddress, isAddress } from 'ethers';

import type { KVStorage } from './myActions';

export interface BookEntry {
  label: string;
  /** Checksummed EVM address. */
  address: string;
  addedAt: number;
}

export const ADDRESS_BOOK_KEY = 'caw-address-book-v1';

const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

export class AddressBookStore {
  private kv: KVStorage | null = null;
  private entries: BookEntry[] = [];
  private initPromise: Promise<void> | null = null;

  /** Idempotent: safe to call from any screen, any number of times. */
  init(kv: KVStorage): Promise<void> {
    if (!this.initPromise) {
      this.kv = kv;
      this.initPromise = (async () => {
        try {
          const raw = await kv.getItem(ADDRESS_BOOK_KEY);
          if (!raw) return;
          const parsed = JSON.parse(raw) as BookEntry[];
          if (!Array.isArray(parsed)) return;
          this.entries = parsed.filter(
            (e) =>
              e &&
              typeof e.label === 'string' &&
              typeof e.address === 'string' &&
              isAddress(e.address),
          );
        } catch {
          /* a corrupt record reads as an empty book, never a crash */
        }
      })();
    }
    return this.initPromise;
  }

  private async persist(): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.setItem(ADDRESS_BOOK_KEY, JSON.stringify(this.entries));
    } catch {
      /* storage hiccups must not break the send flow */
    }
  }

  list(): BookEntry[] {
    return [...this.entries];
  }

  find(address: string): BookEntry | undefined {
    return this.entries.find((e) => sameAddress(e.address, address));
  }

  /**
   * Register a destination. Throws Error('bad-label') for an empty
   * label, Error('bad-address') for an invalid address, and
   * Error('duplicate') when the address is already registered
   * (compared case-insensitively) — the caller points the user at
   * the existing entry via find().
   */
  async add(label: string, address: string): Promise<BookEntry> {
    const name = label.trim();
    if (!name) throw new Error('bad-label');
    const trimmed = address.trim();
    if (!isAddress(trimmed)) throw new Error('bad-address');
    const checksummed = getAddress(trimmed);
    if (this.find(checksummed)) throw new Error('duplicate');
    const entry: BookEntry = {
      label: name,
      address: checksummed,
      addedAt: Date.now(),
    };
    this.entries = [...this.entries, entry];
    await this.persist();
    return entry;
  }

  /** Change the label of a registered address. */
  async update(address: string, label: string): Promise<void> {
    const name = label.trim();
    if (!name) throw new Error('bad-label');
    const found = this.find(address);
    if (!found) throw new Error('not-found');
    found.label = name;
    this.entries = [...this.entries];
    await this.persist();
  }

  /** Remove a registered address (no-op when absent). */
  async remove(address: string): Promise<void> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !sameAddress(e.address, address));
    if (this.entries.length !== before) await this.persist();
  }
}
