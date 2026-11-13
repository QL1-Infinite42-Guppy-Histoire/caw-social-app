/**
 * Marked burns — the shared on-chain index behind SuperLike
 * (v0.5.0) and SuperRecaw (v0.5.0).
 *
 * Both features carry a BURN leg paid the same way: O (the
 * QL1 token "Childhoods End") transferred to the burn address,
 * with a marker appended as TRAILING CALLDATA after the
 * ordinary transfer arguments:
 *
 *     transfer calldata (68 bytes)
 *     + MAGIC  (4 bytes: "SLK1" for a SuperLike,
 *                      "SRC1" for a SuperRecaw)
 *     + cawId (32 bytes, the post's CAW id)
 *
 * The economics changed in v0.6.3 (user decision 2026-11-13):
 * each action now costs 25,000,000 O IN TOTAL — a burn leg
 * plus a plain (unmarked) author-payment leg (see
 * lib/authorPay.ts and lib/actionFlow.ts):
 *   SuperLike: 15,000,000 to the author + 10,000,000 burned
 *   SuperRecaw: 5,000,000 to the author + 20,000,000 burned
 * Under the v0.5.0–v0.6.2 spec both actions were a single
 * 1,000,000 O burn. Those legacy burns were genuine under
 * the spec of their time, so the detection sets below accept
 * BOTH the current burn amount and the legacy 1,000,000 for
 * each magic — no cut-off, no lost history.
 *
 * The recipient is the burn address for everyone, so counts
 * cannot be gathered per author (the v0.4.8/9 design); instead
 * ONE chain-wide scan of the O token's Transfer events TO the
 * burn address is indexed by cawId (and, for SuperRecaw, by
 * cawId + sender). A transfer counts only when its input
 * carries a marker, its amount is in the marker's accepted
 * set, and the Transfer log's own value agrees — the same
 * strictness the CAT42 scanner used.
 *
 * Why trailing calldata is safe for O was verified with the
 * REAL token BEFORE this design was adopted (2026-11-10,
 * read-only, QL1 head 13,435,401):
 *   - eth_call of a burn transfer at the then-current
 *     1,000,000 O (the mechanics are amount-independent),
 *     simulated from the QomSwap O/WQOM pair (a holder of
 *     ~13.28 trillion O):
 *     returns true (0x…01) IDENTICALLY with and without the
 *     36-byte marker.
 *   - eth_estimateGas: plain 35,077 vs marked 35,281 — the
 *     delta (204) is EXACTLY the intrinsic calldata charge of
 *     the test marker (5 non-zero bytes × 16 + 31 zero bytes
 *     × 4), i.e. the execution itself is untouched and never
 *     reads the trailing bytes.
 *   - No transfer tax: 36 real direct transfer() calls sampled
 *     across ~1.46M blocks — every transaction's input amount
 *     equalled its Transfer log amount (0 mismatches).
 *   - eth_getLogs on the QL1 RPC caps the block range at
 *     10,000 — the scanner chunks at 9,000, like the 42 one.
 * The app's send path (ethers sendTransaction with raw data,
 * via sendCalldata) passes calldata through verbatim.
 *
 * Scan progress (last fully scanned block + both indexes) is
 * kept in the on-device KV store; a chunk that fails stops the
 * scan WITHOUT advancing the cursor, so every count is only
 * ever the sum of completed scans. Marked burns cannot exist
 * before the feature does, so the start block (a little under
 * the QL1 head at build time: 13,435,401 on 2026-11-10) loses
 * nothing.
 */
import { Interface } from 'ethers';

import { O_TOKEN } from '../config';
import { rpc, rpcBatch } from './cawApi';
import type { KVStorage } from './myActions';

/** The burn address (the project's established one). */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';

/* ---------- the money (v0.6.3) ----------
 * ONE source of truth for every SuperLike / SuperRecaw
 * amount. The prechecks, the confirmation sheets, the send
 * flows, the detection sets and the pending-leg records all
 * read from here — no other file may hard-code these. */

const o = (whole: number): bigint => BigInt(whole) * 10n ** 18n;

/** SuperLike (v0.6.3): 25,000,000 O total. */
export const SUPERLIKE_TOTAL_O = 25_000_000;
export const SUPERLIKE_TOTAL_RAW = o(SUPERLIKE_TOTAL_O);
export const SUPERLIKE_AUTHOR_O = 15_000_000;
export const SUPERLIKE_AUTHOR_RAW = o(SUPERLIKE_AUTHOR_O);
export const SUPERLIKE_BURN_O = 10_000_000;
export const SUPERLIKE_BURN_RAW = o(SUPERLIKE_BURN_O);

