/**
 * HuntersSwap core logic (v0.3.0) — Expo-free so the Node harness
 * exercises the exact code the app runs.
 *
 * Two halves:
 *  - Entry legs (BSC / Ethereum): Uniswap-V2-family native->USDT
 *    swaps and Zaphod/Hyperlane bridge sends to 42 Chain, ported
 *    from GuppyWallet (lib/bscSwap.ts, lib/zaphod.ts
 *    bridgeInboundSendJob / fetchBridgeQuote / truncateToDstDecimals).
 *  - Back half (42 USDT -> QL1 CAW): quotes come from the ported
 *    aggregator engine (lib/aggEngine.ts); this module adds the
 *    [42] carve-out math and the entry-side rules.
 *
 * Nothing here signs or sends: builders return {to, data, value}
 * and the screen sends them through the app's auth pattern.
 */
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  formatUnits,
  parseUnits,
  zeroPadValue,
  getAddress,
} from 'ethers';

import {
  BRIDGE_IN_FEE_USDT,
  BRIDGE_IN_USDT,
  BRIDGE_NATIVE_FEE_42_FALLBACK,
  BSC_GAS_KEEP_USD,
  CARVE_GAS_MARGIN_42,
  DOMAIN_42,
  ENTRY_DEX,
  ETH_MIN_ENTRY_USD,
  HS_CHAINS,
  USDT_ON,
  BRIDGE_OUT_USDT_42,
  TARGET_DOMAIN,
  type EntryKey,
  type HsChainKey,
} from './chains';
import {
  CHAINS as AGG_CHAINS,
  BRIDGE_PAIRS,
  addCustomToken,
  buildApproveTx as aggBuildApproveTx,
  buildBridgeTx as aggBuildBridgeTx,
  buildSwapTx as aggBuildSwapTx,
  tokenByAddress as aggTokenByAddress,
  evaluateCrossSplit,
  evaluateCrossSplitNet,
  fetchBestRoute,
  fetchBridgeNativeQuote,
  fetchQuotesForTokens,
  quoteCrossPlan,
  tokenById,
} from './aggEngine';
import type { FlowPart, HuntersFlow } from './flows';

export const ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
] as const;

export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
] as const;

export const BRIDGE_ROUTER_ABI = [
  'function quoteBridge(uint256 amount) view returns (uint256 forwardAmount, uint256 fee, uint256 totalRequired)',
  'function quoteNative(uint32 destination, bytes options) view returns (uint256 nativeFee, uint256 nativeFeeWithRef, uint256 totalNative)',
  'function transferRemote(uint32 destination, bytes32 recipient, uint256 amount) payable returns (bytes32 messageId)',
] as const;

export const SEL = {
  swapExactETHForTokens: '0x7ff36ab5',
  approve: '0x095ea7b3',
  transferRemote: '0x81b4e8b4',
} as const;

/* ---------------- providers / signers ---------------- */

const providers = new Map<HsChainKey, JsonRpcProvider>();
export function providerFor(key: HsChainKey): JsonRpcProvider {
  let p = providers.get(key);
  if (!p) {
    const def = HS_CHAINS[key];
    p = new JsonRpcProvider(def.rpcs[0], def.chainId, {
      staticNetwork: true,
    });
    providers.set(key, p);
  }
  return p;
}

export function signerForChain(privateKey: string, key: HsChainKey): Wallet {
  return new Wallet(privateKey, providerFor(key));
}

/* ---------------- transient-failure retry (v0.3.2) ---------------- */

const sleepMs = (ms: number) =>
  new Promise((r) => setTimeout(r, ms));

/** True for transport-level failures (network down, timeout, 5xx,
 *  rate limit). Reverts (CALL_EXCEPTION) are NOT network-ish: they
 *  are answers, and retrying them would just waste time. */
export function isNetworkishError(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (err?.code === 'CALL_EXCEPTION') return false;
  if (err?.code === 'NETWORK_ERROR' || err?.code === 'TIMEOUT') return true;
  const m = String(err?.message ?? e ?? '');
  return /fetch failed|network|timeout|timed out|socket|econn|enotfound|eai_again|http 5\d\d|status 5\d\d|rate limit|too many requests/i.test(
    m,
  );
}

/** Run a read-only call with 2 retries (short backoff) when it
 *  fails with a network-ish error. Anything else throws at once. */
export async function withRpcRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isNetworkishError(e) || attempt === 2) throw e;
      await sleepMs(300 * (attempt + 1));
    }
  }
  throw last;
}

export interface TxReq {
  to: string;
  data: string;
  value: bigint;
}

/* ---------------- robust tx confirmation (v0.4.1) ---------------
 * The v0.4.0 send path confirmed a broadcast with ethers'
 * tx.wait() on ONE RPC endpoint. When that endpoint hiccuped
 * during polling, wait() threw even though the transaction had
 * already been mined — the step was reported as a failure while
 * the swap had actually succeeded (user incident 2026-11-08:
 * BSC swap 0x7b5ac1… landed, app showed 「うまくいきませんでした」).
 * The replacement below polls getTransactionReceipt across ALL
 * of the chain's endpoints with backoff for a generous window,
 * and separates the three outcomes: confirmed / reverted /
 * unconfirmed. An unconfirmed tx is NEVER reported as a plain
 * failure — it may well have succeeded on-chain. */

const rpcProviders = new Map<string, JsonRpcProvider>();

/** Provider for one specific RPC endpoint of a chain (cached). */
export function providerForRpc(key: HsChainKey, url: string): JsonRpcProvider {
  const id = key + '|' + url;
  let p = rpcProviders.get(id);
  if (!p) {
    p = new JsonRpcProvider(url, HS_CHAINS[key].chainId, {
      staticNetwork: true,
    });
    rpcProviders.set(id, p);
  }
  return p;
}

/** One provider per configured endpoint of the chain. */
export function providersFor(key: HsChainKey): JsonRpcProvider[] {
  return HS_CHAINS[key].rpcs.map((u) => providerForRpc(key, u));
}

/** The HuntersSwap chain a provider belongs to, when it is the
 *  shared providerFor() instance (null for any other provider). */
export function chainOfProvider(p: unknown): HsChainKey | null {
  for (const k of Object.keys(HS_CHAINS) as HsChainKey[]) {
    if (providerFor(k) === p) return k;
  }
  return null;
}

export interface ReceiptLike {
  status: number;
}

