/* Feed swipe decisions (v0.7.1) — pure logic, no RN imports, so
 * scripts/verify-swipe.mjs can run the REAL functions.
 *
 * Why this module exists: v0.7.0 recognised the Latest ⇄ Following
 * swipe from onTouchStart / onTouchEnd pageX coordinates attached to
 * the FlatList. On the user's device the swipe never switched feeds
 * (field report 2026-11-18). That pattern depends on the touch-END
 * event being delivered to JS with fresh coordinates; when the
 * native scroll view owns the gesture, the sequence JS sees is a
 * touch CANCEL instead of an end, or an end whose coordinates never
 * moved — either way the start/end diff comes out ~0 and nothing
 * happens. The math was right; the delivery was not.
 *
 * v0.7.1 therefore decides from PanResponder gesture state instead:
 * a wrapper PanResponder evaluates every MOVE in the capture phase
 * (before the list's own scroll responder) and claims the gesture
 * only when it is clearly horizontal. Claiming uses gestureState
 * dx/dy accumulated from move events, never touch-end coordinates,
 * and a claimed release carries the full travel. Vertical drags are
 * never claimed, so scrolling and pull-to-refresh are untouched. */

/** A move may claim the responder once the drag is at least this
 *  many px horizontal AND clearly horizontal-dominant. Claiming
 *  early (24px) matters: the claim must win before the list's
 *  scroll takes the gesture over. */
export const SWIPE_CLAIM_MIN_DX = 24;
export const SWIPE_CLAIM_DOMINANCE = 2.2;

/** On release, a claimed gesture switches feeds only if its total
 *  horizontal travel reaches this many px (same bar as v0.7.0). */
export const SWIPE_SWITCH_MIN_DX = 60;

/** Should the feed's PanResponder claim this move? dx/dy are the
 *  gesture's cumulative travel from touch start. */
export function swipeShouldClaim(dx: number, dy: number): boolean {
  const adx = Math.abs(dx);
  return adx > SWIPE_CLAIM_MIN_DX && adx > SWIPE_CLAIM_DOMINANCE * Math.abs(dy);
}

/** Where a released swipe goes, or null for no switch. Direction
 *  follows the reading direction (same rule as v0.7.0): in LTR a
 *  leftward swipe moves to the next segment (Following) and a
 *  rightward swipe back to Latest; RTL inverts. */
export function swipeTargetMode(
  dx: number,
  isRTL: boolean,
): 'following' | 'latest' | null {
  if (Math.abs(dx) < SWIPE_SWITCH_MIN_DX) return null;
  const toFollowing = isRTL ? dx > 0 : dx < 0;
  return toFollowing ? 'following' : 'latest';
}
