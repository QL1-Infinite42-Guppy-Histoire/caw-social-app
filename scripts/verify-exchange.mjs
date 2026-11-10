#!/usr/bin/env node
/**
 * HuntersExchange verification (v0.5.0).
 *
 * Three layers:
 *  1. The app-side order codec (lib/exchange.ts): serialize /
 *     deserialize round-trip, pair checks, cross-side price
 *     consistency, the minimum-order guide (memo §5 formula +
 *     fallback), and the deployed-address validation against
 *     a stubbed 42 Chain RPC.
 *  2. The order server (worker/): order-shape validation,
 *     apply / cancel / live-book / committed-give logic, and
 *     the signature checks — an order signed by the app-side
 *     signer must verify in the Worker's verifier, and the
 *     app, Worker and contract order hashes must all agree.
 *  3. The escrow contract on a LOCAL ganache EVM (chain id
 *     421018): the pair tokens are mock ERC-20s whose code is
 *     placed at the contract's constant USDT/CAW addresses
 *     (evm_setAccountCode) with seeded balances, so the REAL
 *     shipped bytecode runs unmodified. Deposit / withdraw /
 *     partial fill / overfill / expiry / cancel / bad
 *     signature are exercised end-to-end. Every call is a
 *     direct contract call — no server exists in this layer,
 *     which is exactly the server-down guarantee.
 *
 * Candidate defaults pinned here: trading fee 0 (the
 * contract has no fee code — a fill moves exactly the
 * proportional amount), min-order provisional rate 100 bps
 * (1%, labelled 仮 in the source).
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = ROOT + '/scripts/.build-exchange';
let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log('  ok  ' + label);
  } else {
    fail++;
    console.log('  FAIL ' + label);
  }
}
async function expectRevert(fn, label) {
  try {
    await fn();
    ok(false, label + ' (did not revert)');
  } catch {
    ok(true, label);
  }
}

/* ---------- compile the app graph ---------- */
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
try {
  execFileSync(
    'npx',
    [
      'tsc',
      '--ignoreConfig',
      'src/config.ts',
      'src/lib/cawCore.ts',
      'src/lib/myActions.ts',
      'src/lib/chains.ts',
      'src/lib/aggEngine.ts',
      'src/lib/cawApi.ts',
      'src/lib/hunters.ts',
      'src/lib/flows.ts',
      'src/lib/exchange.ts',
      '--outDir',
      OUT,
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: ROOT, stdio: 'pipe' },
  );
  ok(true, 'tsc compiles the exchange graph');
} catch (e) {
  ok(false, 'tsc: ' + (e.stdout || '').toString().slice(0, 600));
  process.exit(1);
}
writeFileSync(OUT + '/package.json', '{"type":"commonjs"}');

const HX = await import(OUT + '/lib/exchange.js');
const BC = await import(OUT + '/lib/exchangeBytecode.js');
const { Wallet, Contract, BrowserProvider, Interface, solidityPackedKeccak256, AbiCoder } =
  await import('ethers');

const E18 = 10n ** 18n;
const MAKER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TAKER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const makerWallet = new Wallet(MAKER_KEY);
const takerWallet = new Wallet(TAKER_KEY);
const FAKE_CONTRACT = '0x3333333333333333333333333333333333333333';

const sellOrder = {
  maker: makerWallet.address,
  tokenGive: HX.HX_CAW,
  amountGive: 400n * E18,
  tokenGet: HX.HX_USDT,
  amountGet: 200n * E18,
  expiry: 1999999999,
  nonce: '1',
};
const buyOrder = {
  maker: makerWallet.address,
  tokenGive: HX.HX_USDT,
  amountGive: 200n * E18,
  tokenGet: HX.HX_CAW,
  amountGet: 400n * E18,
  expiry: 1999999999,
  nonce: '2',
};

