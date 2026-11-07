/**
 * HuntersSwap (v0.3.0) — buy qCAW starting from BNB (BSC) or ETH
 * (Ethereum), guided one step at a time, all inside the app:
 *
 *   entry swap (PancakeSwap / Uniswap) -> bridge to 42 Chain
 *   -> best route to QL1 (aggregator engine, fees counted,
 *      [42] fee set aside from the flow itself) -> qCAW
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

import { ConfirmSheet, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import { BRIDGE_PAIRS, CHAINS as AGG_CHAINS, tokenById } from '../lib/aggEngine';
import { fmtAmount } from '../lib/cawCore';
import {
  BRIDGE_IN_USDT,
  BRIDGE_OUT_USDT_42,
  ENTRY_DEX,
  USDT_ON,
  type EntryKey,
} from '../lib/chains';
import {
  flowComplete,
  newFlow,
  nextStep,
  type HuntersFlow,
} from '../lib/flows';
import {
  applySlippage,
  arrivalBalance,
  buildAggApprove,
  buildAggBridge,
  buildBridgeInTx,
  buildEntrySwapTx,
  buildRouteSwapTx,
  bscSpendable,
  chipAmount,
  erc20Allowance,
  erc20Balance,
  ethEntryAllowed,
  ethGasExpensive,
  ethGasInfo,
  expected42Usdt,
  fetchHsBalances,
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
  toTargetUsdtRaw,
  type GasEstimates,
  buildAggBridgeFromQl1,
  buildBridgeOut42Tx,
  buildFinalSwapTx,
  quoteBackHalfReverse,
  quoteBridgeOut42,
  quoteFinalSwap,
  truncateToDstDecimals,
  worseThanConfirmed,
  type BackHalfQuote,
  type CarvePlan,
  type HsBalances,
} from '../lib/hunters';
import { huntersFlowStore, huntersSellFlowStore, storeKV } from '../lib/stores';
import { sendTxReq, signerForHsChain } from '../lib/wallet';

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
}

const fmtUsd = (n: number) =>
  '$' + n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 0 });
const fmtTok = (raw: bigint, dec: number) =>
  dec === 18 ? fmtAmount(raw) : formatUnits(raw, dec);

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

function BuySection({ onClose }: { onClose: () => void }) {
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

  const parsedAmount = (e: EntryKey): bigint | null => {
    try {
      const v = parseUnits(amountText.trim() === '' ? '0' : amountText.trim(), 18);
      return v;
    } catch {
      return null;
    }
  };

  /* ---------- quoting for the confirm screen ---------- */
  const buildPlan = async (choice: 'single' | 'split') => {
    const amt = parsedAmount(entry);
    if (amt === null || amt <= 0n) return;
    setQuoting(true);
    setStatus(null);
    try {
      const entryUsdt = await quoteEntrySwap(entry, amt);
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
      setPlan({ entryAmount: amt, entryUsdt, usdt42, back, carve, carveCost, choice, expectedOut });
      setPhase('confirm');
    } catch {
      setStatus({ text: tr('hs.failed'), err: true });
    } finally {
      setQuoting(false);
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
      entryUsdtBefore: before.toString(),
      carveUsdtCost: plan.carveCost.toString(),
    });
    setResumeFlow(null);
    await persist(f);
    setPhase('run');
  };

  const resume = async () => {
    if (!resumeFlow) return;
    setFlow(resumeFlow);
    flowRef.current = resumeFlow;
    setResumeFlow(null);
    if (flowComplete(resumeFlow)) setPhase('done');
    else setPhase('run');
  };

  const discard = async () => {
    setResumeFlow(null);
    await huntersFlowStore.clear();
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
      const f1 = after({ ...flowRef.current! });
      await persist(f1);
      setStatus(null);
      setPending(null);
      setAllowanceTick((t) => t + 1);
    } catch (e) {
      setStatus({
        text: tr(e instanceof Error && e.message === 'price-moved' ? 'hs.priceMoved' : 'hs.failed'),
        err: true,
      });
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
            const isNative = pair.sym === 'QOM';
            const now = await arrivalBalance(
              'ql1',
              isNative ? null : dstTok.address,
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
          const isNative = part.sym === 'QOM';
          dstBefore = (await arrivalBalance('ql1', isNative ? null : dstTok.address, address)).toString();
          return buildAggBridge({ pair: { sym: part.sym } }, address, amt, fee);
        }, (g) => {
          const parts = g.parts.slice();
          parts[partIdx] = { ...parts[partIdx], step: 2, dstBalanceBefore: dstBefore };
          return { ...g, parts };
        });
      });
      return;
    }

    if (partStep === 3) {
      const dstTok = tokenById('ql1', pair.ql1Id);
      const amt = BigInt(part.bridgedAmount ?? '0');
      const isNative = part.sym === 'QOM';
      if (!isNative) {
        const ql1Router = AGG_CHAINS.ql1.router as string;
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
          const qcaw = tokenById('ql1', 'qcaw');
          const route = await freshRoute('ql1', dstTok.address, qcaw.address, amt, part.leg2Path);
          if (!route) throw new Error('no-route');
          return buildRouteSwapTx('ql1', route, address, 1);
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
    if (step.kind === 'entrySwap') runEntrySwap();
    else if (step.kind === 'entryBridge') prepareEntryBridge();
    else if (step.kind === 'carve') runCarve();
    else if (step.kind === 'part' && (step.step === 0 || step.step === 1 || step.step === 3)) {
      preparePart(step.partIdx, step.step);
    }
  };

  const amt = parsedAmount(entry);
  const amtUsd =
    amt !== null && nativePrice(entry) ? Number(formatUnits(amt, 18)) * (nativePrice(entry) ?? 0) : null;
  const ethBlocked = entry === 'ethereum' && amt !== null && amt > 0n && ethUsd !== null && !ethEntryAllowed(amt, ethUsd);
  const overSpendable = amt !== null && amt > spendable(entry);

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
          </View>
        ) : null}

        {phase === 'entry' ? (
          <>
            <Text style={S.body}>{tr('hs.intro')}</Text>
            <Text style={[S.h2, { marginTop: 18 }]}>{tr('hs.yourCoins')}</Text>
            {balLine('BNB (BSC)', balances?.bscNative ?? null, 18, 'BNB')}
            {balLine('USDT (BSC)', balances?.bscUsdt ?? null, 18, 'USDT')}
            {balLine('ETH (Ethereum)', balances?.ethNative ?? null, 18, 'ETH')}
            {balLine('USDT (Ethereum)', balances?.ethUsdt ?? null, 6, 'USDT')}
            {balLine('42', balances?.infNative ?? null, 18, '42')}
            {balLine('USDT (42 Chain)', balances?.infUsdt ?? null, 18, 'USDT')}
            {balLine('QOM (QL1)', balances?.ql1Native ?? null, 18, 'QOM')}
            {balLine('qCAW (QL1)', balances?.ql1Qcaw ?? null, 18, 'qCAW')}

            <Text style={[S.h2, { marginTop: 18 }]}>{tr('hs.amountTitle')}</Text>
            {(['bsc', 'ethereum'] as EntryKey[]).map((e) => (
              <Pressable
                key={e}
                onPress={() => setEntry(e)}
                style={{
                  borderWidth: 2,
                  borderColor: entry === e ? ACCENT : '#eff3f4',
                  borderRadius: 14,
                  padding: 14,
                  marginTop: 10,
                }}
              >
                <Text style={[S.body, { fontWeight: '700' }]}>
                  {tr(e === 'bsc' ? 'hs.fromBsc' : 'hs.fromEth')}
                </Text>
                <Text style={S.small}>
                  {fmtTok(nativeBalance(e), 18)} {e === 'bsc' ? 'BNB' : 'ETH'}
                  {nativePrice(e) ? ' · ' + fmtUsd(Number(formatUnits(nativeBalance(e), 18)) * (nativePrice(e) ?? 0)) : ''}
                </Text>
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
              <Text style={[S.body, { fontWeight: '700' }]}>{entry === 'bsc' ? 'BNB' : 'ETH'}</Text>
            </View>
            <View style={[S.row, { gap: 8, marginTop: 10, flexWrap: 'wrap' }]}>
              {[25, 50, 75, 100].map((pct) => (
                <Pressable
                  key={pct}
                  style={S.chip}
                  onPress={() => setAmountText(formatUnits(chipAmount(spendable(entry), pct), 18))}
                >
                  <Text style={S.chipText}>{pct === 100 ? 'MAX' : pct + '%'}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={[S.small, { marginTop: 10 }]}>
              {tr('hs.gasKeep')}: {fmtTok(nativeBalance(entry) - spendable(entry), 18)} {entry === 'bsc' ? 'BNB' : 'ETH'}
              {amtUsd !== null ? ' · ≈ ' + fmtUsd(amtUsd) : ''}
            </Text>
            {ethBlocked ? <Text style={[S.err, { marginTop: 8 }]}>{tr('hs.ethMin')}</Text> : null}
            {overSpendable ? <Text style={[S.err, { marginTop: 8 }]}>{tr('hs.notEnough')}</Text> : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 18 }, (quoting || amt === null || amt <= 0n || ethBlocked || overSpendable) && S.disabled]}
              disabled={quoting || amt === null || amt <= 0n || ethBlocked || overSpendable}
              onPress={() => buildPlan('single')}
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
            {balLine(entry === 'bsc' ? 'BNB' : 'ETH', plan.entryAmount, 18, entry === 'bsc' ? 'BNB' : 'ETH')}
            {balLine('USDT', plan.entryUsdt, ENTRY_DEX[entry].usdtDecimals, 'USDT')}
            {balLine(tr('hs.feeBridgeIn'), parseUnits('2', 18), 18, 'USDT')}
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
            <View style={{ marginTop: 16 }}>
              <Text style={S.small}>{tr('hs.youGet')}</Text>
              <Text style={[S.h1, { color: ACCENT }]}>{fmtTok(plan.expectedOut, 18)} qCAW</Text>
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
                    onPress={() => plan.choice !== 'split' && buildPlan('split')}
                  >
                    <Text style={plan.choice === 'split' ? S.darkBtnText : S.ghostBtnText}>{tr('hs.useSplit')}</Text>
                  </Pressable>
                  <Pressable
                    style={[plan.choice === 'single' ? S.darkBtn : S.ghostBtn, { flex: 1 }]}
                    onPress={() => plan.choice !== 'single' && buildPlan('single')}
                  >
                    <Text style={plan.choice === 'single' ? S.darkBtnText : S.ghostBtnText}>{tr('hs.useSingle')}</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
            <Text style={[S.small, { marginTop: 14 }]}>{tr('hs.fixedFeeNote')}</Text>
            <Text style={[S.small, { marginTop: 6 }]}>{tr('hs.firstTimeNote')}</Text>
            <Pressable style={[S.bigBtn, { marginTop: 18 }]} onPress={startFlow}>
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
              {watching ? (
                <View style={[S.row, { marginTop: 12, gap: 8 }]}>
                  <ActivityIndicator color={ACCENT} />
                  <Text style={S.small}>{tr('hs.waiting')}</Text>
                </View>
              ) : (
                <Pressable
                  style={[S.bigBtn, { marginTop: 14 }, busy && S.disabled]}
                  disabled={busy}
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
          </>
        ) : null}

        {phase === 'done' ? (
          <>
            <Text style={S.h1}>{tr('hs.doneTitle')}</Text>
            <Text style={[S.body, { marginTop: 10 }]}>{tr('hs.doneDesc')}</Text>
            {balances?.ql1Qcaw !== null && balances?.ql1Qcaw !== undefined ? (
              <Text style={[S.body, { marginTop: 8 }]}>
                {fmtTok(balances.ql1Qcaw, 18)} qCAW
              </Text>
            ) : null}
            {balLine('42', balances?.infNative ?? null, 18, '42')}
            {balLine('USDT (42 Chain)', balances?.infUsdt ?? null, 18, 'USDT')}
            <Pressable style={[S.bigBtn, { marginTop: 18 }]} onPress={onClose}>
              <Text style={S.bigBtnText}>{tr('common.close')}</Text>
            </Pressable>
          </>
        ) : null}

        {status ? (
          <Text style={[status.err ? S.err : S.small, { marginTop: 14 }]}>{status.text}</Text>
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
/* Sell direction: qCAW (QL1) -> QOM -> best route -> USDT (42)       */
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
  back: BackHalfQuote;
  choice: 'single' | 'split';
  usdt42: bigint;
  forwardTarget: bigint;
  nativeOut: bigint;
}

function SellSection({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const address = app.address ?? '';

  const [phase, setPhase] = useState<Phase>('entry');
  const [balances, setBalances] = useState<HsBalances | null>(null);
  const [bnbUsd, setBnbUsd] = useState<number | null>(null);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [target, setTarget] = useState<EntryKey>('bsc');
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
    setQuoting(true);
    setStatus(null);
    try {
      const back = await quoteBackHalfReverse(amt);
      const usdt42 =
        choice === 'split' && back.split ? back.split.netOut : back.bestSingle.finalOut;
      const q = await quoteBridgeOut42(target, usdt42);
      const forwardTarget = toTargetUsdtRaw(q.forward, target);
      const nativeOut = await quoteFinalSwap(target, forwardTarget);
      setPlan({ qcawAmount: amt, back, choice, usdt42, forwardTarget, nativeOut });
      setPhase('confirm');
    } catch {
      setStatus({ text: tr('hs.failed'), err: true });
    } finally {
      setQuoting(false);
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
    const parts: HuntersFlow['parts'] = [];
    if (plan.choice === 'split' && plan.back.split) {
      let used = 0n;
      plan.back.split.parts.forEach((p: any, i: number) => {
        const isLast = i === plan.back.split!.parts.length - 1;
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
      const c = plan.back.bestSingle;
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
      confirmedOut: plan.nativeOut.toString(),
      choice: plan.choice,
      createdAt: Date.now(),
      usdt42Before: usdt42Before.toString(),
      sellUsdt42Expected: plan.usdt42.toString(),
      sellNativeExpected: plan.nativeOut.toString(),
      exitForward: plan.forwardTarget.toString(),
    });
    setResumeFlow(null);
    await persist({ ...base, phase: 'back', carveDone: true, parts });
    setPhase('run');
  };

  const resume = async () => {
    if (!resumeFlow) return;
    setFlow(resumeFlow);
    flowRef.current = resumeFlow;
    setResumeFlow(null);
    setTarget(resumeFlow.exitTarget ?? 'bsc');
    if (resumeFlow.phase === 'done') setPhase('done');
    else setPhase('run');
  };

  const discard = async () => {
    setResumeFlow(null);
    await huntersSellFlowStore.clear();
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
      const f1 = after({ ...flowRef.current! });
      await persist(f1);
      setStatus(null);
      setPending(null);
    } catch (e) {
      setStatus({
        text: tr(e instanceof Error && e.message === 'price-moved' ? 'hs.priceMoved' : 'hs.failed'),
        err: true,
      });
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
            // Gas reality check on the target chain before the
            // final swap is offered.
            const nat = await arrivalBalance(t, null, address).catch(() => 0n);
            const price = t === 'bsc' ? bnbUsd : ethUsd;
            const usd = price ? Number(formatUnits(nat, 18)) * price : 0;
            if (live) {
              await persist({
                ...f,
                phase: usd >= 1 ? 'finalSwap' : 'pausedTarget',
              });
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
  const overBal = amt !== null && amt > qcawBal;

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
          </View>
        ) : null}

        {phase === 'entry' ? (
          <>
            <Text style={S.body}>{tr('hs.sellIntro')}</Text>
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
                {balLine(
                  k === 'bsc' ? 'BNB' : 'ETH',
                  k === 'bsc' ? balances?.bscNative ?? null : balances?.ethNative ?? null,
                  18,
                  k === 'bsc' ? 'BNB' : 'ETH',
                )}
                {balLine(
                  'USDT',
                  k === 'bsc' ? balances?.bscUsdt ?? null : balances?.ethUsdt ?? null,
                  USDT_ON[k].decimals,
                  'USDT',
                )}
              </Pressable>
            ))}
            <Text style={[S.h2, { marginTop: 18 }]}>{tr('hs.yourCoins')}</Text>
            {balLine('qCAW', balances?.ql1Qcaw ?? null, 18, 'qCAW')}
            {balLine('QOM', balances?.ql1Native ?? null, 18, 'QOM')}
            {balLine('USDT (42 Chain)', balances?.infUsdt ?? null, 18, 'USDT')}
            {balLine('42', balances?.infNative ?? null, 18, '42')}
            {noGas42 ? (
              <Text style={[S.err, { marginTop: 12 }]}>{tr('hs.gasWarn42')}</Text>
            ) : null}
            {lowTargetGas ? (
              <Text style={[S.err, { marginTop: 8 }]}>
                {tr('hs.gasWarnTarget', { sym: targetSym })}
              </Text>
            ) : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 20 }, qcawBal <= 0n && { opacity: 0.4 }]}
              disabled={qcawBal <= 0n}
              onPress={() => setPhase('amount')}
            >
              <Text style={S.bigBtnText}>{tr('hs.next')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'amount' ? (
          <>
            <Text style={S.h2}>{tr('hs.amountSellTitle')}</Text>
            {balLine('qCAW', balances?.ql1Qcaw ?? null, 18, 'qCAW')}
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
                  onPress={() => setAmountText(formatUnits(chipAmount(qcawBal, pct), 18))}
                >
                  <Text style={S.chipText}>{pct === 100 ? 'MAX' : pct + '%'}</Text>
                </Pressable>
              ))}
            </View>
            {overBal ? <Text style={[S.err, { marginTop: 10 }]}>{tr('hs.notEnough')}</Text> : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 20 }, (amt === null || amt <= 0n || overBal) && { opacity: 0.4 }]}
              disabled={amt === null || amt <= 0n || overBal || quoting}
              onPress={() => buildSellPlan('single')}
            >
              <Text style={S.bigBtnText}>{quoting ? tr('hs.checking') : tr('hs.next')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'confirm' && plan ? (
          <>
            <Text style={S.h2}>{tr('hs.confirmTitle')}</Text>
            {balLine('qCAW', plan.qcawAmount, 18, 'qCAW')}
            {balLine('USDT (42 Chain)', plan.usdt42, 18, 'USDT')}
            <View style={[S.row, { justifyContent: 'space-between', marginTop: 6 }]}>
              <Text style={S.small}>{tr('hs.feeBridgeOut')}</Text>
              <Text style={[S.body, { fontWeight: '600' }]}>-2 USDT</Text>
            </View>
            {balLine(tr('hs.usdtArriving'), plan.forwardTarget, USDT_ON[target].decimals, 'USDT')}
            {gasEst
              ? balLine(
                  tr('hs.gasQl1Est'),
                  gasEst.gasQomPerSwap * BigInt(plan.choice === 'split' && plan.back.split ? plan.back.split.parts.length : 1),
                  18,
                  'QOM',
                )
              : null}
            {gasEst
              ? balLine(
                  tr('hs.gas42Est'),
                  gasEst.gas42PerLeg * BigInt(plan.choice === 'split' && plan.back.split ? plan.back.split.parts.length : 1),
                  18,
                  '42',
                )
              : null}
            <View style={[S.row, { justifyContent: 'space-between', marginTop: 10 }]}>
              <Text style={S.body}>{tr('hs.youGet')}</Text>
              <Text style={[S.h2, { color: ACCENT }]}>
                {fmtTok(plan.nativeOut, 18)} {targetSym}
              </Text>
            </View>
            {plan.back.split ? (
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
            {lowTargetGas ? (
              <Text style={[S.err, { marginTop: 8 }]}>{tr('hs.gasWarnTarget', { sym: targetSym })}</Text>
            ) : null}
            <Text style={[S.tiny, { marginTop: 12 }]}>{tr('hs.firstTimeNote')}</Text>
            <Pressable style={[S.bigBtn, { marginTop: 16 }]} onPress={startSellFlow}>
              <Text style={S.bigBtnText}>{tr('hs.start')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'run' && flow ? (
          <>
            <Text style={S.h2}>
              {tr('hs.stepOf')} — {flow.direction === 'sell' ? tr('hs.sell') : ''}
            </Text>
            {flow.parts.map((p, i) => (
              <Text key={i} style={[S.small, { marginTop: 6 }]}>
                {tr('hs.partLabel', { n: String(i + 1) })}: {p.sym} — {
                  p.step >= 4 ? '✓' : p.step === 2 ? tr('hs.waiting') : '…'
                }
              </Text>
            ))}
            <Text style={[S.body, { marginTop: 16, fontWeight: '700' }]}>{stepLabel()}</Text>
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
          </>
        ) : null}

        {phase === 'done' ? (
          <>
            <Text style={S.h1}>{tr('hs.doneTitle')}</Text>
            <Text style={[S.body, { marginTop: 10 }]}>
              {finishedWithUsdt ? tr('hs.doneUsdtDesc') : tr('hs.doneSellDesc')}
            </Text>
            {balLine(targetSym, target === 'bsc' ? balances?.bscNative ?? null : balances?.ethNative ?? null, 18, targetSym)}
            {balLine('USDT', target === 'bsc' ? balances?.bscUsdt ?? null : balances?.ethUsdt ?? null, USDT_ON[target].decimals, 'USDT')}
            {balLine('42', balances?.infNative ?? null, 18, '42')}
            {balLine('QOM', balances?.ql1Native ?? null, 18, 'QOM')}
            <Pressable style={[S.bigBtn, { marginTop: 18 }]} onPress={onClose}>
              <Text style={S.bigBtnText}>{tr('common.close')}</Text>
            </Pressable>
          </>
        ) : null}

        {status ? (
          <Text style={[status.err ? S.err : S.small, { marginTop: 14 }]}>{status.text}</Text>
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

export default function HuntersSwapScreen({ onClose }: { onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <View style={[S.row, { paddingHorizontal: 16, paddingVertical: 10, justifyContent: 'space-between' }]}>
        <Text style={S.h1}>{tr('hs.title')}</Text>
        <Pressable onPress={onClose} style={S.ghostBtn}>
          <Text style={S.ghostBtnText}>{tr('common.close')}</Text>
        </Pressable>
      </View>
      <View style={[S.row, { gap: 10, paddingHorizontal: 16, marginBottom: 6 }]}>
        <Pressable
          style={[direction === 'buy' ? S.darkBtn : S.ghostBtn, { flex: 1 }]}
          onPress={() => setDirection('buy')}
        >
          <Text style={direction === 'buy' ? S.darkBtnText : S.ghostBtnText}>{tr('hs.buy')}</Text>
        </Pressable>
        <Pressable
          style={[direction === 'sell' ? S.darkBtn : S.ghostBtn, { flex: 1 }]}
          onPress={() => setDirection('sell')}
        >
          <Text style={direction === 'sell' ? S.darkBtnText : S.ghostBtnText}>{tr('hs.sell')}</Text>
        </Pressable>
      </View>
      {direction === 'buy' ? (
        <BuySection onClose={onClose} />
      ) : (
        <SellSection onClose={onClose} />
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
