/**
 * Multi-chain constants for HuntersSwap (v0.3.0).
 *
 * The app was QL1-only before v0.3.0; HuntersSwap adds read/write
 * access to BSC (56), Ethereum (1) and 42 Chain (421018) with the
 * SAME wallet address (one EVM key works on every EVM chain).
 *
 * Every address below is copied from a verified source in this
 * workspace, not from memory:
 *  - BSC / Ethereum chains + PancakeSwap: GuppyWallet
 *    (~/workspace/infinite-ql1-wallet/src/config/chains.ts,
 *    on-chain verified 2026-10-30 / 2026-11-01)
 *  - Inbound bridge routers (BSC/ETH USDT -> 42): GuppyWallet
 *    lib/zaphod.ts BRIDGE_INBOUND, cross-checked against
 *    ~/workspace/guppy-bridge/src/config.js (bridgeRouter fields
 *    match exactly)
 *  - 42 Chain USDT + the -2 USDT arrival deduction: GuppyWallet
 *    INFINITE_CONTRACTS.bridgeRouterUsdt (feeFlat 2 USDT, min 1)
 *    and the live quoteBridge check in the HuntersSwap plan.
 *
 * NOTE: keep this module free of Expo-runtime imports — the Node
 * verification harness compiles and loads it outside React Native.
 */

export type HsChainKey = 'bsc' | 'ethereum' | 'infinite' | 'ql1';
export type EntryKey = 'bsc' | 'ethereum';

export interface HsChainDef {
  key: HsChainKey;
  chainId: number;
  /** Short plain label suffix, e.g. "BSC". Display names are i18n'd. */
  shortName: string;
  nativeSymbol: string;
  rpcs: string[];
}

export const HS_CHAINS: Record<HsChainKey, HsChainDef> = {
  bsc: {
    key: 'bsc',
    chainId: 56,
    shortName: 'BSC',
    nativeSymbol: 'BNB',
    rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'],
  },
  ethereum: {
    key: 'ethereum',
    chainId: 1,
    shortName: 'Ethereum',
    nativeSymbol: 'ETH',
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  },
  infinite: {
    key: 'infinite',
    chainId: 421018,
    shortName: '42 Chain',
    nativeSymbol: '42',
    rpcs: [
      'https://evm-rpc.infinitedrive.xyz',
      'https://evm-rpc-infinite.mschihuahua.org',
    ],
  },
  ql1: {
    key: 'ql1',
    chainId: 766,
    shortName: 'QL1',
    nativeSymbol: 'QOM',
    rpcs: ['https://evm-rpc-ql1.mschihuahua.org'],
  },
};

export interface TokenDef {
  address: string;
  decimals: number;
  symbol: string;
}

/** PancakeSwap V2 on BSC (GuppyWallet BSC_DEX, verified 2026-11-01). */
export const BSC_DEX = {
  router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  wrapped: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
  usdt: '0x55d398326f99059fF775485246999027B3197955',
  usdtDecimals: 18, // BSC USDT is 18 decimals (NOT 6)
} as const;

/** Uniswap V2 on Ethereum mainnet (same router family as PancakeSwap). */
export const ETH_DEX = {
  router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  wrapped: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT, 6 decimals
  usdtDecimals: 6,
} as const;

export const ENTRY_DEX: Record<EntryKey, typeof BSC_DEX | typeof ETH_DEX> = {
  bsc: BSC_DEX,
  ethereum: ETH_DEX,
};

/** USDT on each chain HuntersSwap touches. */
export const USDT_ON: Record<HsChainKey, TokenDef> = {
  bsc: { address: BSC_DEX.usdt, decimals: 18, symbol: 'USDT' },
  ethereum: { address: ETH_DEX.usdt, decimals: 6, symbol: 'USDT' },
  infinite: {
    address: '0xC2684966e5c95B2bc636FB4a1f3Da9Ad23d94753',
    decimals: 18,
    symbol: 'USDT',
  },
  // QL1 has no plain USDT in this flow; the back half ends in qCAW.
  ql1: {
    address: '0xc276b91c0e8d10260af7b67009d2683bb7776308',
    decimals: 6,
    symbol: 'qUSDT',
  },
};

/**
 * Inbound bridge (source chain -> 42 Chain) for USDT.
 * `router` is the Zaphod BridgeRouter on the SOURCE chain: approve
 * the USDT to it and call transferRemote(421018, recipient32, amt).
 * These routers (v1.1.0 BSC / v1.2.0 ETH) REVERT quoteNative; the
 * official frontend sends with message fee 0 and so do we
 * (the nativeOptional pattern from GuppyWallet).
 */
export const BRIDGE_IN_USDT: Record<
  EntryKey,
  { router: string; token: string; tokenDecimals: number }
> = {
  bsc: {
    router: '0x2f136BaA37Eb5711483D295944EeDa01c4142dA0',
    token: BSC_DEX.usdt,
    tokenDecimals: 18,
  },
  ethereum: {
    router: '0x56d962fD360bA872115e77E3316909037bfB7E7E',
    token: ETH_DEX.usdt,
    tokenDecimals: 6,
  },
};

/** Hyperlane domain of 42 Chain (= its EVM chain id). */
export const DOMAIN_42 = 421018;

/**
 * What the 42-side USDT BridgeRouter keeps on arrival: sending
 * X USDT from BSC/ETH delivers X - 2 USDT on 42 Chain (flat fee,
 * owner-set; measured live, quoteBridge(100) = forward 98 / fee 2).
 */
export const BRIDGE_IN_FEE_USDT = 2;

/**
 * Recommended native balance to keep for gas, in USD — the
 * GuppyWallet guide (BRIDGE_GAS_MIN_USD, measured basis 2026-11-01).
 * HuntersSwap rule (user decision 2026-11-08): BSC keeps $3 or
 * more (the swap + approve + bridge sends together cost more than
 * the bare $1 bridge guide); ETH entry is $100+ only.
 */
export const BRIDGE_GAS_MIN_USD: Record<EntryKey, number> = {
  bsc: 1,
  ethereum: 10,
};
export const BSC_GAS_KEEP_USD = 3;
export const ETH_MIN_ENTRY_USD = 100;

/** Fallback for the 42->QL1 bridge message fee, in [42], per leg.
 *  The live value is re-read before every send (quoteNative); this
 *  is only the planning figure measured 2026-11-07/08. */
export const BRIDGE_NATIVE_FEE_42_FALLBACK = 2.947;

/** Extra [42] kept per bridge leg for 42-Chain gas on top of the
 *  bridge message fee (42 gas is tiny; this is a wide margin). */
export const CARVE_GAS_MARGIN_42 = 0.3;

/**
 * Outbound bridge 42 Chain -> BSC / Ethereum for USDT.
 * The 42-side USDT BridgeRouter (GuppyWallet INFINITE_CONTRACTS.
 * bridgeRouterUsdt; live re-verified 2026-11-08):
 * quoteBridge(100) = forward 98 / fee 2.0 / totalRequired 100 —
 * the flat 2 USDT is taken inside the send — and
 * quoteNative(56) = quoteNative(1) = 0 (no message fee).
 */
export const BRIDGE_OUT_USDT_42 = {
  router: '0x8667682B62CacedA9e87B3CAA21D5B09D9Ae13c3',
  token: '0xC2684966e5c95B2bc636FB4a1f3Da9Ad23d94753',
  feeUsdt: 2,
} as const;

/** Hyperlane domains of the exit target chains. */
export const TARGET_DOMAIN: Record<EntryKey, number> = {
  bsc: 56,
  ethereum: 1,
};
