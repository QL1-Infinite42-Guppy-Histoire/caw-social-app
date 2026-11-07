/**
 * Right-to-left layout support (v0.3.9).
 *
 * Persian (fa) is the app's one RTL language; the other six are
 * LTR. The mirroring itself is React Native's: I18nManager with
 * forceRTL makes flexDirection:'row' run right-to-left, flips
 * start/end alignment, and aligns text to the start (right).
 * Styles therefore use logical properties (marginStart,
 * paddingEnd, …) wherever a physical left/right would break the
 * mirror — see the per-screen audit in the v0.3.9 commit.
 *
 * forceRTL only takes visual effect on a fresh app start (the
 * native layout direction is fixed while the app runs). So the
 * flow is:
 *  - AppContext applies the saved language's direction during
 *    boot, BEFORE any real screen mounts (only the symmetric boot
 *    splash can render earlier). That boot application defines
 *    the direction this session actually lays out in, and it is
 *    what isRtlLayout() reports for the whole session.
 *  - When the user switches language across the RTL boundary,
 *    applyLayoutDirection still sets the I18nManager flags (so
 *    the next start comes up mirrored) but returns true, and the
 *    caller shows a one-time notice in the NEW language asking
 *    for a restart. There is no programmatic reload in this
 *    stack — expo-updates is not installed, and DevSettings.
 *    reload() is a no-op in release builds — so a manual restart
 *    it is. Switching WITHIN the same direction (en<->ja, or
 *    back to the boot language) needs no restart and no notice.
 */
import { I18nManager } from 'react-native';

import { Lang, langIsRtl } from '../i18n';

/** Direction the CURRENT session is laid out in. Set once by the
 *  boot-time apply; glyphs and direction-sensitive styles read
 *  this (not I18nManager.isRTL, which flips the moment forceRTL
 *  is called at switch time — before the layout follows). */
let sessionRtl: boolean | null = null;

/**
 * Point I18nManager at the direction `lang` needs.
 * Returns true when the layout direction would change — i.e.
 * the flags are set for the next launch and the user should
 * restart the app once to see the mirror.
 */
export function applyLayoutDirection(lang: Lang): boolean {
  const want = langIsRtl(lang);
  I18nManager.allowRTL(true);
  if (sessionRtl === null) {
    // Boot: nothing real has mounted yet, so setting the flag
    // now is the session's direction.
    I18nManager.forceRTL(want);
    sessionRtl = want;
    return false;
  }
  if (want === sessionRtl) {
    // Same direction as this session already lays out in; still
    // re-assert the flag in case an earlier switch moved it.
    I18nManager.forceRTL(want);
    return false;
  }
  I18nManager.forceRTL(want);
  return true;
}

/** True when THIS session is laid out right-to-left. */
export function isRtlLayout(): boolean {
  return sessionRtl ?? I18nManager.isRTL;
}

/* Directional glyphs. Symmetric marks (⇄, 🔔, ♥, ▾, ✓) never
 * flip; arrows and next/expand chevrons must point the way the
 * mirrored layout reads. */

/** "Back" arrow: points left in LTR, right in RTL. */
export function backArrow(): string {
  return isRtlLayout() ? '→' : '←';
}

/** "Forward / go" arrow: points right in LTR, left in RTL. */
export function forwardArrow(): string {
  return isRtlLayout() ? '←' : '→';
}

/** "Next" chevron for drill-in rows: › in LTR, ‹ in RTL. */
export function nextChevron(): string {
  return isRtlLayout() ? '‹' : '›';
}

/** Expand/collapse chevron for accordion rows (▾ never flips). */
export function expandChevron(expanded: boolean): string {
  if (expanded) return '▾';
  return isRtlLayout() ? '◂' : '▸';
}
