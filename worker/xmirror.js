/**
 * X mirror notification logic (v0.5.0-x) — the pure half of
 * the Worker's cron poller. The Worker watches ONE linked X
 * account per registration (the user's own), using the
 * read-only X token the app registered, and pushes an Expo
 * notification for each NEW post that the in-app mirror would
 * offer for engraving.
 *
 * What the server holds and what it can do:
 *  - It holds a READ-ONLY X token (scope tweet.read — the
 *    OAuth flow never requests write) and an Expo push token.
 *  - It CANNOT post to X, and it holds nothing related to the
 *    wallet: engraving is signed in the app, by the user,
 *    every time.
 *  - It remembers only which post ids it has already
 *    NOTIFIED about (the seen set). The app remains the
 *    source of truth for what is engraved — this set exists
 *    purely so each post notifies exactly once.
 *
 * The classification mirrors the app (src/lib/xmirror.ts):
 * original posts and quote posts notify; retweets and
 * replies do not. The fetch also asks the API to exclude
 * them — this filter is the second net.
 */

export const XSUB_PREFIX = 'xsub:';
export const XSEEN_PREFIX = 'xseen:';
export const SEEN_CAP = 200;
export const NOTIF_TITLE = 'New post on X';
export const NOTIF_BODY = 'Tap to engrave it on CAW.';
export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export const xsubKey = (xUserId) => XSUB_PREFIX + xUserId;
export const xseenKey = (xUserId) => XSEEN_PREFIX + xUserId;

const DIGITS = /^[0-9]+$/;
const PUSH_TOKEN = /^ExponentPushToken\[[^\]]+\]$/;

/** Shape-check one /x/register body. Returns an error string
 *  or null. The Worker stores exactly what passed this. */
export function validateRegistration(body) {
  if (!body || typeof body !== 'object') return 'bad-body';
  if (typeof body.pushToken !== 'string' || !PUSH_TOKEN.test(body.pushToken)) {
    return 'bad-push-token';
  }
  if (typeof body.xUserId !== 'string' || !DIGITS.test(body.xUserId)) {
    return 'bad-user-id';
  }
  if (typeof body.clientId !== 'string' || body.clientId.length === 0) {
    return 'bad-client-id';
  }
  if (typeof body.accessToken !== 'string' || body.accessToken.length === 0) {
    return 'bad-access-token';
  }
  if (typeof body.refreshToken !== 'string' || body.refreshToken.length === 0) {
    return 'bad-refresh-token';
  }
  if (typeof body.expiresAt !== 'number' || !(body.expiresAt > 0)) {
    return 'bad-expires-at';
  }
  return null;
}

/* ---------------- endpoint authentication (M5) ----------------
 * v0.5.0-fix: /x/register and /x/unregister used to trust
 * any caller, and X user ids are public — anyone could
 * overwrite or delete someone else's subscription record.
 * The rules now, decided here as pure functions:
 *  - register must prove control of the X account: the
 *    Worker validates the presented access token against
 *    X's /2/users/me, and the token's account id must EQUAL
 *    the user id being registered (meId below);
 *  - once a record carries a registration secret (generated
 *    on-device at first registration, stored in the app's
 *    SecureStore, sent as the x-reg-secret header), only a
 *    caller presenting that secret may overwrite or delete
 *    the record;
 *  - a pre-fix record WITHOUT a secret may be overwritten
 *    by a token-proven registration (which then ADOPTS the
 *    presented secret) and unregistered without one — the
 *    legacy window closes itself on the first re-register. */

const REG_SECRET = /^[0-9a-f]{32,128}$/;
export const isRegSecret = (s) =>
  typeof s === 'string' && REG_SECRET.test(s);

/**
 * Decide a registration. `existing` is the stored record or
 * null; `meId` is the account id the presented access token
 * resolved to via /2/users/me (null when the token did not
 * validate); `presentedSecret` is the x-reg-secret header.
 * Returns { ok: true, regSecret } — the secret to store —
 * or { ok: false, error }.
 */
export function planRegistration(existing, body, meId, presentedSecret) {
  if (meId === null || meId === undefined) {
    return { ok: false, error: 'token-invalid' };
  }
  if (meId !== body.xUserId) {
    return { ok: false, error: 'token-mismatch' };
  }
  if (existing && typeof existing.regSecret === 'string' && existing.regSecret) {
    if (presentedSecret !== existing.regSecret) {
      return { ok: false, error: 'secret-required' };
    }
    return { ok: true, regSecret: existing.regSecret };
  }
  /* New record (or a legacy record without a secret): the
   * presented secret becomes the record's secret, so it
   * must be well-formed. */
  if (!isRegSecret(presentedSecret)) {
    return { ok: false, error: 'secret-invalid' };
  }
  return { ok: true, regSecret: presentedSecret };
}

/**
 * Decide an unregistration. Deleting a record that does not
 * exist is a no-op success (idempotent). A record WITH a
 * secret requires it; a legacy record without one does not.
 */
