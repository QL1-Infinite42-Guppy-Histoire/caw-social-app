/**
 * Parent references for posts — REPLIES and QUOTE Recaws
 * (app-level convention, v0.4.0).
 *
 * VERIFIED FIRST (2026-11-08): CAW has NO native reply
 * convention. The evidence, gathered before this was designed:
 *  - A full walk of the QL1 CawActions feed (6,065 transactions,
 *    1,035 posts — the chain's whole CAW history) found ZERO
 *    posts with receiverId != 0 and zero posts carrying a parent
 *    cawId in any field or in their text. (The three "@name"
 *    posts in that history are unstructured text mentions —
 *    receiverId still 0, no link to any post.)
 *  - The web front end's 300-transaction verification corpus
 *    (112 posts) shows the same: every post has receiverId = 0.
 *  - Neither the QL1 web client (docs/app.js, which this app was
 *    ported from) nor the contract's action types (0 post,
 *    1 like, 2 share, 3 follow, 4 unfollow) define a reply.
 *
 * So replies and quote Recaws are an APP-LEVEL convention,
 * designed to be the least intrusive extension that still
 * resolves unambiguously:
 *
 *  - Both are ordinary type-0 posts with receiverId = 0 —
 *    byte-for-byte the same action shape as every post ever
 *    sent on QL1, signed and stored exactly the same way.
 *  - The parent reference rides in ONE extra trailing line of
 *    the post text:
 *
 *        [caw:reply:<base64url(parent cawId)>]
 *        [caw:quote:<base64url(parent cawId)>]
 *
 *    The marker keyword is the kind marker: "reply" vs "quote"
 *    vs no marker (a plain post). The cawId is the same post
 *    identifier likes and shares already use (32 bytes,
 *    base64url-encoded without padding = 43 chars, so the whole
 *    marker line costs 56 bytes of the 420-byte post budget).
 *  - The action's own cawId stays a fresh random id (likes are
 *    keyed by (senderId, cawId) on-chain, so a reply must never
 *    reuse its parent's cawId), and receiverId stays 0: the
 *    contract has never seen a post with receiverId set, and
 *    nothing may be risked on unobserved contract behaviour.
 *  - The tip lists stay empty, as in every real action.
 *
 * Other clients see these as ordinary posts whose text ends
 * with one small bracketed line. This app parses the marker,
 * hides the line, and renders the reply context / quote frame.
 * A marker only counts when it is the text's FINAL line and
 * decodes to exactly 32 bytes; anything else is plain text.
 */

export type PostRefKind = 'reply' | 'quote';

export interface PostRef {
  kind: PostRefKind;
  /** The referenced (parent) post's cawId, '0x…' + 64 hex. */
  parentCawId: string;
}

/* ---------- base64url codec for the 32-byte cawId ---------- */
const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function hexToBytes(hex: string): Uint8Array | null {
  const h = (hex || '').replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToB64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    s += B64[b0 >> 2];
    s += B64[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) s += B64[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) s += B64[b2 & 63];
  }
  return s;
}

function b64UrlToHex(s: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(s)) return null;
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bytes.length !== 32) return null;
  return (
    '0x' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
  );
}

/* ---------- the marker line ---------- */
const MARKER_RE = /\[caw:(reply|quote):([A-Za-z0-9_-]{43})\]/;

/** The full marker line for a parent reference (no newline). */
export function postRefMarker(ref: PostRef): string | null {
  const bytes = hexToBytes(ref.parentCawId);
  if (!bytes) return null;
  return '[caw:' + ref.kind + ':' + bytesToB64Url(bytes) + ']';
}

/** Bytes the marker adds to a post's text ('\n' + marker line). */
export function postRefOverhead(ref: PostRef): number {
  const m = postRefMarker(ref);
  return m ? m.length + 1 : 0;
}

/** Append the marker as the text's final line. */
export function appendPostRef(text: string, ref: PostRef): string {
  const m = postRefMarker(ref);
  if (!m) return text;
  const body = (text || '').replace(/\s+$/, '');
  return body + '\n' + m;
}

export interface ParsedPostText {
  /** The text with a recognised marker line removed. */
  body: string;
  /** The parent reference, when the final line is a valid marker. */
  ref: PostRef | null;
}

/**
 * Split a post's raw text into display body + parent reference.
 * Only a marker on the FINAL line counts (a marker quoted in the
 * middle of a text is just text), and only when it decodes to a
 * real 32-byte cawId.
 */
export function parsePostText(text: string): ParsedPostText {
  const raw = text || '';
  const nl = raw.lastIndexOf('\n');
  const lastLine = (nl >= 0 ? raw.slice(nl + 1) : raw).trim();
  const m = MARKER_RE.exec(lastLine);
  if (m && m[0] === lastLine) {
    const parentCawId = b64UrlToHex(m[2]);
    if (parentCawId) {
      return {
        body: (nl >= 0 ? raw.slice(0, nl) : '').replace(/\s+$/, ''),
        ref: { kind: m[1] as PostRefKind, parentCawId },
      };
    }
  }
  return { body: raw, ref: null };
}

/** Just the display body (marker line hidden). */
export function displayTextOf(text: string): string {
  return parsePostText(text).body;
}
