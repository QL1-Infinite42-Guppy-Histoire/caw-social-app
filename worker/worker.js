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

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
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

    return json({ error: 'not-found' }, 404);
  },
};
