/**
 * Send （送る/出金） — v0.3.5. A plain guided send for every balance
 * the app shows: BSC (BNB/USDT), Ethereum (ETH/USDT), 42 Chain
 * ([42]/USDT) and QL1 (QOM/CAW), to any EVM address.
 *
 * Flow: pick the asset -> recipient (type / paste / address book)
 * + amount with 25/50/75/MAX chips -> confirm (full recipient,
 * fee estimate) -> send. The send itself follows the app's
 * established pattern exactly: ConfirmSheet-style explicit
 * confirm screen, app.requireAuth(), the secret from memory,
 * signerForHsChain + sendTxReq. This is a REAL send: amounts must
 * be > 0 and within the usable balance (native MAX leaves the
 * gas reserve behind). No quote-only mode here.
 *
 * The address book lives on-device only (addressBookStore),
 * shared across wallets; after a successful send to an unknown
 * address the screen offers to save it with a label.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { formatUnits, parseUnits } from 'ethers';

import { ConfirmSheet, LTR_TEXT, MONO, S } from '../components/ui';
import { backArrow, forwardArrow } from '../lib/rtl';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import type { BookEntry } from '../lib/addressBook';
import { HS_CHAINS } from '../lib/chains';
import { fmtAmount } from '../lib/cawCore';
import {
  chipAmount,
  fetchHsBalances,
  providerFor,
  TxUnconfirmedError,
  type HsBalances,
} from '../lib/hunters';
import {
  buildSendTx,
  gasAffordable,
  gasReserve,
  maxSendable,
  normalizeRecipient,
  SEND_ASSETS,
  SEND_CHAINS,
  type SendAsset,
} from '../lib/sendAssets';
import { addressBookStore, storeKV } from '../lib/stores';
import { sendTxReq, signerForHsChain } from '../lib/wallet';

type Phase = 'pick' | 'form' | 'book' | 'confirm' | 'done' | 'failed' | 'unconfirmed';

/** Fallback gas prices (wei) if the live fee read fails — only
 *  used for the MAX reserve and the fee estimate, never sent. */
const FALLBACK_GAS_PRICE: Record<SendAsset['chain'], bigint> = {
  bsc: 3_000_000_000n,
  ethereum: 20_000_000_000n,
  infinite: 6_000_000_000n,
  ql1: 1_000_000_000n,
};

