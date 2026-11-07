import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

import { tr } from '../i18n';

/**
 * Wallet secret storage (single wallet, QL1 only).
 *
 * The secret words / private key live ONLY here, inside
 * expo-secure-store (Android Keystore-backed,
 * WHEN_UNLOCKED_THIS_DEVICE_ONLY). They are never written to
 * AsyncStorage, files, or logs, and never sent anywhere. A separate
 * public record (address only) lets the UI show the address while
 * locked.
 *
 * Unlock: an app password (salted SHA-256 verifier, the password itself
 * is never stored) and/or device biometrics — the user's choice at
 * setup. The gate is checked when the app opens and again before every
 * signature, like the user's other wallet.
 */

const SECRET_KEY = 'caw.wallet.secret.v1';
const PUBLIC_KEY = 'caw.wallet.public.v1';
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

/* ---------- wallet records ---------- */
export async function getWalletPublicInfo(): Promise<WalletPublicInfo | null> {
  try {
    const raw = await SecureStore.getItemAsync(PUBLIC_KEY, STORE_OPTIONS);
    if (!raw) return null;
    return JSON.parse(raw) as WalletPublicInfo;
  } catch {
    return null;
  }
}

export async function saveWallet(
  kind: WalletKind,
  secret: string,
  info: WalletPublicInfo,
): Promise<void> {
  const secretRecord: WalletSecret = { kind, secret };
  await SecureStore.setItemAsync(
    SECRET_KEY,
    JSON.stringify(secretRecord),
    STORE_OPTIONS,
  );
  await SecureStore.setItemAsync(
    PUBLIC_KEY,
    JSON.stringify(info),
    STORE_OPTIONS,
  );
}

export async function loadWalletSecret(): Promise<WalletSecret | null> {
  try {
    const raw = await SecureStore.getItemAsync(SECRET_KEY, STORE_OPTIONS);
    if (!raw) return null;
    return JSON.parse(raw) as WalletSecret;
  } catch {
    return null;
  }
}

export async function deleteWallet(): Promise<void> {
  await SecureStore.deleteItemAsync(SECRET_KEY, STORE_OPTIONS);
  await SecureStore.deleteItemAsync(PUBLIC_KEY, STORE_OPTIONS);
  await SecureStore.deleteItemAsync(UNLOCK_METHOD_KEY, STORE_OPTIONS);
  await SecureStore.deleteItemAsync(PW_VERIFIER_KEY, STORE_OPTIONS);
}
