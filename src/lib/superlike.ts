/**
 * SuperLike （超いいね) — an app-original feature (v0.4.8), NOT a
 * CAW protocol action. A SuperLike is a fixed-price CAT42 tip
 * from the reader to a post's author, bound to the post
 * on-chain, and shown in the app as a ⭐ count on the post.
 *
 * PRICE (v0.4.9, user decision 2026-11-10): one SuperLike costs
 * 1,000 CAT42 in total, split in two transactions sent in this
 * order:
 *   1. AUTHOR leg — 500 CAT42 to the post's author, carrying
 *      the post binding as trailing calldata (below). Sent
 *      first so the ⭐ count lands immediately.
 *   2. BURN leg — a plain 500 CAT42 transfer to the burn
 *      address 0x…dEaD (no marker; it belongs to no post).
 * If the burn leg fails after the author leg landed, the pair
 * is left in an honest PENDING-BURN state (recorded on-device,
 * see the pending-burn store below): the only retry offered
 * sends the burn leg alone — the author is never paid twice
 * for one SuperLike. (v0.4.8 shipped a single 100 CAT42 marked
 * transfer; no SuperLike was ever sent under that price — the
 * count scan verified 0 — so v0.4.9 switches the price and the
 * count rule cleanly, with no legacy amount to honour.)
 *
 * THE BINDING (the author leg): the CAT42
 * `transfer(author, 500 CAT42)` carries the post binding as
 * TRAILING CALLDATA after the ordinary transfer arguments:
 *
 *     transfer calldata (68 bytes)
 *     + MAGIC  "SLK1" (4 bytes, 0x534c4b31)
 *     + cawId (32 bytes, the post's CAW id)
 *
 * Why this is safe was verified BEFORE it was designed in
 * (2026-11-09, both production 42 Chain RPCs, simulated from
 * the CAT42/ZAP pair holding ~5.07M CAT42):
 *   - eth_call of a 100 CAT42 transfer returns true (0x…01)
 *     IDENTICALLY with and without the trailing marker.
 *   - eth_estimateGas: plain 51,542 vs marked 52,118 — the
 *     delta is exactly 576 = 36 extra non-zero calldata bytes
 *     × 16 gas, the standard intrinsic calldata charge. The
 *     EXECUTION gas is identical, i.e. the contract never reads
 *     the trailing bytes; the transfer (and its Transfer log,
 *     emitted by that same execution) is untouched.
 *   - The app's own send path (ethers sendTransaction with raw
 *     data, via sendCalldata) passes calldata through verbatim.
 * (eth_simulateV1 / debug_traceCall are disabled on both
 * endpoints, so log capture from simulation is unavailable;
 * the execution-equivalence above is the evidence.)
 *
 * READS: counts come only from chain data. A scan walks the
 * author's incoming CAT42 Transfer logs from
 * SUPERLIKE_START_BLOCK forward in ≤9,000-block chunks (the
 * RPCs cap eth_getLogs ranges at 10,000), fetches each
 * transfer's transaction input in batches, and counts the
 * transfers whose input carries the marker for a given cawId
 * AND whose amount is exactly the author share (500 CAT42).
 * Progress is
 * kept per author (last scanned block + counts) in the
 * on-device KV store, so repeat reads only scan new blocks.
 * A chunk that fails stops the scan WITHOUT advancing the
 * cursor — a count is only ever the sum of completed scans.
 * Marked transfers cannot exist before the feature does, so
 * the start block (a little under the 42 Chain head at
 * release: 4,345,698 on 2026-11-09) loses nothing.
 *
 * Other clients see a plain CAT42 transfer; only this app
 * reads the marker. The convention is documented in the repo
 * README next to the reply/quote convention.
 */
import { Interface } from 'ethers';

import { CAT42, SEL } from '../config';
import { ethCall42, rpc42, rpc42Batch } from './cawApi';
import { decUintRet, encAddr } from './cawCore';
import type { KVStorage } from './myActions';

/** The fixed price of one SuperLike, in whole CAT42 (v0.4.9):
 *  1,000 total = 500 to the author + 500 burned. */
export const SUPERLIKE_TOTAL_CAT42 = 1000;
export const SUPERLIKE_AUTHOR_CAT42 = 500;
export const SUPERLIKE_BURN_CAT42 = 500;
export const SUPERLIKE_TOTAL_RAW =
  BigInt(SUPERLIKE_TOTAL_CAT42) * 10n ** 18n;