export interface ConfirmOpts {
  /** Total polling window before giving up (default 90 s). */
  windowMs?: number;
  /** First pause between sweeps; grows x1.5 up to maxDelayMs. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Poll receipt fetchers (one per RPC endpoint) until one returns
 * a receipt. A fetcher throwing is an endpoint hiccup, never a
 * verdict — the sweep moves on to the next endpoint. Returns
 * null when the whole window passes with no receipt anywhere.
 */
export async function confirmReceipt(
  fetchers: Array<() => Promise<ReceiptLike | null>>,
  opts: ConfirmOpts = {},
): Promise<ReceiptLike | null> {
  const windowMs = opts.windowMs ?? 90000;
  const sleep = opts.sleep ?? sleepMs;
  const now = opts.now ?? Date.now;
  const start = now();
  let delay = opts.initialDelayMs ?? 1500;
  const maxDelay = opts.maxDelayMs ?? 6000;
  for (;;) {
    for (const f of fetchers) {
      try {
        const r = await f();
        if (r) return r;
      } catch {
        /* endpoint hiccup: try the next one */
      }
    }
    if (now() - start >= windowMs) return null;
    await sleep(delay);
    delay = Math.min(maxDelay, Math.round(delay * 1.5));
    if (now() - start >= windowMs) return null;
  }
}

/** Receipt wait with RPC failover across the chain's endpoints. */
export async function waitForReceiptRobust(
  chain: HsChainKey,
  hash: string,
  opts: ConfirmOpts = {},
): Promise<ReceiptLike | null> {
  const fetchers = providersFor(chain).map(
    (p) => async (): Promise<ReceiptLike | null> => {
      const r = await p.getTransactionReceipt(hash);
      return r && r.status != null ? { status: Number(r.status) } : null;
    },
  );
  return confirmReceipt(fetchers, opts);
}

/** The tx was broadcast (we hold its hash) but no receipt could
 *  be obtained inside the window. It MAY have succeeded — the
 *  UI must say exactly that, never the plain failure text. */
export class TxUnconfirmedError extends Error {
  readonly hash: string;
  constructor(hash: string) {
    super('tx-unconfirmed');
    this.name = 'TxUnconfirmedError';
    this.hash = hash;
  }
}

/** The tx was mined and reverted (receipt status 0). */
export class TxRevertedError extends Error {
  readonly hash: string;
  constructor(hash: string) {
    super('tx-reverted');
    this.name = 'TxRevertedError';
    this.hash = hash;
  }
}

export interface StepSendDeps {
  /** Broadcast the request; resolves with the tx hash. */
  broadcast: () => Promise<string>;
  /** Confirm a broadcast tx; resolves null when unconfirmable. */
  confirm: (hash: string) => Promise<ReceiptLike | null>;
}

/**
 * The one composition every guided-flow send goes through:
 * broadcast, then confirm. Resolves with the hash ONLY on a
 * status-1 receipt; throws TxUnconfirmedError when no receipt
 * could be obtained and TxRevertedError on a status-0 receipt.
 * Nothing here can turn a mined success into a reported failure.
 */
export async function executeStepSend(deps: StepSendDeps): Promise<string> {
  const hash = await deps.broadcast();
  const receipt = await deps.confirm(hash);
  if (!receipt) throw new TxUnconfirmedError(hash);
  if (receipt.status !== 1) throw new TxRevertedError(hash);
  return hash;
}

/* ---------------- execution error taxonomy (v0.4.1) --------------
 * Standing policy: insufficient balance / network-RPC / no-route
 * / price-moved / unconfirmed are DIFFERENT user-facing messages.
 * sendStep classifies whatever a step threw through here. */

export type StepErrorKind =
  | 'price-moved'
  | 'no-route'
  | 'insufficient'
  | 'unconfirmed'
  | 'reverted'
  | 'network'
  | 'failed';

export function classifyStepError(e: unknown): StepErrorKind {
  const err = e as { code?: string; message?: string } | null;
  const msg = err?.message ?? '';
  if (msg === 'price-moved') return 'price-moved';
  if (msg === 'no-route') return 'no-route';
  if (msg === 'insufficient') return 'insufficient';
  if (msg === 'tx-unconfirmed' || e instanceof TxUnconfirmedError) {
    return 'unconfirmed';
  }
  if (
    msg === 'tx-reverted' ||
    e instanceof TxRevertedError ||
    msg.startsWith('transaction failed on chain')
  ) {
    return 'reverted';
  }
  if (err?.code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(msg)) {
    return 'insufficient';
  }
  if (isNetworkishError(e)) return 'network';
  return 'failed';
}

/** i18n key for a classified step error. 'reverted' keeps the
 *  plain failure text — a revert really did fail and the coins
 *  (minus gas) stayed put, which is what hs.failed says. */
export function stepErrorKey(kind: StepErrorKind): string {
  switch (kind) {
    case 'price-moved':
      return 'hs.priceMoved';
    case 'no-route':
      return 'hs.noRoute';
    case 'insufficient':
      return 'hs.notEnough';
    case 'unconfirmed':
      return 'hs.unconfirmed';
    case 'network':
      return 'hs.netFailed';
    default:
      return 'hs.failed';
  }
}

/* ---------------- resume / step-data logic (v0.4.1) --------------
 * The resume bug (user report 2026-11-08): a saved buy flow
 * pointed at the entry-swap step even though that swap had
 * already succeeded on-chain, and the step screen offered a
 * bare title + enabled Next with nothing rebuilt — pressing
 * Next re-ran the swap against a gas-keep-only balance and
 * died in the generic error. The decisions below are pure and
 * value-driven so the harness can walk the exact user journey;
 * the screen feeds them FRESH balance reads, never saved ones. */

export interface EntryFlowLike {
  phase: string;
  /** Native amount the entry swap sends (string, 18 dec). */
  entryAmountRaw: string;
  /** USDT the entry swap was expected to make (string). */
  entryUsdtExpected: string;
  /** Entry-chain USDT balance before the entry swap (string). */
  entryUsdtBefore?: string;
}

function safeBig(v: string | undefined): bigint {
  try {
    return BigInt(v ?? '0');
  } catch {
    return 0n;
  }
}

/**
 * Evidence that the entry swap already landed: the entry chain's
 * USDT balance grew by (nearly) the expected swap output since
 * the flow started. The send path price-checks the fresh quote
 * against the confirmed expectation at 1%, so a real execution
 * lands within a few percent of expected; 80% is a line quote
 * drift cannot cross, while a partial/absent swap cannot reach
 * it. Measured from ACTUAL balances at resume time.
 */
export function entrySwapArrived(
  flow: EntryFlowLike,
  usdtNow: bigint,
): boolean {
  const arrived = usdtNow - safeBig(flow.entryUsdtBefore);
  if (arrived <= 0n) return false;
  const expected = safeBig(flow.entryUsdtExpected);
  if (expected <= 0n) return true;
  return arrived * 100n >= expected * 80n;
}

export type EntrySwapGuard = 'proceed' | 'already-done' | 'insufficient';

/**
 * Execution-time guard for the entry swap (defense in depth —
 * the same decision runs at resume and again right before any
 * broadcast): when the balance evidence says the swap already
 * ran, the answer is 'already-done' and NO second swap may be
 * attempted; when the native balance cannot fund the amount,
 * the answer is the typed 'insufficient', not a send that dies
 * inside ethers with the generic error.
 */
export function entrySwapGuard(
  flow: EntryFlowLike,
  nativeNow: bigint,
  usdtNow: bigint,
): EntrySwapGuard {
  if (entrySwapArrived(flow, usdtNow)) return 'already-done';
  const amt = safeBig(flow.entryAmountRaw);
  if (amt <= 0n) return 'insufficient';
  if (nativeNow < amt) return 'insufficient';
  return 'proceed';
}

/**
 * The step's data is valid and its Next may be enabled: a real
 * amount AND a live quote fetched for this step. A step holding
 * neither must never offer an enabled Next.
 */
export function entryStepReady(
  flow: EntryFlowLike,
  quoteOut: bigint | null,
): boolean {
  return safeBig(flow.entryAmountRaw) > 0n && quoteOut !== null && quoteOut > 0n;
}

/**
 * Resume decision for a saved buy flow sitting on its entry
 * swap: when the balance evidence says the swap already landed,
 * the resumed flow is the SAME flow advanced to the bridge step
 * (whose amounts prepareEntryBridge measures from the actual
 * USDT balance) — "where the user stopped" IS the next step.
 * Returns null when the swap still has to run.
 */
export function resumeEntryAdvance(
  flow: HuntersFlow,
  usdtNow: bigint,
): HuntersFlow | null {
  if (flow.phase !== 'entrySwap') return null;
  if (!entrySwapArrived(flow, usdtNow)) return null;
  return { ...flow, phase: 'entryBridge' };
}

/* ---------------- USDT start / arrival coin (v0.4.1) -------------
 * Buy flows may start from USDT the user already holds on the
 * entry chain (skipping the native->USDT swap entirely), and
 * sell flows may end with the USDT as-is instead of converting
 * it to the native coin. Both directions spend the native coin
 * ONLY as gas, so a missing gas coin is a pre-flight fact with
 * its own plain message — checked before any execution. */

/** Gas units budgeted for a USDT-start entry: an approve
 *  (~50k, only when needed) plus the bridge send (~200k on
 *  these routers), with margin. */
export const USDT_START_GAS_UNITS = 300000n;

/** Pure pre-flight: can this native balance pay the gas a
 *  USDT start needs at this gas price? */
export function usdtStartGasOk(
  nativeNow: bigint,
  gasPriceWei: bigint,
): boolean {
  if (nativeNow <= 0n) return false;
  if (gasPriceWei <= 0n) return true;
  return nativeNow >= gasPriceWei * USDT_START_GAS_UNITS;
}

/** Live pre-flight for a USDT start; null when the fee data
 *  cannot be read (unknown — execution then surfaces the real
 *  error through the step taxonomy instead of a guessed gate). */
export async function fetchUsdtStartGasOk(
  entry: EntryKey,
  owner: string,
): Promise<boolean | null> {
  try {
    const [bal, fee] = await Promise.all([
      arrivalBalance(entry, null, owner),
      providerFor(entry).getFeeData(),
    ]);
    const gp = fee.maxFeePerGas ?? fee.gasPrice;
    if (gp === null || gp === undefined) return null;
    return usdtStartGasOk(bal, BigInt(gp));
  } catch {
    return null;
  }
}

/* ---------------- QL1 gas reality (v0.4.1) -----------------------
 * QL1 steps are paid in NATIVE QOM. QOM that arrived over the
 * bridge is WQOM — an ERC-20 — and WQOM does NOT pay gas, so a
 * user can "have QOM" and still be unable to move anything.
 * When the native balance cannot cover the step's gas (the
 * same measured per-swap figure the confirm screens estimate
 * with), the step must stop BEFORE any send with the dedicated
 * faucet guidance — never the generic failure text. */

/** Pure check: is this native QOM balance short for one QL1
 *  swap at the measured per-swap gas? */
export function ql1GasShort(
  nativeQom: bigint,
  gasQomPerSwap: bigint,
): boolean {
  return nativeQom < gasQomPerSwap;
}

/** Live check; null when the balance or the gas estimate
 *  cannot be read (unknown — the step then proceeds and any
 *  real failure surfaces through the step taxonomy). */
export async function fetchQl1GasShort(owner: string): Promise<boolean | null> {
  try {
    const [bal, est] = await Promise.all([
      arrivalBalance('ql1', null, owner),
      quoteGasEstimates(),
    ]);
    if (!est) return null;
    return ql1GasShort(bal, est.gasQomPerSwap);
  } catch {
    return null;
  }
}

/* ---------------- QL1 gas keep (v0.4.2) ------------------------
 * THE app's single QL1 gas basis. SNS sends (posts, likes,
 * Recaws, follows — each a CawActions processAction) and
 * HuntersDEX sends draw on the SAME native QOM balance, so
 * there is exactly one reserve definition, defined here and
 * used by DEX planning, mid-starts, resumes, execution
 * re-checks and the faucet-guidance judgment alike:
 *
 *   keep = 100 SNS actions + 10 swap-class ops, + 10% margin
 *
 * Measured on the live chain (2026-11-08, gas price
 * 18 QOM/gas — QL1's floor):
 *   processAction: 106,316–136,258 gasUsed over 15 sampled
 *     real txs (fees 1.91M–2.45M QOM) → unit 150,000 gas
 *     (heaviest sample + ~10% headroom)
 *   swap-class op: swapExactTokensForTokens 183,917 gas,
 *     bridge transferRemote 233,913 gas, approve ~46,900 →
 *     unit 250,000 gas (the same per-swap unit
 *     quoteGasEstimates has always modelled)
 *   unwrap (WQOM.withdraw): 36,042 gas by estimateGas
 * Keep in gas: (150,000×100 + 250,000×10) × 1.10 margin
 *   = 19,250,000 gas → 346,500,000 QOM at 18 QOM/gas.
 * The reserve is held in NATIVE QOM (WQOM does not pay
 * gas). DEX steps whose working funds are WQOM secure the
 * keep FIRST by unwrapping exactly the shortfall, and only
 * the surplus over the secured keep is spendable principal;
 * a plan that cannot secure the keep stops at the faucet
 * guidance — never a partial execution, never principal
 * planned against the reserve. */
export const QL1_ACTION_GAS_UNITS = 150000n;
export const QL1_SWAP_GAS_UNITS = 250000n;
export const QL1_KEEP_ACTIONS = 100n;
export const QL1_KEEP_SWAP_OPS = 10n;
/** Unwrap gas budget: measured 36,042, with margin. */
export const QL1_UNWRAP_GAS_UNITS = 50000n;
export const QL1_KEEP_GAS_UNITS =
  ((QL1_ACTION_GAS_UNITS * QL1_KEEP_ACTIONS +
    QL1_SWAP_GAS_UNITS * QL1_KEEP_SWAP_OPS) *
    110n) /
  100n;
/** Measured QL1 gas-price floor (wei per gas): 18 QOM. */
export const QL1_GAS_PRICE_FLOOR = 18n * 10n ** 18n;
/** Keep at the floor price: 346,500,000 QOM in wei. Used
 *  when live fee data cannot be read. */
export const QL1_GAS_KEEP_FLOOR_WEI = QL1_KEEP_GAS_UNITS * QL1_GAS_PRICE_FLOOR;

/** The keep in wei at a given gas price (wei/gas). */
export function ql1GasKeepWei(gasPriceWei: bigint): bigint {
  return gasPriceWei * QL1_KEEP_GAS_UNITS;
}

export interface Ql1KeepPlan {
  /** ok: keep already secured natively (or nothing to secure
   *  against); unwrap: unwrap `unwrapWei` of WQOM first, then
   *  `spendableWei` is quotable; faucet: the keep cannot be
   *  secured — the unwrap itself is unpayable (native balance
   *  below the unwrap's gas, incl. zero) — stop at the faucet
   *  guidance, do not execute partially. */
  action: 'ok' | 'unwrap' | 'faucet';
  keepWei: bigint;
  unwrapWei: bigint;
  /** WQOM principal that may be planned/spent AFTER the keep
   *  is secured. Never includes the reserve. */
  spendableWei: bigint;
  /** The fresh balances the plan was decided from. */
  nativeWei: bigint;
  wqomWei: bigint;
}

/** NATIVE QOM principal that may be planned/spent: the part
 *  of the native balance ABOVE the keep. The keep itself is
 *  never spendable principal — a native-QOM start or step
 *  plans against this and nothing else. (When the plan's
 *  action is 'unwrap' the native balance is below the keep
 *  by construction, so this is 0 until the keep is secured —
 *  and securing it brings native to exactly the keep, still
 *  0 spendable; the WQOM side is the spendable side then.) */
export function ql1NativeSpendableWei(plan: Ql1KeepPlan): bigint {
  return plan.nativeWei > plan.keepWei
    ? plan.nativeWei - plan.keepWei
    : 0n;
}

/** Pure keep decision for a step whose working funds are
 *  WQOM, from fresh balances. */
export function ql1KeepPlan(
  nativeNow: bigint,
  wqomNow: bigint,
  keepWei: bigint,
  unwrapCostWei: bigint,
): Ql1KeepPlan {
  if (keepWei <= 0n) {
    return {
      action: 'ok',
      keepWei,
      unwrapWei: 0n,
      spendableWei: wqomNow,
      nativeWei: nativeNow,
      wqomWei: wqomNow,
    };
  }
  const shortfall = keepWei - nativeNow;
  if (shortfall <= 0n) {
    return {
      action: 'ok',
      keepWei,
      unwrapWei: 0n,
      spendableWei: wqomNow,
      nativeWei: nativeNow,
      wqomWei: wqomNow,
    };
  }
  if (nativeNow < unwrapCostWei) {
    /* The bootstrap problem, honestly: securing the keep
     * needs an unwrap, the unwrap is itself a QL1 send, and
     * the native balance cannot pay for it. The faucet is
     * the way out (it hands out native QOM) — no relayer is
     * invented here. */
    return {
      action: 'faucet',
      keepWei,
      unwrapWei: 0n,
      spendableWei: 0n,
      nativeWei: nativeNow,
      wqomWei: wqomNow,
    };
  }
  const unwrapWei = shortfall < wqomNow ? shortfall : wqomNow;
  return {
    action: unwrapWei > 0n ? 'unwrap' : 'ok',
    keepWei,
    unwrapWei,
    spendableWei: wqomNow - unwrapWei,
    nativeWei: nativeNow,
    wqomWei: wqomNow,
  };
}

/** Live keep plan for the wallet's QL1 position; null when
 *  the balances or fee data cannot be read (callers fall
 *  back to the pre-keep gas gate rather than guessing). */
export async function fetchQl1KeepPlan(owner: string): Promise<Ql1KeepPlan | null> {
  try {
    const [nativeNow, wqomNow, fee] = await Promise.all([
      arrivalBalance('ql1', null, owner),
      erc20Balance('ql1', WQOM_ADDR, owner),
      providerFor('ql1').getFeeData(),
    ]);
    const gp = fee.gasPrice ?? fee.maxFeePerGas;
    if (gp === null || gp === undefined) return null;
    const gasPrice = BigInt(gp);
    return ql1KeepPlan(
      nativeNow,
      wqomNow,
      ql1GasKeepWei(gasPrice),
      gasPrice * QL1_UNWRAP_GAS_UNITS,
    );
  } catch {
    return null;
  }
}

/** WQOM.withdraw(amount): unwrap WQOM back to native QOM.
 *  Selector 0x2e1a7d4d (verified live by estimateGas from a
 *  real holder, 2026-11-08: 36,042 gas). */
export function buildUnwrapTx(amount: bigint): BuiltTx {
  return {
    to: WQOM_ADDR,
    data: '0x2e1a7d4d' + amount.toString(16).padStart(64, '0'),
    value: 0n,
  };
}

/* ============================================================
 * v0.4.3 — the QL1 finishing batch.
 *
 * What v0.4.2 did wrong (on-device, 2026-11-08 11:16–11:18
 * JST): the QL1 swap step offered the gas-securing unwrap as
 * a STANDALONE sheet action that unwrapped only the keep
 * shortfall (ql1KeepPlan). The withdraw's own gas is paid
 * from the same native balance the gate measures, so after
 * the unwrap landed, native sat at (keep − one withdraw's
 * gas) — the plan still reported a shortfall, the sheet
 * re-fired, and the user unwrapped THREE times in shrinking
 * amounts without ever reaching the swap. A gate that
 * re-measures after its own remedy can never converge.
 *
 * The batch below removes the mechanism: when a QL1 swap
 * step executes, the whole finishing sequence — one unwrap
 * of the step's FULL working amount (when the input sits in
 * the wrapped native), any missing approval, and the swap —
 * runs as ONE sequence under the step's single confirmation,
 * with per-leg sub-statuses. Planning happens once from
 * fresh balances; resume re-plans from fresh balances and
 * the persisted converted amount, so an interrupted batch
 * re-enters with the unwrap already credited and never
 * plans a second one for the same step. Everything here is
 * token-generic: the native-vs-wrapped distinction is a
 * registry property (the QL1 token entry whose address is
 * the chain's native anchor), never a symbol comparison.
 * ============================================================ */

/** True when `tok` is the wrapped form of its chain's
 *  native asset: its address is the chain's native anchor
 *  and the entry is not the native pseudo-entry itself.
 *  Registry-derived — adding any token never needs a branch
 *  here; only an entry whose address IS the anchor matches. */
export function isWrappedNativeToken(
  chainKey: 'infinite' | 'ql1',
  tok: { address: string; isNative?: boolean } | null | undefined,
): boolean {
  if (!tok || tok.isNative) return false;
  const anchor = (AGG_CHAINS[chainKey] as any)?.nativeAnchor;
  return (
    typeof anchor === 'string' &&
    tok.address.toLowerCase() === String(anchor).toLowerCase()
  );
}

export interface Ql1InputFacts {
  /** 'nativeAsset': the part's funds ARE the chain's native
   *  asset (delivered wrapped, held natively, or a mix after
   *  a partial batch) — the gas keep carves out of them.
   *  'token': an ordinary ERC-20; the keep does not apply. */
  kind: 'nativeAsset' | 'token';
  /** Balance address of the delivered form (the WQOM
   *  contract for the native asset). */
  tokenAddr: string;
  decimals: number;
  /** Agg registry entry for tx building; null when the
   *  input is spent natively from the start. */
  aggToken: any | null;
  pair: (typeof BRIDGE_PAIRS)[number] | null;
}

/** Resolve what a step-3 part's input actually is, purely
 *  from the registries and the part's own carried facts —
 *  no symbol branches. Sources, in order: a native-QOM
 *  direct start (srcNativeQom), a held-token direct start
 *  (ql1TokenAddr, re-registered into the aggregator on a
 *  cold start so routing resolves), then the bridge-pair
 *  registry. Returns null when nothing identifies the part
 *  (corrupt/legacy state) — the caller shows the network
 *  guidance rather than guessing. */
export function resolveQl1Input(part: FlowPart): Ql1InputFacts | null {
  if (part.srcNativeQom) {
    return {
      kind: 'nativeAsset',
      tokenAddr: WQOM_ADDR,
      decimals: 18,
      aggToken: null,
      pair: null,
    };
  }
  if (part.ql1TokenAddr) {
    const addr = part.ql1TokenAddr.toLowerCase();
    let tok = aggTokenByAddress('ql1', addr);
    if (!tok) {
      tok = addCustomToken('ql1', {
        address: addr,
        symbol: part.sym,
        decimals: part.ql1TokenDec ?? 18,
      });
    }
    if (!tok) return null;
    return {
      kind: isWrappedNativeToken('ql1', tok) ? 'nativeAsset' : 'token',
      tokenAddr: addr,
      decimals: part.ql1TokenDec ?? tok.decimals ?? 18,
      aggToken: tok,
      pair: null,
    };
  }
  const pair = BRIDGE_PAIRS.find((p) => p.sym === part.sym);
  if (!pair) return null;
  const tok = tokenById('ql1', pair.ql1Id);
  if (!tok) return null;
  return {
    kind: isWrappedNativeToken('ql1', tok) ? 'nativeAsset' : 'token',
    tokenAddr: tok.address.toLowerCase(),
    decimals: tok.decimals ?? 18,
    aggToken: tok,
    pair,
  };
}

export type Ql1FinishLeg =
  | { kind: 'unwrap'; amount: bigint }
  | { kind: 'approve'; token: string; amount: bigint }
  | { kind: 'swap'; spendNative: boolean };

export interface Ql1FinishPlan {
  /** 'run': legs + swapInput are decided. 'faucet': gas
   *  cannot be secured from what the wallet holds — the
   *  caller shows the faucet guidance. 'blocked': nothing
   *  swappable exists under the keep rules. */
  action: 'run' | 'faucet' | 'blocked';
  swapInput: bigint;
  legs: Ql1FinishLeg[];
  keepWei: bigint;
}

export interface Ql1FinishArgs {
  kind: 'nativeAsset' | 'token';
  /** nativeAsset delivered-total semantics (bridged parts):
   *  the total this step controls; the keep is carved out
   *  of it. Ignored for direct starts (fixedInputWei set). */
  fundsWei: bigint;
  /** Direct starts: the swap input the user chose; the keep
   *  is secured ON TOP of it from the remaining token
   *  balance. */
  fixedInputWei?: bigint;
  /** Amount of this step's funds already in native form
   *  because the batch unwrapped them (persisted on the
   *  part). For a native direct start, pass fundsWei. */
  convertedWei: bigint;
  nativeNow: bigint;
  /** Balance of the delivered form (wrapped / ERC-20). */
  tokenNow: bigint;
  /** Token kind: current allowance to the QL1 router. */
  allowanceNow: bigint;
  tokenAddr: string;
  keepWei: bigint;
  unwrapCostWei: bigint;
  swapGasCostWei: bigint;
}

/**
 * Plan ONE QL1 finishing batch from fresh balances. Pure.
 *
 * Native-asset accounting (all in native units):
 *  - `still`   = the part's funds still in wrapped form the
 *    batch may touch: for a delivered total, the unconsumed
 *    remainder of the delivery; for a direct start, the
 *    chosen input plus the CURRENT keep shortfall (nothing
 *    more of the user's pile is ever pulled in).
 *  - `outside` = native balance NOT belonging to this part
 *    (nativeNow minus what the batch already converted);
 *    the keep is charged against it first — keepShare is
 *    only what the part itself must still set aside.
 *  - swapInput = min(partTotal − keepShare, nativeNow +
 *    still − keep): the keep is never swapped, by
 *    construction, in every plan.
 *  - the unwrap leg, when the input cannot be funded
 *    natively, converts ALL of `still` in a single withdraw
 *    — never a shortfall-only amount (that was v0.4.2's
 *    converging-loop bug).
 */
export function ql1FinishPlan(a: Ql1FinishArgs): Ql1FinishPlan {
  const K = a.keepWei;
  const nonNeg = (x: bigint) => (x > 0n ? x : 0n);
  if (a.kind === 'token') {
    const input = a.fundsWei < a.tokenNow ? a.fundsWei : a.tokenNow;
    if (input <= 0n) return { action: 'blocked', swapInput: 0n, legs: [], keepWei: K };
    if (a.nativeNow < a.swapGasCostWei) {
      return { action: 'faucet', swapInput: 0n, legs: [], keepWei: K };
    }
    const legs: Ql1FinishLeg[] = [];
    if (a.allowanceNow < input) {
      legs.push({ kind: 'approve', token: a.tokenAddr, amount: input });
    }
    legs.push({ kind: 'swap', spendNative: false });
    return { action: 'run', swapInput: input, legs, keepWei: K };
  }
  /* nativeAsset */
  const fixed = a.fixedInputWei;
  let still: bigint;
  if (fixed !== undefined) {
    const shortfall = nonNeg(K - a.nativeNow);
    const want = fixed + shortfall;
    still = a.tokenNow < want ? a.tokenNow : want;
  } else {
    const remaining = nonNeg(a.fundsWei - a.convertedWei);
    still = a.tokenNow < remaining ? a.tokenNow : remaining;
  }
  const partTotal = a.convertedWei + still;
  const outside = nonNeg(a.nativeNow - a.convertedWei);
  const keepShare = nonNeg(K - outside);
  const maxInput = nonNeg(
    (partTotal - keepShare < a.nativeNow + still - K
      ? partTotal - keepShare
      : a.nativeNow + still - K),
  );
  let input = fixed !== undefined && fixed < maxInput ? fixed : maxInput;
  if (input < 0n) input = 0n;
  const nativeFundable = nonNeg(a.nativeNow - K);
  const needsUnwrap = still > 0n && input > nativeFundable;
  if (input <= 0n || (needsUnwrap && a.nativeNow < a.unwrapCostWei)) {
    /* Gas cannot be secured: either nothing is swappable
     * under the keep, or the unwrap that would fix it is
     * itself unpayable. When native alone already covers
     * the keep there is no gas problem — just nothing to
     * swap — so that case is 'blocked', not faucet. */
    if (input <= 0n && a.nativeNow >= K) {
      return { action: 'blocked', swapInput: 0n, legs: [], keepWei: K };
    }
    return { action: 'faucet', swapInput: 0n, legs: [], keepWei: K };
  }
  const legs: Ql1FinishLeg[] = [];
  if (needsUnwrap) legs.push({ kind: 'unwrap', amount: still });
  legs.push({ kind: 'swap', spendNative: true });
  return { action: 'run', swapInput: input, legs, keepWei: K };
}

export interface Ql1FinishState {
  nativeNow: bigint;
  tokenNow: bigint;
  allowanceNow: bigint;
  keepWei: bigint;
  unwrapCostWei: bigint;
  swapGasCostWei: bigint;
}

/** Read the fresh balances + gas figures a finish plan is
 *  decided from (fee data falls back to the measured floor
 *  price, like fetchQl1KeepPlan). Returns null ONLY when a
 *  balance read fails — the caller then shows the network
 *  guidance and nothing is planned from stale numbers. */
export async function fetchQl1FinishState(
  owner: string,
  tokenAddr: string | null,
): Promise<Ql1FinishState | null> {
  try {
    const fee = await providerFor('ql1')
      .getFeeData()
      .catch(() => null);
    const gasPrice = fee?.gasPrice ?? fee?.maxFeePerGas ?? QL1_GAS_PRICE_FLOOR;
    const nativeNow = await arrivalBalance('ql1', null, owner);
    let tokenNow = 0n;
    let allowanceNow = 0n;
    if (tokenAddr) {
      tokenNow = await erc20Balance('ql1', tokenAddr, owner);
      allowanceNow = await erc20Allowance(
        'ql1',
        tokenAddr,
        owner,
        AGG_CHAINS.ql1.router,
      ).catch(() => 0n);
    }
    return {
      nativeNow,
      tokenNow,
      allowanceNow,
      keepWei: ql1GasKeepWei(gasPrice),
      unwrapCostWei: gasPrice * QL1_UNWRAP_GAS_UNITS,
      swapGasCostWei: gasPrice * QL1_SWAP_GAS_UNITS,
    };
  } catch {
    return null;
  }
}

export interface Ql1BatchDeps {
  /** Fresh plan callback — invoked once at batch start and
   *  again right before the swap leg builds (post-unwrap
   *  balances): the swap input is ALWAYS re-derived, never
   *  carried across the unwrap. */
  plan: () => Promise<Ql1FinishPlan>;
  /** Build the broadcast tx for a leg (its swapInput for
   *  the swap leg). Token-build failures (no route, moved
   *  price) throw and surface through the classifier. */
  buildTx: (leg: Ql1FinishLeg, swapInput: bigint) => Promise<any>;
  /** Broadcast + robustly confirm one tx (the step's
   *  sendTxReq; resolves with the tx hash). A landed-but-
   *  unconfirmed tx throws TxUnconfirmedError and aborts
   *  the batch — later legs are never attempted on an
   *  unproven state. */
  send: (tx: any) => Promise<unknown>;
  onLeg?: (leg: Ql1FinishLeg) => void;
  /** Fires the moment an unwrap leg confirms; the caller
   *  persists the converted amount on the part BEFORE the
   *  swap leg runs. */
  onUnwrapConfirmed?: (amount: bigint) => void | Promise<void>;
}

/**
 * Execute a QL1 finishing batch: every leg of the plan, in
 * order, under the caller's single confirmation. Typed
 * stops: Error('faucet') / Error('blocked') mirror the plan
 * actions (also when a mid-batch re-plan degrades — e.g.
 * the route's input vanished); every other failure is the
 * leg's own error, classified by the caller exactly like a
 * single-step send. The swap leg re-plans first, so a
 * resume after a confirmed unwrap plans ZERO further
 * unwraps (fresh native covers keep + input) by
 * construction.
 */
export async function runQl1FinishBatch(
  deps: Ql1BatchDeps,
): Promise<{ swapInput: bigint }> {
  const p0 = await deps.plan();
  if (p0.action === 'faucet') throw new Error('faucet');
  if (p0.action !== 'run') throw new Error('blocked');
  let swapInput = p0.swapInput;
  for (const leg of p0.legs) {
    if (leg.kind === 'swap') {
      const p1 = await deps.plan();
      if (p1.action === 'faucet') throw new Error('faucet');
      if (p1.action !== 'run' || p1.swapInput <= 0n) throw new Error('blocked');
      swapInput = p1.swapInput;
      deps.onLeg?.(leg);
      const tx = await deps.buildTx(leg, swapInput);
      await deps.send(tx);
    } else {
      deps.onLeg?.(leg);
      const tx = await deps.buildTx(leg, swapInput);
      await deps.send(tx);
      if (leg.kind === 'unwrap') {
        await deps.onUnwrapConfirmed?.(leg.amount);
      }
    }
  }
  return { swapInput };
}

/* ---------------- holdings-driven display (v0.4.3) ------- */

export interface HeldToken {
  chain: 'infinite' | 'ql1';
  address: string;
  symbol: string;
  decimals: number;
  balance: bigint;
}

/** Addresses already covered by the curated balance rows —
 *  auto-discovery must ADD to the curated set, never
 *  duplicate it. */
export function heldTokenExclude(chain: 'infinite' | 'ql1'): Set<string> {
  if (chain === 'ql1') {
    return new Set([WQOM_ADDR.toLowerCase(), QCAW_ADDR.toLowerCase()]);
  }
  return new Set([USDT_ON.infinite.address.toLowerCase()]);
}

/** Parse a Blockscout v2 token-balances payload into held
 *  tokens. Pure. Light sanity filter: only positive
 *  balances, plausible decimals (0–36), at most 50 entries;
 *  a missing symbol falls back to the short address so the
 *  row is still identifiable. */
export function parseHeldTokenBalances(
  chain: 'infinite' | 'ql1',
  payload: any,
  exclude: Set<string>,
): HeldToken[] {
  const items = Array.isArray(payload) ? payload : payload?.items;
  if (!Array.isArray(items)) return [];
  const out: HeldToken[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const tok = it?.token ?? {};
    const addrRaw = tok.address_hash ?? tok.address;
    if (typeof addrRaw !== 'string') continue;
    const addr = addrRaw.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
    if (exclude.has(addr) || seen.has(addr)) continue;
    let value: bigint;
    try {
      value = BigInt(it?.value ?? '0');
    } catch {
      continue;
    }
    if (value <= 0n) continue;
    const dec = Number.parseInt(String(tok.decimals ?? '18'), 10);
    if (!Number.isInteger(dec) || dec < 0 || dec > 36) continue;
    const symbol =
      typeof tok.symbol === 'string' && tok.symbol.length > 0
        ? tok.symbol
        : '…' + addr.slice(-4);
    seen.add(addr);
    out.push({ chain, address: addr, symbol, decimals: dec, balance: value });
    if (out.length >= 50) break;
  }
  return out;
}

/** Discover the tokens the wallet actually holds on the two
 *  flow chains, via the same Blockscout explorers the app
 *  already links to (/api/v2/addresses/<addr>/token-
 *  balances). A failed chain read simply yields no extras
 *  for that chain — the curated rows are unaffected.
 *  `fetcher` is injectable for the harness. */
export async function fetchHeldTokens(
  address: string,
  fetcher?: (url: string) => Promise<any>,
): Promise<HeldToken[]> {
  const get =
    fetcher ??
    (async (url: string) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 12000);
      try {
        const r = await fetch(url, { signal: ctl.signal });
        if (!r.ok) throw new Error('http ' + r.status);
        return await r.json();
      } finally {
        clearTimeout(t);
      }
    });
  const out: HeldToken[] = [];
  for (const chain of ['infinite', 'ql1'] as const) {
    try {
      const base = (AGG_CHAINS[chain] as any)?.explorer;
      if (typeof base !== 'string' || !base) continue;
      const payload = await get(
        `${base}/api/v2/addresses/${address}/token-balances`,
      );
      out.push(...parseHeldTokenBalances(chain, payload, heldTokenExclude(chain)));
    } catch {
      /* that chain's extras are simply absent */
    }
  }
  return out;
}

