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
 */
import { decodeBase64, getBytes, sha256, type Wallet } from 'ethers';

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

/** Read a local file's bytes (picker / cache URIs). The file is
 *  read as base64 through expo-file-system and decoded with
 *  ethers, so the bytes hashed here are exactly the bytes the
 *  multipart upload sends (React Native uploads the file itself;
 *  both read the same URI). */
export async function readFileBytes(fileUri: string): Promise<Uint8Array> {
  const FS = await import('expo-file-system/legacy');
  const b64 = await FS.readAsStringAsync(fileUri, {
    encoding: FS.EncodingType.Base64,
  });
  return getBytes(decodeBase64(b64));
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

const mediaCache = new Map<string, Promise<ProfileMedia | null>>();

/**
 * The shared profile media for one name (icon / header / audio),
 * or null when the name has none — or when the server cannot be
 * reached. Cached per name for the session; failures resolve to
 * null and are cached too (a down server must not turn every
 * avatar on screen into a retry loop). Never rejects.
 */
export function mediaFor(
  nameId: bigint | string | number,
): Promise<ProfileMedia | null> {
  const key = String(nameId);
  if (!mediaCache.has(key)) {
    const p = fetchTimeout(MEDIA_API + '/v1/profile/' + key, undefined, 4000)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) =>
        j && (j.icon || j.header || j.audio) ? (j as ProfileMedia) : null,
      )
      .catch(() => null);
    mediaCache.set(key, p);
  }
  return mediaCache.get(key)!;
}

/** Drop one name's cached profile media (after a set / clear). */
export function invalidateMedia(nameId: bigint | string | number): void {
  mediaCache.delete(String(nameId));
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
  const fd = new FormData();
  fd.append('nameId', String(nameId));
  fd.append('kind', kind);
  fd.append('ts', String(ts));
  fd.append('sig', sig);
  fd.append(
    'file',
    {
      uri: fileUri,
      name: fileNameFor(mimeType, kind),
      type: mimeType || mimeForUri(fileUri),
    } as unknown as Blob,
  );
  const res = await fetchTimeout(
    MEDIA_API + '/v1/profile-media',
    { method: 'POST', body: fd },
    30000,
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
    const fd = new FormData();
    fd.append('nameId', String(nameId));
    fd.append('cawId', cawId);
    fd.append('txHash', txHash);
    fd.append('ts', String(ts));
    fd.append('sig', sig);
    fd.append(
      'file',
      {
        uri: fileUri,
        name: fileNameFor(mimeType, 'image'),
        type: mimeType,
      } as unknown as Blob,
    );
    const res = await fetchTimeout(
      MEDIA_API + '/v1/attach',
      { method: 'POST', body: fd },
      30000,
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
 * already cached (the server accepts up to 50 per call), results
 * cached per cawId for the session. Resolves a map with an entry
 * (possibly empty) for every requested id; never rejects — a
 * failed lookup resolves empty and is NOT cached, so a later
 * call can retry.
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
        5000,
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
      if (okFetch) {
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
