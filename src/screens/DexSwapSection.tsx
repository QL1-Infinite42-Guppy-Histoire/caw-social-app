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
 * Tradable tokens are LIMITED to six (user decision):
 * QOM (native), O, qCAW, KET, HAWK, PHOENIX. Every ordered
 * pair was quote-probed live through this engine on
 * 2026-11-18 and all 30 had routes at probe amounts; a pair
 * (or an amount) with no route at quote time shows the
 * honest no-pool note and the Swap button stays disabled —
 * a quote is never faked.
 *
 * Sends: approve (exact amount, only when the router
 * allowance is short) then the swap, each confirmed, with a
 * fresh re-quote before signing — if the fresh quote moved
 * more than 5% against the user, the send stops with the
 * price-moved note instead of signing the worse price.
 * Slippage for the swap tx itself is 1%. When the from-token
 * is native QOM, the QL1 gas keep (346,500,000 QOM) is held
 * back exactly as everywhere else in the app.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { QL1_GAS_KEEP_FLOOR_WEI, TxUnconfirmedError } from '../lib/hunters';
import { sendTxReq, signerFor } from '../lib/wallet';

const CHAIN = CHAINS.ql1;
const SLIPPAGE_PCT = 1;

/** The six tradable tokens, by aggEngine id on QL1. */
const DEX_TOKENS = [
  { id: 'native', sym: 'QOM' },
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

  const balanceOf = (id: DexTokenId): bigint | null => {
    switch (id) {
      case 'native':
        return app.qom;
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
