/**
 * BurnHawk (v0.7.0) — burn QL1 HAWK to mint PHOENIX, in-app.
 *
 * The mechanism lives in the PHOENIX token contract itself:
 * `burnToMint(uint256)` (selector 0x05737aae) on PHOENIX
 * (0xDFe660C5a29c8AADF1daA096543D249135e1938A) burns the
 * caller's HAWK (0xbC85F14059d60458b614052b4a84734E463878cc)
 * and mints PHOENIX at exactly 100:1. Verified from real
 * transactions on 2026-11-18 (1,000,000 HAWK → 10,000
 * PHOENIX; 500,000 → 5,000; 92+ burnToMint calls in a
 * 200-transaction sample) and shipped first as the standalone
 * site hawk.qql1.com — this module is the same flow for the
 * app, mirroring ~/workspace/hawk-burn/docs/app.js.
 *
 * The flow is two sends, each confirmed before the next:
 *   1. HAWK approve(PHOENIX, amount) — ONLY when the current
 *      allowance is short, and for the exact burn amount.
 *   2. PHOENIX burnToMint(amount).
 * Amounts are rounded DOWN to a whole multiple of 100 HAWK
 * before sending, so no fractional remainder is burned for
 * nothing; the UI says so and previews the receive amount
 * (burn / 100) before anything is signed.
 *
 * The pure helpers below carry the money rules and are unit
 * tested (scripts/verify-burnhawk.mjs); the screen performs
 * the sends with the app's wallet (lib/wallet.ts sendTxReq).
 */
import { HAWK, PHOENIX, SEL } from '../config';
import { ethCall } from './cawApi';
import { encAddr, word } from './cawCore';

/** allowance(address,address) — the standard ERC-20 selector. */
export const ALLOWANCE_SELECTOR = '0xdd62ed3e';

/** approve(spender, amount) calldata for an ERC-20. */
export function buildApproveData(spender: string, amountRaw: bigint): string {
  return SEL.approve + encAddr(spender) + word(amountRaw);
}

/** burnToMint(uint256) on the PHOENIX contract. */
export const BURN_TO_MINT_SELECTOR = '0x05737aae';
/** The spender of the HAWK approval is the PHOENIX contract. */
export const BURN_SPENDER = PHOENIX;
export const BURN_TOKEN = HAWK;

/** 100 HAWK burn to exactly 1 PHOENIX. */
export const BURN_RATIO = 100n;

/** One whole-token unit at the given decimals. */
export function unitOf(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

/** The burn step in raw units: 100 whole HAWK. */
export function burnStepRaw(hawkDecimals: number): bigint {
  return BURN_RATIO * unitOf(hawkDecimals);
}

/**
 * Round a raw HAWK amount DOWN to a whole multiple of the
 * 100-HAWK step. Anything below one step rounds to 0 (the
 * screen treats 0 as "enter at least 100").
 */
export function roundDownBurnRaw(raw: bigint, hawkDecimals: number): bigint {
  if (raw <= 0n) return 0n;
  const step = burnStepRaw(hawkDecimals);
  return raw - (raw % step);
}

/**
 * The PHOENIX raw amount a burn of `burnRaw` HAWK mints:
 * burn whole / 100, re-based to PHOENIX decimals. burnRaw is
 * expected pre-rounded (a multiple of the step), so the
 * division is exact.
 */
export function receiveRawFor(
  burnRaw: bigint,
  hawkDecimals: number,
  phoenixDecimals: number,
): bigint {
  const whole = burnRaw / unitOf(hawkDecimals);
  return (whole / BURN_RATIO) * unitOf(phoenixDecimals);
}

/** burnToMint(amount) calldata for the PHOENIX contract. */
export function buildBurnToMintData(amountRaw: bigint): string {
  return BURN_TO_MINT_SELECTOR + word(amountRaw);
}

/** The current HAWK allowance the wallet grants PHOENIX. */
export async function hawkAllowanceForPhoenix(
  owner: string,
): Promise<bigint> {
  const data = ALLOWANCE_SELECTOR + encAddr(owner) + encAddr(PHOENIX);
  const res = await ethCall(HAWK, data);
  return res && res !== '0x' ? BigInt(res) : 0n;
}

/** True when the existing allowance already covers the burn. */
export function allowanceCovers(allowance: bigint, amountRaw: bigint): boolean {
  return allowance >= amountRaw;
}
