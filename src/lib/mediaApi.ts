/**
 * CAW media server client (v0.7.3).
 *
 * A small server on the community VPS holds profile icons, header
 * images, profile audio and post image attachments for QL1 CAW.
 * It is a pure sidecar: the on-chain CAW protocol never depends on
 * it. If the server is unreachable, icons fall back to the NFT card
 * image and posts render text-only — every read here resolves to
 * null / empty on failure and NEVER throws into rendering.
 *
 * Writes are authorised by an EIP-191 personal_sign signature from
 * the wallet that owns the CAW name; the server verifies the
 * signer against CawName ownerOf on-chain (and, for attachments,
 * that the post's own transaction created the cawId under that
 * name). The signed message format is shared byte for byte with
 * the server and the web viewer:
 *
 *   CAW Media v1
 *   action: <set-icon|set-header|set-audio|clear-*|attach>
 *   name: <decimal name id>
 *   sha256: <hex sha256 of the file bytes; the empty hash for clear-*>
 *   caw: <0x cawId for attach, else ->
 *   tx: <0x post tx hash for attach, else ->
 *   ts: <unix seconds>
 *
 * This module is kept free of React and of top-level native
 * imports (expo-file-system is loaded lazily, only when a file
 * actually has to be read) so the verify harnesses can compile
 * and exercise the pure parts in Node.
 *
 * v0.7.4 transport fix: v0.7.3 read files through the LEGACY
 * expo-file-system API and uploaded them as React Native
 * FormData file parts — on the user's device EVERY write failed
 * before/at sending (the server saw zero requests) while the
 * Node harnesses, which mock both steps, stayed green. Files
 * are now read with the current expo-file-system File API (the
 * one lib/profileImage.ts uses) and the multipart body is built
 * by hand as bytes (buildMultipartBody), so the exact bytes
 * that were hashed for the signature are the bytes sent.
 *
 * v0.7.5 display fix: uploads landed but the image did not show
 * under the post. attachmentsFor cached EMPTY results for the
 * whole session, and a post's card normally mounts (and looks
 * up its attachments) BEFORE the composer's upload finishes —
 * so the first, legitimately empty, answer was pinned forever.
 * Empty results are no longer cached (only non-empty lists
 * are), and the read timeouts grew to 15 s so a slow cold read
 * through the relay stops feeding the empty path.
 *
 * v0.7.10 display fix: the same pinning on the profile-media
 * path — mediaFor cached a FAILED fetch (HTTP error / network
 * failure resolving to null) for the whole session, so one
 * transient failure hid a name's icon / header / audio until
 * the app restarted. Failures are now cached only for a short
 * negative-cache TTL (MEDIA_NEGATIVE_CACHE_MS); a successful
 * answer — media present, or a legitimately empty profile —
 * is still cached for the session exactly as before.
 */
import { sha256, type Wallet } from 'ethers';

export const MEDIA_API =
  'https://vps-2026-11-12-16-49-27.tail303bfa.ts.net:10000';

/** sha256 of the empty string — the digest clear-* actions sign. */
export const MEDIA_EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export type MediaKind = 'icon' | 'header' | 'audio';

/** Server-side size caps (bytes); mirrored client-side so an
 *  oversize file fails fast with a clear note instead of a 413. */
export const MEDIA_CAPS: Record<MediaKind | 'attach', number> = {
  icon: 2 * 1024 * 1024,
  header: 4 * 1024 * 1024,
  audio: 10 * 1024 * 1024,
  attach: 8 * 1024 * 1024,
};

/** Max images the server accepts per post. */
export const MEDIA_ATTACH_PER_POST = 4;

export interface MediaEntry {
  url: string;
  size: number;
  updatedAt?: number;
}

export interface ProfileMedia {
  nameId: string;
  icon: MediaEntry | null;
  header: MediaEntry | null;
  audio: MediaEntry | null;
}

export interface PostAttachment {
  url: string;
  size: number;
}