/** A held QL1 token is a candidate BUY start point (the
 *  aggregator still has the final say: no live route, no
 *  start card). The wrapped native and CAW itself are
 *  excluded — they have their own cards / are the goal. */
export function ql1HeldStartCandidate(h: HeldToken): boolean {
  return h.chain === 'ql1' && h.balance > 0n;
}

/** Register a held token into the aggregator (idempotent)
 *  and return its registry entry, so route search and the
 *  tx builders resolve it exactly like a built-in token. */
export function ensureAggToken(h: HeldToken): any | null {
  const existing = aggTokenByAddress(h.chain, h.address);
  if (existing) return existing;
  return addCustomToken(h.chain, {
    address: h.address,
    symbol: h.symbol,
    decimals: h.decimals,
  });
}

/**
 * Goal recommendation for the HuntersDEX entry cards
 * (v0.4.1): the direction whose continuation the user's
 * current position suggests. Holding CAW is the one clear
 * signal — the natural next move for a CAW holder is toward
 * cashing out; intermediate balances (entry USDT, 42 USDT)
 * continue toward BOTH goals, so they do not distinguish,
 * and the default goal is buying CAW.
 */
export function recommendedGoal(ql1Qcaw: bigint): 'buy' | 'sell' {
  return ql1Qcaw > 0n ? 'sell' : 'buy';
}

