/**
 * HuntersExchange order book (v0.5.0) — the app side of
 * contracts/HuntersExchange.sol, per the design memo
 * (~/workspace/huntersexchange/DESIGN.md, 2026-11-10).
 *
 * Model: pre-deposited escrow on 42 Chain + EIP-712 signed
 * orders stored/displayed by the order server (worker/ in
 * this repo). The server NEVER custodies anything: fills are
 * settled by the immutable contract against the maker's
 * signature, and escrow withdrawal works with every server
 * down. Pair: USDT (42 Chain) ⇄ CAW (the bridged CAW token
 * on 42 Chain); the book merges both order directions.
 *
 * Deployment is the user's step (no keys in the build
 * environment): the Exchange screen deploys the contract
 * with the user's own wallet (SplitSwap in-app deploy
 * precedent), stores the address on-device, and only then
 * shows a live book. CANDIDATE DEFAULTS (2026-11-10, marked
 * where used): trading fee 0 (the contract has no fee code);
 * filled-CAW delivery default = bridge back to QL1 qCAW;
 * minimum-order guide from the memo's formula with the
 * provisional acceptable-fee-rate below (仮).
 */
import {
  Contract,
  Interface,
  TypedDataEncoder,
  Wallet,
  getBytes,
  type TypedDataField,
} from 'ethers';

import { EXCHANGE_SERVER_URL } from '../config';
import { USDT_ON } from './chains';
import { providerFor, WQOM_ADDR, type TxReq } from './hunters';
import { EXCHANGE_ABI, EXCHANGE_BYTECODE } from './exchangeBytecode';
import type { KVStorage } from './myActions';

/** The bridged CAW token on 42 Chain ("A Hunters Dream",
 *  18 dp) and the CAW BridgeRouter for 42 -> QL1 sends.
 *  Both verified for the design memo (DESIGN.md §2) and
 *  identical to the aggregator's token table
 *  (lib/aggEngine.ts: id "caw", br 0x82ba…). */
const CAW_42_TOKEN = '0xce8aEE7148DaA8943453239C42B7b93f984A49F0';
const CAW_BRIDGE_ROUTER_42 = '0x82bA5D61a70677f7f53A9894C63DfB61FD8bCb65';
const USDT_42 = USDT_ON.infinite.address;

/* ---------------- pair + constants ---------------- */

export const HX_USDT = USDT_42;
export const HX_CAW = CAW_42_TOKEN;
export const HX_USDT_DECIMALS = 18; // 42 Chain USDT (app registry)
export const HX_CAW_DECIMALS = 18;
export const HX_CHAIN_ID = 421018;

/** Expiry choices on the order form (mock v050_06): 24h/7d/28d. */
export const HX_EXPIRY_OPTIONS_SEC = [86_400, 604_800, 2_419_200];

/**
 * CANDIDATE DEFAULT — provisional acceptable fee rate for the
 * minimum-order guide, in basis points (仮, design memo §5:
 * the real value waits on measured fill-size distribution).
 * Guide threshold = round-trip fixed cost ÷ this rate.
 */
export const HX_MIN_FEE_RATE_BPS_PROVISIONAL = 100; // 1%
/** Used when the [42] price cannot be quoted: 10 USDT (仮). */
export const HX_MIN_ORDER_FALLBACK_USDT_RAW = 10n * 10n ** 18n;

/* ---------------- orders ---------------- */

export interface HxOrder {
  maker: string;
  tokenGive: string;
  amountGive: bigint;
  tokenGet: string;
  amountGet: bigint;
  /** Unix seconds; 0 = never. Orders from the form always set one. */
  expiry: number;
  /** Maker-chosen uniqueness, decimal string. */
  nonce: string;
}

export interface HxSerializedOrder {
  maker: string;
  tokenGive: string;
  amountGive: string;
  tokenGet: string;
  amountGet: string;
  expiry: number;
  nonce: string;
}

export function serializeOrder(o: HxOrder): HxSerializedOrder {
  return {
    maker: o.maker,
    tokenGive: o.tokenGive,
    amountGive: o.amountGive.toString(),
    tokenGet: o.tokenGet,
    amountGet: o.amountGet.toString(),
    expiry: o.expiry,
    nonce: o.nonce,
  };
}

export function deserializeOrder(s: HxSerializedOrder): HxOrder {
  return {
    maker: s.maker,
    tokenGive: s.tokenGive,
    amountGive: BigInt(s.amountGive),
    tokenGet: s.tokenGet,
    amountGet: BigInt(s.amountGet),
    expiry: s.expiry,
    nonce: s.nonce,
  };
}