const fmtBal = (raw: bigint, dec: number): string => {
  if (dec === 18) return fmtAmount(raw);
  const s = formatUnits(raw, dec);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

const shortAddr = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

export default function SendScreen({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const address = app.address ?? '';

  const [phase, setPhase] = useState<Phase>('pick');
  const [balances, setBalances] = useState<HsBalances | null>(null);
  const [asset, setAsset] = useState<SendAsset | null>(null);
  const [recipient, setRecipient] = useState('');
  const [amountText, setAmountText] = useState('');
  const [gasPrice, setGasPrice] = useState<bigint | null>(null);
  const [book, setBook] = useState<BookEntry[]>([]);
  const [sending, setSending] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState(false);

  /* address-book management state */
  const [newLabel, setNewLabel] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [bookErr, setBookErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [pendingDelete, setPendingDelete] = useState<BookEntry | null>(null);

  /* save-after-send state */
  const [saveLabel, setSaveLabel] = useState('');
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedFlag, setSavedFlag] = useState(false);

  const balOf = useCallback(
    (a: SendAsset): bigint | null =>
      balances ? balances[a.balKey] : null,
    [balances],
  );
  const nativeBalOf = useCallback(
    (chain: SendAsset['chain']): bigint | null => {
      const n = SEND_ASSETS.find(
        (a) => a.chain === chain && a.kind === 'native',
      );
      return n ? balOf(n) : null;
    },
    [balOf],
  );

  const loadBook = useCallback(async () => {
    await addressBookStore.init(storeKV);
    setBook(addressBookStore.list());
  }, []);

  useEffect(() => {
    if (!address) return;
    fetchHsBalances(address)
      .then(setBalances)
      .catch(() => {});
    loadBook().catch(() => {});
  }, [address, loadBook]);

  /* Live gas price for the picked asset's chain (MAX reserve +
     confirm-screen estimate). */
  useEffect(() => {
    if (!asset) return;
    let live = true;
    setGasPrice(null);
    providerFor(asset.chain)
      .getFeeData()
      .then((fd) => {
        if (live) setGasPrice(fd.gasPrice ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [asset]);

  const gasPriceEff =
    gasPrice && gasPrice > 0n
      ? gasPrice
      : asset
        ? FALLBACK_GAS_PRICE[asset.chain]
        : 0n;
  const bal = asset ? balOf(asset) : null;
  const spendable = asset
    ? maxSendable(asset, bal ?? 0n, gasPriceEff)
    : 0n;

  let amountRaw: bigint | null = null;
  if (asset && amountText.trim()) {
    try {
      amountRaw = parseUnits(amountText.trim(), asset.decimals);
    } catch {
      amountRaw = null;
    }
  }
  const recipientNorm = recipient.trim()
    ? normalizeRecipient(recipient)
    : null;
  const recipientBad = recipient.trim().length > 0 && !recipientNorm;
  const overBalance =
    amountRaw !== null && (bal === null || amountRaw > spendable);
  const formValid =
    !!asset &&
    !!recipientNorm &&
    amountRaw !== null &&
    amountRaw > 0n &&
    !overBalance;

  const matchedEntry = recipientNorm
    ? book.find(
        (e) => e.address.toLowerCase() === recipientNorm.toLowerCase(),
      )
    : undefined;

  const pickAsset = (a: SendAsset) => {
    setAsset(a);
    setAmountText('');
    setPhase('form');
  };

  const setChip = (pct: number) => {
    if (!asset) return;
    const amt = chipAmount(spendable, pct);
    setAmountText(
      amt === 0n ? '' : formatUnits(amt, asset.decimals),
    );
  };

  const doSend = async () => {
    if (!asset || !recipientNorm || amountRaw === null) return;
    setSending(true);
    try {
      const ok = await app.requireAuth();
      if (!ok) {
        setSending(false);
        return;
      }
      const sec = app.getSecret();
      if (!sec) throw new Error('no secret');
      const signer = signerForHsChain(sec.kind, sec.secret, asset.chain);
      const req = buildSendTx(asset, recipientNorm, amountRaw);
      const hash = await sendTxReq(signer, req);
      setTxHash(hash);
      setPhase('done');
      app.refreshBalances().catch(() => {});
      if (address) {
        fetchHsBalances(address).then(setBalances).catch(() => {});
      }
    } catch (e) {
      /* A broadcast whose receipt could not be obtained is NOT a
       * failure (v0.4.1): it may have gone through. Show the
       * unconfirmed state with the hash instead of send.failed. */
      if (e instanceof TxUnconfirmedError) {
        setTxHash(e.hash);
        setPhase('unconfirmed');
      } else {
        setPhase('failed');
      }
    } finally {
      setSending(false);
    }
  };

  /* ---------- address book actions ---------- */
  const bookErrorText = (e: unknown, addr: string): string => {
    const msg = e instanceof Error ? e.message : '';
    if (msg === 'duplicate') {
      const found = addressBookStore.find(addr);
      return tr('send.duplicate', { label: found?.label ?? '' });
    }
    if (msg === 'bad-address') return tr('send.badAddress');
    if (msg === 'bad-label') return tr('send.needLabel');
    return tr('send.badAddress');
  };

  const addEntry = async () => {
    setBookErr(null);
    try {
      await addressBookStore.add(newLabel, newAddress);
      setNewLabel('');
      setNewAddress('');
      setBook(addressBookStore.list());
    } catch (e) {
      setBookErr(bookErrorText(e, newAddress));
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBookErr(null);
    try {
      await addressBookStore.update(editing, editLabel);
      setEditing(null);
      setBook(addressBookStore.list());
    } catch (e) {
      setBookErr(bookErrorText(e, editing));
    }
  };

  const saveAfterSend = async () => {
    if (!recipientNorm) return;
    setSaveErr(null);
    try {
      await addressBookStore.add(saveLabel, recipientNorm);
      setSavedFlag(true);
      setBook(addressBookStore.list());
    } catch (e) {
      setSaveErr(bookErrorText(e, recipientNorm));
    }
  };

  const reserve = asset ? gasReserve(asset, gasPriceEff) : 0n;
  const nativeSym = asset ? HS_CHAINS[asset.chain].nativeSymbol : '';
  const lowGas =
    !!asset &&
    amountRaw !== null &&
    (asset.kind === 'erc20'
      ? !gasAffordable(asset, nativeBalOf(asset.chain) ?? 0n, gasPriceEff)
      : (bal ?? 0n) - amountRaw < reserve);

  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <View
        style={[
          S.row,
          {
            paddingHorizontal: 16,
            paddingVertical: 10,
            justifyContent: 'space-between',
          },
        ]}
      >
        <Text style={S.h1}>{tr('send.title')}</Text>
        <Pressable onPress={onClose} style={S.ghostBtn}>
          <Text style={S.ghostBtnText}>{tr('common.close')}</Text>
        </Pressable>
      </View>

      <ScrollView
        style={S.screen}
        contentContainerStyle={[S.scrollPad, { paddingBottom: 32 + insets.bottom }]}
      >
        {phase === 'pick' ? (
          <>
            <Text style={S.h2}>{tr('send.pickAsset')}</Text>
            {SEND_CHAINS.map((chain) => (
              <View key={chain} style={{ marginTop: 16 }}>
                <Text style={[S.small, { fontWeight: '700' }]}>
                  {HS_CHAINS[chain].shortName}
                </Text>
                {SEND_ASSETS.filter((a) => a.chain === chain).map((a) => {
                  const b = balOf(a);
                  return (
                    <Pressable
                      key={a.id}
                      onPress={() => pickAsset(a)}
                      style={{
                        borderWidth: 1,
                        borderColor: '#eff3f4',
                        borderRadius: 14,
                        padding: 14,
                        marginTop: 8,
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <Text style={[S.body, { fontWeight: '700' }]}>
                        {a.symbol}
                      </Text>
                      <Text style={S.body}>
                        {b === null ? '—' : fmtBal(b, a.decimals)} {a.symbol}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </>
        ) : null}

        {phase === 'form' && asset ? (
          <>
            <Pressable onPress={() => setPhase('pick')}>
              <Text style={[S.small, { color: ACCENT, fontWeight: '700' }]}>
                {backArrow()} {asset.symbol} ({asset.chainLabel})
              </Text>
            </Pressable>

            <Text style={[S.h2, { marginTop: 18 }]}>{tr('send.to')}</Text>
            <Text style={[S.small, { marginTop: 4 }]}>
              {tr('send.sameAddress')}
            </Text>
            <TextInput
              style={[S.input, { marginTop: 10, fontFamily: MONO, fontSize: 13.5 }, LTR_TEXT, { textAlign: 'left' }]}
              value={recipient}
              onChangeText={setRecipient}
              placeholder="0x…"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {recipientBad ? (
              <Text style={[S.err, { marginTop: 6 }]}>
                {tr('send.badAddress')}
              </Text>
            ) : null}
            {matchedEntry ? (
              <Text style={[S.small, { marginTop: 6 }]}>
                📖 {matchedEntry.label}
              </Text>
            ) : null}
            <View style={[S.row, { gap: 10, marginTop: 10 }]}>
              <Pressable
                style={[S.ghostBtn, { flex: 1 }]}
                onPress={async () => {
                  const t = await Clipboard.getStringAsync();
                  if (t) setRecipient(t.trim());
                }}
              >
                <Text style={S.ghostBtnText}>{tr('send.paste')}</Text>
              </Pressable>
              <Pressable
                style={[S.ghostBtn, { flex: 1 }]}
                onPress={() => {
                  setBookErr(null);
                  setPhase('book');
                }}
              >
                <Text style={S.ghostBtnText}>{tr('send.book')}</Text>
              </Pressable>
            </View>
            {book.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginTop: 10 }}
              >
                <View style={[S.row, { gap: 8 }]}>
                  {book.map((e) => (
                    <Pressable
                      key={e.address}
                      onPress={() => setRecipient(e.address)}
                      style={{
                        backgroundColor: '#eff3f4',
                        borderRadius: 999,
                        paddingHorizontal: 12,
                        paddingVertical: 7,
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '600' }}>
                        {e.label} · {shortAddr(e.address)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
            ) : null}

            <Text style={[S.h2, { marginTop: 22 }]}>{tr('send.amount')}</Text>
            <Text style={[S.small, { marginTop: 4 }]}>
              {bal === null ? '—' : fmtBal(bal, asset.decimals)} {asset.symbol}
            </Text>
            <TextInput
              style={[S.input, { marginTop: 10 }]}
              value={amountText}
              onChangeText={(t) =>
                setAmountText(t.replace(/[^0-9.]/g, ''))
              }
              placeholder="0.0"
              keyboardType="decimal-pad"
            />
            <View style={[S.row, { gap: 8, marginTop: 10 }]}>
              {[25, 50, 75, 100].map((pct) => (
                <Pressable
                  key={pct}
                  onPress={() => setChip(pct)}
                  style={{
                    flex: 1,
                    backgroundColor: '#eff3f4',
                    borderRadius: 999,
                    paddingVertical: 8,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ fontSize: 13.5, fontWeight: '600' }}>
                    {pct === 100 ? 'MAX' : pct + '%'}
                  </Text>
                </Pressable>
              ))}
            </View>
            {overBalance ? (
              <Text style={[S.err, { marginTop: 8 }]}>
                {tr('send.over')}
              </Text>
            ) : null}

            <Pressable
              style={[S.bigBtn, { marginTop: 24 }, !formValid && S.disabled]}
              disabled={!formValid}
              onPress={() => setPhase('confirm')}
            >
              <Text style={S.bigBtnText}>{tr('hs.next')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'book' ? (
          <>
            <Pressable onPress={() => setPhase('form')}>
              <Text style={[S.small, { color: ACCENT, fontWeight: '700' }]}>
                {backArrow()} {tr('common.back')}
              </Text>
            </Pressable>
            <Text style={[S.h2, { marginTop: 14 }]}>{tr('send.book')}</Text>
            {book.length === 0 ? (
              <Text style={[S.small, { marginTop: 10 }]}>
                {tr('send.bookEmpty')}
              </Text>
            ) : null}
            {book.map((e) => (
              <View
                key={e.address}
                style={{
                  borderWidth: 1,
                  borderColor: '#eff3f4',
                  borderRadius: 14,
                  padding: 12,
                  marginTop: 10,
                }}
              >
                <Pressable onPress={() => {
                  setRecipient(e.address);
                  setPhase('form');
                }}>
                  <Text style={[S.body, { fontWeight: '700' }]}>{e.label}</Text>
                  <Text
                    style={{
                      fontFamily: MONO,
                      fontSize: 12,
                      color: '#536471',
                      marginTop: 2,
                    }}
                  >
                    {e.address}
                  </Text>
                </Pressable>
                {editing === e.address ? (
                  <View style={{ marginTop: 10 }}>
                    <TextInput
                      style={S.input}
                      value={editLabel}
                      onChangeText={setEditLabel}
                      placeholder={tr('send.labelPh')}
                    />
                    <Pressable
                      style={[S.darkBtn, { marginTop: 8 }]}
                      onPress={saveEdit}
                    >
                      <Text style={S.darkBtnText}>{tr('send.save')}</Text>
                    </Pressable>
                  </View>
                ) : (
                  <View style={[S.row, { gap: 8, marginTop: 10 }]}>
                    <Pressable
                      style={[S.ghostBtn, { flex: 1 }]}
                      onPress={() => {
                        setEditing(e.address);
                        setEditLabel(e.label);
                        setBookErr(null);
                      }}
                    >
                      <Text style={S.ghostBtnText}>{tr('send.edit')}</Text>
                    </Pressable>
                    <Pressable
                      style={[S.ghostBtn, { flex: 1 }]}
                      onPress={() => setPendingDelete(e)}
                    >
                      <Text style={S.ghostBtnText}>{tr('send.delete')}</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ))}
            {bookErr ? (
              <Text style={[S.err, { marginTop: 10 }]}>{bookErr}</Text>
            ) : null}

            <Text style={[S.h2, { marginTop: 22 }]}>{tr('send.bookAdd')}</Text>
            <TextInput
              style={[S.input, { marginTop: 10 }]}
              value={newLabel}
              onChangeText={setNewLabel}
              placeholder={tr('send.labelPh')}
            />
            <TextInput
              style={[
                S.input,
                { marginTop: 10, fontFamily: MONO, fontSize: 13.5 },
              ]}
              value={newAddress}
              onChangeText={setNewAddress}
              placeholder="0x…"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              style={[S.darkBtn, { marginTop: 12 }]}
              onPress={addEntry}
            >
              <Text style={S.darkBtnText}>{tr('send.bookAdd')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'confirm' && asset && recipientNorm && amountRaw !== null ? (
          <>
            <Text style={S.h2}>{tr('send.confirmTitle')}</Text>
            <View style={{ marginTop: 14, gap: 10 }}>
              <View style={[S.row, { justifyContent: 'space-between' }]}>
                <Text style={S.small}>Chain</Text>
                <Text style={[S.body, { fontWeight: '700' }]}>
                  {asset.chainLabel}
                </Text>
              </View>
              <View style={[S.row, { justifyContent: 'space-between' }]}>
                <Text style={S.small}>{tr('send.amount')}</Text>
                <Text style={[S.body, { fontWeight: '700' }]}>
                  {fmtBal(amountRaw, asset.decimals)} {asset.symbol}
                </Text>
              </View>
              <View>
                <Text style={S.small}>{tr('send.to')}</Text>
                <Text
                  selectable
                  style={{
                    fontFamily: MONO,
                    fontSize: 13,
                    color: '#0f1419',
                    marginTop: 4,
                    writingDirection: 'ltr',
                    textAlign: 'left',
                  }}
                >
                  {recipientNorm}
                </Text>
                {matchedEntry ? (
                  <Text style={[S.small, { marginTop: 4 }]}>
                    📖 {matchedEntry.label}
                  </Text>
                ) : null}
              </View>
              <View style={[S.row, { justifyContent: 'space-between' }]}>
                <Text style={S.small}>{tr('send.gas')}</Text>
                <Text style={S.body}>
                  {fmtBal(reserve, 18)} {nativeSym}
                </Text>
              </View>
            </View>
            {lowGas ? (
              <Text style={[S.err, { marginTop: 12 }]}>
                {tr('send.lowGas', { sym: nativeSym })}
              </Text>
            ) : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 24 }, sending && S.disabled]}
              disabled={sending}
              onPress={doSend}
            >
              <Text style={S.bigBtnText}>
                {sending ? tr('send.sending') : tr('send.title')}
              </Text>
            </Pressable>
            <Pressable
              style={[S.ghostBtn, { marginTop: 10 }]}
              disabled={sending}
              onPress={() => setPhase('form')}
            >
              <Text style={S.ghostBtnText}>{tr('common.back')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'done' ? (
          <>
            <Text style={[S.h1, { color: '#1b7a43' }]}>{tr('send.sent')}</Text>
            {asset && amountRaw !== null ? (
              <Text style={[S.body, { marginTop: 10 }]}>
                {fmtBal(amountRaw, asset.decimals)} {asset.symbol} {forwardArrow()}{' '}
                {recipientNorm ? shortAddr(recipientNorm) : ''}
              </Text>
            ) : null}
            {txHash ? (
              <View style={{ marginTop: 16 }}>
                <Text style={S.small}>{tr('send.hash')}</Text>
                <Text
                  selectable
                  style={{
                    fontFamily: MONO,
                    fontSize: 12,
                    color: '#0f1419',
                    marginTop: 4,
                    writingDirection: 'ltr',
                    textAlign: 'left',
                  }}
                >
                  {txHash}
                </Text>
                <Pressable
                  style={[S.ghostBtn, { marginTop: 10 }]}
                  onPress={async () => {
                    await Clipboard.setStringAsync(txHash);
                    setCopiedHash(true);
                    setTimeout(() => setCopiedHash(false), 2000);
                  }}
                >
                  <Text style={S.ghostBtnText}>
                    {copiedHash ? tr('settings.copied') : tr('settings.copy')}
                  </Text>
                </Pressable>
              </View>
            ) : null}
            {recipientNorm && !matchedEntry && !savedFlag ? (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: '#eff3f4',
                  borderRadius: 14,
                  padding: 14,
                  marginTop: 22,
                }}
              >
                <Text style={S.body}>{tr('send.saveOffer')}</Text>
                <Text
                  style={{
                    fontFamily: MONO,
                    fontSize: 12,
                    color: '#536471',
                    marginTop: 4,
                  }}
                >
                  {recipientNorm}
                </Text>
                <TextInput
                  style={[S.input, { marginTop: 10 }]}
                  value={saveLabel}
                  onChangeText={setSaveLabel}
                  placeholder={tr('send.labelPh')}
                />
                {saveErr ? (
                  <Text style={[S.err, { marginTop: 8 }]}>{saveErr}</Text>
                ) : null}
                <Pressable
                  style={[S.darkBtn, { marginTop: 10 }]}
                  onPress={saveAfterSend}
                >
                  <Text style={S.darkBtnText}>{tr('send.save')}</Text>
                </Pressable>
              </View>
            ) : null}
            {savedFlag ? (
              <Text style={[S.ok, { marginTop: 16 }]}>{tr('send.saved')}</Text>
            ) : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 24 }]}
              onPress={onClose}
            >
              <Text style={S.bigBtnText}>{tr('common.close')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'failed' ? (
          <>
            <Text style={S.err}>{tr('send.failed')}</Text>
            <Pressable
              style={[S.bigBtn, { marginTop: 20 }]}
              onPress={() => setPhase('form')}
            >
              <Text style={S.bigBtnText}>{tr('common.back')}</Text>
            </Pressable>
          </>
        ) : null}

        {phase === 'unconfirmed' ? (
          <>
            <Text style={S.body}>{tr('hs.unconfirmed')}</Text>
            {txHash ? (
              <Text
                selectable
                style={{
                  fontFamily: MONO,
                  fontSize: 12,
                  color: '#536471',
                  marginTop: 10,
                  writingDirection: 'ltr',
                  textAlign: 'left',
                }}
              >
                {txHash}
              </Text>
            ) : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 20 }]}
              onPress={onClose}
            >
              <Text style={S.bigBtnText}>{tr('common.close')}</Text>
            </Pressable>
          </>
        ) : null}

        {sending && phase === 'confirm' ? (
          <ActivityIndicator color={ACCENT} style={{ marginTop: 16 }} />
        ) : null}
      </ScrollView>

      <ConfirmSheet
        visible={pendingDelete !== null}
        title={pendingDelete ? pendingDelete.label : ''}
        confirmLabel={tr('send.delete')}
        cancelLabel={tr('settings.cancel')}
        onConfirm={async () => {
          if (pendingDelete) {
            await addressBookStore.remove(pendingDelete.address);
            setBook(addressBookStore.list());
          }
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </View>
  );
}