/* ---------- 1. app-side codec ---------- */
{
  ok(
    HX.HX_USDT === '0xC2684966e5c95B2bc636FB4a1f3Da9Ad23d94753' &&
      HX.HX_CAW === '0xce8aEE7148DaA8943453239C42B7b93f984A49F0',
    'pair constants are the verified 42 Chain addresses',
  );
  const s = HX.serializeOrder(sellOrder);
  ok(
    s.amountGive === (400n * E18).toString() && s.nonce === '1' &&
      typeof s.expiry === 'number',
    'serialize: bigints become decimal strings',
  );
  const back = HX.deserializeOrder(s);
  ok(
    back.amountGive === sellOrder.amountGive &&
      back.amountGet === sellOrder.amountGet &&
      back.maker === sellOrder.maker && back.nonce === '1',
    'serialize/deserialize round-trip is lossless',
  );
  ok(HX.hxIsPairOrder(sellOrder) && HX.hxIsPairOrder(buyOrder), 'pair check accepts both directions');
  ok(
    !HX.hxIsPairOrder({ ...sellOrder, tokenGet: HX.HX_CAW }),
    'pair check refuses a same-token order',
  );
  ok(
    HX.hxOrderPriceScaled(sellOrder) === E18 / 2n &&
      HX.hxOrderPriceScaled(buyOrder) === E18 / 2n,
    'price is consistent across both sides of the book (0.5 USDT per CAW)',
  );
  ok(
    HX.hxOrderUsdtValue(sellOrder) === 200n * E18 &&
      HX.hxOrderUsdtValue(buyOrder) === 200n * E18,
    'USDT value reads the USDT side either way',
  );
  // minimum-order guide: relay 3.13 [42] at 0.5 USDT/[42] ->
  // fixed cost 1.565 USDT; at the provisional 1% rate the
  // guide is exactly 156.5 USDT.
  ok(HX.HX_MIN_FEE_RATE_BPS_PROVISIONAL === 100, 'provisional fee-rate constant is 100 bps (1%, 仮)');
  ok(
    HX.hxMinOrderUsdtRaw(313n * E18 / 100n, E18 / 2n) === 1565n * E18 / 10n,
    'min-order formula: ceil(cost / rate) from the memo',
  );
  ok(
    HX.hxMinOrderUsdtRaw(null, null) === 10n * E18,
    'min-order fallback is 10 USDT when prices are unknown',
  );
  ok(
    HX.hxBelowMinOrder(sellOrder, 1565n * E18 / 10n) === false &&
      HX.hxBelowMinOrder({ ...sellOrder, amountGet: 100n * E18 }, 1565n * E18 / 10n) === true,
    'below-min guide compares the order’s USDT value',
  );
  ok(BC.EXCHANGE_BYTECODE.startsWith('0x60'), 'shipped bytecode present');
  const iface = new Interface(BC.EXCHANGE_ABI);
  ok(
    HX.hxDepositData(HX.HX_CAW, 5n).startsWith(iface.getFunction('deposit').selector) &&
      HX.hxWithdrawData(HX.HX_CAW, 5n).startsWith(iface.getFunction('withdraw').selector) &&
      HX.hxCancelData(sellOrder).startsWith(iface.getFunction('cancelOrder').selector),
    'tx builders encode the contract’s own selectors',
  );
}

