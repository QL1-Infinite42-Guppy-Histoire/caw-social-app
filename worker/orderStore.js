/**
 * HuntersExchange order store — pure logic (no I/O, no
 * crypto), unit-tested by scripts/verify-exchange.mjs.
 *
 * Storage shape: one KV key per exchange contract,
 * `orders:<contract lowercase>` → JSON array of listings
 * { order, signature, receivedAt }. A listing is a SIGNED
 * order; the store is a display/order-routing aid only —
 * the contract is the source of truth for balances, fills
 * and cancels, and every write path here re-validates the
 * signature before accepting (see verify.js).
 */

export const HX_USDT = '0xc2684966e5c95b2bc636fb4a1f3da9ad23d94753';
export const HX_CAW = '0xce8aee7148daa8943453239c42b7b93f984a49f0';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^[0-9]+$/;

export function ordersKey(contract) {
  return 'orders:' + String(contract).toLowerCase();
}

/** Structural validation of a serialized order. */
export function validateOrderShape(o) {
  if (!o || typeof o !== 'object') return 'not-an-object';
  if (!ADDR.test(o.maker || '')) return 'bad-maker';
  if (!ADDR.test(o.tokenGive || '')) return 'bad-tokenGive';
  if (!ADDR.test(o.tokenGet || '')) return 'bad-tokenGet';
  if (!UINT.test(String(o.amountGive))) return 'bad-amountGive';
  if (!UINT.test(String(o.amountGet))) return 'bad-amountGet';
  if (BigInt(o.amountGive) <= 0n) return 'zero-give';
  if (BigInt(o.amountGet) <= 0n) return 'zero-get';
  if (!Number.isSafeInteger(o.expiry) || o.expiry < 0) return 'bad-expiry';
  if (!UINT.test(String(o.nonce))) return 'bad-nonce';
  const g = o.tokenGive.toLowerCase();
  const t = o.tokenGet.toLowerCase();
  const pair =
    (g === HX_USDT && t === HX_CAW) || (g === HX_CAW && t === HX_USDT);
  if (!pair) return 'not-the-pair';
  return null;
}

export function orderExpired(o, nowSec) {
  return o.expiry !== 0 && o.expiry < nowSec;
}

/**
 * Add a listing. Returns { ok } or { ok:false, error }.
 * Duplicates (same maker + nonce + amounts) are refused so a
 * replayed POST cannot flood the book.
 */
export function applyOrder(listings, listed, nowSec) {
  const shapeErr = validateOrderShape(listed && listed.order);
  if (shapeErr) return { ok: false, error: shapeErr };
  if (typeof listed.signature !== 'string' || listed.signature.length !== 132) {
    return { ok: false, error: 'bad-signature' };
  }
  if (orderExpired(listed.order, nowSec)) {
    return { ok: false, error: 'expired' };
  }
  const key = orderIdentity(listed.order);
  if (listings.some((l) => orderIdentity(l.order) === key)) {
    return { ok: false, error: 'duplicate' };
  }
  return {
    ok: true,
    listings: [...listings, { ...listed, receivedAt: nowSec }],
  };
}

/** Remove the listing whose order matches (cancel path). */
export function applyCancel(listings, order) {
  const key = orderIdentity(order);
  const next = listings.filter((l) => orderIdentity(l.order) !== key);
  return { ok: next.length !== listings.length, listings: next };
}

/** Identity of an order independent of field casing. */
export function orderIdentity(o) {
  return [
    String(o.maker).toLowerCase(),
    String(o.tokenGive).toLowerCase(),
    String(o.amountGive),
    String(o.tokenGet).toLowerCase(),
    String(o.amountGet),
    String(o.expiry),
    String(o.nonce),
  ].join(':');
}

/** The live book: unexpired listings, newest last. */
export function liveBook(listings, nowSec) {
  return listings.filter((l) => !orderExpired(l.order, nowSec));
}

/**
 * Aggregate escrow need: the total GIVE amount a maker has
 * committed across open listings of one token, minus what a
 * caller reports already filled on-chain (filledByIdentity:
 * identity → filled raw). The Worker compares this against
 * the maker's on-chain escrow balance before accepting a new
 * listing, so the book cannot advertise unfunded orders
 * (best-effort: fills are only known when reported/checked).
 */
export function committedGive(listings, maker, token, filledByIdentity) {
  const m = String(maker).toLowerCase();
  const t = String(token).toLowerCase();
  let total = 0n;
  for (const l of listings) {
    if (l.order.maker.toLowerCase() !== m) continue;
    if (l.order.tokenGive.toLowerCase() !== t) continue;
    const filled = filledByIdentity
      ? BigInt(filledByIdentity[orderIdentity(l.order)] || '0')
      : 0n;
    const remaining = BigInt(l.order.amountGive) - filled;
    if (remaining > 0n) total += remaining;
  }
  return total;
}