/** A failed write against the media server. `status` is the HTTP
 *  status (0 when the request never completed); `serverError` is
 *  the server's own {error} text when it sent one. */
export class MediaApiError extends Error {
  status: number;
  serverError: string;
  constructor(status: number, serverError: string) {
    super('media ' + status + (serverError ? ': ' + serverError : ''));
    this.name = 'MediaApiError';
    this.status = status;
    this.serverError = serverError;
  }
}

/** True when a media write was refused because the acting
 *  name is sanctioned (v0.7.9): the server answers 403 with
 *  an "account sanctioned" error, and the UI swaps its
 *  generic failure note for the sanction wording. */
export function isSanctionedError(e: unknown): boolean {
  return (
    e instanceof MediaApiError &&
    e.status === 403 &&
    /sanction/i.test(e.serverError || '')
  );
}

/** One-line detail for a failed media write, appended to the UI
 *  failure notes (v0.7.4). The bare "sharing failed" note hid
 *  WHICH step broke; the note now carries the error's own
 *  message — MediaApiError's includes the HTTP status and the
 *  server's error text — trimmed to a short single line. */
export function mediaErrorDetail(e: unknown): string {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  const raw = typeof m === 'string' && m ? m : String(e);
  return raw.length > 100 ? raw.slice(0, 100) : raw;
}

/** The signed message, byte for byte as the server rebuilds it. */
export function buildMediaMessage(o: {
  action: string;
  nameId: string;
  sha256: string;
  caw?: string;
  tx?: string;
  ts: number | string;
}): string {
  return [
    'CAW Media v1',
    'action: ' + o.action,
    'name: ' + o.nameId,
    'sha256: ' + o.sha256,
    'caw: ' + (o.caw || '-'),
    'tx: ' + (o.tx || '-'),
    'ts: ' + o.ts,
  ].join('\n');
}

/* ---------------- transport ---------------- */

async function fetchTimeout(
  url: string,
  init: RequestInit | undefined,
  ms: number,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...(init || {}), signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function throwForBad(res: Response): Promise<void> {
  if (res.ok) return;
  let serverError = '';
  try {
    const j = await res.json();
    if (j && typeof j.error === 'string') serverError = j.error;
  } catch {
    /* a non-JSON error body — the status alone will have to do */
  }
  throw new MediaApiError(res.status, serverError);
}

/** Fixed boundary for the hand-built upload bodies. */
export const MEDIA_MULTIPART_BOUNDARY =
  '----CAWMediaBoundary7MA4YWxkTrZu0gW';

/**
 * Assemble a multipart/form-data body BY HAND, as bytes: the
 * text fields in the given order, then ONE file part, then the
 * closing boundary. v0.7.3 sent React Native FormData file
 * parts and every write failed on the device before/at sending
 * (the server logged zero requests); this framing is the exact
 * byte layout the parent agent verified the live server accepts
 * (it recovers the signer and answers 403 for a non-owner).
 * Pure and exported so the harness can pin the bytes.
 */
export function buildMultipartBody(
  fields: Array<[string, string]>,
  fileField: string,
  fileName: string,
  fileType: string,
  fileBytes: Uint8Array,
  boundary: string,
): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of fields) {
    parts.push(
      enc.encode(
        '--' +
          boundary +
          '\r\nContent-Disposition: form-data; name="' +
          name +
          '"\r\n\r\n' +
          value +
          '\r\n',
      ),
    );
  }
  parts.push(
    enc.encode(
      '--' +
        boundary +
        '\r\nContent-Disposition: form-data; name="' +
        fileField +
        '"; filename="' +
        fileName +
        '"\r\nContent-Type: ' +
        fileType +
        '\r\n\r\n',
    ),
  );
  parts.push(fileBytes);
  parts.push(enc.encode('\r\n--' + boundary + '--\r\n'));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** POST fields + one file to a media endpoint as a hand-built
 *  multipart body (see buildMultipartBody). The body is sent as
 *  an ArrayBuffer sliced to exactly the built bytes. */
