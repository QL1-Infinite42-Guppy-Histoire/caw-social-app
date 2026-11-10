/**
 * HuntersExchange — the order-book section of the
 * HuntersSwap screen (v0.5.0), per the design memo
 * (~/workspace/huntersexchange/DESIGN.md). The instant-swap
 * sections of HuntersSwapScreen are untouched; this is the
 * 注文板 (order book) mode beside them.
 *
 * Honest states, by design:
 *  - No escrow contract stored on this device → the deploy
 *    panel (「コントラクト未デプロイ — デプロイして開始」),
 *    never a fake book. Deployment is the user's own wallet
 *    sending the creation bytecode (SplitSwap precedent);
 *    an already-deployed address can also be imported and is
 *    validated against the contract's immutable pair
 *    constants before it is trusted.
 *  - Contract live but order server not connected
 *    (EXCHANGE_SERVER_URL empty) → escrow deposit / withdraw
 *    work (pure on-chain), the book area says so plainly.
 *
 * Candidate defaults (2026-11-10): trading fee 0 (the
 * contract has no fee code); filled CAW is delivered back
 * to QL1 qCAW by default (bridge fee 0 + relay fee in [42],
 * quoted live and shown before confirming); the
 * minimum-order guide uses the memo's formula with the
 * provisional 1% acceptable-fee-rate (仮).
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Wallet } from 'ethers';

import { S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import {
  fmtAmountCardDec,
  fmtExactDec,
  parseAmount,
} from '../lib/cawCore';
import {
  buildApproveTx,
  erc20Allowance,
  erc20Balance,
} from '../lib/hunters';
import { sendTxReq, signerForHsChain } from '../lib/wallet';
import {
  buildCawDeliveryTx,
  deserializeOrder,
  hxBelowMinOrder,
  hxCancelData,
  hxCancelled,
  hxDepositData,
  hxEscrowBalances,
  hxFetchBook,
  hxFetchMyOrders,
  hxFilled,
  hxFillData,
  hxMinOrderUsdtRaw,
  hxOrderHash,
  hxOrderPriceScaled,
  hxPostCancel,
  hxPostOrder,
  hxPrice42UsdtRaw,
  hxReferenceCawQuote,
  hxServerConfigured,
  hxSignCancel,
  hxSignOrder,
  hxWithdrawData,
  loadExchangeAddress,
  quoteCawDeliveryFee,
  saveExchangeAddress,
  serializeOrder,
  validateExchangeAddress,
  HX_CAW,
  HX_EXPIRY_OPTIONS_SEC,
  HX_USDT,
  exchangeAddressSync,
  type HxListedOrder,
  type HxOrder,
} from '../lib/exchange';
import { EXCHANGE_BYTECODE } from '../lib/exchangeBytecode';

const card: object = {
  backgroundColor: '#fff',
  borderRadius: 16,
  padding: 14,
  marginTop: 12,
  borderWidth: 1,
  borderColor: '#e6ebee',
};
const chipRow: object = { flexDirection: 'row', gap: 8, marginTop: 10 };
function chip(on: boolean): object {
  return {
    flex: 1,
    borderRadius: 999,
    paddingVertical: 8,
    alignItems: 'center',
    backgroundColor: on ? ACCENT : '#eff3f4',
  };
}
function chipText(on: boolean): object {
  return { fontSize: 13.5, fontWeight: '700', color: on ? '#fff' : '#0f1419' };
}

/** USDT (whole) per 1e9 CAW with 2 dp, from raw sides. */
function pricePer1e9(usdtRaw: bigint, cawRaw: bigint): string {
  if (cawRaw === 0n) return '—';
  const scaled = (usdtRaw * 10n ** 9n * 100n) / cawRaw; // ×100 for 2dp
  const whole = scaled / 100n;
  const frac = (scaled % 100n).toString().padStart(2, '0');
  return whole.toString() + '.' + frac;
}

function orderSides(o: HxOrder): { usdt: bigint; caw: bigint } {
  return o.tokenGive.toLowerCase() === HX_USDT.toLowerCase()
    ? { usdt: o.amountGive, caw: o.amountGet }
    : { usdt: o.amountGet, caw: o.amountGive };
}

