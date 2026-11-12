/**
 * Post view counts (impressions) — v0.6.0, X-style overhaul.
 *
 * HONESTY FIRST: views are NOT on-chain and cannot be. The
 * numbers come from an app-side counter (a Cloudflare Worker
 * + KV, worker/views/ in this repo) that aggregates views
 * registered from inside this app — nothing else. The About
 * section in Settings says exactly that, in every language
 * ('views.note').
 *
 * GATING: the counter endpoint is src/config.ts's
 * VIEWS_COUNTER_URL. While it is EMPTY (the shipped state —
 * activation needs the operator to deploy the counter Worker
 * and a later build to fill the URL, the same pattern as the
 * HuntersExchange order book), this module is inert and the
 * post rows render NO views element at all — absent, never
 * a fake 0. Only with an endpoint set do counts load, and a
 * row shows a number only after the counter has answered.
 *
 * Counting rules (approximate by design, and documented as
 * such): a view is registered at most once per post per day
 * per device — enforced on the device (a local day record,
 * kept before the send so a flaky network can only ever
 * UNDERcount, never inflate) and again on the Worker (a
 * per-device-per-post-per-day dedupe key). The device token
 * is a random on-device id, unrelated to any wallet or name;
 * it exists only so the same phone cannot count twice.
 *
 * The network core (batching, cache, dedupe) mirrors the
 * marked-burns index's shape (lib/markedBurns.ts): an
 * in-memory cache, a subscribe/notify fan-out, and debounced
 * batch requests so a screenful of rows costs one POST.
 */
import { VIEWS_COUNTER_URL } from '../config';
import type { KVStorage } from './myActions';

/** True only when a counter endpoint is configured. Every
 *  consumer gates on this — with it false, nothing in this
 *  module touches the network or the UI. */
export const VIEWS_ENABLED: boolean = VIEWS_COUNTER_URL.length > 0;

const DEVICE_KEY = 'caw-views-device-v1';
const HIT_KEY = 'caw-views-hit-v1';

/* ---------- pure helpers (verified in Node) ---------- */

/** Normalise a cawId to the counter's key form: '0x' + 64
 *  lowercase hex. Null when the id is not a well-formed id. */
export function normViewId(cawId: string): string | null {
  const h = (cawId || '').replace(/^0x/, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? '0x' + h : null;
}

/** The UTC day key ('YYYY-MM-DD') a hit dedupe window uses. */
export function viewDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * X-style compact count: 285 → "285", 1,000 → "1K",
 * 1,234 → "1.2K", 999,949 → "999.9K", 1,200,000 → "1.2M".
 * One decimal, truncated (never rounded up), ".0" dropped.
 */
export function formatViewCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  const v = Math.floor(n);
  if (v < 1000) return String(v);
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [base, suffix] of units) {
    if (v >= base) {
      const scaled = Math.floor((v / base) * 10) / 10;
      const text = scaled.toFixed(1).replace(/\.0$/, '');
      return text + suffix;
    }
  }
  return String(v);
}

/**
 * The local once-per-day gate: given the stored hit record
 * (cawId key → day key) and today, decide whether this post
 * may register a view, and produce the record to store when
 * it does. Pure — the store below is a thin wrapper.
 */
export function planViewHit(
  record: Record<string, string>,
  cawId: string,
  today: string,
): { send: boolean; record: Record<string, string> } {
  const id = normViewId(cawId);
  if (!id) return { send: false, record };
  if (record[id] === today) return { send: false, record };
  return { send: true, record: { ...record, [id]: today } };
}

/** Prune day entries older than the given day key (keeps the
 *  stored record from growing without bound). */
export function pruneHitRecord(
  record: Record<string, string>,
  keepFromDay: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (v >= keepFromDay) out[k] = v;
  }
  return out;
}

/* ---------- the store (device state + network) ---------- */

let kv: KVStorage | null = null;
let deviceToken: string | null = null;
let deviceLoading: Promise<string> | null = null;
let hitRecord: Record<string, string> = {};
let hitLoaded: Promise<void> | null = null;

const counts = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a broken listener must not break the counter */
    }
  }
}

