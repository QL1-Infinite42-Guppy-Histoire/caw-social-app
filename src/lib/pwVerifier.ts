/**
 * Password verifier + attempt-throttle logic (v0.5.0-fix,
 * audit M3) — the PURE half. Storage (SecureStore) and the
 * random salt live in lib/walletStore.ts; everything about
 * record shapes, KDF parameters and the throttle math lives
 * here so the Node harness can pin it.
 *
 * Record formats:
 *  - v2 (current): { v: 2, kdf: 'scrypt', N, r, p, salt,
 *    hash } — scrypt (memory-hard) over the password, from
 *    the @noble/hashes implementation ethers already ships
 *    (no new dependency: ethers re-exports scrypt, and the
 *    lockfile pins @noble/hashes 1.3.2 through it). The salt
 *    is 16 random bytes, hex.
 *  - legacy (pre-v0.5.0-fix): { salt, hash } where hash is a
 *    single SHA-256 of `${salt}:${password}` — the format
 *    every install up to vc36 carries. checkPwRecord still
 *    verifies it (flagged `legacy: true`) so walletStore can
 *    transparently re-hash to v2 on the first successful
 *    unlock: NOBODY gets locked out by the upgrade.
 *
 * The password is a GATE, not an encryption key (the secret
 * itself rests on the Android Keystore's
 * WHEN_UNLOCKED_THIS_DEVICE_ONLY) — but the gate's strength
 * is the password's strength, so the verifier must not be
 * fast to brute-force offline, and online attempts must be
 * rate-limited (the throttle below).
 */
import { scrypt, sha256, toUtf8Bytes } from 'ethers';

export const PW_SCRYPT_N = 16384;
export const PW_SCRYPT_R = 8;
export const PW_SCRYPT_P = 1;
export const PW_DKLEN = 32;

export interface PwRecordV2 {
  v: 2;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

/** The pre-v0.5.0-fix stored shape (no version marker). */
export interface PwRecordLegacy {
  salt: string;
  hash: string;
}

function strip0x(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

/** Constant-time-ish string compare (same discipline the
 *  legacy verifier used: full-length XOR accumulation). */
export function pwHashEq(a: string, b: string): boolean {
  const x = strip0x(a).toLowerCase();
  const y = strip0x(b).toLowerCase();
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) {
    diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  }
  return diff === 0;
}

/** The legacy digest: SHA-256 hex of `${salt}:${password}`. */
export function legacyPwHash(salt: string, password: string): string {
  return strip0x(sha256(toUtf8Bytes(`${salt}:${password}`)));
}

/** The v2 digest for explicit scrypt parameters. */
export async function scryptPwHash(
  saltHex: string,
  password: string,
  N: number,
  r: number,
  p: number,
): Promise<string> {
  const out = await scrypt(
    toUtf8Bytes(password),
    '0x' + strip0x(saltHex),
    N,
    r,
    p,
    PW_DKLEN,
  );
  return strip0x(out);
}

/** Build a fresh v2 record for `password` under `saltHex`. */
export async function makePwRecord(
  password: string,
  saltHex: string,
): Promise<PwRecordV2> {
  return {
    v: 2,
    kdf: 'scrypt',
    N: PW_SCRYPT_N,
    r: PW_SCRYPT_R,
    p: PW_SCRYPT_P,
    salt: saltHex,
    hash: await scryptPwHash(
      saltHex,
      password,
      PW_SCRYPT_N,
      PW_SCRYPT_R,
      PW_SCRYPT_P,
    ),
  };
}

function isV2(rec: unknown): rec is PwRecordV2 {
  const r = rec as PwRecordV2 | null;
  return (
    !!r &&
    typeof r === 'object' &&
    r.v === 2 &&
    r.kdf === 'scrypt' &&
    typeof r.salt === 'string' &&
    typeof r.hash === 'string' &&
    Number.isInteger(r.N) &&
    r.N > 0 &&
    Number.isInteger(r.r) &&
    r.r > 0 &&
    Number.isInteger(r.p) &&
    r.p > 0
  );
}

function isLegacy(rec: unknown): rec is PwRecordLegacy {
  const r = rec as PwRecordLegacy | null;
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.salt === 'string' &&
    typeof r.hash === 'string'
  );
}

/**
 * Verify `password` against a stored record of EITHER
 * format. `legacy: true` on a success tells the caller to
 * re-hash into v2 (the transparent migration). A malformed
 * record never verifies.
 */
export async function checkPwRecord(
  record: unknown,
  password: string,
): Promise<{ ok: boolean; legacy: boolean }> {
  if (isV2(record)) {
    try {
      const candidate = await scryptPwHash(
        record.salt,
        password,
        record.N,
        record.r,
        record.p,
      );
      return { ok: pwHashEq(candidate, record.hash), legacy: false };
    } catch {
      return { ok: false, legacy: false };
    }
  }
  if (isLegacy(record)) {
    return {
      ok: pwHashEq(legacyPwHash(record.salt, password), record.hash),
      legacy: true,
    };
  }
  return { ok: false, legacy: false };
}

/* ---------------- attempt throttle ----------------
 * Progressive delay, persisted by the caller (walletStore,
 * SecureStore) so an app restart does NOT reset it: the
 * first PW_FREE_FAILURES consecutive failures are free;
 * from the next failure the required wait doubles —
 * 5 s, 10 s, 20 s, 40 s — capped at 60 s. A success resets
 * the count to zero. */

/** Consecutive failures tolerated with no delay. */
export const PW_FREE_FAILURES = 4;
export const PW_MAX_DELAY_MS = 60_000;

export interface PwThrottleState {
  /** Consecutive failures since the last success. */
  fails: number;
  /** When the last failure happened (ms epoch). */
  lastFailAt: number;
}

/** The delay a failure count imposes on the NEXT attempt. */
export function pwDelayMs(consecutiveFails: number): number {
  if (consecutiveFails <= PW_FREE_FAILURES) return 0;
  const over = consecutiveFails - PW_FREE_FAILURES; // 1, 2, 3…
  return Math.min(PW_MAX_DELAY_MS, 5000 * 2 ** (over - 1));
}

/** How long an attempt right now must wait, given the state. */
export function pwWaitMs(state: PwThrottleState, now: number): number {
  const delay = pwDelayMs(state.fails);
  if (delay === 0 || state.lastFailAt <= 0) return 0;
  const elapsed = now - state.lastFailAt;
  return elapsed >= delay ? 0 : delay - elapsed;
}

export function pwNoteFailure(
  state: PwThrottleState,
  now: number,
): PwThrottleState {
  return { fails: state.fails + 1, lastFailAt: now };
}

export function pwNoteSuccess(): PwThrottleState {
  return { fails: 0, lastFailAt: 0 };
}

export function parsePwThrottle(raw: string | null): PwThrottleState {
  if (!raw) return { fails: 0, lastFailAt: 0 };
  try {
    const j = JSON.parse(raw) as Partial<PwThrottleState>;
    const fails =
      typeof j.fails === 'number' && j.fails > 0 ? Math.floor(j.fails) : 0;
    const lastFailAt =
      typeof j.lastFailAt === 'number' && j.lastFailAt > 0 ? j.lastFailAt : 0;
    return { fails, lastFailAt };
  } catch {
    return { fails: 0, lastFailAt: 0 };
  }
}
