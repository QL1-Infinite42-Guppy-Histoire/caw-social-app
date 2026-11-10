/**
 * HuntersExchange — the whole Exchange screen (v0.5.0
 * formal), per the design memo
 * (~/workspace/huntersexchange/DESIGN.md). The instant swap
 * is GONE (user decision 2026-11-10: 「板だけにして」): this
 * section is the order book plus the guided deposit /
 * withdraw flows that fund it.
 *
 * "Deposit" here is honestly named: the coin is BRIDGED to
 * 42 Chain and then held in the escrow contract (the user's
 * 「デポジット（という名の42チェーンにブリッジ）」). The four
 * flows (lib/exchangeFlows.ts) start from wherever the coin
 * already is — BSC USDT or QL1 qCAW, or the 42 Chain wallet —
 * and withdrawals mirror them back out. Every flow is a
 * fixed step list with per-step status, persisted on-device
 * so a killed app resumes at the first unfinished step.
 *
 * Honest states, by design:
 *  - No escrow contract stored on this device → the deploy
 *    panel (「コントラクト未デプロイ — デプロイして開始」),
 *    never a fake book, and deposit / withdraw show the
 *    same deploy-first state. Deployment is the user's own
 *    wallet sending the creation bytecode (SplitSwap
 *    precedent); an already-deployed address can also be
 *    imported and is validated against the contract's
 *    immutable pair constants before it is trusted.
 *  - Contract live but order server not connected
 *    (EXCHANGE_SERVER_URL empty) → the guided deposit /
 *    withdraw flows work (pure on-chain), the book area
 *    says so plainly.
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
import { tr, type StrKey } from '../i18n';
import {
  BRIDGE_IN_USDT,
  BRIDGE_OUT_USDT_42,
  USDT_ON,
  type HsChainKey,
} from '../lib/chains';
import {
  fmtAmount,
  fmtAmountCardDec,
  fmtExactDec,
  parseAmount,
} from '../lib/cawCore';
import {
  arrivalBalance,
  buildAggBridge,
  buildAggBridgeFromQl1,
  buildApproveTx,
  buildBridgeInTx,
  buildBridgeOut42Tx,
  buildWrapTx,
  classifyStepError,
  erc20Allowance,
  erc20Balance,
  expected42Usdt,
  fetchQl1BridgeState,
  fetchQl1GasShort,
  fetchUsdtStartGasOk,
  freshBridgeFee42,
  ql1BridgePlan,
  quoteBridgeIn,
  quoteBridgeOut42,
  quotePairTokenFee,
  runQl1BridgeBatch,
  stepErrorKey,
  WQOM_ADDR,
  type TxReq,
} from '../lib/hunters';
import {
  buildCawBridgeInTx,
  CAW_WARP_ROUTER_QL1,
  QCAW_TOKEN_QL1,
  QOM_BRIDGE_PAIR,
  xAdvance,
  xArrivalVerdict,
  xCurrentStep,
  xDefaultRoute,
  xExpectedBscFromForward,
  xFlowComplete,
  xIsWaitStep,
  xPreviewDepUsdtArrival,
  xPreviewWdUsdtArrival,
  xStepsFor,
  xTokenOf,
  type XFlow,
  type XFlowKind,
  type XStepId,
} from '../lib/exchangeFlows';
import { storeKV, xFlowStore } from '../lib/stores';
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
  hxQomToUsdtRaw,
  hxQomUsdtRaw,
  hxReferenceCawQomQuote,
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
  HX_QOM,
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

/* Guided-flow presentation maps (v0.5.0 formal). */
const X_KIND_TITLE: Record<XFlowKind, StrKey> = {
  depUsdt: 'hxd.depUsdt',
  depCaw: 'hxd.depCaw',
  depQom: 'hxd.depQom',
  wdUsdt: 'hxd.wdUsdt',
  wdCaw: 'hxd.wdCaw',
  wdQom: 'hxd.wdQom',
};
const X_KIND_INTRO: Record<XFlowKind, StrKey> = {
  depUsdt: 'hxd.depUsdtIntro',
  depCaw: 'hxd.depCawIntro',
  depQom: 'hxd.depQomIntro',
  wdUsdt: 'hxd.wdUsdtIntro',
  wdCaw: 'hxd.wdCawIntro',
  wdQom: 'hxd.wdQomIntro',
};
const X_STEP_LABEL: Record<XStepId, StrKey> = {
  bridgeIn: 'hxd.stepBridgeIn',
  bridgeQl1: 'hxd.stepBridgeQl1',
  bridgeQl1Qom: 'hxd.stepBridgeQl1Qom',
  wait42: 'hxd.stepWait42',
  deposit: 'hxd.stepDeposit',
  escrowOut: 'hxd.stepEscrowOut',
  bridgeOut: 'hxd.stepBridgeOut',
  waitBsc: 'hxd.stepWaitBsc',
  deliverQl1: 'hxd.stepDeliverQl1',
  bridge42Qom: 'hxd.stepBridge42Qom',
  waitQl1: 'hxd.stepWaitQl1',
};
/** Route chips per flow: deposits list the outside chain
 *  first (the named flows), withdrawals list the 42 wallet
 *  first (the stop-here option). */
const X_ROUTES: Record<XFlowKind, { k: string; label: StrKey }[]> = {
  depUsdt: [
    { k: 'bsc', label: 'hxd.fromBsc' },
    { k: '42', label: 'hxd.from42' },
  ],
  depCaw: [
    { k: 'ql1', label: 'hxd.fromQl1' },
    { k: '42', label: 'hxd.from42' },
  ],
  depQom: [
    { k: 'ql1', label: 'hxd.fromQl1' },
    { k: '42', label: 'hxd.from42Qom' },
  ],
  wdUsdt: [
    { k: '42', label: 'hxd.keep42' },
    { k: 'bsc', label: 'hxd.toBsc' },
  ],
  wdCaw: [
    { k: '42', label: 'hxd.keep42' },
    { k: 'ql1', label: 'hxd.toQl1' },
  ],
  wdQom: [
    { k: '42', label: 'hxd.keep42' },
    { k: 'ql1', label: 'hxd.toQl1Qom' },
  ],
};
const flowBtn: object = {
  flex: 1,
  borderRadius: 12,
  paddingVertical: 12,
  alignItems: 'center',
  backgroundColor: ACCENT,
};
const flowBtnText: object = { fontSize: 14.5, fontWeight: '700', color: '#fff' };
const flowBtnGhost: object = {
  flex: 1,
  borderRadius: 12,
  paddingVertical: 12,
  alignItems: 'center',
  backgroundColor: '#eff3f4',
};
const flowBtnGhostText: object = {
  fontSize: 14.5,
  fontWeight: '700',
  color: '#0f1419',
};
const pctChip: object = {
  flex: 1,
  borderRadius: 999,
  paddingVertical: 6,
  alignItems: 'center',
  backgroundColor: '#eff3f4',
};
const pctChipText: object = {
  fontSize: 12.5,
  fontWeight: '700',
  color: '#0f1419',
};

