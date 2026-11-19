/**
 * Tip （チップ) — a plain HAWK transfer from the reader to
 * a post's author. HAWK is the tip currency since v0.7.8
 * (user decision 2026-11-19). The role's history: CAT42
 * from v0.5.0 through v0.6.7, then PHOENIX from v0.7.0
 * through v0.7.7. A tip is deliberately JUST a transfer:
 * no marker, no counting, no split, no burn — so past
 * PHOENIX (and CAT42) tips need no migration: they were
 * plain transfers too, and nothing in the app detects or
 * displays tips by currency. PHOENIX itself is untouched
 * elsewhere (HuntersDEX, the wallet display, BurnHawk).
 * The amount is the tipper's choice: presets (TIP_PRESETS
 * below) or a custom amount (the sheet's custom input
 * carries the app's usual 25 / 50 / 75 / MAX balance
 * chips).
 *
 * Chain note: CAT42 lives on 42 Chain, so the old tip was
 * sent there; PHOENIX and HAWK both live on QL1
 * (config.ts), so the tip travels on QL1 like the
 * SuperLike / SuperRecaw legs — same wallet address on
 * both chains, so the recipient (the author's owner
 * address) is unchanged.
 */
import { Interface } from 'ethers';

import { HAWK, SEL } from '../config';
import { ethCall } from './cawApi';
import { decUintRet, encAddr, parseAmount } from './cawCore';

/**
 * The tip preset amounts, in whole HAWK — ONE central
 * constant; the tip sheet renders exactly these.
 *
 * DECIDED (user, 2026-11-19): 1,000 / 5,000 / 10,000 HAWK —
 * the same value steps as the PHOENIX era's 10 / 50 / 100
 * at the 100 HAWK : 1 PHOENIX anchor (the burnToMint
 * rate). (The PHOENIX presets were themselves the CAT42
 * era's numbers, DECIDED 2026-11-18.) Custom amounts are
 * unchanged.
 */
export const TIP_PRESETS = [1000, 5000, 10000] as const;

const ERC20_IFACE = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/** Parse a custom tip amount (HAWK, 18 decimals) into raw
 *  units. Null for anything malformed or not positive. */
export function parseTipAmount(text: string): bigint | null {
  const raw = parseAmount(text);
  if (raw === null || raw <= 0n) return null;
  return raw;
}

/** The raw units for one preset (whole HAWK). */
export function tipPresetRaw(hawk: number): bigint {
  return BigInt(hawk) * 10n ** 18n;
}

/** The amount a balance chip selects: pct% of the balance
 *  (100 = MAX, the whole balance — a tip pays no separate fee
 *  in HAWK, so MAX needs no reserve). */
export function tipChipAmount(balance: bigint, pct: number): bigint {
  if (pct >= 100) return balance;
  return (balance * BigInt(pct)) / 100n;
}

/** Plain HAWK transfer calldata for a tip. */
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

/** A trustworthy HAWK balance read on QL1 (throws on RPC
 *  failure). Kept here (not in lib/superlike.ts) for the tip
 *  flow, mirroring oBalanceOf there. */
export async function hawkBalanceOf(owner: string): Promise<bigint> {
  return decUintRet(
    await ethCall(HAWK, SEL.balanceOf + encAddr(owner)),
  );
}
