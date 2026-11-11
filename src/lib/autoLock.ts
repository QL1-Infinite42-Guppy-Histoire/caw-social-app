/**
 * Auto-lock state machine (v0.5.0-fix, audit M4) — the PURE
 * half. AppContext wires it to React Native's AppState: when
 * the app goes to the background the clock starts; if it is
 * STILL backgrounded AUTO_LOCK_MS later, the app locks
 * (the in-memory secret is cleared exactly as the manual
 * lock does). Returning within the grace period cancels the
 * clock and the session continues untouched.
 *
 * Only a real 'background' transition starts the clock —
 * transient 'inactive' states (system prompts, the
 * biometric sheet itself) must never count, or the app
 * would lock itself mid-authentication.
 */
export const AUTO_LOCK_MS = 60_000;

export interface AutoLockState {
  /** When the current background period began (ms epoch),
   *  or null while foregrounded. */
  backgroundSince: number | null;
}

export const autoLockInitial: AutoLockState = { backgroundSince: null };

export function autoLockOnBackground(
  _state: AutoLockState,
  now: number,
): AutoLockState {
  return { backgroundSince: now };
}

export function autoLockOnForeground(_state: AutoLockState): AutoLockState {
  return { backgroundSince: null };
}

/** True when the background period has run past the grace
 *  window and the app must lock NOW. */
export function autoLockDue(state: AutoLockState, now: number): boolean {
  return (
    state.backgroundSince !== null &&
    now - state.backgroundSince >= AUTO_LOCK_MS
  );
}