export function planUnregister(existing, presentedSecret) {
  if (!existing) return { ok: true };
  if (typeof existing.regSecret === 'string' && existing.regSecret) {
    return presentedSecret === existing.regSecret
      ? { ok: true }
      : { ok: false, error: 'secret-required' };
  }
  return { ok: true };
}

/** Classify one raw tweet (same rules as the app). */
export function classifyTweet(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || typeof raw.text !== 'string') return null;
  const refs = Array.isArray(raw.referenced_tweets)
    ? raw.referenced_tweets
    : [];
  const types = refs.map((r) => r && r.type).filter(Boolean);
  if (types.includes('retweeted')) return 'skip';
  if (types.includes('replied_to')) return 'skip';
  if (typeof raw.in_reply_to_user_id === 'string') return 'skip';
  return 'mirror';
}

/** Parse a timeline response body into mirror posts. */
export function parseTimeline(json) {
  const posts = [];
  const data = json && Array.isArray(json.data) ? json.data : [];
  for (const raw of data) {
    if (classifyTweet(raw) !== 'mirror') continue;
    posts.push({
      id: raw.id,
      text: raw.text,
      createdAt: typeof raw.created_at === 'string' ? raw.created_at : '',
    });
  }
  return posts;
}

/**
 * Decide what a poll does.
 *  - seen === null → BASELINE: this account was never polled;
 *    everything current becomes "seen" and NOTHING notifies
 *    (registering must never flood the phone with history).
 *  - otherwise → the posts whose ids are not in seen are
 *    fresh; they are returned OLDEST FIRST (notification
 *    order), and the seen set advances to include every post
 *    in this fetch (capped at SEEN_CAP, freshest kept).
 */
export function planPoll(seen, posts) {
  const fetchedIds = posts.map((p) => p.id);
  const nextSeen = [...new Set([...fetchedIds, ...(seen ?? [])])].slice(
    0,
    SEEN_CAP,
  );
  if (seen === null) {
    return { baseline: true, fresh: [], nextSeen };
  }
  const seenSet = new Set(seen);
  const fresh = posts.filter((p) => !seenSet.has(p.id)).reverse();
  return { baseline: false, fresh, nextSeen };
}

/** The notification preview: first ~80 chars, one line. */
export function previewSnippet(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? flat.slice(0, 79) + '…' : flat;
}

/**
 * Build the Expo push messages for fresh posts. The payload
 * carries ONLY the post id and a short preview — no tokens,
 * no account data, nothing that could sign or post.
 * categoryId 'xmirror' is what gives the notification its
 * 刻む action button on the device (registered by the app).
 */
export function buildPushMessages(fresh, pushToken) {
  return fresh.map((p) => {
    const preview = previewSnippet(p.text);
    return {
      to: pushToken,
      sound: 'default',
      title: NOTIF_TITLE,
      body: preview || NOTIF_BODY,
      data: { xPostId: p.id, preview },
      categoryId: 'xmirror',
    };
  });
}

/** The newest id in a list (X ids are numeric strings that
 *  grow with time — compared as bigints, so '10' beats '9'). */
export function maxNumericId(ids) {
  let best = null;
  for (const id of ids) {
    try {
      const v = BigInt(id);
      if (best === null || v > best.v) best = { v, s: id };
    } catch {
      /* non-numeric ids never advance the watermark */
    }
  }
  return best ? best.s : null;
}

/**
 * The timeline query for one poll. `sinceId` is the cost
 * valve: X reads are pay-per-use ($0.001 per post returned
 * for the owner's own posts), so asking only for posts
 * NEWER than the newest one already seen makes an idle
 * account's poll return an empty page — zero resources,
 * zero cost. (X also dedupes repeat reads of the same
 * resource within 24h, covering any overlap at page edges.)
 */
export function timelineQuery(sinceId) {
  const q = new URLSearchParams({
    max_results: '50',
    'tweet.fields': 'created_at,referenced_tweets,in_reply_to_user_id',
    exclude: 'retweets,replies',
  });
  if (sinceId) q.set('since_id', sinceId);
  return q.toString();
}

/** True when the stored access token is spent (60 s slack —
 *  a poll should never start with a token that dies mid-run). */
export function tokenNeedsRefresh(sub, nowSec) {
  return nowSec + 60 >= sub.expiresAt;
}

/** The refresh grant body (public client, PKCE-born grant:
 *  client_id in the body, no secret exists). */
export function refreshBody(sub) {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: sub.clientId,
    refresh_token: sub.refreshToken,
  }).toString();
}

/** Apply a token response to a stored subscription. Returns
 *  the updated subscription, or null when the body is not a
 *  grant (the caller then leaves the old one untouched and
 *  the next poll retries). */
export function applyTokenResponse(sub, json, nowSec) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.access_token !== 'string' || !json.access_token) return null;
  if (typeof json.refresh_token !== 'string' || !json.refresh_token) return null;
  if (typeof json.expires_in !== 'number' || !(json.expires_in > 0)) return null;
  return {
    ...sub,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: nowSec + json.expires_in,
  };
}
