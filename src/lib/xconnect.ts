/**
 * X mirror — device glue (v0.5.0-x). React-Native-only: the
 * secure store, the system-browser OAuth flow, the X API
 * fetches, and the push-token registration. All decisions
 * (shapes, filtering, error classes) live in the pure
 * lib/xmirror.ts; this file only moves bytes.
 *
 * KEY SAFETY SHAPE:
 *  - The X Client ID is the USER's own (their X developer
 *    app), typed into Settings. Nothing X-related is
 *    hardcoded anywhere in this app, and there is no client
 *    secret at all — PKCE is the proof of possession.
 *  - X tokens live ONLY in expo-secure-store, in the same
 *    storage class as the wallet material
 *    (WHEN_UNLOCKED_THIS_DEVICE_ONLY), and disconnect wipes
 *    them.
 *  - The tokens are READ-ONLY by scope (tweet.read): they
 *    cannot post to X, and they are not the wallet key —
 *    engraving is always signed in-app, by the user.
 */
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';

import { X_MIRROR_SERVER_URL } from '../config';
import {
  X_API_BASE,
  X_REDIRECT_URI,
  X_TOKEN_URL,
  accessTokenUsable,
  base64ToBase64Url,
  buildAuthorizeUrl,
  buildRefreshBody,
  buildTokenExchangeBody,
  classifyXError,
  mergePages,
  mirrorCandidates,
  networkErrorInfo,
  oauthState,
  parseAuthRedirect,
  parseTimelinePage,
  pkceVerifier,
  sessionFromTokenResponse,
  timelinePath,
  type XErrorInfo,
  type XPost,
  type XSession,
} from './xmirror';
import { storeKV, xMirrorStore } from './stores';

const STORE_OPTIONS = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const CLIENT_ID_KEY = 'caw-x-client-id';
const SESSION_KEY = 'caw-x-session';
const PUSH_KEY = 'caw-x-push';

export class XApiError extends Error {
  info: XErrorInfo;
  constructor(info: XErrorInfo) {
    super(info.kind);
    this.info = info;
  }
}

/* ------------------------------------------------------------------ */
/* Persistence (secure store only)                                     */
/* ------------------------------------------------------------------ */

export async function loadXClientId(): Promise<string> {
  try {
    return (await SecureStore.getItemAsync(CLIENT_ID_KEY, STORE_OPTIONS)) ?? '';
  } catch {
    return '';
  }
}

export async function saveXClientId(id: string): Promise<void> {
  const v = id.trim();
  if (v) {
    await SecureStore.setItemAsync(CLIENT_ID_KEY, v, STORE_OPTIONS);
  } else {
    await SecureStore.deleteItemAsync(CLIENT_ID_KEY, STORE_OPTIONS);
  }
}

export async function loadXSession(): Promise<XSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY, STORE_OPTIONS);
    if (!raw) return null;
    const j = JSON.parse(raw) as XSession;
    if (
      typeof j.accessToken !== 'string' ||
      typeof j.refreshToken !== 'string' ||
      typeof j.expiresAt !== 'number' ||
      typeof j.userId !== 'string' ||
      typeof j.username !== 'string'
    ) {
      return null;
    }
    return j;
  } catch {
    return null;
  }
}

async function saveXSession(s: XSession): Promise<void> {
  await SecureStore.setItemAsync(
    SESSION_KEY,
    JSON.stringify(s),
    STORE_OPTIONS,
  );
}

/** Disconnect: tokens wiped from the secure store, the
 *  engraved map forgotten (the chain keeps the posts; a
 *  reconnect simply offers the window again), and the push
 *  registration withdrawn best-effort. The Client ID is kept
 *  — it is the user's own app id, not a credential. */