export type ArrivalAction = 'done-usdt' | 'final-swap' | 'paused-usdt';

/**
 * What happens when a sell flow's exit-bridge USDT lands on the
 * target chain. The user's chosen arrival coin decides: USDT
 * as-is finishes the flow right there; converting to the native
 * coin proceeds to the final swap ONLY when the target chain
 * holds roughly $1+ of the native coin for gas — otherwise the
 * flow pauses AT the USDT with the plain gas message (the
 * existing behavior; no refuel tricks are invented here).
 * Flows saved before v0.4.1 have no endCoin: they mean 'native'.
 */
export function arrivalAction(
  endCoin: 'usdt' | 'native' | undefined,
  targetNativeUsd: number,
): ArrivalAction {
  if (endCoin === 'usdt') return 'done-usdt';
  return targetNativeUsd >= 1 ? 'final-swap' : 'paused-usdt';
}

/* ---------------- generic ERC20 reads ---------------- */

export async function erc20Balance(
  chain: HsChainKey,
  token: string,
  owner: string,
): Promise<bigint> {
  const c = new Contract(token, ERC20_ABI, providerFor(chain)) as any;
  return BigInt(await withRpcRetry(() => c.balanceOf(owner)));
}

export async function erc20Allowance(
  chain: HsChainKey,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const c = new Contract(token, ERC20_ABI, providerFor(chain)) as any;
  return BigInt(await withRpcRetry(() => c.allowance(owner, spender)));
}

