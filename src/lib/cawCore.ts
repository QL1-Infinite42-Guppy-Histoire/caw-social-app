/**
 * CAW signing core + calldata codec — TypeScript port of the verified
 * web front end (~/workspace/caw-social-ql1/docs/app.js).
 *
 * The CAW write path on QL1, pinned down from the live CawActions contract:
 * - digest = keccak256(0x1901 || DOMAIN_SEPARATOR || structHash), where
 *   DOMAIN_SEPARATOR is the value the contract itself keeps in storage
 *   slot 2, and structHash = keccak256(TYPEHASH || fields) with the fields
 *   in the contract's own order (the two tip lists are empty in every real
 *   action seen on QL1, so they contribute keccak256('')).
 * - The web version of this exact code was tested off-chain against all
 *   264 actions found in recent real transactions: every signature
 *   recovered its sender, and the batch encoder rebuilt every real
 *   calldata byte for byte. scripts/verify-core.mjs re-runs that same
 *   corpus against THIS port.
 *
 * Only the Keccak primitive differs from the web version (ethers'
 * audited keccak256 instead of the hand-rolled one); every preimage is
 * assembled byte-for-byte the same way.
 */
import { getBytes, keccak256, toUtf8Bytes, toUtf8String } from 'ethers';

export interface CawAction {
  /** 0 = post, 1 = like, 2 = share (reCaw), 3 = follow */
  type: number;
  senderId: bigint;
  receiverId: bigint;
  /** unix seconds */
  ts: number;
  sender: string;
  cawId: string;
  text: string;
}

export interface CawSignature {
  v: number;
  r: string;
  s: string;
}

/* ---------- hex helpers (same string math as the web version) ---------- */
export const strip = (h: string): string => (h || '').replace(/^0x/, '');
export const word = (v: bigint | number): string =>
  BigInt(v).toString(16).padStart(64, '0');
export const encAddr = (a: string): string =>
  strip(a).toLowerCase().padStart(64, '0');

/** ABI-encode a string argument (offset + length + padded data), hex, no 0x. */
export function encStr(s: string): string {
  const bytes = toUtf8Bytes(s);
  const data = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const paddedLen = Math.ceil(bytes.length / 32) * 64 || 64;
  return word(32) + word(bytes.length) + data.padEnd(paddedLen, '0');
}

const uAt = (hex: string, byteOff: number): bigint =>
  BigInt('0x' + hex.slice(byteOff * 2, byteOff * 2 + 64));
const addrAt = (hex: string, byteOff: number): string =>
  '0x' + hex.slice(byteOff * 2 + 24, byteOff * 2 + 64);
const strAt = (hex: string, byteOff: number): string => {
  const len = Number(uAt(hex, byteOff));
  const raw = hex.slice((byteOff + 32) * 2, (byteOff + 32) * 2 + len * 2);
  const bytes = new Uint8Array(
    (raw.match(/../g) || []).map((h) => parseInt(h, 16)),
  );
  return toUtf8String(bytes);
};

export const decStringRet = (hexIn: string): string => {
  const hex = strip(hexIn);
  return strAt(hex, Number(uAt(hex, 0)));
};
export const decUintRet = (hex: string): bigint => uAt(strip(hex), 0);
export const decAddrRet = (hex: string): string => addrAt(strip(hex), 0);

export interface NameToken {
  id: bigint;
  balance: bigint;
  username: string;
}

/** Decode the return of CawName.tokens(owner): (uint256, uint256, string)[] */
export function decTokensRet(hexIn: string): NameToken[] {
  const hex = strip(hexIn);
  const arrOff = Number(uAt(hex, 0));
  const n = Number(uAt(hex, arrOff));
  const out: NameToken[] = [];
  for (let i = 0; i < n; i++) {
    const elemOff = arrOff + 32 + Number(uAt(hex, arrOff + 32 + i * 32));
    out.push({
      id: uAt(hex, elemOff),
      balance: uAt(hex, elemOff + 32),
      username: strAt(hex, elemOff + Number(uAt(hex, elemOff + 64))),
    });
  }
  return out;
}

/** Format an 18-decimal amount for display (up to 6 fraction digits). */
export function fmtAmount(wei: bigint): string {
  const s = BigInt(wei).toString().padStart(19, '0');
  const whole = s.slice(0, -18).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = s.slice(-18).replace(/0+$/, '');
  return frac ? whole + '.' + frac.slice(0, 6) : whole;
}