export const SUPERLIKE_AUTHOR_RAW =
  BigInt(SUPERLIKE_AUTHOR_CAT42) * 10n ** 18n;
export const SUPERLIKE_BURN_RAW =
  BigInt(SUPERLIKE_BURN_CAT42) * 10n ** 18n;

/** The project's established burn address (the CAT42 claim
 *  site's fee burn uses the same address). */
export const SUPERLIKE_BURN_ADDRESS =
  '0x000000000000000000000000000000000000dEaD';

/** Trailing-calldata magic: ASCII "SLK1". */
export const SUPERLIKE_MAGIC = '534c4b31';

/** First 42 Chain block a SuperLike can exist in (see header). */
export const SUPERLIKE_START_BLOCK = 4_300_000;

/** eth_getLogs chunk size (both RPCs cap the range at 10,000). */
const SL_CHUNK = 9000;

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_SELECTOR = 'a9059cbb';

const ERC20_IFACE = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/* ---------- the marker codec (pure) ---------- */

function normCawId(cawId: string): string | null {
  const h = (cawId || '').replace(/^0x/, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}

/**
 * The full transaction data for a SuperLike: an ordinary
 * CAT42 transfer of the fixed price to `to`, with the marker
 * (magic + cawId) appended. Null when the cawId is malformed.
 */
export function buildSuperlikeData(to: string, cawId: string): string | null {
  const id = normCawId(cawId);
  if (!id) return null;
  const base = ERC20_IFACE.encodeFunctionData('transfer', [
    to,
    SUPERLIKE_AUTHOR_RAW,
  ]);
  return base + SUPERLIKE_MAGIC + id;
}

/**
 * The burn leg's transaction data: a PLAIN CAT42 transfer of
 * the burn share to the burn address — deliberately no marker,
 * so the scanner never mistakes it for an author leg (it is
 * also addressed to the burn address, not to any author).
 */
export function buildBurnData(): string {
  return ERC20_IFACE.encodeFunctionData('transfer', [
    SUPERLIKE_BURN_ADDRESS,
    SUPERLIKE_BURN_RAW,
  ]);
}

export interface SuperlikeMark {
  to: string;
  amount: bigint;
  cawId: string;
}

/**
 * Parse a transaction's input as a marked SuperLike transfer.
 * Strict shape: exactly the transfer encoding + 36 trailing
 * bytes, the magic in place. Anything else is not a SuperLike.
 */
export function parseSuperlikeInput(data: string): SuperlikeMark | null {
  const h = (data || '').replace(/^0x/, '').toLowerCase();
  // 4 selector + 32 to + 32 amount + 4 magic + 32 cawId = 104 B
  if (h.length !== 208) return null;
  if (!h.startsWith(TRANSFER_SELECTOR)) return null;
  if (h.slice(136, 144) !== SUPERLIKE_MAGIC) return null;
  const to = '0x' + h.slice(32, 72);
  let amount: bigint;
  try {
    amount = BigInt('0x' + h.slice(72, 136));
  } catch {
    return null;
  }
  return { to, amount, cawId: '0x' + h.slice(144, 208) };
}

/* ---------- guard decisions (pure) ---------- */

/**
 * Why a SuperLike must not be sent, or null when it may.
 * Mirrors the self-follow rule: your own names' posts (local
 * list) and any post whose author owner IS your address are
 * blocked — a tip to yourself is meaningless and the chain
 * would happily take the fee-less transfer's gas.
 */
export function superlikeBlockReason(args: {
  senderId: bigint;
  myTokenIds: readonly bigint[];
  authorOwner: string;
  myAddress: string;
}): 'self' | null {
  if (args.myTokenIds.some((id) => id === args.senderId)) return 'self';
  if (
    args.authorOwner &&
    args.myAddress &&
    args.authorOwner.toLowerCase() === args.myAddress.toLowerCase()
  ) {
    return 'self';
  }
  return null;
}

/** True when the balance cannot cover one whole SuperLike
 *  (author share + burn share, v0.4.9). */
export function superlikeShortfall(balance: bigint): boolean {
  return balance < SUPERLIKE_TOTAL_RAW;
}

/** True when the balance cannot cover just the burn leg —
 *  the gate for the pending-burn retry. */
export function superlikeBurnShortfall(balance: bigint): boolean {
  return balance < SUPERLIKE_BURN_RAW;
}

/** A trustworthy CAT42 balance read (throws on RPC failure). */
export async function cat42BalanceOf(owner: string): Promise<bigint> {
  return decUintRet(
    await ethCall42(CAT42, SEL.balanceOf + encAddr(owner)),
  );
}

/* ---------- the count store + scanner ---------- */

const KV_KEY = 'caw-superlike-v1';

interface SlRecord {
  /** Last 42 Chain block fully scanned for this author. */
  to: number;
  counts: Record<string, number>;
}

let kv: KVStorage | null = null;
let loaded: Promise<void> | null = null;
const records = new Map<string, SlRecord>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

export function initSuperlikeStore(storage: KVStorage): void {
  kv = storage;
}

export function subscribeSuperlike(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a broken listener must not break the scanner */
    }
  }
}

