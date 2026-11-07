/**
 * Read layer for CAW on QL1 — public RPC + Blockscout API, ported from
 * the verified web front end. No keys are handled here; writes go
 * through src/lib/wallet.ts with the in-app signer.
 */
import { decodeBase64, toUtf8String } from 'ethers';

import { API, CAW_ACTIONS, CAW_NAME, EXPLORER, MINTER, QCAW, RPC, SEL } from '../config';
import {
  CawAction,
  NameToken,
  decodeActions,
  decAddrRet,
  decStringRet,
  decTokensRet,
  decUintRet,
  encAddr,
  encStr,
  strip,
  word,
} from './cawCore';

export interface TimelineItem extends CawAction {
  hash: string;
  blockTs?: string;
}

export interface Page<T> {
  items: T[];
  next: Record<string, unknown> | null;
}

/* ---------- read-only RPC ---------- */
let rpcSeq = 0;
export async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSeq, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

export const ethCall = (to: string, data: string): Promise<string> =>
  rpc('eth_call', [{ to, data }, 'latest']);
export const readUint = async (to: string, data: string): Promise<bigint> =>
  decUintRet(await ethCall(to, data));
export const readAddr = async (to: string, data: string): Promise<string> =>
  decAddrRet(await ethCall(to, data));
export const readStr = async (to: string, data: string): Promise<string> =>
  decStringRet(await ethCall(to, data));

/** Retry a read a few times (public RPCs can hiccup). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  tries = 3,
  delayMs = 700,
): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/* ---------- names ---------- */
/**
 * IMPORTANT — the QL1 CawName.tokens(owner) rows pair each token id
 * with the WRONG username: the name of the token one id lower (proven
 * from the raw return data: the owner of id 189 gets username
 * "dreamin", which belongs to id 188; usernames(189) is "neptune").
 * Only the ids and balances in those rows can be trusted, so every
 * username is re-read from the usernames(id) mapping — the same source
 * resolveNameId verifies against. A failed read leaves the username
 * empty (the UI shows "#id") rather than somebody else's name.
 */
const ownerTokensCache = new Map<string, Promise<NameToken[]>>();
export function tokensOf(owner: string): Promise<NameToken[]> {
  const key = owner.toLowerCase();
  if (!ownerTokensCache.has(key)) {
    const p = (async (): Promise<NameToken[]> => {
      try {
        const h = await ethCall(CAW_NAME, SEL.tokens + encAddr(owner));
        const toks = decTokensRet(h);
        await Promise.all(
          toks.map(async (t) => {
            try {
              const un = await withRetry(
                () => readStr(CAW_NAME, SEL.usernames + word(t.id)),
                2,
                400,
              );
              t.username = un || '';
            } catch {
              t.username = '';
            }
          }),
        );
        return toks;
      } catch {
        // Do not let one transient RPC failure poison the whole
        // session: drop the cache entry so the next call retries.
        ownerTokensCache.delete(key);
        return [];
      }
    })();
    ownerTokensCache.set(key, p);
  }
  return ownerTokensCache.get(key)!;
}
export function clearNameCaches(): void {
  ownerTokensCache.clear();
  nameCache.clear();
  avatarCache.clear();
}

const nameCache = new Map<bigint, Promise<string | null>>();
export function resolveName(idIn: bigint): Promise<string | null> {
  const id = BigInt(idIn);
  if (!nameCache.has(id)) {
    const p = (async (): Promise<string | null> => {
      let result: string | null = null;
      // The usernames(id) mapping is the authoritative name source
      // (tokens() pairs ids with shifted names — see tokensOf above).
      try {
        const n = await withRetry(
          () => readStr(CAW_NAME, SEL.usernames + word(id)),
          2,
          400,
        );
        if (n) result = n;
      } catch {
        /* fall through to the token list */
      }
      if (!result) {
        try {
          const owner = await readAddr(CAW_NAME, SEL.ownerOf + word(id));
          const toks = await tokensOf(owner);
          const hit = toks.find((t) => t.id === id);
          if (hit && hit.username) result = hit.username;
        } catch {
          /* fall through */
        }
      }
      // A miss caused by a transient read failure must not stick for
      // the whole session — evict so the next render retries.
      if (!result) nameCache.delete(id);
      return result;
    })();
    nameCache.set(id, p);
  }
  return nameCache.get(id)!;
}

export type ResolveResult =
  | { status: 'ok'; id: bigint; username: string }
  | { status: 'notfound' };