export function buildApproveTx(token: string, spender: string, amount: bigint): TxReq {
  const iface = new Interface(ERC20_ABI as unknown as string[]);
  return {
    to: token,
    data: iface.encodeFunctionData('approve', [spender, amount]),
    value: 0n,
  };
}

/* ---------------- balances (entry screen) ---------------- */

export interface HsBalances {
  bscNative: bigint | null;
  bscUsdt: bigint | null;
  ethNative: bigint | null;
  ethUsdt: bigint | null;
  infUsdt: bigint | null;
  infNative: bigint | null;
  ql1Native: bigint | null;
  /** WQOM held on QL1 (ERC-20) — what bridged QOM actually
   *  arrives as. Shown as its OWN balance row (v0.4.2): before
   *  this, delivered funds were invisible in the list. */
  ql1Wqom: bigint | null;
  ql1Qcaw: bigint | null;
}

const QCAW_ADDR = '0xd2140E16aDf37194036865E90BbCA1139b739d0D';
/** WQOM on QL1 — the wrapped native token (also the bridge
 *  delivery asset for the QOM pair). */
export const WQOM_ADDR = '0xa26dfBF98Dd1A32FAe56A3D2B2D60A8a41b0bDF0';

async function tryRead<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** All balances the HuntersSwap entry screen shows. A failed read
 *  comes back null (shown as "—"), never as a guessed number. */
export async function fetchHsBalances(address: string): Promise<HsBalances> {
  const [bscNative, bscUsdt, ethNative, ethUsdt, infUsdt, infNative, ql1Native, ql1Wqom, ql1Qcaw] =
    await Promise.all([
      tryRead(() => providerFor('bsc').getBalance(address).then((v) => BigInt(v))),
      tryRead(() => erc20Balance('bsc', USDT_ON.bsc.address, address)),
      tryRead(() => providerFor('ethereum').getBalance(address).then((v) => BigInt(v))),
      tryRead(() => erc20Balance('ethereum', USDT_ON.ethereum.address, address)),
      tryRead(() => erc20Balance('infinite', USDT_ON.infinite.address, address)),
      tryRead(() => providerFor('infinite').getBalance(address).then((v) => BigInt(v))),
      tryRead(() => providerFor('ql1').getBalance(address).then((v) => BigInt(v))),
      tryRead(() => erc20Balance('ql1', WQOM_ADDR, address)),
      tryRead(() => erc20Balance('ql1', QCAW_ADDR, address)),
    ]);
  return {
    bscNative,
    bscUsdt,
    ethNative,
    ethUsdt,
    infUsdt,
    infNative,
    ql1Native,
    ql1Wqom,
    ql1Qcaw,
  };
}

/** Balance used for bridge-arrival watching on a chain: native
 *  balance when token is null, ERC20 balance otherwise. */
export async function arrivalBalance(
  chain: HsChainKey,
  token: string | null,
  owner: string,
): Promise<bigint> {
  if (token === null) {
    return BigInt(await providerFor(chain).getBalance(owner));
  }
  return erc20Balance(chain, token, owner);
}

export type PartArrivalVerdict =
  | { action: 'wait' }
  | { action: 'arrived'; arrived: bigint }
  | { action: 'rebase' };

/**
 * One arrival-watch poll for a buy part parked at its bridge
 * step (step 2), decided purely from the QL1 balance of the
 * pair token AS DELIVERED — an ERC-20 in every case: QOM
 * bridged into QL1 lands as WQOM, never as native QOM
 * (v0.4.2; before this the QOM pair was watched on the native
 * balance and could never advance).
 *
 * Normal rule (baseline denominated in the delivered token,
 * dstBaseIsToken set — armed by v0.4.2+, and always the case
 * for non-QOM pairs, whose baselines were never misread):
 * the part advances once the balance DELTA reaches 99% of
 * the bridged amount; the delta is what gets swapped onward.
 *
 * Repair rule for legacy QOM parts (saved by v0.4.1 or
 * earlier with dstBaseIsToken absent): their stored baseline
 * was captured from the NATIVE balance, so the delta mixes
 * two different assets and can under- or over-state the
 * delivery. If the delta does not reach the threshold but
 * the delivered-token balance ALONE already covers 99% of
 * the bridged amount, the delivery is here — advance with
 * the full balance as the arrived amount (cross-asset
 * baseline). If neither holds, the watcher rebases the
 * stored baseline onto the current delivered-token balance
 * exactly once (the caller persists dstBaseIsToken with it,
 * which is also what makes it once-only) and keeps watching
 * deltas from there. A partial delivery below threshold
 * never advances the part.
 */
export function partArrivalVerdict(
  now: bigint,
  part: {
    sym: string;
    dstBalanceBefore?: string;
    bridgedAmount?: string;
    dstBaseIsToken?: boolean;
    /** Registry-derived by the caller (v0.4.3): this part's
     *  pair delivers as the wrapped native (WQOM), so a
     *  pre-v0.4.2 native baseline can mismatch the read
     *  asset and needs the repair below. Any other token
     *  leaves it unset — the delta rule alone applies. */
    deliversWrappedNative?: boolean;
  },
): PartArrivalVerdict {
  const want = (safeBig(part.bridgedAmount) * 99n) / 100n;
  if (want <= 0n) return { action: 'wait' };
  const arrived = now - safeBig(part.dstBalanceBefore);
  if (arrived > 0n && arrived >= want) return { action: 'arrived', arrived };
  const legacyNativeBaseline =
    part.deliversWrappedNative === true && !part.dstBaseIsToken;
  if (legacyNativeBaseline) {
    if (now >= want) return { action: 'arrived', arrived: now };
    return { action: 'rebase' };
  }
  return { action: 'wait' };
}

/* ---------------- prices (all from live DEX quotes) ---------------- */

function dexRouter(entry: EntryKey): any {
  return new Contract(
    ENTRY_DEX[entry].router,
    ROUTER_ABI as unknown as string[],
    providerFor(entry),
  );
}

/** USD value of 1 unit of the entry chain's native coin, from the
 *  live V2 pair (getAmountsOut of exactly 1 coin). */
export async function nativeUsdPrice(entry: EntryKey): Promise<number> {
  const dex = ENTRY_DEX[entry];
  const amounts: bigint[] = await withRpcRetry(() =>
    dexRouter(entry).getAmountsOut(parseUnits('1', 18), [
      dex.wrapped,
      dex.usdt,
    ]),
  );
  return Number(formatUnits(amounts[amounts.length - 1], dex.usdtDecimals));
}

