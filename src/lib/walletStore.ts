import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

import { tr } from '../i18n';

/**
 * Wallet secret storage (multiple wallets since v0.2.0, QL1 only).
 *
 * The secret words / private keys live ONLY here, inside
 * expo-secure-store (Android Keystore-backed,
 * WHEN_UNLOCKED_THIS_DEVICE_ONLY) — one record per wallet address.
 * They are never written to AsyncStorage, files, or logs, and never
 * sent anywhere. A public registry (addresses + kinds only) lets
 * the UI list wallets and show the active address while locked.
 *
 * v0.1.x kept a single wallet under the legacy keys below. On first
 * use the legacy wallet is adopted into the registry and its secret
 * is copied to the per-address key (verified by reading it back
 * before the legacy secret is removed), so existing users keep
 * their wallet untouched.
 *
 * Unlock: an app password (salted SHA-256 verifier, the password
 * itself is never stored) and/or device biometrics — one app-level
 * gate for all wallets, checked when the app opens and again before
 * every signature, like the user's other wallet.
 */

const SECRET_KEY = 'caw.wallet.secret.v1';
const PUBLIC_KEY = 'caw.wallet.public.v1';
const LIST_KEY = 'caw.wallets.list.v2';
const ACTIVE_KEY = 'caw.wallets.active.v2';
const secretKeyFor = (address: string) =>
  'caw.wallet.secret.' + address.toLowerCase();
const UNLOCK_METHOD_KEY = 'caw.wallet.unlockMethod.v1';
const PW_VERIFIER_KEY = 'caw.wallet.pwVerifier.v1';
const STORE_OPTIONS = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
} as const;

export type WalletKind = 'mnemonic' | 'privateKey';

export interface WalletPublicInfo {
  kind: WalletKind;
  address: string;
}

interface WalletSecret {
  kind: WalletKind;
  secret: string;
}

export type UnlockMethod = 'biometric' | 'password';

/* ---------- biometrics ---------- */
export async function isBiometricAvailable(): Promise<boolean> {
  const [hasHardware, isEnrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  return hasHardware && isEnrolled;
}

/** Gate a sensitive action behind device biometrics / device PIN. */
export async function authenticate(
  reason: string = tr('auth.reason'),
): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    disableDeviceFallback: false,
  });
  return result.success;
}

/* ---------- unlock method ---------- */
export async function getUnlockMethod(): Promise<UnlockMethod> {
  try {
    const v = await SecureStore.getItemAsync(UNLOCK_METHOD_KEY, STORE_OPTIONS);
    return v === 'password' ? 'password' : 'biometric';
  } catch {
    return 'biometric';
  }
}
export async function setUnlockMethodStored(
  method: UnlockMethod,
): Promise<void> {
  await SecureStore.setItemAsync(UNLOCK_METHOD_KEY, method, STORE_OPTIONS);
}