function ensureLoaded(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      if (!kv) return;
      try {
        const raw = await kv.getItem(KV_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, SlRecord>;
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v.to === 'number' && v.counts) {
            records.set(k, { to: v.to, counts: { ...v.counts } });
          }
        }
      } catch {
        /* a corrupt cache just means a rescan */
      }
    })();
  }
  return loaded;
}

async function persist(): Promise<void> {
  if (!kv) return;
  try {
    await kv.setItem(KV_KEY, JSON.stringify(Object.fromEntries(records)));
  } catch {
    /* persistence is an optimisation; the in-memory copy stands */
  }
}

const topicAddress = (addr: string): string =>
  '0x' + '0'.repeat(24) + addr.replace(/^0x/, '').toLowerCase();
const hexBlock = (n: number): string => '0x' + n.toString(16);

interface RawLog {
  transactionHash: string;
  data: string;
}

async function absorb(rec: SlRecord, ownerKey: string, logs: RawLog[]): Promise<void> {
  const hashes = [...new Set(logs.map((l) => l.transactionHash))];
  const inputs = new Map<string, string>();
  for (let i = 0; i < hashes.length; i += 30) {
    const group = hashes.slice(i, i + 30);
    const txs = await rpc42Batch(
      group.map((hash) => ({
        method: 'eth_getTransactionByHash',
        params: [hash],
      })),
    );
    group.forEach((hash, j) => {
      const tx = txs[j] as { input?: string } | null;
      if (tx && typeof tx.input === 'string') inputs.set(hash, tx.input);
    });
  }
  for (const log of logs) {
    const input = inputs.get(log.transactionHash);
    if (!input) continue;
    const mark = parseSuperlikeInput(input);
    if (!mark) continue;
    if (mark.to.toLowerCase() !== ownerKey) continue;
    if (mark.amount !== SUPERLIKE_AUTHOR_RAW) continue;
    // The log's own value word must agree with the marked amount.
    try {
      if (BigInt(log.data) !== SUPERLIKE_AUTHOR_RAW) continue;
    } catch {
      continue;
    }
    rec.counts[mark.cawId] = (rec.counts[mark.cawId] ?? 0) + 1;
  }
}

async function scanAuthor(ownerKey: string): Promise<void> {
  const running = inflight.get(ownerKey);
  if (running) return running;
  const p = (async () => {
    await ensureLoaded();
    let rec = records.get(ownerKey);
    if (!rec) {
      rec = { to: SUPERLIKE_START_BLOCK - 1, counts: {} };
      records.set(ownerKey, rec);
    }
    let head: number;
    try {
      head = Number(BigInt(await rpc42('eth_blockNumber', [])));
    } catch {
      return; // cannot even read the head — try again later
    }
    let from = Math.max(SUPERLIKE_START_BLOCK, rec.to + 1);
    while (from <= head) {
      const toB = Math.min(from + SL_CHUNK - 1, head);
      let logs: RawLog[];
      try {
        logs = (await rpc42('eth_getLogs', [
          {
            address: CAT42,
            topics: [TRANSFER_TOPIC, null, topicAddress(ownerKey)],
            fromBlock: hexBlock(from),
            toBlock: hexBlock(toB),
          },
        ])) as RawLog[];
      } catch {
        return; // cursor NOT advanced past the failed chunk
      }
      if (logs.length > 0) {
        try {
          await absorb(rec, ownerKey, logs);
        } catch {
          return; // input fetch failed — rescan this chunk later
        }
      }
      rec.to = toB;
      await persist();
      notify();
      from = toB + 1;
    }
  })();
  inflight.set(ownerKey, p);
  try {
    await p;
  } finally {
    inflight.delete(ownerKey);
  }
}