/** Live quote for the entry swap: native coin -> USDT. */
export async function quoteEntrySwap(
  entry: EntryKey,
  amountIn: bigint,
): Promise<bigint> {
  const dex = ENTRY_DEX[entry];
  const amounts: bigint[] = await withRpcRetry(() =>
    dexRouter(entry).getAmountsOut(amountIn, [dex.wrapped, dex.usdt]),
  );
  return amounts[amounts.length - 1];
}

export function buildEntrySwapTx(
  entry: EntryKey,
  amountIn: bigint,
  amountOutMin: bigint,
  to: string,
  nowSec?: number,
): TxReq {
  const dex = ENTRY_DEX[entry];
  const iface = new Interface(ROUTER_ABI as unknown as string[]);
  const deadline = BigInt((nowSec ?? Math.floor(Date.now() / 1000)) + 20 * 60);
  return {
    to: dex.router,
    data: iface.encodeFunctionData('swapExactETHForTokens', [
      amountOutMin,
      [dex.wrapped, dex.usdt],
      to,
      deadline,
    ]),
    value: amountIn,
  };
}

/** [42] price in USD from the aggregator engine's live 42-side
 *  route (1 [42] -> USDT, best route). */
export async function price42Usd(): Promise<number | null> {
  try {
    const q = await fetchQuotesForTokens(
      AGG_CHAINS.infinite,
      tokenById('infinite', 'native'),
      tokenById('infinite', 'usdt'),
      parseUnits('1', 18),
    );
    if (!q.routes || !q.routes.length) return null;
    return Number(formatUnits(q.routes[0].amountOut, 18));
  } catch {
    return null;
  }
}

/** Ethereum gas snapshot for the entry screen: current gas price
 *  and the USD cost of the ~450k gas the ETH entry needs in total
 *  (swap + approve + bridge send, GuppyWallet planning figure). */
export async function ethGasInfo(): Promise<{
  gasPriceWei: bigint;
  totalUsd450k: number;
} | null> {
  try {
    const [fee, ethUsd] = await Promise.all([
      providerFor('ethereum').getFeeData(),
      nativeUsdPrice('ethereum'),
    ]);
    if (fee.gasPrice === null || fee.gasPrice === undefined) return null;
    const gasPriceWei = BigInt(fee.gasPrice);
    const costEth = Number(formatUnits(gasPriceWei * 450000n, 18));
    return { gasPriceWei, totalUsd450k: costEth * ethUsd };
  } catch {
    return null;
  }
}

/** "Gas is expensive now" for the ETH entry: the total entry gas
 *  would eat more than 10% of a $100 entry (the minimum size). */
export function ethGasExpensive(totalUsd450k: number): boolean {
  return totalUsd450k > ETH_MIN_ENTRY_USD * 0.1;
}

/* ---------------- entry rules (user decisions 2026-11-08) ------ */

/** BSC: how much BNB must stay behind for gas — $3 worth or more. */
export function bscGasKeepRaw(bnbBalance: bigint, bnbUsd: number): bigint {
  if (bnbUsd <= 0) return 0n;
  const keep = parseUnits((BSC_GAS_KEEP_USD / bnbUsd).toFixed(18), 18);
  return keep < bnbBalance ? keep : bnbBalance;
}

/** BSC: the most BNB that may be swapped (balance minus $3 keep). */
export function bscSpendable(bnbBalance: bigint, bnbUsd: number): bigint {
  const keep = bscGasKeepRaw(bnbBalance, bnbUsd);
  const rest = bnbBalance - keep;
  return rest > 0n ? rest : 0n;
}

/** ETH entry gate: the amount to swap must be worth $100 or more. */
export function ethEntryAllowed(amountIn: bigint, ethUsd: number): boolean {
  if (ethUsd <= 0) return false;
  return Number(formatUnits(amountIn, 18)) * ethUsd >= ETH_MIN_ENTRY_USD;
}

/** Amount for a % chip of a spendable balance. */
export function chipAmount(spendable: bigint, pct: number): bigint {
  if (pct >= 100) return spendable;
  return (spendable * BigInt(pct)) / 100n;
}

/* ---------------- inbound bridge (BSC/ETH -> 42) --------------- */

export interface BridgeInQuote {
  forward: bigint;
  fee: bigint;
  totalNative: bigint;
  /** false when quoteNative reverted and the fee fell back to 0
   *  (the normal case on these older routers). */
  nativeQuoteOk: boolean;
}

/** Fresh quote for an inbound USDT bridge send. Mirrors
 *  GuppyWallet fetchBridgeQuote with nativeOptional: true. */
export async function quoteBridgeIn(
  entry: EntryKey,
  amount: bigint,
): Promise<BridgeInQuote> {
  const cfg = BRIDGE_IN_USDT[entry];
  const router = new Contract(
    cfg.router,
    BRIDGE_ROUTER_ABI as unknown as string[],
    providerFor(entry),
  ) as any;
  const qb: any = await withRpcRetry(() => router.quoteBridge(amount));
  let totalNative = 0n;
  let nativeQuoteOk = false;
  try {
    const qn = await router.quoteNative(DOMAIN_42, '0x');
    totalNative = BigInt(qn.totalNative ?? qn[2]);
    nativeQuoteOk = true;
  } catch {
    totalNative = 0n; // older routers revert; official frontend sends 0
  }
  return {
    forward: BigInt(qb.forwardAmount ?? qb[0]),
    fee: BigInt(qb.fee ?? qb[1]),
    totalNative,
    nativeQuoteOk,
  };
}

/** Mirror of the official frontend's amount adjustment (amounts
 *  are passed in source units, truncated to destination decimals). */
export function truncateToDstDecimals(
  amountRaw: bigint,
  srcDecimals: number,
  dstDecimals: number = 18,
): bigint {
  if (dstDecimals >= srcDecimals) return amountRaw;
  const step = 10n ** BigInt(srcDecimals - dstDecimals);
  return (amountRaw / step) * step;
}

export function buildBridgeInTx(
  entry: EntryKey,
  amount: bigint,
  recipient: string,
  totalNative: bigint,
): TxReq {
  const cfg = BRIDGE_IN_USDT[entry];
  const iface = new Interface(BRIDGE_ROUTER_ABI as unknown as string[]);
  const amt = truncateToDstDecimals(amount, cfg.tokenDecimals);
  return {
    to: cfg.router,
    data: iface.encodeFunctionData('transferRemote', [
      DOMAIN_42,
      zeroPadValue(getAddress(recipient), 32),
      amt,
    ]),
    value: totalNative,
  };
}

/** USDT expected on 42 Chain for a source-side send amount. */
export function expected42Usdt(sourceUsdtRaw: bigint, sourceDecimals: number): bigint {
  const in42 = parseUnits(formatUnits(sourceUsdtRaw, sourceDecimals), 18);
  const fee = parseUnits(String(BRIDGE_IN_FEE_USDT), 18);
  return in42 > fee ? in42 - fee : 0n;
}

/* ---------------- execution gate (quote-only mode) -------------- */

/**
 * Quote-only mode (v0.3.2): the QUOTE path never looks at balances —
 * any well-formed positive amount gets an estimate, even above what
 * the wallet holds. The balance gate lives HERE, at execution time:
 * the confirm screen asks this helper and disables the start action
 * (with a plain "estimate only" note) when the amount exceeds the
 * usable balance. Send-time validation is unchanged.
 */
export interface AmountGate {
  ok: boolean;
  insufficient: boolean;
}

export function amountGate(amount: bigint, usable: bigint): AmountGate {
  const insufficient = amount > usable;
  return { ok: !insufficient, insufficient };
}

/* ---------------- back half: 42 USDT -> QL1 CAW --------------- */

export interface BackHalfQuote {
  /** All enabled cross candidates (engine objects, opaque here). */
  candidates: any[];
  bestSingle: any;
  /** Set only when the split plan beats the best single route
   *  AFTER the extra bridge fees (evaluateCrossSplitNet.shown). */
  split: {
    parts: any[];
    totalOut: bigint;
    /** Split output after the extra bridge fees, in CAW:
     *  best single output + the net verdict's net gain. */
    netOut: bigint;
    netGainPct: number;
  } | null;
  /** Live 42->QL1 bridge message fee per leg, in [42] raw. */
  feePerLeg42: bigint;
  /** Live bridge TOKEN fee of the best route's pair (0 today). */
  tokenFeeBest?: bigint;
  at: number;
}

/**
 * Split evaluation costs many extra quotes and, in the QL1 -> 42
 * direction (leg fees 0), can "win" by dust on tiny outputs — the
 * 0.658-USDT sell that took 26 s in v0.3.1. Rule (v0.3.2): the best
 * SINGLE route is always computed first, and the split search runs
 * ONLY when the trade is worth roughly this many USD or more.
 * Below the threshold `split` stays null. A split failure never
 * fails the quote (best-effort try/catch, as before).
 */
export const SPLIT_MIN_USD = 50;

/** Rough USD value of an 18-decimal USDT amount (USDT ≈ $1). */
const usdOfUsdt18 = (raw: bigint): number => Number(formatUnits(raw, 18));

export async function quoteBackHalf(usdt42Raw: bigint): Promise<BackHalfQuote> {
  const usdt = tokenById('infinite', 'usdt');
  const qcaw = tokenById('ql1', 'qcaw');
  const cands = await quoteCrossPlan('infinite', usdt, 'ql1', qcaw, usdt42Raw);
  await applyTokenFees(cands, 'infinite', 'ql1', qcaw.address);
  const enabled = cands.filter((c: any) => c.enabled);
  if (!enabled.length) throw new Error('no-route');
  const bestSingle = enabled
    .slice()
    .sort((a: any, b: any) => (b.finalOut > a.finalOut ? 1 : -1))[0];
  let split: BackHalfQuote['split'] = null;
  // The output is CAW, which this app deliberately never prices in
  // USD; the input IS USDT, and the output's value tracks it, so the
  // input amount is the rough size gauge for the split search.
  if (usdOfUsdt18(usdt42Raw) >= SPLIT_MIN_USD) {
    try {
      const xs = await evaluateCrossSplit('infinite', 'ql1', usdt42Raw, cands);
      const net = await evaluateCrossSplitNet('infinite', 'ql1', qcaw, xs);
      if (net && net.shown && xs.best) {
        split = {
          parts: xs.best.parts,
          totalOut: xs.best.totalOut,
          netOut: bestSingle.finalOut + (net.netGain ?? 0n),
          netGainPct: net.netPct ?? 0,
        };
      }
    } catch {
      split = null; // split evaluation is best-effort; single still works
    }
  }
  // The engine quotes quoteNative per pair, live — take the BEST
  // route's pair fee (all pairs price the same mailbox today).
  let feePerLeg42 = parseUnits(String(BRIDGE_NATIVE_FEE_42_FALLBACK), 18);
  if (bestSingle.nativeFee && bestSingle.nativeFee > 0n) {
    feePerLeg42 = bestSingle.nativeFee as bigint;
  } else {
    try {
      const pair = BRIDGE_PAIRS.find((p) => p.sym === bestSingle.pair.sym);
      const q = pair ? await fetchBridgeNativeQuote(pair) : null;
      if (q && q.totalNative > 0n) feePerLeg42 = q.totalNative;
    } catch {
      /* keep the measured fallback */
    }
  }
  return {
    candidates: cands,
    bestSingle,
    split,
    feePerLeg42,
    tokenFeeBest: (bestSingle.tokenFee ?? 0n) as bigint,
    at: Date.now(),
  };
}

