/**
 * Compose drafts (v0.2.0) — kept on this phone only, one per wallet
 * address. The composer auto-saves as you type, restores the draft
 * when it is reopened, and clears it once the post is sent. Nothing
 * about a draft ever leaves the device.
 */

import type { KVStorage } from './myActions';

export interface Draft {
  text: string;
  /** Acting name the draft was written under (display only). */
  actingId: string | null;
  savedAt: number;
}

let kv: KVStorage | null = null;
const keyFor = (address: string) =>
  'caw-draft-' + address.toLowerCase();

export function initDrafts(storage: KVStorage): void {
  kv = storage;
}

export async function loadDraft(address: string): Promise<Draft | null> {
  if (!kv || !address) return null;
  try {
    const raw = await kv.getItem(keyFor(address));
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return d && typeof d.text === 'string' ? d : null;
  } catch {
    return null;
  }
}

export async function saveDraft(
  address: string,
  draft: Draft,
): Promise<void> {
  if (!kv || !address) return;
  try {
    await kv.setItem(keyFor(address), JSON.stringify(draft));
  } catch {
    /* a draft that fails to save is not worth an error */
  }
}

export async function clearDraft(address: string): Promise<void> {
  if (!kv || !address) return;
  try {
    // The KV adapter has no remove in every build; storing an empty
    // text is equivalent (the composer treats it as no draft).
    await kv.setItem(
      keyFor(address),
      JSON.stringify({ text: '', actingId: null, savedAt: 0 } as Draft),
    );
  } catch {
    /* ignore */
  }
}
