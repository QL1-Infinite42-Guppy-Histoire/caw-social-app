/**
 * SuperRecaw (v0.5.0) — a Recaw set apart in the feed,
 * paid for by burning exactly 1,000,000 O (QL1) with an
 * "SRC1" trailing-calldata marker naming the ORIGINAL post's
 * cawId (see lib/markedBurns.ts for the shared marked-burn
 * index and the O transfer verification).
 *
 * The order of operations mirrors the v0.4.9 SuperLike debt
 * discipline: the NORMAL Recaw action lands FIRST (it is the
 * visible act); only then is the O burn sent. If the burn
 * fails after the recaw landed, the debt is recorded here
 * (on-device KV) and the only retry offered sends the burn
 * alone — the retry path cannot build a second recaw. If the
 * recaw itself fails, nothing else runs.
 *
 * Display: a recaw row renders with the gold SuperRecaw
 * attribution line (flat X-style since v0.6.1; a gradient
 * frame + badge through v0.6.0) only when the index holds
 * an SRC1 mark for (original cawId, recawer's owner
 * address) — chain data only, never a local tally.
 */
import {
  SUPERRECAW_MAGIC,
  buildMarkedBurnData,
  hasSuperRecaw,
  normCawIdHex,
  superRecawCached,
} from './markedBurns';
import type { KVStorage } from './myActions';

export { SUPERRECAW_MAGIC };

/** The full transaction data for a SuperRecaw burn. */
export function buildSuperRecawData(cawId: string): string | null {
  return buildMarkedBurnData(SUPERRECAW_MAGIC, cawId);
}

/** Detection from completed scans (no network). */
export function superRecawCachedFor(cawId: string, sender: string): boolean {
  return superRecawCached(cawId, sender);
}

/** Scan, then answer whether the sender SuperRecaw'd the post. */
export function hasSuperRecawFor(
  cawId: string,
  sender: string,
): Promise<boolean> {
  return hasSuperRecaw(cawId, sender);
}

/* ---------- pending SuperRecaw burns ---------- */
/**
 * When the recaw has landed but its O burn has not, the pair
 * is owed a burn. That debt is recorded here so it survives
 * restarts and the retry can be offered honestly: the retry
 * sends ONLY the burn — the record's existence is the proof
 * the recaw already happened, and nothing in the retry path
 * can rebuild or resend the recaw.
 */
const KV_KEY = 'caw-superrecaw-burn-v1';

export interface PendingSrcBurn {
  /** The ORIGINAL post's cawId (0x + 64 hex). */
  cawId: string;
  /** Unix seconds when the recaw landed. */
  ts: number;
}

let kv: KVStorage | null = null;
let loaded: Promise<void> | null = null;
const records = new Map<string, PendingSrcBurn>();

export function initSuperRecawStore(storage: KVStorage): void {
  kv = storage;
}

function key(sender: string, cawId: string): string | null {
  const id = normCawIdHex(cawId);
  if (!id || !sender) return null;
  return sender.toLowerCase() + ':' + '0x' + id;
}

function ensureLoaded(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      if (!kv) return;
      try {
        const raw = await kv.getItem(KV_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, PendingSrcBurn>;
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v.cawId === 'string') records.set(k, v);
        }
      } catch {
        /* a corrupt record just means no pending burn is shown */
      }
    })();
  }
  return loaded;
}

async function persist(): Promise<void> {
  if (!kv) return;
  try {
    await kv.setItem(KV_KEY, JSON.stringify(Object.fromEntries(records)));
  } catch {
    /* the in-memory record still stands for this session */
  }
}

/** The pending SuperRecaw burn owed for one post by one sender. */
export async function pendingSrcBurnFor(
  sender: string,
  cawId: string,
): Promise<PendingSrcBurn | null> {
  const k = key(sender, cawId);
  if (!k) return null;
  await ensureLoaded();
  return records.get(k) ?? null;
}

/** Record that a recaw landed and its burn is now owed. */
export async function recordSrcBurn(
  sender: string,
  rec: PendingSrcBurn,
): Promise<void> {
  const k = key(sender, rec.cawId);
  if (!k) return;
  await ensureLoaded();
  records.set(k, rec);
  await persist();
}

/** Clear the debt once the burn has landed. */
export async function clearSrcBurn(
  sender: string,
  cawId: string,
): Promise<void> {
  const k = key(sender, cawId);
  if (!k) return;
  await ensureLoaded();
  if (records.delete(k)) await persist();
}
