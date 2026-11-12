/**
 * CAW action costs (in-name CAW) — the composer's cost line
 * (v0.6.0) reads from here.
 *
 * These are PROTOCOL facts, not UI inventions: the legacy
 * CawActions cost table was recovered from the contract's own
 * storage during the replacement-contract build (2026-11-12,
 * ~/workspace/caw-actions-replacement, parity suite 92/92):
 *
 *     post    5,000 CAW  (all to the reward pool)
 *     like    2,000 CAW  (1,600 author / 400 pool)
 *     recaw   4,000 CAW  (2,000 / 2,000)
 *     follow 30,000 CAW  (24,000 followed / 6,000 pool)
 *     unfollow    0
 *
 * Costs are charged from the acting name's DEPOSITED balance
 * (cawBalanceOf) by CawActions itself; the app never moves
 * this money directly. A reply and a quote Recaw are ordinary
 * POSTS in this app (type 0, with a parent-reference marker —
 * see lib/postRef.ts), so every composer variant costs the
 * post price; `composeCostRaw` states that mapping in one
 * place so the UI never hardcodes a figure.
 *
 * Pure module (no imports) — the Node verification harness
 * compiles it directly.
 */

/** Whole-CAW amounts from the recovered cost table. */
export const ACTION_COST_CAW = {
  post: 5000,
  like: 2000,
  recaw: 4000,
  follow: 30000,
  unfollow: 0,
} as const;

/** The post price in raw units (CAW has 18 decimals). */
export const POST_COST_RAW: bigint =
  BigInt(ACTION_COST_CAW.post) * 10n ** 18n;

/** What the composer is aimed at (mirrors AppContext's
 *  ComposeTarget kinds): a plain post, a reply, or a quote. */
export type ComposeCostKind = 'post' | 'reply' | 'quote';

/**
 * The cost of what the composer will send, in raw CAW. All
 * three composer variants are type-0 posts on chain, so all
 * three cost the post price — the function exists so that
 * fact is stated (and verified) once, not assumed per screen.
 */
export function composeCostRaw(_kind: ComposeCostKind): bigint {
  return POST_COST_RAW;
}