async function postMultipart(
  path: string,
  fields: Array<[string, string]>,
  fileName: string,
  fileType: string,
  fileBytes: Uint8Array,
): Promise<Response> {
  const body = buildMultipartBody(
    fields,
    'file',
    fileName,
    fileType,
    fileBytes,
    MEDIA_MULTIPART_BOUNDARY,
  );
  const buf = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;
  return fetchTimeout(
    MEDIA_API + path,
    {
      method: 'POST',
      headers: {
        'content-type':
          'multipart/form-data; boundary=' + MEDIA_MULTIPART_BOUNDARY,
      },
      body: buf,
    },
    30000,
  );
}

/** Read a local file's bytes (picker / cache URIs) with the
 *  current expo-file-system File API — the same class the
 *  profile-image store (lib/profileImage.ts) uses. A content://
 *  URI (what the Android document picker hands out for profile
 *  audio) is first copied into the app's cache folder and the
 *  copy is read, since not every content provider can be read
 *  in place. The bytes returned here are both hashed for the
 *  signature and uploaded, so the digest the signature covers
 *  is always the digest of what the server receives. */
export async function readFileBytes(fileUri: string): Promise<Uint8Array> {
  const { File, Paths } = await import('expo-file-system');
  let file = new File(fileUri);
  if (fileUri.startsWith('content://')) {
    const copy = new File(
      Paths.cache,
      'media-read-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
    );
    await file.copy(copy, { overwrite: true });
    file = copy;
  }
  return file.bytes();
}

/** Hex sha256 (no 0x prefix — the wire format) of raw bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return sha256(bytes).replace(/^0x/, '');
}

function fileNameFor(mimeType: string | undefined, fallback: string): string {
  const m = (mimeType || '').toLowerCase();
  if (m.includes('png')) return fallback + '.png';
  if (m.includes('webp')) return fallback + '.webp';
  if (m.includes('gif')) return fallback + '.gif';
  if (m.includes('mp3') || m.includes('mpeg')) return fallback + '.mp3';
  if (m.includes('mp4') || m.includes('m4a')) return fallback + '.m4a';
  if (m.includes('ogg')) return fallback + '.ogg';
  return fallback + '.jpg';
}

function mimeForUri(uri: string): string {
  const ext = uri.split('?')[0].split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/mp4';
    case 'ogg':
      return 'audio/ogg';
    default:
      return 'image/jpeg';
  }
}

/* ---------------- profile media reads ---------------- */

/** How long a FAILED profile-media fetch stays cached (ms).
 *  A down server must not turn every avatar on screen into a
 *  retry loop, so failures are still cached — but only for
 *  this short TTL (v0.7.10): once it lapses the next lookup
 *  refetches, so a transient failure recovers within the
 *  session instead of pinning the fallback look until the
 *  app restarts. Successful answers are NOT subject to this
 *  TTL — they are cached for the session as before. */
export const MEDIA_NEGATIVE_CACHE_MS = 30000;

interface MediaCacheEntry {
  promise: Promise<ProfileMedia | null>;
  /** Epoch ms until which a FAILED result stays cached;
   *  0 while the fetch is in flight or when the result was
   *  a success (present media or a legitimately empty
   *  profile), which stays cached for the whole session. */
  negativeUntil: number;
}

const mediaCache = new Map<string, MediaCacheEntry>();

/**
 * The shared profile media for one name (icon / header / audio),
 * or null when the name has none — or when the server cannot be
 * reached. Successful answers are cached per name for the
 * session; failures resolve to null and are cached only for
 * MEDIA_NEGATIVE_CACHE_MS (a down server must not turn every
 * avatar on screen into a retry loop, but a transient failure
 * must not pin the fallback for the whole session either).
 * Never rejects.
 */
