/**
 * SuperLike （超いいね) — an app-original feature (v0.4.8),
 * NOT a CAW protocol action.
 *
 * Since v0.6.3 (user decision 2026-11-13) one SuperLike
 * costs 25,000,000 O IN TOTAL, in two QL1 transactions:
 *   1. the BURN leg — 10,000,000 O (the QL1 token
 *      "Childhoods End" at 0x6c39…bbEd4 — a QL1 contract; it
 *      has no code on 42 Chain) to the burn address, with the
 *      post binding carried as trailing calldata ("SLK1" +
 *      cawId). This leg DEFINES the action: the post's ⭐
 *      count is tallied from these marked burns (see
 *      lib/markedBurns.ts for the shared index and the
 *      pre-design verification of O's transfer behaviour:
 *      identical eth_call success with the marker, a gas
 *      delta of exactly the intrinsic calldata charge, and
 *      no transfer tax in 36 sampled real transfers).
 *   2. the AUTHOR leg — a plain, unmarked transfer of
 *      15,000,000 O to the post author's owner address.
 * The burn goes first: if it fails, nothing happened. If
 * the author leg fails after the burn landed, the payment
 * is recorded as an on-device debt (lib/authorPay.ts) and
 * the only retry sends the transfer alone.
 *
 * History: v0.4.8 shipped a 100 CAT42 marked tip to the
 * author; v0.4.9 repriced it to 1,000 CAT42 (500 to the
 * author + 500 burned, two legs, with a pending-burn debt
 * store for a burn leg that failed after the author leg
 * landed). NO SuperLike was ever sent at either CAT42 price
 * (the count scans verified 0 throughout), so v0.5.0
 * replaced the design cleanly: a SuperLike was ONE burn
 * transaction of exactly 1,000,000 O. v0.6.3 supersedes
 * that price; burns made at 1,000,000 O under it stay
 * counted forever (the detection sets in lib/markedBurns.ts
 * accept the legacy amount). CAT42 itself is now only the
 * tip currency (lib/tip.ts).
 *
 * Other clients see a plain O burn; only this app reads the
 * marker. The convention is documented in the repo README
 * next to the reply/quote convention.
 */
import { O_TOKEN, SEL } from '../config';
import { ethCall } from './cawApi';
import { decUintRet, encAddr } from './cawCore';
import {
  SUPERLIKE_AUTHOR_O,
  SUPERLIKE_AUTHOR_RAW,
  SUPERLIKE_BURN_O,
  SUPERLIKE_BURN_RAW,
  SUPERLIKE_MAGIC,
  SUPERLIKE_TOTAL_O,
  SUPERLIKE_TOTAL_RAW,
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

/** The SuperLike money (v0.6.3), re-exported from the one
 *  source of truth in lib/markedBurns.ts: 25,000,000 O in
 *  total = 15,000,000 to the author + 10,000,000 burned. */
export {
  SUPERLIKE_AUTHOR_O,
  SUPERLIKE_AUTHOR_RAW,
  SUPERLIKE_BURN_O,
  SUPERLIKE_BURN_RAW,
  SUPERLIKE_TOTAL_O,
  SUPERLIKE_TOTAL_RAW,
};

export { SUPERLIKE_MAGIC };

/* ---------- the burn calldata (pure) ---------- */

/**
 * The full transaction data for a SuperLike's BURN leg: an
 * ordinary O transfer of exactly the burn amount
 * (10,000,000 O) to the burn address, with the SLK1 marker +
 * cawId appended. Null on a malformed id.
 */
export function buildSuperlikeData(cawId: string): string | null {
  return buildMarkedBurnData(SUPERLIKE_MAGIC, cawId, SUPERLIKE_BURN_RAW);
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
 * blocked — a SuperLike on your own post buys nothing, and
 * its author leg would be a payment to yourself. Because the
 * whole action is refused here, a self-payment can never
 * arise (unchanged in v0.6.3).
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

/** True when the O balance cannot cover one whole SuperLike
 *  (the full 25,000,000 O total — both legs). */
export function superlikeShortfall(balance: bigint): boolean {
  return balance < SUPERLIKE_TOTAL_RAW;
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