/** SuperRecaw (v0.6.3): 25,000,000 O total (plus the Recaw). */
export const SUPERRECAW_TOTAL_O = 25_000_000;
export const SUPERRECAW_TOTAL_RAW = o(SUPERRECAW_TOTAL_O);
export const SUPERRECAW_AUTHOR_O = 5_000_000;
export const SUPERRECAW_AUTHOR_RAW = o(SUPERRECAW_AUTHOR_O);
export const SUPERRECAW_BURN_O = 20_000_000;
export const SUPERRECAW_BURN_RAW = o(SUPERRECAW_BURN_O);

/**
 * The v0.5.0–v0.6.2 burn price: exactly 1,000,000 O for BOTH
 * actions. Detection-only now — nothing new is ever sent at
 * this amount, but burns made under the old spec stay valid
 * forever (they were real when they were made).
 */
export const LEGACY_MARKED_BURN_O = 1_000_000;
export const LEGACY_MARKED_BURN_RAW = o(LEGACY_MARKED_BURN_O);

/** Burn amounts that COUNT for each marker (current + legacy). */
export const SUPERLIKE_BURN_AMOUNTS: readonly bigint[] = [
  SUPERLIKE_BURN_RAW,
  LEGACY_MARKED_BURN_RAW,
];
export const SUPERRECAW_BURN_AMOUNTS: readonly bigint[] = [
  SUPERRECAW_BURN_RAW,
  LEGACY_MARKED_BURN_RAW,
];

/** The accepted burn-amount set for a parsed marker's magic. */
export function burnAmountsForMagic(magic: string): readonly bigint[] {
  return magic === SUPERLIKE_MAGIC
    ? SUPERLIKE_BURN_AMOUNTS
    : SUPERRECAW_BURN_AMOUNTS;
}

/** Trailing-calldata magics (ASCII). */
export const SUPERLIKE_MAGIC = '534c4b31'; // "SLK1"
export const SUPERRECAW_MAGIC = '53524331'; // "SRC1"

/** First QL1 block a marked burn can exist in (see header). */
export const MARKED_BURN_START_BLOCK = 13_400_000;

/** eth_getLogs chunk size (the QL1 RPC caps the range at 10,000). */
const MB_CHUNK = 9000;

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_SELECTOR = 'a9059cbb';

const ERC20_IFACE = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/* ---------- the marker codec (pure) ---------- */

