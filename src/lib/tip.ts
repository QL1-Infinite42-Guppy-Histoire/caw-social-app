/**
 * Tip （チップ, v0.5.0) — CAT42's one clear job: a plain
 * CAT42 transfer from the reader to a post's author. As of
 * v0.5.0 CAT42 is the tip currency only (SuperLike moved to
 * O burns — see lib/superlike.ts), so a tip is deliberately
 * JUST a transfer: no marker, no counting, no split, no burn.
 * The amount is the tipper's choice: presets of 10 / 50 / 100
 * CAT42, or a custom amount (the sheet's custom input carries
 * the app's usual 25 / 50 / 75 / MAX balance chips).
 */
import { Interface } from 'ethers';

import { CAT42, SEL } from '../config';
import { ethCall42 } from './cawApi';
import { decUintRet, encAddr, parseAmount } from './cawCore';

export const TIP_PRESETS_CAT42 = [10, 50, 100] as const;

const ERC20_IFACE = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/** Parse a custom tip amount (CAT42, 18 decimals) into raw
 *  units. Null for anything malformed or not positive. */
export function parseTipAmount(text: string): bigint | null {
  const raw = parseAmount(text);
  if (raw === null || raw <= 0n) return null;
  return raw;
}

/** The raw units for one preset (whole CAT42). */
export function tipPresetRaw(cat42: number): bigint {
  return BigInt(cat42) * 10n ** 18n;
}

/** The amount a balance chip selects: pct% of the balance
 *  (100 = MAX, the whole balance — a tip pays no separate fee
 *  in CAT42, so MAX needs no reserve). */
export function tipChipAmount(balance: bigint, pct: number): bigint {
  if (pct >= 100) return balance;
  return (balance * BigInt(pct)) / 100n;
}

/** Plain CAT42 transfer calldata for a tip. */
export function buildTipData(to: string, amountRaw: bigint): string {
  return ERC20_IFACE.encodeFunctionData('transfer', [to, amountRaw]);
}

/**
 * Why a tip must not be sent, or null when it may. Same shape
 * as the SuperLike guard: your own names' posts (local list)
 * and any post whose author owner IS your address are blocked
 * — tipping yourself is meaningless.
 */
export function tipBlockReason(args: {
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

/** True when the balance cannot cover the chosen tip. */
export function tipShortfall(balance: bigint, amountRaw: bigint): boolean {
  return balance < amountRaw;
}

/**
 * The M1 recipient cross-check verdict (v0.5.0-fix). A tip is
 * a plain transfer: once sent to a wrong address it cannot
 * be taken back, and the recipient comes from ONE read —
 * ownerOf on the primary QL1 RPC. So the primary resolution
 * is re-read through a second, independent endpoint:
 *  - 'ok'         both endpoints answered and agree;
 *  - 'primary'    the second endpoint could not be read
 *                 (null) — the primary's word stands, as
 *                 before (an unreachable checker must not
 *                 brick tipping);
 *  - 'mismatch'   both answered and DISAGREE → the tip must
 *                 be refused outright: one of the two is
 *                 lying or broken, and there is no way to
 *                 tell which from here.
 * `primary` itself is never null here — an unreadable
 * primary refuses the tip before this is consulted.
 */
export function tipRecipientVerdict(
  primary: string,
  alt: string | null,
): 'ok' | 'primary' | 'mismatch' {
  if (alt === null) return 'primary';
  return primary.toLowerCase() === alt.toLowerCase() ? 'ok' : 'mismatch';
}

/** A trustworthy CAT42 balance read on 42 Chain (throws on
 *  RPC failure). Kept here (not in lib/superlike.ts, whose
 *  CAT42 reads left with the old design) for the tip flow. */
export async function cat42BalanceOf(owner: string): Promise<bigint> {
  return decUintRet(
    await ethCall42(CAT42, SEL.balanceOf + encAddr(owner)),
  );
}