export function mediaFor(
  nameId: bigint | string | number,
): Promise<ProfileMedia | null> {
  const key = String(nameId);
  const hit = mediaCache.get(key);
  if (hit) {
    if (hit.negativeUntil === 0 || hit.negativeUntil > Date.now()) {
      return hit.promise;
    }
    mediaCache.delete(key);
  }
  const entry: MediaCacheEntry = {
    promise: Promise.resolve(null),
    negativeUntil: 0,
  };
  let failed = false;
  const p = fetchTimeout(MEDIA_API + '/v1/profile/' + key, undefined, 15000)
    .then((r) => {
      if (!r.ok) failed = true;
      return r.ok ? r.json() : null;
    })
    .then((j) =>
      j && (j.icon || j.header || j.audio) ? (j as ProfileMedia) : null,
    )
    .catch(() => {
      failed = true;
      return null;
    })
    .then((result) => {
      if (result === null && failed) {
        entry.negativeUntil = Date.now() + MEDIA_NEGATIVE_CACHE_MS;
      }
      return result;
    });
  entry.promise = p;
  mediaCache.set(key, entry);
  return p;
}

/** Drop one name's cached profile media (after a set / clear). */
export function invalidateMedia(nameId: bigint | string | number): void {
  mediaCache.delete(String(nameId));
}

/** Drop one post's cached attachment list (after an admin
 *  delete, so other cards stop serving the removed image). */
export function invalidateAttachments(cawId: string): void {
  attachCache.delete(String(cawId).toLowerCase());
}

/* ---------------- moderation (admin API, v0.7.6) ----------------
 * The media server keeps a small admin list (one root plus the
 * moderators it appoints). When the app's wallet address is on
 * it, the app grows moderation tools: posts can be hidden
 * (display-level only — the post stays on-chain and other
 * clients may still show it), profile media and post
 * attachments can be hidden or deleted, and the root can
 * appoint / revoke moderators. Every op is an EIP-191
 * personal_sign by the wallet over the admin message format —
 * the media format plus a `target:` line before `ts:` — and
 * the server authorises it against its admin list, never
 * against name ownership. The format and the error mapping
 * are shared byte for byte / rule for rule with the web
 * viewer (buildAdminMessage / adminOpErrorKey there).
 *
 * Hidden MEDIA truth is the server's own list: the
 * `list-hidden` op returns every hidden profile item and
 * attachment, so a hide can be undone from any session —
 * there is no session-only limitation. */

export type AdminRole = 'root' | 'mod';

export interface AdminEntry {
  address: string;
  role: AdminRole;
}

/** The admin list (GET /v1/admins). Null on any failure —
 *  a down server simply means "no admin UI this time". */
export async function fetchAdmins(): Promise<AdminEntry[] | null> {
  try {
    const res = await fetchTimeout(MEDIA_API + '/v1/admins', undefined, 15000);
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || !Array.isArray(j.admins)) return null;
    return j.admins
      .filter(
        (a: unknown): a is AdminEntry =>
          !!a &&
          typeof (a as AdminEntry).address === 'string' &&
          ((a as AdminEntry).role === 'root' ||
            (a as AdminEntry).role === 'mod'),
      )
      .map((a: AdminEntry) => ({
        address: a.address.toLowerCase(),
        role: a.role,
      }));
  } catch {
    return null;
  }
}

/** The hidden-post list (GET /v1/hidden-posts): lowercase
 *  cawIds our frontends must not render for non-admins.
 *  Null on any failure (callers keep the last good list). */
export async function fetchHiddenPosts(): Promise<string[] | null> {
  try {
    const res = await fetchTimeout(
      MEDIA_API + '/v1/hidden-posts',
      undefined,
      15000,
    );
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || !Array.isArray(j.posts)) return null;
    return j.posts.map((x: unknown) => String(x).toLowerCase());
  } catch {
    return null;
  }
}

/** One active user sanction (v0.7.9, GET /v1/sanctions):
 *  a CAW name frozen until `until` (ms) or banned
 *  (`until` null). The list carries ACTIVE sanctions
 *  only, newest first. */
