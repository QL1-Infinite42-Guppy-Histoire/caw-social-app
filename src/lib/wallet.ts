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
import {
  chainOfProvider,
  confirmReceipt,
  executeStepSend,
  providerFor,
  waitForReceiptRobust,
  type ReceiptLike,
  type TxReq,
} from './hunters';
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

/**
 * Receipt confirmation for a broadcast tx (v0.4.1). HuntersSwap
 * chains confirm across ALL their RPC endpoints with a generous
 * polling window; any other provider confirms against itself
 * with the same retry tolerance. This replaces the old
 * single-endpoint receipt wait: a polling hiccup there used to
 * throw AFTER the tx had already been mined, so a successful
 * swap was reported to the user as a failure.
 */
async function confirmForSigner(
  signer: Wallet,
  hash: string,
): Promise<ReceiptLike | null> {
  const provider = signer.provider as JsonRpcProvider | null;
  if (!provider) return null;
  const chain = chainOfProvider(provider);
  if (chain) return waitForReceiptRobust(chain, hash);
  return confirmReceipt([
    async () => {
      const r = await provider.getTransactionReceipt(hash);
      return r && r.status != null ? { status: Number(r.status) } : null;
    },
  ]);
}

/**
 * Send one HuntersSwap tx request and confirm it. Resolves with
 * the hash ONLY on a status-1 receipt; throws TxRevertedError
 * on a mined revert and TxUnconfirmedError when no receipt
 * could be obtained (the tx may still have succeeded — callers
 * must not present that as a plain failure).
 */
export async function sendTxReq(
  signer: Wallet,
  req: TxReq,
  onBroadcast?: (hash: string) => void,
): Promise<string> {
  return executeStepSend({
    broadcast: async () => {
      const tx = await signer.sendTransaction({
        to: req.to,
        data: req.data,
        value: req.value,
      });
      return tx.hash;
    },
    confirm: (hash) => confirmForSigner(signer, hash),
    onBroadcast,
  });
}

/** Send raw calldata and confirm the receipt (same contract as
 *  sendTxReq: TxRevertedError / TxUnconfirmedError). */
export async function sendCalldata(
  signer: Wallet,
  to: string,
  data: string,
): Promise<string> {
  return executeStepSend({
    broadcast: async () => {
      const tx = await signer.sendTransaction({ to, data });
      return tx.hash;
    },
    confirm: (hash) => confirmForSigner(signer, hash),
  });
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