/** Parse a plain decimal amount (up to 18 decimals) into wei, or null. */
export function parseAmount(str: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec((str || '').trim());
  if (!m) return null;
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0'));
}

/* ==== signing core (verified) ==== */
const SC_DS =
  '1131b7219bb3aaedaa16d8f6e50191b447828129c4c2c5b3fa55263a6f37c96d';
const SC_TYPEHASH =
  'd2f7d9453bd20ea9069ffefabd584b9d0b624994852fb9b9568a2a8ecc3517ac';
const SC_EMPTY_HASH = strip(keccak256(new Uint8Array(0)));

const kec = (hexNoPrefix: string): string =>
  strip(keccak256(getBytes('0x' + hexNoPrefix)));

/** The digest a name owner signs for one action. Returns '0x…' hex. */
export function actionDigest(a: CawAction): string {
  const textHash = strip(keccak256(toUtf8Bytes(a.text)));
  const structHash = kec(
    SC_TYPEHASH +
      word(a.type) +
      word(a.senderId) +
      word(a.receiverId) +
      SC_EMPTY_HASH +
      word(a.ts) +
      SC_EMPTY_HASH +
      encAddr(a.sender) +
      strip(a.cawId) +
      textHash,
  );
  return '0x' + kec('1901' + SC_DS + structHash);
}

function encodeAction(a: CawAction): string {
  const tb = toUtf8Bytes(a.text);
  const textTail =
    word(tb.length) +
    Array.from(tb)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .padEnd(Math.ceil(tb.length / 32) * 64 || 64, '0');
  return (
    word(a.type) +
    word(a.senderId) +
    word(a.receiverId) +
    word(0x120) +
    word(a.ts) +
    encAddr(a.sender) +
    word(0x140) +
    strip(a.cawId) +
    word(0x160) +
    word(0) +
    word(0) +
    textTail
  ); // the two tip lists are always empty here
}

/** Full calldata for the processAction batch call. */
export function encodeBatch(actions: CawAction[], sigs: CawSignature[]): string {
  const n = actions.length;
  const tails = actions.map(encodeAction);
  let acts = word(n);
  let off = n * 32;
  const offs = tails.map((t) => {
    const o = off;
    off += t.length / 2;
    return o;
  });
  acts += offs.map((o) => word(o)).join('') + tails.join('');
  const vs = word(n) + sigs.map((s) => word(s.v)).join('');
  const rs = word(n) + sigs.map((s) => strip(s.r)).join('');
  const ss = word(n) + sigs.map((s) => strip(s.s)).join('');
  const head =
    word(0x80) +
    word(0x80 + acts.length / 2) +
    word(0x80 + acts.length / 2 + vs.length / 2) +
    word(0x80 + acts.length / 2 + vs.length / 2 + rs.length / 2);
  return '0x84e33f2f' + word(1) + word(0x40) + head + acts + vs + rs + ss;
}

/**
 * Decode one action out of processAction calldata (the first action of a
 * batch — the timeline only ever renders single-action batches, exactly
 * like the web version). Returns null when the calldata is not a
 * decodable action.
 */
export function decodeAction(raw: string): CawAction | null {
  const hex = strip(raw || '');
  if (!raw || !raw.startsWith('0x84e33f2f') || hex.length < 800 * 2) return null;
  const type = Number(uAt(hex, 4 + 8 * 32));
  if (type > 3) return null;
  const textLen = Number(uAt(hex, 4 + 19 * 32));
  const textHex = hex.slice(
    (4 + 20 * 32) * 2,
    (4 + 20 * 32) * 2 + textLen * 2,
  );
  let text = '';
  try {
    text = toUtf8String(
      new Uint8Array(
        (textHex.match(/../g) || []).map((h) => parseInt(h, 16)),
      ),
    );
  } catch {
    text = '';
  }
  return {
    type,
    senderId: uAt(hex, 4 + 9 * 32),
    receiverId: uAt(hex, 4 + 10 * 32),
    ts: Number(uAt(hex, 4 + 12 * 32)),
    sender: addrAt(hex, 4 + 13 * 32),
    cawId: '0x' + hex.slice((4 + 15 * 32) * 2, (4 + 15 * 32) * 2 + 64),
    text,
  };
}

/** UTF-8 byte length — the 420 limit counts bytes (a Japanese letter = 3). */
export const textBytes = (s: string): number => toUtf8Bytes(s).length;
