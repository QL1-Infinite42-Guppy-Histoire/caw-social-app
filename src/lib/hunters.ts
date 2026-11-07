/**
 * HuntersSwap core logic (v0.3.0) — Expo-free so the Node harness
 * exercises the exact code the app runs.
 *
 * Two halves:
 *  - Entry legs (BSC / Ethereum): Uniswap-V2-family native->USDT
 *    swaps and Zaphod/Hyperlane bridge sends to 42 Chain, ported
 *    from GuppyWallet (lib/bscSwap.ts, lib/zaphod.ts
 *    bridgeInboundSendJob / fetchBridgeQuote / truncateToDstDecimals).
 *  - Back half (42 USDT -> QL1 qCAW): quotes come from the ported
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

export interface TxReq {
  to: string;
  data: string;
  value: bigint;
}

/* ---------------- generic ERC20 reads ---------------- */

export async function erc20Balance(
  chain: HsChainKey,
  token: string,
  owner: string,
): Promise<bigint> {
  const c = new Contract(token, ERC20_ABI, providerFor(chain)) as any;
  return BigInt(await c.balanceOf(owner));
}

export async function erc20Allowance(
  chain: HsChainKey,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const c = new Contract(token, ERC20_ABI, providerFor(chain)) as any;
  return BigInt(await c.allowance(owner, spender));
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
  ql1Qcaw: bigint | null;
}

