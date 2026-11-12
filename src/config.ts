/**
 * CAW Social (QL1) — chain constants.
 * QL1 only: this app is fixed to the QL1 chain (EVM chain id 766).
 *
 * NOTE: keep this module free of Expo-runtime imports — the Node
 * verification harness (scripts/verify-*.mjs) compiles and loads it
 * outside React Native. The app version lives in lib/appVersion.ts
 * for the same reason.
 */
export const RPC = 'https://evm-rpc-ql1.mschihuahua.org';
/**
 * Second, INDEPENDENT QL1 read endpoint (v0.5.0-fix, audit
 * M1): the QL1 explorer's own eth-rpc proxy (Blockscout,
 * scan.qom.network) — a different operator and stack from
 * the primary community node above. Verified live
 * 2026-11-11: chainId answers 766, its block height tracks
 * the primary's, and ownerOf(190) on CAW_NAME returns the
 * identical address through both. Used ONLY as a cross-check
 * where a single RPC's word moves money by itself (the CAT42
 * tip recipient) — general reads keep using the primary.
 */
export const RPC_ALT = 'https://scan.qom.network/api/eth-rpc';
export const API = 'https://scan.qom.network/api/v2';
export const EXPLORER = 'https://scan.qom.network';
export const CHAIN_ID = 766;

export const CAW_NAME = '0x864f08Af11F6DC2c0De42562e4664d4f033D393f';
export const CAW_ACTIONS = '0x95c2AFEc2dE8b09323Cdc7E40Bcce42C3C49E496';

/**
 * HuntersExchange order-server base URL (v0.5.0). EMPTY until
 * the order-book Worker (worker/ in this repo) is deployed and
 * its URL is filled in here — the Exchange screen shows an
 * honest "server not connected" state meanwhile; escrow
 * deposit / withdraw / fill / cancel are pure on-chain calls
 * and never depend on this server. Custom-domain wiring waits
 * on the user's domain purchase (pending, 2026-11-10).
 */
export const EXCHANGE_SERVER_URL = '';

/**
 * Post view counter base URL (v0.6.0). EMPTY until the views
 * Worker (worker/views/ in this repo) is deployed and its
 * URL is filled in here — the same activation pattern as the
 * order book above. While empty, post rows render NO views
 * element at all: view counts are an app-side aggregation
 * (they are not, and cannot be, on-chain), and the app never
 * shows a number it did not actually get from the counter.
 */
export const VIEWS_COUNTER_URL = '';
export const MINTER = '0xFC2f8743E3b09a6c973B114c3a082433e974eD9f';
export const QCAW = '0xd2140E16aDf37194036865E90BbCA1139b739d0D';
/** CAT42 on 42 Chain (18 decimals) — the SuperLike currency.
 *  Same contract the aggregator engine lists (aggEngine tokens). */
export const CAT42 = '0x7386719EBbBeB4d810fF89027Bfb8A1CDf696310';
/** O ("Childhoods End", symbol O) at the address the user
 *  supplied: 0x6c39…bbEd4. Verified live 2026-11-10 (v0.4.10):
 *  that address is a QL1 contract — code, symbol() "O" and
 *  decimals() 18 answer on the QL1 RPC, and the aggregator's
 *  QL1 table lists this exact address as "O / Childhoods End".
 *  The same address has NO code on 42 Chain, so the balance is
 *  read over the QL1 RPC, never rpc42. (A different "O" exists
 *  on 42 Chain at 0xf4c1…c156; it is not the one the user
 *  named.) Decimals are still read from the contract at
 *  runtime, never assumed. */
export const O_TOKEN = '0x6c39b68a28bA90F4EB80032ec0eB32ad81cbbEd4';
/** KET on 42 Chain, resolved from the aggregator's 42 Chain
 *  token table (aggEngine CHAINS.infinite.tokens) and verified
 *  live 2026-11-10 (v0.4.10): code present on 42 Chain,
 *  symbol() "KET", decimals() 18 (read at runtime, not
 *  assumed). The QL1 table's KET (0x034c…1fb4) is a different
 *  contract and is NOT used here. */
export const KET42 = '0xb749d42e6004db590b2f04f32b87485402a061e2';
export const ACTION_SELECTOR = '0x84e33f2f';

/** Function selectors used by the app (same values as the web front end). */
export const SEL = {
  usernames: '0x136dd963',
  ownerOf: '0x6352211e',
  tokenOfOwnerByIndex: '0x2f745c59',
  tokenURI: '0xc87b56dd',
  cawBalanceOf: '0x532f3a34',
  totalSupply: '0x18160ddd',
  balanceOf: '0x70a08231',
  decimals: '0x313ce567',
  allowance: '0xdd62ed3e',
  approve: '0x095ea7b3',
  transfer: '0xa9059cbb',
  costOfName: '0x8c87aa8a',
  idByUsername: '0x9ebf19e8',
  isValidUsername: '0x3b032005',
  followerCount: '0x9f46a705',
  likes: '0x14ce3e7d',
  mint: '0xd85d3d27',
  deposit: '0x6170c4b1',
  withdraw: '0x43387983',
} as const;

/**
 * Brand accent. v0.6.0 (X-style overhaul): the accent is now
 * X blue — the same single constant drives every existing
 * accent usage (buttons, links, the active tab), so the whole
 * app picks up the new accent without per-screen restyles.
 * (Before v0.6.0 this was the web version's orange, #e8590c.)
 */
export const ACCENT = '#1D9BF0';

/* X-style design tokens (v0.6.0). The palette the X overhaul
 * is built from: white light surface / pure-black dark
 * surface, hairline dividers, near-black ink, one secondary
 * gray, the blue accent above, and a gold reserved for the
 * SuperLike star — never for anything else. The app ships a
 * light UI today (no theme switcher exists), so the dark
 * surface is defined here for the token set's completeness;
 * screens read the light values through components/ui.tsx. */
export const X_BLUE = '#1D9BF0';
export const X_GOLD = '#FFAC33';
export const X_INK = '#0F1419';
export const X_SECONDARY = '#536471';
export const X_HAIRLINE = '#EFF3F4';
export const X_BG_LIGHT = '#FFFFFF';
export const X_BG_DARK = '#000000';