export interface SanctionEntry {
  nameId: string;
  kind: 'freeze' | 'ban';
  until: number | null;
  ts: number;
}

/** The active-sanctions list (GET /v1/sanctions). Null on
 *  any failure (callers keep the last good list). */
export async function fetchSanctions(): Promise<SanctionEntry[] | null> {
  try {
    const res = await fetchTimeout(
      MEDIA_API + '/v1/sanctions',
      undefined,
      15000,
    );
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || !Array.isArray(j.sanctions)) return null;
    const out: SanctionEntry[] = [];
    for (const e of j.sanctions as Array<Record<string, unknown>>) {
      if (
        !e ||
        e.nameId == null ||
        (e.kind !== 'freeze' && e.kind !== 'ban')
      ) {
        continue;
      }
      out.push({
        nameId: String(e.nameId),
        kind: e.kind,
        until: typeof e.until === 'number' ? e.until : null,
        ts: typeof e.ts === 'number' ? e.ts : 0,
      });
    }
    return out;
  } catch {
    return null;
  }
}

export interface AdminOpFields {
  action: string;
  nameId?: string | number | null;
  sha256?: string | null;
  cawId?: string | null;
  target?: string | null;
}

/** The signed admin message, byte for byte as the server
 *  rebuilds it: the media format with a `target:` line.
 *  Canonicalisation IS the contract — name is the decimal id
 *  or -, sha256 the lowercase hash (the empty hash when the
 *  action pins no media), caw / target the lowercase hex
 *  or -. Clients sign the lowercase forms. */
export function buildAdminMessage(o: {
  action: string;
  nameId?: string | number | null;
  sha256?: string | null;
  cawId?: string | null;
  target?: string | null;
  ts: number | string;
}): string {
  return [
    'CAW Media v1',
    'action: ' + o.action,
    'name: ' +
      (o.nameId != null && o.nameId !== '' ? String(o.nameId) : '-'),
    'sha256: ' +
      (o.sha256 ? String(o.sha256).toLowerCase() : MEDIA_EMPTY_SHA256),
    'caw: ' + (o.cawId ? String(o.cawId).toLowerCase() : '-'),
    'tx: -',
    'target: ' + (o.target ? String(o.target).toLowerCase() : '-'),
    'ts: ' + o.ts,
  ].join('\n');
}

/** Map an admin-op rejection to its string-table suffix.
 *  403 splits by the server's message (not an admin vs root
 *  only); 409 is the stale-hash race and gets its own honest
 *  wording. Mirrors the web viewer's adminOpErrorKey. */
export function adminOpErrorKey(
  status: number,
  msg: string,
): 'notAdmin' | 'rootOnly' | 'cannotSanction' | 'changed' | 'notFound' | 'sig' | 'throttle' | 'bad' | 'fail' {
  const m = String(msg || '');
  if (status === 403) {
    if (m.includes('cannot sanction')) return 'cannotSanction';
    return m.includes('root only') ? 'rootOnly' : 'notAdmin';
  }
  if (status === 409) return 'changed';
  if (status === 404) return 'notFound';
  if (status === 401) return 'sig';
  if (status === 429) return 'throttle';
  if (status === 400) return 'bad';
  return 'fail';
}

/** Media blobs are content-addressed: /media/<sha256>.<ext>.
 *  The hash an admin op must pin is read back out of the URL
 *  the public reads already hand the client. */
export function hashFromMediaUrl(url: string): string | null {
  const m = /\/media\/([0-9a-f]{64})\.[a-z0-9]+/.exec(String(url || ''));
  return m ? m[1] : null;
}

/**
 * One signed admin op (POST /v1/admin/op). The body carries
 * ONLY the fields the action uses, plus action / ts / sig —
 * the message is the canonical buildAdminMessage form.
 * Resolves with the server's JSON; rejects with MediaApiError
 * (status + the server's own error text) on any failure.
 */
