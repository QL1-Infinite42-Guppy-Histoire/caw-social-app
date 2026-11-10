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
 *
 * v0.5.0 formal adds a fourth layer:
 *  4. The Exchange restructure — no instant-swap entry points
 *     remain reachable from the Exchange (static checks over
 *     both screens); the guided deposit / withdraw flows of
 *     lib/exchangeFlows.ts (step sequencing for every
 *     kind × route, holdings-driven default routes, resume
 *     points after a persisted bridge send, balance-delta
 *     arrival verdicts, fee previews, the QL1 warp tx
 *     builder, the on-device flow store); the withdraw
 *     mirroring wiring in ExchangeSection; and the honest
 *     deposit wording in all 20 languages (the removed
 *     instant-swap strings must be GONE from the dicts, the
 *     hxd.* set must be complete).
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
      'src/lib/exchangeFlows.ts',
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
  /* ---- the second pair: QOM ⇄ CAW (v0.5.0 formal) ---- */
  ok(
    HX.HX_QOM.toLowerCase() === '0x53465cbbba5b14f5dc00794330f0f4afb30eaa1d',
    'QOM constant is the live-verified 42 Chain QOM token (NOT the QL1 WQOM address — no code there on 42)',
  );
  const qomAsk = { ...sellOrder, tokenGet: HX.HX_QOM };
  const qomBid = { ...buyOrder, tokenGive: HX.HX_QOM };
  ok(
    HX.hxIsPairOrder(qomAsk) && HX.hxIsPairOrder(qomBid),
    'pair check accepts the QOM pair in both directions',
  );
  ok(
    !HX.hxIsPairOrder({ ...sellOrder, tokenGive: HX.HX_USDT, tokenGet: HX.HX_QOM }),
    'pair check refuses USDT⇄QOM (no CAW leg — the two books never settle against each other)',
  );
  ok(
    HX.hxOrderPriceScaled(qomAsk) === E18 / 2n &&
      HX.hxOrderQuoteValue(qomAsk) === 200n * E18 &&
      HX.hxOrderQuoteValue(qomBid) === 200n * E18,
    'QOM book: price + quote value read the QOM side either way',
  );
  ok(
    HX.hxQomToUsdtRaw(100n * E18, 500000n) === 50n * E18 &&
      HX.hxQomToUsdtRaw(0n, 500000n) === 0n,
    'QOM→USDT guide math: 100 QOM at 0.5 USDT/QOM values as 50 USDT',
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
  ok(
    val.includes('HX_QOM') && val.includes('QOM()'),
    'validation also pins the contract’s QOM() to the 42 Chain QOM token',
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
  /* ---- the Worker and the QOM pair ---- */
  const qomOrderObj = { ...sellOrder, tokenGet: HX.HX_QOM };
  const serQ = HX.serializeOrder(qomOrderObj);
  ok(OS.validateOrderShape(serQ) === null, 'worker accepts a QOM-pair order');
  ok(
    OS.validateOrderShape({ ...ser, tokenGive: HX.HX_USDT, tokenGet: HX.HX_QOM }) === 'not-the-pair',
    'worker refuses a USDT⇄QOM order',
  );
  const sigQ = await HX.hxSignOrder(makerWallet, FAKE_CONTRACT, qomOrderObj);
  const rq = OS.applyOrder([], { order: serQ, signature: sigQ }, now);
  ok(rq.ok && rq.listings.length === 1, 'worker lists a signed QOM-pair order');
  ok(
    WV.verifyOrderSignature(FAKE_CONTRACT, serQ, sigQ) === true &&
      WV.orderHash(FAKE_CONTRACT, serQ) === HX.hxOrderHash(FAKE_CONTRACT, qomOrderObj),
    'worker and app agree on the QOM order’s hash + signature',
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
  for (const token of [HX.HX_USDT, HX.HX_CAW, HX.HX_QOM]) {
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
  ok(
    (await xc.USDT()) === HX.HX_USDT && (await xc.CAW()) === HX.HX_CAW && (await xc.QOM()) === HX.HX_QOM,
    'contract pair constants match the app (USDT, CAW and the QOM book token)',
  );
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

  /* ---- second pair on ganache: QOM ⇄ CAW fills and
   * CROSS-PAIR ISOLATION. Escrow accounting is per token by
   * construction; these checks prove a QOM-book fill moves
   * only CAW+QOM, a USDT-book balance is never touched by
   * it, and a USDT⇄QOM order can never settle at all. ---- */
  await seed(HX.HX_QOM, makerWallet.address, 1000n * E18);
  await seed(HX.HX_QOM, takerWallet.address, 1000n * E18);
  await seed(HX.HX_CAW, takerWallet.address, 500n * E18);
  const snap = async () => ({
    mU: await escrow(HX.HX_USDT, makerWallet.address),
    tU: await escrow(HX.HX_USDT, takerWallet.address),
    mC: await escrow(HX.HX_CAW, makerWallet.address),
    tC: await escrow(HX.HX_CAW, takerWallet.address),
    mQ: await escrow(HX.HX_QOM, makerWallet.address),
    tQ: await escrow(HX.HX_QOM, takerWallet.address),
  });
  // maker re-funds CAW escrow; both sides fund QOM escrow
  await (await sendFrom(maker, {
    to: HX.HX_CAW,
    data: mockIface.encodeFunctionData('approve', [xaddr, 500n * E18]),
  })).wait();
  await (await sendFrom(maker, { to: xaddr, data: HX.hxDepositData(HX.HX_CAW, 500n * E18) })).wait();
  await (await sendFrom(maker, {
    to: HX.HX_QOM,
    data: mockIface.encodeFunctionData('approve', [xaddr, 600n * E18]),
  })).wait();
  await (await sendFrom(maker, { to: xaddr, data: HX.hxDepositData(HX.HX_QOM, 600n * E18) })).wait();
  await (await sendFrom(taker, {
    to: HX.HX_QOM,
    data: mockIface.encodeFunctionData('approve', [xaddr, 1000n * E18]),
  })).wait();
  await (await sendFrom(taker, { to: xaddr, data: HX.hxDepositData(HX.HX_QOM, 1000n * E18) })).wait();
  ok((await escrow(HX.HX_QOM, makerWallet.address)) === 600n * E18, 'QOM pair: deposit credits the QOM escrow');
  // QOM ask: maker sells 400 CAW for 800 QOM (2 QOM per CAW);
  // taker fills 100 CAW worth.
  const qomAsk = {
    maker: makerWallet.address,
    tokenGive: HX.HX_CAW,
    amountGive: 400n * E18,
    tokenGet: HX.HX_QOM,
    amountGet: 800n * E18,
    expiry: 1999999999,
    nonce: '11',
  };
  const sigQA = await HX.hxSignOrder(makerWallet, xaddr, qomAsk);
  const beforeAsk = await snap();
  await (await sendFrom(taker, { to: xaddr, data: HX.hxFillData(qomAsk, sigQA, 100n * E18) })).wait();
  const afterAsk = await snap();
  ok(
    afterAsk.mC === beforeAsk.mC - 100n * E18 && afterAsk.tC === beforeAsk.tC + 100n * E18,
    'QOM fill: CAW moves maker→taker inside escrow',
  );
  ok(
    afterAsk.tQ === beforeAsk.tQ - 200n * E18 && afterAsk.mQ === beforeAsk.mQ + 200n * E18,
    'QOM fill: taker pays exactly the proportional 200 QOM — fee 0',
  );
  ok(
    afterAsk.mU === beforeAsk.mU && afterAsk.tU === beforeAsk.tU,
    'CROSS-PAIR ISOLATION: a QOM-book fill never touches USDT escrow',
  );
  // QOM bid: taker offers 300 QOM for 150 CAW; maker fills it.
  const qomBid = {
    maker: takerWallet.address,
    tokenGive: HX.HX_QOM,
    amountGive: 300n * E18,
    tokenGet: HX.HX_CAW,
    amountGet: 150n * E18,
    expiry: 1999999999,
    nonce: '12',
  };
  const sigQB = await HX.hxSignOrder(takerWallet, xaddr, qomBid);
  const beforeBid = await snap();
  await (await sendFrom(maker, { to: xaddr, data: HX.hxFillData(qomBid, sigQB, 300n * E18) })).wait();
  const afterBid = await snap();
  ok(
    afterBid.tQ === beforeBid.tQ - 300n * E18 && afterBid.mQ === beforeBid.mQ + 300n * E18 &&
      afterBid.mC === beforeBid.mC - 150n * E18 && afterBid.tC === beforeBid.tC + 150n * E18,
    'QOM bid fills in full against CAW+QOM escrow only',
  );
  ok(
    afterBid.mU === beforeBid.mU && afterBid.tU === beforeBid.tU,
    'CROSS-PAIR ISOLATION: the reverse QOM fill also leaves USDT escrow untouched',
  );
  // a USDT⇄QOM order can never settle, even fully funded+singed
  const badPair = {
    maker: makerWallet.address,
    tokenGive: HX.HX_USDT,
    amountGive: 10n * E18,
    tokenGet: HX.HX_QOM,
    amountGet: 10n * E18,
    expiry: 1999999999,
    nonce: '13',
  };
  const sigBad = await HX.hxSignOrder(makerWallet, xaddr, badPair);
  await expectRevert(
    async () => {
      const tx = await sendFrom(taker, {
        to: xaddr,
        data: HX.hxFillData(badPair, sigBad, 1n * E18),
      });
      await tx.wait();
    },
    'fill: a USDT⇄QOM order reverts — the books cannot settle against each other',
  );
  // QOM withdraw works with no server, like every token
  const qomWallet = new Contract(HX.HX_QOM, mock.abi, maker);
  const qBefore = await qomWallet.balanceOf(makerWallet.address);
  const mQFinal = await escrow(HX.HX_QOM, makerWallet.address);
  await (await sendFrom(maker, { to: xaddr, data: HX.hxWithdrawData(HX.HX_QOM, mQFinal) })).wait();
  ok(
    (await escrow(HX.HX_QOM, makerWallet.address)) === 0n &&
      (await qomWallet.balanceOf(makerWallet.address)) === qBefore + mQFinal,
    'QOM withdraw: escrow returns to the wallet with no server involved',
  );
  await g.disconnect();
}

/* ---------- 4. formal statics (v0.5.0 formal): the instant
 * swap is GONE from the Exchange; the book + the guided
 * bridge-deposit / withdraw flows are what remains. The
 * bridge / swap LIBRARIES stay (the deposit flows reuse
 * them) — only the instant-swap UX was removed. ---------- */
{
  const screen = readFileSync(ROOT + '/src/screens/HuntersSwapScreen.tsx', 'utf8');
  const xs = readFileSync(ROOT + '/src/screens/ExchangeSection.tsx', 'utf8');
  ok(
    !screen.includes('BuySection') && !screen.includes('SellSection'),
    'formal: no instant-swap buy/sell sections remain in the screen',
  );
  ok(
    !screen.includes('hx.modeSwap') && !screen.includes('hx.modeBook') && !screen.includes('hsMode'),
    'formal: no swap/book mode toggle remains — the Exchange opens on the book',
  );
  ok(
    !screen.includes('hs.goalBuy') && !screen.includes('hs.goalSell') && !screen.includes('recommendedGoal'),
    'formal: no goal cards remain',
  );
  ok(
    screen.includes('<ExchangeSection />'),
    'formal: the screen is the deposit-address strip + the Exchange section',
  );
  ok(
    !xs.includes('quoteBackHalf') && !xs.includes('buildEntrySwapTx') && !xs.includes('quoteEntrySwap'),
    'formal: the Exchange section wires no instant-swap quoting at all',
  );
  ok(
    xs.includes("case 'bridgeIn':") && xs.includes('buildBridgeInTx') && xs.includes('quoteBridgeIn'),
    'depUsdt: the BSC→42 step is wired to the proven BridgeIn machinery',
  );
  ok(
    xs.includes("case 'bridgeQl1':") && xs.includes('buildCawBridgeInTx'),
    'depCaw: the QL1→42 step is wired to the CAW warp builder',
  );
  ok(
    xs.includes("case 'deposit':") && xs.includes('hxDepositData'),
    'deposits end by depositing the 42-side token into escrow',
  );
  ok(
    xs.includes("case 'escrowOut':") && xs.includes('hxWithdrawData'),
    'withdrawals start by taking the token out of escrow',
  );
  ok(
    xs.includes("case 'bridgeOut':") && xs.includes('quoteBridgeOut42') && xs.includes('buildBridgeOut42Tx'),
    'wdUsdt: the 42→BSC step is wired with its live quote + fee guard',
  );
  ok(
    xs.includes("case 'deliverQl1':") && xs.includes('buildCawDeliveryTx'),
    'wdCaw: the CAW delivery back to QL1 is wired',
  );
  ok(
    xs.includes('xFlowStore') && xs.includes('xAdvance') && xs.includes('xArrivalVerdict'),
    'flows persist on-device and resume (store + advance + delta arrival verdict)',
  );
  ok(
    xs.includes("openSetup('depCaw')") && xs.includes("openSetup('wdCaw')") &&
      xs.includes("'depUsdt' : 'depQom'") && xs.includes("'wdUsdt' : 'wdQom'"),
    'entry points: quote-token deposit/withdraw follow the pair switcher; CAW is shared',
  );
  ok(
    xs.indexOf("if (phase === 'nodeploy')") !== -1 &&
      xs.indexOf("if (phase === 'nodeploy')") < xs.indexOf('openSetup('),
    'not-deployed: the deploy-first state renders before any deposit entry point exists',
  );
  /* the QOM pair (steer 2026-11-10) */
  ok(
    xs.includes("tr('hx.pairUsdt')") && xs.includes("tr('hx.pairQom')"),
    'pair switcher renders both books (USDT ⇄ CAW / QOM ⇄ CAW)',
  );
  ok(
    xs.includes("case 'bridgeQl1Qom':") && xs.includes('runQl1BridgeBatch') && xs.includes('buildAggBridgeFromQl1'),
    'depQom: the QL1 wrap+bridge step is wired to the proven batch runner',
  );
  ok(
    xs.includes("case 'bridge42Qom':") && xs.includes('buildAggBridge') && xs.includes("freshBridgeFee42('QOM')"),
    'wdQom: the 42→QL1 step is wired with the live relay quote',
  );
  ok(
    xs.includes('hxReferenceCawQomQuote') && xs.includes('pairToken'),
    'the reference line + order form scope to the chosen pair',
  );
}

/* ---------- 5. deposit/withdraw flow library (stubbed) ----
 * xStepsFor is the single source of truth for sequencing;
 * resume = serialize → deserialize mid-flow and land on the
 * same step; arrivals are judged on balance DELTAS. */
const XF = await import(OUT + '/lib/exchangeFlows.js');
{
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok(
    eq(XF.xStepsFor('depUsdt', 'bsc'), ['bridgeIn', 'wait42', 'deposit']) &&
      eq(XF.xStepsFor('depUsdt', '42'), ['deposit']),
    'depUsdt sequencing: BSC start bridges then deposits; 42 start deposits directly',
  );
  ok(
    eq(XF.xStepsFor('depCaw', 'ql1'), ['bridgeQl1', 'wait42', 'deposit']) &&
      eq(XF.xStepsFor('depCaw', '42'), ['deposit']),
    'depCaw sequencing: QL1 start warps then deposits; 42 start deposits directly',
  );
  ok(
    eq(XF.xStepsFor('depQom', 'ql1'), ['bridgeQl1Qom', 'wait42', 'deposit']) &&
      eq(XF.xStepsFor('depQom', '42'), ['deposit']),
    'depQom sequencing: QL1 start wrap+bridges then deposits; 42 start deposits directly',
  );
  ok(
    eq(XF.xStepsFor('wdUsdt', 'bsc'), ['escrowOut', 'bridgeOut', 'waitBsc']) &&
      eq(XF.xStepsFor('wdUsdt', '42'), ['escrowOut']),
    'wdUsdt mirrors depUsdt (escrow out first, bridge back last)',
  );
  ok(
    eq(XF.xStepsFor('wdCaw', 'ql1'), ['escrowOut', 'deliverQl1']) &&
      eq(XF.xStepsFor('wdQom', 'ql1'), ['escrowOut', 'bridge42Qom', 'waitQl1']) &&
      eq(XF.xStepsFor('wdQom', '42'), ['escrowOut']),
    'wdCaw / wdQom mirror their deposits',
  );
  {
    let inv = true;
    for (const kind of XF.XFLOW_KINDS) {
      for (const route of ['bsc', '42', 'ql1']) {
        const steps = XF.xStepsFor(kind, route);
        if (kind.startsWith('dep') && steps[steps.length - 1] !== 'deposit') inv = false;
        if (kind.startsWith('wd') && steps[0] !== 'escrowOut') inv = false;
        steps.forEach((s, i) => {
          if (XF.xIsWaitStep(s) && (i === 0 || !steps[i - 1].startsWith('bridge'))) inv = false;
        });
      }
    }
    ok(inv, 'flow invariants: deposits end at deposit, withdrawals start at escrowOut, every wait follows its bridge');
  }
  ok(
    XF.xDefaultRoute('depUsdt', { bscUsdt: 1n, ql1Caw: 0n }) === 'bsc' &&
      XF.xDefaultRoute('depUsdt', { bscUsdt: 0n, ql1Caw: 0n }) === '42' &&
      XF.xDefaultRoute('depCaw', { bscUsdt: 0n, ql1Caw: 1n }) === 'ql1' &&
      XF.xDefaultRoute('depQom', { bscUsdt: 0n, ql1Caw: 0n, ql1Qom: 1n }) === 'ql1' &&
      XF.xDefaultRoute('depQom', { bscUsdt: 0n, ql1Caw: 0n, ql1Qom: 0n }) === '42' &&
      XF.xDefaultRoute('wdUsdt', { bscUsdt: 0n, ql1Caw: 0n }) === 'bsc' &&
      XF.xDefaultRoute('wdQom', { bscUsdt: 0n, ql1Caw: 0n }) === 'ql1',
    'holdings-driven starts: the default route follows what the wallet actually holds',
  );
  const mk = (kind, route) => ({
    v: 1, kind, route, step: 0, amountRaw: (100n * E18).toString(), savedAt: 1700000000000,
  });
  {
    // resume mid-flow: bridge sent → persisted → reloaded →
    // the current step is the WAIT, never the bridge again.
    let f = XF.xAdvance(
      { ...mk('depUsdt', 'bsc'), bridgeHash: '0xabc', base42: '5', expected42: (98n * E18).toString() },
      1700000001000,
    );
    ok(XF.xCurrentStep(f) === 'wait42', 'depUsdt resume: after the bridge send the flow waits for arrival');
    const back = XF.deserializeXFlow(XF.serializeXFlow(f));
    ok(
      back !== null && back.step === 1 && back.bridgeHash === '0xabc' && XF.xCurrentStep(back) === 'wait42',
      'depUsdt resume: serialize/deserialize keeps the step + bridge evidence',
    );
    f = XF.xAdvance(back, 1700000002000);
    ok(XF.xCurrentStep(f) === 'deposit', 'depUsdt resume: arrival advances to the escrow deposit');
    f = XF.xAdvance(f, 1700000003000);
    ok(XF.xFlowComplete(f) && XF.xCurrentStep(f) === null, 'depUsdt: the final advance completes the flow');
    let q = XF.xAdvance(mk('depQom', 'ql1'), 1700000001000);
    ok(XF.xCurrentStep(q) === 'wait42', 'depQom resume: after the wrap+bridge batch the flow waits on 42');
    let w = XF.xAdvance(XF.xAdvance(mk('wdQom', 'ql1'), 1), 2);
    ok(XF.xCurrentStep(w) === 'waitQl1', 'wdQom resume: after the bridge back the flow waits on QL1 (native)');
  }
  ok(
    XF.deserializeXFlow(null) === null && XF.deserializeXFlow('') === null &&
      XF.deserializeXFlow('{"v":2}') === null &&
      XF.deserializeXFlow(JSON.stringify({ ...mk('depUsdt', 'bsc'), kind: 'nope' })) === null &&
      XF.deserializeXFlow(JSON.stringify({ ...mk('depUsdt', 'bsc'), step: 99 })) === null &&
      XF.deserializeXFlow(JSON.stringify({ ...mk('depUsdt', 'bsc'), amountRaw: 'x' })) === null,
    'stored flows: malformed / unknown-kind / out-of-range records are refused, never resumed wrong',
  );
  ok(
    XF.xArrivalVerdict(100n, 150n, 98n) === 'pending' &&
      XF.xArrivalVerdict(100n, 198n, 98n) === 'arrived' &&
      XF.xArrivalVerdict(100n, 500n, 98n) === 'arrived' &&
      XF.xArrivalVerdict(100n, 500n, 0n) === 'pending',
    'arrival verdict is delta-based: partial credit stays pending, a zero expectation never completes',
  );
  ok(
    XF.xPreviewDepUsdtArrival(100n * E18) === 98n * E18 &&
      XF.xPreviewWdUsdtArrival(100n * E18) === 98n * E18 &&
      XF.xPreviewWdUsdtArrival(1n * E18) === 0n,
    'fee previews: −2 USDT into 42, flat 2 USDT back to BSC, floored at 0',
  );
  {
    const tx = XF.buildCawBridgeInTx(makerWallet.address, 7n * E18);
    const sel = new Interface(['function transferRemote(uint32,bytes32,uint256) payable returns (bytes32)'])
      .getFunction('transferRemote').selector;
    const args = AbiCoder.defaultAbiCoder().decode(
      ['uint32', 'bytes32', 'uint256'],
      '0x' + tx.data.slice(10),
    );
    ok(
      tx.to === XF.CAW_WARP_ROUTER_QL1 && tx.value === 0n && tx.data.startsWith(sel) &&
        args[0] === 421018n && args[2] === 7n * E18,
      'depCaw bridge tx: transferRemote to the QL1 CAW warp router, domain 421018, exact amount, no value',
    );
  }
  ok(
    XF.QOM_BRIDGE_PAIR.br.toLowerCase() === '0x049a78fe311cf1c23f09cdd4f12420ffc917c8db' &&
      XF.QOM_BRIDGE_PAIR.ql1Router.toLowerCase() === '0x30da1e7c8de5fa75b593002e0b2d2910ffcadcb6',
    'QOM bridge pair matches the app’s verified aggEngine pair (42 bridge + QL1 router)',
  );
  {
    const m = new Map();
    const kv = {
      getItem: async (k) => (m.has(k) ? m.get(k) : null),
      setItem: async (k, v) => { m.set(k, v); },
    };
    const store = new XF.XFlowStore();
    await store.init(kv, makerWallet.address);
    await store.save(mk('depQom', 'ql1'));
    const loaded = await store.load();
    ok(loaded !== null && loaded.kind === 'depQom', 'flow store: save/load round-trips per address');
    const other = new XF.XFlowStore();
    await other.init(kv, takerWallet.address);
    ok((await other.load()) === null, 'flow store: another address sees no flow');
    await store.save(null);
    ok((await store.load()) === null, 'flow store: clearing removes the flow');
  }
}

/* ---------- 6. honest wording × 20 languages ---------- */
{
  const OUT6 = ROOT + '/scripts/.build-exchange-i18n';
  rmSync(OUT6, { recursive: true, force: true });
  mkdirSync(OUT6, { recursive: true });
  execFileSync(
    'npx',
    ['tsc', '--ignoreConfig', 'src/i18n.ts', '--outDir', OUT6, '--module', 'commonjs', '--target', 'es2022', '--skipLibCheck'],
    { cwd: ROOT, stdio: 'pipe' },
  );
  writeFileSync(OUT6 + '/package.json', '{"type":"commonjs"}');
  const i18n = await import(OUT6 + '/i18n.js');
  const srcI = readFileSync(ROOT + '/src/i18n.ts', 'utf8');
  ok(
    (srcI.match(/'hxd\./g) || []).length === 900,
    'hxd strings: 45 keys × 20 languages in source',
  );
  const LANGS20 = ['en', 'ja', 'zh', 'ko', 'es', 'tr', 'fa', 'id', 'vi', 'pt', 'nl', 'hi', 'fr', 'th', 'it', 'pl', 'uk', 'de', 'ru', 'ar'];
  let allOk = true;
  for (const L of LANGS20) {
    i18n.setLang(L);
    for (const k of [
      'hxd.depUsdt', 'hxd.depCaw', 'hxd.depQom', 'hxd.wdUsdt', 'hxd.wdCaw', 'hxd.wdQom',
      'hxd.stepBridgeIn', 'hxd.stepBridgeQl1', 'hxd.stepBridgeQl1Qom',
      'hxd.stepBridgeOut', 'hxd.stepDeliverQl1', 'hxd.stepBridge42Qom',
      'hx.pairUsdt', 'hx.pairQom', 'hx.referenceQom',
    ]) {
      if (i18n.tr(k) === k) { allOk = false; console.log('  missing:', L, k); }
    }
    for (const dead of ['hx.modeSwap', 'hx.modeBook', 'hs.dualBuy', 'hs.stepBridgeIn', 'hx.deposit', 'hx.withdraw']) {
      if (i18n.tr(dead) !== dead) { allOk = false; console.log('  dead key alive:', L, dead); }
    }
  }
  ok(allOk, 'deposit/withdraw + pair strings resolve in all 20 languages; retired instant-swap keys are gone in all 20');
  i18n.setLang('en');
  const intro = i18n.tr('hxd.depUsdtIntro');
  ok(
    intro.includes('bridged') && intro.includes('42 Chain') && intro.includes('Exchange contract'),
    'EN deposit intro is honest: the coin is bridged to 42 Chain and held in the Exchange contract',
  );
  i18n.setLang('ja');
  ok(
    i18n.tr('hxd.depUsdt') === 'USDT をデポジット' &&
      i18n.tr('hxd.depCaw') === 'qCAW をデポジット' &&
      i18n.tr('hxd.depQom') === 'QOM をデポジット',
    'JA entry buttons say デポジット plainly for all three tokens',
  );
  ok(
    i18n.tr('hxd.depQomIntro').includes('ブリッジ') &&
      i18n.tr('hxd.wdQomIntro').includes('ネイティブ QOM'),
    'JA QOM intros name the bridge and the native-QOM return honestly',
  );
}

console.log(`\nexchange: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
