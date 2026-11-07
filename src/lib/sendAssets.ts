/**
 * General send （送る/出金） — asset table + pure send logic (v0.3.5).
 *
 * The eight balances the app already shows become sendable:
 *   BSC: BNB (native), USDT      Ethereum: ETH (native), USDT
 *   42 Chain: 42 (native), USDT  QL1: QOM (native), CAW
 *
 * Decimals and token addresses are NOT re-typed here: USDT comes
 * from USDT_ON (chains.ts), natives from HS_CHAINS, and CAW is the
 * QCAW contract from config.ts (display name is CAW since v0.3.2).
 * This module is Expo-free so scripts/verify-send.mjs can test the
 * construction, validation and MAX math without a phone.
 */
import { getAddress, Interface, isAddress } from 'ethers';

import { QCAW } from '../config';
import {
  HS_CHAINS,
  USDT_ON,
  type HsChainKey,
} from './chains';

export interface SendAsset {
  /** Unique id, e.g. 'bsc:USDT'. */
  id: string;
  chain: HsChainKey;
  /** Plain chain label: 'BSC' | 'Ethereum' | '42 Chain' | 'QL1'. */
  chainLabel: string;
  symbol: string;
  decimals: number;
  kind: 'native' | 'erc20';
  /** ERC-20 contract (erc20 kind only). */
  token?: string;
  /** Field name in hunters' HsBalances for this asset's balance. */
  balKey:
    | 'bscNative'
    | 'bscUsdt'
    | 'ethNative'
    | 'ethUsdt'
    | 'infNative'
    | 'infUsdt'
    | 'ql1Native'
    | 'ql1Qcaw';
}

const native = (
  chain: HsChainKey,
  balKey: SendAsset['balKey'],
): SendAsset => ({
  id: chain + ':' + HS_CHAINS[chain].nativeSymbol,
  chain,
  chainLabel: HS_CHAINS[chain].shortName,
  symbol: HS_CHAINS[chain].nativeSymbol,
  decimals: 18,
  kind: 'native',
  balKey,
});

const usdt = (chain: HsChainKey, balKey: SendAsset['balKey']): SendAsset => ({
  id: chain + ':USDT',
  chain,
  chainLabel: HS_CHAINS[chain].shortName,
  symbol: 'USDT',
  decimals: USDT_ON[chain].decimals,
  kind: 'erc20',
  token: USDT_ON[chain].address,
  balKey,
});

export const SEND_ASSETS: SendAsset[] = [
  native('bsc', 'bscNative'),
  usdt('bsc', 'bscUsdt'),
  native('ethereum', 'ethNative'),
  usdt('ethereum', 'ethUsdt'),
  native('infinite', 'infNative'),
  usdt('infinite', 'infUsdt'),
  native('ql1', 'ql1Native'),
  {
    id: 'ql1:CAW',
    chain: 'ql1',
    chainLabel: HS_CHAINS.ql1.shortName,
    symbol: 'CAW',
    decimals: 18,
    kind: 'erc20',
    token: QCAW,
    balKey: 'ql1Qcaw',
  },
];

export const SEND_CHAINS: HsChainKey[] = [
  'bsc',
  'ethereum',
  'infinite',
  'ql1',
];

/* ---------------- recipient validation ---------------- */

/**
 * Normalize a user-typed recipient: trims whitespace, then applies
 * ethers' isAddress (which rejects bad checksums in mixed-case
 * input) and returns the checksummed form, or null when invalid.
 */
export function normalizeRecipient(raw: string): string | null {
  const t = raw.trim();
  if (!t || !isAddress(t)) return null;
  try {
    return getAddress(t);
  } catch {
    return null;
  }
}

/* ---------------- tx construction ---------------- */

const ERC20_TRANSFER_IFACE = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

export interface SendTxReq {
  to: string;
  data: string;
  value: bigint;
}

/** Build the unsigned tx for a send. Native: plain value transfer.
 *  ERC-20: transfer(address,uint256) to the token contract. */
export function buildSendTx(
  asset: SendAsset,
  to: string,
  amountRaw: bigint,
): SendTxReq {
  const recipient = getAddress(to);
  if (asset.kind === 'native') {
    return { to: recipient, data: '0x', value: amountRaw };
  }
  const data = ERC20_TRANSFER_IFACE.encodeFunctionData('transfer', [
    recipient,
    amountRaw,
  ]);
  return { to: asset.token!, data, value: 0n };
}

/* ---------------- gas + MAX math ---------------- */

/** Gas units budgeted for a plain send (display + MAX reserve). */
export const SEND_GAS_UNITS: Record<SendAsset['kind'], bigint> = {
  native: 21000n,
  erc20: 65000n,
};

/** Extra headroom on the reserve so MAX does not strand the send
 *  when the gas price ticks up between quoting and signing. */
const GAS_MARGIN_NUM = 12n;
const GAS_MARGIN_DEN = 10n;

/** Wei set aside for this send's gas at the given gas price. */
export function gasReserve(asset: SendAsset, gasPrice: bigint): bigint {
  const base = SEND_GAS_UNITS[asset.kind] * gasPrice;
  return (base * GAS_MARGIN_NUM) / GAS_MARGIN_DEN;
}

/**
 * The most that can actually be sent:
 * - native coin: balance minus the gas reserve (MAX leaves gas
 *   behind — the same idea as HuntersSwap's gas-keep, computed
 *   from the live gas price instead of a USD rule);
 * - ERC-20: the full token balance (gas is paid in the chain's
 *   native coin, separately — see gasAffordable).
 * Never negative.
 */
export function maxSendable(
  asset: SendAsset,
  balance: bigint,
  gasPrice: bigint,
): bigint {
  if (asset.kind === 'erc20') return balance;
  const left = balance - gasReserve(asset, gasPrice);
  return left > 0n ? left : 0n;
}

/** Can this chain's native balance pay this send's gas reserve? */
export function gasAffordable(
  asset: SendAsset,
  nativeBalance: bigint,
  gasPrice: bigint,
): boolean {
  return nativeBalance >= gasReserve(asset, gasPrice);
}
