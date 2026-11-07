/* Verification for the general Send feature + address book
 * (v0.3.5). Run: node scripts/verify-send.mjs
 *
 * READ-ONLY / pure logic only. No keys, NO sends: tx construction
 * is checked as unsigned calldata, the address book runs against
 * an in-memory KV.
 *
 * Checks:
 *  - decimals/address table of SEND_ASSETS vs the chain config it
 *    derives from (USDT_ON, HS_CHAINS, config QCAW);
 *  - ERC-20 transfer calldata: selector 0xa9059cbb + exact
 *    (recipient, amount) encoding, per ERC-20 asset;
 *  - native send construction: { to, data '0x', value };
 *  - recipient validation: checksummed / lowercase accepted and
 *    normalized, bad checksum / short / non-hex / empty rejected;
 *  - MAX math: native leaves the gas reserve (with margin), never
 *    negative; ERC-20 MAX is the full balance; gasAffordable;
 *  - address book: add/list/edit/delete, duplicate prevention
 *    (case-insensitive), validation errors, persistence
 *    round-trip through a fresh store instance on the same KV.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BUILD = new URL('./.build-send', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

execFileSync(
  'npx',
  [
    'tsc', '--ignoreConfig',
    'src/config.ts', 'src/lib/chains.ts', 'src/lib/myActions.ts',
    'src/lib/cawCore.ts', 'src/lib/sendAssets.ts', 'src/lib/addressBook.ts',
    '--module', 'commonjs', '--target', 'es2022',
    '--outDir', BUILD, '--skipLibCheck',
  ],
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'inherit' },
);

const SA = require(BUILD + '/lib/sendAssets.js');
const AB = require(BUILD + '/lib/addressBook.js');
const chains = require(BUILD + '/lib/chains.js');
const cfg = require(BUILD + '/config.js');
const { Interface } = require('ethers');

const RECIP = '0x000000000000000000000000000000000000dEaD';
const E18 = 10n ** 18n;

/* ---------- asset table vs config ---------- */
check('8 send assets', SA.SEND_ASSETS.length === 8);
for (const a of SA.SEND_ASSETS) {
  if (a.kind === 'native') {
    check(
      `${a.id}: native matches HS_CHAINS`,
      a.symbol === chains.HS_CHAINS[a.chain].nativeSymbol && a.decimals === 18 && !a.token,
    );
  } else if (a.symbol === 'USDT') {
    check(
      `${a.id}: USDT matches USDT_ON`,
      a.token === chains.USDT_ON[a.chain].address &&
        a.decimals === chains.USDT_ON[a.chain].decimals,
      `dec=${a.decimals}`,
    );
  } else {
    check(
      `${a.id}: CAW is the QCAW contract, 18 dec`,
      a.token === cfg.QCAW && a.decimals === 18,
    );
  }
}
// The spec's pinned decimals, stated independently of the config:
const decOf = (id) => SA.SEND_ASSETS.find((a) => a.id === id).decimals;
check(
  'pinned decimals: BSC USDT 18 / ETH USDT 6 / 42 USDT 18',
  decOf('bsc:USDT') === 18 && decOf('ethereum:USDT') === 6 && decOf('infinite:USDT') === 18,
);

/* ---------- tx construction ---------- */
const transferIface = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
]);
for (const a of SA.SEND_ASSETS) {
  const amt = 12345n * 10n ** BigInt(a.decimals - 4);
  const tx = SA.buildSendTx(a, RECIP, amt);
  if (a.kind === 'native') {
    check(
      `${a.id}: native tx`,
      tx.to === RECIP && tx.data === '0x' && tx.value === amt,
    );
  } else {
    const decoded = transferIface.decodeFunctionData('transfer', tx.data);
    check(
      `${a.id}: erc20 transfer calldata`,
      tx.to === a.token &&
        tx.value === 0n &&
        tx.data.startsWith('0xa9059cbb') &&
        decoded[0] === RECIP &&
        decoded[1] === amt,
    );
  }
}