export async function disconnectX(): Promise<void> {
  const s = await loadXSession();
  await SecureStore.deleteItemAsync(SESSION_KEY, STORE_OPTIONS);
  await SecureStore.deleteItemAsync(PUSH_KEY, STORE_OPTIONS);
  if (s) {
    await xMirrorStore.init(storeKV, s.userId).catch(() => {});
    await xMirrorStore.reset().catch(() => {});
  }
  if (s && X_MIRROR_SERVER_URL) {
    await unregisterPush(s).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* OAuth (authorization code + PKCE, system browser)                   */
/* ------------------------------------------------------------------ */

async function postTokenForm(body: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(X_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (e) {
    throw new XApiError(networkErrorInfo(e));
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new XApiError(classifyXError(res.status, json));
  return json;
}

async function fetchMe(accessToken: string): Promise<{ id: string; username: string }> {
  let res: Response;
  try {
    res = await fetch(X_API_BASE + '/users/me', {
      headers: { authorization: 'Bearer ' + accessToken },
    });
  } catch (e) {
    throw new XApiError(networkErrorInfo(e));
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new XApiError(classifyXError(res.status, json));
  const data = (json as { data?: { id?: unknown; username?: unknown } })?.data;
  if (typeof data?.id !== 'string' || typeof data?.username !== 'string') {
    throw new XApiError({ kind: 'unknown', detail: 'users/me shape' });
  }
  return { id: data.id, username: data.username };
}

/**
 * Run the full connect flow: PKCE pair → system browser →
 * code exchange → who-am-I → session saved. Throws XApiError
 * (or Error('cancelled')) — the caller shows the honest state;
 * nothing is saved on any failure path.
 */
export async function connectX(clientId: string): Promise<XSession> {
  const verifier = pkceVerifier(
    new Uint8Array(await Crypto.getRandomBytesAsync(32)),
  );
  const digestB64 = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  const challenge = base64ToBase64Url(digestB64);
  const state = oauthState(
    new Uint8Array(await Crypto.getRandomBytesAsync(16)),
  );
  const authUrl = buildAuthorizeUrl({
    clientId,
    redirectUri: X_REDIRECT_URI,
    codeChallenge: challenge,
    state,
  });
  const result = await WebBrowser.openAuthSessionAsync(
    authUrl,
    X_REDIRECT_URI,
  );
  if (result.type !== 'success' || !result.url) {
    throw new Error('cancelled');
  }
  const parsed = parseAuthRedirect(result.url, state);
  if (!parsed.ok) throw new Error(parsed.error);
  const grant = sessionFromTokenResponse(
    await postTokenForm(
      buildTokenExchangeBody({
        clientId,
        redirectUri: X_REDIRECT_URI,
        code: parsed.code,
        codeVerifier: verifier,
      }),
    ),
    Math.floor(Date.now() / 1000),
  );
  if (!grant) throw new XApiError({ kind: 'unknown', detail: 'token shape' });
  const me = await fetchMe(grant.accessToken);
  const session: XSession = { ...grant, userId: me.id, username: me.username };
  await saveXSession(session);
  return session;
}

/** A session whose access token works: refreshed when the
 *  stored one is spent. A failed refresh surfaces the API's
 *  own verdict (an expired/revoked grant classifies 'auth' —
 *  the UI then asks for a fresh connect; nothing is faked). */
export async function usableXSession(): Promise<XSession> {
  const s = await loadXSession();
  if (!s) throw new XApiError({ kind: 'auth', detail: 'not-connected' });
  if (accessTokenUsable(s, Math.floor(Date.now() / 1000))) return s;
  const clientId = await loadXClientId();
  if (!clientId) throw new XApiError({ kind: 'auth', detail: 'no-client-id' });
  const grant = sessionFromTokenResponse(
    await postTokenForm(
      buildRefreshBody({ clientId, refreshToken: s.refreshToken }),
    ),
    Math.floor(Date.now() / 1000),
  );
  if (!grant) throw new XApiError({ kind: 'unknown', detail: 'refresh shape' });
  const next: XSession = { ...grant, userId: s.userId, username: s.username };
  await saveXSession(next);
  return next;
}

/* ------------------------------------------------------------------ */
/* Timeline fetch (in-app detection)                                   */
/* ------------------------------------------------------------------ */

async function fetchTimelinePage(
  session: XSession,
  pageToken: string | null,
  sinceId: string | null,
): Promise<{ posts: XPost[]; nextToken: string | null }> {
  let res: Response;
  try {
    res = await fetch(
      X_API_BASE + timelinePath(session.userId, pageToken, sinceId),
      {
        headers: { authorization: 'Bearer ' + session.accessToken },
      },
    );
  } catch (e) {
    throw new XApiError(networkErrorInfo(e));
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new XApiError(classifyXError(res.status, json));
  return parseTimelinePage(json);
}

/**
 * The in-app detection path — runs when the mirror screen
 * opens, when the app unlocks, and on the manual refresh
 * button. There is NO on-device background detection
 * (Android does not allow it reliably); timely detection is
 * the Worker's job.
 *
 * Cost shape (X reads are pay-per-use, $0.001 per returned
 * post for your own posts): the FIRST fetch reads a window
 * of recent posts into the on-device cache and sets the
 * watermark. Every later fetch passes `since_id` = the
 * watermark, so it only ever returns posts that are new —
 * and when nothing was posted, the page is empty and the
 * check costs zero. The inbox is then "cache minus
 * engraved", so an un-engraved post stays listed without
 * ever being re-fetched (and X's 24h same-resource dedupe
 * covers any overlap the paging still produces).
 */
export async function fetchMirrorCandidates(
  maxPages = 2,
): Promise<{ candidates: XPost[]; session: XSession }> {
  const session = await usableXSession();
  await xMirrorStore.init(storeKV, session.userId);
  const sinceId = xMirrorStore.watermark();
  const pages: XPost[][] = [];
  let token: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchTimelinePage(session, token, sinceId);
    pages.push(page.posts);
    token = page.nextToken;
    if (!token) break;
  }
  await xMirrorStore.mergeFetched(mergePages(pages));
  return {
    candidates: mirrorCandidates(
      xMirrorStore.cachedPosts(),
      xMirrorStore.ids(),
    ),
    session,
  };
}

/** Find one post by id across a few pages (the notification
 *  deep link): returns it when it is still an un-engraved
 *  candidate, else null — the screen then simply shows the
 *  inbox. */
export async function findMirrorCandidate(
  xPostId: string,
): Promise<XPost | null> {
  const { candidates } = await fetchMirrorCandidates(3);
  return candidates.find((p) => p.id === xPostId) ?? null;
}

/* ------------------------------------------------------------------ */
/* Push registration (the user's own Worker)                           */
/* ------------------------------------------------------------------ */

export interface PushRegistration {
  pushToken: string;
  xUserId: string;
}

/** The device's Expo push token, or null when notifications
 *  are unavailable on this build/device (permission denied,
 *  no FCM setup, …) — the caller shows the honest state; the
 *  in-app detection path is unaffected. */
export async function devicePushToken(): Promise<string | null> {
  try {
    const perm = await Notifications.getPermissionsAsync();
    let granted = perm.granted;
    if (!granted && perm.canAskAgain) {
      granted = (await Notifications.requestPermissionsAsync()).granted;
    }
    if (!granted) return null;
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    const t = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    return typeof t.data === 'string' && t.data ? t.data : null;
  } catch {
    return null;
  }
}

async function pushPost(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(X_MIRROR_SERVER_URL + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Register this device + the X read token with the user's own
 * Worker so its cron can notice new posts and push. What the
 * server receives: the push token, the X account id, and the
 * X session (access + refresh + the user's own Client ID) —
 * READ-ONLY by scope; it cannot post to X and it is not the
 * wallet key. Returns the state the UI should show.
 */
export async function registerPush(
  session: XSession,
): Promise<'ok' | 'no-server' | 'no-token' | 'failed'> {
  if (!X_MIRROR_SERVER_URL) return 'no-server';
  const pushToken = await devicePushToken();
  if (!pushToken) return 'no-token';
  const ok = await pushPost('/x/register', {
    pushToken,
    xUserId: session.userId,
    username: session.username,
    clientId: await loadXClientId(),
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
  });
  if (!ok) return 'failed';
  await SecureStore.setItemAsync(
    PUSH_KEY,
    JSON.stringify({ pushToken, xUserId: session.userId }),
    STORE_OPTIONS,
  );
  return 'ok';
}

export async function loadPushRegistration(): Promise<PushRegistration | null> {
  try {
    const raw = await SecureStore.getItemAsync(PUSH_KEY, STORE_OPTIONS);
    if (!raw) return null;
    const j = JSON.parse(raw) as PushRegistration;
    return typeof j.pushToken === 'string' && typeof j.xUserId === 'string'
      ? j
      : null;
  } catch {
    return null;
  }
}

async function unregisterPush(session: XSession): Promise<void> {
  await pushPost('/x/unregister', { xUserId: session.userId });
}
