/**
 * HuntersDEX swap section (v0.7.0) — a NORMAL DEX flow.
 *
 * Replaces the HuntersExchange order book as the HuntersDEX
 * screen's body (user decision 2026-11-18: 「板」ではなく
 * 通常の DEX の仕組みで). The interaction mirrors the app's
 * swap: pick a from-token and a to-token, type an amount,
 * read the live quote, swap. Quotes and tx building come
 * from the app's existing aggregator engine (lib/aggEngine)
 * over the QomSwap router on QL1 — the same engine the
 * HuntersSwap flows have used since v0.3.
 *
 * Tradable tokens are LIMITED (user decision): QOM
 * (native), O, qCAW, KET, HAWK, PHOENIX — plus, since
 * v0.7.7 (user decision 2026-11-19), WQOM. Every ordered
 * swap pair was quote-probed live through this engine
 * (2026-11-18 for the original six, 2026-11-19 for the
 * WQOM pairs); a pair (or an amount) with no route at
 * quote time shows the honest no-pool note and the Swap
 * button stays disabled — a quote is never faked.
 *
 * QOM ⇄ WQOM is NOT a swap: the pair is served by the
 * WQOM contract itself, 1:1 — wrap is WQOM.deposit()
 * (the amount rides in the tx value), unwrap is
 * WQOM.withdraw(amount), both built by lib/hunters
 * (buildWrapTx / buildUnwrapTx, the same builders the
 * HuntersSwap flows use). The "quote" for the pair is
 * exact by construction (amount out = amount in, no
 * price impact, no slippage), so it is synthesized
 * locally instead of probed through the router — the
 * router path for two tokens at the same address would
 * be degenerate. No approve exists on this pair either:
 * deposit takes the native value, withdraw is called on
 * the token contract itself.
 *
 * Sends: approve (exact amount, only when the router
 * allowance is short) then the swap, each confirmed, with a
 * fresh re-quote before signing — if the fresh quote moved
 * more than 5% against the user, the send stops with the
 * price-moved note instead of signing the worse price.
 * Slippage for the swap tx itself is 1%. When the from-token
 * is native QOM, the spendable amount nets out the QL1 gas
 * keep — which since the user's 2026-11-18 decision is 0
 * (no reserve is held back; see src/lib/hunters.ts), so the
 * full QOM balance is spendable here, as on the web DEX.
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
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ConfirmSheet, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import {
  CHAINS,
  buildApproveTx,
  buildSwapTx,
  fetchBestRoute,
  formatAmount,
  parseAmount,
  tokenById,
} from '../lib/aggEngine';
import { ALLOWANCE_SELECTOR } from '../lib/burnHawk';
import { ethCall } from '../lib/cawApi';
import { encAddr, fmtAmountCardDec } from '../lib/cawCore';
import {
  QL1_GAS_KEEP_FLOOR_WEI,
  TxUnconfirmedError,
  WQOM_ADDR,
  buildUnwrapTx,
  buildWrapTx,
  erc20Balance,
} from '../lib/hunters';
import { sendTxReq, signerFor } from '../lib/wallet';

const CHAIN = CHAINS.ql1;
const SLIPPAGE_PCT = 1;

/** The tradable tokens, by aggEngine id on QL1. WQOM
 *  (v0.7.7) is the engine's own 'wqom' entry — the same
 *  WQOM contract (lib/hunters WQOM_ADDR) the router paths
 *  already anchor on. The wallet's balance display is a
 *  separate, unchanged list; this list is DEX-only. */
const DEX_TOKENS = [
  { id: 'native', sym: 'QOM' },
  { id: 'wqom', sym: 'WQOM' },
  { id: 'o', sym: 'O' },
  { id: 'qcaw', sym: 'qCAW' },
  { id: 'ket', sym: 'KET' },
  { id: 'hawk', sym: 'HAWK' },
  { id: 'phoenix', sym: 'PHOENIX' },
] as const;

