/**
 * HuntersExchange order server (v0.5.0) — a Cloudflare Worker
 * + KV that stores and serves SIGNED orders for the
 * HuntersExchange escrow contract (42 Chain). Design memo:
 * ~/workspace/huntersexchange/DESIGN.md §3.
 *
 * The server is a bulletin board, never a custodian: every
 * listing is an EIP-712 order the maker signed; settlement
 * happens on-chain against the immutable contract; escrow
 * withdrawal works with this server down. Listings are
 * accepted only when (a) the signature recovers the maker
 * and (b) the maker's on-chain escrow balance covers the
 * total they have committed — the book should not advertise
 * orders that cannot fill.
 *
 * Endpoints:
 *   GET  /book?contract=0x…            → { orders: [listing] }
 *   GET  /orders?contract=0x…&maker=0x… → the maker's listings
 *   POST /orders  { contract, order, signature }
 *   POST /cancel  { contract, order, signature }  (signature =
 *        the maker's personal-sign of the order hash; the
 *        on-chain cancelOrder() is the authoritative kill)
 *   POST /x/register    { pushToken, xUserId, username,
 *        clientId, accessToken, refreshToken, expiresAt }
 *   POST /x/unregister  { xUserId }
 *
 * X mirror (v0.5.0-x): the same Worker also runs a CRON
 * poller (see the `scheduled` handler). For each /x/register
 * subscription it reads the linked X account's timeline with
 * the registered READ-ONLY token and sends one Expo push per
 * new post. Its pure logic lives in xmirror.js: the first
 * poll of an account is a silent baseline (no flood), the
 * seen set guarantees one notification per post, and the
 * push payload carries only the post id + a short preview.
 * The server can never post to X (read-only scope) and holds
 * no wallet material — engraving is signed in the app.
 * Since v0.5.0-fix (audit M5) the /x endpoints are
 * authenticated: registration proves control of the X
 * account via /2/users/me, and overwrite/unregister of a
 * record carrying a registration secret requires it.
 *
 * Binding: HX_KV (KV namespace). No secrets, no keys.
 * Deploy: see worker/README.md. wrangler.toml's main points
 * at the esbuild bundle (dist/worker.js); build with
 * `npm run build` in this directory.
 */
import {
  applyCancel,
  applyOrder,
  committedGive,
  liveBook,
  ordersKey,
} from './orderStore.js';
import {
  escrowBalanceOf,
  verifyCancelSignature,
  verifyOrderSignature,
} from './verify.js';
import {
  EXPO_PUSH_URL,
  applyTokenResponse,
  buildPushMessages,
  maxNumericId,
  parseTimeline,
  planPoll,
  planRegistration,
  planUnregister,
  refreshBody,
  timelineQuery,
  tokenNeedsRefresh,
  validateRegistration,
  xseenKey,
  xsubKey,
  XSUB_PREFIX,
} from './xmirror.js';

const X_API = 'https://api.twitter.com/2';
const X_TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-reg-secret',
    },
  });
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;

