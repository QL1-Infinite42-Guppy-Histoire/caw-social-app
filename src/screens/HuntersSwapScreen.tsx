/**
 * HuntersSwap (v0.3.0) — buy CAW starting from BNB (BSC) or ETH
 * (Ethereum), guided one step at a time, all inside the app:
 *
 *   entry swap (PancakeSwap / Uniswap) -> bridge to 42 Chain
 *   -> best route to QL1 (aggregator engine, fees counted,
 *      [42] fee set aside from the flow itself) -> CAW
 *
 * Every send follows the app's pattern: ConfirmSheet, then
 * app.requireAuth(), then the secret from memory, then send.
 * A fresh quote is taken before every send; if it is much worse
 * than what the user confirmed, the flow stops and asks.
 * Progress is persisted on-device (HuntersFlowStore) so closing
 * the app mid-flow resumes where it left off.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatUnits, parseUnits } from 'ethers';
import * as Clipboard from 'expo-clipboard';

import { AppLogo, ConfirmSheet, HAIRLINE, MONO, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr, type StrKey } from '../i18n';
import { BRIDGE_PAIRS, CHAINS as AGG_CHAINS, tokenById } from '../lib/aggEngine';
import { fmtAmount } from '../lib/cawCore';
import {
  BRIDGE_IN_USDT,
  BRIDGE_OUT_USDT_42,
  ENTRY_DEX,
  USDT_ON,
  type EntryKey,
  type HsChainKey,
} from '../lib/chains';
import {
  flowComplete,
  newFlow,
  nextStep,
  type HuntersFlow,
} from '../lib/flows';
import {
  amountGate,
  applySlippage,
  arrivalAction,
  arrivalBalance,
  buildAggApprove,
  buildAggBridge,
  buildBridgeInTx,
  buildEntrySwapTx,
  buildRouteSwapTx,
  bscSpendable,
  chipAmount,
  classifyStepError,
  entryStepReady,
  entrySwapGuard,
  erc20Allowance,
  partArrivalVerdict,
  erc20Balance,
  ethEntryAllowed,
  ethGasExpensive,
  ethGasInfo,
  expected42Usdt,
  buildUnwrapTx,
  WQOM_ADDR,
  QL1_GAS_KEEP_FLOOR_WEI,
  ql1NativeSpendableWei,
  fetchHsBalances,
  fetchQl1GasShort,
  fetchQl1KeepPlan,
  fetchUsdtStartGasOk,
  freshBridgeFee42,
  freshRoute,
  nativeUsdPrice,
  planCarveout,
  quoteBackHalf,
  quoteBridgeIn,
  quoteCarveUsdtCost,
  quoteEntrySwap,
  netHeadline,
  quoteGasEstimates,
  resumeEntryAdvance,
  stepErrorKey,
  toTargetUsdtRaw,
  waitForReceiptRobust,
  type GasEstimates,
  buildAggBridgeFromQl1,
  buildBridgeOut42Tx,
  buildFinalSwapTx,
  quoteBackHalfReverse,
  quoteBridgeOut42,
  recommendedGoal,
  quoteFinalSwap,
  truncateToDstDecimals,
  worseThanConfirmed,
  type BackHalfQuote,
  type CarvePlan,
  type HsBalances,
} from '../lib/hunters';
import { huntersFlowStore, huntersSellFlowStore, storeKV } from '../lib/stores';
import { sendTxReq, signerForHsChain } from '../lib/wallet';
import SendScreen from './SendScreen';
import FaucetScreen, { FaucetButton } from './FaucetScreen';

type Phase = 'entry' | 'amount' | 'confirm' | 'run' | 'done';

interface Plan {
  entryAmount: bigint;
  entryUsdt: bigint;
  usdt42: bigint;
  back: BackHalfQuote;
  carve: CarvePlan;
  /** USDT (42) the carve swap will spend to make the kept [42]. */
  carveCost: bigint;
  choice: 'single' | 'split';
  /** Headline estimate, NET of the carve-out (see netHeadline). */
  expectedOut: bigint;
  /** Coin the flow starts from (v0.4.1): 'native' swaps first;
   *  'usdt' starts at the bridge with USDT already held. */
  startCoin: 'native' | 'usdt';
  /** USDT start only: live gas pre-flight (null = unreadable). */
  gasOk: boolean | null;
  /** Start point (v0.4.1): 'entry' = from the entry chain;
   *  'usdt42' = mid-start from USDT already held on 42 Chain
   *  (entryAmount/entryUsdt are 0 and unused there). */
  startPoint: 'entry' | 'usdt42';
}

const fmtUsd = (n: number) =>
  '$' + n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 0 });
const fmtTok = (raw: bigint, dec: number) =>
  dec === 18 ? fmtAmount(raw) : formatUnits(raw, dec);

/** Plain label/value row — used by the plan/fee breakdown views
 *  (cost lines, not coin balances, so no badge treatment there). */
function balLine(label: string, raw: bigint | null, dec: number, sym: string) {
  return (
    <View style={[S.row, { justifyContent: 'space-between', marginTop: 6 }]}>
      <Text style={S.small}>{label}</Text>
      <Text style={[S.body, { fontWeight: '600' }]}>
        {raw === null ? '—' : fmtTok(raw, dec) + ' ' + sym}
      </Text>
    </View>
  );
}

/* Balance list styling (v0.3.7): the plain text rows became one
 * rounded card (same language as the Home wallet card) with a
 * circular coin badge per row, the chain name under the token
 * name, the amount bold on the right and — only where the app
 * already has a price (BNB/ETH spot, USDT = $1) — a small USD
 * line under it. Zero-balance rows are dimmed so real holdings
 * stand out. Display only: values and formatting are unchanged. */
const COIN_BADGE: Record<string, { bg: string; fg: string }> = {
  BNB: { bg: '#F0B90B', fg: '#1F2329' },
  ETH: { bg: '#627EEA', fg: '#FFFFFF' },
  USDT: { bg: '#26A17B', fg: '#FFFFFF' },
  '42': { bg: '#151426', fg: '#F5C542' },
  QOM: { bg: '#8E44AD', fg: '#FFFFFF' },
  WQOM: { bg: '#4A235A', fg: '#FFFFFF' },
};

function CoinBadge({ sym }: { sym: string }) {
  if (sym === 'CAW') {
    return (
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: 19,
          overflow: 'hidden',
          backgroundColor: '#151426',
        }}
      >
        <AppLogo size={38} />
      </View>
    );
  }
  const c = COIN_BADGE[sym] ?? { bg: '#868E96', fg: '#FFFFFF' };
  return (
    <View
      style={{
        width: 38,
        height: 38,
        borderRadius: 19,
        backgroundColor: c.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          color: c.fg,
          fontWeight: '800',
          fontSize: sym.length > 3 ? 9.5 : sym.length > 2 ? 11 : 14,
        }}
      >
        {sym}
      </Text>
    </View>
  );
}

function CoinRow({
  name,
  chain,
  raw,
  dec,
  sym,
  usd,
  last,
}: {
  name: string;
  chain: string;
  raw: bigint | null;
  dec: number;
  sym: string;
  usd?: number | null;
  last?: boolean;
}) {
  const zero = raw !== null && raw === 0n;
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 11,
          paddingVertical: 10,
          paddingHorizontal: 13,
        },
        !last && { borderBottomWidth: 1, borderBottomColor: HAIRLINE },
        zero && { opacity: 0.45 },
      ]}
    >
      <CoinBadge sym={sym} />
      <View style={{ flex: 1 }}>
        <Text style={[S.body, { fontWeight: '600' }]}>{name}</Text>
        <Text style={S.tiny}>{chain}</Text>
      </View>
      <View style={{ alignItems: 'flex-end', flexShrink: 1 }}>
        <Text
          style={[S.body, { fontWeight: '700', fontVariant: ['tabular-nums'] }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.6}
        >
          {raw === null ? '—' : fmtTok(raw, dec) + ' ' + sym}
        </Text>
        {usd !== null && usd !== undefined ? (
          <Text style={S.tiny}>≈ {fmtUsd(usd)}</Text>
        ) : null}
      </View>
    </View>
  );
}

const bigOr0 = (s?: string): bigint => {
  try {
    return BigInt(s ?? '0');
  } catch {
    return 0n;
  }
};

/**
 * Spendable native amount for a FRESH balance, applying the
 * same auto-keep the amount screen uses ($3 of BNB on BSC via
 * bscSpendable; the $10 gas portion on Ethereum). The keep is
 * NEVER spent — not by a fresh start, not by a resume, not by
 * any mid-start (invariant, v0.4.1).
 */
function keepAwareSpendable(
  e: EntryKey,
  bal: bigint,
  bnbUsd: number | null,
  ethUsd: number | null,
): bigint {
  if (e === 'bsc') return bnbUsd ? bscSpendable(bal, bnbUsd) : bal;
  if (!ethUsd || ethUsd <= 0) return bal;
  const keep = parseUnits((10 / ethUsd).toFixed(18), 18);
  return bal > keep ? bal - keep : 0n;
}

/**
 * Error surface for a failed guided-flow step (v0.4.1 taxonomy):
 * the message follows the KIND of failure (see classifyStepError
 * in lib/hunters) — insufficient balance, no route, price moved,
 * network, and the distinct UNCONFIRMED text are different
 * messages, and an unconfirmed tx's hash is recorded on the flow
 * so a later resume can re-check it instead of re-running the
 * step blind. Returns the text to show.
 */
async function stepErrorText(
  e: unknown,
  chain: HsChainKey,
  flow: HuntersFlow | null,
  persist: (f: HuntersFlow) => Promise<void>,
): Promise<string> {
  const kind = classifyStepError(e);
  if (kind === 'unconfirmed') {
    const hash = (e as { hash?: unknown }).hash;
    if (typeof hash === 'string' && flow) {
      await persist({
        ...flow,
        pendingTx: { chain, hash, at: Date.now() },
      }).catch(() => {});
    }
  }
  return tr(stepErrorKey(kind) as StrKey);
}

function CoinCard({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: '#fff',
        borderWidth: 1,
        borderColor: HAIRLINE,
        borderRadius: 16,
        marginTop: 10,
        overflow: 'hidden',
      }}
    >
      {children}
    </View>
  );
}

/**
 * Deposit address card (v0.3.3): the active wallet's own address,
 * shown above the balances on the entry screen so it can be copied
 * and pasted into an exchange / another wallet. The app uses ONE
 * address on every chain (BSC / Ethereum / 42 Chain / QL1), so a
 * single row serves all chains. Copying always takes the full 0x
 * string; the "copied" note follows the SettingsScreen pattern.
 */
function DepositAddressRow({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  if (!address) return null;
  const doCopy = async () => {
    await Clipboard.setStringAsync(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: '#eff3f4',
        borderRadius: 14,
        padding: 14,
        marginTop: 14,
      }}
    >
      <Text style={[S.body, { fontWeight: '700' }]}>{tr('hs.depositAddress')}</Text>
      <Text style={[S.small, { marginTop: 2 }]}>{tr('hs.depositSame')}</Text>
      <Text
        selectable
        style={{ fontFamily: MONO, fontSize: 13, color: '#0f1419', marginTop: 8, writingDirection: 'ltr', textAlign: 'left' }}
      >
        {address}
      </Text>
      <Pressable style={[S.ghostBtn, { marginTop: 10 }]} onPress={doCopy}>
        <Text style={S.ghostBtnText}>
          {copied ? tr('hs.addressCopied') : tr('hs.copyAddress')}
        </Text>
      </Pressable>
    </View>
  );
}