/* ---------- password verifier (salted hash only) ---------- */
interface PwVerifier {
  salt: string;
  hash: string;
}
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
async function hashPassword(salt: string, password: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${salt}:${password}`,
  );
}
export async function setPasswordVerifier(password: string): Promise<void> {
  const salt = bytesToHex(await Crypto.getRandomBytesAsync(16));
  const hash = await hashPassword(salt, password);
  await SecureStore.setItemAsync(
    PW_VERIFIER_KEY,
    JSON.stringify({ salt, hash } as PwVerifier),
    STORE_OPTIONS,
  );
}
export async function hasPasswordVerifier(): Promise<boolean> {
  try {
    return (
      (await SecureStore.getItemAsync(PW_VERIFIER_KEY, STORE_OPTIONS)) !== null
    );
  } catch {
    return false;
  }
}
export async function verifyPassword(password: string): Promise<boolean> {
  try {
    const raw = await SecureStore.getItemAsync(PW_VERIFIER_KEY, STORE_OPTIONS);
    if (!raw) return false;
    const record = JSON.parse(raw) as PwVerifier;
    const candidate = await hashPassword(record.salt, password);
    if (candidate.length !== record.hash.length) return false;
    let diff = 0;
    for (let i = 0; i < candidate.length; i++) {
      diff |= candidate.charCodeAt(i) ^ record.hash.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

/* ---------- wallet records (multi-wallet registry) ---------- */

async function readList(): Promise<WalletPublicInfo[] | null> {
  try {
    const raw = await SecureStore.getItemAsync(LIST_KEY, STORE_OPTIONS);
    if (!raw) return null;
    const list = JSON.parse(raw) as WalletPublicInfo[];
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

async function writeList(list: WalletPublicInfo[]): Promise<void> {
  await SecureStore.setItemAsync(
    LIST_KEY,
    JSON.stringify(list),
    STORE_OPTIONS,
  );
}

/**
 * Adopt the v0.1.x single wallet into the registry, once. The
 * secret copy is read back and compared before the legacy secret
 * is deleted; on any doubt the legacy records are left in place
 * and reads keep falling back to them.
 */
let migrated = false;
async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  migrated = true;
  try {
    if ((await readList()) !== null) return;
    const raw = await SecureStore.getItemAsync(PUBLIC_KEY, STORE_OPTIONS);
    if (!raw) return;
    const info = JSON.parse(raw) as WalletPublicInfo;
    await writeList([info]);
    await SecureStore.setItemAsync(ACTIVE_KEY, info.address, STORE_OPTIONS);
    const legacySecret = await SecureStore.getItemAsync(
      SECRET_KEY,
      STORE_OPTIONS,
    );
    if (legacySecret) {
      await SecureStore.setItemAsync(
        secretKeyFor(info.address),
        legacySecret,
        STORE_OPTIONS,
      );
      const check = await SecureStore.getItemAsync(
        secretKeyFor(info.address),
        STORE_OPTIONS,
      );
      if (check === legacySecret) {
        await SecureStore.deleteItemAsync(SECRET_KEY, STORE_OPTIONS);
      }
    }
  } catch {
    /* legacy reads still work as a fallback */
  }
}

export async function listWallets(): Promise<WalletPublicInfo[]> {
  await ensureMigrated();
  const list = await readList();
  if (list) return list;
  // Registry unreadable/absent: fall back to the legacy record.
  try {
    const raw = await SecureStore.getItemAsync(PUBLIC_KEY, STORE_OPTIONS);
    if (!raw) return [];
    return [JSON.parse(raw) as WalletPublicInfo];
  } catch {
    return [];
  }
}

export async function getActiveWalletInfo(): Promise<WalletPublicInfo | null> {
  const list = await listWallets();
  if (list.length === 0) return null;
  try {
    const active = await SecureStore.getItemAsync(ACTIVE_KEY, STORE_OPTIONS);
    const found = active
      ? list.find((w) => w.address.toLowerCase() === active.toLowerCase())
      : undefined;
    return found ?? list[0];
  } catch {
    return list[0];
  }
}

/** The ACTIVE wallet's public info (kept name from the single-wallet era). */
export async function getWalletPublicInfo(): Promise<WalletPublicInfo | null> {
  return getActiveWalletInfo();
}

export async function setActiveWallet(address: string): Promise<void> {
  await ensureMigrated();
  await SecureStore.setItemAsync(ACTIVE_KEY, address, STORE_OPTIONS);
}

export async function saveWallet(
  kind: WalletKind,
  secret: string,
  info: WalletPublicInfo,
): Promise<void> {
  await ensureMigrated();
  const secretRecord: WalletSecret = { kind, secret };
  await SecureStore.setItemAsync(
    secretKeyFor(info.address),
    JSON.stringify(secretRecord),
    STORE_OPTIONS,
  );
  const list = await listWallets();
  const next = list.filter(
    (w) => w.address.toLowerCase() !== info.address.toLowerCase(),
  );
  next.push(info);
  await writeList(next);
  await SecureStore.setItemAsync(ACTIVE_KEY, info.address, STORE_OPTIONS);
  // Keep the legacy public record pointing at the active wallet so
  // any older code path still sees a consistent address.
  await SecureStore.setItemAsync(
    PUBLIC_KEY,
    JSON.stringify(info),
    STORE_OPTIONS,
  );
}

/** Secret of the given wallet, or of the active one when omitted. */
export async function loadWalletSecret(
  address?: string,
): Promise<WalletSecret | null> {
  await ensureMigrated();
  const target =
    address ?? (await getActiveWalletInfo())?.address ?? null;
  if (target) {
    try {
      const raw = await SecureStore.getItemAsync(
        secretKeyFor(target),
        STORE_OPTIONS,
      );
      if (raw) return JSON.parse(raw) as WalletSecret;
    } catch {
      /* fall through to the legacy slot */
    }
  }
  try {
    const raw = await SecureStore.getItemAsync(SECRET_KEY, STORE_OPTIONS);
    if (!raw) return null;
    return JSON.parse(raw) as WalletSecret;
  } catch {
    return null;
  }
}

/** Remove one wallet (secret + registry entry); fixes the active pointer. */
export async function deleteWalletByAddress(address: string): Promise<void> {
  await ensureMigrated();
  await SecureStore.deleteItemAsync(secretKeyFor(address), STORE_OPTIONS);
  const list = (await listWallets()).filter(
    (w) => w.address.toLowerCase() !== address.toLowerCase(),
  );
  await writeList(list);
  const active = await getActiveWalletInfo();
  if (!active || active.address.toLowerCase() === address.toLowerCase()) {
    if (list.length > 0) {
      await SecureStore.setItemAsync(
        ACTIVE_KEY,
        list[0].address,
        STORE_OPTIONS,
      );
      await SecureStore.setItemAsync(
        PUBLIC_KEY,
        JSON.stringify(list[0]),
        STORE_OPTIONS,
      );
    } else {
      await SecureStore.deleteItemAsync(ACTIVE_KEY, STORE_OPTIONS);
      await SecureStore.deleteItemAsync(PUBLIC_KEY, STORE_OPTIONS);
    }
  }
}

/** Remove ALL wallets and the app unlock setup (the Settings danger zone). */
export async function deleteWallet(): Promise<void> {
  await ensureMigrated();
  const list = await listWallets();
  for (const w of list) {
    await SecureStore.deleteItemAsync(secretKeyFor(w.address), STORE_OPTIONS);
  }
  await SecureStore.deleteItemAsync(SECRET_KEY, STORE_OPTIONS);
  await SecureStore.deleteItemAsync(PUBLIC_KEY, STORE_OPTIONS);
  await SecureStore.deleteItemAsync(LIST_KEY, STORE_OPTIONS);
  await SecureStore.deleteItemAsync(ACTIVE_KEY, STORE_OPTIONS);
  await SecureStore.deleteItemAsync(UNLOCK_METHOD_KEY, STORE_OPTIONS);
  await SecureStore.deleteItemAsync(PW_VERIFIER_KEY, STORE_OPTIONS);
}