export async function adminOp(
  signer: Wallet,
  fields: AdminOpFields,
): Promise<Record<string, unknown>> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signer.signMessage(
    buildAdminMessage({ ...fields, ts }),
  );
  const body: Record<string, unknown> = { action: fields.action, ts, sig };
  if (fields.nameId != null && fields.nameId !== '') {
    body.nameId = String(fields.nameId);
  }
  if (fields.sha256) body.sha256 = String(fields.sha256).toLowerCase();
  if (fields.cawId) body.cawId = String(fields.cawId).toLowerCase();
  if (fields.target) body.target = String(fields.target).toLowerCase();
  const res = await fetchTimeout(
    MEDIA_API + '/v1/admin/op',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    15000,
  );
  let j: Record<string, unknown> | null = null;
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    /* a non-JSON body — the status alone will have to do */
  }
  if (!res.ok) {
    throw new MediaApiError(
      res.status,
      j && typeof j.error === 'string' ? j.error : '',
    );
  }
  return j ?? {};
}

/** One entry of the server's hidden-media list. Profile items
 *  carry kind + nameId; attachments carry kind 'attach' +
 *  cawId. `ts` is the hide time in MILLISECONDS (server form). */
export type HiddenMediaEntry =
  | {
      kind: MediaKind;
      nameId: string;
      hash: string;
      hiddenBy: string;
      ts: number;
    }
  | {
      kind: 'attach';
      cawId: string;
      hash: string;
      hiddenBy: string;
      ts: number;
    };

/**
 * The server's hidden-media list (the `list-hidden` admin
 * op, newest first) — the durable truth for media unhide:
 * every entry can be unhidden / deleted straight from the
 * list, in any session. Resolves [] when the server reports
 * none; rejects with MediaApiError on failure (callers keep
 * the last good list).
 */
export async function listHiddenMedia(
  signer: Wallet,
): Promise<HiddenMediaEntry[]> {
  const j = await adminOp(signer, { action: 'list-hidden' });
  const raw = Array.isArray(j.hidden) ? j.hidden : [];
  const out: HiddenMediaEntry[] = [];
  for (const e of raw as Array<Record<string, unknown>>) {
    if (!e || typeof e.hash !== 'string') continue;
    const base = {
      hash: String(e.hash).toLowerCase(),
      hiddenBy: typeof e.hiddenBy === 'string' ? e.hiddenBy : '',
      ts: typeof e.ts === 'number' ? e.ts : 0,
    };
    if (e.kind === 'attach' && typeof e.cawId === 'string') {
      out.push({ kind: 'attach', cawId: e.cawId.toLowerCase(), ...base });
    } else if (
      (e.kind === 'icon' || e.kind === 'header' || e.kind === 'audio') &&
      e.nameId != null
    ) {
      out.push({
        kind: e.kind as MediaKind,
        nameId: String(e.nameId),
        ...base,
      });
    }
  }
  return out;
}

/** The one visibility rule for posts: a hidden post is
 *  dropped for everyone except admins, who keep seeing it
 *  (marked). Mirrors the web viewer's modItemVisible. */
export function postVisible(hidden: boolean, isAdmin: boolean): boolean {
  return !hidden || !!isAdmin;
}

/** The list choke point, mirroring the web's modFilterItems:
 *  feed-shaped items (type 0 posts and type 2 Recaws carry
 *  the post's cawId; other types are never posts) filtered
 *  against the lowercase hidden set. Admins keep everything. */
export function filterModeratedItems<
  T extends { type: number; cawId: string },
>(items: T[], hidden: Set<string>, isAdmin: boolean): T[] {
  if (!items || !hidden || hidden.size === 0 || isAdmin) return items || [];
  return items.filter(
    (a) =>
      !(
        a &&
        (a.type === 0 || a.type === 2) &&
        a.cawId &&
        hidden.has(String(a.cawId).toLowerCase())
      ),
  );
}

/** The author-side companion (v0.7.9): posts and Recaws
 *  whose AUTHOR name is under an active sanction are
 *  dropped for non-admins (admins keep them, marked).
 *  Same item-shape discipline as filterModeratedItems —
 *  only types 0 and 2 are posts. */
