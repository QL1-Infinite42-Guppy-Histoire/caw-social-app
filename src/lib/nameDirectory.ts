/**
 * Name directory — every CAW name on QL1, for partial-match search.
 *
 * A name is fixed at mint and never changes, so the directory is
 * append-only: once an id's name has been read it never needs
 * re-reading, and a later visit only fetches the ids minted since
 * (totalSupply is the watermark). The list is persisted on the
 * device through the injected KV store, so repeat searches are
 * instant.
 *
 * Names are read through usernames(id − 1) — the corrected slot,
 * which the mint records proved equal to the name on the token's
 * card (see readCardName in cawApi.ts). That read is a short string,
 * far cheaper than pulling every tokenURI (each carries a full SVG
 * card). The directory is a discovery index only: opening a result
 * goes through the profile screen, which resolves the name from the
 * card itself.
 *
 * Pure logic + injected storage, so it can be verified in Node
 * (see scripts/verify-follow.mjs).
 */
import { CAW_NAME, SEL } from '../config';
import { decStringRet, word } from './cawCore';
import { ethCallBatch, totalSupply } from './cawApi';
import type { KVStorage } from './myActions';

export interface NameEntry {
  id: bigint;
  name: string;
}

const DIR_KEY = 'caw-name-directory-v1';
const BATCH = 120;

let kv: KVStorage | null = null;
/** names[id] for id >= 1; index 0 unused. '' = not fetched yet. */
let names: string[] = [''];
/** Highest id with a fetched name (contiguous from 1). */
let fetchedUpTo = 0;
let loading: Promise<void> | null = null;
let hydrated = false;

export function initNameDirectory(storage: KVStorage): void {
  kv = storage;
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  if (!kv) return;
  try {
    const raw = await kv.getItem(DIR_KEY);
    if (!raw) return;
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.names) && typeof j.upTo === 'number') {
      names = [''].concat(j.names.slice(1).map((n: unknown) => String(n || '')));
      fetchedUpTo = Math.min(j.upTo, names.length - 1);
    }
  } catch {
    /* a broken cache just means a fresh scan */
  }
}

async function persist(): Promise<void> {
  if (!kv) return;
  try {
    await kv.setItem(
      DIR_KEY,
      JSON.stringify({ upTo: fetchedUpTo, names }),
    );
  } catch {
    /* persistence is an optimisation, never a blocker */
  }
}

export interface DirectoryProgress {
  done: number;
  total: number;
}

/**
 * Fetch every name not yet in the directory (batched RPC reads).
 * Safe to call repeatedly; concurrent calls share one run. Reports
 * progress as (fetched ids / current totalSupply).
 */
export function ensureDirectory(
  onProgress?: (p: DirectoryProgress) => void,
): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        await hydrate();
        const supply = Number(await totalSupply());
        if (onProgress) onProgress({ done: fetchedUpTo, total: supply });
        while (fetchedUpTo < supply) {
          const from = fetchedUpTo + 1;
          const to = Math.min(from + BATCH - 1, supply);
          const calls = [];
          for (let id = from; id <= to; id++) {
            calls.push({
              to: CAW_NAME,
              data: SEL.usernames + word(BigInt(id - 1)),
            });
          }
          const results = await ethCallBatch(calls);
          let advanced = fetchedUpTo;
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r === null) break; // stop the contiguous run here
            let n = '';
            try {
              n = decStringRet(r);
            } catch {
              n = '';
            }
            names[from + i] = n;
            advanced = from + i;
          }
          if (advanced === fetchedUpTo) break; // no progress — retry later
          fetchedUpTo = advanced;
          if (onProgress) onProgress({ done: fetchedUpTo, total: supply });
          if (advanced < to) break; // a gap appeared; next call resumes
        }
        await persist();
      } finally {
        loading = null;
      }
    })();
  }
  return loading;
}

export function directoryStatus(): DirectoryProgress & { ready: boolean } {
  return {
    done: fetchedUpTo,
    total: Math.max(fetchedUpTo, names.length - 1),
    ready: fetchedUpTo > 0,
  };
}

/** All fetched entries (id order). */
export function directoryEntries(): NameEntry[] {
  const out: NameEntry[] = [];
  for (let id = 1; id <= fetchedUpTo; id++) {
    if (names[id]) out.push({ id: BigInt(id), name: names[id] });
  }
  return out;
}

/**
 * Partial-match search over the fetched directory. Ranking: exact
 * match first, then prefix matches, then substring matches (each
 * group in id order). Case-insensitive; the query is trimmed.
 */
export function searchDirectory(query: string, limit = 50): NameEntry[] {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const exact: NameEntry[] = [];
  const prefix: NameEntry[] = [];
  const sub: NameEntry[] = [];
  for (let id = 1; id <= fetchedUpTo; id++) {
    const n = names[id];
    if (!n) continue;
    const ln = n.toLowerCase();
    if (ln === q) exact.push({ id: BigInt(id), name: n });
    else if (ln.startsWith(q)) prefix.push({ id: BigInt(id), name: n });
    else if (ln.includes(q)) sub.push({ id: BigInt(id), name: n });
    if (exact.length + prefix.length + sub.length > limit * 4) break;
  }
  return [...exact, ...prefix, ...sub].slice(0, limit);
}

/** Drop the in-memory directory (tests / a fresh start). */
export function resetDirectoryForTest(): void {
  names = [''];
  fetchedUpTo = 0;
  loading = null;
  hydrated = false;
}