/* ---------- 1b. deployed-address validation (statics) ----------
 * validateExchangeAddress reads through an ethers provider
 * bound to the real 42 Chain RPC (providerFor), which cannot
 * be stubbed from a harness — so its DECISION RULE is pinned
 * here statically, and the on-chain half of the rule (a real
 * deployment's USDT()/CAW() actually returning the pair) is
 * exercised against ganache in section 3. */
{
  const src = readFileSync(ROOT + '/src/lib/exchange.ts', 'utf8');
  const val = src.slice(src.indexOf('export async function validateExchangeAddress'));
  ok(val.includes('getCode'), 'validation requires code at the address');
  ok(
    val.includes('HX_USDT') && val.includes('HX_CAW'),
    'validation compares the contract’s USDT()/CAW() against the pair constants',
  );
  ok(
    val.includes('toLowerCase()'),
    'validation compares addresses case-insensitively',
  );
  const xs = readFileSync(ROOT + '/src/screens/ExchangeSection.tsx', 'utf8');
  ok(
    xs.includes("tr('hx.notDeployed')") && xs.includes("tr('hx.deploy')"),
    'pre-deploy UI shows the honest not-deployed state with a deploy action',
  );
  ok(
    xs.includes('EXCHANGE_BYTECODE') && xs.includes('validateExchangeAddress') &&
      xs.includes('saveExchangeAddress'),
    'deploy flow: send the bytecode, validate the result, then store the address',
  );
  ok(
    xs.includes('hxSignOrder') && xs.includes('hxPostOrder'),
    'order placement signs the order and posts it to the server',
  );
  ok(
    xs.includes("tr('hx.deliveryQl1')") && xs.includes('quoteCawDeliveryFee'),
    'filled-CAW delivery defaults to QL1 with the relay fee quoted first',
  );
}

/* ---------- 2. the Worker ---------- */
const OS = await import(pathToFileURL(ROOT + '/worker/orderStore.js').href);
const WV = await import(pathToFileURL(ROOT + '/worker/verify.js').href);
{
  const ser = HX.serializeOrder(sellOrder);
  ok(OS.validateOrderShape(ser) === null, 'worker accepts a well-formed order');
  ok(OS.validateOrderShape({ ...ser, maker: '0x123' }) === 'bad-maker', 'worker refuses a bad maker');
  ok(OS.validateOrderShape({ ...ser, amountGive: '0' }) === 'zero-give', 'worker refuses a zero give');
  ok(
    OS.validateOrderShape({ ...ser, tokenGet: ser.tokenGive }) === 'not-the-pair',
    'worker refuses a non-pair order',
  );
  ok(OS.validateOrderShape({ ...ser, nonce: 'x' }) === 'bad-nonce', 'worker refuses a bad nonce');
  const now = 1794300000;
  const sig = await HX.hxSignOrder(makerWallet, FAKE_CONTRACT, sellOrder);
  ok(sig.length === 132, 'app-side order signature is 65 bytes');
  let r = OS.applyOrder([], { order: ser, signature: sig }, now);
  ok(r.ok && r.listings.length === 1, 'worker lists a signed order');
  ok(
    OS.applyOrder(r.listings, { order: ser, signature: sig }, now).ok === false,
    'worker refuses a duplicate listing',
  );
  ok(
    OS.applyOrder([], { order: { ...ser, expiry: 100 }, signature: sig }, now).error === 'expired',
    'worker refuses an expired order',
  );
  ok(
    OS.applyOrder([], { order: ser, signature: '0x12' }, now).error === 'bad-signature',
    'worker refuses a malformed signature',
  );
  const live = OS.liveBook(
    [...r.listings, { order: { ...ser, nonce: '9', expiry: 100 }, signature: sig, receivedAt: now }],
    now,
  );
  ok(live.length === 1, 'live book hides expired listings');
  const cancelled = OS.applyCancel(r.listings, ser);
  ok(cancelled.ok && cancelled.listings.length === 0, 'cancel removes the listing');
  ok(OS.applyCancel(r.listings, { ...ser, nonce: '7' }).ok === false, 'cancel of an unknown order is a no-op');
  const id1 = OS.orderIdentity(ser);
  const committed = OS.committedGive(
    [
      { order: ser },
      { order: { ...ser, nonce: '3', amountGive: (200n * E18).toString() } },
      { order: { ...ser, nonce: '4', tokenGive: ser.tokenGet, tokenGet: ser.tokenGive } },
    ],
    makerWallet.address,
    HX.HX_CAW,
    { [id1]: (100n * E18).toString() },
  );
  ok(
    committed === (400n - 100n + 200n) * E18,
    'committedGive sums remaining give across the maker’s listings of one token',
  );
  // signature checks + hash agreement app <-> worker
  ok(
    WV.verifyOrderSignature(FAKE_CONTRACT, ser, sig) === true,
    'worker verifies the app-side order signature',
  );
  const tampered = { ...ser, amountGive: (401n * E18).toString() };
  ok(
    WV.verifyOrderSignature(FAKE_CONTRACT, tampered, sig) === false,
    'worker refuses a tampered order',
  );
  const foreignSig = await HX.hxSignOrder(takerWallet, FAKE_CONTRACT, sellOrder);
  ok(
    WV.verifyOrderSignature(FAKE_CONTRACT, ser, foreignSig) === false,
    'worker refuses a signature from the wrong key',
  );
  ok(
    WV.orderHash(FAKE_CONTRACT, ser) === HX.hxOrderHash(FAKE_CONTRACT, sellOrder),
    'worker and app compute the same order hash',
  );
  const cancelSig = await HX.hxSignCancel(makerWallet, FAKE_CONTRACT, sellOrder);
  ok(
    WV.verifyCancelSignature(FAKE_CONTRACT, ser, cancelSig) === true,
    'worker verifies the maker’s cancel signature',
  );
  ok(
    WV.verifyCancelSignature(FAKE_CONTRACT, ser, sig) === false,
    'an order signature does not double as a cancel signature',
  );
  const fakeFetch = async () => ({
    json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + (42n).toString(16).padStart(64, '0') }),
  });
  ok(
    (await WV.escrowBalanceOf(FAKE_CONTRACT, HX.HX_CAW, makerWallet.address, fakeFetch)) === 42n,
    'worker reads the escrow balance from an RPC answer',
  );
  const deadFetch = async () => {
    throw new Error('down');
  };
  ok(
    (await WV.escrowBalanceOf(FAKE_CONTRACT, HX.HX_CAW, makerWallet.address, deadFetch)) === null,
    'worker reports null (refuse) when the escrow read fails',
  );
}

