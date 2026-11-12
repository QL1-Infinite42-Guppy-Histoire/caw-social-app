/**
 * CAW post view counter — core logic (v0.6.0).
 *
 * Views are NOT on-chain. This counter aggregates, in
 * Cloudflare KV, the views that the CAW Social app registers
 * from inside itself — approximate by design:
 *
 *   - a view counts at most once per post per day per device,
 *     enforced here by a dedupe key (the app ALSO gates on the
 *     device before sending, so a view that never arrives
 *     simply never counts — the counter can undercount on a
 *     flaky network, never inflate from one device);
 *   - the device token is a random id the app generates on
 *     the phone. It is not a wallet, a name, or a person, and
 *     nothing here tries to make it one.
 *
 * Storage (KV binding VIEWS_KV):
 *   count:<cawId>                    → decimal string
 *   hit:<deviceToken>:<day>:<cawId>  → '1', TTL 3 days
 *
 * cawId key form: '0x' + 64 lowercase hex — the same
 * normalisation the app applies (src/lib/views.ts).
 *
 * Pure functions over an injected KV ({ get, put }) so the
 * whole behaviour is verifiable in Node without a Cloudflare
 * account (scripts/verify-xui.mjs drives this file with a
 * fake KV).
 */

export const MAX_IDS_PER_REQUEST = 100;
const DEDUPE_TTL_SECONDS = 3 * 24 * 3600;

export function normViewId(cawId) {
  if (typeof cawId !== 'string') return null;
  const h = cawId.replace(/^0x/, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? '0x' + h : null;
}

export function validDeviceToken(token) {
  return typeof token === 'string' && /^[0-9a-f]{16,64}$/.test(token);
}

/** The UTC day key ('YYYY-MM-DD') a dedupe window uses. */
export function viewDayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Sanitise an ids payload: normalised, de-duplicated,
 *  capped. Malformed entries drop out silently. */
export function sanitizeIds(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    const id = normViewId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS_PER_REQUEST) break;
  }
  return out;
}

const countKey = (id) => 'count:' + id;
const hitKey = (token, day, id) => `hit:${token}:${day}:${id}`;

async function readCount(kv, id) {
  const raw = await kv.get(countKey(id));
  const n = raw === null || raw === undefined ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** POST /views — read the counts for a batch of posts.
 *  Ids the counter has never seen answer 0 (a real zero:
 *  no view has been registered for them). */
export async function getCounts(kv, idsRaw) {
  const ids = sanitizeIds(idsRaw);
  const counts = {};
  await Promise.all(
    ids.map(async (id) => {
      counts[id] = await readCount(kv, id);
    }),
  );
  return { counts };
}

/**
 * POST /views/hit — register a batch of views from one
 * device. Each (device, day, post) counts once: a repeat
 * inside the window is acknowledged but does not increment.
 * Returns which ids actually counted, plus their new totals.
 */
export async function registerHits(kv, body, nowMs) {
  const token = body && body.deviceToken;
  if (!validDeviceToken(token)) {
    return { error: 'bad device token', status: 400 };
  }
  const ids = sanitizeIds(body && body.ids);
  const day = viewDayKey(nowMs);
  const counted = [];
  const counts = {};
  for (const id of ids) {
    const hk = hitKey(token, day, id);
    const seen = await kv.get(hk);
    if (seen === null || seen === undefined) {
      await kv.put(hk, '1', { expirationTtl: DEDUPE_TTL_SECONDS });
      const next = (await readCount(kv, id)) + 1;
      await kv.put(countKey(id), String(next));
      counted.push(id);
      counts[id] = next;
    } else {
      counts[id] = await readCount(kv, id);
    }
  }
  return { ok: true, counted, counts };
}