export function subscribeViews(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The last fetched count for a post, or null when the
 *  counter has not answered for it yet (rows render nothing
 *  for null — a number appears only when it is real). */
export function viewCountCached(cawId: string): number | null {
  const id = normViewId(cawId);
  if (!id) return null;
  return counts.has(id) ? (counts.get(id) as number) : null;
}

export function initViews(storage: KVStorage): void {
  kv = storage;
}

function randomToken(): string {
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}

function loadDeviceToken(): Promise<string> {
  if (deviceToken) return Promise.resolve(deviceToken);
  if (!deviceLoading) {
    deviceLoading = (async () => {
      if (kv) {
        try {
          const saved = await kv.getItem(DEVICE_KEY);
          if (saved && /^[0-9a-f]{16,64}$/.test(saved)) {
            deviceToken = saved;
            return saved;
          }
        } catch {
          /* fall through to a fresh token */
        }
      }
      const fresh = randomToken();
      deviceToken = fresh;
      if (kv) {
        try {
          await kv.setItem(DEVICE_KEY, fresh);
        } catch {
          /* the token still works for this session */
        }
      }
      return fresh;
    })();
  }
  return deviceLoading;
}

function loadHitRecord(): Promise<void> {
  if (!hitLoaded) {
    hitLoaded = (async () => {
      if (!kv) return;
      try {
        const raw = await kv.getItem(HIT_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            hitRecord = parsed as Record<string, string>;
          }
        }
      } catch {
        /* a corrupt record just means a recount today */
      }
    })();
  }
  return hitLoaded;
}

async function persistHitRecord(): Promise<void> {
  if (!kv) return;
  try {
    await kv.setItem(HIT_KEY, JSON.stringify(hitRecord));
  } catch {
    /* persistence trouble must not break the row */
  }
}

async function postJson(path: string, body: unknown): Promise<any> {
  const res = await fetch(VIEWS_COUNTER_URL + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('views ' + res.status);
  return res.json();
}

/* Counts batching: rows ask for their ids as they mount; the
 * asks coalesce over a short window into ONE POST /views. */
const pendingCounts = new Set<string>();
let countsTimer: ReturnType<typeof setTimeout> | null = null;
const fetchingCounts = new Set<string>();

function flushCounts(): void {
  countsTimer = null;
  const ids = [...pendingCounts].filter((id) => !fetchingCounts.has(id));
  pendingCounts.clear();
  if (ids.length === 0) return;
  for (const id of ids) fetchingCounts.add(id);
  postJson('/views', { ids })
    .then((j) => {
      const got = (j && j.counts) || {};
      let changed = false;
      for (const id of ids) {
        const v = got[id];
        // An id missing from the answer means the counter has
        // no views recorded for it — a real 0, now known.
        const n = typeof v === 'number' && v >= 0 ? Math.floor(v) : 0;
        if (counts.get(id) !== n) {
          counts.set(id, n);
          changed = true;
        }
      }
      if (changed) notify();
    })
    .catch(() => {
      /* counts stay unknown; a later mount retries */
    })
    .finally(() => {
      for (const id of ids) fetchingCounts.delete(id);
    });
}

/** Ask the counter for these posts' counts (batched). */
export function ensureViewCounts(cawIds: string[]): void {
  if (!VIEWS_ENABLED) return;
  let queued = false;
  for (const raw of cawIds) {
    const id = normViewId(raw);
    if (!id || counts.has(id) || fetchingCounts.has(id)) continue;
    pendingCounts.add(id);
    queued = true;
  }
  if (queued && !countsTimer) {
    countsTimer = setTimeout(flushCounts, 300);
  }
}

/* Hit batching: views register through the same coalescing,
 * one POST /views/hit per screenful. */
const pendingHits = new Set<string>();
let hitsTimer: ReturnType<typeof setTimeout> | null = null;

function flushHits(): void {
  hitsTimer = null;
  const ids = [...pendingHits];
  pendingHits.clear();
  if (ids.length === 0) return;
  loadDeviceToken()
    .then((deviceTokenValue) =>
      postJson('/views/hit', { ids, deviceToken: deviceTokenValue }),
    )
    .then((j) => {
      // Fold the server's post-hit counts straight into the
      // cache when it returns them — the row that registered
      // the view sees its own count move.
      const got = (j && j.counts) || {};
      let changed = false;
      for (const [id, v] of Object.entries(got)) {
        if (typeof v === 'number' && counts.get(id) !== v) {
          counts.set(id, Math.floor(v));
          changed = true;
        }
      }
      if (changed) notify();
    })
    .catch(() => {
      /* the local day record already stands (undercount at
       * worst — see the header); nothing to retry loudly */
    });
}

/**
 * Register a view of one post, at most once per day on this
 * device. Called by post rows as they render. A no-op when
 * the counter is not configured.
 */
export function registerView(cawId: string): void {
  if (!VIEWS_ENABLED) return;
  const id = normViewId(cawId);
  if (!id) return;
  ensureViewCounts([id]);
  loadHitRecord()
    .then(async () => {
      const today = viewDayKey(Date.now());
      const plan = planViewHit(hitRecord, id, today);
      if (!plan.send) return;
      // Keep the last week of day entries; older ones can
      // never match a future "today" check anyway.
      const weekAgo = viewDayKey(Date.now() - 7 * 86400_000);
      hitRecord = pruneHitRecord(plan.record, weekAgo);
      await persistHitRecord();
      pendingHits.add(id);
      if (!hitsTimer) hitsTimer = setTimeout(flushHits, 1200);
    })
    .catch(() => {});
}