export function filterSanctionedItems<
  T extends { type: number; senderId: bigint },
>(items: T[], sanctionedNames: Set<string>, isAdmin: boolean): T[] {
  if (!items || !sanctionedNames || sanctionedNames.size === 0 || isAdmin) {
    return items || [];
  }
  return items.filter(
    (a) =>
      !(
        a &&
        (a.type === 0 || a.type === 2) &&
        sanctionedNames.has(a.senderId.toString())
      ),
  );
}

/* ---------------- profile media writes ---------------- */

/**
 * Upload (or replace) one piece of profile media for a name the
 * signer owns. `fileUri` is a local file URI; `mimeType` its
 * picker-reported type (the server sniffs the magic bytes itself,
 * so this only names the multipart part). Resolves with the
 * stored entry; rejects with MediaApiError on any failure.
 */
export async function setProfileMedia(
  kind: MediaKind,
  fileUri: string,
  mimeType: string | undefined,
  signer: Wallet,
  nameId: bigint | string,
): Promise<{ ok: true; kind: MediaKind; url: string; hash: string }> {
  const bytes = await readFileBytes(fileUri);
  if (bytes.length > MEDIA_CAPS[kind]) {
    throw new MediaApiError(413, kind + ' too large');
  }
  const hash = sha256Hex(bytes);
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signer.signMessage(
    buildMediaMessage({
      action: 'set-' + kind,
      nameId: String(nameId),
      sha256: hash,
      ts,
    }),
  );
  const res = await postMultipart(
    '/v1/profile-media',
    [
      ['nameId', String(nameId)],
      ['kind', kind],
      ['ts', String(ts)],
      ['sig', sig],
    ],
    fileNameFor(mimeType, kind),
    mimeType || mimeForUri(fileUri),
    bytes,
  );
  await throwForBad(res);
  invalidateMedia(nameId);
  return res.json();
}

/** Remove one piece of profile media (the server forgets the
 *  mapping; the name falls back to the default look). */
export async function clearProfileMedia(
  kind: MediaKind,
  signer: Wallet,
  nameId: bigint | string,
): Promise<{ ok: true; cleared: boolean }> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signer.signMessage(
    buildMediaMessage({
      action: 'clear-' + kind,
      nameId: String(nameId),
      sha256: MEDIA_EMPTY_SHA256,
      ts,
    }),
  );
  const res = await fetchTimeout(
    MEDIA_API + '/v1/clear',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nameId: String(nameId), kind, ts, sig }),
    },
    15000,
  );
  await throwForBad(res);
  invalidateMedia(nameId);
  return res.json();
}

/* ---------------- post attachments ---------------- */

/**
 * Attach one image to an already-confirmed post. The server
 * re-reads the post transaction and requires it to contain this
 * cawId authored by this name + signer, so a 404 ("post
 * transaction not found yet") is retried once after a pause —
 * the chain read can lag the receipt by a few seconds.
 */
