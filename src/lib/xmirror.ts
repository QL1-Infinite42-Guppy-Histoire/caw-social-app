/**
 * X mirror （ミラー) — pure logic (v0.5.0-x).
 *
 * The user's own posts on X are detected and offered for
 * "engraving": posting the same text on CAW as a normal post.
 * Engraving is NEVER automatic — the user confirms and signs
 * in the app, through the standard sign flow (see
 * actionFlow.performMirrorPost). This module holds everything
 * that can be decided without a device: the OAuth 2.0 + PKCE
 * shapes, the token/session bookkeeping rules, the timeline
 * parsing (which posts are mirror candidates), the engraved
 * dedupe, and the X API error classification.
 *
 * No React Native / Expo imports here — the Node verification
 * harness (scripts/verify-xmirror.mjs) compiles and loads this
 * file directly. The device-side glue (secure store, system
 * browser, fetch) lives in lib/xconnect.ts.
 */

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const X_AUTHORIZE_URL = 'https://twitter.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
export const X_API_BASE = 'https://api.twitter.com/2';
/** Scopes: read my posts + who I am + stay connected (refresh). */
export const X_SCOPES = 'tweet.read users.read offline.access';

/**
 * The normal CAW post cost, in CAW (18 decimals): 5,000 CAW
 * from the posting name's deposited balance — the same cost
 * the live CawActions contract charges a kind-0 action
 * (measured on-chain; the contract remains the authority —
 * this figure only drives the pre-flight display and the
 * shortfall stop in the mirror screen, exactly like the
 * SuperLike / tip shortfall checks).
 */
export const POST_COST_RAW = 5000n * 10n ** 18n;
export const POST_COST_DISPLAY = '5,000';

/** The OAuth redirect the user's X app must register. The
 *  scheme is the app's own (app.json "scheme": "cawsocial"). */
export const X_REDIRECT_URI = 'cawsocial://x-callback';

/* ------------------------------------------------------------------ */
/* PKCE helpers (string shapes; randomness/digest are injected)        */
/* ------------------------------------------------------------------ */

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url-encode bytes without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64URL[a >> 2];
    out += B64URL[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += B64URL[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) out += B64URL[c & 63];
  }
  return out;
}

/** base64 (standard alphabet, as produced by expo-crypto's
 *  digest encoding) → base64url without padding. */
export function base64ToBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A PKCE code verifier from random bytes (43–128 chars per
 *  RFC 7636; 32 bytes → 43 chars). */
export function pkceVerifier(randomBytes: Uint8Array): string {
  return base64UrlEncode(randomBytes);
}

/** A random OAuth `state` value from random bytes. */
export function oauthState(randomBytes: Uint8Array): string {
  return base64UrlEncode(randomBytes);
}

/* ------------------------------------------------------------------ */
/* OAuth request shapes                                                */
/* ------------------------------------------------------------------ */

export function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    scope: X_SCOPES,
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: 'S256',
  });
  return X_AUTHORIZE_URL + '?' + q.toString();
}

export type RedirectParse =
  | { ok: true; code: string }
  | { ok: false; error: string };

/** Parse the OAuth redirect back into the app. A state mismatch
 *  refuses the code (someone else's flow must never be
 *  completed by this device). */
export function parseAuthRedirect(
  url: string,
  expectedState: string,
): RedirectParse {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return { ok: false, error: 'bad-redirect' };
  }
  const err = params.get('error');
  if (err) return { ok: false, error: err };
  const state = params.get('state');
  if (!state || state !== expectedState) {
    return { ok: false, error: 'state-mismatch' };
  }
  const code = params.get('code');
  if (!code) return { ok: false, error: 'no-code' };
  return { ok: true, code };
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/** The authorization-code exchange body. Public client: the
 *  client_id travels in the body and there is NO secret —
 *  this app never holds one (PKCE is the proof). */
export function buildTokenExchangeBody(args: {
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): string {
  return formBody({
    grant_type: 'authorization_code',
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    code: args.code,
    code_verifier: args.codeVerifier,
  });
}

export function buildRefreshBody(args: {
  clientId: string;
  refreshToken: string;
}): string {
  return formBody({
    grant_type: 'refresh_token',
    client_id: args.clientId,
    refresh_token: args.refreshToken,
  });
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export interface XSession {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds when the access token stops working. */
  expiresAt: number;
  userId: string;
  username: string;
}

/** A token-response JSON → session fields, or null when the
 *  body is not a token grant. `obtainedAtSec` anchors the
 *  expiry so tests can pin the arithmetic. */
export function sessionFromTokenResponse(
  json: unknown,
  obtainedAtSec: number,
): Omit<XSession, 'userId' | 'username'> | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  const access = j.access_token;
  const refresh = j.refresh_token;
  const expiresIn = j.expires_in;
  if (typeof access !== 'string' || access.length === 0) return null;
  if (typeof refresh !== 'string' || refresh.length === 0) return null;
  if (typeof expiresIn !== 'number' || !(expiresIn > 0)) return null;
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: obtainedAtSec + expiresIn,
  };
}

/** True when the access token should still be accepted
 *  (30 s of slack for clock skew). */
export function accessTokenUsable(s: XSession, nowSec: number): boolean {
  return nowSec + 30 < s.expiresAt;
}

/** The refresh grant the Worker runs is read-only in effect:
 *  the scopes never include tweet.write, so no token minted
 *  from this flow can post to X. Pinned by the harness. */
