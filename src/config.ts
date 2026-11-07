/**
 * CAW Social (QL1) — chain constants.
 * QL1 only: this app is fixed to the QL1 chain (EVM chain id 766).
 */
export const RPC = 'https://evm-rpc-ql1.mschihuahua.org';
export const API = 'https://scan.qom.network/api/v2';
export const EXPLORER = 'https://scan.qom.network';
export const CHAIN_ID = 766;

export const CAW_NAME = '0x864f08Af11F6DC2c0De42562e4664d4f033D393f';
export const CAW_ACTIONS = '0x95c2AFEc2dE8b09323Cdc7E40Bcce42C3C49E496';
export const MINTER = '0xFC2f8743E3b09a6c973B114c3a082433e974eD9f';
export const QCAW = '0xd2140E16aDf37194036865E90BbCA1139b739d0D';
export const ACTION_SELECTOR = '0x84e33f2f';

/** Function selectors used by the app (same values as the web front end). */
export const SEL = {
  usernames: '0x136dd963',
  ownerOf: '0x6352211e',
  tokens: '0xe4860339',
  tokenURI: '0xc87b56dd',
  cawBalanceOf: '0x532f3a34',
  totalSupply: '0x18160ddd',
  balanceOf: '0x70a08231',
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

/** Brand accent (same orange as the web version). */
export const ACCENT = '#e8590c';
