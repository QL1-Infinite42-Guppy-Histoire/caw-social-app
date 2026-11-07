/**
 * Ethers layer: key derivation, raw-digest signing, and transaction
 * sending — all inside the app, with the key the user keeps on this
 * phone. This is the piece wallet browsers could not do: CAW needs a
 * plain ECDSA signature over a raw digest (no prefix), and current
 * wallet apps refuse that. Here it is just SigningKey.sign(digest).
 */
import * as Crypto from 'expo-crypto';
import {
  HDNodeWallet,
  JsonRpcProvider,
  Mnemonic,
  SigningKey,
  Wallet,
} from 'ethers';

import { CAW_ACTIONS, CHAIN_ID, RPC } from '../config';
import { nameOwner } from './cawApi';
import type { HsChainKey } from './chains';
import { providerFor, type TxReq } from './hunters';
import {
  CawAction,
  CawSignature,
  actionDigest,
  encodeBatch,
} from './cawCore';
import type { WalletKind } from './walletStore';

export interface CreatedWallet {
  phrase: string;
  address: string;
}

export function createWallet(): CreatedWallet {
  const w = HDNodeWallet.createRandom();
  if (!w.mnemonic) throw new Error('no mnemonic');
  return { phrase: w.mnemonic.phrase, address: w.address };
}

export function normalizePhrase(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Returns the address for a phrase, or null when it is not a valid one. */
export function addressFromPhrase(input: string): string | null {
  const phrase = normalizePhrase(input);
  const words = phrase.split(' ').filter(Boolean);
  if (words.length !== 12 && words.length !== 24) return null;
  if (!Mnemonic.isValidMnemonic(phrase)) return null;
  try {
    return HDNodeWallet.fromPhrase(phrase).address;
  } catch {
    return null;
  }
}

/** Returns the address for a private key, or null when malformed. */
export function addressFromPrivateKey(input: string): string | null {
  const pk = input.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;
  try {
    return new Wallet(pk).address;
  } catch {
    return null;
  }
}

/** The raw private key behind a stored secret (mnemonic → account 0). */
export function privateKeyOf(kind: WalletKind, secret: string): string {
  if (kind === 'privateKey') return secret.trim();
  return HDNodeWallet.fromPhrase(normalizePhrase(secret)).privateKey;
}

export function addressOf(kind: WalletKind, secret: string): string {
  return new Wallet(privateKeyOf(kind, secret)).address;
}

let provider: JsonRpcProvider | null = null;
export function getProvider(): JsonRpcProvider {
  if (!provider) {
    provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  }
  return provider;
}

export function signerFor(kind: WalletKind, secret: string): Wallet {
  return new Wallet(privateKeyOf(kind, secret), getProvider());
}

/** Signer for any HuntersSwap chain (same key, other network). */
export function signerForHsChain(
  kind: WalletKind,
  secret: string,
  chain: HsChainKey,
): Wallet {
  return new Wallet(privateKeyOf(kind, secret), providerFor(chain));
}

/** Sign one action's digest with no extra prefix — the CAW way. */
export function signAction(privateKey: string, action: CawAction): CawSignature {
  const digest = actionDigest(action);
  const sig = new SigningKey(privateKey).sign(digest);
  return { v: sig.v, r: sig.r, s: sig.s };
}

/** Send one HuntersSwap tx request and wait; throws on revert. */
export async function sendTxReq(signer: Wallet, req: TxReq): Promise<string> {
  const tx = await signer.sendTransaction({
    to: req.to,
    data: req.data,
    value: req.value,
  });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error('transaction failed on chain (tx ' + tx.hash + ')');
  }
  return tx.hash;
}

/** Send raw calldata and wait for the receipt; throws when it reverts. */
export async function sendCalldata(
  signer: Wallet,
  to: string,
  data: string,
): Promise<string> {
  const tx = await signer.sendTransaction({ to, data });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error('transaction failed on chain (tx ' + tx.hash + ')');
  }
  return tx.hash;
}

/**
 * Sign + submit one CAW action (post / like / share / follow) as a
 * processAction batch of one.
 *
 * PRE-SIGN GUARD (fail-closed, app-side, independent of what the
 * contract would accept): ownerOf(senderTokenId) is read fresh and
 * MUST equal this wallet's address before anything is signed. A
 * mismatch — or a failed read, which means ownership cannot be
 * proven — refuses the send with Error('not-owner'). An action can
 * therefore never be signed under a name this wallet does not own,
 * whatever any list or cache said earlier.
 */
export async function submitAction(
  kind: WalletKind,
  secret: string,
  action: CawAction,
): Promise<string> {
  const signer = signerFor(kind, secret);
  let owner: string | null = null;
  try {
    owner = await nameOwner(action.senderId);
  } catch {
    owner = null; // unreadable = unproven = refuse below
  }
  if (!owner || owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error('not-owner');
  }
  const sig = signAction(signer.privateKey, action);
  const data = encodeBatch([action], [sig]);
  return sendCalldata(signer, CAW_ACTIONS, data);
}

/** A fresh random action id (32 bytes), as on the web. */
export async function randomCawId(): Promise<string> {
  const b = await Crypto.getRandomBytesAsync(32);
  return (
    '0x' +
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')
  );
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);
