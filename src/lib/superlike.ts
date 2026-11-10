/**
 * SuperLike （超いいね) — an app-original feature (v0.4.8),
 * NOT a CAW protocol action. Since v0.5.0 a SuperLike is a
 * premium option paid for by BURNING O: one SuperLike burns
 * exactly 1,000,000 O (the QL1 token "Childhoods End" at
 * 0x6c39…bbEd4 — a QL1 contract; it has no code on 42 Chain)
 * to the burn address, with the post binding carried as
 * trailing calldata, and the post shows a ⭐ count tallied
 * from those marked burns (see lib/markedBurns.ts for the
 * shared index and the pre-design verification of O's
 * transfer behaviour: identical eth_call success with the
 * marker, a gas delta of exactly the intrinsic calldata
 * charge, and no transfer tax in 36 sampled real transfers).
 *
 * History: v0.4.8 shipped a 100 CAT42 marked tip to the
 * author; v0.4.9 repriced it to 1,000 CAT42 (500 to the author
 * + 500 burned, two legs, with a pending-burn debt store for
 * a burn leg that failed after the author leg landed). NO
 * SuperLike was ever sent at either CAT42 price (the count
 * scans verified 0 throughout), so v0.5.0 replaces the design
 * cleanly: the CAT42 send path, its sheets and the debt store
 * are gone. CAT42 itself is now only the tip currency
 * (lib/tip.ts). A SuperLike is ONE burn transaction — if it
 * fails, nothing happened and the user simply retries.
 *
 * Other clients see a plain O burn; only this app reads the
 * marker. The convention is documented in the repo README
 * next to the reply/quote convention.
 */
import { O_TOKEN, SEL } from '../config';
import { ethCall } from './cawApi';
import { decUintRet, encAddr } from './cawCore';
import {
  MARKED_BURN_PRICE_O,
  MARKED_BURN_PRICE_RAW,
  SUPERLIKE_MAGIC,
  buildMarkedBurnData,
  initMarkedBurnStore,
  parseMarkedBurnInput,
  refreshMarkedBurns,
  subscribeMarkedBurns,
  superlikeCount as mbSuperlikeCount,
  superlikeCountCached as mbSuperlikeCountCached,
  type MarkedBurnMark,
} from './markedBurns';
import type { KVStorage } from './myActions';

/** The fixed price of one SuperLike: 1,000,000 O, burned. */
export const SUPERLIKE_PRICE_O = MARKED_BURN_PRICE_O;
export const SUPERLIKE_PRICE_RAW = MARKED_BURN_PRICE_RAW;

export { SUPERLIKE_MAGIC };

/* ---------- the burn calldata (pure) ---------- */

/**
 * The full transaction data for a SuperLike: an ordinary O
 * transfer of exactly the price to the burn address, with
 * the SLK1 marker + cawId appended. Null on a malformed id.
 */
export function buildSuperlikeData(cawId: string): string | null {
  return buildMarkedBurnData(SUPERLIKE_MAGIC, cawId);
}

/** Parse a transaction input as a SuperLike burn (SLK1 only). */
export function parseSuperlikeInput(data: string): MarkedBurnMark | null {
  const mark = parseMarkedBurnInput(data);
  return mark && mark.magic === SUPERLIKE_MAGIC ? mark : null;
}

/* ---------- guard decisions (pure) ---------- */

/**
 * Why a SuperLike must not be sent, or null when it may.
 * Mirrors the self-follow rule: your own names' posts (local
 * list) and any post whose author owner IS your address are
 * blocked — burning 1M O on your own post buys nothing.
 */
export function superlikeBlockReason(args: {
  senderId: bigint;
  myTokenIds: readonly bigint[];
  authorOwner: string;
  myAddress: string;
}): 'self' | null {
  if (args.myTokenIds.some((id) => id === args.senderId)) return 'self';
  if (
    args.authorOwner &&
    args.myAddress &&
    args.authorOwner.toLowerCase() === args.myAddress.toLowerCase()
  ) {
    return 'self';
  }
  return null;
}

/** True when the O balance cannot cover one whole SuperLike. */
export function superlikeShortfall(balance: bigint): boolean {
  return balance < SUPERLIKE_PRICE_RAW;
}

/** A trustworthy O balance read on QL1 (throws on RPC failure). */
export async function oBalanceOf(owner: string): Promise<bigint> {
  return decUintRet(
    await ethCall(O_TOKEN, SEL.balanceOf + encAddr(owner)),
  );
}

/* ---------- counts (delegated to the marked-burn index) ---------- */

export function initSuperlikeStore(storage: KVStorage): void {
  initMarkedBurnStore(storage);
}

export function subscribeSuperlike(fn: () => void): () => void {
  return subscribeMarkedBurns(fn);
}

/** The verified SuperLike count for one post (chain-wide scan). */
export function superlikeCount(cawId: string): Promise<number> {
  return mbSuperlikeCount(cawId);
}

/** The count from completed scans so far (0 when none). */
export function superlikeCountCached(cawId: string): number {
  return mbSuperlikeCountCached(cawId);
}

/** After my own SuperLike lands, nudge the index rescan. */
export function refreshSuperlikesFor(): void {
  refreshMarkedBurns();
}