/* ---------------- [42] carve-out -------------------------------- */

export interface CarvePlan {
  /** [42] that must be in the wallet before the bridge legs run:
   *  (message fee + gas margin) x legs. */
  reserveTotal: bigint;
  /** Already in the wallet — nothing to carve when this covers it. */
  alreadyHave: bigint;
  /** Still to make from the flow itself (0 when covered). */
  needFromFlow: bigint;
  legs: number;
}

export function planCarveout(
  legs: number,
  feePerLeg42: bigint,
  native42Balance: bigint,
): CarvePlan {
  const perLeg = feePerLeg42 + parseUnits(String(CARVE_GAS_MARGIN_42), 18);
  const reserveTotal = perLeg * BigInt(Math.max(1, legs));
  const needFromFlow =
    native42Balance >= reserveTotal ? 0n : reserveTotal - native42Balance;
  return {
    reserveTotal,
    alreadyHave: native42Balance,
    needFromFlow,
    legs: Math.max(1, legs),
  };
}

/**
 * How much USDT (42 Chain) to swap into [42] to cover a carve
 * shortfall, quoted with the engine's live USDT->[42] route, plus
 * a 5% safety margin. Returns null when the route cannot be quoted.
 */
export async function quoteCarveUsdtCost(
  need42Raw: bigint,
): Promise<{ usdtCost: bigint; route: any } | null> {
  if (need42Raw <= 0n) return { usdtCost: 0n, route: null };
  try {
    const best: any = await fetchBestRoute(
      AGG_CHAINS.infinite,
      tokenById('infinite', 'native'),
      tokenById('infinite', 'usdt'),
      need42Raw,
    );
    if (!best || !best.amountOut || best.amountOut <= 0n) return null;
    // best is the [42]->USDT direction (price discovery); invert it:
    // to RECEIVE need42Raw of [42], swap along the USDT->[42] route.
    const usdtTo42: any = await fetchBestRoute(
      AGG_CHAINS.infinite,
      tokenById('infinite', 'usdt'),
      tokenById('infinite', 'native'),
      best.amountOut,
    );
    if (!usdtTo42 || !usdtTo42.amountOut || usdtTo42.amountOut <= 0n) return null;
    // Scale the input by need/actual-received, +5% margin.
    // (fetchBestRoute returns { path, amounts, amountOut } — there
    // is no `.route` field; execution re-quotes via freshRoute.)
    const got = usdtTo42.amountOut;
    let cost = (best.amountOut * need42Raw) / got;
    cost = (cost * 105n) / 100n;
    if (cost <= 0n) cost = best.amountOut;
    return { usdtCost: cost, route: usdtTo42 };
  } catch {
    return null;
  }
}

/* ---------------- execution tx builders (back half) ------------ */

export interface BuiltTx {
  to: string;
  data: string;
  value: bigint;
}

function normTx(tx: any): BuiltTx {
  return {
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value ?? 0),
  };
}

/** Approve tx for a token on 42/QL1 from the engine's builder. */
export function buildAggApprove(tokenAddr: string, spender: string, amount: bigint): BuiltTx {
  return normTx(aggBuildApproveTx(tokenAddr, spender, amount));
}

/** Swap tx on 42 Chain or QL1 from an engine candidate route. */
export function buildAggSwap(
  chainKey: 'infinite' | 'ql1',
  cand: any,
  leg: 1 | 2,
  amountIn: bigint,
  account: string,
  slippagePct: number,
): BuiltTx | null {
  const chainObj = AGG_CHAINS[chainKey];
  const route = leg === 1 ? cand.swap1Route : cand.swap2Route;
  if (!route) return null;
  const fromTok = tokenByAddressSafe(chainKey, route.path[0]);
  const toTok = tokenByAddressSafe(chainKey, route.path[route.path.length - 1]);
  if (!fromTok || !toTok) return null;
  // The candidate's stored route may predate routes carrying
  // amountIn (v0.3.6 hotfix): attach the caller's explicit amount.
  const routeIn = { ...route, amountIn };
  return normTx(
    aggBuildSwapTx(chainObj, fromTok, toTok, routeIn, account, slippagePct, Math.floor(Date.now() / 1000)),
  );
}

function tokenByAddressSafe(chainKey: string, addr: string): any {
  try {
    return aggTokenByAddress(chainKey, addr);
  } catch {
    return null;
  }
}

/** Bridge tx 42 -> QL1 for one candidate (engine builder). The
 *  native value is the live message fee — fetch it fresh before
 *  sending and pass it in. */
export function buildAggBridge(cand: any, recipient: string, amount: bigint, nativeFee: bigint): BuiltTx {
  const pair = BRIDGE_PAIRS.find((p) => p.sym === cand.pair.sym);
  if (!pair) throw new Error('no-bridge-pair');
  return normTx(aggBuildBridgeTx(pair, 'infinite', recipient, amount, nativeFee));
}

/** Same bridge builder for parts whose source chain is QL1
 *  (sell direction: the candidate object comes from a QL1 ->
 *  infinite quote). */
export function buildAggBridgeFromQl1(
  cand: any,
  recipient: string,
  amount: bigint,
  nativeFee: bigint,
): BuiltTx {
  const pair = cand.pair;
  return normTx(aggBuildBridgeTx(pair, 'ql1', recipient, amount, nativeFee));
}

/** Fresh live 42->QL1 message fee (in [42] raw) for a pair symbol. */
export async function freshBridgeFee42(sym: string): Promise<bigint> {
  const pair = BRIDGE_PAIRS.find((p) => p.sym === sym);
  if (!pair) return parseUnits(String(BRIDGE_NATIVE_FEE_42_FALLBACK), 18);
  try {
    const q = await fetchBridgeNativeQuote(pair);
    if (q && q.totalNative > 0n) return q.totalNative;
  } catch {
    /* fall through */
  }
  return parseUnits(String(BRIDGE_NATIVE_FEE_42_FALLBACK), 18);
}

/**
 * Fresh route for one swap leg at an exact amount, preferring the
 * path the confirmed plan used. Returns the engine route object
 * (carries amountIn / amountOut / path) or null.
 */
export async function freshRoute(
  aggKey: 'infinite' | 'ql1',
  fromAddr: string,
  toAddr: string,
  amount: bigint,
  wantPath: string[] | null,
): Promise<any | null> {
  const chainObj = AGG_CHAINS[aggKey];
  const fromTok = aggTokenByAddress(aggKey, fromAddr);
  const toTok = aggTokenByAddress(aggKey, toAddr);
  if (!fromTok || !toTok) return null;
  const q = await fetchQuotesForTokens(chainObj, fromTok, toTok, amount);
  if (!q.routes || !q.routes.length) return null;
  // Normalize at the source (v0.3.6 hotfix): execution builders
  // read route.amountIn, so guarantee it here — the requested
  // amount, which equals route.amounts[0] by construction.
  const withAmountIn = (r: any) =>
    r ? { ...r, amountIn: r.amounts?.[0] ?? amount } : r;
  if (wantPath) {
    const wp = wantPath.map((a) => a.toLowerCase()).join(',');
    const match = q.routes.find(
      (r: any) => r.path.map((a: string) => a.toLowerCase()).join(',') === wp,
    );
    if (match) return withAmountIn(match);
  }
  return withAmountIn(q.routes[0]);
}

/** Build a swap tx from a fresh engine route (route amounts rule).
 *  fromTokOverride: the caller already holds the input token's
 *  entry and needs it used as-is. Needed on QL1, where resolving
 *  the WQOM address by lookup yields the chain's "native" entry
 *  (same contract) and would build a native-spending
 *  swapExactETHForTokens — wrong when the input is WQOM the
 *  user actually holds as an ERC-20 (e.g. a bridge delivery);
 *  the delivered-token entry (id 'wqom', isNative false) builds
 *  the token-spending swapExactTokensForTokens instead. */
export function buildRouteSwapTx(
  aggKey: 'infinite' | 'ql1',
  route: any,
  account: string,
  slippagePct: number,
  fromTokOverride?: any,
): BuiltTx {
  const chainObj = AGG_CHAINS[aggKey];
  const fromTok = fromTokOverride ?? aggTokenByAddress(aggKey, route.path[0]);
  const toTok = aggTokenByAddress(aggKey, route.path[route.path.length - 1]);
  return normTx(aggBuildSwapTx(chainObj, fromTok, toTok, route, account, slippagePct, Math.floor(Date.now() / 1000)));
}

export function aggTokenAddr(aggKey: string, id: string): string {
  return tokenById(aggKey, id).address;
}

export function aggTokenByAddr(aggKey: string, addr: string): any {
  return aggTokenByAddress(aggKey, addr);
}

/* ---------------- freshness guard ------------------------------- */

/** True when a fresh quote is materially worse than what the user
 *  confirmed (default tolerance 3%). Callers must stop and ask. */
export function worseThanConfirmed(
  freshOut: bigint,
  confirmedOut: bigint,
  toleranceBps: number = 300,
): boolean {
  if (confirmedOut <= 0n) return false;
  const floor = (confirmedOut * BigInt(10000 - toleranceBps)) / 10000n;
  return freshOut < floor;
}

export function applySlippage(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10000 - bps)) / 10000n;
}

export { formatUnits, parseUnits };