/**
 * The verified SuperLike count for one post: scans the
 * author's incoming marked transfers up to the current head
 * (deduped per author, cursor-persisted), then answers from
 * the accumulated counts. Returns the best-known count when
 * the chain is unreachable — itself a sum of completed scans,
 * never an invented number.
 */
export async function superlikeCount(
  owner: string,
  cawId: string,
): Promise<number> {
  const id = normCawId(cawId);
  if (!id) return 0;
  const ownerKey = owner.toLowerCase();
  await scanAuthor(ownerKey);
  await ensureLoaded();
  return records.get(ownerKey)?.counts['0x' + id] ?? 0;
}

/** The count from completed scans so far, or null if never scanned. */
export function superlikeCountCached(
  owner: string,
  cawId: string,
): number | null {
  const id = normCawId(cawId);
  if (!id) return null;
  const rec = records.get(owner.toLowerCase());
  if (!rec) return null;
  return rec.counts['0x' + id] ?? 0;
}

/**
 * After my own SuperLike lands: the cursor already covers
 * blocks up to the previous head, so the next count read picks
 * the transfer up — just wake the listeners once the rescan
 * completes. Fire-and-forget by design.
 */
export function refreshSuperlikesFor(owner: string): void {
  scanAuthor(owner.toLowerCase())
    .then(() => notify())
    .catch(() => {});
}

/* ---------- pending burns (v0.4.9) ---------- */
/**
 * When the author leg of a SuperLike has landed but the burn
 * leg has not, the pair is owed a burn. That debt is recorded
 * here (same on-device KV as the counts, its own key) so it
 * survives restarts and the retry can be offered honestly:
 * the retry sends ONLY the burn leg — the record's existence
 * is the proof the author was already paid, and nothing in the
 * retry path can rebuild or resend the author leg.
 */
const BURN_KV_KEY = 'caw-superlike-burn-v1';

export interface PendingBurn {
  /** The post the SuperLike belongs to (0x + 64 hex). */
  cawId: string;
  /** The author who already received the author share. */
  author: string;
  /** Unix seconds when the author leg landed. */
  ts: number;
}

const burnRecords = new Map<string, PendingBurn>();
let burnLoaded: Promise<void> | null = null;

function burnKey(sender: string, cawId: string): string | null {
  const id = normCawId(cawId);
  if (!id || !sender) return null;
  return sender.toLowerCase() + ':' + '0x' + id;
}

function ensureBurnLoaded(): Promise<void> {
  if (!burnLoaded) {
    burnLoaded = (async () => {
      if (!kv) return;
      try {
        const raw = await kv.getItem(BURN_KV_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, PendingBurn>;
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v.cawId === 'string' && typeof v.author === 'string') {
            burnRecords.set(k, v);
          }
        }
      } catch {
        /* a corrupt record just means no pending burn is shown */
      }
    })();
  }
  return burnLoaded;
}

async function persistBurns(): Promise<void> {
  if (!kv) return;
  try {
    await kv.setItem(BURN_KV_KEY, JSON.stringify(Object.fromEntries(burnRecords)));
  } catch {
    /* the in-memory record still stands for this session */
  }
}

/** The pending burn owed for one post by one sender, if any. */
export async function pendingBurnFor(
  sender: string,
  cawId: string,
): Promise<PendingBurn | null> {
  const key = burnKey(sender, cawId);
  if (!key) return null;
  await ensureBurnLoaded();
  return burnRecords.get(key) ?? null;
}

/** Record that an author leg landed and its burn is now owed. */
export async function recordPendingBurn(
  sender: string,
  rec: PendingBurn,
): Promise<void> {
  const key = burnKey(sender, rec.cawId);
  if (!key) return;
  await ensureBurnLoaded();
  burnRecords.set(key, rec);
  await persistBurns();
}

/** Clear the debt once the burn leg has landed. */
export async function clearPendingBurn(
  sender: string,
  cawId: string,
): Promise<void> {
  const key = burnKey(sender, cawId);
  if (!key) return;
  await ensureBurnLoaded();
  if (burnRecords.delete(key)) await persistBurns();
}