const QCAW_ADDR = '0xd2140E16aDf37194036865E90BbCA1139b739d0D';

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
  const [bscNative, bscUsdt, ethNative, ethUsdt, infUsdt, infNative, ql1Native, ql1Qcaw] =
    await Promise.all([
      tryRead(() => providerFor('bsc').getBalance(address).then((v) => BigInt(v))),
      tryRead(() => erc20Balance('bsc', USDT_ON.bsc.address, address)),
      tryRead(() => providerFor('ethereum').getBalance(address).then((v) => BigInt(v))),
      tryRead(() => erc20Balance('ethereum', USDT_ON.ethereum.address, address)),
      tryRead(() => erc20Balance('infinite', USDT_ON.infinite.address, address)),
      tryRead(() => providerFor('infinite').getBalance(address).then((v) => BigInt(v))),
      tryRead(() => providerFor('ql1').getBalance(address).then((v) => BigInt(v))),
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
  const amounts: bigint[] = await dexRouter(entry).getAmountsOut(
    parseUnits('1', 18),
    [dex.wrapped, dex.usdt],
  );
  return Number(formatUnits(amounts[amounts.length - 1], dex.usdtDecimals));
}

/** Live quote for the entry swap: native coin -> USDT. */
export async function quoteEntrySwap(
  entry: EntryKey,
  amountIn: bigint,
): Promise<bigint> {
  const dex = ENTRY_DEX[entry];
  const amounts: bigint[] = await dexRouter(entry).getAmountsOut(amountIn, [
    dex.wrapped,
    dex.usdt,
  ]);
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
  const qb = await router.quoteBridge(amount);
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

/* ---------------- back half: 42 USDT -> QL1 qCAW --------------- */

export interface BackHalfQuote {
  /** All enabled cross candidates (engine objects, opaque here). */
  candidates: any[];
  bestSingle: any;
  /** Set only when the split plan beats the best single route
   *  AFTER the extra bridge fees (evaluateCrossSplitNet.shown). */
  split: {
    parts: any[];
    totalOut: bigint;
    /** Split output after the extra bridge fees, in qCAW:
     *  best single output + the net verdict's net gain. */
    netOut: bigint;
    netGainPct: number;
  } | null;
  /** Live 42->QL1 bridge message fee per leg, in [42] raw. */
  feePerLeg42: bigint;
  at: number;
}

export async function quoteBackHalf(usdt42Raw: bigint): Promise<BackHalfQuote> {
  const usdt = tokenById('infinite', 'usdt');
  const qcaw = tokenById('ql1', 'qcaw');
  const cands = await quoteCrossPlan('infinite', usdt, 'ql1', qcaw, usdt42Raw);
  const enabled = cands.filter((c: any) => c.enabled);
  if (!enabled.length) throw new Error('no-route');
  const bestSingle = enabled
    .slice()
    .sort((a: any, b: any) => (b.finalOut > a.finalOut ? 1 : -1))[0];
  let split: BackHalfQuote['split'] = null;
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
  let feePerLeg42 = parseUnits(String(BRIDGE_NATIVE_FEE_42_FALLBACK), 18);
  try {
    const q = await fetchBridgeNativeQuote(BRIDGE_PAIRS[0]);
    if (q && q.totalNative > 0n) feePerLeg42 = q.totalNative;
  } catch {
    /* keep the measured fallback */
  }
  return { candidates: cands, bestSingle, split, feePerLeg42, at: Date.now() };
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
    if (!usdtTo42 || !usdtTo42.route) return null;
    // Scale the input by need/actual-received, +5% margin.
    const got = usdtTo42.amountOut > 0n ? usdtTo42.amountOut : 1n;
    let cost = (best.amountOut * need42Raw) / got;
    cost = (cost * 105n) / 100n;
    if (cost <= 0n) cost = best.amountOut;
    return { usdtCost: cost, route: usdtTo42.route };
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
  void amountIn;
  return normTx(
    aggBuildSwapTx(chainObj, fromTok, toTok, route, account, slippagePct, Math.floor(Date.now() / 1000)),
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
  if (wantPath) {
    const wp = wantPath.map((a) => a.toLowerCase()).join(',');
    const match = q.routes.find(
      (r: any) => r.path.map((a: string) => a.toLowerCase()).join(',') === wp,
    );
    if (match) return match;
  }
  return q.routes[0];
}

/** Build a swap tx from a fresh engine route (route amounts rule). */
export function buildRouteSwapTx(
  aggKey: 'infinite' | 'ql1',
  route: any,
  account: string,
  slippagePct: number,
): BuiltTx {
  const chainObj = AGG_CHAINS[aggKey];
  const fromTok = aggTokenByAddress(aggKey, route.path[0]);
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
/* Reverse direction (sell): qCAW -> QOM -> 42 USDT -> target chain   */
/* ------------------------------------------------------------------ */
/* Reverse direction (sell): qCAW -> QOM -> 42 USDT -> target chain   */
/* ------------------------------------------------------------------ */

/**
 * Sell back half: qCAW on QL1 -> USDT on 42 Chain, best route via
 * the ported engine (quoteCrossPlan works QL1 -> infinite; live
 * verified 2026-11-08: 75B qCAW -> ~81.8 USDT via QOM, QL1-side
 * bridge legs carry nativeFee 0 — the QL1 warp routers expose no
 * quote functions and real sends go out with value 0).
 */
export async function quoteBackHalfReverse(
  qcawRaw: bigint,
): Promise<BackHalfQuote> {
  const qcaw = tokenById('ql1', 'qcaw');
  const usdt = tokenById('infinite', 'usdt');
  const cands = await quoteCrossPlan('ql1', qcaw, 'infinite', usdt, qcawRaw);
  const enabled = cands.filter((c: any) => c.enabled);
  if (!enabled.length) throw new Error('no-route');
  const bestSingle = enabled
    .slice()
    .sort((a: any, b: any) => (b.finalOut > a.finalOut ? 1 : -1))[0];
  let split: BackHalfQuote['split'] = null;
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
  return { candidates: cands, bestSingle, split, feePerLeg42: 0n, at: Date.now() };
}

const BRIDGE_OUT_IFACE = new Interface([
  'function quoteBridge(uint256 amount) view returns (uint256 forwardAmount, uint256 tokenFee, uint256 totalRequired)',
  'function quoteNative(uint32 destinationDomain, bytes hookData) view returns (uint256 nativeFee, uint256 hookFee, uint256 totalNative)',
  'function transferRemote(uint32 destinationDomain, bytes32 mintRecipient, uint256 amount, bytes hookMetadata) payable returns (bytes32 messageId)',
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
  const res = await provider.call({ to: BRIDGE_OUT_USDT_42.router, data });
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
  const nRes = await provider.call({ to: BRIDGE_OUT_USDT_42.router, data: nData });
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
    '0x',
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
  const amounts = (await c.getAmountsOut(usdtRaw, [
    dex.usdt,
    dex.wrapped,
  ])) as bigint[];
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