/** USDT (whole) per 1e9 CAW with 2 dp, from raw sides. */
function pricePer1e9(usdtRaw: bigint, cawRaw: bigint): string {
  if (cawRaw === 0n) return '—';
  const scaled = (usdtRaw * 10n ** 9n * 100n) / cawRaw; // ×100 for 2dp
  const whole = scaled / 100n;
  const frac = (scaled % 100n).toString().padStart(2, '0');
  return whole.toString() + '.' + frac;
}

/** Escrow token address / display symbol for a flow kind. */
function xTokenAddr(kind: XFlowKind): string {
  const t = xTokenOf(kind);
  return t === 'usdt' ? HX_USDT : t === 'qom' ? HX_QOM : HX_CAW;
}
function xTokenSym(kind: XFlowKind): string {
  const t = xTokenOf(kind);
  return t === 'usdt' ? 'USDT' : t === 'qom' ? 'QOM' : 'CAW';
}

function orderSides(o: HxOrder): {
  quote: bigint;
  caw: bigint;
  quoteSym: string;
} {
  const giveIsCaw = o.tokenGive.toLowerCase() === HX_CAW.toLowerCase();
  const quoteTok = giveIsCaw ? o.tokenGet : o.tokenGive;
  return {
    quote: giveIsCaw ? o.amountGet : o.amountGive,
    caw: giveIsCaw ? o.amountGive : o.amountGet,
    quoteSym:
      quoteTok.toLowerCase() === HX_QOM.toLowerCase() ? 'QOM' : 'USDT',
  };
}

