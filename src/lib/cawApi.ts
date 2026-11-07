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
  decodeAction,
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
const ownerTokensCache = new Map<string, Promise<NameToken[]>>();
export function tokensOf(owner: string): Promise<NameToken[]> {
  const key = owner.toLowerCase();
  if (!ownerTokensCache.has(key)) {
    ownerTokensCache.set(
      key,
      ethCall(CAW_NAME, SEL.tokens + encAddr(owner))
        .then((h) => decTokensRet(h))
        .catch(() => []),
    );
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
    nameCache.set(
      id,
      (async () => {
        try {
          const owner = await readAddr(CAW_NAME, SEL.ownerOf + word(id));
          const toks = await tokensOf(owner);
          const hit = toks.find((t) => t.id === id);
          if (hit && hit.username) return hit.username;
        } catch {
          /* fall through */
        }
        try {
          const n = await readStr(CAW_NAME, SEL.usernames + word(id));
          if (n) return n;
        } catch {
          /* fall through */
        }
        return null;
      })(),
    );
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
    avatarCache.set(
      id,
      (async () => {
        try {
          const uri = await readStr(CAW_NAME, SEL.tokenURI + word(id));
          if (uri.startsWith('data:application/json;base64,')) {
            const meta = JSON.parse(
              toUtf8String(decodeBase64(uri.split(',')[1])),
            );
            if (meta.image) {
              return meta.image.startsWith('ipfs://')
                ? 'https://ipfs.io/ipfs/' + meta.image.slice(7)
                : meta.image;
            }
          } else if (uri.startsWith('http')) {
            return uri;
          }
        } catch {
          /* no picture */
        }
        return null;
      })(),
    );
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
    const a = decodeAction(it.raw_input);
    if (a) items.push({ ...a, hash: it.hash, blockTs: it.timestamp });
  }
  return { items, next: j.next_page_params || null };
}

export const fetchTimelinePage = fetchActionPage;

/** Up to 10 posts by one name, scanning up to 4 pages (same as web). */
export async function fetchProfilePosts(
  nameId: bigint,
  next: Record<string, unknown> | null,
): Promise<Page<TimelineItem> & { done: boolean }> {
  const found: TimelineItem[] = [];
  let cursor = next;
  let pages = 0;
  let done = false;
  while (found.length < 10 && pages < 4 && !done) {
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