function BuySection({
  onClose,
  onSwitchDirection,
}: {
  onClose: () => void;
  onSwitchDirection: () => void;
}) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const address = app.address ?? '';

  const [phase, setPhase] = useState<Phase>('entry');
  const [balances, setBalances] = useState<HsBalances | null>(null);
  const [bnbUsd, setBnbUsd] = useState<number | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [gasUsd, setGasUsd] = useState<number | null>(null);
  const [gasEst, setGasEst] = useState<GasEstimates | null>(null);
  const [entry, setEntry] = useState<EntryKey>('bsc');
  /** Start coin (v0.4.1): swap the native coin into USDT first,
   *  or start from USDT already held on the entry chain. */
  const [startCoin, setStartCoin] = useState<'native' | 'usdt'>('native');
  const [amountText, setAmountText] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [status, setStatus] = useState<{ text: string; err: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<HuntersFlow | null>(null);
  const [resumeFlow, setResumeFlow] = useState<HuntersFlow | null>(null);
  const [pending, setPending] = useState<{ title: string; run: () => Promise<void> } | null>(null);
  const [allowanceTick, setAllowanceTick] = useState(0);
  const flowRef = useRef<HuntersFlow | null>(null);
  flowRef.current = flow;
  /* Step rehydration (v0.4.1): entering the run phase — above all
     on RESUME — rebuilds the current step from fresh chain reads
     before it becomes actionable. `rehydrating` blocks Next while
     that runs; the entry step additionally needs a LIVE quote
     (stepQuote) fetched for exactly this step — saved quote
     values are never restored — and the bridge step shows the
     USDT actually available to send onward (bridgeUsdt). */
  const [rehydrating, setRehydrating] = useState(false);
  const [stepQuote, setStepQuote] = useState<bigint | null>(null);
  const [stepQuoteErr, setStepQuoteErr] = useState(false);
  /* QL1 gas-shortage guidance state (v0.4.1): set by the QL1
     step gates when the native QOM balance cannot cover the
     step's gas; renders the faucet guidance under the step
     card instead of any generic error. */
  const [ql1Short, setQl1Short] = useState(false);
  /* Mid-start (v0.4.1): 'entry' = start on the entry chain
     (native or USDT); 'usdt42' = start from USDT already held
     on 42 Chain, straight into the back half. */
  const [startPoint, setStartPoint] = useState<'entry' | 'usdt42' | 'wqom' | 'qom'>('entry');
  const [bridgeUsdt, setBridgeUsdt] = useState<bigint | null>(null);
  /* WQOM mid-start (v0.4.2): the QL1 gas-keep plan for the
   * typed amount (caps it at the post-keep spendable) and the
   * live WQOM->CAW quote for it. */
  const [wqomPlan, setWqomPlan] = useState<import('../lib/hunters').Ql1KeepPlan | null>(null);
  const [wqomQuote, setWqomQuote] = useState<bigint | null>(null);
  /* Native-QOM direct start (v0.4.2): the same keep plan —
   * for a native start the spendable side is the native
   * balance ABOVE the keep (ql1NativeSpendableWei) — and the
   * live QOM->CAW quote for the typed amount. */
  const [qomPlan, setQomPlan] = useState<import('../lib/hunters').Ql1KeepPlan | null>(null);
  const [qomQuote, setQomQuote] = useState<bigint | null>(null);
  /* Slow-quote reassurance (v0.3.2): if a quote search runs past
     ~15 s, say so in plain words instead of leaving a silent spinner. */
  const [slowQuote, setSlowQuote] = useState(false);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beginQuote = () => {
    setQuoting(true);
    setSlowQuote(false);
    if (slowTimer.current) clearTimeout(slowTimer.current);
    slowTimer.current = setTimeout(() => setSlowQuote(true), 15000);
  };
  const endQuote = () => {
    setQuoting(false);
    setSlowQuote(false);
    if (slowTimer.current) {
      clearTimeout(slowTimer.current);
      slowTimer.current = null;
    }
  };

  /* ---------- loading balances / prices / saved flow ---------- */
  const loadBasics = useCallback(async () => {
    if (!address) return;
    const [b, pb, pe, g] = await Promise.all([
      fetchHsBalances(address).catch(() => null),
      nativeUsdPrice('bsc').catch(() => null),
      nativeUsdPrice('ethereum').catch(() => null),
      ethGasInfo().catch(() => null),
    ]);
    quoteGasEstimates().then((g) => g && setGasEst(g)).catch(() => {});
    if (b) setBalances(b);
    if (pb) setBnbUsd(pb);
    if (pe) setEthUsd(pe);
    if (g) setGasUsd(g.totalUsd450k);
  }, [address]);

  useEffect(() => {
    loadBasics();
    if (address) {
      huntersFlowStore
        .init(storeKV, address)
        .then(() => huntersFlowStore.load())
        .then((f) => {
          if (f && !flowComplete(f)) setResumeFlow(f);
        })
        .catch(() => {});
    }
  }, [address, loadBasics]);

  const persist = useCallback(async (f: HuntersFlow | null) => {
    setFlow(f);
    flowRef.current = f;
    if (f) await huntersFlowStore.save(f);
    else await huntersFlowStore.clear();
  }, []);

  /* ---------- amount helpers ---------- */
  const nativeBalance = (e: EntryKey): bigint =>
    (e === 'bsc' ? balances?.bscNative : balances?.ethNative) ?? 0n;
  const nativePrice = (e: EntryKey): number | null =>
    e === 'bsc' ? bnbUsd : ethUsd;
  const spendable = (e: EntryKey): bigint => {
    const bal = nativeBalance(e);
    if (e === 'bsc') {
      return bnbUsd ? bscSpendable(bal, bnbUsd) : bal;
    }
    // ETH: keep $10 worth for gas (the GuppyWallet guide).
    if (!ethUsd || ethUsd <= 0) return bal;
    const keep = parseUnits((10 / ethUsd).toFixed(18), 18);
    return bal > keep ? bal - keep : 0n;
  };

  /** Decimals of the amount being typed: the native coin is
   *  always 18; a USDT start uses the entry chain's USDT
   *  decimals (18 on BSC, 6 on Ethereum). */
  const amountDecimals = (e: EntryKey): number =>
    startPoint !== 'entry'
      ? 18
      : startCoin === 'usdt'
        ? ENTRY_DEX[e].usdtDecimals
        : 18;

  const parsedAmount = (e: EntryKey): bigint | null => {
    try {
      const v = parseUnits(amountText.trim() === '' ? '0' : amountText.trim(), amountDecimals(e));
      return v;
    } catch {
      return null;
    }
  };

  const usdtBalance = (e: EntryKey): bigint =>
    (e === 'bsc' ? balances?.bscUsdt : balances?.ethUsdt) ?? 0n;

  /* ---------- quoting for the confirm screen ---------- */
  const buildPlan = async (choice: 'single' | 'split') => {
    const amt = parsedAmount(entry);
    if (amt === null || amt <= 0n) return;
    beginQuote();
    setStatus(null);
    try {
      /* USDT start: the amount IS the entry USDT — the swap leg,
         its fees and its slippage simply do not exist. */
      const entryUsdt = startCoin === 'usdt' ? amt : await quoteEntrySwap(entry, amt);
      const usdt42 = expected42Usdt(entryUsdt, ENTRY_DEX[entry].usdtDecimals);
      const back = await quoteBackHalf(usdt42);
      const legs =
        choice === 'split' && back.split ? back.split.parts.length : 1;
      const carve = planCarveout(legs, back.feePerLeg42, balances?.infNative ?? 0n);
      let carveCost = 0n;
      if (carve.needFromFlow > 0n) {
        const q = await quoteCarveUsdtCost(carve.needFromFlow);
        if (q) carveCost = q.usdtCost;
      }
      const rawOut =
        choice === 'split' && back.split ? back.split.netOut : back.bestSingle.finalOut;
      const expectedOut = netHeadline(rawOut, usdt42, carveCost);
      /* USDT start: run the gas pre-flight NOW so the confirm
         screen can show the plain gas message before anything
         is executed (re-checked again at the bridge step). */
      const gasOk =
        startCoin === 'usdt' ? await fetchUsdtStartGasOk(entry, address) : null;
      setPlan({
        entryAmount: amt,
        entryUsdt,
        usdt42,
        back,
        carve,
        carveCost,
        choice,
        expectedOut,
        startCoin,
        gasOk,
        startPoint: 'entry',
      });
      setPhase('confirm');
    } catch (e) {
      setStatus({
        text: tr(e instanceof Error && e.message === 'no-route' ? 'hs.noRoute' : 'hs.netFailed'),
        err: true,
      });
    } finally {
      endQuote();
    }
  };

  /**
   * Mid-start plan (v0.4.1): start from USDT already held on
   * 42 Chain. There are no entry legs at all — the amount IS
   * the 42 USDT the back half runs on — so the plan is just
   * the back-half quote plus the [42] gas carve, exactly what
   * initBackHalf will re-quote when the flow starts.
   */
  const buildPlan42 = async (choice: 'single' | 'split') => {
    const amt = parsedAmount(entry);
    if (amt === null || amt <= 0n) return;
    beginQuote();
    setStatus(null);
    try {
      const back = await quoteBackHalf(amt);
      const legs =
        choice === 'split' && back.split ? back.split.parts.length : 1;
      const carve = planCarveout(legs, back.feePerLeg42, balances?.infNative ?? 0n);
      let carveCost = 0n;
      if (carve.needFromFlow > 0n) {
        const q = await quoteCarveUsdtCost(carve.needFromFlow);
        if (q) carveCost = q.usdtCost;
      }
      const rawOut =
        choice === 'split' && back.split ? back.split.netOut : back.bestSingle.finalOut;
      const expectedOut = netHeadline(rawOut, amt, carveCost);
      setPlan({
        entryAmount: 0n,
        entryUsdt: 0n,
        usdt42: amt,
        back,
        carve,
        carveCost,
        choice,
        expectedOut,
        startCoin: 'native',
        gasOk: null,
        startPoint: 'usdt42',
      });
      setPhase('confirm');
    } catch (e) {
      setStatus({
        text: tr(e instanceof Error && e.message === 'no-route' ? 'hs.noRoute' : 'hs.netFailed'),
        err: true,
      });
    } finally {
      endQuote();
    }
  };

  /* ---------- starting / resuming ---------- */
  const startFlow = async () => {
    if (!plan || !address) return;
    const before = await erc20Balance(
      entry,
      USDT_ON[entry].address,
      address,
    ).catch(() => 0n);
    const usdtStart = plan.startCoin === 'usdt';
    /* USDT start: the flow bridges part of an EXISTING balance,
       so "before" is recorded net of the committed amount — the
       bridge step then measures exactly that amount with the
       same balance-minus-before math the swap path uses once
       its swap has landed. The flow starts AT the bridge step:
       there is no swap to run. */
    const beforeForFlow = usdtStart
      ? before > plan.entryAmount
        ? before - plan.entryAmount
        : 0n
      : before;
    const f = newFlow({
      id: Date.now().toString(36),
      address,
      entry,
      entryAmountRaw: plan.entryAmount.toString(),
      entryUsdtExpected: plan.entryUsdt.toString(),
      usdt42Expected: plan.usdt42.toString(),
      confirmedOut: plan.expectedOut.toString(),
      choice: plan.choice,
      createdAt: Date.now(),
      entryUsdtBefore: beforeForFlow.toString(),
      carveUsdtCost: plan.carveCost.toString(),
      startCoin: plan.startCoin,
      finalAsset: 'CAW',
      finalChain: 'ql1',
    });
    setResumeFlow(null);
    await persist(usdtStart ? { ...f, phase: 'entryBridge' } : f);
    setPhase('run');
  };

  /**
   * Mid-start from 42 Chain USDT (v0.4.1): the flow is born at
   * the back-half phase — the SAME saved-state shape and the
   * SAME initializer (initBackHalf) a bridged-in flow uses, so
   * resume treats it identically. "Before" is recorded net of
   * the committed amount, as with the USDT entry start.
   */
  const startFlow42 = async () => {
    if (!plan || !address) return;
    const bal = await erc20Balance(
      'infinite',
      USDT_ON.infinite.address,
      address,
    ).catch(() => 0n);
    const before = bal > plan.usdt42 ? bal - plan.usdt42 : 0n;
    const f = newFlow({
      id: Date.now().toString(36),
      address,
      entry,
      entryAmountRaw: '0',
      entryUsdtExpected: '0',
      usdt42Expected: plan.usdt42.toString(),
      confirmedOut: plan.expectedOut.toString(),
      choice: plan.choice,
      createdAt: Date.now(),
      entryUsdtBefore: '0',
      usdt42Before: before.toString(),
      usdt42Actual: plan.usdt42.toString(),
      carveUsdtCost: plan.carveCost.toString(),
      startCoin: 'usdt',
      finalAsset: 'CAW',
      finalChain: 'ql1',
    });
    setResumeFlow(null);
    await persist({ ...f, phase: 'back' });
    setPhase('run');
    await initBackHalf({ ...f, phase: 'back' });
  };

  /* WQOM mid-start (v0.4.2): the amount screen for a WQOM
   * start keeps a fresh gas-keep plan (its spendable caps the
   * amount — the reserve is never presented as usable) and a
   * fresh WQOM->CAW quote for the typed amount. */
  useEffect(() => {
    if (phase !== 'amount' || startPoint !== 'wqom') return;
    let live = true;
    fetchQl1KeepPlan(address)
      .then((p) => {
        if (live) setWqomPlan(p);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [phase, startPoint, address]);

  useEffect(() => {
    if (phase !== 'amount' || startPoint !== 'wqom') {
      setWqomQuote(null);
      return;
    }
    const amt = parsedAmount(entry);
    if (amt === null || amt <= 0n) {
      setWqomQuote(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      freshRoute('ql1', WQOM_ADDR, tokenById('ql1', 'qcaw').address, amt, null)
        .then((r) => {
          if (live) setWqomQuote(r ? BigInt(r.amountOut) : null);
        })
        .catch(() => {
          if (live) setWqomQuote(null);
        });
    }, 600);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, startPoint, amountText, address]);

  /**
   * Mid-start from WQOM held on QL1 (v0.4.2): the flow is
   * born as a single QOM part parked at the QL1 swap step —
   * the SAME saved-state shape a bridged part reaches
   * organically, so the run phase, the gas-keep enforcement
   * in the swap step and resume all treat it identically.
   * The keep plan and the quote are re-read at start; a plan
   * that cannot secure the gas keep never starts (the faucet
   * guidance is what the amount screen shows instead).
   */
  const startWqomFlow = async () => {
    if (!address) return;
    const amt = parsedAmount(entry);
    if (amt === null || amt <= 0n) return;
    setStatus(null);
    const planNow = await fetchQl1KeepPlan(address).catch(() => null);
    if (planNow) {
      setWqomPlan(planNow);
      if (planNow.action === 'faucet') return;
      if (amt > planNow.spendableWei) {
        setStatus({ text: tr('hs.notEnough'), err: true });
        return;
      }
    }
    const route = await freshRoute(
      'ql1',
      WQOM_ADDR,
      tokenById('ql1', 'qcaw').address,
      amt,
      null,
    ).catch(() => null);
    if (!route) {
      setStatus({ text: tr('hs.noRoute'), err: true });
      return;
    }
    const f = newFlow({
      id: Date.now().toString(36),
      address,
      entry,
      entryAmountRaw: '0',
      entryUsdtExpected: '0',
      usdt42Expected: '0',
      confirmedOut: BigInt(route.amountOut).toString(),
      choice: 'single',
      createdAt: Date.now(),
      finalAsset: 'CAW',
      finalChain: 'ql1',
    });
    setResumeFlow(null);
    await persist({
      ...f,
      phase: 'back',
      carveDone: true,
      parts: [
        {
          sym: 'QOM',
          pct: 100,
          usdtIn: '0',
          leg1Path: null,
          leg2Path: route.path as string[],
          step: 3,
          bridgedAmount: amt.toString(),
          dstBaseIsToken: true,
        },
      ],
    });
    setPhase('run');
  };

  /* Native-QOM direct start (v0.4.2): the amount screen for
   * a QOM start keeps the same shared gas-keep plan fresh —
   * its NATIVE spendable (balance minus the keep) caps the
   * amount, so the reserve is never presented as usable —
   * and a fresh QOM->CAW quote for the typed amount. The
   * quote runs over the QOM pair (WQOM address is the pair
   * token); only the SPEND differs (native, at step 3). */
  useEffect(() => {
    if (phase !== 'amount' || startPoint !== 'qom') return;
    let live = true;
    fetchQl1KeepPlan(address)
      .then((p) => {
        if (live) setQomPlan(p);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [phase, startPoint, address]);

  useEffect(() => {
    if (phase !== 'amount' || startPoint !== 'qom') {
      setQomQuote(null);
      return;
    }
    const amt = parsedAmount(entry);
    if (amt === null || amt <= 0n) {
      setQomQuote(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      freshRoute('ql1', WQOM_ADDR, tokenById('ql1', 'qcaw').address, amt, null)
        .then((r) => {
          if (live) setQomQuote(r ? BigInt(r.amountOut) : null);
        })
        .catch(() => {
          if (live) setQomQuote(null);
        });
    }, 600);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, startPoint, amountText, address]);

  /**
   * Direct start from NATIVE QOM held on QL1 (v0.4.2, the
   * user's explicit go-ahead): the flow is born as a single
   * QOM part parked at the QL1 swap step, marked
   * srcNativeQom so step 3 spends natively and enforces the
   * keep against the native balance — the same saved-state
   * shape and resume machinery as every other start. The
   * keep plan is re-read at start: an amount that would eat
   * into the 100-action keep never starts, and when the keep
   * cannot be secured the amount screen's faucet guidance is
   * what stands instead.
   */
  const startQomFlow = async () => {
    if (!address) return;
    const amt = parsedAmount(entry);
    if (amt === null || amt <= 0n) return;
    setStatus(null);
    const planNow = await fetchQl1KeepPlan(address).catch(() => null);
    if (planNow) {
      setQomPlan(planNow);
      if (planNow.action === 'faucet') return;
      if (amt > ql1NativeSpendableWei(planNow)) {
        setStatus({ text: tr('hs.notEnough'), err: true });
        return;
      }
    }
    const route = await freshRoute(
      'ql1',
      WQOM_ADDR,
      tokenById('ql1', 'qcaw').address,
      amt,
      null,
    ).catch(() => null);
    if (!route) {
      setStatus({ text: tr('hs.noRoute'), err: true });
      return;
    }
    const f = newFlow({
      id: Date.now().toString(36),
      address,
      entry,
      entryAmountRaw: '0',
      entryUsdtExpected: '0',
      usdt42Expected: '0',
      confirmedOut: BigInt(route.amountOut).toString(),
      choice: 'single',
      createdAt: Date.now(),
      finalAsset: 'CAW',
      finalChain: 'ql1',
    });
    setResumeFlow(null);
    await persist({
      ...f,
      phase: 'back',
      carveDone: true,
      parts: [
        {
          sym: 'QOM',
          pct: 100,
          usdtIn: '0',
          leg1Path: null,
          leg2Path: route.path as string[],
          step: 3,
          bridgedAmount: amt.toString(),
          srcNativeQom: true,
        },
      ],
    });
    setPhase('run');
  };

  /**
   * Resume (v0.4.1 rework): the saved flow is NEVER dropped
   * straight onto an actionable step screen. Fresh chain state
   * is read first and every decision is made from it:
   *  - a recorded unconfirmed tx is re-checked; a confirmed one
   *    clears the record (the step it belonged to is reconciled
   *    by the balance evidence below);
   *  - if the flow sits on its entry swap but the balance
   *    evidence says that swap already landed, the flow advances
   *    to the bridge step — where the user actually stopped;
   *  - if the entry step cannot be rebuilt (no valid saved
   *    amount), the guidance restarts from that step's input
   *    (the amount screen) instead of showing an empty step.
   * While this runs, `rehydrating` keeps Next disabled; the
   * step's live quote is then fetched by the step-data effect.
   */
  const resume = async () => {
    if (!resumeFlow) return;
    const f0 = resumeFlow;
    setResumeFlow(null);
    setRehydrating(true);
    setStatus(null);
    /* The saved flow's entry chain and start coin ARE the
       resume state — the step screens and the bridge builder
       read them from component state, so they are restored
       from the flow, never left at a default. */
    setEntry(f0.entry);
    setStartCoin(f0.startCoin ?? 'native');
    setStartPoint(f0.phase === 'back' && f0.entryAmountRaw === '0' ? 'usdt42' : 'entry');
    try {
      let f = f0;
      const b = await fetchHsBalances(address).catch(() => null);
      if (b) setBalances(b);
      if (f.pendingTx) {
        const rc = await waitForReceiptRobust(
          f.pendingTx.chain as HsChainKey,
          f.pendingTx.hash,
          { windowMs: 8000 },
        ).catch(() => null);
        if (rc && rc.status === 1) {
          const cleared = { ...f };
          delete cleared.pendingTx;
          f = cleared;
          setStatus({ text: tr('hs.stepAlreadyDone'), err: false });
        }
      }
      if (f.phase === 'entrySwap') {
        const usdtNow = await erc20Balance(
          f.entry,
          USDT_ON[f.entry].address,
          address,
        ).catch(() => null);
        if (usdtNow !== null) {
          const adv = resumeEntryAdvance(f, usdtNow);
          if (adv) {
            f = adv;
            setStatus({ text: tr('hs.stepAlreadyDone'), err: false });
          }
        }
        if (f.phase === 'entrySwap' && bigOr0(f.entryAmountRaw) <= 0n) {
          await huntersFlowStore.clear();
          setFlow(null);
          flowRef.current = null;
          setPhase('amount');
          setStatus({ text: tr('hs.netFailed'), err: true });
          return;
        }
      }
      setFlow(f);
      flowRef.current = f;
      if (f !== f0) await huntersFlowStore.save(f);
      setPhase(flowComplete(f) ? 'done' : 'run');
    } finally {
      setRehydrating(false);
    }
  };

  const discard = async () => {
    setResumeFlow(null);
    await huntersFlowStore.clear();
  };

  /* U-turn (v0.4.1): abandon this direction and start the
     reverse goal from the assets currently held. Legs already
     broadcast are NOT reversed (a sent swap/bridge cannot be
     un-sent) — the saved flow is discarded and the other
     direction's balance-based start points take over; the
     new flow fixes its own final asset at its start. */
  const uturn = async () => {
    await persist(null);
    setResumeFlow(null);
    setPhase('entry');
    setStatus(null);
    onSwitchDirection();
  };

  /* ---------- generic send (app auth pattern) ---------- */
  const sendStep = async (
    chain: 'bsc' | 'ethereum' | 'infinite' | 'ql1',
    build: () => Promise<{ to: string; data: string; value: bigint }>,
    after: (f: HuntersFlow) => HuntersFlow,
  ) => {
    const f0 = flowRef.current;
    if (!f0) return;
    setBusy(true);
    setStatus({ text: tr('hs.sending'), err: false });
    try {
      const ok = await app.requireAuth();
      if (!ok) {
        setStatus(null);
        setPending(null);
        return;
      }
      const sec = app.getSecret();
      if (!sec) throw new Error('no secret');
      const signer = signerForHsChain(sec.kind, sec.secret, chain);
      const req = await build();
      await sendTxReq(signer, req);
      const base = { ...flowRef.current! };
      delete base.pendingTx;
      const f1 = after(base);
      await persist(f1);
      setStatus(null);
      setPending(null);
      setAllowanceTick((t) => t + 1);
    } catch (e) {
      const text = await stepErrorText(e, chain, flowRef.current, persist);
      setStatus({ text, err: true });
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const askSend = (title: string, run: () => Promise<void>) =>
    setPending({ title, run });

  /* ---------- arrival watching ---------- */
  const step = flow ? nextStep(flow) : null;
  const watching =
    phase === 'run' &&
    flow !== null &&
    (step?.kind === 'wait42' || (step?.kind === 'part' && step.step === 2));

  useEffect(() => {
    if (!watching || !flow) return;
    let live = true;
    const check = async () => {
      const f = flowRef.current;
      if (!f || !address) return;
      try {
        if (f.phase === 'wait42') {
          const now = await arrivalBalance('infinite', USDT_ON.infinite.address, address);
          const before = BigInt(f.usdt42Before ?? '0');
          const arrived = now - before;
          const want = (BigInt(f.usdt42Expected) * 99n) / 100n;
          if (arrived >= want && arrived > 0n) {
            const f1: HuntersFlow = {
              ...f,
              phase: 'back',
              usdt42Actual: arrived.toString(),
            };
            if (live) await initBackHalf(f1);
          }
        } else {
          const s = nextStep(f);
          if (s.kind === 'part' && s.step === 2) {
            const part = f.parts[s.partIdx];
            const pair = BRIDGE_PAIRS.find((p) => p.sym === part.sym);
            if (!pair) return;
            const dstTok = tokenById('ql1', pair.ql1Id);
            /* v0.4.2: a QL1 bridge delivery is ALWAYS the
             * pair token as an ERC-20 — QOM included, which
             * lands as WQOM (dstTok.address), never as native
             * QOM. Watching the native balance (the pre-v0.4.2
             * QOM shortcut) could never see the delivery and
             * parked the part here forever. partArrivalVerdict
             * also repairs baselines that older versions
             * captured from the native balance. */
            const now = await arrivalBalance('ql1', dstTok.address, address);
            const verdict = partArrivalVerdict(now, part);
            if (verdict.action === 'arrived') {
              const parts = f.parts.slice();
              parts[s.partIdx] = {
                ...part,
                step: part.leg2Path ? 3 : 4,
                bridgedAmount: verdict.arrived.toString(),
              };
              if (live) await persist({ ...f, parts });
            } else if (verdict.action === 'rebase') {
              const parts = f.parts.slice();
              parts[s.partIdx] = {
                ...part,
                dstBalanceBefore: now.toString(),
                dstBaseIsToken: true,
              };
              if (live) await persist({ ...f, parts });
            }
          }
        }
      } catch {
        /* a failed poll just tries again next tick */
      }
    };
    const iv = setInterval(check, 12000);
    check();
    return () => {
      live = false;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, flow?.phase, flow?.parts, address]);

  /* ---------- step data (live rebuild, v0.4.1) ----------
   * Whenever the run phase presents a step — fresh start AND
   * resume — its content is rebuilt from live reads: the entry
   * swap gets a FRESH quote for its saved amount (never the
   * confirm-screen numbers), and the bridge step measures the
   * USDT actually available to send onward. Until the entry
   * quote lands, entryStepReady() keeps Next disabled. */
  const stepKind = step?.kind ?? null;
  useEffect(() => {
    setStepQuote(null);
    setStepQuoteErr(false);
    setBridgeUsdt(null);
    if (phase !== 'run' || !flow) return;
    if (stepKind === 'entrySwap') {
      const amt = bigOr0(flow.entryAmountRaw);
      if (amt <= 0n) {
        setStepQuoteErr(true);
        return;
      }
      let live = true;
      quoteEntrySwap(flow.entry, amt)
        .then((q) => {
          if (live) setStepQuote(q);
        })
        .catch(() => {
          if (live) setStepQuoteErr(true);
        });
      return () => {
        live = false;
      };
    }
    if (stepKind === 'entryBridge') {
      let live = true;
      erc20Balance(flow.entry, USDT_ON[flow.entry].address, address)
        .then((bal) => {
          if (!live) return;
          const before = bigOr0(flow.entryUsdtBefore);
          setBridgeUsdt(bal > before ? bal - before : 0n);
        })
        .catch(() => {});
      return () => {
        live = false;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, flow?.id, flow?.phase, stepKind, address]);

  /* ---------- back-half initialisation (quote + parts + carve) -- */
  const initBackHalf = async (f: HuntersFlow, accept: boolean = false) => {
    try {
      const total = BigInt(f.usdt42Actual ?? f.usdt42Expected);
      const back = await quoteBackHalf(total);
      const freshRaw =
        f.choice === 'split' && back.split ? back.split.netOut : back.bestSingle.finalOut;
      const freshExpected = netHeadline(freshRaw, total, BigInt(f.carveUsdtCost ?? '0'));
      if (!accept && worseThanConfirmed(freshExpected, BigInt(f.confirmedOut))) {
        // Prices moved a lot while bridging: stop and ask before
        // running anything on the back half.
        setBackStale(true);
        setStatus({ text: tr('hs.priceMoved'), err: true });
        await persist({ ...f, parts: [], confirmedOut: f.confirmedOut });
        return;
      }
      if (accept) {
        f = { ...f, confirmedOut: freshExpected.toString() };
        setBackStale(false);
        setStatus(null);
      }
      const useSplit = f.choice === 'split' && back.split !== null;
      const legs = useSplit && back.split ? back.split.parts.length : 1;
      const infNative = await arrivalBalance('infinite', null, address).catch(() => 0n);
      const carve = planCarveout(legs, back.feePerLeg42, infNative);
      let carveCost = 0n;
      if (carve.needFromFlow > 0n) {
        const q = await quoteCarveUsdtCost(carve.needFromFlow);
        if (q) carveCost = q.usdtCost;
      }
      const parts: HuntersFlow['parts'] = [];
      if (useSplit && back.split) {
        let used = 0n;
        back.split.parts.forEach((p: any, i: number) => {
          const isLast = i === back.split!.parts.length - 1;
          let amt = isLast ? total - used : (total * BigInt(p.pct)) / 100n;
          if (i === 0) amt -= carveCost;
          used += isLast ? total - used : (total * BigInt(p.pct)) / 100n;
          parts.push({
            sym: p.cand.pair.sym,
            pct: p.pct,
            usdtIn: amt.toString(),
            leg1Path: p.cand.leg1Path ?? null,
            leg2Path: p.cand.leg2Path ?? null,
            step: 0,
          });
        });
      } else {
        const c = back.bestSingle;
        parts.push({
          sym: c.pair.sym,
          pct: 100,
          usdtIn: (total - carveCost).toString(),
          leg1Path: c.leg1Path ?? null,
          leg2Path: c.leg2Path ?? null,
          step: 0,
        });
      }
      await persist({
        ...f,
        parts,
        carveDone: carve.needFromFlow <= 0n,
        carveUsdtCost: carveCost.toString(),
      });
    } catch {
      setStatus({ text: tr('hs.failed'), err: true });
    }
  };

  /* ---------- step runners (each takes a FRESH quote first) ---- */
  const [backStale, setBackStale] = useState(false);

  const runEntrySwap = () =>
    askSend(tr(entry === 'bsc' ? 'hs.stepEntrySwapBsc' : 'hs.stepEntrySwapEth'), async () => {
      const f = flowRef.current!;
      const amt = BigInt(f.entryAmountRaw);
      /* Execution-time re-check (v0.4.1, defense in depth — the
       * resume path runs the same decision): fresh balances
       * decide. If the balance evidence says this swap already
       * landed (an earlier send was misreported as failed),
       * advance to the bridge step instead of broadcasting it a
       * second time; if the balance cannot fund the amount, stop
       * with the insufficient-balance message and NO broadcast. */
      const [nativeNow, usdtNow] = await Promise.all([
        arrivalBalance(entry, null, address).catch(() => null),
        erc20Balance(entry, USDT_ON[entry].address, address).catch(() => null),
      ]);
      if (nativeNow !== null && usdtNow !== null) {
        const g = entrySwapGuard(f, nativeNow, usdtNow);
        if (g === 'already-done') {
          const base = { ...f };
          delete base.pendingTx;
          await persist({ ...base, phase: 'entryBridge' });
          setStatus({ text: tr('hs.stepAlreadyDone'), err: false });
          setPending(null);
          return;
        }
        if (g === 'insufficient') {
          setStatus({ text: tr('hs.notEnough'), err: true });
          setPending(null);
          return;
        }
        /* Gas-keep invariant: balance ≥ amount is NOT enough —
           the swap may not eat the auto-keep ($3 of BNB / the
           ETH gas portion), on a resume exactly as on a fresh
           start. Checked against the fresh balance with the
           same spendable math as the amount screen. */
        if (amt > keepAwareSpendable(f.entry, nativeNow, bnbUsd, ethUsd)) {
          setStatus({ text: tr('hs.notEnough'), err: true });
          setPending(null);
          return;
        }
      }
      await sendStep(entry, async () => {
        const fresh = await quoteEntrySwap(entry, amt);
        if (worseThanConfirmed(fresh, BigInt(f.entryUsdtExpected))) {
          throw new Error('price-moved');
        }
        return buildEntrySwapTx(entry, amt, applySlippage(fresh, 100), address);
      }, (g) => ({ ...g, phase: 'entryBridge' }));
    });

  const prepareEntryBridge = async () => {
    const f = flowRef.current;
    if (!f) return;
    /* USDT start (v0.4.1): the bridge spends the gas coin, so a
       missing gas coin is a pre-flight stop with its own plain
       message — checked BEFORE any send is prepared, never a
       send that dies at execution with the generic text. */
    if (f.startCoin === 'usdt') {
      const ok = await fetchUsdtStartGasOk(f.entry, address).catch(() => null);
      if (ok === false) {
        setStatus({
          text: tr('hs.needGasCoin', { sym: f.entry === 'bsc' ? 'BNB' : 'ETH' }),
          err: true,
        });
        return;
      }
    }
    const cfg = BRIDGE_IN_USDT[entry];
    const bal = await erc20Balance(entry, cfg.token, address).catch(() => 0n);
    const before = BigInt(f.entryUsdtBefore ?? '0');
    const actual = bal > before ? bal - before : BigInt(f.entryUsdtExpected);
    const allow = await erc20Allowance(entry, cfg.token, address, cfg.router).catch(() => 0n);
    if (allow < actual) {
      askSend(tr('hs.stepApprove'), async () => {
        await sendStep(entry, async () => buildAggApprove(cfg.token, cfg.router, actual), (g) => g);
      });
      return;
    }
    askSend(tr('hs.stepBridgeIn'), async () => {
      await sendStep(entry, async () => {
        const q = await quoteBridgeIn(entry, actual);
        const usdt42Before = await arrivalBalance('infinite', USDT_ON.infinite.address, address);
        f.usdt42Before = usdt42Before.toString();
        f.entryUsdtActual = actual.toString();
        f.usdt42Expected = expected42Usdt(actual, cfg.tokenDecimals).toString();
        return buildBridgeInTx(entry, actual, address, q.totalNative);
      }, (g) => ({ ...g, phase: 'wait42', usdt42Before: f.usdt42Before, entryUsdtActual: f.entryUsdtActual, usdt42Expected: f.usdt42Expected }));
    });
  };

  const runCarve = async () => {
    const f = flowRef.current;
    if (!f) return;
    const cost = BigInt(f.carveUsdtCost ?? '0');
    const aggRouter = AGG_CHAINS.infinite.router as string;
    const allow = await erc20Allowance('infinite', USDT_ON.infinite.address, address, aggRouter).catch(() => 0n);
    if (allow < cost) {
      askSend(tr('hs.stepApprove'), async () => {
        await sendStep('infinite', async () => buildAggApprove(USDT_ON.infinite.address, aggRouter, cost), (g) => g);
      });
      return;
    }
    askSend(tr('hs.stepCarve'), async () => {
      await sendStep('infinite', async () => {
        const nativeTok = tokenById('infinite', 'native');
        const route = await freshRoute('infinite', USDT_ON.infinite.address, nativeTok.address, cost, null);
        if (!route) throw new Error('no-route');
        // Freshness: the carve must still buy (nearly) what is needed.
        const legs = Math.max(1, f.parts.length);
        const fee = await freshBridgeFee42(f.parts[0]?.sym ?? 'QOM');
        const need = planCarveout(legs, fee, await arrivalBalance('infinite', null, address)).needFromFlow;
        if (need > 0n && route.amountOut < (need * 95n) / 100n) {
          throw new Error('price-moved');
        }
        return buildRouteSwapTx('infinite', route, address, 1);
      }, (g) => ({ ...g, carveDone: true }));
    });
  };

  const preparePart = async (partIdx: number, partStep: number) => {
    const f = flowRef.current;
    if (!f) return;
    const part = f.parts[partIdx];
    const pair = BRIDGE_PAIRS.find((p) => p.sym === part.sym);
    if (!pair) return;

    if (partStep === 0) {
      if (!part.leg1Path) {
        // The part already IS the bridge token — nothing to swap.
        const parts = f.parts.slice();
        parts[partIdx] = { ...parts[partIdx], step: 1, bridgedAmount: parts[partIdx].usdtIn };
        await persist({ ...f, parts });
        return;
      }
      const need = BigInt(part.usdtIn);
      const aggRouter = AGG_CHAINS.infinite.router as string;
      const allow = await erc20Allowance('infinite', USDT_ON.infinite.address, address, aggRouter).catch(() => 0n);
      if (allow < need && part.leg1Path) {
        askSend(tr('hs.stepApprove'), async () => {
          await sendStep('infinite', async () => buildAggApprove(USDT_ON.infinite.address, aggRouter, need), (g) => g);
        });
        return;
      }
      askSend(tr('hs.stepSwap1'), async () => {
        await sendStep('infinite', async () => {
          if (!part.leg1Path) {
            // Direct bridge of the pair token itself — nothing to swap.
            return null as never;
          }
          const tSrc = tokenById('infinite', pair.infId);
          const route = await freshRoute('infinite', USDT_ON.infinite.address, tSrc.address, need, part.leg1Path);
          if (!route) throw new Error('no-route');
          part.bridgedAmount = route.amountOut.toString();
          return buildRouteSwapTx('infinite', route, address, 1);
        }, (g) => {
          const parts = g.parts.slice();
          parts[partIdx] = { ...parts[partIdx], step: 1, bridgedAmount: part.bridgedAmount };
          return { ...g, parts };
        });
      });
      return;
    }

    if (partStep === 1) {
      const tSrc = tokenById('infinite', pair.infId);
      const amt = BigInt(part.bridgedAmount ?? '0');
      const allow = await erc20Allowance('infinite', tSrc.address, address, pair.br).catch(() => 0n);
      if (allow < amt) {
        askSend(tr('hs.stepApprove'), async () => {
          await sendStep('infinite', async () => buildAggApprove(tSrc.address, pair.br, amt), (g) => g);
        });
        return;
      }
      askSend(tr('hs.stepBridge42'), async () => {
        let dstBefore = '0';
        await sendStep('infinite', async () => {
          const fee = await freshBridgeFee42(part.sym);
          const dstTok = tokenById('ql1', pair.ql1Id);
          /* v0.4.2: baseline in the DELIVERED token — the
           * ERC-20 balance (WQOM for the QOM pair), never the
           * native QOM balance; see the step-2 watcher. */
          dstBefore = (await arrivalBalance('ql1', dstTok.address, address)).toString();
          return buildAggBridge({ pair: { sym: part.sym } }, address, amt, fee);
        }, (g) => {
          const parts = g.parts.slice();
          parts[partIdx] = { ...parts[partIdx], step: 2, dstBalanceBefore: dstBefore, dstBaseIsToken: true };
          return { ...g, parts };
        });
      });
      return;
    }

    if (partStep === 3) {
      const dstTok = tokenById('ql1', pair.ql1Id);
      let amt = BigInt(part.bridgedAmount ?? '0');
      if (pair.sym === 'QOM') {
        /* QL1 gas keep (v0.4.2): this step's working funds are
           WQOM (arrived over the bridge or a WQOM mid-start)
           or NATIVE QOM (a native direct start — the part is
           marked srcNativeQom and its cap is the native
           surplus over the same keep).
           The shared keep (100 SNS actions + swap-class ops +
           margin, held in NATIVE QOM; see ql1KeepPlan) is
           secured BEFORE any principal moves: a shortfall is
           unwrapped from the WQOM first, only the surplus over
           the secured keep may be swapped, and when the keep
           cannot be secured the step stops at the faucet
           guidance — never a partial execution, never the
           generic failure text for a gas condition. When the
           keep plan cannot be read, fall back to the v0.4.1
           per-swap gas gate rather than guessing. */
        const plan = await fetchQl1KeepPlan(address);
        if (plan) {
          if (plan.action === 'faucet') {
            setQl1Short(true);
            return;
          }
          setQl1Short(false);
          if (plan.action === 'unwrap') {
            askSend(tr('hs.stepUnwrap'), async () => {
              await sendStep('ql1', async () => {
                const p2 = await fetchQl1KeepPlan(address).catch(() => null);
                const uw = p2 && p2.action === 'unwrap' ? p2.unwrapWei : plan.unwrapWei;
                if (uw <= 0n) throw new Error('insufficient');
                return buildUnwrapTx(uw);
              }, (g) => g);
            });
            return;
          }
          /* The cap is the post-keep surplus of the part's
             OWN funds: WQOM parts plan against the WQOM
             surplus (spendableWei); a native-QOM part plans
             against the native balance above the keep — the
             keep itself is never principal. */
          const spendableCap = part.srcNativeQom
            ? ql1NativeSpendableWei(plan)
            : plan.spendableWei;
          if (amt > spendableCap) {
            /* Cap the swap at the post-keep surplus; the rest
               of the delivery is not lost — it is (or becomes)
               the native gas reserve itself. */
            amt = spendableCap;
            if (amt <= 0n) {
              setStatus({ text: tr('hs.notEnough'), err: true });
              return;
            }
            const parts = f.parts.slice();
            parts[partIdx] = { ...parts[partIdx], bridgedAmount: amt.toString() };
            await persist({ ...f, parts });
          }
        } else if ((await fetchQl1GasShort(address)) === true) {
          setQl1Short(true);
          return;
        } else {
          setQl1Short(false);
        }
      } else {
        /* QL1 gas gate (v0.4.1): this step's sends run on QL1
           and are paid in NATIVE QOM — measured against the
           same per-swap gas estimate the confirm screen
           shows. If the native balance cannot cover it, stop
           HERE with the faucet guidance: bridged QOM is WQOM
           and does not pay gas, and the generic failure text
           must never stand in for this condition. */
        if ((await fetchQl1GasShort(address)) === true) {
          setQl1Short(true);
          return;
        }
        setQl1Short(false);
      }
      /* v0.4.2: the arrived token is an ERC-20 in the wallet
       * for EVERY pair — the QOM pair's is WQOM — so the swap
       * in is a token swap needing an allowance, never a
       * native spend. (Pre-v0.4.2 the QOM pair skipped the
       * allowance and the tx builder resolved WQOM to the
       * native entry, building a native-spending swap that
       * could only die on the small native gas balance.) */
      const ql1Router = AGG_CHAINS.ql1.router as string;
      /* A native-QOM part needs no allowance: the tx value
       * IS the input. Every other part's input is the pair
       * token as an ERC-20 and needs one (v0.4.2 note above). */
      if (!part.srcNativeQom) {
        const allow = await erc20Allowance('ql1', dstTok.address, address, ql1Router).catch(() => 0n);
        if (allow < amt) {
          askSend(tr('hs.stepApprove'), async () => {
            await sendStep('ql1', async () => buildAggApprove(dstTok.address, ql1Router, amt), (g) => g);
          });
          return;
        }
      }
      askSend(tr('hs.stepSwap2'), async () => {
        await sendStep('ql1', async () => {
          if (pair.sym === 'QOM') {
            /* Execution re-check (v0.4.2, mirroring the BSC
               keepAwareSpendable rule): the keep is re-decided
               from FRESH balances at broadcast time — if the
               amount no longer fits over the secured reserve,
               stop with the typed insufficient error instead
               of sending a swap that eats the gas keep. A
               native part is checked against the native
               surplus; a WQOM part against the WQOM surplus. */
            const p3 = await fetchQl1KeepPlan(address).catch(() => null);
            if (
              p3 &&
              amt >
                (part.srcNativeQom
                  ? ql1NativeSpendableWei(p3)
                  : p3.spendableWei)
            )
              throw new Error('insufficient');
          }
          const qcaw = tokenById('ql1', 'qcaw');
          const route = await freshRoute('ql1', dstTok.address, qcaw.address, amt, part.leg2Path);
          if (!route) throw new Error('no-route');
          /* Native part: no override — the builder resolves
             the pair token (WQOM address) to its native entry
             and builds the native-spending swap. WQOM part:
             the delivered-token entry, a token spend. */
          return part.srcNativeQom
            ? buildRouteSwapTx('ql1', route, address, 1)
            : buildRouteSwapTx('ql1', route, address, 1, dstTok);
        }, (g) => {
          const parts = g.parts.slice();
          parts[partIdx] = { ...parts[partIdx], step: 4 };
          return { ...g, parts };
        });
      });
    }
  };

  /* ---------- completion side effect ---------- */
  useEffect(() => {
    if (phase === 'run' && flow && flowComplete(flow)) {
      setPhase('done');
      huntersFlowStore.clear().catch(() => {});
      app.refreshBalances().catch(() => {});
      loadBasics();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, phase]);

  /* ---------- render ---------- */
  const stepLabel = (): string => {
    if (!flow || !step) return '';
    switch (step.kind) {
      case 'entrySwap':
        return tr(entry === 'bsc' ? 'hs.stepEntrySwapBsc' : 'hs.stepEntrySwapEth');
      case 'entryBridge':
        return tr('hs.stepBridgeIn');
      case 'wait42':
        return tr('hs.waiting');
      case 'requote':
        return tr('hs.checking');
      case 'carve':
        return tr('hs.stepCarve');
      case 'part':
        if (step.step === 0) return tr('hs.stepSwap1');
        if (step.step === 1) return tr('hs.stepBridge42');
        if (step.step === 2) return tr('hs.waiting');
        return tr('hs.stepSwap2');
      default:
        return '';
    }
  };

  const onRunNext = () => {
    if (!flow || !step) return;
    if (rehydrating) return;
    /* Never execute an unbuilt step (v0.4.1): the entry swap
       needs its amount AND its live quote in hand. */
    if (step.kind === 'entrySwap' && !entryStepReady(flow, stepQuote)) return;
    if (step.kind === 'entrySwap') runEntrySwap();
    else if (step.kind === 'entryBridge') prepareEntryBridge();
    else if (step.kind === 'carve') runCarve();
    else if (step.kind === 'part' && (step.step === 0 || step.step === 1 || step.step === 3)) {
      preparePart(step.partIdx, step.step);
    }
  };

  const amt = parsedAmount(entry);
  /* USD value of the typed amount: for a USDT start the amount
     IS dollars; for a native start it is amount × native price. */
  const amtUsd =
    amt === null
      ? null
      : startPoint === 'wqom' || startPoint === 'qom'
        ? null
        : startPoint === 'usdt42'
          ? Number(formatUnits(amt, 18))
          : startCoin === 'usdt'
          ? Number(formatUnits(amt, amountDecimals(entry)))
          : nativePrice(entry)
            ? Number(formatUnits(amt, 18)) * (nativePrice(entry) ?? 0)
            : null;
  /* The $100 rule is an ENTRY minimum (it exists because L1 gas
     makes small entries pointless, and the L1 bridge send pays
     that gas either way) — so it applies to the typed USD value
     of BOTH start coins on the Ethereum entry. A 42-USDT
     mid-start never touches L1, so it does not apply there. */
  const ethBlocked =
    startPoint === 'entry' &&
    entry === 'ethereum' &&
    amt !== null &&
    amt > 0n &&
    (startCoin === 'usdt'
      ? Number(formatUnits(amt, ENTRY_DEX.ethereum.usdtDecimals)) < 100
      : ethUsd !== null && !ethEntryAllowed(amt, ethUsd));
  const overSpendable =
    amt !== null &&
    amt >
      (startPoint === 'wqom'
        ? wqomPlan
          ? wqomPlan.spendableWei
          : (balances?.ql1Wqom ?? 0n)
        : startPoint === 'qom'
          ? qomPlan
            ? ql1NativeSpendableWei(qomPlan)
            : (balances?.ql1Native ?? 0n) > QL1_GAS_KEEP_FLOOR_WEI
              ? (balances?.ql1Native ?? 0n) - QL1_GAS_KEEP_FLOOR_WEI
              : 0n
          : startPoint === 'usdt42'
          ? (balances?.infUsdt ?? 0n)
          : startCoin === 'usdt'
            ? usdtBalance(entry)
            : spendable(entry));
  /* Quote-only gate (v0.3.2): quoting works for ANY amount, but
     STARTING the flow is blocked when the plan's amount is over the
     usable balance (after the gas-keep rules) or under the ETH
     entry minimum. The send path itself is unchanged. */
  const planGate = plan
    ? plan.startPoint === 'usdt42'
      ? amountGate(plan.usdt42, balances?.infUsdt ?? 0n)
      : amountGate(
          plan.entryAmount,
          plan.startCoin === 'usdt' ? usdtBalance(entry) : spendable(entry),
        )
    : null;
  const planEthMinBlocked =
    !!plan &&
    plan.startPoint === 'entry' &&
    entry === 'ethereum' &&
    (plan.startCoin === 'usdt'
      ? Number(formatUnits(plan.entryAmount, ENTRY_DEX.ethereum.usdtDecimals)) < 100
      : ethUsd !== null && !ethEntryAllowed(plan.entryAmount, ethUsd));
  /* USDT start with no gas coin: blocked at the confirm screen
     with the plain gas message, before anything executes. */
  const planGasBlocked =
    !!plan &&
    plan.startPoint === 'entry' &&
    plan.startCoin === 'usdt' &&
    plan.gasOk === false;
  const startBlocked = !!planGate?.insufficient || planEthMinBlocked || planGasBlocked;
  /* Next stays disabled until the entry step holds valid data
     (amount + live quote) — an empty step never offers it. */
  const entryBlocked =
    step?.kind === 'entrySwap' && !!flow && !entryStepReady(flow, stepQuote);

  return (
    <View style={{ flex: 1 }}>

      <ScrollView style={S.screen} contentContainerStyle={[S.scrollPad, { paddingBottom: 32 + insets.bottom }]}>
        {phase === 'entry' && resumeFlow ? (
          <View style={{ borderWidth: 1, borderColor: ACCENT, borderRadius: 14, padding: 14, marginBottom: 14 }}>
            <Text style={S.body}>{tr('hs.resumeTitle')}</Text>
            <View style={[S.row, { gap: 10, marginTop: 10 }]}>
              <Pressable style={[S.darkBtn, { flex: 1 }]} onPress={resume}>
                <Text style={S.darkBtnText}>{tr('hs.resume')}</Text>
              </Pressable>
              <Pressable style={[S.ghostBtn, { flex: 1 }]} onPress={discard}>
                <Text style={S.ghostBtnText}>{tr('hs.discard')}</Text>
              </Pressable>
            </View>
            <Pressable style={[S.ghostBtn, { marginTop: 10 }]} onPress={uturn}>
              <Text style={S.ghostBtnText}>{tr('hs.uturn')}</Text>
            </Pressable>
            <Text style={[S.tiny, { marginTop: 6 }]}>{tr('hs.uturnNote')}</Text>
          </View>
        ) : null}

        {phase === 'entry' ? (
          <>
            <View
              style={{
                backgroundColor: '#f2f8ff',
                borderWidth: 1,
                borderColor: '#d9e9f9',
                borderRadius: 14,
                padding: 12,
                marginBottom: 14,
              }}
            >
              <Text style={S.body}>{tr('hs.intro')}</Text>
            </View>
            <DepositAddressRow address={address} />
            <Text style={[S.h2, { marginTop: 18 }]}>{tr('hs.yourCoins')}</Text>
            <CoinCard>
              <CoinRow name="BNB" chain="BSC" raw={balances?.bscNative ?? null} dec={18} sym="BNB"
                usd={balances?.bscNative != null && bnbUsd ? Number(formatUnits(balances.bscNative, 18)) * bnbUsd : null} />
              <CoinRow name="USDT" chain="BSC" raw={balances?.bscUsdt ?? null} dec={18} sym="USDT"
                usd={balances?.bscUsdt != null ? Number(formatUnits(balances.bscUsdt, 18)) : null} />
              <CoinRow name="ETH" chain="Ethereum" raw={balances?.ethNative ?? null} dec={18} sym="ETH"
                usd={balances?.ethNative != null && ethUsd ? Number(formatUnits(balances.ethNative, 18)) * ethUsd : null} />
              <CoinRow name="USDT" chain="Ethereum" raw={balances?.ethUsdt ?? null} dec={6} sym="USDT"
                usd={balances?.ethUsdt != null ? Number(formatUnits(balances.ethUsdt, 6)) : null} />
              <CoinRow name="42" chain="42 Chain" raw={balances?.infNative ?? null} dec={18} sym="42" />
              <CoinRow name="USDT" chain="42 Chain" raw={balances?.infUsdt ?? null} dec={18} sym="USDT"
                usd={balances?.infUsdt != null ? Number(formatUnits(balances.infUsdt, 18)) : null} />
              <CoinRow name="QOM" chain="QL1" raw={balances?.ql1Native ?? null} dec={18} sym="QOM" />
              <CoinRow name="WQOM" chain="QL1" raw={balances?.ql1Wqom ?? null} dec={18} sym="WQOM" />
              <CoinRow name="CAW" chain="QL1" raw={balances?.ql1Qcaw ?? null} dec={18} sym="CAW" last />
            </CoinCard>

            <Text style={[S.h2, { marginTop: 18 }]}>{tr('hs.amountTitle')}</Text>
            {(['bsc', 'ethereum'] as EntryKey[]).map((e) => (
              <Pressable
                key={e}
                onPress={() => { setEntry(e); setStartPoint('entry'); }}
                style={{
                  borderWidth: 2,
                  borderColor: entry === e ? ACCENT : '#eff3f4',
                  borderRadius: 14,
                  padding: 14,
                  marginTop: 10,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                  <CoinBadge sym={e === 'bsc' ? 'BNB' : 'ETH'} />
                  <View style={{ flex: 1 }}>
                    <Text style={[S.body, { fontWeight: '700' }]}>
                      {tr(e === 'bsc' ? 'hs.fromBsc' : 'hs.fromEth')}
                    </Text>
                    <Text style={S.small}>
                      {fmtTok(nativeBalance(e), 18)} {e === 'bsc' ? 'BNB' : 'ETH'}
                      {nativePrice(e) ? ' · ' + fmtUsd(Number(formatUnits(nativeBalance(e), 18)) * (nativePrice(e) ?? 0)) : ''}
                    </Text>
                  </View>
                </View>
              </Pressable>
            ))}
            {gasUsd !== null ? (
              <Text style={[S.small, { marginTop: 10 }]}>
                {tr('hs.gasNow', { usd: fmtUsd(gasUsd) })}
              </Text>
            ) : null}
            {gasUsd !== null && ethGasExpensive(gasUsd) ? (
              <Text style={[S.err, { marginTop: 6 }]}>{tr('hs.gasExpensive')}</Text>
            ) : null}
            <Text style={[S.small, { marginTop: 6 }]}>{tr('hs.ethMin')}</Text>

            {/* Start coin (v0.4.1): the native coin (swapped to
                USDT first) or USDT already held on this chain
                (straight to the bridge; the native coin is then
                only needed as gas). */}
            <Text style={[S.h2, { marginTop: 18 }]}>{tr('hs.startFrom')}</Text>
            <View style={[S.row, { gap: 10, marginTop: 10 }]}>
              {(['native', 'usdt'] as const).map((c) => (
                <Pressable
                  key={c}
                  style={[startCoin === c ? S.darkBtn : S.ghostBtn, { flex: 1 }]}
                  onPress={() => { setStartCoin(c); setStartPoint('entry'); }}
                >
                  <Text style={startCoin === c ? S.darkBtnText : S.ghostBtnText}>
                    {c === 'native' ? (entry === 'bsc' ? 'BNB' : 'ETH') : 'USDT'}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={[S.small, { marginTop: 8 }]}>
              {startCoin === 'usdt'
                ? fmtTok(usdtBalance(entry), ENTRY_DEX[entry].usdtDecimals) + ' USDT'
                : fmtTok(nativeBalance(entry), 18) + ' ' + (entry === 'bsc' ? 'BNB' : 'ETH')}
            </Text>

            {/* Mid-start point (v0.4.1, balance-based): USDT
                already held on 42 Chain can start the flow at
                the back half directly. Offered ONLY when the
                balance is non-zero — a start the user cannot
                fund is never presented. */}
            {(balances?.infUsdt ?? 0n) > 0n ? (
              <Pressable
                onPress={() =>
                  setStartPoint(startPoint === 'usdt42' ? 'entry' : 'usdt42')
                }
                style={{
                  borderWidth: 2,
                  borderColor: startPoint === 'usdt42' ? ACCENT : '#eff3f4',
                  borderRadius: 14,
                  padding: 14,
                  marginTop: 14,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                  <CoinBadge sym="USDT" />
                  <View style={{ flex: 1 }}>
                    <Text style={[S.body, { fontWeight: '700' }]}>
                      {tr('hs.fromUsdt42')}
                    </Text>
                    <Text style={S.small}>
                      {fmtTok(balances?.infUsdt ?? 0n, 18)} USDT
                    </Text>
                  </View>
                </View>
              </Pressable>
            ) : null}

            {/* Mid-start point (v0.4.2, balance-based): WQOM
                held on QL1 — what bridged QOM arrives as —
                can start the buy directly at the QL1 swap
                step. Offered ONLY when the balance is
                non-zero. */}
            {(balances?.ql1Wqom ?? 0n) > 0n ? (
              <Pressable
                onPress={() =>
                  setStartPoint(startPoint === 'wqom' ? 'entry' : 'wqom')
                }
                style={{
                  borderWidth: 2,
                  borderColor: startPoint === 'wqom' ? ACCENT : '#eff3f4',
                  borderRadius: 14,
                  padding: 14,
                  marginTop: 14,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                  <CoinBadge sym="WQOM" />
                  <View style={{ flex: 1 }}>
                    <Text style={[S.body, { fontWeight: '700' }]}>
                      {tr('hs.fromWqom')}
                    </Text>
                    <Text style={S.small}>
                      {fmtTok(balances?.ql1Wqom ?? 0n, 18)} WQOM
                    </Text>
                  </View>
                </View>
              </Pressable>
            ) : null}

            {/* Direct start point (v0.4.2, balance-based):
                NATIVE QOM held on QL1 can start the buy
                directly at the QL1 swap step. Offered ONLY
                when the balance is non-zero; the amount is
                planned against the balance above the shared
                gas keep, so holding only the keep offers the
                card but no spendable amount. */}
            {(balances?.ql1Native ?? 0n) > 0n ? (
              <Pressable
                onPress={() =>
                  setStartPoint(startPoint === 'qom' ? 'entry' : 'qom')
                }
                style={{
                  borderWidth: 2,
                  borderColor: startPoint === 'qom' ? ACCENT : '#eff3f4',
                  borderRadius: 14,
                  padding: 14,
                  marginTop: 14,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                  <CoinBadge sym="QOM" />
                  <View style={{ flex: 1 }}>
                    <Text style={[S.body, { fontWeight: '700' }]}>
                      {tr('hs.fromQom')}
                    </Text>
                    <Text style={S.small}>
                      {fmtTok(balances?.ql1Native ?? 0n, 18)} QOM
                    </Text>
                  </View>
                </View>
              </Pressable>
            ) : null}

            <Pressable
              style={[S.bigBtn, { marginTop: 18 }]}
              onPress={() => setPhase('amount')}
            >
              <Text style={S.bigBtnText}>{tr('hs.next')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'amount' ? (
          <>
            <Text style={S.h2}>{tr('hs.amountTitle')}</Text>
            <View style={[S.row, { marginTop: 14, gap: 10 }]}>
              <TextInput
                style={[S.input, { flex: 1 }]}
                value={amountText}
                onChangeText={setAmountText}
                placeholder="0.0"
                keyboardType="decimal-pad"
                autoCorrect={false}
              />
              <Text style={[S.body, { fontWeight: '700' }]}>
                {startPoint === 'wqom' ? 'WQOM' : startPoint === 'qom' ? 'QOM' : startPoint === 'usdt42' || startCoin === 'usdt' ? 'USDT' : entry === 'bsc' ? 'BNB' : 'ETH'}
              </Text>
            </View>
            <View style={[S.row, { gap: 8, marginTop: 10, flexWrap: 'wrap' }]}>
              {[25, 50, 75, 100].map((pct) => (
                <Pressable
                  key={pct}
                  style={S.chip}
                  onPress={() =>
                    setAmountText(
                      formatUnits(
                        chipAmount(
                          startPoint === 'wqom'
                            ? wqomPlan
                              ? wqomPlan.spendableWei
                              : (balances?.ql1Wqom ?? 0n)
                            : startPoint === 'qom'
                              ? qomPlan
                                ? ql1NativeSpendableWei(qomPlan)
                                : (balances?.ql1Native ?? 0n) > QL1_GAS_KEEP_FLOOR_WEI
                                  ? (balances?.ql1Native ?? 0n) - QL1_GAS_KEEP_FLOOR_WEI
                                  : 0n
                              : startPoint === 'usdt42'
                              ? (balances?.infUsdt ?? 0n)
                              : startCoin === 'usdt'
                                ? usdtBalance(entry)
                                : spendable(entry),
                          pct,
                        ),
                        amountDecimals(entry),
                      ),
                    )
                  }
                >
                  <Text style={S.chipText}>{pct === 100 ? 'MAX' : pct + '%'}</Text>
                </Pressable>
              ))}
            </View>
            {startPoint === 'wqom' ? (
              <>
                {wqomPlan ? (
                  <Text style={[S.small, { marginTop: 10 }]}>
                    {tr('hs.gasKeep')}: {fmtTok(wqomPlan.keepWei, 18)} QOM
                  </Text>
                ) : null}
                {wqomPlan?.action === 'unwrap' ? (
                  <Text style={[S.small, { marginTop: 6 }]}>{tr('hs.keepUnwrap')}</Text>
                ) : null}
                {wqomQuote !== null && amt !== null && amt > 0n ? (
                  <Text style={[S.small, { marginTop: 6 }]}>
                    {tr('hs.youGet')}: {fmtTok(wqomQuote, 18)} CAW
                  </Text>
                ) : null}
                {wqomPlan?.action === 'faucet' ? (
                  <View style={{ marginTop: 12 }}>
                    <Text style={S.err}>{tr('hs.gasQomShort')}</Text>
                    <Text style={[S.small, { marginTop: 6 }]}>{tr('hs.wqomNote')}</Text>
                    <View style={{ marginTop: 10 }}>
                      <FaucetButton label={tr('faucet.goFaucet')} primary />
                    </View>
                  </View>
                ) : null}
              </>
            ) : null}
            {startPoint === 'qom' ? (
              <>
                {qomPlan ? (
                  <Text style={[S.small, { marginTop: 10 }]}>
                    {tr('hs.gasKeep')}: {fmtTok(qomPlan.keepWei, 18)} QOM
                  </Text>
                ) : null}
                {qomPlan?.action === 'unwrap' ? (
                  <Text style={[S.small, { marginTop: 6 }]}>{tr('hs.keepUnwrap')}</Text>
                ) : null}
                {qomQuote !== null && amt !== null && amt > 0n ? (
                  <Text style={[S.small, { marginTop: 6 }]}>
                    {tr('hs.youGet')}: {fmtTok(qomQuote, 18)} CAW
                  </Text>
                ) : null}
                {qomPlan?.action === 'faucet' ? (
                  <View style={{ marginTop: 12 }}>
                    <Text style={S.err}>{tr('hs.gasQomShort')}</Text>
                    <View style={{ marginTop: 10 }}>
                      <FaucetButton label={tr('faucet.goFaucet')} primary />
                    </View>
                  </View>
                ) : null}
              </>
            ) : null}
            {startPoint === 'usdt42' || startPoint === 'wqom' || startPoint === 'qom' ? null : startCoin === 'native' ? (
              <Text style={[S.small, { marginTop: 10 }]}>
                {tr('hs.gasKeep')}: {fmtTok(nativeBalance(entry) - spendable(entry), 18)} {entry === 'bsc' ? 'BNB' : 'ETH'}
                {amtUsd !== null ? ' · ≈ ' + fmtUsd(amtUsd) : ''}
              </Text>
            ) : nativeBalance(entry) === 0n ? (
              /* USDT start with NO gas coin at all: say it here,
                 in plain words, before anything is quoted or
                 executed — and again at the confirm screen. */
              <Text style={[S.err, { marginTop: 10 }]}>
                {tr('hs.needGasCoin', { sym: entry === 'bsc' ? 'BNB' : 'ETH' })}
              </Text>
            ) : null}
            {ethBlocked ? <Text style={[S.err, { marginTop: 8 }]}>{tr('hs.ethMin')}</Text> : null}
            {overSpendable ? <Text style={[S.err, { marginTop: 8 }]}>{tr('hs.notEnough')}</Text> : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 18 }, (quoting || amt === null || amt <= 0n || (startPoint === 'wqom' && (wqomQuote === null || wqomPlan?.action === 'faucet' || overSpendable)) || (startPoint === 'qom' && (qomQuote === null || qomPlan?.action === 'faucet' || overSpendable))) && S.disabled]}
              disabled={quoting || amt === null || amt <= 0n || (startPoint === 'wqom' && (wqomQuote === null || wqomPlan?.action === 'faucet' || overSpendable)) || (startPoint === 'qom' && (qomQuote === null || qomPlan?.action === 'faucet' || overSpendable))}
              onPress={() => (startPoint === 'wqom' ? startWqomFlow() : startPoint === 'qom' ? startQomFlow() : startPoint === 'usdt42' ? buildPlan42('single') : buildPlan('single'))}
            >
              <Text style={S.bigBtnText}>{quoting ? tr('hs.checking') : tr('hs.next')}</Text>
            </Pressable>
            <Pressable style={[S.ghostBtn, { marginTop: 10 }]} onPress={() => setPhase('entry')}>
              <Text style={S.ghostBtnText}>{tr('common.back')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'confirm' && plan ? (
          <>
            <Text style={S.h2}>{tr('hs.confirmTitle')}</Text>
            <View style={S.cardBox}>
            {plan.startPoint === 'usdt42' ? (
              /* Mid-start: the 42 Chain USDT itself is what
                 moves — no entry swap, no inbound bridge. */
              balLine('USDT (42 Chain)', plan.usdt42, 18, 'USDT')
            ) : plan.startCoin === 'usdt' ? (
              /* USDT start: one line — the USDT itself is what
                 moves; there is no swap leg to show. */
              balLine('USDT', plan.entryAmount, ENTRY_DEX[entry].usdtDecimals, 'USDT')
            ) : (
              <>
                {balLine(entry === 'bsc' ? 'BNB' : 'ETH', plan.entryAmount, 18, entry === 'bsc' ? 'BNB' : 'ETH')}
                {balLine('USDT', plan.entryUsdt, ENTRY_DEX[entry].usdtDecimals, 'USDT')}
              </>
            )}
            {plan.startPoint === 'entry'
              ? balLine(tr('hs.feeBridgeIn'), parseUnits('2', 18), 18, 'USDT')
              : null}
            {balLine(
              tr('hs.feeBridge42') +
                ' (' +
                String(plan.choice === 'split' && plan.back.split ? plan.back.split.parts.length : 1) +
                ' × ' +
                fmtTok(plan.back.feePerLeg42, 18) +
                ', ' +
                tr('hs.aboutUsdEach') +
                ')',
              plan.back.feePerLeg42 * BigInt(plan.choice === 'split' && plan.back.split ? plan.back.split.parts.length : 1),
              18,
              '42',
            )}
            {plan.back.tokenFeeBest && plan.back.tokenFeeBest > 0n
              ? balLine(tr('hs.feeToken'), plan.back.tokenFeeBest, 18, plan.back.bestSingle.pair.sym)
              : null}
            {gasEst
              ? balLine(
                  tr('hs.gas42Est'),
                  gasEst.gas42PerLeg * BigInt(plan.choice === 'split' && plan.back.split ? plan.back.split.parts.length : 1),
                  18,
                  '42',
                )
              : null}
            {gasEst
              ? balLine(
                  tr('hs.gasQl1Est'),
                  gasEst.gasQomPerSwap * BigInt(plan.choice === 'split' && plan.back.split ? plan.back.split.parts.length : 1),
                  18,
                  'QOM',
                )
              : null}
            {plan.carve.reserveTotal > 0n
              ? balLine(tr('hs.keep42'), plan.carve.reserveTotal, 18, '42')
              : null}
            </View>
            <View style={{ marginTop: 16 }}>
              <Text style={S.small}>{tr('hs.youGet')}</Text>
              <Text style={[S.h1, { color: ACCENT }]}>{fmtTok(plan.expectedOut, 18)} CAW</Text>
            </View>
            {plan.back.split ? (
              <View style={{ borderWidth: 1, borderColor: '#eff3f4', borderRadius: 14, padding: 14, marginTop: 14 }}>
                <Text style={[S.body, { fontWeight: '700' }]}>
                  {tr('hs.splitTitle', { n: String(plan.back.split.parts.length) })}
                </Text>
                <Text style={[S.small, { marginTop: 6 }]}>
                  {tr('hs.splitDesc', { pct: plan.back.split.netGainPct.toFixed(1) })}
                </Text>
                <View style={[S.row, { gap: 10, marginTop: 10 }]}>
                  <Pressable
                    style={[plan.choice === 'split' ? S.darkBtn : S.ghostBtn, { flex: 1 }]}
                    onPress={() => plan.choice !== 'split' && (plan.startPoint === 'usdt42' ? buildPlan42('split') : buildPlan('split'))}
                  >
                    <Text style={plan.choice === 'split' ? S.darkBtnText : S.ghostBtnText}>{tr('hs.useSplit')}</Text>
                  </Pressable>
                  <Pressable
                    style={[plan.choice === 'single' ? S.darkBtn : S.ghostBtn, { flex: 1 }]}
                    onPress={() => plan.choice !== 'single' && (plan.startPoint === 'usdt42' ? buildPlan42('single') : buildPlan('single'))}
                  >
                    <Text style={plan.choice === 'single' ? S.darkBtnText : S.ghostBtnText}>{tr('hs.useSingle')}</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
            <Text style={[S.small, { marginTop: 14 }]}>{tr('hs.fixedFeeNote')}</Text>
            <Text style={[S.small, { marginTop: 6 }]}>{tr('hs.firstTimeNote')}</Text>
            {startBlocked ? (
              <Text style={[S.err, { marginTop: 14 }]}>
                {planGate?.insufficient
                  ? tr('hs.quoteOnly')
                  : planGasBlocked
                    ? tr('hs.needGasCoin', { sym: entry === 'bsc' ? 'BNB' : 'ETH' })
                    : tr('hs.ethMin')}
              </Text>
            ) : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 18 }, startBlocked && { opacity: 0.4 }]}
              disabled={startBlocked}
              onPress={plan.startPoint === 'usdt42' ? startFlow42 : startFlow}
            >
              <Text style={S.bigBtnText}>{tr('hs.start')}</Text>
            </Pressable>
            <Pressable style={[S.ghostBtn, { marginTop: 10 }]} onPress={() => setPhase('amount')}>
              <Text style={S.ghostBtnText}>{tr('common.back')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'run' && flow ? (
          <>
            {flow.parts.length > 1 ? (
              <Text style={S.small}>
                {flow.parts.map((p, i) => `${tr('hs.partLabel', { n: String(i + 1) })}: ${p.step >= 4 ? '✓' : '…'}`).join('  ')}
              </Text>
            ) : null}
            <View style={{ borderWidth: 1, borderColor: '#eff3f4', borderRadius: 14, padding: 16, marginTop: 12 }}>
              <Text style={[S.body, { fontWeight: '700', fontSize: 17 }]}>{stepLabel()}</Text>
              {/* Step content (v0.4.1): the step always shows WHAT
                  it will move — amounts from the flow, and for the
                  entry swap the LIVE quote fetched for this step.
                  A bare title with an enabled Next is the bug state
                  this replaces. */}
              {step?.kind === 'entrySwap' ? (
                <View style={{ marginTop: 6 }}>
                  {balLine(
                    entry === 'bsc' ? 'BNB' : 'ETH',
                    bigOr0(flow.entryAmountRaw),
                    18,
                    entry === 'bsc' ? 'BNB' : 'ETH',
                  )}
                  {stepQuote !== null ? (
                    balLine('USDT', stepQuote, ENTRY_DEX[entry].usdtDecimals, 'USDT')
                  ) : (
                    <Text style={[S.small, { marginTop: 6 }]}>
                      {stepQuoteErr ? tr('hs.netFailed') : tr('hs.checking')}
                    </Text>
                  )}
                </View>
              ) : null}
              {step?.kind === 'entryBridge' && bridgeUsdt !== null
                ? balLine('USDT', bridgeUsdt, ENTRY_DEX[entry].usdtDecimals, 'USDT')
                : null}
              {step?.kind === 'carve' && flow.carveUsdtCost
                ? balLine('USDT', bigOr0(flow.carveUsdtCost), 18, 'USDT')
                : null}
              {step?.kind === 'part' && step.step === 0
                ? balLine('USDT', bigOr0(flow.parts[step.partIdx]?.usdtIn), 18, 'USDT')
                : null}
              {step?.kind === 'part' && step.step === 3 && flow.parts[step.partIdx]?.bridgedAmount
                ? balLine(
                    flow.parts[step.partIdx].sym,
                    bigOr0(flow.parts[step.partIdx].bridgedAmount),
                    18,
                    flow.parts[step.partIdx].sym,
                  )
                : null}
              {/* End goal (invariant): the final asset this flow
                  delivers, read from the SAVED flow state — set
                  at start (fresh or mid-start), never recomputed
                  on resume — with its stored amount estimate. */}
              <View style={[S.row, { justifyContent: 'space-between', marginTop: 10 }]}>
                <Text style={S.small}>{tr('hs.youGet')}</Text>
                <Text style={[S.body, { fontWeight: '700' }]}>
                  {fmtTok(bigOr0(flow.confirmedOut), 18)} {flow.finalAsset ?? 'CAW'}
                </Text>
              </View>
              {/* QL1 gas-shortage guidance (v0.4.1): shown by
                  the QL1 step gate INSTEAD of any error text,
                  with the mandatory direct faucet button. */}
              {ql1Short ? (
                <View style={{ marginTop: 12 }}>
                  <Text style={S.err}>{tr('hs.gasQomShort')}</Text>
                  <Text style={[S.small, { marginTop: 6 }]}>{tr('hs.wqomNote')}</Text>
                  <View style={{ marginTop: 10 }}>
                    <FaucetButton label={tr('faucet.goFaucet')} primary />
                  </View>
                </View>
              ) : null}
              {rehydrating ? (
                <View style={[S.row, { marginTop: 12, gap: 8 }]}>
                  <ActivityIndicator color={ACCENT} />
                  <Text style={S.small}>{tr('hs.checking')}</Text>
                </View>
              ) : watching ? (
                <View style={[S.row, { marginTop: 12, gap: 8 }]}>
                  <ActivityIndicator color={ACCENT} />
                  <Text style={S.small}>{tr('hs.waiting')}</Text>
                </View>
              ) : (
                <Pressable
                  style={[S.bigBtn, { marginTop: 14 }, (busy || entryBlocked) && S.disabled]}
                  disabled={busy || entryBlocked}
                  onPress={onRunNext}
                >
                  <Text style={S.bigBtnText}>{busy ? tr('hs.sending') : tr('hs.next')}</Text>
                </Pressable>
              )}
              {step?.kind === 'requote' ? (
                <Pressable
                  style={[S.bigBtn, { marginTop: 14 }]}
                  onPress={() => flow && initBackHalf(flow, true)}
                >
                  <Text style={S.bigBtnText}>{tr('hs.next')}</Text>
                </Pressable>
              ) : null}
            </View>
            <Pressable style={[S.ghostBtn, { marginTop: 12 }]} onPress={uturn}>
              <Text style={S.ghostBtnText}>{tr('hs.uturn')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'done' ? (
          <>
            <View style={[S.cardBox, { marginTop: 16 }]}>
              <View style={{ alignItems: 'center' }}>
                <View
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 28,
                    backgroundColor: '#1b7a43',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 28, fontWeight: '800' }}>✓</Text>
                </View>
                <Text style={[S.h1, { marginTop: 12 }]}>{tr('hs.doneTitle')}</Text>
                <Text style={[S.body, { marginTop: 8, textAlign: 'center' }]}>{tr('hs.doneDesc')}</Text>
                {balances?.ql1Qcaw !== null && balances?.ql1Qcaw !== undefined ? (
                  <Text style={[S.body, { marginTop: 8, fontWeight: '700' }]}>
                    {fmtTok(balances.ql1Qcaw, 18)} CAW
                  </Text>
                ) : null}
              </View>
              {balLine('42', balances?.infNative ?? null, 18, '42')}
              {balLine('USDT (42 Chain)', balances?.infUsdt ?? null, 18, 'USDT')}
            </View>
            <Pressable style={[S.bigBtn, { marginTop: 18 }]} onPress={onClose}>
              <Text style={S.bigBtnText}>{tr('common.close')}</Text>
            </Pressable>
          </>
        ) : null}

        {status ? (
          <Text style={[status.err ? S.err : S.small, { marginTop: 14 }]}>{status.text}</Text>
        ) : null}
        {quoting && slowQuote ? (
          <Text style={[S.small, { marginTop: 10 }]}>{tr('hs.stillWorking')}</Text>
        ) : null}
      </ScrollView>

      <ConfirmSheet
        visible={pending !== null}
        title={pending?.title ?? ''}
        confirmLabel={tr('hs.next')}
        cancelLabel={tr('settings.cancel')}
        onConfirm={() => pending?.run()}
        onCancel={() => {
          if (!busy) setPending(null);
        }}
        busy={busy}
      />
    </View>
  );
}

/* ================================================================== */
/* Sell direction: CAW (QL1) -> QOM -> best route -> USDT (42)       */
/*   -> bridge to BSC / Ethereum -> BNB / ETH.                        */
/* Mirrors the buy architecture: fresh quote before every send,       */
/* per-tx signing confirmation, arrival watching, persisted flow.     */
/* Gas reality (checked in the UI, never worked around silently):     */
/*  - 42 Chain steps need [42] gas; with none, the coins can arrive   */
/*    on 42 Chain but cannot move — warned before starting.           */
/*  - the final swap needs BNB / ETH gas on the target chain; with    */
/*    ~none, the flow can stop cleanly at "USDT arrived"              */
/*    (pausedTarget) and resume later.                                */
/* ================================================================== */

interface SellPlan {
  qcawAmount: bigint;
  /** Back-half quote; absent on a 42-USDT mid-start plan
   *  (there is no back half — the flow starts at the exit
   *  bridge with the USDT already on 42 Chain). */
  back?: BackHalfQuote;
  choice: 'single' | 'split';
  usdt42: bigint;
  forwardTarget: bigint;
  nativeOut: bigint;
  /** Arrival coin (v0.4.1): 'usdt' ends the flow when the
   *  bridge lands (nativeOut stays 0); 'native' adds the
   *  final swap on the target chain. */
  endCoin: 'usdt' | 'native';
  /** Mid-start (v0.4.1): the 42 Chain USDT amount the flow
   *  starts from, when it does not start from CAW. */
  fromUsdt42?: bigint;
}

function SellSection({
  onClose,
  onSwitchDirection,
}: {
  onClose: () => void;
  onSwitchDirection: () => void;
}) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const address = app.address ?? '';

  const [phase, setPhase] = useState<Phase>('entry');
  const [balances, setBalances] = useState<HsBalances | null>(null);
  const [bnbUsd, setBnbUsd] = useState<number | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [target, setTarget] = useState<EntryKey>('bsc');
  /** Arrival coin (v0.4.1): receive the bridged USDT as-is, or
   *  convert it into the target chain's native coin. */
  const [endCoin, setEndCoin] = useState<'usdt' | 'native'>('native');
  /* QL1 gas-shortage guidance state (v0.4.1), as on the buy
     side; set by the QL1 step gates in prepareSellPart. */
  const [ql1Short, setQl1Short] = useState(false);
  /* Mid-start (v0.4.1): 'caw' = the full sell from CAW;
     'usdt42' = start from USDT already held on 42 Chain,
     straight at the exit bridge. */
  const [sellFrom, setSellFrom] = useState<'caw' | 'usdt42'>('caw');
  const [amountText, setAmountText] = useState('');
  const [plan, setPlan] = useState<SellPlan | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [status, setStatus] = useState<{ text: string; err: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<HuntersFlow | null>(null);
  const [resumeFlow, setResumeFlow] = useState<HuntersFlow | null>(null);
  const [pending, setPending] = useState<{ title: string; run: () => Promise<void> } | null>(null);
  const [finishedWithUsdt, setFinishedWithUsdt] = useState(false);
  const [gasEst, setGasEst] = useState<GasEstimates | null>(null);
  const flowRef = useRef<HuntersFlow | null>(null);
  flowRef.current = flow;

  /* Slow-quote reassurance (v0.3.2): if a quote search runs past
     ~15 s, say so in plain words instead of leaving a silent spinner. */
  const [slowQuote, setSlowQuote] = useState(false);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beginQuote = () => {
    setQuoting(true);
    setSlowQuote(false);
    if (slowTimer.current) clearTimeout(slowTimer.current);
    slowTimer.current = setTimeout(() => setSlowQuote(true), 15000);
  };
  const endQuote = () => {
    setQuoting(false);
    setSlowQuote(false);
    if (slowTimer.current) {
      clearTimeout(slowTimer.current);
      slowTimer.current = null;
    }
  };

  const loadBasics = useCallback(async () => {
    if (!address) return;
    const [b, pb, pe] = await Promise.all([
      fetchHsBalances(address).catch(() => null),
      nativeUsdPrice('bsc').catch(() => null),
      nativeUsdPrice('ethereum').catch(() => null),
    ]);
    if (b) setBalances(b);
    if (pb) setBnbUsd(pb);
    if (pe) setEthUsd(pe);
  }, [address]);

  useEffect(() => {
    loadBasics();
    if (address) {
      huntersSellFlowStore
        .init(storeKV, address)
        .then(() => huntersSellFlowStore.load())
        .then((f) => {
          if (f && !flowComplete(f)) setResumeFlow(f);
        })
        .catch(() => {});
    }
  }, [address, loadBasics]);

  const persist = useCallback(async (f: HuntersFlow | null) => {
    setFlow(f);
    flowRef.current = f;
    if (f) await huntersSellFlowStore.save(f);
    else await huntersSellFlowStore.clear();
  }, []);

  const targetSym = target === 'bsc' ? 'BNB' : 'ETH';
  const targetPrice = target === 'bsc' ? bnbUsd : ethUsd;
  const targetNativeBal =
    (target === 'bsc' ? balances?.bscNative : balances?.ethNative) ?? null;
  const targetGasUsd =
    targetNativeBal !== null && targetPrice
      ? Number(formatUnits(targetNativeBal, 18)) * targetPrice
      : null;
  const noGas42 = balances !== null && (balances.infNative ?? 0n) === 0n;
  const lowTargetGas = targetGasUsd !== null && targetGasUsd < 1;

  const parsedQcaw = (): bigint | null => {
    try {
      return parseUnits(amountText.trim() === '' ? '0' : amountText.trim(), 18);
    } catch {
      return null;
    }
  };

  /* ---------- confirm-screen quoting ---------- */
  const buildSellPlan = async (choice: 'single' | 'split') => {
    const amt = parsedQcaw();
    if (amt === null || amt <= 0n) return;
    beginQuote();
    setStatus(null);
    try {
      const back = await quoteBackHalfReverse(amt);
      const usdt42 =
        choice === 'split' && back.split ? back.split.netOut : back.bestSingle.finalOut;
      const q = await quoteBridgeOut42(target, usdt42);
      const forwardTarget = toTargetUsdtRaw(q.forward, target);
      /* USDT arrival: the forward amount IS the result — the
         final swap (and its quote) does not exist. */
      const nativeOut =
        endCoin === 'usdt' ? 0n : await quoteFinalSwap(target, forwardTarget);
      setPlan({ qcawAmount: amt, back, choice, usdt42, forwardTarget, nativeOut, endCoin });
      setPhase('confirm');
    } catch (e) {
      setStatus({
        text: tr(e instanceof Error && e.message === 'no-route' ? 'hs.noRoute' : 'hs.netFailed'),
        err: true,
      });
    } finally {
      endQuote();
    }
  };

  /* ---------- start / resume ---------- */
  const startSellFlow = async () => {
    if (!plan || !address) return;
    const usdt42Before = await erc20Balance(
      'infinite',
      USDT_ON.infinite.address,
      address,
    ).catch(() => 0n);
    const total = plan.qcawAmount;
    const back = plan.back;
    if (!back) return;
    const parts: HuntersFlow['parts'] = [];
    if (plan.choice === 'split' && back.split) {
      let used = 0n;
      back.split.parts.forEach((p: any, i: number) => {
        const isLast = i === back.split!.parts.length - 1;
        const amt = isLast ? total - used : (total * BigInt(p.pct)) / 100n;
        used += amt;
        parts.push({
          sym: p.cand.pair.sym,
          pct: p.pct,
          usdtIn: amt.toString(),
          leg1Path: p.cand.leg1Path ?? null,
          leg2Path: p.cand.leg2Path ?? null,
          step: 0,
        });
      });
    } else {
      const c = back.bestSingle;
      parts.push({
        sym: c.pair.sym,
        pct: 100,
        usdtIn: total.toString(),
        leg1Path: c.leg1Path ?? null,
        leg2Path: c.leg2Path ?? null,
        step: 0,
      });
    }
    const base = newFlow({
      id: Date.now().toString(36),
      address,
      entry: target,
      direction: 'sell',
      exitTarget: target,
      entryAmountRaw: total.toString(),
      entryUsdtExpected: '0',
      usdt42Expected: plan.usdt42.toString(),
      /* USDT arrival: the confirmed result is the forwarded
         USDT itself, not a native amount. */
      confirmedOut:
        plan.endCoin === 'usdt'
          ? plan.forwardTarget.toString()
          : plan.nativeOut.toString(),
      choice: plan.choice,
      createdAt: Date.now(),
      usdt42Before: usdt42Before.toString(),
      sellUsdt42Expected: plan.usdt42.toString(),
      sellNativeExpected: plan.nativeOut.toString(),
      exitForward: plan.forwardTarget.toString(),
      endCoin: plan.endCoin,
      finalAsset: plan.endCoin === 'usdt' ? 'USDT' : targetSym,
      finalChain: target,
    });
    setResumeFlow(null);
    await persist({ ...base, phase: 'back', carveDone: true, parts });
    setPhase('run');
  };

  /**
   * Mid-start plan (v0.4.1): start from USDT already held on
   * 42 Chain. Only the exit legs remain — bridge out to the
   * target chain, then the arrival choice (USDT as-is or the
   * final swap) exactly as in a full sell.
   */
  const buildSellPlan42 = async () => {
    const amt = parsedQcaw();
    if (amt === null || amt <= 0n) return;
    beginQuote();
    setStatus(null);
    try {
      const q = await quoteBridgeOut42(target, amt);
      const forwardTarget = toTargetUsdtRaw(q.forward, target);
      const nativeOut =
        endCoin === 'usdt' ? 0n : await quoteFinalSwap(target, forwardTarget);
      setPlan({
        qcawAmount: 0n,
        choice: 'single',
        usdt42: amt,
        forwardTarget,
        nativeOut,
        endCoin,
        fromUsdt42: amt,
      });
      setPhase('confirm');
    } catch (e) {
      setStatus({
        text: tr(e instanceof Error && e.message === 'no-route' ? 'hs.noRoute' : 'hs.netFailed'),
        err: true,
      });
    } finally {
      endQuote();
    }
  };

  /**
   * Mid-start from 42 Chain USDT (v0.4.1): the flow is born at
   * the exit-bridge phase — the SAME saved-state shape a full
   * sell reaches after its back half, so resume and the
   * arrival watcher treat it identically. "Before" is
   * recorded net of the committed amount, so the exit bridge
   * measures exactly that amount from the real balance.
   */
  const startSellFlow42 = async () => {
    if (!plan || !address || !plan.fromUsdt42) return;
    const bal = await erc20Balance(
      'infinite',
      USDT_ON.infinite.address,
      address,
    ).catch(() => 0n);
    const before = bal > plan.fromUsdt42 ? bal - plan.fromUsdt42 : 0n;
    const base = newFlow({
      id: Date.now().toString(36),
      address,
      entry: target,
      direction: 'sell',
      exitTarget: target,
      entryAmountRaw: '0',
      entryUsdtExpected: '0',
      usdt42Expected: plan.usdt42.toString(),
      confirmedOut:
        plan.endCoin === 'usdt'
          ? plan.forwardTarget.toString()
          : plan.nativeOut.toString(),
      choice: 'single',
      createdAt: Date.now(),
      usdt42Before: before.toString(),
      sellUsdt42Expected: plan.usdt42.toString(),
      sellNativeExpected: plan.nativeOut.toString(),
      exitForward: plan.forwardTarget.toString(),
      endCoin: plan.endCoin,
      finalAsset: plan.endCoin === 'usdt' ? 'USDT' : targetSym,
      finalChain: target,
    });
    setResumeFlow(null);
    await persist({ ...base, phase: 'exitBridge', carveDone: true, parts: [] });
    setPhase('run');
  };

  const resume = async () => {
    if (!resumeFlow) return;
    setFlow(resumeFlow);
    flowRef.current = resumeFlow;
    setResumeFlow(null);
    setTarget(resumeFlow.exitTarget ?? 'bsc');
    /* The saved arrival-coin choice resumes with the flow. */
    setEndCoin(resumeFlow.endCoin ?? 'native');
    if (resumeFlow.phase === 'done' && resumeFlow.endCoin === 'usdt') {
      setFinishedWithUsdt(true);
    }
    if (resumeFlow.phase === 'done') setPhase('done');
    else setPhase('run');
  };

  const discard = async () => {
    setResumeFlow(null);
    await huntersSellFlowStore.clear();
  };

  /* U-turn (v0.4.1): same rule as the buy side — discard the
     saved flow and start the reverse goal fresh from the
     assets currently held; sent legs are never reversed. */
  const uturn = async () => {
    await persist(null);
    setResumeFlow(null);
    setPhase('entry');
    setStatus(null);
    onSwitchDirection();
  };

  /* ---------- generic send (same app auth pattern as buy) ---------- */
  const sendStep = async (
    chain: 'bsc' | 'ethereum' | 'infinite' | 'ql1',
    build: () => Promise<{ to: string; data: string; value: bigint }>,
    after: (f: HuntersFlow) => HuntersFlow,
  ) => {
    const f0 = flowRef.current;
    if (!f0) return;
    setBusy(true);
    setStatus({ text: tr('hs.sending'), err: false });
    try {
      const ok = await app.requireAuth();
      if (!ok) {
        setStatus(null);
        setPending(null);
        return;
      }
      const sec = app.getSecret();
      if (!sec) throw new Error('no secret');
      const signer = signerForHsChain(sec.kind, sec.secret, chain);
      const req = await build();
      await sendTxReq(signer, req);
      const base = { ...flowRef.current! };
      delete base.pendingTx;
      const f1 = after(base);
      await persist(f1);
      setStatus(null);
      setPending(null);
    } catch (e) {
      const text = await stepErrorText(e, chain, flowRef.current, persist);
      setStatus({ text, err: true });
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const askSend = (title: string, run: () => Promise<void>) =>
    setPending({ title, run });

  const step = flow ? nextStep(flow) : null;

  /* ---------- phase transitions driven by the flow state ---------- */
  useEffect(() => {
    if (phase !== 'run' || !flow) return;
    if (flow.phase === 'done') {
      setPhase('done');
      huntersSellFlowStore.clear().catch(() => {});
      app.refreshBalances().catch(() => {});
      loadBasics();
      return;
    }
    if (
      flow.phase === 'back' &&
      flow.parts.length > 0 &&
      flow.parts.every((p) => p.step >= 4)
    ) {
      persist({ ...flow, phase: 'exitBridge' }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, phase]);

  /* ---------- arrival watching (part bridges + exit bridge) ------- */
  const watching =
    phase === 'run' &&
    flow !== null &&
    (step?.kind === 'waitTarget' || (step?.kind === 'part' && step.step === 2));

  useEffect(() => {
    if (!watching || !flow) return;
    let live = true;
    const check = async () => {
      const f = flowRef.current;
      if (!f || !address) return;
      try {
        const s = nextStep(f);
        if (s.kind === 'part' && s.step === 2) {
          const part = f.parts[s.partIdx];
          const pair = BRIDGE_PAIRS.find((p) => p.sym === part.sym);
          if (!pair) return;
          const dstTok = tokenById('infinite', pair.infId);
          const now = await arrivalBalance(
            'infinite',
            dstTok.isNative ? null : dstTok.address,
            address,
          );
          const before = BigInt(part.dstBalanceBefore ?? '0');
          const arrived = now - before;
          const want = (BigInt(part.bridgedAmount ?? '0') * 99n) / 100n;
          if (arrived > 0n && arrived >= want) {
            const parts = f.parts.slice();
            parts[s.partIdx] = {
              ...part,
              step: part.leg2Path ? 3 : 4,
              bridgedAmount: arrived.toString(),
            };
            if (live) await persist({ ...f, parts });
          }
        } else if (s.kind === 'waitTarget') {
          const t = f.exitTarget ?? 'bsc';
          const now = await arrivalBalance(t, USDT_ON[t].address, address);
          const before = BigInt(f.targetUsdtBefore ?? '0');
          const arrived = now - before;
          const want = (BigInt(f.exitForward ?? '0') * 99n) / 100n;
          if (arrived > 0n && arrived >= want) {
            // The chosen arrival coin decides what "arrived"
            // means (arrivalAction): USDT as-is finishes here;
            // converting needs ~$1 of target-chain gas for the
            // final swap, else the flow pauses AT the USDT
            // with the plain gas message (existing behavior).
            const nat = await arrivalBalance(t, null, address).catch(() => 0n);
            const price = t === 'bsc' ? bnbUsd : ethUsd;
            const usd = price ? Number(formatUnits(nat, 18)) * price : 0;
            const action = arrivalAction(f.endCoin, usd);
            if (live) {
              if (action === 'done-usdt') {
                setFinishedWithUsdt(true);
                await persist({ ...f, phase: 'done' });
              } else {
                await persist({
                  ...f,
                  phase: action === 'final-swap' ? 'finalSwap' : 'pausedTarget',
                });
              }
            }
          }
        }
      } catch {
        /* a failed poll just tries again next tick */
      }
    };
    const iv = setInterval(check, 12000);
    check();
    return () => {
      live = false;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, flow?.phase, flow?.parts, address, bnbUsd, ethUsd]);

  /* ---------- part steps (QL1 swap -> bridge -> 42 swap) ---------- */
  const prepareSellPart = async (partIdx: number, partStep: number) => {
    const f = flowRef.current;
    if (!f) return;
    const part = f.parts[partIdx];
    const pair = BRIDGE_PAIRS.find((p) => p.sym === part.sym);
    if (!pair) return;

    /* QL1 gas gate (v0.4.1): part steps 0 (swap) and 1 (bridge
       out of QL1) both SEND on QL1, paid in native QOM. Same
       rule as the buy side: a short native balance stops here
       with the faucet guidance — WQOM does not pay gas, and
       the generic failure text never stands in for it. */
    if (partStep === 0 || partStep === 1) {
      if ((await fetchQl1GasShort(address)) === true) {
        setQl1Short(true);
        return;
      }
      setQl1Short(false);
    }

    if (partStep === 0) {
      if (!part.leg1Path) {
        const parts = f.parts.slice();
        parts[partIdx] = { ...part, step: 1, bridgedAmount: part.usdtIn };
        await persist({ ...f, parts });
        return;
      }
      const need = BigInt(part.usdtIn);
      const fromAddr = part.leg1Path[0];
      const ql1Router = AGG_CHAINS.ql1.router as string;
      const allow = await erc20Allowance('ql1', fromAddr, address, ql1Router).catch(() => 0n);
      if (allow < need) {
        askSend(tr('hs.stepApprove'), async () => {
          await sendStep('ql1', async () => buildAggApprove(fromAddr, ql1Router, need), (g) => g);
        });
        return;
      }
      askSend(tr('hs.sStepSwap1'), async () => {
        await sendStep('ql1', async () => {
          const dstTok = tokenById('ql1', pair.ql1Id);
          const route = await freshRoute('ql1', fromAddr, dstTok.address, need, part.leg1Path);
          if (!route) throw new Error('no-route');
          part.bridgedAmount = route.amountOut.toString();
          return buildRouteSwapTx('ql1', route, address, 1);
        }, (g) => {
          const parts = g.parts.slice();
          parts[partIdx] = { ...parts[partIdx], step: 1, bridgedAmount: part.bridgedAmount };
          return { ...g, parts };
        });
      });
      return;
    }

    if (partStep === 1) {
      const tSrc = tokenById('ql1', pair.ql1Id);
      const amt = BigInt(part.bridgedAmount ?? '0');
      if (!tSrc.isNative) {
        const allow = await erc20Allowance('ql1', tSrc.address, address, pair.ql1Router).catch(() => 0n);
        if (allow < amt) {
          askSend(tr('hs.stepApprove'), async () => {
            await sendStep('ql1', async () => buildAggApprove(tSrc.address, pair.ql1Router, amt), (g) => g);
          });
          return;
        }
      }
      askSend(tr('hs.sStepBridge'), async () => {
        let dstBefore = '0';
        await sendStep('ql1', async () => {
          const dstTok = tokenById('infinite', pair.infId);
          dstBefore = (
            await arrivalBalance('infinite', dstTok.isNative ? null : dstTok.address, address)
          ).toString();
          return buildAggBridgeFromQl1({ pair }, address, amt, 0n);
        }, (g) => {
          const parts = g.parts.slice();
          parts[partIdx] = { ...parts[partIdx], step: 2, dstBalanceBefore: dstBefore };
          return { ...g, parts };
        });
      });
      return;
    }

    if (partStep === 3) {
      const tSrc = tokenById('infinite', pair.infId);
      const amt = BigInt(part.bridgedAmount ?? '0');
      if (!tSrc.isNative) {
        const infRouter = AGG_CHAINS.infinite.router as string;
        const allow = await erc20Allowance('infinite', tSrc.address, address, infRouter).catch(() => 0n);
        if (allow < amt) {
          askSend(tr('hs.stepApprove'), async () => {
            await sendStep('infinite', async () => buildAggApprove(tSrc.address, infRouter, amt), (g) => g);
          });
          return;
        }
      }
      askSend(tr('hs.sStepSwap2'), async () => {
        await sendStep('infinite', async () => {
          const route = await freshRoute(
            'infinite',
            tSrc.address,
            USDT_ON.infinite.address,
            amt,
            part.leg2Path,
          );
          if (!route) throw new Error('no-route');
          return buildRouteSwapTx('infinite', route, address, 1);
        }, (g) => {
          const parts = g.parts.slice();
          parts[partIdx] = { ...parts[partIdx], step: 4 };
          return { ...g, parts };
        });
      });
    }
  };

  /* ---------- exit bridge 42 -> target ---------------------------- */
  const prepareExitBridge = async () => {
    const f = flowRef.current;
    if (!f) return;
    const t = f.exitTarget ?? 'bsc';
    const balNow = await erc20Balance('infinite', USDT_ON.infinite.address, address).catch(() => 0n);
    const arrived = balNow - BigInt(f.usdt42Before ?? '0');
    if (arrived <= 0n) {
      setStatus({ text: tr('hs.failed'), err: true });
      return;
    }
    const allow = await erc20Allowance(
      'infinite',
      USDT_ON.infinite.address,
      address,
      BRIDGE_OUT_USDT_42.router,
    ).catch(() => 0n);
    if (allow < arrived) {
      askSend(tr('hs.stepApprove'), async () => {
        await sendStep('infinite', async () => buildAggApprove(USDT_ON.infinite.address, BRIDGE_OUT_USDT_42.router, arrived), (g) => g);
      });
      return;
    }
    askSend(tr('hs.sStepBridgeOut'), async () => {
      let targetBefore = '0';
      let fwdTarget = 0n;
      await sendStep('infinite', async () => {
        const bal = await erc20Balance('infinite', USDT_ON.infinite.address, address);
        const amt = bal - BigInt(f.usdt42Before ?? '0');
        if (amt <= 0n) throw new Error('no-usdt');
        const q = await quoteBridgeOut42(t, amt);
        const fee = parseUnits('2', 18);
        if (amt - q.forward > fee + amt / 1000n + parseUnits('0.01', 18)) {
          throw new Error('price-moved');
        }
        targetBefore = (
          await erc20Balance(t, USDT_ON[t].address, address).catch(() => 0n)
        ).toString();
        fwdTarget = toTargetUsdtRaw(q.forward, t);
        return buildBridgeOut42Tx(t, address, amt, q.totalNative);
      }, (g) => ({
        ...g,
        phase: 'waitTarget',
        targetUsdtBefore: targetBefore,
        exitForward: fwdTarget.toString(),
      }));
    });
  };

  /* ---------- final swap on the target chain ---------------------- */
  const prepareFinalSwap = async () => {
    const f = flowRef.current;
    if (!f) return;
    const t = f.exitTarget ?? 'bsc';
    const balNow = await erc20Balance(t, USDT_ON[t].address, address).catch(() => 0n);
    const amount = balNow - BigInt(f.targetUsdtBefore ?? '0');
    if (amount <= 0n) {
      setStatus({ text: tr('hs.failed'), err: true });
      return;
    }
    const dex = ENTRY_DEX[t];
    const allow = await erc20Allowance(t, USDT_ON[t].address, address, dex.router).catch(() => 0n);
    if (allow < amount) {
      askSend(tr('hs.stepApprove'), async () => {
        await sendStep(t, async () => buildAggApprove(USDT_ON[t].address, dex.router, amount), (g) => g);
      });
      return;
    }
    askSend(tr(t === 'bsc' ? 'hs.sStepFinalBsc' : 'hs.sStepFinalEth'), async () => {
      await sendStep(t, async () => {
        const bal = await erc20Balance(t, USDT_ON[t].address, address);
        const amt = bal - BigInt(f.targetUsdtBefore ?? '0');
        if (amt <= 0n) throw new Error('no-usdt');
        const fresh = await quoteFinalSwap(t, amt);
        const expected = BigInt(f.sellNativeExpected ?? '0');
        const fwd = BigInt(f.exitForward ?? '0');
        if (fwd > 0n && expected > 0n && fresh * fwd * 100n < expected * amt * 97n) {
          throw new Error('price-moved');
        }
        return buildFinalSwapTx(t, amt, applySlippage(fresh, 100), address);
      }, (g) => ({ ...g, phase: 'done' }));
    });
  };

  /* ---------- paused-at-USDT actions ------------------------------ */
  const checkGasAgain = async () => {
    const f = flowRef.current;
    if (!f) return;
    const t = f.exitTarget ?? 'bsc';
    const nat = await arrivalBalance(t, null, address).catch(() => 0n);
    const price = t === 'bsc' ? bnbUsd : ethUsd;
    const usd = price ? Number(formatUnits(nat, 18)) * price : 0;
    if (usd >= 1) {
      await persist({ ...f, phase: 'finalSwap' });
      setStatus(null);
    } else {
      setStatus({ text: tr('hs.needGasTarget', { sym: t === 'bsc' ? 'BNB' : 'ETH' }), err: true });
    }
  };

  const finishHere = async () => {
    const f = flowRef.current;
    if (!f) return;
    setFinishedWithUsdt(true);
    await persist({ ...f, phase: 'done' });
  };

  /* ---------- render ---------------------------------------------- */
  const stepLabel = (): string => {
    if (!flow || !step) return '';
    switch (step.kind) {
      case 'part':
        if (step.step === 0) return tr('hs.sStepSwap1');
        if (step.step === 1) return tr('hs.sStepBridge');
        if (step.step === 2) return tr('hs.waiting');
        return tr('hs.sStepSwap2');
      case 'exitBridge':
        return tr('hs.sStepBridgeOut');
      case 'waitTarget':
        return tr('hs.waiting');
      case 'finalSwap':
        return tr(target === 'bsc' ? 'hs.sStepFinalBsc' : 'hs.sStepFinalEth');
      default:
        return '';
    }
  };

  const onRunNext = () => {
    if (!flow || !step) return;
    if (step.kind === 'part' && (step.step === 0 || step.step === 1 || step.step === 3)) {
      prepareSellPart(step.partIdx, step.step);
    } else if (step.kind === 'exitBridge') {
      prepareExitBridge();
    } else if (step.kind === 'finalSwap') {
      prepareFinalSwap();
    }
  };

  const qcawBal = balances?.ql1Qcaw ?? 0n;
  const amt = parsedQcaw();
  const overBal =
    amt !== null &&
    amt > (sellFrom === 'usdt42' ? (balances?.infUsdt ?? 0n) : qcawBal);
  /* Quote-only gate (v0.3.2): quoting works for ANY amount; the
     start action is blocked when the plan sells more than held. */
  const sellGate = plan
    ? plan.fromUsdt42
      ? amountGate(plan.fromUsdt42, balances?.infUsdt ?? 0n)
      : amountGate(plan.qcawAmount, qcawBal)
    : null;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={S.screen} contentContainerStyle={[S.scrollPad, { paddingBottom: 32 + insets.bottom }]}>
        {phase === 'entry' && resumeFlow ? (
          <View style={{ borderWidth: 1, borderColor: ACCENT, borderRadius: 14, padding: 14, marginBottom: 14 }}>
            <Text style={S.body}>{tr('hs.resumeTitle')}</Text>
            <View style={[S.row, { gap: 10, marginTop: 10 }]}>
              <Pressable style={[S.darkBtn, { flex: 1 }]} onPress={resume}>
                <Text style={S.darkBtnText}>{tr('hs.resume')}</Text>
              </Pressable>
              <Pressable style={[S.ghostBtn, { flex: 1 }]} onPress={discard}>
                <Text style={S.ghostBtnText}>{tr('hs.discard')}</Text>
              </Pressable>
            </View>
            <Pressable style={[S.ghostBtn, { marginTop: 10 }]} onPress={uturn}>
              <Text style={S.ghostBtnText}>{tr('hs.uturn')}</Text>
            </Pressable>
            <Text style={[S.tiny, { marginTop: 6 }]}>{tr('hs.uturnNote')}</Text>
          </View>
        ) : null}

        {phase === 'entry' ? (
          <>
            <View
              style={{
                backgroundColor: '#f2f8ff',
                borderWidth: 1,
                borderColor: '#d9e9f9',
                borderRadius: 14,
                padding: 12,
                marginBottom: 14,
              }}
            >
              <Text style={S.body}>{tr('hs.sellIntro')}</Text>
            </View>
            <DepositAddressRow address={address} />
            <Text style={[S.h2, { marginTop: 16 }]}>{tr('hs.toChain')}</Text>
            {(['bsc', 'ethereum'] as EntryKey[]).map((k) => (
              <Pressable
                key={k}
                onPress={() => setTarget(k)}
                style={{
                  borderWidth: 2,
                  borderColor: target === k ? ACCENT : '#e5e5e5',
                  borderRadius: 14,
                  padding: 14,
                  marginTop: 10,
                }}
              >
                <Text style={[S.body, { fontWeight: '700' }]}>
                  {k === 'bsc' ? 'BNB (BSC)' : 'ETH (Ethereum)'}
                </Text>
                <CoinRow
                  name={k === 'bsc' ? 'BNB' : 'ETH'}
                  chain={k === 'bsc' ? 'BSC' : 'Ethereum'}
                  raw={k === 'bsc' ? balances?.bscNative ?? null : balances?.ethNative ?? null}
                  dec={18}
                  sym={k === 'bsc' ? 'BNB' : 'ETH'}
                  usd={
                    (k === 'bsc' ? balances?.bscNative : balances?.ethNative) != null &&
                    (k === 'bsc' ? bnbUsd : ethUsd)
                      ? Number(formatUnits((k === 'bsc' ? balances?.bscNative : balances?.ethNative)!, 18)) *
                        ((k === 'bsc' ? bnbUsd : ethUsd) ?? 0)
                      : null
                  }
                />
                <CoinRow
                  name="USDT"
                  chain={k === 'bsc' ? 'BSC' : 'Ethereum'}
                  raw={k === 'bsc' ? balances?.bscUsdt ?? null : balances?.ethUsdt ?? null}
                  dec={USDT_ON[k].decimals}
                  sym="USDT"
                  usd={
                    (k === 'bsc' ? balances?.bscUsdt : balances?.ethUsdt) != null
                      ? Number(formatUnits((k === 'bsc' ? balances?.bscUsdt : balances?.ethUsdt)!, USDT_ON[k].decimals))
                      : null
                  }
                  last
                />
              </Pressable>
            ))}
            {/* Arrival coin (v0.4.1): keep the bridged USDT
                as-is, or convert it into BNB / ETH at the end. */}
            <Text style={[S.h2, { marginTop: 18 }]}>{tr('hs.arriveAs')}</Text>
            <View style={[S.row, { gap: 10, marginTop: 10 }]}>
              {(['usdt', 'native'] as const).map((c) => (
                <Pressable
                  key={c}
                  style={[endCoin === c ? S.darkBtn : S.ghostBtn, { flex: 1 }]}
                  onPress={() => setEndCoin(c)}
                >
                  <Text style={endCoin === c ? S.darkBtnText : S.ghostBtnText}>
                    {c === 'usdt'
                      ? tr('hs.arriveUsdt')
                      : tr('hs.arriveNative', { sym: targetSym })}
                  </Text>
                </Pressable>
              ))}
            </View>
            {/* Start point (v0.4.1, balance-based): the full
                sell from CAW, or a mid-start from USDT already
                held on 42 Chain — offered ONLY when that
                balance is non-zero. */}
            <Text style={[S.h2, { marginTop: 18 }]}>{tr('hs.startFrom')}</Text>
            <View style={[S.row, { gap: 10, marginTop: 10 }]}>
              <Pressable
                style={[sellFrom === 'caw' ? S.darkBtn : S.ghostBtn, { flex: 1 }]}
                onPress={() => setSellFrom('caw')}
              >
                <Text style={sellFrom === 'caw' ? S.darkBtnText : S.ghostBtnText}>
                  {tr('hs.fromCaw')}
                </Text>
              </Pressable>
              {(balances?.infUsdt ?? 0n) > 0n ? (
                <Pressable
                  style={[sellFrom === 'usdt42' ? S.darkBtn : S.ghostBtn, { flex: 1 }]}
                  onPress={() => setSellFrom('usdt42')}
                >
                  <Text style={sellFrom === 'usdt42' ? S.darkBtnText : S.ghostBtnText}>
                    {tr('hs.fromUsdt42')}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {sellFrom === 'usdt42' ? (
              <Text style={[S.small, { marginTop: 8 }]}>
                {fmtTok(balances?.infUsdt ?? 0n, 18)} USDT
              </Text>
            ) : null}
            <Text style={[S.h2, { marginTop: 18 }]}>{tr('hs.yourCoins')}</Text>
            <CoinCard>
              <CoinRow name="CAW" chain="QL1" raw={balances?.ql1Qcaw ?? null} dec={18} sym="CAW" />
              <CoinRow name="QOM" chain="QL1" raw={balances?.ql1Native ?? null} dec={18} sym="QOM" />
              <CoinRow name="WQOM" chain="QL1" raw={balances?.ql1Wqom ?? null} dec={18} sym="WQOM" />
              <CoinRow name="USDT" chain="42 Chain" raw={balances?.infUsdt ?? null} dec={18} sym="USDT"
                usd={balances?.infUsdt != null ? Number(formatUnits(balances.infUsdt, 18)) : null} />
              <CoinRow name="42" chain="42 Chain" raw={balances?.infNative ?? null} dec={18} sym="42" last />
            </CoinCard>
            {noGas42 ? (
              <Text style={[S.err, { marginTop: 12 }]}>{tr('hs.gasWarn42')}</Text>
            ) : null}
            {lowTargetGas && endCoin === 'native' ? (
              <Text style={[S.err, { marginTop: 8 }]}>
                {tr('hs.gasWarnTarget', { sym: targetSym })}
              </Text>
            ) : null}
            <Pressable
              style={[
                S.bigBtn,
                { marginTop: 20 },
                (sellFrom === 'caw' ? qcawBal <= 0n : (balances?.infUsdt ?? 0n) <= 0n) && {
                  opacity: 0.4,
                },
              ]}
              disabled={
                sellFrom === 'caw' ? qcawBal <= 0n : (balances?.infUsdt ?? 0n) <= 0n
              }
              onPress={() => setPhase('amount')}
            >
              <Text style={S.bigBtnText}>{tr('hs.next')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'amount' ? (
          <>
            <Text style={S.h2}>{tr('hs.amountSellTitle')}</Text>
            {sellFrom === 'usdt42'
              ? balLine('USDT (42 Chain)', balances?.infUsdt ?? null, 18, 'USDT')
              : balLine('CAW', balances?.ql1Qcaw ?? null, 18, 'CAW')}
            <TextInput
              style={[S.input, { marginTop: 12 }]}
              value={amountText}
              onChangeText={setAmountText}
              keyboardType="decimal-pad"
              placeholder="0"
            />
            <View style={[S.row, { gap: 8, marginTop: 10 }]}>
              {[25, 50, 75, 100].map((pct) => (
                <Pressable
                  key={pct}
                  style={[S.chip, { flex: 1 }]}
                  onPress={() =>
                    setAmountText(
                      formatUnits(
                        chipAmount(sellFrom === 'usdt42' ? (balances?.infUsdt ?? 0n) : qcawBal, pct),
                        18,
                      ),
                    )
                  }
                >
                  <Text style={S.chipText}>{pct === 100 ? 'MAX' : pct + '%'}</Text>
                </Pressable>
              ))}
            </View>
            {overBal ? <Text style={[S.err, { marginTop: 10 }]}>{tr('hs.notEnough')}</Text> : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 20 }, (amt === null || amt <= 0n) && { opacity: 0.4 }]}
              disabled={amt === null || amt <= 0n || quoting}
              onPress={() => (sellFrom === 'usdt42' ? buildSellPlan42() : buildSellPlan('single'))}
            >
              <Text style={S.bigBtnText}>{quoting ? tr('hs.checking') : tr('hs.next')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'confirm' && plan ? (
          <>
            <Text style={S.h2}>{tr('hs.confirmTitle')}</Text>
            <View style={S.cardBox}>
            {plan.fromUsdt42 ? null : balLine('CAW', plan.qcawAmount, 18, 'CAW')}
            {balLine('USDT (42 Chain)', plan.usdt42, 18, 'USDT')}
            <View style={[S.row, { justifyContent: 'space-between', marginTop: 6 }]}>
              <Text style={S.small}>{tr('hs.feeBridgeOut')}</Text>
              <Text style={[S.body, { fontWeight: '600' }]}>-2 USDT</Text>
            </View>
            {balLine(tr('hs.usdtArriving'), plan.forwardTarget, USDT_ON[target].decimals, 'USDT')}
            {gasEst && !plan.fromUsdt42
              ? balLine(
                  tr('hs.gasQl1Est'),
                  gasEst.gasQomPerSwap * BigInt(plan.choice === 'split' && plan.back?.split ? plan.back?.split.parts.length : 1),
                  18,
                  'QOM',
                )
              : null}
            {gasEst
              ? balLine(
                  tr('hs.gas42Est'),
                  gasEst.gas42PerLeg * BigInt(plan.choice === 'split' && plan.back?.split ? plan.back?.split.parts.length : 1),
                  18,
                  '42',
                )
              : null}
            </View>
            <View style={[S.row, { justifyContent: 'space-between', marginTop: 10 }]}>
              <Text style={S.body}>{tr('hs.youGet')}</Text>
              <Text style={[S.h2, { color: ACCENT }]}>
                {plan.endCoin === 'usdt'
                  ? `${fmtTok(plan.forwardTarget, USDT_ON[target].decimals)} USDT`
                  : `${fmtTok(plan.nativeOut, 18)} ${targetSym}`}
              </Text>
            </View>
            {plan.back?.split ? (
              <View style={{ marginTop: 14 }}>
                <Text style={S.body}>{tr('hs.splitTitle')}</Text>
                <Text style={[S.small, { marginTop: 4 }]}>{tr('hs.splitDesc')}</Text>
                <View style={[S.row, { gap: 10, marginTop: 10 }]}>
                  <Pressable
                    style={[plan.choice === 'single' ? S.darkBtn : S.ghostBtn, { flex: 1 }]}
                    onPress={() => buildSellPlan('single')}
                  >
                    <Text style={plan.choice === 'single' ? S.darkBtnText : S.ghostBtnText}>
                      {tr('hs.useSingle')}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[plan.choice === 'split' ? S.darkBtn : S.ghostBtn, { flex: 1 }]}
                    onPress={() => buildSellPlan('split')}
                  >
                    <Text style={plan.choice === 'split' ? S.darkBtnText : S.ghostBtnText}>
                      {tr('hs.useSplit')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
            {noGas42 ? <Text style={[S.err, { marginTop: 12 }]}>{tr('hs.gasWarn42')}</Text> : null}
            {lowTargetGas && endCoin === 'native' ? (
              <Text style={[S.err, { marginTop: 8 }]}>{tr('hs.gasWarnTarget', { sym: targetSym })}</Text>
            ) : null}
            <Text style={[S.tiny, { marginTop: 12 }]}>{tr('hs.firstTimeNote')}</Text>
            {sellGate?.insufficient ? (
              <Text style={[S.err, { marginTop: 12 }]}>{tr('hs.quoteOnly')}</Text>
            ) : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 16 }, sellGate?.insufficient && { opacity: 0.4 }]}
              disabled={!!sellGate?.insufficient}
              onPress={plan?.fromUsdt42 ? startSellFlow42 : startSellFlow}
            >
              <Text style={S.bigBtnText}>{tr('hs.start')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'run' && flow ? (
          <>
            <Text style={S.h2}>
              {tr('hs.stepOf', {
                a: String(
                  Math.min(
                    flow.parts.reduce((s, p) => s + Math.min(p.step, 4), 0) +
                      (step?.kind === 'waitTarget' || step?.kind === 'finalSwap'
                        ? 1
                        : step?.kind === 'done'
                          ? 2
                          : 0) +
                      1,
                    flow.parts.length * 4 + 2,
                  ),
                ),
                b: String(flow.parts.length * 4 + 2),
              })}{' '}
              — {flow.direction === 'sell' ? tr('hs.sell') : ''}
            </Text>
            <View style={S.cardBox}>
              {flow.parts.map((p, i) => (
                <View
                  key={i}
                  style={[
                    S.row,
                    { justifyContent: 'space-between', paddingVertical: 5 },
                    p.step < 4 && { opacity: 0.85 },
                  ]}
                >
                  <Text style={S.small}>
                    {tr('hs.partLabel', { n: String(i + 1) })}: {p.sym}
                  </Text>
                  <Text
                    style={[
                      S.small,
                      p.step >= 4 && { color: '#1b7a43', fontWeight: '700' },
                    ]}
                  >
                    {p.step >= 4 ? '✓' : p.step === 2 ? tr('hs.waiting') : '…'}
                  </Text>
                </View>
              ))}
            </View>
            <Text style={[S.body, { marginTop: 16, fontWeight: '700' }]}>{stepLabel()}</Text>
            {/* End goal (invariant): the final asset this flow
                delivers — from the SAVED flow state (the arrival
                choice made at start), never recomputed on
                resume — with its stored amount estimate. */}
            <View style={[S.row, { justifyContent: 'space-between', marginTop: 8 }]}>
              <Text style={S.small}>{tr('hs.youGet')}</Text>
              <Text style={[S.body, { fontWeight: '700' }]}>
                {fmtTok(
                  bigOr0(flow.confirmedOut),
                  flow.endCoin === 'usdt'
                    ? USDT_ON[flow.exitTarget ?? 'bsc'].decimals
                    : 18,
                )}{' '}
                {flow.finalAsset ??
                  (flow.endCoin === 'usdt'
                    ? 'USDT'
                    : flow.exitTarget === 'ethereum'
                      ? 'ETH'
                      : 'BNB')}
              </Text>
            </View>
            {/* QL1 gas-shortage guidance (v0.4.1), as on the
                buy side: dedicated state + faucet button,
                never the generic error. */}
            {ql1Short ? (
              <View style={{ marginTop: 12 }}>
                <Text style={S.err}>{tr('hs.gasQomShort')}</Text>
                <Text style={[S.small, { marginTop: 6 }]}>{tr('hs.wqomNote')}</Text>
                <View style={{ marginTop: 10 }}>
                  <FaucetButton label={tr('faucet.goFaucet')} primary />
                </View>
              </View>
            ) : null}
            {step?.kind === 'pausedTarget' ? (
              <>
                <Text style={[S.body, { marginTop: 10 }]}>
                  {tr('hs.needGasTarget', { sym: targetSym })}
                </Text>
                <Pressable style={[S.bigBtn, { marginTop: 14 }]} onPress={checkGasAgain}>
                  <Text style={S.bigBtnText}>{tr('hs.checkAgain')}</Text>
                </Pressable>
                <Pressable style={[S.ghostBtn, { marginTop: 10 }]} onPress={finishHere}>
                  <Text style={S.ghostBtnText}>{tr('hs.finishHere')}</Text>
                </Pressable>
              </>
            ) : step?.kind === 'waitTarget' || (step?.kind === 'part' && step.step === 2) ? (
              <ActivityIndicator color={ACCENT} style={{ marginTop: 16 }} />
            ) : (
              <Pressable
                style={[S.bigBtn, { marginTop: 16 }, busy && { opacity: 0.5 }]}
                disabled={busy}
                onPress={onRunNext}
              >
                <Text style={S.bigBtnText}>{tr('hs.next')}</Text>
              </Pressable>
            )}
            <Pressable style={[S.ghostBtn, { marginTop: 12 }]} onPress={uturn}>
              <Text style={S.ghostBtnText}>{tr('hs.uturn')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'done' ? (
          <>
            <View style={[S.cardBox, { marginTop: 16 }]}>
              <View style={{ alignItems: 'center' }}>
                <View
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 28,
                    backgroundColor: '#1b7a43',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 28, fontWeight: '800' }}>✓</Text>
                </View>
                <Text style={[S.h1, { marginTop: 12 }]}>{tr('hs.doneTitle')}</Text>
                <Text style={[S.body, { marginTop: 8, textAlign: 'center' }]}>
                  {finishedWithUsdt ? tr('hs.doneUsdtDesc') : tr('hs.doneSellDesc')}
                </Text>
              </View>
              {balLine(targetSym, target === 'bsc' ? balances?.bscNative ?? null : balances?.ethNative ?? null, 18, targetSym)}
              {balLine('USDT', target === 'bsc' ? balances?.bscUsdt ?? null : balances?.ethUsdt ?? null, USDT_ON[target].decimals, 'USDT')}
              {balLine('42', balances?.infNative ?? null, 18, '42')}
              {balLine('QOM', balances?.ql1Native ?? null, 18, 'QOM')}
            </View>
            <Pressable style={[S.bigBtn, { marginTop: 18 }]} onPress={onClose}>
              <Text style={S.bigBtnText}>{tr('common.close')}</Text>
            </Pressable>
          </>
        ) : null}

        {status ? (
          <Text style={[status.err ? S.err : S.small, { marginTop: 14 }]}>{status.text}</Text>
        ) : null}
        {quoting && slowQuote ? (
          <Text style={[S.small, { marginTop: 10 }]}>{tr('hs.stillWorking')}</Text>
        ) : null}
      </ScrollView>

      <ConfirmSheet
        visible={pending !== null}
        title={pending?.title ?? ''}
        confirmLabel={tr('hs.next')}
        cancelLabel={tr('settings.cancel')}
        onConfirm={() => pending?.run()}
        onCancel={() => {
          if (!busy) setPending(null);
        }}
        busy={busy}
      />
    </View>
  );
}

/* ================================================================== */
/* HuntersSwap screen: direction toggle + buy / sell sections         */
/* ================================================================== */

/** Faucet entry in the HuntersDEX header (v0.4.1), pill-styled
 *  to match the Send / Close pills beside it. */
function FaucetPillButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={{
          backgroundColor: '#eff3f4',
          borderRadius: 999,
          paddingHorizontal: 14,
          paddingVertical: 8,
        }}
      >
        <Text style={{ color: '#0f1419', fontSize: 14, fontWeight: '600' }}>
          {tr('faucet.title')}
        </Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <FaucetScreen onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}

export default function HuntersSwapScreen({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const [sendOpen, setSendOpen] = useState(false);
  /* Goal recommendation (v0.4.1): keyed off the user's actual
     position — holding CAW highlights the cash-out goal;
     anything else (or an unreadable balance) defaults to the
     buy goal. See recommendedGoal in lib/hunters. */
  const [goalRec, setGoalRec] = useState<'buy' | 'sell'>('buy');
  useEffect(() => {
    if (!app.address) return;
    let live = true;
    fetchHsBalances(app.address)
      .then((b) => {
        if (live) setGoalRec(recommendedGoal(b.ql1Qcaw ?? 0n));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [app.address]);
  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      {/* Brand header (v0.4.0): the feature's name is HuntersDEX
       * (a proper noun, never translated); the localized
       * "Buy / sell CAW" line stays as its caption. Display-only
       * rename — internal ids and storage keys still say
       * HuntersSwap, like the qCAW→CAW rename before it. */}
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 12,
          borderBottomWidth: 1,
          borderBottomColor: HAIRLINE,
        }}
      >
        <View style={[S.row, { justifyContent: 'space-between', alignItems: 'flex-start' }]}>
          <View style={{ flex: 1, paddingRight: 8 }}>
            <Text style={{ fontSize: 25, fontWeight: '800', color: '#0f1419', letterSpacing: 0.2 }}>
              Hunters<Text style={{ color: ACCENT }}>DEX</Text>
            </Text>
            <Text style={[S.small, { marginTop: 1 }]}>{tr('hs.title')}</Text>
          </View>
          <View style={[S.row, { gap: 8, paddingTop: 2 }]}>
            <FaucetPillButton />
            <Pressable
              onPress={() => setSendOpen(true)}
              style={{
                backgroundColor: ACCENT,
                borderRadius: 999,
                paddingHorizontal: 14,
                paddingVertical: 8,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>{tr('send.title')}</Text>
            </Pressable>
            <Pressable
              onPress={onClose}
              style={{
                backgroundColor: '#eff3f4',
                borderRadius: 999,
                paddingHorizontal: 14,
                paddingVertical: 8,
              }}
            >
              <Text style={{ color: '#0f1419', fontSize: 14, fontWeight: '600' }}>{tr('common.close')}</Text>
            </Pressable>
          </View>
        </View>
        {/* Direction by GOAL, not by technique (v0.4.1): two
         * prominent cards — "for people who want CAW" and "for
         * people who want to cash out". The card matching the
         * user's current position glows with an おすすめ
         * badge (recommendedGoal); the chosen card is filled.
         * The cards are also the U-turn junction: switching
         * goal here keeps every start point of the other
         * direction one tap away. */}
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
          {(['buy', 'sell'] as const).map((d) => {
            const on = direction === d;
            const rec = goalRec === d;
            return (
              <Pressable
                key={d}
                onPress={() => setDirection(d)}
                style={{
                  flex: 1,
                  borderWidth: 2,
                  borderColor: on || rec ? ACCENT : '#eff3f4',
                  backgroundColor: on ? '#f2f8ff' : '#fff',
                  borderRadius: 16,
                  padding: 12,
                  shadowColor: ACCENT,
                  shadowOpacity: rec ? 0.35 : 0,
                  shadowRadius: rec ? 8 : 0,
                  shadowOffset: { width: 0, height: 2 },
                  elevation: rec ? 4 : 0,
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    minHeight: 20,
                  }}
                >
                  <Text style={{ fontSize: 17 }}>{d === 'buy' ? '🐟' : '💰'}</Text>
                  {rec ? (
                    <View
                      style={{
                        backgroundColor: ACCENT,
                        borderRadius: 999,
                        paddingHorizontal: 8,
                        paddingVertical: 2,
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>
                        {tr('hs.recommend')}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: '700',
                    color: '#0f1419',
                    marginTop: 6,
                  }}
                >
                  {tr(d === 'buy' ? 'hs.goalBuy' : 'hs.goalSell')}
                </Text>
                <Text style={[S.small, { marginTop: 2 }]}>
                  {tr(d === 'buy' ? 'hs.goalBuySub' : 'hs.goalSellSub')}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <Modal
        visible={sendOpen}
        animationType="slide"
        onRequestClose={() => setSendOpen(false)}
      >
        <SendScreen onClose={() => setSendOpen(false)} />
      </Modal>
      {direction === 'buy' ? (
        <BuySection onClose={onClose} onSwitchDirection={() => setDirection('sell')} />
      ) : (
        <SellSection onClose={onClose} onSwitchDirection={() => setDirection('buy')} />
      )}
    </View>
  );
}

export function HuntersSwapModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <HuntersSwapScreen onClose={onClose} />
    </Modal>
  );
}