/* ---------- recipient validation ---------- */
check('checksummed accepted', SA.normalizeRecipient(RECIP) === RECIP);
check(
  'lowercase accepted + checksummed',
  SA.normalizeRecipient(RECIP.toLowerCase()) === RECIP,
);
check(
  'whitespace trimmed',
  SA.normalizeRecipient('  ' + RECIP + ' \n') === RECIP,
);
// Wrong-case MIXED address = bad EIP-55 checksum -> rejected.
// (The all-caps form '0x…DEAD' is a valid EIP-55 variant and is
// accepted, like all-lowercase.)
check('bad checksum rejected', SA.normalizeRecipient('0x000000000000000000000000000000000000DeaD') === null);
check('all-caps accepted (EIP-55 variant)', SA.normalizeRecipient('0x000000000000000000000000000000000000DEAD') === RECIP);
check('too short rejected', SA.normalizeRecipient('0x1234') === null);
check('non-hex rejected', SA.normalizeRecipient('0xZZZZ00000000000000000000000000000000dEaD') === null);
check('empty rejected', SA.normalizeRecipient('') === null && SA.normalizeRecipient('   ') === null);

/* ---------- MAX / gas math ---------- */
const bnb = SA.SEND_ASSETS.find((a) => a.id === 'bsc:BNB');
const busdt = SA.SEND_ASSETS.find((a) => a.id === 'bsc:USDT');
const gasPrice = 3_000_000_000n; // 3 gwei
const reserve = SA.gasReserve(bnb, gasPrice);
check(
  'native gas reserve = 21000 * price * 1.2 margin',
  reserve === (21000n * gasPrice * 12n) / 10n,
  reserve.toString(),
);
check(
  'native MAX leaves the reserve',
  SA.maxSendable(bnb, E18, gasPrice) === E18 - reserve,
);
check(
  'native MAX floors at 0',
  SA.maxSendable(bnb, reserve / 2n, gasPrice) === 0n,
);
check(
  'erc20 MAX is the full balance',
  SA.maxSendable(busdt, 777n * E18, gasPrice) === 777n * E18,
);
const reserveErc20 = SA.gasReserve(busdt, gasPrice);
check(
  'erc20 gas reserve = 65000 * price * 1.2 margin',
  reserveErc20 === (65000n * gasPrice * 12n) / 10n,
);
check(
  'gasAffordable',
  SA.gasAffordable(busdt, reserveErc20, gasPrice) === true &&
    SA.gasAffordable(busdt, reserveErc20 - 1n, gasPrice) === false,
);

/* ---------- address book ---------- */
const mem = new Map();
const kv = {
  getItem: async (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: async (k, v) => { mem.set(k, v); },
};
const book = new AB.AddressBookStore();
await book.init(kv);
check('book starts empty', book.list().length === 0);
const e1 = await book.add('Exchange', RECIP.toLowerCase());
check('add checksums the address', e1.address === RECIP && book.list().length === 1);
let dupErr = null;
try {
  await book.add('Copy', RECIP);
} catch (e) {
  dupErr = e;
}
check('duplicate prevented (case-insensitive)', dupErr && dupErr.message === 'duplicate');
check('find is case-insensitive', book.find(RECIP.toLowerCase())?.label === 'Exchange');
let badErr = null;
try {
  await book.add('Bad', '0x123');
} catch (e) {
  badErr = e;
}
check('bad address rejected', badErr && badErr.message === 'bad-address');
let labelErr = null;
try {
  await book.add('   ', '0x000000000000000000000000000000000000bEEF');
} catch (e) {
  labelErr = e;
}
check('empty label rejected', labelErr && labelErr.message === 'bad-label');
await book.update(RECIP, 'Main exchange');
check('edit relabels', book.find(RECIP)?.label === 'Main exchange');
// Persistence round-trip: a fresh store over the same KV sees it.
const book2 = new AB.AddressBookStore();
await book2.init(kv);
check(
  'persistence round-trip',
  book2.list().length === 1 && book2.find(RECIP)?.label === 'Main exchange',
);
await book2.remove(RECIP.toLowerCase());
check('delete removes', book2.list().length === 0);
const book3 = new AB.AddressBookStore();
await book3.init(kv);
check('delete persisted', book3.list().length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