async function readListings(env, contract) {
  const raw = await env.HX_KV.get(ordersKey(contract));
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function writeListings(env, contract, listings) {
  await env.HX_KV.put(ordersKey(contract), JSON.stringify(listings));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return json({}, 204);
    const url = new URL(request.url);
    const nowSec = Math.floor(Date.now() / 1000);

    if (request.method === 'GET' && url.pathname === '/book') {
      const contract = url.searchParams.get('contract') || '';
      if (!ADDR.test(contract)) return json({ error: 'bad-contract' }, 400);
      const listings = await readListings(env, contract);
      return json({ orders: liveBook(listings, nowSec) });
    }

    if (request.method === 'GET' && url.pathname === '/orders') {
      const contract = url.searchParams.get('contract') || '';
      const maker = (url.searchParams.get('maker') || '').toLowerCase();
      if (!ADDR.test(contract) || !ADDR.test(maker)) {
        return json({ error: 'bad-params' }, 400);
      }
      const listings = await readListings(env, contract);
      return json({
        orders: liveBook(listings, nowSec).filter(
          (l) => l.order.maker.toLowerCase() === maker,
        ),
      });
    }

    if (request.method === 'POST' && url.pathname === '/orders') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad-json' }, 400);
      }
      const { contract, order, signature } = body || {};
      if (!ADDR.test(contract || '')) {
        return json({ error: 'bad-contract' }, 400);
      }
      const listings = await readListings(env, contract);
      const applied = applyOrder(listings, { order, signature }, nowSec);
      if (!applied.ok) return json({ error: applied.error }, 400);
      if (!verifyOrderSignature(contract, order, signature)) {
        return json({ error: 'bad-signature' }, 400);
      }
      // Escrow coverage: the maker's committed give across the
      // live book plus this order must fit their on-chain
      // escrowed balance of the give token.
      const balance = await escrowBalanceOf(
        contract,
        order.tokenGive,
        order.maker,
      );
      if (balance === null) {
        return json({ error: 'escrow-check-failed' }, 502);
      }
      const committed = committedGive(
        applied.listings,
        order.maker,
        order.tokenGive,
        null,
      );
      if (committed > balance) {
        return json({ error: 'insufficient-escrow' }, 400);
      }
      await writeListings(env, contract, applied.listings);
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/cancel') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad-json' }, 400);
      }
      const { contract, order, signature } = body || {};
      if (!ADDR.test(contract || '') || !order) {
        return json({ error: 'bad-params' }, 400);
      }
      if (!verifyCancelSignature(contract, order, signature)) {
        return json({ error: 'bad-signature' }, 400);
      }
      const listings = await readListings(env, contract);
      const applied = applyCancel(listings, order);
      if (applied.ok) await writeListings(env, contract, applied.listings);
      return json({ ok: applied.ok });
    }

    if (request.method === 'POST' && url.pathname === '/x/register') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad-json' }, 400);
      }
      const err = validateRegistration(body);
      if (err) return json({ error: err }, 400);
      /* M5 (v0.5.0-fix): a registration must prove control
       * of the X account it names. The presented access
       * token is validated against X's /2/users/me — the
       * token's account id must equal the registered user
       * id — and overwriting a record that carries a
       * registration secret requires that secret (the
       * x-reg-secret header). The decision itself is the
       * pure planRegistration in xmirror.js. */
      let meId = null;
      try {
        const meRes = await fetch(`${X_API}/users/me`, {
          headers: { authorization: `Bearer ${body.accessToken}` },
        });
        if (meRes.ok) {
          const me = await meRes.json();
          if (me && me.data && typeof me.data.id === 'string') {
            meId = me.data.id;
          }
        }
      } catch {
        meId = null;
      }
      let existing = null;
      try {
        const rawSub = await env.HX_KV.get(xsubKey(body.xUserId));
        existing = rawSub ? JSON.parse(rawSub) : null;
      } catch {
        existing = null;
      }
      const plan = planRegistration(
        existing,
        body,
        meId,
        request.headers.get('x-reg-secret'),
      );
      if (!plan.ok) return json({ error: plan.error }, 403);
      // Store exactly the subscription shape the poller reads
      // (plus the registration secret, which is never
      // returned). Re-registering (new device, fresh token)
      // replaces it; the seen set is kept, so nothing
      // re-notifies.
      await env.HX_KV.put(
        xsubKey(body.xUserId),
        JSON.stringify({
          pushToken: body.pushToken,
          xUserId: body.xUserId,
          username:
            typeof body.username === 'string' ? body.username : '',
          clientId: body.clientId,
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
          expiresAt: body.expiresAt,
          regSecret: plan.regSecret,
        }),
      );
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/x/unregister') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad-json' }, 400);
      }
      if (!body || typeof body.xUserId !== 'string' || !body.xUserId) {
        return json({ error: 'bad-user-id' }, 400);
      }
      /* M5: deleting a record that carries a registration
       * secret requires presenting it (legacy records
       * without one stay deletable — see planUnregister). */
      let existing = null;
      try {
        const rawSub = await env.HX_KV.get(xsubKey(body.xUserId));
        existing = rawSub ? JSON.parse(rawSub) : null;
      } catch {
        existing = null;
      }
      const plan = planUnregister(
        existing,
        request.headers.get('x-reg-secret'),
      );
      if (!plan.ok) return json({ error: plan.error }, 403);
      await env.HX_KV.delete(xsubKey(body.xUserId));
      await env.HX_KV.delete(xseenKey(body.xUserId));
      return json({ ok: true });
    }

    return json({ error: 'not-found' }, 404);
  },

  /**
   * Cron: poll every registered X account once. One bad
   * subscription (revoked grant, X rate limit) must never
   * stop the others — each is handled in its own try/catch
   * and simply retried on the next tick.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAllX(env));
  },
};

async function pollAllX(env) {
  const nowSec = Math.floor(Date.now() / 1000);
  const list = await env.HX_KV.list({ prefix: XSUB_PREFIX });
  for (const key of list.keys) {
    try {
      await pollOneX(env, key.name.slice(XSUB_PREFIX.length), nowSec);
    } catch {
      /* retried on the next tick */
    }
  }
}

