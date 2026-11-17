/**
 * Tip （チップ) — a plain PHOENIX transfer from the reader to
 * a post's author. PHOENIX is the tip currency since v0.7.0
 * (user decision 2026-11-18), replacing CAT42, which held the
 * role from v0.5.0 through v0.6.7. A tip is deliberately JUST
 * a transfer: no marker, no counting, no split, no burn. The
 * amount is the tipper's choice: presets (TIP_PRESETS below)
 * or a custom amount (the sheet's custom input carries the
 * app's usual 25 / 50 / 75 / MAX balance chips).
 *
 * Chain note: CAT42 lives on 42 Chain, so the old tip was
 * sent there; PHOENIX lives on QL1 (config.ts), so the tip
 * now travels on QL1 like the SuperLike / SuperRecaw legs —
 * same wallet address on both chains, so the recipient (the
 * author's owner address) is unchanged.
 */
import { Interface } from 'ethers';

import { PHOENIX, SEL } from '../config';
import { ethCall } from './cawApi';
import { decUintRet, encAddr, parseAmount } from './cawCore';

/**
 * The tip preset amounts, in whole PHOENIX — ONE central
 * constant; the tip sheet renders exactly these.
 *
 * DECIDED (user, 2026-11-18): 10 / 50 / 100 PHOENIX — the
 * same numbers the CAT42 tip used. (An assistant-suggested
 * 1 / 5 / 10 was NOT chosen.) Custom amounts are unchanged.
 */
export const TIP_PRESETS = [10, 50, 100] as const;

const ERC20_IFACE = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/** Parse a custom tip amount (PHOENIX, 18 decimals) into raw
 *  units. Null for anything malformed or not positive. */
export function parseTipAmount(text: string): bigint | null {
  const raw = parseAmount(text);
  if (raw === null || raw <= 0n) return null;
  return raw;
}

/** The raw units for one preset (whole PHOENIX). */
export function tipPresetRaw(phoenix: number): bigint {
  return BigInt(phoenix) * 10n ** 18n;
}

/** The amount a balance chip selects: pct% of the balance
 *  (100 = MAX, the whole balance — a tip pays no separate fee
 *  in PHOENIX, so MAX needs no reserve). */
export function tipChipAmount(balance: bigint, pct: number): bigint {
  if (pct >= 100) return balance;
  return (balance * BigInt(pct)) / 100n;
}

/** Plain PHOENIX transfer calldata for a tip. */
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

/** A trustworthy PHOENIX balance read on QL1 (throws on RPC
 *  failure). Kept here (not in lib/superlike.ts) for the tip
 *  flow, mirroring oBalanceOf there. */
export async function phoenixBalanceOf(owner: string): Promise<bigint> {
  return decUintRet(
    await ethCall(PHOENIX, SEL.balanceOf + encAddr(owner)),
  );
}