type DexTokenId = (typeof DEX_TOKENS)[number]['id'];
type Status = { text: string; tone: 'info' | 'ok' | 'err' } | null;
/** The engine is untyped (ported JS); its route objects carry
 *  { path, amounts, amountOut, amountIn, hops, priceImpactPct }. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Route = any;

const CHIP_PCTS = [25, 50, 75, 100] as const;

export default function DexSwapSection() {
  const app = useApp();
  const [fromId, setFromId] = useState<DexTokenId>('native');
  const [toId, setToId] = useState<DexTokenId>('o');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Route | null>(null);
  const [quoteState, setQuoteState] = useState<
    'idle' | 'checking' | 'ok' | 'none'
  >('idle');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const quoteSeq = useRef(0);

  const fromTok = useMemo(() => tokenById('ql1', fromId), [fromId]);
  const toTok = useMemo(() => tokenById('ql1', toId), [toId]);
  const fromSym = DEX_TOKENS.find((t) => t.id === fromId)?.sym ?? '';
  const toSym = DEX_TOKENS.find((t) => t.id === toId)?.sym ?? '';

  /* WQOM balance (v0.7.7): the wallet's balance display
   * deliberately does NOT carry WQOM (its six-token list is
   * a separate user decision), so this section reads its
   * own copy straight from the contract — on mount, on
   * wallet change, and after every send it makes. */
  const [wqomBal, setWqomBal] = useState<bigint | null>(null);
  const refreshWqomBal = useCallback(() => {
    if (!app.address) {
      setWqomBal(null);
      return;
    }
    erc20Balance('ql1', WQOM_ADDR, app.address)
      .then((v) => setWqomBal(v))
      .catch(() => {});
  }, [app.address]);
  useEffect(() => {
    refreshWqomBal();
  }, [refreshWqomBal]);

  /** The QOM ⇄ WQOM pair: a 1:1 wrap/unwrap through the
   *  WQOM contract, never a router swap (see the header). */
  const isWrapPair =
    (fromId === 'native' && toId === 'wqom') ||
    (fromId === 'wqom' && toId === 'native');

  const balanceOf = (id: DexTokenId): bigint | null => {
    switch (id) {
      case 'native':
        return app.qom;
      case 'wqom':
        return wqomBal;
      case 'qcaw':
        return app.qcaw;
      case 'o':
        return app.oTok ? app.oTok.raw : null;
      case 'ket':
        return app.ket ? app.ket.raw : null;
      case 'hawk':
        return app.hawk ? app.hawk.raw : null;
      case 'phoenix':
        return app.phoenix ? app.phoenix.raw : null;
    }
  };
  const fromBalance = balanceOf(fromId);

  /** What the user can actually spend: native QOM keeps the
   *  gas keep back; tokens can go to zero. */
  const spendable = (id: DexTokenId, bal: bigint | null): bigint | null => {
    if (bal === null) return null;
    if (id === 'native')
      return bal > QL1_GAS_KEEP_FLOOR_WEI ? bal - QL1_GAS_KEEP_FLOOR_WEI : 0n;
    return bal;
  };
  const maxSpendable = spendable(fromId, fromBalance);

  const amountIn = useMemo(() => {
    if (!fromTok) return null;
    try {
      const v = parseAmount(amount, fromTok.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amount, fromTok]);

  const overBalance =
    amountIn !== null && maxSpendable !== null && amountIn > maxSpendable;

  /* Live quote, debounced; a sequence guard keeps a slow
   * earlier quote from overwriting a newer one. */
  useEffect(() => {
    if (!fromTok || !toTok || amountIn === null || overBalance) {
      setQuote(null);
      setQuoteState('idle');
      return;
    }
    if (isWrapPair) {
      /* Wrap/unwrap: the quote is exact by construction —
       * 1 WQOM is always 1 QOM. Synthesized locally in the
       * route's shape; doSwap branches on isWrapPair before
       * any of the route machinery is touched. */
      setQuote({ amountOut: amountIn, priceImpactPct: 0, wrap: true });
      setQuoteState('ok');
      return;
    }
    const seq = ++quoteSeq.current;
    setQuoteState('checking');
    const timer = setTimeout(() => {
      fetchBestRoute(CHAIN, fromTok, toTok, amountIn)
        .then((route) => {
          if (quoteSeq.current !== seq) return;
          setQuote(route);
          setQuoteState(route ? 'ok' : 'none');
        })
        .catch(() => {
          if (quoteSeq.current !== seq) return;
          setQuote(null);
          setQuoteState('none');
        });
    }, 700);
    return () => clearTimeout(timer);
  }, [fromTok, toTok, amountIn, overBalance]);

  const pickFrom = (id: DexTokenId) => {
    setStatus(null);
    if (id === toId) setToId(fromId);
    setFromId(id);
  };
  const pickTo = (id: DexTokenId) => {
    setStatus(null);
    if (id === fromId) setFromId(toId);
    setToId(id);
  };

  const setPct = (pct: number) => {
    if (!fromTok || maxSpendable === null) return;
    const part = (maxSpendable * BigInt(pct)) / 100n;
    setAmount(formatAmount(part, fromTok.decimals, 8).replace(/,/g, ''));
    setStatus(null);
  };

  const canSwap =
    !busy &&
    quoteState === 'ok' &&
    quote !== null &&
    amountIn !== null &&
    !overBalance &&
    !!app.address;

  const doSwap = async () => {
    if (!canSwap || !fromTok || !toTok || !app.address || !quote || !amountIn)
      return;
    setConfirming(false);
    setBusy(true);
    setStatus({ text: tr('hs.sending'), tone: 'info' });
    try {
      const ok = await app.requireAuth();
      if (!ok) {
        setStatus(null);
        return;
      }
      const sec = app.getSecret();
      if (!sec) throw new Error('no secret');
      const signer = signerFor(sec.kind, sec.secret);
      if (isWrapPair) {
        /* Wrap / unwrap (v0.7.7): a single call on the WQOM
         * contract itself — deposit() with the amount as the
         * tx value, or withdraw(amount). No router, no
         * approve, no re-quote: the 1:1 rate cannot move.
         * The builders are lib/hunters' own, shared with
         * the HuntersSwap flows. */
        const tx =
          fromId === 'native'
            ? buildWrapTx(amountIn)
            : buildUnwrapTx(amountIn);
        await sendTxReq(signer, tx);
        setStatus({ text: tr('dex.done'), tone: 'ok' });
        setAmount('');
        setQuote(null);
        setQuoteState('idle');
        app.refreshBalances().catch(() => {});
        refreshWqomBal();
        return;
      }
      /* Fresh re-quote at send time; a >5% adverse move (or a
       * vanished route) stops the send rather than signing a
       * price the user never saw. */
      const fresh: Route = await fetchBestRoute(CHAIN, fromTok, toTok, amountIn);
      if (!fresh) {
        setStatus({ text: tr('hs.noRoute'), tone: 'err' });
        return;
      }
      if (fresh.amountOut * 100n < quote.amountOut * 95n) {
        setStatus({ text: tr('hs.priceMoved'), tone: 'err' });
        return;
      }
      if (!fromTok.isNative) {
        const data =
          ALLOWANCE_SELECTOR + encAddr(app.address) + encAddr(CHAIN.router);
        const res = await ethCall(fromTok.address, data);
        const allowance = res && res !== '0x' ? BigInt(res) : 0n;
        if (allowance < amountIn) {
          await sendTxReq(
            signer,
            buildApproveTx(fromTok.address, CHAIN.router, amountIn),
          );
        }
      }
      const tx = buildSwapTx(
        CHAIN,
        fromTok,
        toTok,
        fresh,
        app.address,
        SLIPPAGE_PCT,
        Math.floor(Date.now() / 1000),
      );
      await sendTxReq(signer, tx);
      setStatus({ text: tr('dex.done'), tone: 'ok' });
      setAmount('');
      setQuote(null);
      setQuoteState('idle');
      app.refreshBalances().catch(() => {});
      refreshWqomBal();
    } catch (e) {
      if (e instanceof TxUnconfirmedError) {
        setStatus({ text: tr('hs.unconfirmed'), tone: 'err' });
      } else {
        setStatus({ text: tr('hs.failed'), tone: 'err' });
      }
    } finally {
      setBusy(false);
    }
  };

  const tokenChips = (
    selected: DexTokenId,
    onPick: (id: DexTokenId) => void,
  ) => (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingEnd: 8 }}
    >
      {DEX_TOKENS.map((t) => {
        const on = t.id === selected;
        return (
          <Pressable
            key={t.id}
            onPress={() => onPick(t.id)}
            disabled={busy}
            style={{
              backgroundColor: on ? ACCENT : '#eff3f4',
              borderRadius: 999,
              paddingHorizontal: 14,
              paddingVertical: 8,
            }}
          >
            <Text
              style={{
                color: on ? '#fff' : '#0f1419',
                fontSize: 14,
                fontWeight: '700',
              }}
            >
              {t.sym}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );

  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
      <Text style={S.small}>{tr('dex.from')}</Text>
      <View style={{ marginTop: 8 }}>{tokenChips(fromId, pickFrom)}</View>
      <Text style={[S.small, { marginTop: 10 }]}>
        {tr('dex.balance', {
          balance:
            fromBalance !== null && fromTok
              ? fmtAmountCardDec(fromBalance, fromTok.decimals)
              : '—',
        })}
      </Text>

      <View style={[S.row, { marginTop: 12, gap: 8 }]}>
        <TextInput
          style={[S.input, { flex: 1 }]}
          value={amount}
          onChangeText={(t) => {
            setAmount(t);
            setStatus(null);
          }}
          keyboardType="decimal-pad"
          placeholder="0"
          placeholderTextColor="#536471"
          editable={!busy}
        />
        <Text style={[S.body, { fontWeight: '700' }]}>{fromSym}</Text>
      </View>
      <View style={[S.row, { marginTop: 10, gap: 8 }]}>
        {CHIP_PCTS.map((pct) => (
          <Pressable
            key={pct}
            onPress={() => setPct(pct)}
            disabled={busy || maxSpendable === null}
            style={{
              backgroundColor: '#eff3f4',
              borderRadius: 999,
              paddingHorizontal: 14,
              paddingVertical: 7,
              opacity: busy || maxSpendable === null ? 0.5 : 1,
            }}
          >
            <Text style={{ color: '#0f1419', fontSize: 13.5, fontWeight: '700' }}>
              {pct === 100 ? 'MAX' : pct + '%'}
            </Text>
          </Pressable>
        ))}
      </View>
      {overBalance ? (
        <Text style={[S.err, { marginTop: 10 }]}>
          {fromId === 'native' ? tr('hs.gasQomShort') : tr('hs.notEnough')}
        </Text>
      ) : null}

      <Text style={[S.small, { marginTop: 20 }]}>{tr('dex.to')}</Text>
      <View style={{ marginTop: 8 }}>{tokenChips(toId, pickTo)}</View>

      {quoteState === 'checking' ? (
        <View style={[S.row, { marginTop: 16, gap: 8 }]}>
          <ActivityIndicator color={ACCENT} />
          <Text style={S.small}>{tr('hs.checking')}</Text>
        </View>
      ) : quoteState === 'none' ? (
        <Text style={[S.err, { marginTop: 16 }]}>{tr('dex.noPool')}</Text>
      ) : quoteState === 'ok' && quote && toTok ? (
        <View style={{ marginTop: 16 }}>
          <Text style={[S.body, { fontWeight: '700' }]}>
            {tr('dex.youGet')}: {formatAmount(quote.amountOut, toTok.decimals, 6)}{' '}
            {toSym}
          </Text>
          {quote.priceImpactPct !== null &&
          quote.priceImpactPct !== undefined &&
          quote.priceImpactPct >= 1 ? (
            <Text style={[S.small, { marginTop: 4 }]}>
              {tr('dex.impact')}: {quote.priceImpactPct.toFixed(1)}%
            </Text>
          ) : null}
        </View>
      ) : null}

      <Pressable
        style={[S.bigBtn, { marginTop: 22 }, !canSwap && { opacity: 0.45 }]}
        disabled={!canSwap}
        onPress={() => setConfirming(true)}
      >
        <Text style={S.bigBtnText}>{tr('dex.swapCta')}</Text>
      </Pressable>

      {busy ? (
        <View style={[S.row, { marginTop: 14, gap: 8 }]}>
          <ActivityIndicator color={ACCENT} />
          <Text style={S.small}>{status ? status.text : ''}</Text>
        </View>
      ) : status ? (
        <Text
          style={[
            status.tone === 'ok' ? S.ok : status.tone === 'err' ? S.err : S.small,
            { marginTop: 14 },
          ]}
        >
          {status.text}
        </Text>
      ) : null}

      <ConfirmSheet
        visible={confirming}
        title="HuntersDEX"
        body={
          quote && amountIn !== null && fromTok && toTok
            ? tr('dex.confirm', {
                amount: formatAmount(amountIn, fromTok.decimals, 6),
                from: fromSym,
                out: formatAmount(quote.amountOut, toTok.decimals, 6),
                to: toSym,
              })
            : ''
        }
        confirmLabel={tr('dex.swapCta')}
        cancelLabel={tr('compose.cancel')}
        onConfirm={doSwap}
        onCancel={() => setConfirming(false)}
        busy={busy}
      />
    </View>
  );
}