/* ------------------------------------------------------------------ */
/* Reverse direction (sell): CAW -> QOM -> 42 USDT -> target chain   */
/* ------------------------------------------------------------------ */
/* Reverse direction (sell): CAW -> QOM -> 42 USDT -> target chain   */
/* ------------------------------------------------------------------ */

/**
 * Sell back half: CAW on QL1 -> USDT on 42 Chain, best route via
 * the ported engine (quoteCrossPlan works QL1 -> infinite; live
 * verified 2026-11-08: 75B CAW -> ~81.8 USDT via QOM, QL1-side
 * bridge legs carry nativeFee 0 — the QL1 warp routers expose no
 * quote functions and real sends go out with value 0).
 */
export async function quoteBackHalfReverse(
  qcawRaw: bigint,
): Promise<BackHalfQuote> {
  const qcaw = tokenById('ql1', 'qcaw');
  const usdt = tokenById('infinite', 'usdt');
  const cands = await quoteCrossPlan('ql1', qcaw, 'infinite', usdt, qcawRaw);
  await applyTokenFees(cands, 'ql1', 'infinite', usdt.address);
  const enabled = cands.filter((c: any) => c.enabled);
  if (!enabled.length) throw new Error('no-route');
  const bestSingle = enabled
    .slice()
    .sort((a: any, b: any) => (b.finalOut > a.finalOut ? 1 : -1))[0];
  let split: BackHalfQuote['split'] = null;
  // Split search only when the single-route OUTPUT is worth roughly
  // $50+ (the output here is USDT itself, so this is exact, not a
  // proxy). Below that the search is skipped entirely — split=null.
  if (usdOfUsdt18(bestSingle.finalOut as bigint) >= SPLIT_MIN_USD) {
    try {
      const xs = await evaluateCrossSplit('ql1', 'infinite', qcawRaw, cands);
      const net = await evaluateCrossSplitNet('ql1', 'infinite', usdt, xs);
      if (net && net.shown && xs.best) {
        split = {
          parts: xs.best.parts,
          totalOut: xs.best.totalOut,
          netOut: bestSingle.finalOut + (net.netGain ?? 0n),
          netGainPct: net.netPct ?? 0,
        };
      }
    } catch {
      split = null;
    }
  }
  return { candidates: cands, bestSingle, split, feePerLeg42: 0n, at: Date.now() };
}

const BRIDGE_OUT_IFACE = new Interface([
  'function quoteBridge(uint256 amount) view returns (uint256 forwardAmount, uint256 tokenFee, uint256 totalRequired)',
  'function quoteNative(uint32 destinationDomain, bytes hookData) view returns (uint256 nativeFee, uint256 hookFee, uint256 totalNative)',
  'function transferRemote(uint32 destinationDomain, bytes32 mintRecipient, uint256 amount) payable returns (bytes32 messageId)',
]);

export interface BridgeOutQuote {
  forward: bigint;
  tokenFee: bigint;
  totalRequired: bigint;
  totalNative: bigint;
}

/** Live quote for the 42 -> target USDT bridge (sell exit leg). */
export async function quoteBridgeOut42(
  target: EntryKey,
  amountRaw: bigint,
): Promise<BridgeOutQuote> {
  const provider = providerFor('infinite');
  const data = BRIDGE_OUT_IFACE.encodeFunctionData('quoteBridge', [amountRaw]);
  const res = await withRpcRetry(() =>
    provider.call({ to: BRIDGE_OUT_USDT_42.router, data }),
  );
  const [forward, tokenFee, totalRequired] =
    BRIDGE_OUT_IFACE.decodeFunctionResult('quoteBridge', res) as unknown as [
      bigint,
      bigint,
      bigint,
    ];
  const nData = BRIDGE_OUT_IFACE.encodeFunctionData('quoteNative', [
    TARGET_DOMAIN[target],
    '0x',
  ]);
  const nRes = await withRpcRetry(() =>
    provider.call({ to: BRIDGE_OUT_USDT_42.router, data: nData }),
  );
  const [, , totalNative] = BRIDGE_OUT_IFACE.decodeFunctionResult(
    'quoteNative',
    nRes,
  ) as unknown as [bigint, bigint, bigint];
  return { forward, tokenFee, totalRequired, totalNative };
}

/** transferRemote calldata for the 42 -> target USDT bridge. */
export function buildBridgeOut42Tx(
  target: EntryKey,
  recipient: string,
  amountRaw: bigint,
  totalNative: bigint,
): TxReq {
  const data = BRIDGE_OUT_IFACE.encodeFunctionData('transferRemote', [
    TARGET_DOMAIN[target],
    zeroPadValue(getAddress(recipient), 32),
    amountRaw,
  ]);
  return { to: BRIDGE_OUT_USDT_42.router, data, value: totalNative };
}

const FINAL_SWAP_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
];

/** Quote the final target-chain swap USDT -> native coin. */
export async function quoteFinalSwap(
  target: EntryKey,
  usdtRaw: bigint,
): Promise<bigint> {
  const dex = ENTRY_DEX[target];
  const c = new Contract(dex.router, FINAL_SWAP_ABI, providerFor(target));
  const amounts = (await withRpcRetry(() =>
    c.getAmountsOut(usdtRaw, [dex.usdt, dex.wrapped]),
  )) as bigint[];
  return amounts[amounts.length - 1];
}

/** swapExactTokensForETH calldata (USDT -> BNB / ETH). */
export function buildFinalSwapTx(
  target: EntryKey,
  usdtRaw: bigint,
  minOutRaw: bigint,
  to: string,
): TxReq {
  const dex = ENTRY_DEX[target];
  const iface = new Interface(FINAL_SWAP_ABI);
  const data = iface.encodeFunctionData('swapExactTokensForETH', [
    usdtRaw,
    minOutRaw,
    [dex.usdt, dex.wrapped],
    to,
    BigInt(Math.floor(Date.now() / 1000) + 1200),
  ]);
  return { to: dex.router, data, value: 0n };
}


/** Convert an 18-decimal amount into the target chain's USDT raw
 *  units (Ethereum USDT has 6 decimals; BSC keeps 18). */
export function toTargetUsdtRaw(amount18: bigint, target: EntryKey): bigint {
  const dec = USDT_ON[target].decimals;
  if (dec >= 18) return amount18;
  return amount18 / 10n ** BigInt(18 - dec);
}

const QUOTE_BRIDGE_IFACE = new Interface([
  'function quoteBridge(uint256 amount) view returns (uint256 forwardAmount, uint256 tokenFee, uint256 totalRequired)',
]);

/**
 * LIVE per-pair bridge TOKEN fee from quoteBridge on the pair's
 * source-side router. Returns null when the router has no
 * quoteBridge (plain warp routers — their sends are 1:1, verified
 * by sampled deliveries). Measured 2026-11-08: fee = 0 on every
 * enabled pair (QOM / BABY / CAW quote; the rest revert).
 */
export async function quotePairTokenFee(
  pair: { br: string; ql1Router: string },
  amountRaw: bigint,
  srcKey: 'infinite' | 'ql1',
): Promise<bigint | null> {
  try {
    const data = QUOTE_BRIDGE_IFACE.encodeFunctionData('quoteBridge', [amountRaw]);
    const res = await providerFor(srcKey).call({
      to: srcKey === 'infinite' ? pair.br : pair.ql1Router,
      data,
    });
    const [, fee] = QUOTE_BRIDGE_IFACE.decodeFunctionResult(
      'quoteBridge',
      res,
    ) as unknown as [bigint, bigint, bigint];
    return fee;
  } catch {
    return null;
  }
}

/**
 * Fold the live token fee into candidate estimates: when a pair
 * charges one, the bridged amount shrinks, so leg 2 is re-quoted
 * at the reduced amount before routes are compared or a split is
 * evaluated. (Execution needs no such math — it measures arrived
 * balances.) With today's fee = 0 this is a verified no-op.
 */
async function applyTokenFees(
  cands: any[],
  srcKey: 'infinite' | 'ql1',
  dstKey: 'infinite' | 'ql1',
  toTokAddr: string,
): Promise<void> {
  const feeBySym = new Map<string, bigint | null>();
  for (const c of cands) {
    if (!c.enabled) continue;
    const sym = c.pair.sym as string;
    if (!feeBySym.has(sym)) {
      feeBySym.set(sym, await quotePairTokenFee(c.pair, c.bridgeOut, srcKey));
    }
    const fee = feeBySym.get(sym) ?? 0n;
    c.tokenFee = fee ?? 0n;
    if (fee && fee > 0n && c.bridgeOut > fee) {
      const reduced = c.bridgeOut - fee;
      const r = await freshRoute(dstKey, c.tDst.address, toTokAddr, reduced, c.leg2Path);
      if (r) {
        c.bridgeOut = reduced;
        c.finalOut = r.amountOut as bigint;
      }
    }
  }
}

/** Live gas estimates for the confirm screens (never hardcoded). */
export interface GasEstimates {
  /** [42] for one 42->QL1 leg's 42-side steps (approve+swap+bridge). */
  gas42PerLeg: bigint;
  /** QOM for one swap on QL1. */
  gasQomPerSwap: bigint;
}

export async function quoteGasEstimates(): Promise<GasEstimates | null> {
  try {
    const [f42, fQ] = await Promise.all([
      providerFor('infinite').getFeeData(),
      providerFor('ql1').getFeeData(),
    ]);
    if (!f42.gasPrice || !fQ.gasPrice) return null;
    return {
      gas42PerLeg: BigInt(f42.gasPrice) * 410000n,
      /* The shared QL1 swap-class unit (see the QL1 gas keep
       * section): one gas model for estimates, the gas gate
       * and the keep — no divergent thresholds. */
      gasQomPerSwap: BigInt(fQ.gasPrice) * QL1_SWAP_GAS_UNITS,
    };
  } catch {
    return null;
  }
}

/**
 * Headline estimate NET of the carve-out's opportunity cost: the
 * carve swap keeps K of the input out of the route, so the routed
 * amount — and proportionally the expected output — shrinks.
 * (Linear scaling; the carve is ~2% of the input at $100 size, so
 * the approximation error is far below the 3% freshness guard.)
 */
export function netHeadline(
  finalOut: bigint,
  inputRaw: bigint,
  carveCostRaw: bigint,
): bigint {
  if (inputRaw <= 0n || carveCostRaw <= 0n) return finalOut;
  if (carveCostRaw >= inputRaw) return 0n;
  return (finalOut * (inputRaw - carveCostRaw)) / inputRaw;
}