export async function attachToPost(
  cawId: string,
  txHash: string,
  fileUri: string,
  signer: Wallet,
  nameId: bigint | string,
): Promise<{ ok: true; url: string; hash: string }> {
  const bytes = await readFileBytes(fileUri);
  if (bytes.length > MEDIA_CAPS.attach) {
    throw new MediaApiError(413, 'image too large');
  }
  const hash = sha256Hex(bytes);
  const mimeType = mimeForUri(fileUri);
  for (let attempt = 0; attempt < 2; attempt++) {
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signer.signMessage(
      buildMediaMessage({
        action: 'attach',
        nameId: String(nameId),
        sha256: hash,
        caw: cawId.toLowerCase(),
        tx: txHash.toLowerCase(),
        ts,
      }),
    );
    const res = await postMultipart(
      '/v1/attach',
      [
        ['nameId', String(nameId)],
        ['cawId', cawId],
        ['txHash', txHash],
        ['ts', String(ts)],
        ['sig', sig],
      ],
      fileNameFor(mimeType, 'image'),
      mimeType,
      bytes,
    );
    if (res.ok) {
      attachCache.delete(cawId.toLowerCase());
      return res.json();
    }
    if (res.status !== 404 || attempt === 1) {
      await throwForBad(res);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new MediaApiError(404, 'post transaction not found yet');
}

const attachCache = new Map<string, Promise<PostAttachment[]>>();

/**
 * Attachments for a batch of posts: ONE GET for every id not
 * already cached (the server accepts up to 50 per call).
 * NON-EMPTY results are cached per cawId for the session;
 * empty results are NEVER cached — a post's attachments land
 * moments after the post itself first renders (the composer
 * uploads after the tx confirms), so an empty answer is a
 * "not yet", not a "never", and caching it hid the image for
 * the whole session (the v0.7.5 bug). Resolves a map with an
 * entry (possibly empty) for every requested id; never
 * rejects — a failed lookup also resolves empty, uncached,
 * so a later call can retry.
 */
export async function attachmentsFor(
  cawIds: string[],
): Promise<Map<string, PostAttachment[]>> {
  const out = new Map<string, PostAttachment[]>();
  const wanted = [
    ...new Set(cawIds.map((c) => c.toLowerCase()).filter(Boolean)),
  ];
  const missing: string[] = [];
  for (const id of wanted) {
    const hit = attachCache.get(id);
    if (hit) out.set(id, await hit);
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    let media: Record<string, PostAttachment[]> = {};
    let okFetch = false;
    try {
      const res = await fetchTimeout(
        MEDIA_API + '/v1/posts?caw=' + chunk.join(','),
        undefined,
        15000,
      );
      if (res.ok) {
        const j = await res.json();
        if (j && j.media) {
          media = j.media as Record<string, PostAttachment[]>;
          okFetch = true;
        }
      }
    } catch {
      /* fall through — every id in the chunk resolves empty */
    }
    for (const id of chunk) {
      const list = (media[id] || []).slice(0, MEDIA_ATTACH_PER_POST);
      out.set(id, list);
      // Cache ONLY a non-empty list (v0.7.5). An empty answer —
      // from a successful fetch just as much as from a failed
      // one — must stay retryable: the post's own upload may
      // land a second later, and a cached [] would hide it
      // until the app restarts.
      if (okFetch && list.length > 0) {
        attachCache.set(id, Promise.resolve(list));
      }
    }
  }
  return out;
}

/* Per-card convenience: individual lookups made in the same
 * render pass are coalesced into one attachmentsFor batch (one
 * GET), so a timeline of post cards costs a single request. */
const pendingAttach = new Map<
  string,
  Array<(v: PostAttachment[]) => void>
>();
let attachTimer: ReturnType<typeof setTimeout> | null = null;

/** Attachments for ONE post, batched with its neighbours. */
export function attachmentLookup(cawIdIn: string): Promise<PostAttachment[]> {
  const cawId = (cawIdIn || '').toLowerCase();
  if (!cawId) return Promise.resolve([]);
  const hit = attachCache.get(cawId);
  if (hit) return hit;
  return new Promise((resolve) => {
    const arr = pendingAttach.get(cawId) || [];
    arr.push(resolve);
    pendingAttach.set(cawId, arr);
    if (!attachTimer) {
      attachTimer = setTimeout(() => {
        attachTimer = null;
        const ids = [...pendingAttach.keys()];
        attachmentsFor(ids)
          .then((map) => {
            for (const id of ids) {
              const waiters = pendingAttach.get(id) || [];
              pendingAttach.delete(id);
              const v = map.get(id) || [];
              for (const w of waiters) w(v);
            }
          })
          .catch(() => {
            for (const id of ids) {
              const waiters = pendingAttach.get(id) || [];
              pendingAttach.delete(id);
              for (const w of waiters) w([]);
            }
          });
      }, 60);
    }
  });
}