export default function ExchangeSection() {
  const app = useApp();
  const address = app.address;
  /** The wallet's own 42 Chain balances (deposit source). */
  const [walletBal, setWalletBal] = useState<{
    usdt: bigint;
    caw: bigint;
  } | null>(null);

  const [contract, setContract] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'nodeploy' | 'live'>(
    'loading',
  );
  const [status, setStatus] = useState<{ text: string; err: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [importText, setImportText] = useState('');

  const [escrow, setEscrow] = useState<{ usdt: bigint; caw: bigint } | null>(
    null,
  );
  const [book, setBook] = useState<HxListedOrder[] | null>(null);
  const [myOrders, setMyOrders] = useState<HxListedOrder[]>([]);
  const [refQuote, setRefQuote] = useState<bigint | null>(null);
  const [bookErr, setBookErr] = useState(false);

  /* escrow deposit / withdraw form */
  const [escToken, setEscToken] = useState<'usdt' | 'caw'>('usdt');
  const [escMode, setEscMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [escAmount, setEscAmount] = useState('');

  /* order form */
  const [side, setSide] = useState<'sell' | 'buy'>('sell');
  const [giveText, setGiveText] = useState('');
  const [priceText, setPriceText] = useState('');
  const [expirySec, setExpirySec] = useState(HX_EXPIRY_OPTIONS_SEC[1]);
  const [relayFee, setRelayFee] = useState<bigint | null>(null);
  const [price42, setPrice42] = useState<bigint | null>(null);

  /* fill */
  const [fillTarget, setFillTarget] = useState<HxListedOrder | null>(null);
  const [fillGiveText, setFillGiveText] = useState('');
  const [fillRemaining, setFillRemaining] = useState<bigint | null>(null);
  const [delivery, setDelivery] = useState<'ql1' | 'keep'>('ql1');
  const [pendingDelivery, setPendingDelivery] = useState<bigint | null>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /* ---------- contract discovery ---------- */
  useEffect(() => {
    let live = true;
    (async () => {
      const stored = exchangeAddressSync() ?? (await loadExchangeAddress());
      if (!live) return;
      if (!stored) {
        setPhase('nodeploy');
        return;
      }
      const ok = await validateExchangeAddress(stored);
      if (!live) return;
      if (ok) {
        setContract(stored);
        setPhase('live');
      } else {
        setPhase('nodeploy');
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const refreshBook = useCallback(async () => {
    if (!contract || !address) return;
    try {
      const [eb, mine, wUsdt, wCaw] = await Promise.all([
        hxEscrowBalances(contract, address),
        hxFetchMyOrders(contract, address).catch(() => []),
        erc20Balance('infinite', HX_USDT, address).catch(() => null),
        erc20Balance('infinite', HX_CAW, address).catch(() => null),
      ]);
      if (!aliveRef.current) return;
      setEscrow(eb);
      setMyOrders(mine);
      if (wUsdt !== null && wCaw !== null) {
        setWalletBal({ usdt: wUsdt, caw: wCaw });
      }
    } catch {
      /* escrow read failure leaves the last figures standing */
    }
    if (hxServerConfigured()) {
      try {
        const orders = await hxFetchBook(contract);
        if (!aliveRef.current) return;
        setBook(orders);
        setBookErr(false);
      } catch {
        if (aliveRef.current) setBookErr(true);
      }
    }
    hxReferenceCawQuote()
      .then((q) => {
        if (aliveRef.current) setRefQuote(q);
      })
      .catch(() => {});
  }, [contract, address]);

  useEffect(() => {
    if (phase === 'live') refreshBook();
  }, [phase, refreshBook]);

  useEffect(() => {
    if (!address) return;
    quoteCawDeliveryFee(address)
      .then((f) => {
        if (aliveRef.current) setRelayFee(f);
      })
      .catch(() => {});
    hxPrice42UsdtRaw()
      .then((p) => {
        if (aliveRef.current) setPrice42(p);
      })
      .catch(() => {});
  }, [address]);

  /* ---------- send helper (42 Chain, app wallet) ---------- */
  const send42 = useCallback(
    async (build: () => { to: string; data: string; value: bigint }) => {
      const ok = await app.requireAuth();
      if (!ok) throw new Error('locked');
      const secret = app.getSecret();
      if (!secret) throw new Error('locked');
      const signer = signerForHsChain(secret.kind, secret.secret, 'infinite');
      return sendTxReq(signer, build());
    },
    [app],
  );

  const signer42 = useCallback(async (): Promise<Wallet> => {
    const ok = await app.requireAuth();
    if (!ok) throw new Error('locked');
    const secret = app.getSecret();
    if (!secret) throw new Error('locked');
    return signerForHsChain(secret.kind, secret.secret, 'infinite');
  }, [app]);

  /* ---------- deploy / import ---------- */
  const deploy = useCallback(async () => {
    setBusy(true);
    setStatus({ text: tr('hx.deploying'), err: false });
    try {
      const signer = await signer42();
      const tx = await signer.sendTransaction({
        data: EXCHANGE_BYTECODE,
        value: 0n,
      });
      const rc = await tx.wait();
      const addr = rc?.contractAddress ?? null;
      if (!addr) throw new Error('no-address');
      const valid = await validateExchangeAddress(addr);
      if (!valid) throw new Error('invalid-deploy');
      await saveExchangeAddress(addr);
      setContract(addr);
      setPhase('live');
      setStatus({ text: tr('hx.deployed'), err: false });
    } catch {
      setStatus({ text: tr('hx.deployFailed'), err: true });
    } finally {
      setBusy(false);
    }
  }, [signer42]);

  const importContract = useCallback(async () => {
    const addr = importText.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      setStatus({ text: tr('hx.importBad'), err: true });
      return;
    }
    setBusy(true);
    try {
      const valid = await validateExchangeAddress(addr);
      if (!valid) {
        setStatus({ text: tr('hx.importBad'), err: true });
        return;
      }
      await saveExchangeAddress(addr);
      setContract(addr);
      setPhase('live');
      setStatus({ text: tr('hx.deployed'), err: false });
    } finally {
      setBusy(false);
    }
  }, [importText]);

  /* ---------- escrow deposit / withdraw ---------- */
  const escrowMax = useMemo((): bigint | null => {
    if (escMode === 'deposit') {
      if (!walletBal) return null;
      return escToken === 'usdt' ? walletBal.usdt : walletBal.caw;
    }
    if (!escrow) return null;
    return escToken === 'usdt' ? escrow.usdt : escrow.caw;
  }, [escMode, escToken, walletBal, escrow]);

  const runEscrow = useCallback(async () => {
    if (!contract || !address) return;
    const amount = parseAmount(escAmount);
    if (amount === null || amount <= 0n) {
      setStatus({ text: tr('hx.amountBad'), err: true });
      return;
    }
    if (escrowMax !== null && amount > escrowMax) {
      setStatus({ text: tr('hx.amountOver'), err: true });
      return;
    }
    const token = escToken === 'usdt' ? HX_USDT : HX_CAW;
    setBusy(true);
    setStatus({ text: tr('hs.sending'), err: false });
    try {
      if (escMode === 'deposit') {
        const signer = await signer42();
        const allowance = await erc20Allowance(
          'infinite',
          token,
          address,
          contract,
        );
        if (allowance < amount) {
          await sendTxReq(
            signer,
            buildApproveTx(token, contract, amount),
          );
        }
        await sendTxReq(signer, {
          to: contract,
          data: hxDepositData(token, amount),
          value: 0n,
        });
        setStatus({ text: tr('hx.depositDone'), err: false });
      } else {
        await send42(() => ({
          to: contract,
          data: hxWithdrawData(token, amount),
          value: 0n,
        }));
        setStatus({ text: tr('hx.withdrawDone'), err: false });
      }
      setEscAmount('');
      refreshBook();
    } catch {
      setStatus({ text: tr('hx.txFailed'), err: true });
    } finally {
      setBusy(false);
    }
  }, [
    contract,
    address,
    escAmount,
    escrowMax,
    escToken,
    escMode,
    send42,
    signer42,
    refreshBook,
  ]);

  /* ---------- place order ---------- */
  const minOrderRaw = useMemo(
    () => hxMinOrderUsdtRaw(relayFee, price42),
    [relayFee, price42],
  );

  const draftOrder = useMemo((): HxOrder | null => {
    if (!address) return null;
    const give = parseAmount(giveText);
    const price = parseAmount(priceText); // USDT per 1e9 CAW, 18dp fixed
    if (give === null || give <= 0n || price === null || price <= 0n) {
      return null;
    }
    // price is per 1e9 CAW: counter = give * price / 1e9 tokens.
    const counter = (give * price) / 10n ** 27n;
    if (counter <= 0n) return null;
    const base: Omit<HxOrder, 'tokenGive' | 'amountGive' | 'tokenGet' | 'amountGet'> = {
      maker: address,
      expiry: Math.floor(Date.now() / 1000) + expirySec,
      nonce: Date.now().toString(),
    };
    return side === 'sell'
      ? { ...base, tokenGive: HX_CAW, amountGive: give, tokenGet: HX_USDT, amountGet: counter }
      : { ...base, tokenGive: HX_USDT, amountGive: give, tokenGet: HX_CAW, amountGet: counter };
  }, [address, giveText, priceText, side, expirySec]);

  const belowMin = draftOrder ? hxBelowMinOrder(draftOrder, minOrderRaw) : false;

  const placeOrder = useCallback(async () => {
    if (!contract || !draftOrder) return;
    if (!hxServerConfigured()) {
      setStatus({ text: tr('hx.noServer'), err: true });
      return;
    }
    // The give side must be covered by escrow — the server
    // enforces it too; failing here first is kinder.
    const esc = escrow;
    if (esc) {
      const have =
        draftOrder.tokenGive.toLowerCase() === HX_USDT.toLowerCase()
          ? esc.usdt
          : esc.caw;
      if (have < draftOrder.amountGive) {
        setStatus({ text: tr('hx.needEscrow'), err: true });
        return;
      }
    }
    setBusy(true);
    setStatus({ text: tr('hs.sending'), err: false });
    try {
      const signer = await signer42();
      const signature = await hxSignOrder(signer, contract, draftOrder);
      await hxPostOrder(contract, {
        order: serializeOrder(draftOrder),
        signature,
      });
      setStatus({ text: tr('hx.orderPlaced'), err: false });
      setGiveText('');
      refreshBook();
    } catch {
      setStatus({ text: tr('hx.orderFailed'), err: true });
    } finally {
      setBusy(false);
    }
  }, [contract, draftOrder, escrow, signer42, refreshBook]);

  /* ---------- cancel ---------- */
  const cancelOrder = useCallback(
    async (listed: HxListedOrder) => {
      if (!contract) return;
      const order = deserializeOrder(listed.order);
      setBusy(true);
      setStatus({ text: tr('hs.sending'), err: false });
      try {
        // On-chain cancel is authoritative; the server listing
        // removal is best-effort afterwards.
        await send42(() => ({
          to: contract,
          data: hxCancelData(order),
          value: 0n,
        }));
        try {
          const signer = await signer42();
          const sig = await hxSignCancel(signer, contract, order);
          await hxPostCancel(contract, order, sig);
        } catch {
          /* listing ages out at expiry even if this fails */
        }
        setStatus({ text: tr('hx.cancelDone'), err: false });
        refreshBook();
      } catch {
        setStatus({ text: tr('hx.txFailed'), err: true });
      } finally {
        setBusy(false);
      }
    },
    [contract, send42, signer42, refreshBook],
  );

  /* ---------- fill ---------- */
  const openFill = useCallback(
    async (listed: HxListedOrder) => {
      if (!contract) return;
      const order = deserializeOrder(listed.order);
      setFillTarget(listed);
      setFillGiveText('');
      setFillRemaining(null);
      try {
        const [filled, cancelled] = await Promise.all([
          hxFilled(contract, hxOrderHash(contract, order)),
          hxCancelled(contract, hxOrderHash(contract, order)),
        ]);
        if (!aliveRef.current) return;
        if (cancelled) {
          setStatus({ text: tr('hx.orderCancelled'), err: true });
          setFillTarget(null);
          return;
        }
        setFillRemaining(order.amountGive - filled);
      } catch {
        if (aliveRef.current) setFillRemaining(order.amountGive);
      }
    },
    [contract],
  );

  const fillGetAmount = useMemo((): bigint | null => {
    if (!fillTarget) return null;
    const order = deserializeOrder(fillTarget.order);
    const give = parseAmount(fillGiveText);
    if (give === null || give <= 0n) return null;
    return (give * order.amountGet + order.amountGive - 1n) / order.amountGive;
  }, [fillTarget, fillGiveText]);

  const runDelivery = useCallback(
    async (amount: bigint) => {
      if (!contract || !address) return;
      // Withdraw the received CAW from escrow if it is still
      // there, then bridge wallet CAW back to QL1.
      const eb = await hxEscrowBalances(contract, address);
      if (eb.caw >= amount) {
        await send42(() => ({
          to: contract,
          data: hxWithdrawData(HX_CAW, amount),
          value: 0n,
        }));
      }
      const tx = await buildCawDeliveryTx(amount, address);
      await send42(() => tx);
    },
    [contract, address, send42],
  );

  const confirmFill = useCallback(async () => {
    if (!contract || !fillTarget || !address) return;
    const order = deserializeOrder(fillTarget.order);
    const give = parseAmount(fillGiveText);
    if (give === null || give <= 0n || fillGetAmount === null) {
      setStatus({ text: tr('hx.amountBad'), err: true });
      return;
    }
    if (fillRemaining !== null && give > fillRemaining) {
      setStatus({ text: tr('hx.fillOver'), err: true });
      return;
    }
    if (escrow) {
      const haveGet =
        order.tokenGet.toLowerCase() === HX_USDT.toLowerCase()
          ? escrow.usdt
          : escrow.caw;
      if (haveGet < fillGetAmount) {
        setStatus({ text: tr('hx.needEscrow'), err: true });
        return;
      }
    }
    setBusy(true);
    setStatus({ text: tr('hs.sending'), err: false });
    try {
      await send42(() => ({
        to: contract,
        data: hxFillData(order, fillTarget.signature, give),
        value: 0n,
      }));
      const receivedCaw =
        order.tokenGive.toLowerCase() === HX_CAW.toLowerCase();
      setFillTarget(null);
      refreshBook();
      if (receivedCaw && delivery === 'ql1') {
        setStatus({ text: tr('hx.delivering'), err: false });
        try {
          await runDelivery(give);
          setStatus({ text: tr('hx.fillDoneDelivered'), err: false });
        } catch {
          // The fill itself landed; only the delivery is left.
          setPendingDelivery(give);
          setStatus({ text: tr('hx.deliveryPending'), err: true });
        }
      } else {
        setStatus({ text: tr('hx.fillDone'), err: false });
      }
    } catch {
      setStatus({ text: tr('hx.txFailed'), err: true });
    } finally {
      setBusy(false);
    }
  }, [
    contract,
    fillTarget,
    address,
    fillGiveText,
    fillGetAmount,
    fillRemaining,
    escrow,
    send42,
    refreshBook,
    delivery,
    runDelivery,
  ]);

  const retryDelivery = useCallback(async () => {
    if (pendingDelivery === null) return;
    setBusy(true);
    setStatus({ text: tr('hx.delivering'), err: false });
    try {
      await runDelivery(pendingDelivery);
      setPendingDelivery(null);
      setStatus({ text: tr('hx.fillDoneDelivered'), err: false });
      refreshBook();
    } catch {
      setStatus({ text: tr('hx.deliveryPending'), err: true });
    } finally {
      setBusy(false);
    }
  }, [pendingDelivery, runDelivery, refreshBook]);

  /* ---------- render ---------- */
  const sortedBook = useMemo(() => {
    if (!book) return null;
    const rows = book.map((l) => ({ l, o: deserializeOrder(l.order) }));
    const asks = rows
      .filter((r) => r.o.tokenGive.toLowerCase() === HX_CAW.toLowerCase())
      .sort((a, b) =>
        hxOrderPriceScaled(a.o) < hxOrderPriceScaled(b.o) ? -1 : 1,
      );
    const bids = rows
      .filter((r) => r.o.tokenGive.toLowerCase() === HX_USDT.toLowerCase())
      .sort((a, b) =>
        hxOrderPriceScaled(a.o) > hxOrderPriceScaled(b.o) ? -1 : 1,
      );
    return { asks, bids };
  }, [book]);

  if (phase === 'loading') {
    return (
      <View style={card}>
        <ActivityIndicator color={ACCENT} />
      </View>
    );
  }

  if (phase === 'nodeploy') {
    return (
      <View style={card}>
        <Text style={S.h2}>{tr('hx.title')}</Text>
        <Text style={[S.body, { marginTop: 8 }]}>{tr('hx.notDeployed')}</Text>
        <Text style={[S.small, { marginTop: 6 }]}>{tr('hx.deployBody')}</Text>
        <Pressable
          style={[S.bigBtn, { marginTop: 14 }, busy && S.disabled]}
          disabled={busy}
          onPress={deploy}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={S.bigBtnText}>{tr('hx.deploy')}</Text>
          )}
        </Pressable>
        <Text style={[S.small, { marginTop: 16 }]}>{tr('hx.importLabel')}</Text>
        <TextInput
          style={[S.input, { marginTop: 6 }]}
          value={importText}
          onChangeText={setImportText}
          placeholder="0x…"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          style={[S.ghostBtn, { marginTop: 10 }, busy && S.disabled]}
          disabled={busy}
          onPress={importContract}
        >
          <Text style={S.ghostBtnText}>{tr('hx.import')}</Text>
        </Pressable>
        {status ? (
          <Text style={[status.err ? S.err : S.ok, { marginTop: 10 }]}>
            {status.text}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View>
      {/* reference price strip */}
      <View style={card}>
        <Text style={S.h2}>{tr('hx.title')}</Text>
        <Text style={[S.small, { marginTop: 6 }]}>
          {tr('hx.reference', {
            // refQuote: USDT raw (6 dp) per 1e9 CAW from QomSwap.
            price:
              refQuote !== null
                ? (Number(refQuote) / 1_000_000).toFixed(2)
                : '—',
          })}
        </Text>
        <Text style={S.tiny}>
          {tr('hx.contractAddr', {
            addr: contract
              ? contract.slice(0, 6) + '…' + contract.slice(-4)
              : '—',
          })}
        </Text>
        {status ? (
          <Text style={[status.err ? S.err : S.ok, { marginTop: 8 }]}>
            {status.text}
          </Text>
        ) : null}
      </View>

      {/* escrow */}
      <View style={card}>
        <Text style={S.h2}>{tr('hx.escrowTitle')}</Text>
        <Text style={[S.body, { marginTop: 6 }]}>
          {tr('hx.escrowBalances', {
            usdt: escrow ? fmtAmountCardDec(escrow.usdt, 18) : '—',
            caw: escrow ? fmtAmountCardDec(escrow.caw, 18) : '—',
          })}
        </Text>
        <View style={chipRow}>
          <Pressable
            style={chip(escToken === 'usdt')}
            onPress={() => setEscToken('usdt')}
          >
            <Text style={chipText(escToken === 'usdt')}>USDT</Text>
          </Pressable>
          <Pressable
            style={chip(escToken === 'caw')}
            onPress={() => setEscToken('caw')}
          >
            <Text style={chipText(escToken === 'caw')}>CAW</Text>
          </Pressable>
          <Pressable
            style={chip(escMode === 'deposit')}
            onPress={() => setEscMode('deposit')}
          >
            <Text style={chipText(escMode === 'deposit')}>
              {tr('hx.deposit')}
            </Text>
          </Pressable>
          <Pressable
            style={chip(escMode === 'withdraw')}
            onPress={() => setEscMode('withdraw')}
          >
            <Text style={chipText(escMode === 'withdraw')}>
              {tr('hx.withdraw')}
            </Text>
          </Pressable>
        </View>
        <TextInput
          style={[S.input, { marginTop: 10 }]}
          value={escAmount}
          onChangeText={(t) => setEscAmount(t.replace(/[^0-9.]/g, ''))}
          placeholder="0.0"
          keyboardType="decimal-pad"
        />
        <View style={[S.row, { justifyContent: 'space-between', marginTop: 6 }]}>
          <Text style={S.tiny}>
            {tr('hx.available', {
              amount:
                escrowMax !== null ? fmtAmountCardDec(escrowMax, 18) : '—',
              symbol: escToken === 'usdt' ? 'USDT' : 'CAW',
            })}
          </Text>
          <Pressable
            onPress={() =>
              escrowMax !== null && setEscAmount(fmtExactDec(escrowMax, 18))
            }
          >
            <Text style={[S.tiny, { color: ACCENT, fontWeight: '700' }]}>
              MAX
            </Text>
          </Pressable>
        </View>
        <Pressable
          style={[S.bigBtn, { marginTop: 12 }, busy && S.disabled]}
          disabled={busy}
          onPress={runEscrow}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={S.bigBtnText}>
              {escMode === 'deposit' ? tr('hx.deposit') : tr('hx.withdraw')}
            </Text>
          )}
        </Pressable>
        <Text style={[S.tiny, { marginTop: 8 }]}>{tr('hx.escrowNote')}</Text>
      </View>

      {/* order form */}
      <View style={card}>
        <Text style={S.h2}>{tr('hx.orderTitle')}</Text>
        <View style={chipRow}>
          <Pressable style={chip(side === 'sell')} onPress={() => setSide('sell')}>
            <Text style={chipText(side === 'sell')}>{tr('hx.sell')}</Text>
          </Pressable>
          <Pressable style={chip(side === 'buy')} onPress={() => setSide('buy')}>
            <Text style={chipText(side === 'buy')}>{tr('hx.buy')}</Text>
          </Pressable>
        </View>
        <Text style={[S.small, { marginTop: 12 }]}>
          {side === 'sell' ? tr('hx.giveCaw') : tr('hx.giveUsdt')}
        </Text>
        <TextInput
          style={[S.input, { marginTop: 4 }]}
          value={giveText}
          onChangeText={(t) => setGiveText(t.replace(/[^0-9.]/g, ''))}
          placeholder="0.0"
          keyboardType="decimal-pad"
        />
        <Text style={[S.small, { marginTop: 10 }]}>{tr('hx.priceLabel')}</Text>
        <TextInput
          style={[S.input, { marginTop: 4 }]}
          value={priceText}
          onChangeText={(t) => setPriceText(t.replace(/[^0-9.]/g, ''))}
          placeholder="0.00"
          keyboardType="decimal-pad"
        />
        {draftOrder ? (
          <Text style={[S.body, { marginTop: 8 }]}>
            {tr('hx.youGet', {
              amount: fmtAmountCardDec(
                draftOrder.amountGet,
                18,
              ),
              symbol: side === 'sell' ? 'USDT' : 'CAW',
            })}
          </Text>
        ) : null}
        <Text style={[S.small, { marginTop: 10 }]}>{tr('hx.expiry')}</Text>
        <View style={chipRow}>
          {HX_EXPIRY_OPTIONS_SEC.map((sec, i) => (
            <Pressable
              key={sec}
              style={chip(expirySec === sec)}
              onPress={() => setExpirySec(sec)}
            >
              <Text style={chipText(expirySec === sec)}>
                {tr(
                  i === 0 ? 'hx.exp24h' : i === 1 ? 'hx.exp7d' : 'hx.exp28d',
                )}
              </Text>
            </Pressable>
          ))}
        </View>
        {belowMin ? (
          <Text style={[S.small, { marginTop: 10, color: '#b7791f' }]}>
            {tr('hx.minWarn', {
              min: fmtAmountCardDec(minOrderRaw, 18),
            })}
          </Text>
        ) : null}
        <Pressable
          style={[
            S.bigBtn,
            { marginTop: 14 },
            (busy || !draftOrder) && S.disabled,
          ]}
          disabled={busy || !draftOrder}
          onPress={placeOrder}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={S.bigBtnText}>{tr('hx.placeOrder')}</Text>
          )}
        </Pressable>
        {!hxServerConfigured() ? (
          <Text style={[S.small, { marginTop: 8 }]}>{tr('hx.noServer')}</Text>
        ) : null}
      </View>

      {/* pending delivery retry */}
      {pendingDelivery !== null ? (
        <View style={card}>
          <Text style={S.body}>{tr('hx.deliveryPending')}</Text>
          <Pressable
            style={[S.bigBtn, { marginTop: 10 }, busy && S.disabled]}
            disabled={busy}
            onPress={retryDelivery}
          >
            <Text style={S.bigBtnText}>{tr('hx.deliverNow')}</Text>
          </Pressable>
        </View>
      ) : null}

      {/* my orders */}
      {myOrders.length > 0 ? (
        <View style={card}>
          <Text style={S.h2}>{tr('hx.myOrders')}</Text>
          {myOrders.map((l, i) => {
            const o = deserializeOrder(l.order);
            const s = orderSides(o);
            return (
              <View
                key={i}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingVertical: 8,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: '#eef2f4',
                }}
              >
                <Text style={S.small}>
                  {o.tokenGive.toLowerCase() === HX_CAW.toLowerCase()
                    ? tr('hx.sell')
                    : tr('hx.buy')}{' '}
                  {fmtAmountCardDec(s.caw, 18)} CAW ·{' '}
                  {pricePer1e9(s.usdt, s.caw)} USDT
                </Text>
                <Pressable
                  disabled={busy}
                  onPress={() => cancelOrder(l)}
                  style={{
                    backgroundColor: '#fdecec',
                    borderRadius: 999,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                  }}
                >
                  <Text style={{ color: '#c92a2a', fontWeight: '700', fontSize: 13 }}>
                    {tr('hx.cancel')}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}

      {/* book */}
      <View style={card}>
        <View style={[S.row, { justifyContent: 'space-between' }]}>
          <Text style={S.h2}>{tr('hx.bookTitle')}</Text>
          <Pressable onPress={refreshBook} hitSlop={8}>
            <Text style={[S.small, { color: ACCENT, fontWeight: '700' }]}>
              {tr('hx.refresh')}
            </Text>
          </Pressable>
        </View>
        {!hxServerConfigured() ? (
          <Text style={[S.body, { marginTop: 8 }]}>{tr('hx.noServer')}</Text>
        ) : bookErr ? (
          <Text style={[S.body, { marginTop: 8 }]}>{tr('hx.bookError')}</Text>
        ) : !sortedBook ? (
          <ActivityIndicator color={ACCENT} style={{ marginTop: 12 }} />
        ) : (
          <>
            <Text style={[S.small, { marginTop: 10, color: '#c92a2a', fontWeight: '700' }]}>
              {tr('hx.asks')}
            </Text>
            {sortedBook.asks.length === 0 ? (
              <Text style={S.small}>{tr('hx.bookEmpty')}</Text>
            ) : (
              sortedBook.asks.map((r, i) => (
                <BookRow key={'a' + i} o={r.o} mine={address !== null && r.o.maker.toLowerCase() === address.toLowerCase()} onFill={() => openFill(r.l)} />
              ))
            )}
            <Text style={[S.small, { marginTop: 12, color: '#2b8a3e', fontWeight: '700' }]}>
              {tr('hx.bids')}
            </Text>
            {sortedBook.bids.length === 0 ? (
              <Text style={S.small}>{tr('hx.bookEmpty')}</Text>
            ) : (
              sortedBook.bids.map((r, i) => (
                <BookRow key={'b' + i} o={r.o} mine={address !== null && r.o.maker.toLowerCase() === address.toLowerCase()} onFill={() => openFill(r.l)} />
              ))
            )}
          </>
        )}
      </View>

      {/* fill panel */}
      {fillTarget ? (
        <View style={card}>
          <Text style={S.h2}>{tr('hx.fillTitle')}</Text>
          {(() => {
            const o = deserializeOrder(fillTarget.order);
            const s = orderSides(o);
            const giveIsCaw =
              o.tokenGive.toLowerCase() === HX_CAW.toLowerCase();
            return (
              <>
                <Text style={[S.body, { marginTop: 6 }]}>
                  {pricePer1e9(s.usdt, s.caw)} USDT / 10⁹ CAW
                </Text>
                <Text style={S.small}>
                  {tr('hx.fillRemaining', {
                    amount:
                      fillRemaining !== null
                        ? fmtAmountCardDec(fillRemaining, 18)
                        : '—',
                    symbol: giveIsCaw ? 'CAW' : 'USDT',
                  })}
                </Text>
                <Text style={[S.small, { marginTop: 10 }]}>
                  {giveIsCaw ? tr('hx.fillGiveCaw') : tr('hx.fillGiveUsdt')}
                </Text>
                <TextInput
                  style={[S.input, { marginTop: 4 }]}
                  value={fillGiveText}
                  onChangeText={(t) =>
                    setFillGiveText(t.replace(/[^0-9.]/g, ''))
                  }
                  placeholder="0.0"
                  keyboardType="decimal-pad"
                />
                {fillGetAmount !== null ? (
                  <Text style={[S.body, { marginTop: 8 }]}>
                    {tr('hx.fillCost', {
                      amount: fmtAmountCardDec(fillGetAmount, 18),
                      symbol: giveIsCaw ? 'USDT' : 'CAW',
                    })}
                  </Text>
                ) : null}
                {giveIsCaw ? (
                  <>
                    <Text style={[S.small, { marginTop: 10 }]}>
                      {tr('hx.deliveryLabel')}
                    </Text>
                    <View style={chipRow}>
                      <Pressable
                        style={chip(delivery === 'ql1')}
                        onPress={() => setDelivery('ql1')}
                      >
                        <Text style={chipText(delivery === 'ql1')}>
                          {tr('hx.deliveryQl1')}
                        </Text>
                      </Pressable>
                      <Pressable
                        style={chip(delivery === 'keep')}
                        onPress={() => setDelivery('keep')}
                      >
                        <Text style={chipText(delivery === 'keep')}>
                          {tr('hx.deliveryKeep')}
                        </Text>
                      </Pressable>
                    </View>
                    {delivery === 'ql1' ? (
                      <Text style={[S.tiny, { marginTop: 8 }]}>
                        {tr('hx.deliveryFee', {
                          fee:
                            relayFee !== null
                              ? fmtAmountCardDec(relayFee, 18)
                              : '—',
                        })}
                      </Text>
                    ) : null}
                  </>
                ) : null}
                <Pressable
                  style={[
                    S.bigBtn,
                    { marginTop: 14 },
                    (busy || fillGetAmount === null) && S.disabled,
                  ]}
                  disabled={busy || fillGetAmount === null}
                  onPress={confirmFill}
                >
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={S.bigBtnText}>{tr('hx.fillNow')}</Text>
                  )}
                </Pressable>
                <Pressable
                  style={[S.ghostBtn, { marginTop: 10 }]}
                  disabled={busy}
                  onPress={() => setFillTarget(null)}
                >
                  <Text style={S.ghostBtnText}>{tr('compose.cancel')}</Text>
                </Pressable>
              </>
            );
          })()}
        </View>
      ) : null}
    </View>
  );
}

function BookRow({
  o,
  mine,
  onFill,
}: {
  o: HxOrder;
  mine: boolean;
  onFill: () => void;
}) {
  const s = orderSides(o);
  return (
    <Pressable
      disabled={mine}
      onPress={onFill}
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingVertical: 7,
        borderTopWidth: 1,
        borderTopColor: '#eef2f4',
      }}
    >
      <Text style={S.body}>{pricePer1e9(s.usdt, s.caw)}</Text>
      <Text style={S.small}>{fmtAmountCardDec(s.caw, 18)} CAW</Text>
      <Text style={S.tiny}>
        {mine ? tr('hx.yours') : tr('hx.fill')}
      </Text>
    </Pressable>
  );
}