export function normCawIdHex(cawId: string): string | null {
  const h = (cawId || '').replace(/^0x/, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}

/**
 * The full transaction data for a marked burn: an ordinary
 * transfer of exactly `amountRaw` to the burn address, with
 * the marker (magic + cawId) appended. The amount is a
 * required parameter — a caller must name WHICH burn it is
 * building (the SuperLike burn and the SuperRecaw burn
 * differ since v0.6.3). Null when the cawId is malformed.
 */
export function buildMarkedBurnData(
  magic: string,
  cawId: string,
  amountRaw: bigint,
): string | null {
  const id = normCawIdHex(cawId);
  if (!id) return null;
  const base = ERC20_IFACE.encodeFunctionData('transfer', [
    BURN_ADDRESS,
    amountRaw,
  ]);
  return base + magic + id;
}

export interface MarkedBurnMark {
  magic: string;
  to: string;
  amount: bigint;
  cawId: string;
}

/**
 * Parse a transaction's input as a marked burn transfer.
 * Strict shape: exactly the transfer encoding + 36 trailing
 * bytes, a known magic in place, the recipient the burn
 * address. Anything else is not a marked burn.
 */
export function parseMarkedBurnInput(data: string): MarkedBurnMark | null {
  const h = (data || '').replace(/^0x/, '').toLowerCase();
  // 4 selector + 32 to + 32 amount + 4 magic + 32 cawId = 104 B
  if (h.length !== 208) return null;
  if (!h.startsWith(TRANSFER_SELECTOR)) return null;
  const magic = h.slice(136, 144);
  if (magic !== SUPERLIKE_MAGIC && magic !== SUPERRECAW_MAGIC) return null;
  const to = '0x' + h.slice(32, 72);
  if (to !== BURN_ADDRESS.toLowerCase()) return null;
  let amount: bigint;
  try {
    amount = BigInt('0x' + h.slice(72, 136));
  } catch {
    return null;
  }
  return { magic, to, amount, cawId: '0x' + h.slice(144, 208) };
}

/* ---------- the index (store + scanner) ---------- */

/* The persisted index needs no version bump for v0.6.3:
 * records written by v0.5.0–v0.6.2 can only contain legacy
 * 1,000,000 burns, which both detection sets still accept,
 * and the scan cursor simply continues from where it was. */
const KV_KEY = 'caw-marked-burns-v1';

interface MbRecord {
  /** Last QL1 block fully scanned. */
  to: number;
  /** SuperLike counts by cawId ('0x' + 64 hex). */
  sl: Record<string, number>;
  /** SuperRecaw marks: key cawId + ':' + sender (lowercase). */
  src: Record<string, number>;
}

let kv: KVStorage | null = null;
let loaded: Promise<void> | null = null;
let record: MbRecord = { to: MARKED_BURN_START_BLOCK - 1, sl: {}, src: {} };
let scanning: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function initMarkedBurnStore(storage: KVStorage): void {
  kv = storage;
}

export function subscribeMarkedBurns(fn: () => void): () => void {
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
        const parsed = JSON.parse(raw) as MbRecord;
        if (
          parsed &&
          typeof parsed.to === 'number' &&
          parsed.sl &&
          parsed.src &&
          parsed.to >= MARKED_BURN_START_BLOCK - 1
        ) {
          record = { to: parsed.to, sl: { ...parsed.sl }, src: { ...parsed.src } };
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
    await kv.setItem(KV_KEY, JSON.stringify(record));
  } catch {
    /* persistence is an optimisation; the in-memory copy stands */
  }
}

const topicAddress = (addr: string): string =>
  '0x' + '0'.repeat(24) + addr.replace(/^0x/, '').toLowerCase();
const hexBlock = (n: number): string => '0x' + n.toString(16);

interface RawLog {
  transactionHash: string;
  topics: string[];
  data: string;
}

async function absorb(logs: RawLog[]): Promise<void> {
  const hashes = [...new Set(logs.map((l) => l.transactionHash))];
  const inputs = new Map<string, string>();
  for (let i = 0; i < hashes.length; i += 30) {
    const group = hashes.slice(i, i + 30);
    const txs = await rpcBatch(
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
    if (!input) throw new Error('missing input'); // rescan chunk later
    const mark = parseMarkedBurnInput(input);
    if (!mark) continue;
    // The amount must be one the marker accepts: the current
    // burn for that action, or the legacy 1,000,000 (v0.6.3).
    if (!burnAmountsForMagic(mark.magic).includes(mark.amount)) continue;
    // The log's own value word must agree with the marked amount.
    try {
      if (BigInt(log.data) !== mark.amount) continue;
    } catch {
      continue;
    }
    const from = ('0x' + (log.topics[1] || '').slice(26)).toLowerCase();
    if (mark.magic === SUPERLIKE_MAGIC) {
      record.sl[mark.cawId] = (record.sl[mark.cawId] ?? 0) + 1;
    } else {
      const key = mark.cawId + ':' + from;
      record.src[key] = (record.src[key] ?? 0) + 1;
    }
  }
}

async function scanOnce(): Promise<void> {
  await ensureLoaded();
  let head: number;
  try {
    head = Number(BigInt(await rpc('eth_blockNumber', [])));
  } catch {
    return; // cannot even read the head — try again later
  }
  let from = Math.max(MARKED_BURN_START_BLOCK, record.to + 1);
  while (from <= head) {
    const toB = Math.min(from + MB_CHUNK - 1, head);
    let logs: RawLog[];
    try {
      logs = (await rpc('eth_getLogs', [
        {
          address: O_TOKEN,
          topics: [TRANSFER_TOPIC, null, topicAddress(BURN_ADDRESS)],
          fromBlock: hexBlock(from),
          toBlock: hexBlock(toB),
        },
      ])) as RawLog[];
    } catch {
      return; // cursor NOT advanced past the failed chunk
    }
    if (logs.length > 0) {
      try {
        await absorb(logs);
      } catch {
        return; // input fetch failed — rescan this chunk later
      }
    }
    record.to = toB;
    await persist();
    notify();
    from = toB + 1;
  }
}

/** Scan to the current head (deduped while a scan is running). */
export function scanMarkedBurns(): Promise<void> {
  if (!scanning) {
    scanning = scanOnce().finally(() => {
      scanning = null;
    });
  }
  return scanning;
}

/** The SuperLike count for one post, from completed scans. */
export function superlikeCountCached(cawId: string): number {
  const id = normCawIdHex(cawId);
  if (!id) return 0;
  return record.sl['0x' + id] ?? 0;
}

/** Scan, then answer the SuperLike count for one post. */
export async function superlikeCount(cawId: string): Promise<number> {
  await scanMarkedBurns();
  return superlikeCountCached(cawId);
}

/** True when this sender has a SuperRecaw mark for the post. */
export function superRecawCached(cawId: string, sender: string): boolean {
  const id = normCawIdHex(cawId);
  if (!id || !sender) return false;
  return (record.src['0x' + id + ':' + sender.toLowerCase()] ?? 0) > 0;
}

/** Scan, then answer whether the sender SuperRecaw'd the post. */
export async function hasSuperRecaw(
  cawId: string,
  sender: string,
): Promise<boolean> {
  await scanMarkedBurns();
  return superRecawCached(cawId, sender);
}

/** After my own marked burn lands, nudge a rescan (fire-and-forget). */
export function refreshMarkedBurns(): void {
  scanMarkedBurns()
    .then(() => notify())
    .catch(() => {});
}