async function pollOneX(env, xUserId, nowSec) {
  const raw = await env.HX_KV.get(xsubKey(xUserId));
  if (!raw) return;
  let sub = JSON.parse(raw);

  if (tokenNeedsRefresh(sub, nowSec)) {
    const res = await fetch(X_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: refreshBody(sub),
    });
    const next = res.ok
      ? applyTokenResponse(sub, await res.json().catch(() => null), nowSec)
      : null;
    if (!next) return; // revoked / rate-limited: try next tick
    sub = next;
    await env.HX_KV.put(xsubKey(xUserId), JSON.stringify(sub));
  }

  // The seen record is { ids, sinceId } (a bare array from
  // the first build is still read as ids with no watermark).
  // sinceId is the poll's cost valve: with it, a poll that
  // finds nothing new returns an empty page — zero billed
  // resources (X reads are pay-per-use, $0.001 per returned
  // post for the owner's own posts).
  const seenRaw = await env.HX_KV.get(xseenKey(xUserId));
  let seen = null;
  let sinceId = null;
  if (seenRaw) {
    try {
      const v = JSON.parse(seenRaw);
      if (Array.isArray(v)) {
        seen = v.filter((x) => typeof x === 'string');
      } else if (v && typeof v === 'object') {
        if (Array.isArray(v.ids)) {
          seen = v.ids.filter((x) => typeof x === 'string');
        }
        if (typeof v.sinceId === 'string') sinceId = v.sinceId;
      }
    } catch {
      seen = null;
      sinceId = null;
    }
  }

  const res = await fetch(
    `${X_API}/users/${xUserId}/tweets?${timelineQuery(sinceId)}`,
    {
      headers: { authorization: 'Bearer ' + sub.accessToken },
    },
  );
  if (!res.ok) return; // surfaced in-app; a push must never fake it
  const posts = parseTimeline(await res.json().catch(() => null));

  const plan = planPoll(seen, posts);
  if (plan.fresh.length > 0) {
    const messages = buildPushMessages(plan.fresh, sub.pushToken);
    for (let i = 0; i < messages.length; i += 100) {
      await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env.EXPO_ACCESS_TOKEN
            ? { authorization: 'Bearer ' + env.EXPO_ACCESS_TOKEN }
            : {}),
        },
        body: JSON.stringify(messages.slice(i, i + 100)),
      });
    }
  }
  const newest = maxNumericId(posts.map((p) => p.id));
  const nextSince = newest ?? sinceId;
  const nextRecord = { ids: plan.nextSeen, sinceId: nextSince };
  if (JSON.stringify(nextRecord) !== JSON.stringify({ ids: seen ?? [], sinceId })) {
    await env.HX_KV.put(xseenKey(xUserId), JSON.stringify(nextRecord));
  }
}
