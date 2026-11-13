/**
 * Author payments — the plain-transfer leg of a SuperLike
 * and of a SuperRecaw (v0.6.3), and the on-device debt
 * record for when that leg fails after the rest of the
 * action already landed.
 *
 * Since v0.6.3 (user decision 2026-11-13) both actions cost
 * 25,000,000 O in total: a marked BURN leg (see
 * lib/markedBurns.ts) plus a plain, UNMARKED O transfer to
 * the post's author — 15,000,000 O for a SuperLike,
 * 5,000,000 O for a SuperRecaw. The author leg carries no
 * marker and is never counted; it is money owed to a person,
 * so when it fails after the defining leg (the burn, or the
 * Recaw + burn) already landed, the debt is recorded here
 * and the only retry offered sends the transfer alone —
 * the same discipline as the SuperRecaw burn debt
 * (lib/superRecaw.ts), extended to the payment side.
 *
 * The record pins the recipient (the author's owner address
 * AS RESOLVED WHEN THE ACTION WAS TAKEN), the amount and
 * the post. It survives restarts (on-device KV) and clears
 * only when the transfer itself confirms.
 */
import { Interface } from 'ethers';

import {
  SUPERLIKE_AUTHOR_RAW,
  SUPERRECAW_AUTHOR_RAW,
  normCawIdHex,
} from './markedBurns';
import type { KVStorage } from './myActions';

/** Which action owes the payment. */
export type AuthorPayKind = 'sl' | 'src';

/** The author leg's amount for an action kind (the one
 *  source of truth stays in lib/markedBurns.ts). */
export function authorPayAmountFor(kind: AuthorPayKind): bigint {
  return kind === 'sl' ? SUPERLIKE_AUTHOR_RAW : SUPERRECAW_AUTHOR_RAW;
}

const ERC20_IFACE = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/**
 * Plain O transfer calldata for an author payment: an
 * ordinary transfer, NO marker — deliberately
 * indistinguishable from any other O transfer, because the
 * marker/counting convention belongs to the burn leg only.
 */
export function buildAuthorPayData(to: string, amountRaw: bigint): string {
  return ERC20_IFACE.encodeFunctionData('transfer', [to, amountRaw]);
}

/* ---------- pending author payments ---------- */

const KV_KEY = 'caw-author-pay-v1';

export interface PendingAuthorPay {
  /** The post's cawId (0x + 64 hex). */
  cawId: string;
  /**
   * The author's owner address, pinned when the action was
   * taken. May be '' when it could not be resolved at that
   * moment — the retry then resolves it fresh from the post.
   */
  author: string;
  /** The owed amount, raw units (18 decimals). */
  amountRaw: bigint;
  /** Unix seconds when the debt was recorded. */
  ts: number;
}

interface StoredPay {
  cawId: string;
  author: string;
  /** Raw amount as a decimal string (JSON has no bigint). */
  amount: string;
  ts: number;
}

let kv: KVStorage | null = null;
let loaded: Promise<void> | null = null;
const records = new Map<string, PendingAuthorPay>();

export function initAuthorPayStore(storage: KVStorage): void {
  kv = storage;
}

function key(sender: string, kind: AuthorPayKind, cawId: string): string | null {
  const id = normCawIdHex(cawId);
  if (!id || !sender) return null;
  return sender.toLowerCase() + ':' + kind + ':' + '0x' + id;
}

function ensureLoaded(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      if (!kv) return;
      try {
        const raw = await kv.getItem(KV_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, StoredPay>;
        for (const [k, v] of Object.entries(parsed)) {
          if (!v || typeof v.cawId !== 'string') continue;
          try {
            records.set(k, {
              cawId: v.cawId,
              author: typeof v.author === 'string' ? v.author : '',
              amountRaw: BigInt(v.amount),
              ts: typeof v.ts === 'number' ? v.ts : 0,
            });
          } catch {
            /* a record with an unreadable amount is dropped */
          }
        }
      } catch {
        /* a corrupt record just means no pending payment is shown */
      }
    })();
  }
  return loaded;
}

async function persist(): Promise<void> {
  if (!kv) return;
  try {
    const out: Record<string, StoredPay> = {};
    for (const [k, v] of records) {
      out[k] = {
        cawId: v.cawId,
        author: v.author,
        amount: v.amountRaw.toString(),
        ts: v.ts,
      };
    }
    await kv.setItem(KV_KEY, JSON.stringify(out));
  } catch {
    /* the in-memory record still stands for this session */
  }
}

/** The pending author payment owed for one post by one sender. */
export async function pendingAuthorPayFor(
  sender: string,
  kind: AuthorPayKind,
  cawId: string,
): Promise<PendingAuthorPay | null> {
  const k = key(sender, kind, cawId);
  if (!k) return null;
  await ensureLoaded();
  return records.get(k) ?? null;
}

/** Record that an action landed but its author payment did not. */
export async function recordAuthorPay(
  sender: string,
  kind: AuthorPayKind,
  rec: PendingAuthorPay,
): Promise<void> {
  const k = key(sender, kind, rec.cawId);
  if (!k) return;
  await ensureLoaded();
  records.set(k, rec);
  await persist();
}

/** Clear the debt once the payment has landed. */
export async function clearAuthorPay(
  sender: string,
  kind: AuthorPayKind,
  cawId: string,
): Promise<void> {
  const k = key(sender, kind, cawId);
  if (!k) return;
  await ensureLoaded();
  if (records.delete(k)) await persist();
}