export default function ExchangeSection() {
  const app = useApp();
  const address = app.address;
  /** The book being shown: USDT ⇄ CAW or QOM ⇄ CAW. The
   *  book, my orders, the order form and the quote-token
   *  deposit/withdraw actions are all scoped by this. */
  const [pair, setPair] = useState<'usdt' | 'qom'>('usdt');
  const pairToken = pair === 'usdt' ? HX_USDT : HX_QOM;
  const pairSym = pair === 'usdt' ? 'USDT' : 'QOM';
  /** The wallet's own 42 Chain balances (deposit source). */
  const [walletBal, setWalletBal] = useState<{
    usdt: bigint;
    caw: bigint;
    qom: bigint;
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

  const [escrow, setEscrow] = useState<{
    usdt: bigint;
    caw: bigint;
    qom: bigint;
  } | null>(null);
  const [book, setBook] = useState<HxListedOrder[] | null>(null);
  const [myOrders, setMyOrders] = useState<HxListedOrder[]>([]);
  const [refQuote, setRefQuote] = useState<bigint | null>(null);
  const [refQomQuote, setRefQomQuote] = useState<bigint | null>(null);
  const [bookErr, setBookErr] = useState(false);

  /* guided deposit / withdraw flows (v0.5.0 formal) */
  const [xflow, setXflow] = useState<XFlow | null>(null);
  const [xSetup, setXSetup] = useState<XFlowKind | null>(null);
  const [xRoute, setXRoute] = useState<string>('bsc');
  const [xAmount, setXAmount] = useState('');
  /** Holdings on the two outside chains (deposit sources). */
  const [xHeld, setXHeld] = useState<{
    bscUsdt: bigint | null;
    ql1Caw: bigint | null;
    ql1Native: bigint | null;
    wqomQl1: bigint | null;
  }>({ bscUsdt: null, ql1Caw: null, ql1Native: null, wqomQl1: null });
  /** QL1 QOM bridge state for the depQom setup (what can be
   *  assembled from WQOM held + native above the gas keep). */
  const [xQomAsm, setXQomAsm] = useState<bigint | null>(null);
  const [xBusy, setXBusy] = useState(false);
  const [xStatus, setXStatus] = useState<{ text: string; err: boolean } | null>(
    null,
  );
  /** Preflight for the current send step: whether an approve
   *  send must come first, and a hard pre-send block (gas)
   *  with its own plain message when there is one. */
  const [xPre, setXPre] = useState<{
    step: XStepId;
    needsApprove: boolean;
    blocked: string | null;
  } | null>(null);
  const [xPreNonce, setXPreNonce] = useState(0);
  const xPollRef = useRef(false);
  /** True when the showing flow was loaded back from the
   *  on-device store (a resume, not a fresh start). */
  const [xResumed, setXResumed] = useState(false);

  /* order form */
  const [side, setSide] = useState<'sell' | 'buy'>('sell');
  const [giveText, setGiveText] = useState('');
  const [priceText, setPriceText] = useState('');
  const [expirySec, setExpirySec] = useState(HX_EXPIRY_OPTIONS_SEC[1]);
  const [relayFee, setRelayFee] = useState<bigint | null>(null);
  const [price42, setPrice42] = useState<bigint | null>(null);
  /** QOM price (USDT 6 dp per whole QOM) for the min-order
   *  guide on the QOM book; null = the guide does not judge. */
  const [qomUsdtPrice, setQomUsdtPrice] = useState<bigint | null>(null);
  /** Live 42->QL1 relay fee for the QOM pair (wdQom preview). */
  const [qomRelayFee, setQomRelayFee] = useState<bigint | null>(null);

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
      const [eb, mine, wUsdt, wCaw, wQom, bUsdt, qCaw, qNat, qWqom] =
        await Promise.all([
          hxEscrowBalances(contract, address),
          hxFetchMyOrders(contract, address).catch(() => []),
          erc20Balance('infinite', HX_USDT, address).catch(() => null),
          erc20Balance('infinite', HX_CAW, address).catch(() => null),
          erc20Balance('infinite', HX_QOM, address).catch(() => null),
          erc20Balance('bsc', USDT_ON.bsc.address, address).catch(() => null),
          erc20Balance('ql1', QCAW_TOKEN_QL1, address).catch(() => null),
          arrivalBalance('ql1', null, address).catch(() => null),
          erc20Balance('ql1', WQOM_ADDR, address).catch(() => null),
        ]);
      if (!aliveRef.current) return;
      setEscrow(eb);
      setMyOrders(mine);
      if (wUsdt !== null && wCaw !== null && wQom !== null) {
        setWalletBal({ usdt: wUsdt, caw: wCaw, qom: wQom });
      }
      if (bUsdt !== null || qCaw !== null || qNat !== null || qWqom !== null) {
        setXHeld((h) => ({
          bscUsdt: bUsdt ?? h.bscUsdt,
          ql1Caw: qCaw ?? h.ql1Caw,
          ql1Native: qNat ?? h.ql1Native,
          wqomQl1: qWqom ?? h.wqomQl1,
        }));
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
    hxReferenceCawQomQuote()
      .then((q) => {
        if (aliveRef.current) setRefQomQuote(q);
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
    hxQomUsdtRaw()
      .then((p) => {
        if (aliveRef.current) setQomUsdtPrice(p);
      })
      .catch(() => {});
    freshBridgeFee42('QOM')
      .then((f) => {
        if (aliveRef.current) setQomRelayFee(f);
      })
      .catch(() => {});
  }, [address]);

  /* ---------- send helpers (app wallet, any flow chain) ---------- */
  const signerOn = useCallback(
    async (chain: HsChainKey): Promise<Wallet> => {
      const ok = await app.requireAuth();
      if (!ok) throw new Error('locked');
      const secret = app.getSecret();
      if (!secret) throw new Error('locked');
      return signerForHsChain(secret.kind, secret.secret, chain);
    },
    [app],
  );

  const send42 = useCallback(
    async (build: () => { to: string; data: string; value: bigint }) => {
      const signer = await signerOn('infinite');
      return sendTxReq(signer, build());
    },
    [signerOn],
  );

  const signer42 = useCallback(
    async (): Promise<Wallet> => signerOn('infinite'),
    [signerOn],
  );

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

  /* ---------- guided deposit / withdraw flows ----------
   * The state machine lives in lib/exchangeFlows.ts; this
   * section is its runner. One flow at a time, persisted
   * after every confirmed step. An approve, when a step
   * needs one, is its own send under the same step (the
   * preflight offers it first; the step's main send only
   * runs once the allowance covers it) — exactly the
   * sub-send pattern the older guided flows used. */
  const persistX = useCallback(async (f: XFlow | null) => {
    setXflow(f);
    if (f === null) await xFlowStore.clear().catch(() => {});
    else await xFlowStore.save(f).catch(() => {});
  }, []);

  /** Advance past the current step; on the last step the
   *  flow completes and is cleared with its done message. */
  const advanceX = useCallback(
    async (f: XFlow) => {
      const next = xAdvance(f, Date.now());
      if (xFlowComplete(next)) {
        await persistX(null);
        setXStatus({
          text: tr(
            f.kind === 'depUsdt' || f.kind === 'depCaw'
              ? 'hx.depositDone'
              : 'hx.withdrawDone',
          ),
          err: false,
        });
        refreshBook();
      } else {
        await persistX(next);
      }
    },
    [persistX, refreshBook],
  );

  /* Resume: load the persisted flow (if any) for this wallet. */
  useEffect(() => {
    if (!address) return;
    let live = true;
    xFlowStore
      .init(storeKV, address)
      .then(() => xFlowStore.load())
      .then((f) => {
        if (live && f) {
          setXflow(f);
          if (f.step > 0) setXResumed(true);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [address]);

  /* Preflight for the current SEND step. */
  useEffect(() => {
    let live = true;
    setXPre(null);
    (async () => {
      if (!xflow || !address || !contract) return;
      const step = xCurrentStep(xflow);
      if (!step || xIsWaitStep(step)) return;
      const amount = BigInt(xflow.amountRaw);
      let needsApprove = false;
      let blocked: string | null = null;
      try {
        if (step === 'bridgeIn') {
          const allow = await erc20Allowance(
            'bsc',
            USDT_ON.bsc.address,
            address,
            BRIDGE_IN_USDT.bsc.router,
          ).catch(() => 0n);
          needsApprove = allow < amount;
          const gasOk = await fetchUsdtStartGasOk('bsc', address).catch(
            () => null,
          );
          if (gasOk === false) {
            blocked = tr('hs.needGasCoin', { sym: 'BNB' });
          }
        } else if (step === 'bridgeQl1') {
          const allow = await erc20Allowance(
            'ql1',
            QCAW_TOKEN_QL1,
            address,
            CAW_WARP_ROUTER_QL1,
          ).catch(() => 0n);
          needsApprove = allow < amount;
          const short = await fetchQl1GasShort(address).catch(() => null);
          if (short === true) blocked = tr('hs.gasQomShort');
        } else if (step === 'bridgeQl1Qom') {
          /* The batch plans itself at send time; the
           * preflight only surfaces the cannot-assemble
           * block (native above the keep + WQOM held must
           * cover the amount). */
          const st = await fetchQl1BridgeState(
            address,
            WQOM_ADDR,
            QOM_BRIDGE_PAIR.ql1Router,
          ).catch(() => null);
          if (st) {
            const plan = ql1BridgePlan({
              amt: amount,
              erc20: true,
              wrappedNative: true,
              tokenBal: st.tokenBal,
              nativeBal: st.nativeBal,
              allowance: st.allowance,
              keepWei: st.keepWei,
              wrapCostWei: st.wrapCostWei,
            });
            if (plan.action !== 'run') blocked = tr('hs.notEnough');
          }
        } else if (step === 'deposit') {
          const allow = await erc20Allowance(
            'infinite',
            xTokenAddr(xflow.kind),
            address,
            contract,
          ).catch(() => 0n);
          needsApprove = allow < amount;
        } else if (step === 'bridge42Qom') {
          const allow = await erc20Allowance(
            'infinite',
            HX_QOM,
            address,
            QOM_BRIDGE_PAIR.br,
          ).catch(() => 0n);
          needsApprove = allow < amount;
        } else if (step === 'bridgeOut') {
          const allow = await erc20Allowance(
            'infinite',
            HX_USDT,
            address,
            BRIDGE_OUT_USDT_42.router,
          ).catch(() => 0n);
          needsApprove = allow < amount;
        }
      } catch {
        /* unreadable preflight: the send itself surfaces the
         * real error through the step taxonomy */
      }
      if (live) setXPre({ step, needsApprove, blocked });
    })();
    return () => {
      live = false;
    };
  }, [xflow, address, contract, xPreNonce]);

  const openSetup = useCallback(
    (kind: XFlowKind) => {
      setXSetup(kind);
      setXAmount('');
      setXStatus(null);
      setXRoute(
        xDefaultRoute(kind, {
          bscUsdt: xHeld.bscUsdt ?? 0n,
          ql1Caw: xHeld.ql1Caw ?? 0n,
          ql1Qom: (xHeld.wqomQl1 ?? 0n) + (xHeld.ql1Native ?? 0n),
        }),
      );
    },
    [xHeld],
  );

  /* depQom setup: what QL1 QOM can actually be assembled
   * (WQOM held + native above the gas keep, wrap cost
   * aside) — read live while that setup is open. */
  useEffect(() => {
    let live = true;
    if (!(xSetup === 'depQom' && xRoute === 'ql1' && address)) {
      setXQomAsm(null);
      return;
    }
    (async () => {
      const st = await fetchQl1BridgeState(
        address,
        WQOM_ADDR,
        QOM_BRIDGE_PAIR.ql1Router,
      ).catch(() => null);
      if (!live) return;
      if (!st) {
        setXQomAsm(null);
        return;
      }
      const surplus =
        st.nativeBal > st.keepWei + st.wrapCostWei
          ? st.nativeBal - st.keepWei - st.wrapCostWei
          : 0n;
      setXQomAsm(st.tokenBal + surplus);
    })();
    return () => {
      live = false;
    };
  }, [xSetup, xRoute, address]);

  /** The balance the setup amount is drawn from. */
  const xSourceMax = useMemo((): bigint | null => {
    if (!xSetup) return null;
    switch (xSetup) {
      case 'depUsdt':
        return xRoute === 'bsc' ? xHeld.bscUsdt : (walletBal?.usdt ?? null);
      case 'depCaw':
        return xRoute === 'ql1' ? xHeld.ql1Caw : (walletBal?.caw ?? null);
      case 'depQom':
        return xRoute === 'ql1' ? xQomAsm : (walletBal?.qom ?? null);
      case 'wdUsdt':
        return escrow?.usdt ?? null;
      case 'wdCaw':
        return escrow?.caw ?? null;
      case 'wdQom':
        return escrow?.qom ?? null;
    }
  }, [xSetup, xRoute, xHeld, walletBal, escrow, xQomAsm]);

  const startXFlow = useCallback(async () => {
    if (!xSetup || !contract) return;
    const amount = parseAmount(xAmount);
    if (amount === null || amount <= 0n) {
      setXStatus({ text: tr('hx.amountBad'), err: true });
      return;
    }
    if (xSourceMax !== null && amount > xSourceMax) {
      setXStatus({ text: tr('hx.amountOver'), err: true });
      return;
    }
    const f: XFlow = {
      v: 1,
      kind: xSetup,
      route: xRoute,
      amountRaw: amount.toString(),
      step: 0,
      savedAt: Date.now(),
    };
    setXSetup(null);
    setXStatus(null);
    setXResumed(false);
    await persistX(f);
  }, [xSetup, contract, xAmount, xSourceMax, xRoute, persistX]);

  /** The approve send a step needs first, if any. */
  const xApproveFor = useCallback(
    (step: XStepId, f: XFlow): { chain: HsChainKey; tx: TxReq } | null => {
      if (!contract) return null;
      const amount = BigInt(f.amountRaw);
      switch (step) {
        case 'bridgeIn':
          return {
            chain: 'bsc',
            tx: buildApproveTx(
              USDT_ON.bsc.address,
              BRIDGE_IN_USDT.bsc.router,
              amount,
            ),
          };
        case 'bridgeQl1':
          return {
            chain: 'ql1',
            tx: buildApproveTx(QCAW_TOKEN_QL1, CAW_WARP_ROUTER_QL1, amount),
          };
        case 'deposit': {
          return {
            chain: 'infinite',
            tx: buildApproveTx(xTokenAddr(f.kind), contract, amount),
          };
        }
        case 'bridge42Qom':
          return {
            chain: 'infinite',
            tx: buildApproveTx(HX_QOM, QOM_BRIDGE_PAIR.br, amount),
          };
        case 'bridgeOut':
          return {
            chain: 'infinite',
            tx: buildApproveTx(HX_USDT, BRIDGE_OUT_USDT_42.router, amount),
          };
        default:
          return null;
      }
    },
    [contract],
  );

  const runXStep = useCallback(async () => {
    if (!xflow || !contract || !address) return;
    const step = xCurrentStep(xflow);
    if (!step || xIsWaitStep(step)) return;
    if (xPre && xPre.step === step && xPre.blocked) {
      setXStatus({ text: xPre.blocked, err: true });
      return;
    }
    const amount = BigInt(xflow.amountRaw);
    setXBusy(true);
    setXStatus({ text: tr('hs.sending'), err: false });
    try {
      /* Approve first when the preflight says one is owed:
       * the step does NOT advance — the next tap runs the
       * step's main send. */
      if (xPre && xPre.step === step && xPre.needsApprove) {
        const a = xApproveFor(step, xflow);
        if (a) {
          const signer = await signerOn(a.chain);
          await sendTxReq(signer, a.tx);
          setXStatus({ text: tr('hxd.approved'), err: false });
          setXPreNonce((n) => n + 1);
          return;
        }
      }
      switch (step) {
        case 'bridgeIn': {
          const base = await erc20Balance('infinite', HX_USDT, address);
          const q = await quoteBridgeIn('bsc', amount);
          const signer = await signerOn('bsc');
          const hash = await sendTxReq(
            signer,
            buildBridgeInTx('bsc', amount, address, q.totalNative),
          );
          await advanceX({
            ...xflow,
            base42: base.toString(),
            expected42: expected42Usdt(amount, 18).toString(),
            bridgeHash: hash,
          });
          break;
        }
        case 'bridgeQl1': {
          const base = await erc20Balance('infinite', HX_CAW, address);
          const signer = await signerOn('ql1');
          const hash = await sendTxReq(
            signer,
            buildCawBridgeInTx(address, amount),
          );
          await advanceX({
            ...xflow,
            base42: base.toString(),
            expected42: amount.toString(),
            bridgeHash: hash,
          });
          break;
        }
        case 'bridgeQl1Qom': {
          /* ONE batch under this step: [wrap the shortfall]
           * -> [approve] -> bridge, planned fresh by
           * ql1BridgePlan against the gas keep (the app's
           * proven QL1 bridge discipline). The 42-side
           * baseline is captured inside the bridge leg's
           * builder — after wrap/approve have landed, right
           * before transferRemote is built. */
          const st = await fetchQl1BridgeState(
            address,
            WQOM_ADDR,
            QOM_BRIDGE_PAIR.ql1Router,
          );
          if (!st) {
            throw Object.assign(new Error('fetch failed'), {
              code: 'NETWORK_ERROR',
            });
          }
          const plan = ql1BridgePlan({
            amt: amount,
            erc20: true,
            wrappedNative: true,
            tokenBal: st.tokenBal,
            nativeBal: st.nativeBal,
            allowance: st.allowance,
            keepWei: st.keepWei,
            wrapCostWei: st.wrapCostWei,
          });
          if (plan.action !== 'run') throw new Error('insufficient');
          let base42 = 0n;
          let lastHash: string | undefined;
          const signer = await signerOn('ql1');
          await runQl1BridgeBatch({
            plan,
            amt: amount,
            buildTx: async (leg) => {
              if (leg.kind === 'wrap') return buildWrapTx(leg.amount);
              if (leg.kind === 'approve') {
                return buildApproveTx(
                  WQOM_ADDR,
                  QOM_BRIDGE_PAIR.ql1Router,
                  amount,
                );
              }
              base42 = await erc20Balance('infinite', HX_QOM, address);
              return buildAggBridgeFromQl1(
                { pair: QOM_BRIDGE_PAIR },
                address,
                amount,
                0n,
              );
            },
            send: async (tx) => {
              lastHash = await sendTxReq(signer, tx);
            },
          });
          const tokenFee =
            (await quotePairTokenFee(QOM_BRIDGE_PAIR, amount, 'ql1').catch(
              () => null,
            )) ?? 0n;
          const expected = amount > tokenFee ? amount - tokenFee : 0n;
          await advanceX({
            ...xflow,
            base42: base42.toString(),
            expected42: expected.toString(),
            bridgeHash: lastHash,
          });
          break;
        }
        case 'deposit': {
          const signer = await signerOn('infinite');
          await sendTxReq(signer, {
            to: contract,
            data: hxDepositData(xTokenAddr(xflow.kind), amount),
            value: 0n,
          });
          await advanceX(xflow);
          break;
        }
        case 'escrowOut': {
          const signer = await signerOn('infinite');
          await sendTxReq(signer, {
            to: contract,
            data: hxWithdrawData(xTokenAddr(xflow.kind), amount),
            value: 0n,
          });
          await advanceX(xflow);
          break;
        }
        case 'bridge42Qom': {
          /* Relay fee quoted LIVE (freshBridgeFee42), token
           * fee quoted live (quotePairTokenFee) — neither is
           * hardcoded; the expected QL1 arrival folds the
           * token fee in. */
          const tokenFee =
            (await quotePairTokenFee(QOM_BRIDGE_PAIR, amount, 'infinite').catch(
              () => null,
            )) ?? 0n;
          const nativeFee = await freshBridgeFee42('QOM');
          const baseQl1 = await arrivalBalance('ql1', null, address);
          const signer = await signerOn('infinite');
          const hash = await sendTxReq(
            signer,
            buildAggBridge({ pair: QOM_BRIDGE_PAIR }, address, amount, nativeFee),
          );
          const expected = amount > tokenFee ? amount - tokenFee : 0n;
          await advanceX({
            ...xflow,
            baseQl1: baseQl1.toString(),
            expectedQl1: expected.toString(),
            bridgeHash: hash,
          });
          break;
        }
        case 'bridgeOut': {
          const q = await quoteBridgeOut42('bsc', amount);
          /* The flat fee is 2 USDT; a materially worse live
           * quote than that stops the send (the sell flow's
           * proven guard, same tolerance). */
          const fee = 2n * 10n ** 18n;
          if (
            amount - q.forward >
            fee + amount / 1000n + 10n ** 16n
          ) {
            throw new Error('price-moved');
          }
          const baseBsc = await erc20Balance(
            'bsc',
            USDT_ON.bsc.address,
            address,
          ).catch(() => 0n);
          const signer = await signerOn('infinite');
          const hash = await sendTxReq(
            signer,
            buildBridgeOut42Tx('bsc', address, amount, q.totalNative),
          );
          await advanceX({
            ...xflow,
            baseBsc: baseBsc.toString(),
            expectedBsc: xExpectedBscFromForward(q.forward).toString(),
            bridgeHash: hash,
          });
          break;
        }
        case 'deliverQl1': {
          /* Fee quoted live inside the builder, never a
           * hardcoded figure. */
          const tx = await buildCawDeliveryTx(amount, address);
          const signer = await signerOn('infinite');
          await sendTxReq(signer, tx);
          await advanceX(xflow);
          break;
        }
        default:
          break;
      }
      refreshBook();
    } catch (e) {
      setXStatus({
        text: tr(stepErrorKey(classifyStepError(e)) as StrKey),
        err: true,
      });
    } finally {
      setXBusy(false);
    }
  }, [
    xflow,
    contract,
    address,
    xPre,
    xApproveFor,
    signerOn,
    advanceX,
    refreshBook,
  ]);

  /** Judge a wait step against a fresh destination balance. */
  const checkArrival = useCallback(async () => {
    if (!xflow || !address || xPollRef.current) return;
    const step = xCurrentStep(xflow);
    if (!step || !xIsWaitStep(step)) return;
    xPollRef.current = true;
    try {
      if (step === 'wait42') {
        const now = await erc20Balance(
          'infinite',
          xTokenAddr(xflow.kind),
          address,
        );
        if (
          xArrivalVerdict(
            BigInt(xflow.base42 ?? '0'),
            now,
            BigInt(xflow.expected42 ?? '0'),
          ) === 'arrived'
        ) {
          setXStatus({ text: tr('hxd.arrived'), err: false });
          await advanceX(xflow);
        }
      } else if (step === 'waitQl1') {
        /* The wdQom arrival is NATIVE QOM on QL1. */
        const now = await arrivalBalance('ql1', null, address);
        if (
          xArrivalVerdict(
            BigInt(xflow.baseQl1 ?? '0'),
            now,
            BigInt(xflow.expectedQl1 ?? '0'),
          ) === 'arrived'
        ) {
          await advanceX(xflow);
        }
      } else {
        const now = await erc20Balance('bsc', USDT_ON.bsc.address, address);
        if (
          xArrivalVerdict(
            BigInt(xflow.baseBsc ?? '0'),
            now,
            BigInt(xflow.expectedBsc ?? '0'),
          ) === 'arrived'
        ) {
          await advanceX(xflow);
        }
      }
    } catch {
      /* a failed read leaves the step pending, never wrong */
    } finally {
      xPollRef.current = false;
    }
  }, [xflow, address, advanceX]);

  /* Auto-check arrivals while a wait step is showing. */
  const xStepNow = xflow ? xCurrentStep(xflow) : null;
  useEffect(() => {
    if (!xStepNow || !xIsWaitStep(xStepNow)) return;
    checkArrival();
    const id = setInterval(checkArrival, 15000);
    return () => clearInterval(id);
  }, [xStepNow, checkArrival]);

  const discardXFlow = useCallback(async () => {
    setXStatus(null);
    await persistX(null);
  }, [persistX]);

  /* ---------- place order ---------- */
  const minOrderRaw = useMemo(
    () => hxMinOrderUsdtRaw(relayFee, price42),
    [relayFee, price42],
  );

  /** Escrow balance of one token for this wallet (null while
   *  the escrow read has not landed yet). */
  const escOf = useCallback(
    (token: string): bigint | null => {
      if (!escrow) return null;
      const t = token.toLowerCase();
      if (t === HX_USDT.toLowerCase()) return escrow.usdt;
      if (t === HX_QOM.toLowerCase()) return escrow.qom;
      return escrow.caw;
    },
    [escrow],
  );

  const draftOrder = useMemo((): HxOrder | null => {
    if (!address) return null;
    const give = parseAmount(giveText);
    const price = parseAmount(priceText); // quote token per 1e9 CAW, 18dp fixed
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
      ? { ...base, tokenGive: HX_CAW, amountGive: give, tokenGet: pairToken, amountGet: counter }
      : { ...base, tokenGive: pairToken, amountGive: give, tokenGet: HX_CAW, amountGet: counter };
  }, [address, giveText, priceText, side, expirySec, pairToken]);

  /* The minimum-order guide judges the order's USDT VALUE:
   * directly for USDT orders; for QOM orders through the
   * live QOM price — and when that price cannot be quoted
   * the guide stays silent rather than guessing. */
  const belowMin = useMemo((): boolean => {
    if (!draftOrder) return false;
    if (pair === 'usdt') return hxBelowMinOrder(draftOrder, minOrderRaw);
    if (qomUsdtPrice === null) return false;
    const quoteRaw =
      draftOrder.tokenGive.toLowerCase() === HX_QOM.toLowerCase()
        ? draftOrder.amountGive
        : draftOrder.amountGet;
    return hxQomToUsdtRaw(quoteRaw, qomUsdtPrice) < minOrderRaw;
  }, [draftOrder, pair, qomUsdtPrice, minOrderRaw]);

  const placeOrder = useCallback(async () => {
    if (!contract || !draftOrder) return;
    if (!hxServerConfigured()) {
      setStatus({ text: tr('hx.noServer'), err: true });
      return;
    }
    // The give side must be covered by escrow — the server
    // enforces it too; failing here first is kinder.
    const have = escOf(draftOrder.tokenGive);
    if (have !== null && have < draftOrder.amountGive) {
      setStatus({ text: tr('hx.needEscrow'), err: true });
      return;
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
  }, [contract, draftOrder, escOf, signer42, refreshBook]);

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
    const haveGet = escOf(order.tokenGet);
    if (haveGet !== null && haveGet < fillGetAmount) {
      setStatus({ text: tr('hx.needEscrow'), err: true });
      return;
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
    escOf,
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
    const rows = book
      .map((l) => ({ l, o: deserializeOrder(l.order) }))
      /* Pair scoping: an order belongs to the book whose
       * quote token is its non-CAW side. */
      .filter((r) => orderSides(r.o).quoteSym === pairSym);
    const asks = rows
      .filter((r) => r.o.tokenGive.toLowerCase() === HX_CAW.toLowerCase())
      .sort((a, b) =>
        hxOrderPriceScaled(a.o) < hxOrderPriceScaled(b.o) ? -1 : 1,
      );
    const bids = rows
      .filter((r) => r.o.tokenGive.toLowerCase() !== HX_CAW.toLowerCase())
      .sort((a, b) =>
        hxOrderPriceScaled(a.o) > hxOrderPriceScaled(b.o) ? -1 : 1,
      );
    return { asks, bids };
  }, [book, pairSym]);

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

  const xCur = xflow ? xCurrentStep(xflow) : null;
  const xParsed = xSetup ? parseAmount(xAmount) : null;
  const xFeePreview = ((): string | null => {
    if (!xSetup) return null;
    if (
      xSetup === 'depUsdt' &&
      xRoute === 'bsc' &&
      xParsed !== null &&
      xParsed > 0n
    ) {
      return tr('hxd.feeBridgeIn', {
        amount: fmtAmountCardDec(xPreviewDepUsdtArrival(xParsed), 18),
      });
    }
    if (xSetup === 'depCaw' && xRoute === 'ql1') {
      return tr('hxd.feeBridgeFree');
    }
    if (xSetup === 'depQom' && xRoute === 'ql1') {
      return tr('hxd.feeQomBridge');
    }
    if (xSetup === 'wdQom' && xRoute === 'ql1') {
      return tr('hxd.feeRelayQom', {
        fee: qomRelayFee !== null ? fmtAmount(qomRelayFee) : '—',
      });
    }
    if (
      xSetup === 'wdUsdt' &&
      xRoute === 'bsc' &&
      xParsed !== null &&
      xParsed > 0n
    ) {
      return tr('hxd.feeBridgeOut', {
        amount: fmtAmountCardDec(xPreviewWdUsdtArrival(xParsed), 18),
      });
    }
    if (xSetup === 'wdCaw' && xRoute === 'ql1') {
      return tr('hx.deliveryFee', {
        fee: relayFee !== null ? fmtAmount(relayFee) : '—',
      });
    }
    return null;
  })();

  return (
    <View>
      {/* reference price strip + pair switcher */}
      <View style={card}>
        <Text style={S.h2}>{tr('hx.title')}</Text>
        <View style={[chipRow, { marginTop: 10 }]}>
          <Pressable
            style={chip(pair === 'usdt')}
            onPress={() => setPair('usdt')}
          >
            <Text style={chipText(pair === 'usdt')}>{tr('hx.pairUsdt')}</Text>
          </Pressable>
          <Pressable
            style={chip(pair === 'qom')}
            onPress={() => setPair('qom')}
          >
            <Text style={chipText(pair === 'qom')}>{tr('hx.pairQom')}</Text>
          </Pressable>
        </View>
        <Text style={[S.small, { marginTop: 6 }]}>
          {pair === 'usdt'
            ? tr('hx.reference', {
                // refQuote: USDT raw (6 dp) per 1e9 CAW from QomSwap.
                price:
                  refQuote !== null
                    ? (Number(refQuote) / 1_000_000).toFixed(2)
                    : '—',
              })
            : tr('hx.referenceQom', {
                // refQomQuote: QOM raw (18 dp) per 1e9 CAW from QomSwap.
                price:
                  refQomQuote !== null
                    ? fmtAmountCardDec(refQomQuote, 18)
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

      {/* escrow + guided deposit / withdraw flows */}
      <View style={card}>
        <Text style={S.h2}>{tr('hx.escrowTitle')}</Text>
        <Text style={[S.body, { marginTop: 6 }]}>
          {tr('hx.escrowBalances', {
            usdt: escrow ? fmtAmountCardDec(escrow.usdt, 18) : '—',
            caw: escrow ? fmtAmountCardDec(escrow.caw, 18) : '—',
            qom: escrow ? fmtAmountCardDec(escrow.qom, 18) : '—',
          })}
        </Text>

        {xflow ? (
          /* ---- an in-progress (or resumed) flow ---- */
          <View style={{ marginTop: 12 }}>
            <Text style={[S.body, { fontWeight: '700' }]}>
              {tr(X_KIND_TITLE[xflow.kind])} —{' '}
              {fmtAmountCardDec(BigInt(xflow.amountRaw), 18)}{' '}
              {xTokenSym(xflow.kind)}
            </Text>
            {xResumed ? (
              <Text style={[S.small, { marginTop: 2 }]}>
                {tr('hxd.resumeTitle')}
              </Text>
            ) : null}
            <View style={{ marginTop: 8 }}>
              {xStepsFor(xflow.kind, xflow.route).map((s, i) => {
                const st =
                  i < xflow.step ? 'done' : i === xflow.step ? 'now' : 'todo';
                return (
                  <View key={s} style={[S.row, { marginTop: 6, gap: 8 }]}>
                    <Text>
                      {st === 'done' ? '✅' : st === 'now' ? '▶️' : '・'}
                    </Text>
                    <Text
                      style={[
                        S.body,
                        st === 'now' && { fontWeight: '700' },
                        st === 'todo' && { color: '#8899a6' },
                      ]}
                    >
                      {tr(X_STEP_LABEL[s])}
                    </Text>
                  </View>
                );
              })}
            </View>
            {xCur && xIsWaitStep(xCur) ? (
              <Text style={[S.small, { marginTop: 10 }]}>
                {tr('hxd.waitingNote')}
              </Text>
            ) : null}
            {xPre && xCur && xPre.step === xCur && xPre.blocked ? (
              <Text style={[S.err, { marginTop: 10 }]}>{xPre.blocked}</Text>
            ) : null}
            {xCur && xIsWaitStep(xCur) ? (
              <Pressable
                style={[S.bigBtn, { marginTop: 12 }, xBusy && S.disabled]}
                disabled={xBusy}
                onPress={checkArrival}
              >
                {xBusy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={S.bigBtnText}>{tr('hxd.checkNow')}</Text>
                )}
              </Pressable>
            ) : xCur ? (
              <Pressable
                style={[S.bigBtn, { marginTop: 12 }, xBusy && S.disabled]}
                disabled={xBusy}
                onPress={runXStep}
              >
                {xBusy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={S.bigBtnText}>
                    {xPre && xPre.step === xCur && xPre.needsApprove
                      ? tr('hxd.stepApprove')
                      : tr(X_STEP_LABEL[xCur])}
                  </Text>
                )}
              </Pressable>
            ) : null}
            <Pressable
              style={{ marginTop: 12, alignSelf: 'flex-start' }}
              onPress={discardXFlow}
            >
              <Text
                style={[S.small, { color: '#b03a2e', fontWeight: '600' }]}
              >
                {tr('hxd.discard')}
              </Text>
            </Pressable>
            <Text style={[S.tiny, { marginTop: 4 }]}>
              {tr('hxd.discardNote')}
            </Text>
          </View>
        ) : xSetup ? (
          /* ---- flow setup ---- */
          <View style={{ marginTop: 12 }}>
            <Text style={[S.body, { fontWeight: '700' }]}>
              {tr(X_KIND_TITLE[xSetup])}
            </Text>
            <Text style={[S.small, { marginTop: 4 }]}>
              {tr(X_KIND_INTRO[xSetup])}
            </Text>
            <View style={chipRow}>
              {X_ROUTES[xSetup].map((r) => (
                <Pressable
                  key={r.k}
                  style={chip(xRoute === r.k)}
                  onPress={() => setXRoute(r.k)}
                >
                  <Text style={chipText(xRoute === r.k)}>{tr(r.label)}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              style={[S.input, { marginTop: 10 }]}
              value={xAmount}
              onChangeText={(t) => setXAmount(t.replace(/[^0-9.]/g, ''))}
              placeholder="0.0"
              keyboardType="decimal-pad"
            />
            <Text style={[S.tiny, { marginTop: 6 }]}>
              {tr('hx.available', {
                amount:
                  xSourceMax !== null
                    ? fmtAmountCardDec(xSourceMax, 18)
                    : '—',
                symbol: xTokenSym(xSetup),
              })}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              {[25, 50, 75, 100].map((p) => (
                <Pressable
                  key={p}
                  style={pctChip}
                  onPress={() => {
                    if (xSourceMax !== null) {
                      setXAmount(
                        fmtExactDec((xSourceMax * BigInt(p)) / 100n, 18),
                      );
                    }
                  }}
                >
                  <Text style={pctChipText}>
                    {p === 100 ? 'MAX' : p + '%'}
                  </Text>
                </Pressable>
              ))}
            </View>
            {xFeePreview ? (
              <Text style={[S.small, { marginTop: 10 }]}>{xFeePreview}</Text>
            ) : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 12 }]}
              onPress={startXFlow}
            >
              <Text style={S.bigBtnText}>{tr('hxd.start')}</Text>
            </Pressable>
            <Pressable
              style={{ marginTop: 10, alignSelf: 'flex-start' }}
              onPress={() => setXSetup(null)}
            >
              <Text style={S.small}>{tr('settings.cancel')}</Text>
            </Pressable>
          </View>
        ) : (
          /* ---- the plain entry buttons: the quote-token pair
           * follows the pair switcher; CAW is the shared leg,
           * so its deposit / withdraw is shown under both
           * pairs. ---- */
          <View>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              <Pressable
                style={flowBtn}
                onPress={() => openSetup(pair === 'usdt' ? 'depUsdt' : 'depQom')}
              >
                <Text style={flowBtnText}>
                  {tr(pair === 'usdt' ? 'hxd.depUsdt' : 'hxd.depQom')}
                </Text>
              </Pressable>
              <Pressable style={flowBtn} onPress={() => openSetup('depCaw')}>
                <Text style={flowBtnText}>{tr('hxd.depCaw')}</Text>
              </Pressable>
            </View>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Pressable
                style={flowBtnGhost}
                onPress={() => openSetup(pair === 'usdt' ? 'wdUsdt' : 'wdQom')}
              >
                <Text style={flowBtnGhostText}>
                  {tr(pair === 'usdt' ? 'hxd.wdUsdt' : 'hxd.wdQom')}
                </Text>
              </Pressable>
              <Pressable
                style={flowBtnGhost}
                onPress={() => openSetup('wdCaw')}
              >
                <Text style={flowBtnGhostText}>{tr('hxd.wdCaw')}</Text>
              </Pressable>
            </View>
          </View>
        )}

        {xStatus ? (
          <Text style={[xStatus.err ? S.err : S.ok, { marginTop: 10 }]}>
            {xStatus.text}
          </Text>
        ) : null}
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
          {side === 'sell'
            ? tr('hx.giveCaw')
            : pair === 'usdt'
              ? tr('hx.giveUsdt')
              : tr('hx.giveQom')}
        </Text>
        <TextInput
          style={[S.input, { marginTop: 4 }]}
          value={giveText}
          onChangeText={(t) => setGiveText(t.replace(/[^0-9.]/g, ''))}
          placeholder="0.0"
          keyboardType="decimal-pad"
        />
        <Text style={[S.small, { marginTop: 10 }]}>
          {tr(pair === 'usdt' ? 'hx.priceLabel' : 'hx.priceLabelQom')}
        </Text>
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
              symbol: side === 'sell' ? pairSym : 'CAW',
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

      {/* my orders (scoped to the pair being shown) */}
      {myOrders.filter(
        (l) => orderSides(deserializeOrder(l.order)).quoteSym === pairSym,
      ).length > 0 ? (
        <View style={card}>
          <Text style={S.h2}>{tr('hx.myOrders')}</Text>
          {myOrders
            .filter(
              (l) =>
                orderSides(deserializeOrder(l.order)).quoteSym === pairSym,
            )
            .map((l, i) => {
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
                    {pricePer1e9(s.quote, s.caw)} {s.quoteSym}
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
          <Text style={S.h2}>
            {tr(pair === 'usdt' ? 'hx.bookTitle' : 'hx.bookTitleQom')}
          </Text>
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
                  {pricePer1e9(s.quote, s.caw)} {s.quoteSym} / 10⁹ CAW
                </Text>
                <Text style={S.small}>
                  {tr('hx.fillRemaining', {
                    amount:
                      fillRemaining !== null
                        ? fmtAmountCardDec(fillRemaining, 18)
                        : '—',
                    symbol: giveIsCaw ? 'CAW' : s.quoteSym,
                  })}
                </Text>
                <Text style={[S.small, { marginTop: 10 }]}>
                  {giveIsCaw
                    ? tr('hx.fillGiveCaw')
                    : s.quoteSym === 'QOM'
                      ? tr('hx.fillGiveQom')
                      : tr('hx.fillGiveUsdt')}
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
                      symbol: giveIsCaw ? s.quoteSym : 'CAW',
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
      <Text style={S.body}>{pricePer1e9(s.quote, s.caw)}</Text>
      <Text style={S.small}>{fmtAmountCardDec(s.caw, 18)} CAW</Text>
      <Text style={S.tiny}>
        {mine ? tr('hx.yours') : tr('hx.fill')}
      </Text>
    </Pressable>
  );
}