/** Signed order as stored by the order server. */
export interface HxListedOrder {
  order: HxSerializedOrder;
  signature: string;
}

export const HX_ORDER_TYPES: Record<string, TypedDataField[]> = {
  Order: [
    { name: 'maker', type: 'address' },
    { name: 'tokenGive', type: 'address' },
    { name: 'amountGive', type: 'uint256' },
    { name: 'tokenGet', type: 'address' },
    { name: 'amountGet', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

export function hxDomain(contract: string) {
  return {
    name: 'HuntersExchange',
    version: '1',
    chainId: HX_CHAIN_ID,
    verifyingContract: contract,
  } as const;
}

function orderValue(o: HxOrder) {
  return {
    maker: o.maker,
    tokenGive: o.tokenGive,
    amountGive: o.amountGive,
    tokenGet: o.tokenGet,
    amountGet: o.amountGet,
    expiry: BigInt(o.expiry),
    nonce: BigInt(o.nonce),
  };
}

/** The EIP-712 digest the contract's fill() verifies. */
export function hxOrderHash(contract: string, o: HxOrder): string {
  return TypedDataEncoder.hash(
    hxDomain(contract),
    HX_ORDER_TYPES,
    orderValue(o),
  );
}

export async function hxSignOrder(
  wallet: Wallet,
  contract: string,
  o: HxOrder,
): Promise<string> {
  return wallet.signTypedData(
    hxDomain(contract),
    HX_ORDER_TYPES,
    orderValue(o),
  );
}

/**
 * Cancel authorisation for the order server: the maker signs
 * the order hash as a personal message. The on-chain kill
 * switch is cancelOrder(); this signature only lets the
 * server drop the listing early.
 */
export async function hxSignCancel(
  wallet: Wallet,
  contract: string,
  o: HxOrder,
): Promise<string> {
  return wallet.signMessage(getBytes(hxOrderHash(contract, o)));
}

/** True when the order's pair side is one of the two book tokens. */
export function hxIsPairOrder(o: HxOrder): boolean {
  const g = o.tokenGive.toLowerCase();
  const t = o.tokenGet.toLowerCase();
  return (
    (g === HX_USDT.toLowerCase() && t === HX_CAW.toLowerCase()) ||
    (g === HX_CAW.toLowerCase() && t === HX_USDT.toLowerCase())
  );
}

/** The order's USDT-denominated side, raw (18 dp). */
export function hxOrderUsdtValue(o: HxOrder): bigint {
  return o.tokenGive.toLowerCase() === HX_USDT.toLowerCase()
    ? o.amountGive
    : o.amountGet;
}

/**
 * Unit price of an order: USDT raw (18 dp) per 1 whole CAW,
 * scaled by 1e18 — priceRaw = usdtRaw * 1e18 / cawWholeRaw…
 * precisely: (usdtSide * 10^18) / cawSide gives USDT-raw per
 * 1 CAW-raw × 10^18; dividing by 10^18 in display yields USDT
 * per whole CAW as a decimal. Used for book sorting only.
 */
export function hxOrderPriceScaled(o: HxOrder): bigint {
  const usdt = hxOrderUsdtValue(o);
  const caw =
    o.tokenGive.toLowerCase() === HX_CAW.toLowerCase()
      ? o.amountGive
      : o.amountGet;
  if (caw === 0n) return 0n;
  return (usdt * 10n ** 18n) / caw;
}

/* ---------------- minimum-order guide (memo §5) ---------------- */

/**
 * The memo's formula: minimum sensible order value =
 * round-trip fixed cost ÷ acceptable fee rate, so the fixed
 * costs of trading + delivery stay under the rate of the
 * order's value. Round-trip fixed cost here = the delivery
 * bridge's relay fee in [42] (the bridge's own token fee is
 * 0), converted at the quoted [42] price. Both inputs are
 * measured at order time; when the price cannot be quoted
 * the provisional fallback applies. Returns USDT raw (18 dp).
 * CANDIDATE DEFAULT: rate = HX_MIN_FEE_RATE_BPS_PROVISIONAL.
 */
export function hxMinOrderUsdtRaw(
  relay42Raw: bigint | null,
  price42UsdtRaw: bigint | null,
): bigint {
  if (relay42Raw === null || price42UsdtRaw === null) {
    return HX_MIN_ORDER_FALLBACK_USDT_RAW;
  }
  const costUsdtRaw = (relay42Raw * price42UsdtRaw) / 10n ** 18n;
  const rate = BigInt(HX_MIN_FEE_RATE_BPS_PROVISIONAL);
  return (costUsdtRaw * 10_000n + rate - 1n) / rate;
}

export function hxBelowMinOrder(o: HxOrder, minUsdtRaw: bigint): boolean {
  return hxOrderUsdtValue(o) < minUsdtRaw;
}

/* ---------------- deployed-address store ---------------- */

const HX_ADDRESS_KEY = 'caw-exchange-address-v1';
let hxKv: KVStorage | null = null;
let hxAddressCache: string | null = null;

export function initExchangeStore(kv: KVStorage): void {
  hxKv = kv;
}

export async function loadExchangeAddress(): Promise<string | null> {
  if (hxAddressCache !== null) return hxAddressCache;
  if (!hxKv) return null;
  try {
    const v = await hxKv.getItem(HX_ADDRESS_KEY);
    hxAddressCache = v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null;
  } catch {
    hxAddressCache = null;
  }
  return hxAddressCache;
}

export async function saveExchangeAddress(addr: string): Promise<void> {
  hxAddressCache = addr;
  if (hxKv) {
    try {
      await hxKv.setItem(HX_ADDRESS_KEY, addr);
    } catch {
      // The in-memory copy still serves this session.
    }
  }
}

export function exchangeAddressSync(): string | null {
  return hxAddressCache;
}

/* ---------------- on-chain reads / validation ---------------- */

const hxIface = new Interface(EXCHANGE_ABI as unknown as any[]);

function hxContract(contract: string): Contract {
  return new Contract(
    contract,
    EXCHANGE_ABI as unknown as any[],
    providerFor('infinite'),
  );
}

/**
 * Prove an address really is a HuntersExchange deployment:
 * code present AND the immutable pair constants point at the
 * verified tokens (the memo's addresses).
 */
export async function validateExchangeAddress(
  addr: string,
): Promise<boolean> {
  try {
    const p = providerFor('infinite');
    const code = await p.getCode(addr);
    if (!code || code === '0x') return false;
    const c = hxContract(addr);
    const usdt = (await c.USDT()) as string;
    const caw = (await c.CAW()) as string;
    return (
      usdt.toLowerCase() === HX_USDT.toLowerCase() &&
      caw.toLowerCase() === HX_CAW.toLowerCase()
    );
  } catch {
    return false;
  }
}

export async function hxEscrowBalances(
  contract: string,
  who: string,
): Promise<{ usdt: bigint; caw: bigint }> {
  const c = hxContract(contract);
  const [usdt, caw] = await Promise.all([
    c.balanceOf(HX_USDT, who) as Promise<bigint>,
    c.balanceOf(HX_CAW, who) as Promise<bigint>,
  ]);
  return { usdt, caw };
}

export async function hxFilled(
  contract: string,
  orderHash: string,
): Promise<bigint> {
  const c = hxContract(contract);
  return (await c.filled(orderHash)) as bigint;
}

export async function hxCancelled(
  contract: string,
  orderHash: string,
): Promise<boolean> {
  const c = hxContract(contract);
  return (await c.cancelled(orderHash)) as boolean;
}

/* ---------------- transaction builders ---------------- */

export function hxDepositData(token: string, amount: bigint): string {
  return hxIface.encodeFunctionData('deposit', [token, amount]);
}

export function hxWithdrawData(token: string, amount: bigint): string {
  return hxIface.encodeFunctionData('withdraw', [token, amount]);
}

export function hxFillData(
  o: HxOrder,
  signature: string,
  giveAmount: bigint,
): string {
  return hxIface.encodeFunctionData('fill', [
    {
      maker: o.maker,
      tokenGive: o.tokenGive,
      amountGive: o.amountGive,
      tokenGet: o.tokenGet,
      amountGet: o.amountGet,
      expiry: BigInt(o.expiry),
      nonce: BigInt(o.nonce),
    },
    signature,
    giveAmount,
  ]);
}

export function hxCancelData(o: HxOrder): string {
  return hxIface.encodeFunctionData('cancelOrder', [
    {
      maker: o.maker,
      tokenGive: o.tokenGive,
      amountGive: o.amountGive,
      tokenGet: o.tokenGet,
      amountGet: o.amountGet,
      expiry: BigInt(o.expiry),
      nonce: BigInt(o.nonce),
    },
  ]);
}

/**
 * Delivery of filled CAW back to QL1 qCAW (CANDIDATE DEFAULT
 * for received CAW): the CAW-specific Hyperlane route on the
 * 42-side BridgeRouter — token fee 0, native relay fee quoted
 * live (paid in [42], shown before confirming). Mirrors the
 * shipped hunters.ts bridge-out construction.
 */
export async function buildCawDeliveryTx(
  amountRaw: bigint,
  recipient: string,
): Promise<TxReq> {
  const p = providerFor('infinite');
  const router = new Contract(
    CAW_BRIDGE_ROUTER_42,
    [
      'function quoteNativeFee(uint32 destination, bytes32 to, uint256 gasAmount) view returns (uint256)',
      'function bridgeToken(address to, uint32 destination, address token, uint256 tokenAmount, uint256 nativeFee) payable returns (bytes32)',
    ],
    p,
  );
  const fee = (await router.quoteNativeFee(
    766,
    '0x' + recipient.replace(/^0x/, '').toLowerCase().padStart(64, '0'),
    0,
  )) as bigint;
  const data = router.interface.encodeFunctionData('bridgeToken', [
    recipient,
    766,
    HX_CAW,
    amountRaw,
    fee,
  ]);
  return { to: CAW_BRIDGE_ROUTER_42, data, value: fee };
}

/** The delivery relay fee alone (for the confirm sheet). */
export async function quoteCawDeliveryFee(
  recipient: string,
): Promise<bigint> {
  const p = providerFor('infinite');
  const router = new Contract(
    CAW_BRIDGE_ROUTER_42,
    [
      'function quoteNativeFee(uint32 destination, bytes32 to, uint256 gasAmount) view returns (uint256)',
    ],
    p,
  );
  return (await router.quoteNativeFee(
    766,
    '0x' + recipient.replace(/^0x/, '').toLowerCase().padStart(64, '0'),
    0,
  )) as bigint;
}

/* ---------------- reference quotes ---------------- */

const V2_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function WETH() view returns (address)',
];

/**
 * Reference price (memo §4): QomSwap quote for 1,000,000,000
 * CAW on QL1, path CAW → WQOM → USDT(QL1, 6 dp). Returns USDT
 * raw (6 dp) received for 1e9 CAW, or null when unquotable.
 */
export async function hxReferenceCawQuote(): Promise<bigint | null> {
  try {
    const c = new Contract(
      '0xc1f90231035A52091eBCb7dddaCa3051a5F44f30',
      V2_ROUTER_ABI,
      providerFor('ql1'),
    );
    const amounts = (await c.getAmountsOut(1_000_000_000n * 10n ** 18n, [
      '0xd2140E16aDf37194036865E90BbCA1139b739d0D',
      WQOM_ADDR,
      USDT_ON.ql1.address,
    ])) as bigint[];
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

/**
 * [42] price in USDT raw (18 dp) per 1 whole [42], from the
 * Infinite router (WETH() = wrapped [42]). Null when the pair
 * cannot be quoted — the min-order guide then falls back.
 */
export async function hxPrice42UsdtRaw(): Promise<bigint | null> {
  try {
    const c = new Contract(
      '0xBF07dFE35746894bAe373f63f4Bf2379F9BaFEc0',
      V2_ROUTER_ABI,
      providerFor('infinite'),
    );
    const w = (await c.WETH()) as string;
    const amounts = (await c.getAmountsOut(10n ** 18n, [
      w,
      HX_USDT,
    ])) as bigint[];
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

/* ---------------- order server client ---------------- */

export function hxServerConfigured(): boolean {
  return EXCHANGE_SERVER_URL !== '';
}

async function hxFetchJson(
  path: string,
  init?: RequestInit,
): Promise<any> {
  const res = await fetch(EXCHANGE_SERVER_URL + path, {
    ...init,
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok) throw new Error('hx-server-' + res.status);
  return res.json();
}

export async function hxFetchBook(
  contract: string,
): Promise<HxListedOrder[]> {
  const j = await hxFetchJson(
    '/book?contract=' + encodeURIComponent(contract),
  );
  return (j.orders || []) as HxListedOrder[];
}

export async function hxFetchMyOrders(
  contract: string,
  maker: string,
): Promise<HxListedOrder[]> {
  const j = await hxFetchJson(
    '/orders?contract=' +
      encodeURIComponent(contract) +
      '&maker=' +
      encodeURIComponent(maker),
  );
  return (j.orders || []) as HxListedOrder[];
}

export async function hxPostOrder(
  contract: string,
  listed: HxListedOrder,
): Promise<void> {
  await hxFetchJson('/orders', {
    method: 'POST',
    body: JSON.stringify({ contract, ...listed }),
  });
}

export async function hxPostCancel(
  contract: string,
  order: HxOrder,
  cancelSignature: string,
): Promise<void> {
  await hxFetchJson('/cancel', {
    method: 'POST',
    body: JSON.stringify({
      contract,
      order: serializeOrder(order),
      signature: cancelSignature,
    }),
  });
}
