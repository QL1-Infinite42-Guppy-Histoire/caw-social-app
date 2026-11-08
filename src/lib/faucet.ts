/* ==================================================================
 * In-app faucet client (v0.4.1).
 *
 * Talks to the public faucet Worker the user already runs
 * (42-faucet). The faucet's own wallet sends the coins; the app
 * only ASKS for a claim for the app's wallet address — no keys
 * are involved on this side, and claims are never signed here.
 *
 * API (verified live 2026-11-08):
 *   GET  /status?chain=42|ql1&token=native|zap
 *        -> { ready, reason, faucetAddress, balance, claimsLeft,
 *             chain, token, symbol, claimAmount }
 *   POST /claim { chain, token, address }
 *        -> { ok:true, txHash, amount, explorerUrl }
 *         | { ok:false, code, retryAfterSec?, balance? }
 * Turnstile is disabled in the live deployment (empty site key,
 * no worker secret), so claims go without a token; the
 * turnstile_failed mapping below is the safety net.
 * ================================================================== */

export const FAUCET_BASE = 'https://42-faucet.nepicobsv.workers.dev';

export interface FaucetPool {
  chain: '42' | 'ql1';
  token: 'native' | 'zap';
  /** Display symbol of what the pool pays. */
  sym: string;
  /** Chain label for display. */
  chainLabel: string;
}

/** The three live pools: 0.05 [42], 10,000,000 QOM, 1 ZAP. */
export const FAUCET_POOLS: FaucetPool[] = [
  { chain: '42', token: 'native', sym: '42', chainLabel: '42 Chain' },
  { chain: 'ql1', token: 'native', sym: 'QOM', chainLabel: 'QL1' },
  { chain: '42', token: 'zap', sym: 'ZAP', chainLabel: '42 Chain' },
];

export interface FaucetStatus {
  ready: boolean;
  reason?: string;
  faucetAddress?: string;
  balance?: string;
  claimsLeft?: number;
  chain: string;
  token: string;
  symbol: string;
  claimAmount: string;
}

export interface ClaimOk {
  ok: true;
  txHash: string;
  amount: string;
  explorerUrl?: string;
}

export interface ClaimErr {
  ok: false;
  code: string;
  retryAfterSec?: number;
}

export type ClaimResult = ClaimOk | ClaimErr;

/** Minimal fetch surface so the harness can stub the Worker. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const defaultFetch: FetchLike = (url, init) =>
  fetch(url, init) as unknown as ReturnType<FetchLike>;

export async function fetchFaucetStatus(
  pool: FaucetPool,
  fetchImpl: FetchLike = defaultFetch,
): Promise<FaucetStatus | null> {
  try {
    const r = await fetchImpl(
      `${FAUCET_BASE}/status?chain=${pool.chain}&token=${pool.token}`,
    );
    if (!r.ok) return null;
    const j = (await r.json()) as FaucetStatus;
    return j && typeof j.claimAmount === 'string' ? j : null;
  } catch {
    return null;
  }
}

export async function claimFaucet(
  pool: FaucetPool,
  address: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ClaimResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let j: any = null;
  try {
    const r = await fetchImpl(`${FAUCET_BASE}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chain: pool.chain,
        token: pool.token,
        address,
      }),
    });
    j = (await r.json().catch(() => null)) as typeof j;
  } catch {
    /* the request itself failed: the screen shows the network
       message (code 'network'), distinct from every worker code */
    return { ok: false, code: 'network' };
  }
  if (j && j.ok === true) {
    return {
      ok: true,
      txHash: typeof j.txHash === 'string' ? j.txHash : '',
      amount: typeof j.amount === 'string' ? j.amount : '',
      explorerUrl:
        typeof j.explorerUrl === 'string' ? j.explorerUrl : undefined,
    };
  }
  return {
    ok: false,
    code: typeof j?.code === 'string' ? j.code : 'failed',
    retryAfterSec:
      typeof j?.retryAfterSec === 'number' ? j.retryAfterSec : undefined,
  };
}

/* ---------------- error taxonomy ----------------------------------
 * EVERY worker rejection code maps to its own plain-language
 * message key — never the generic failure text. Unlisted codes
 * fall back to 'faucet.err.failed' (a claim-specific message,
 * still not the app-wide generic). */

export const FAUCET_ERROR_CODES = [
  'address_cooldown',
  'ip_cooldown',
  'daily_limit',
  'balance_too_high',
  'faucet_low',
  'not_ready',
  'rpc_error',
  'send_failed',
  'invalid_address',
  'turnstile_failed',
] as const;

export function faucetErrorKey(code: string): string {
  return (FAUCET_ERROR_CODES as readonly string[]).includes(code)
    ? `faucet.err.${code}`
    : 'faucet.err.failed';
}

/** Codes whose message carries a "try again {t}" suffix built
 *  from retryAfterSec. */
export function isCooldownCode(code: string): boolean {
  return code === 'address_cooldown' || code === 'ip_cooldown';
}

/** Bucket a retry-after duration for the plain-language suffix:
 *  the address cooldown runs up to 7 days, the IP one 24h. */
export function retryParts(sec: number): {
  unit: 'days' | 'hours' | 'minutes';
  n: number;
} {
  const s = Math.max(0, Math.floor(sec));
  if (s >= 36 * 3600) return { unit: 'days', n: Math.ceil(s / 86400) };
  if (s >= 90 * 60) return { unit: 'hours', n: Math.ceil(s / 3600) };
  return { unit: 'minutes', n: Math.max(1, Math.ceil(s / 60)) };
}