/**
 * Resolve a username to its token id, verified against the name list.
 * The QL1 name desk answers idByUsername(name) with tokenId + 1, so the
 * raw answer can never be trusted on its own: check the neighbours and
 * accept only the id whose stored name matches exactly. Returns
 * 'notfound' for a genuinely free/unknown name and THROWS when the reads
 * themselves failed (callers show a load error, never a false
 * "not found").
 */
export async function resolveNameId(rawName: string): Promise<ResolveResult> {
  const q = String(rawName || '').trim().toLowerCase();
  if (!q) return { status: 'notfound' };
  const id0 = await withRetry(() => readUint(MINTER, SEL.idByUsername + encStr(q)));
  if (id0 === 0n) return { status: 'notfound' };
  const cands = [id0 - 1n, id0, id0 + 1n].filter((c) => c >= 1n);
  let readFailed = false;
  for (const c of cands) {
    let uname: string | null = null;
    try {
      uname = await withRetry(
        () => readStr(CAW_NAME, SEL.usernames + word(c)),
        2,
        500,
      );
    } catch {
      readFailed = true;
    }
    if (uname === q) return { status: 'ok', id: c, username: uname };
  }
  if (readFailed) throw new Error('name lookup reads failed');
  return { status: 'notfound' };
}

/* ---------- avatars ---------- */
const avatarCache = new Map<bigint, Promise<string | null>>();
/** Avatar image for a name id (from its picture data), cached. */
export function avatarFor(idIn: bigint): Promise<string | null> {
  const id = BigInt(idIn);
  if (!avatarCache.has(id)) {
    const p = (async (): Promise<string | null> => {
      let result: string | null = null;
      try {
        const uri = await withRetry(
          () => readStr(CAW_NAME, SEL.tokenURI + word(id)),
          2,
          400,
        );
        if (uri.startsWith('data:application/json;base64,')) {
          const meta = JSON.parse(
            toUtf8String(decodeBase64(uri.split(',')[1])),
          );
          if (meta.image) {
            result = meta.image.startsWith('ipfs://')
              ? 'https://ipfs.io/ipfs/' + meta.image.slice(7)
              : meta.image;
          }
        } else if (uri.startsWith('http')) {
          result = uri;
        }
      } catch {
        /* no picture, or a transient failure */
      }
      // Same rule as names: a failure-driven null must not stick.
      if (!result) avatarCache.delete(id);
      return result;
    })();
    avatarCache.set(id, p);
  }
  return avatarCache.get(id)!;
}

/* ---------- balances & counts ---------- */
export async function walletBalances(
  address: string,
): Promise<{ qom: bigint; qcaw: bigint }> {
  const [qom, qcaw] = await Promise.all([
    rpc('eth_getBalance', [address, 'latest'])
      .then((h: string) => BigInt(h))
      .catch(() => 0n),
    readUint(QCAW, SEL.balanceOf + encAddr(address)).catch(() => 0n),
  ]);
  return { qom, qcaw };
}

export const followerCount = (id: bigint): Promise<bigint> =>
  readUint(CAW_ACTIONS, SEL.followerCount + word(id));

export const nameBalance = (id: bigint): Promise<bigint> =>
  readUint(CAW_NAME, SEL.cawBalanceOf + word(id));

export const likesCount = (a: CawAction): Promise<bigint> =>
  readUint(CAW_ACTIONS, SEL.likes + word(a.senderId) + strip(a.cawId));

export const nameOwner = (id: bigint): Promise<string> =>
  readAddr(CAW_NAME, SEL.ownerOf + word(id));

/* ---------- name check (for minting) ---------- */
export interface NameCheck {
  valid: boolean;
  taken: boolean;
  cost: bigint;
}
export async function checkName(name: string): Promise<NameCheck> {
  const enc = encStr(name);
  const [valid, res, cost] = await Promise.all([
    ethCall(MINTER, SEL.isValidUsername + enc).then(
      (h) => decUintRet(h) !== 0n,
    ),
    resolveNameId(name).catch(() => ({ status: 'error' as const })),
    readUint(MINTER, SEL.costOfName + enc),
  ]);
  if (valid && res.status === 'error') throw new Error('lookup failed');
  return { valid, taken: res.status === 'ok', cost };
}

export const qcawAllowance = (owner: string, spender: string): Promise<bigint> =>
  readUint(QCAW, SEL.allowance + encAddr(owner) + encAddr(spender)).catch(
    () => 0n,
  );
export const qcawBalance = (owner: string): Promise<bigint> =>
  readUint(QCAW, SEL.balanceOf + encAddr(owner)).catch(() => 0n);

