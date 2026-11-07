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

/**
 * Decode the return of CawName.tokens(owner): (uint256, uint256, string)[]
 *
 * The username in each row is the token's true (minted) name — the
 * rows agree with the tokenURI cards and the mint records. The one
 * shifted getter on this contract is usernames(): usernames(n)
 * returns token n+1's name. (An earlier version of this comment
 * claimed the opposite; the mint transactions — e.g. mint("neptune")
 * creating token 190, whose tokens() row and card both say
 * "neptune" — settled which side is shifted.) The app still builds
 * "my names" from tokenOfOwnerByIndex + ownerOf with card names, so
 * this decoder serves the verification scripts.
 */
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

/* ---------- generated avatars (fallback) ---------- */
/**
 * Fallback avatar, generated from a name's card name (the tokenURI
 * name field — the mint truth): the initial letter on a colour
 * hashed from that name. Used while the card picture loads, when a
 * token has no picture, and for names whose card cannot be read.
 * The picture itself comes from tokenURI (see avatarFor in
 * cawApi.ts) and a user's own on-device custom picture, when set,
 * still wins over both (see profileCustom.ts).
 */
const AVATAR_COLORS = [
  '#1d9bf0', '#6c4bd8', '#e0245e', '#e8590c',
  '#00ba7c', '#0f7ae5', '#7c3aed', '#c9184a',
  '#087f5b', '#1971c2', '#a61e4d', '#5f3dc4',
];

function avatarHash(seed: string): number {
  // FNV-1a, 32-bit — small, deterministic on every platform.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function avatarSpec(
  username: string | null | undefined,
  id: bigint,
): { letter: string; bg: string } {
  const name = (username || '').trim();
  const letter = name ? name.charAt(0).toUpperCase() : '?';
  const seed = name ? name.toLowerCase() : 'id:' + id.toString();
  return { letter, bg: AVATAR_COLORS[avatarHash(seed) % AVATAR_COLORS.length] };
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
 * Decode ALL actions out of processAction calldata by walking the batch
 * structure (array offsets first, then each action's own field offsets —
 * the text is found through the action's text-offset field, so actions
 * with non-empty tip lists decode correctly too).
 *
 * On QL1 every real batch seen so far carries a single action, but the
 * decoder must not silently drop or misread a batch if that ever
 * changes. Returns [] when the calldata is not a decodable batch (the
 * deployer's no-op calls with zero actions land here too).
 */
export function decodeActions(raw: string): CawAction[] {
  if (!raw || !raw.startsWith('0x84e33f2f')) return [];
  const hex = strip(raw);
  const body = hex.slice(8); // after the 4-byte selector
  const wAt = (i: number): string => body.slice(i * 64, i * 64 + 64);
  const wi = (i: number): number => {
    const w = wAt(i);
    if (w.length < 64) throw new Error('short calldata');
    return Number(BigInt('0x' + w));
  };
  try {
    // word 0: a constant (1 in every real batch), word 1: offset of the
    // head (four array offsets: actions, v, r, s).
    const headAt = wi(1) / 32;
    const actsAt = headAt + wi(headAt) / 32;
    const n = wi(actsAt);
    if (n < 0 || n > 64) return [];
    const out: CawAction[] = [];
    for (let k = 0; k < n; k++) {
      const tOff = actsAt + 1 + wi(actsAt + 1 + k) / 32;
      const f = (i: number): string => wAt(tOff + i);
      const fi = (i: number): bigint => BigInt('0x' + f(i));
      const type = Number(fi(0));
      if (type > 3) continue;
      // field 8 is the offset of the text tail, relative to the action
      const textWord = tOff + Number(fi(8)) / 32;
      const textLen = wi(textWord);
      if (textLen < 0 || textLen > 4096) continue;
      const textHex = body.slice(
        (textWord + 1) * 64,
        (textWord + 1) * 64 + textLen * 2,
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
      out.push({
        type,
        senderId: fi(1),
        receiverId: fi(2),
        ts: Number(fi(4)),
        sender: '0x' + f(5).slice(24),
        cawId: '0x' + f(7),
        text,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Decode one action out of processAction calldata (the first action of
 * a batch). Returns null when the calldata carries no decodable action.
 */
export function decodeAction(raw: string): CawAction | null {
  const all = decodeActions(raw);
  return all.length ? all[0] : null;
}

/** UTF-8 byte length — the 420 limit counts bytes (a Japanese letter = 3). */
export const textBytes = (s: string): number => toUtf8Bytes(s).length;