/* ---------- 3. the contract on ganache ---------- */
{
  const Ganache = (await import('ganache')).default;
  const solc = (await import('solc')).default;
  const MOCK_SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public constant decimals = 18;
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "bal");
        require(allowance[from][msg.sender] >= amount, "allow");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    // Test-only seeding (ganache has no evm_setStorageAt):
    // the mock's code is placed at the pair addresses, and
    // mint() then writes balances into that address's storage.
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}`;
  const input = {
    language: 'Solidity',
    sources: { 'Mock.sol': { content: MOCK_SRC } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
  const mock = compiled.contracts['Mock.sol'].MockERC20;
  ok(!!mock, 'mock ERC-20 compiles');

  const g = Ganache.provider({ chain: { chainId: 421018 }, logging: { quiet: true } });
  const provider = new BrowserProvider(g);
  const funder = await provider.getSigner(0);
  const maker = makerWallet.connect(provider);
  const taker = takerWallet.connect(provider);
  for (const w of [makerWallet, takerWallet]) {
    const tx = await funder.sendTransaction({ to: w.address, value: E18 / 10n });
    await tx.wait();
  }
  const mockDeploy = await new Contract(
    await (async () => {
      const f = new (await import('ethers')).ContractFactory(mock.abi, mock.evm.bytecode.object, funder);
      const c = await f.deploy();
      await c.waitForDeployment();
      return c.getAddress();
    })(),
    mock.abi,
    funder,
  );
  const mockCode = await provider.getCode(await mockDeploy.getAddress());
  ok(mockCode.length > 2, 'mock deployed');
  // place the mock code at the pair constants, then seed
  // balances by calling the mock's mint() at those addresses
  for (const token of [HX.HX_USDT, HX.HX_CAW]) {
    await g.request({ method: 'evm_setAccountCode', params: [token, mockCode] });
  }
  const seed = async (token, who, amount) => {
    const t = new Contract(token, mock.abi, funder);
    await (await t.mint(who, amount)).wait();
  };
  await seed(HX.HX_CAW, makerWallet.address, 2000n * E18);
  await seed(HX.HX_USDT, takerWallet.address, 1000n * E18);
  const cawAsMaker = new Contract(HX.HX_CAW, mock.abi, maker);
  const usdtAsTaker = new Contract(HX.HX_USDT, mock.abi, taker);
  ok((await cawAsMaker.balanceOf(makerWallet.address)) === 2000n * E18, 'seeded CAW balance readable at the constant address');
  ok((await usdtAsTaker.balanceOf(takerWallet.address)) === 1000n * E18, 'seeded USDT balance readable at the constant address');

  // deploy the REAL shipped bytecode
  const deployTx = await funder.sendTransaction({ data: BC.EXCHANGE_BYTECODE });
  const deployRcpt = await deployTx.wait();
  const xaddr = deployRcpt.contractAddress;
  ok(!!xaddr, 'HuntersExchange deploys from the shipped bytecode');
  const xc = new Contract(xaddr, BC.EXCHANGE_ABI, provider);
  ok((await xc.USDT()) === HX.HX_USDT && (await xc.CAW()) === HX.HX_CAW, 'contract pair constants match the app');
  ok(
    (await xc.hashOrder({
      maker: sellOrder.maker,
      tokenGive: sellOrder.tokenGive,
      amountGive: sellOrder.amountGive,
      tokenGet: sellOrder.tokenGet,
      amountGet: sellOrder.amountGet,
      expiry: BigInt(sellOrder.expiry),
      nonce: BigInt(sellOrder.nonce),
    })) === HX.hxOrderHash(xaddr, sellOrder),
    'contract hashOrder == app hxOrderHash (EIP-712 agreement)',
  );

  const xMaker = new Contract(xaddr, BC.EXCHANGE_ABI, maker);
  const xTaker = new Contract(xaddr, BC.EXCHANGE_ABI, taker);
  const escrow = async (token, who) => xc.balanceOf(token, who);
  // Fully local nonces for the two test wallets (both fresh
  // at nonce 0; ethers' populated nonce proved unreliable
  // against ganache's pending count in this harness). Every
  // maker/taker send — approves included — goes through here.
  const nonceOf = new Map([
    [makerWallet.address, 0],
    [takerWallet.address, 0],
  ]);
  const sendFrom = async (wallet, txReq) => {
    const n = nonceOf.get(wallet.address);
    const tx = await wallet.sendTransaction({ ...txReq, nonce: n });
    nonceOf.set(wallet.address, n + 1);
    return tx;
  };
  const mockIface = new Interface(mock.abi);
  // deposits (approves + deposits via raw sends, app builders)
  await (await sendFrom(maker, {
    to: HX.HX_CAW,
    data: mockIface.encodeFunctionData('approve', [xaddr, 1000n * E18]),
  })).wait();
  await (await sendFrom(maker, { to: xaddr, data: HX.hxDepositData(HX.HX_CAW, 1000n * E18) })).wait();
  ok((await escrow(HX.HX_CAW, makerWallet.address)) === 1000n * E18, 'deposit: maker escrow credited with what arrived');
  await (await sendFrom(taker, {
    to: HX.HX_USDT,
    data: mockIface.encodeFunctionData('approve', [xaddr, 500n * E18]),
  })).wait();
  await (await sendFrom(taker, { to: xaddr, data: HX.hxDepositData(HX.HX_USDT, 500n * E18) })).wait();
  ok((await escrow(HX.HX_USDT, takerWallet.address)) === 500n * E18, 'deposit: taker escrow credited');
  await expectRevert(
    () => xMaker.deposit.staticCall('0x9999999999999999999999999999999999999999', 1n),
    'deposit: a non-pair token reverts',
  );
  // sign + partial fill
  const sig = await HX.hxSignOrder(makerWallet, xaddr, sellOrder);
  const fillTx = await sendFrom(taker, {
    to: xaddr,
    data: HX.hxFillData(sellOrder, sig, 150n * E18),
  });
  await fillTx.wait();
  ok((await escrow(HX.HX_CAW, makerWallet.address)) === 850n * E18, 'fill: maker CAW escrow drops by the filled amount');
  ok((await escrow(HX.HX_CAW, takerWallet.address)) === 150n * E18, 'fill: taker receives the CAW in escrow');
  ok(
    (await escrow(HX.HX_USDT, takerWallet.address)) === 425n * E18 &&
      (await escrow(HX.HX_USDT, makerWallet.address)) === 75n * E18,
    'fill: taker pays exactly the proportional 75 USDT — fee 0, no skim',
  );
  ok(
    (await xc.filled(HX.hxOrderHash(xaddr, sellOrder))) === 150n * E18,
    'fill: the filled tally tracks the partial fill',
  );
  await expectRevert(
    async () => {
      const tx = await sendFrom(taker, {
        to: xaddr,
        data: HX.hxFillData(sellOrder, sig, 251n * E18),
      });
      await tx.wait();
    },
    'fill: overfilling past the order amount reverts',
  );
  const fill2 = await sendFrom(taker, {
    to: xaddr,
    data: HX.hxFillData(sellOrder, sig, 250n * E18),
  });
  await fill2.wait();
  ok(
    (await xc.filled(HX.hxOrderHash(xaddr, sellOrder))) === 400n * E18,
    'fill: the remainder fills to exactly the order amount',
  );
  // bad signature
  const order2 = { ...sellOrder, nonce: '2' };
  const foreignSig = await HX.hxSignOrder(takerWallet, xaddr, order2);
  await expectRevert(
    async () => {
      const tx = await sendFrom(taker, {
        to: xaddr,
        data: HX.hxFillData(order2, foreignSig, 1n * E18),
      });
      await tx.wait();
    },
    'fill: a signature from the wrong key reverts',
  );
  // expiry
  const order3 = { ...sellOrder, nonce: '3', expiry: 1000 };
  const sig3 = await HX.hxSignOrder(makerWallet, xaddr, order3);
  await expectRevert(
    async () => {
      const tx = await sendFrom(taker, {
        to: xaddr,
        data: HX.hxFillData(order3, sig3, 1n * E18),
      });
      await tx.wait();
    },
    'fill: an expired order reverts',
  );
  // cancel then fill reverts; withdraw still works (server-down)
  const sig2 = await HX.hxSignOrder(makerWallet, xaddr, order2);
  await (await sendFrom(maker, { to: xaddr, data: HX.hxCancelData(order2) })).wait();
  ok(
    (await xc.cancelled(HX.hxOrderHash(xaddr, order2))) === true,
    'cancel: the on-chain kill switch records the order',
  );
  await expectRevert(
    async () => {
      const tx = await sendFrom(taker, {
        to: xaddr,
        data: HX.hxFillData(order2, sig2, 1n * E18),
      });
      await tx.wait();
    },
    'fill: a cancelled order reverts',
  );
  await expectRevert(
    () => xTaker.cancelOrder.staticCall({
      maker: order2.maker,
      tokenGive: order2.tokenGive,
      amountGive: order2.amountGive,
      tokenGet: order2.tokenGet,
      amountGet: order2.amountGet,
      expiry: BigInt(order2.expiry),
      nonce: BigInt(order2.nonce),
    }),
    'cancel: only the maker can cancel',
  );
  const cawBefore = await cawAsMaker.balanceOf(makerWallet.address);
  await (await sendFrom(maker, {
    to: xaddr,
    data: HX.hxWithdrawData(HX.HX_CAW, 600n * E18),
  })).wait();
  ok(
    (await escrow(HX.HX_CAW, makerWallet.address)) === 0n &&
      (await cawAsMaker.balanceOf(makerWallet.address)) === cawBefore + 600n * E18,
    'withdraw: escrow returns to the wallet with no server involved',
  );
  await expectRevert(
    () => xMaker.withdraw.staticCall(HX.HX_CAW, 1n),
    'withdraw: more than the escrow balance reverts',
  );
  await g.disconnect();
}

console.log(`\nexchange: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