/* ---------- timeline & profile posts (Blockscout) ---------- */
function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

/**
 * In-memory index of posts (type 0) seen while reading the feed, by
 * cawId. Like/share entries carry the target post's cawId, so this is
 * how their content gets found for display.
 */
const postIndex = new Map<string, TimelineItem>();

/** Optional hook: notified for every decoded action (used to seed the
 *  on-device "my actions" memory without a circular import). */
let actionObserver: ((a: CawAction) => void) | null = null;
export function setActionObserver(fn: ((a: CawAction) => void) | null): void {
  actionObserver = fn;
}

async function fetchActionPage(
  next: Record<string, unknown> | null,
): Promise<Page<TimelineItem>> {
  let url = API + '/addresses/' + CAW_ACTIONS + '/transactions';
  if (next) url += qs(next);
  const res = await fetch(url);
  if (!res.ok) throw new Error('api ' + res.status);
  const j = await res.json();
  const items: TimelineItem[] = [];
  for (const it of j.items || []) {
    if (!it.raw_input || (it.status && it.status !== 'ok')) continue;
    // A batch can carry several actions — render every one of them,
    // not just the first.
    for (const a of decodeActions(it.raw_input)) {
      const item: TimelineItem = { ...a, hash: it.hash, blockTs: it.timestamp };
      items.push(item);
      if (a.type === 0) postIndex.set(a.cawId.toLowerCase(), item);
      if (actionObserver) {
        try {
          actionObserver(a);
        } catch {
          /* the observer must never break the feed */
        }
      }
    }
  }
  return { items, next: j.next_page_params || null };
}

export const fetchTimelinePage = fetchActionPage;

/**
 * Find the original post for a cawId (the target of a like / share).
 * Checks everything the feed reads have already indexed, then scans
 * up to 12 fresh pages. Returns null when it cannot be found nearby —
 * the entry then simply shows without the quoted post.
 */
export async function findPostByCawId(
  cawId: string,
): Promise<TimelineItem | null> {
  const key = (cawId || '').toLowerCase();
  const hit = postIndex.get(key);
  if (hit) return hit;
  let cursor: Record<string, unknown> | null = null;
  for (let p = 0; p < 12; p++) {
    const page = await fetchActionPage(cursor);
    const h2 = postIndex.get(key);
    if (h2) return h2;
    cursor = page.next;
    if (!cursor) break;
  }
  return null;
}

/**
 * Up to 10 actions by one name. Almost every action on QL1 is
 * submitted by a relay address, so a profile cannot be read from the
 * owner's own transaction list — the contract feed itself has to be
 * scanned. The old budget of 4 pages (200 txs) found NOTHING for
 * less-active names (measured: name #189's first action sits on page
 * 21), so profiles looked empty. One call now scans up to 30 pages,
 * and "see more" continues from the returned cursor.
 */
export async function fetchProfilePosts(
  nameId: bigint,
  next: Record<string, unknown> | null,
): Promise<Page<TimelineItem> & { done: boolean }> {
  const found: TimelineItem[] = [];
  let cursor = next;
  let pages = 0;
  let done = false;
  while (found.length < 10 && pages < 30 && !done) {
    const page = await fetchActionPage(cursor);
    cursor = page.next;
    if (!cursor) done = true;
    pages++;
    for (const a of page.items) {
      if (a.senderId === nameId) found.push(a);
    }
  }
  return { items: found, next: cursor, done };
}

/** ISO timestamp of the day a name was made (first mint transfer), or null. */
export async function mintDateOf(id: bigint): Promise<string | null> {
  let url: string | null =
    API + '/tokens/' + CAW_NAME + '/instances/' + id.toString() + '/transfers';
  for (let page = 0; page < 8 && url; page++) {
    try {
      const res: Response = await fetch(url);
      if (!res.ok) return null;
      const j: any = await res.json();
      for (const it of j.items || []) {
        const from = (it.from && it.from.hash) || '';
        if (from.toLowerCase() === '0x0000000000000000000000000000000000000000') {
          return it.timestamp as string;
        }
      }
      url = j.next_page_params
        ? API +
          '/tokens/' +
          CAW_NAME +
          '/instances/' +
          id.toString() +
          '/transfers' +
          qs(j.next_page_params)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

export const txUrl = (hash: string): string => EXPLORER + '/tx/' + hash;
export const addressUrl = (addr: string): string =>
  EXPLORER + '/address/' + addr;