export function scopesAreReadOnly(): boolean {
  return !X_SCOPES.split(' ').some((s) => s.includes('write'));
}

/* ------------------------------------------------------------------ */
/* Timeline parsing — which posts are mirror candidates                */
/* ------------------------------------------------------------------ */

export interface XPost {
  id: string;
  text: string;
  /** ISO timestamp from the API (created_at). */
  createdAt: string;
}

export interface TimelinePage {
  posts: XPost[];
  nextToken: string | null;
}

type RefType = 'retweeted' | 'replied_to' | 'quoted';

/**
 * Classify one raw tweet object. Mirror candidates are the
 * user's OWN words: original posts and quote posts. Retweets
 * (someone else's words) and replies (half a conversation,
 * meaningless standing alone) are excluded — the help copy in
 * the app says exactly this.
 */
export function classifyTweet(raw: unknown): 'mirror' | 'skip' | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== 'string' || typeof t.text !== 'string') return null;
  const refs = Array.isArray(t.referenced_tweets)
    ? (t.referenced_tweets as Record<string, unknown>[])
    : [];
  const types = refs
    .map((r) => (typeof r.type === 'string' ? (r.type as RefType) : null))
    .filter((x) => x !== null);
  if (types.includes('retweeted')) return 'skip';
  if (types.includes('replied_to')) return 'skip';
  if (typeof t.in_reply_to_user_id === 'string') return 'skip';
  return 'mirror';
}

/** Parse one `GET /2/users/:id/tweets` response body. */
export function parseTimelinePage(json: unknown): TimelinePage {
  const posts: XPost[] = [];
  if (!json || typeof json !== 'object') return { posts, nextToken: null };
  const j = json as Record<string, unknown>;
  const data = Array.isArray(j.data) ? j.data : [];
  for (const raw of data) {
    if (classifyTweet(raw) !== 'mirror') continue;
    const t = raw as Record<string, unknown>;
    posts.push({
      id: t.id as string,
      text: t.text as string,
      createdAt: typeof t.created_at === 'string' ? t.created_at : '',
    });
  }
  const meta = (j.meta ?? {}) as Record<string, unknown>;
  return {
    posts,
    nextToken:
      typeof meta.next_token === 'string' && meta.next_token
        ? meta.next_token
        : null,
  };
}

/** The timeline request path (the API's own exclude params do
 *  the first cut; classifyTweet is the second, so a fixture or
 *  an API change can never leak a retweet into the inbox). */
export function timelinePath(userId: string, pageToken?: string | null): string {
  const q = new URLSearchParams({
    max_results: '50',
    'tweet.fields': 'created_at,referenced_tweets,in_reply_to_user_id',
    exclude: 'retweets,replies',
  });
  if (pageToken) q.set('pagination_token', pageToken);
  return '/users/' + encodeURIComponent(userId) + '/tweets?' + q.toString();
}

/**
 * The inbox list: fetched posts minus the ones already
 * engraved (the mapping is the source of truth — see
 * xMirrorStore). Fetch order is newest-first (the API's
 * order) and is preserved.
 */
export function mirrorCandidates(
  fetched: XPost[],
  engraved: ReadonlySet<string> | ReadonlyMap<string, string>,
): XPost[] {
  const has = (id: string) =>
    engraved instanceof Set ? engraved.has(id) : engraved.has(id);
  const seen = new Set<string>();
  const out: XPost[] = [];
  for (const p of fetched) {
    if (has(p.id) || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/** Merge fetched pages, keeping the first (newest) copy of a
 *  post when pages overlap. */
export function mergePages(pages: XPost[][]): XPost[] {
  const seen = new Set<string>();
  const out: XPost[] = [];
  for (const page of pages) {
    for (const p of page) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* X API errors — surfaced honestly, never disguised                   */
/* ------------------------------------------------------------------ */

export type XErrorKind =
  | 'rate-limit'
  | 'no-access'
  | 'auth'
  | 'network'
  | 'unknown';

export interface XErrorInfo {
  kind: XErrorKind;
  /** The API's own words, when it sent any (shown to the user
   *  under the plain-language line). */
  detail: string;
}

/** Classify an X API failure from its HTTP status + body. */
export function classifyXError(
  status: number,
  json: unknown,
): XErrorInfo {
  let detail = '';
  if (json && typeof json === 'object') {
    const j = json as Record<string, unknown>;
    if (typeof j.detail === 'string') detail = j.detail;
    else if (typeof j.title === 'string') detail = j.title;
    else if (Array.isArray(j.errors) && j.errors.length > 0) {
      const e = j.errors[0] as Record<string, unknown>;
      if (typeof e.message === 'string') detail = e.message;
    }
  }
  if (status === 429) return { kind: 'rate-limit', detail };
  if (status === 401) return { kind: 'auth', detail };
  if (status === 403) return { kind: 'no-access', detail };
  return { kind: 'unknown', detail };
}

/** A thrown fetch (no response at all) is a network error. */
export function networkErrorInfo(e: unknown): XErrorInfo {
  return {
    kind: 'network',
    detail: e instanceof Error ? e.message : String(e),
  };
}

/** Notification preview: the post's first ~80 characters,
 *  flattened to one line. The payload never carries more
 *  than this plus the post id. */
export function previewSnippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? flat.slice(0, 79) + '…' : flat;
}
