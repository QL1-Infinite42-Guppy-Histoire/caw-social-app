import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ConfirmSheet, S } from '../components/ui';
import { MINTER, QCAW, SEL } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import {
  checkName,
  clearNameCaches,
  qcawAllowance,
  qcawBalance,
} from '../lib/cawApi';
import { encAddr, encStr, fmtAmount, word } from '../lib/cawCore';
import { HuntersSwapModal } from './HuntersSwapScreen';
import { sendCalldata, signerFor } from '../lib/wallet';

type CheckState =
  | { kind: 'invalid' }
  | { kind: 'taken' }
  | { kind: 'available'; cost: bigint };

type StatusTone = 'info' | 'ok' | 'err';
interface Status {
  text: string;
  tone: StatusTone;
}

export default function GetNameScreen() {
  const app = useApp();
  const [input, setInput] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkedName, setCheckedName] = useState('');
  const [check, setCheck] = useState<CheckState | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'approve' | 'mint' | null>(null);
  const [hsOpen, setHsOpen] = useState(false);

  const cost = check && check.kind === 'available' ? check.cost : null;
  // Freshly read balance wins; fall back to the context balance.
  const shownBalance = balance !== null ? balance : app.qcaw;
  const notEnough =
    cost !== null && shownBalance !== null && shownBalance < cost;
  const needsApprove =
    cost !== null && (allowance === null || allowance < cost);

  const onChangeInput = (t: string) => {
    setInput(t.toLowerCase());
    // A new (partial) name invalidates the previous check result.
    setCheck(null);
    setCheckedName('');
    setBalance(null);
    setAllowance(null);
    setStatus(null);
    setConfirm(null);
  };

  const doCheck = async () => {
    const name = input.trim().toLowerCase();
    setStatus(null);
    setCheck(null);
    setCheckedName('');
    setBalance(null);
    setAllowance(null);
    if (!name) {
      setCheck({ kind: 'invalid' });
      return;
    }
    setChecking(true);
    try {
      const r = await checkName(name);
      setCheckedName(name);
      if (!r.valid) {
        setCheck({ kind: 'invalid' });
        return;
      }
      if (r.taken) {
        setCheck({ kind: 'taken' });
        return;
      }
      setCheck({ kind: 'available', cost: r.cost });
      if (app.address) {
        const [bal, allow] = await Promise.all([
          qcawBalance(app.address),
          qcawAllowance(app.address, MINTER),
        ]);
        setBalance(bal);
        setAllowance(allow);
      }
    } catch {
      setCheck(null);
      setStatus({ text: tr('get.checkFail'), tone: 'err' });
    } finally {
      setChecking(false);
    }
  };

  const doApprove = async () => {
    if (cost === null) return;
    setBusy(true);
    setStatus({ text: tr('get.sending'), tone: 'info' });
    try {
      const ok = await app.requireAuth();
      if (!ok) {
        setStatus(null);
        setConfirm(null);
        return;
      }
      const sec = app.getSecret();
      if (!sec) throw new Error('no secret');
      const signer = signerFor(sec.kind, sec.secret);
      setStatus({ text: tr('get.waiting'), tone: 'info' });
      await sendCalldata(
        signer,
        QCAW,
        SEL.approve + encAddr(MINTER) + word(cost),
      );
      // Re-read the allowance so the screen moves on to step 2.
      if (app.address) {
        const [allow, bal] = await Promise.all([
          qcawAllowance(app.address, MINTER),
          qcawBalance(app.address),
        ]);
        setAllowance(allow);
        setBalance(bal);
      }
      setStatus({ text: tr('get.done'), tone: 'ok' });
      setConfirm(null);
    } catch {
      setStatus({ text: tr('get.failed'), tone: 'err' });
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const doMint = async () => {
    if (cost === null || !checkedName) return;
    setBusy(true);
    setStatus({ text: tr('get.sending'), tone: 'info' });
    try {
      const ok = await app.requireAuth();
      if (!ok) {
        setStatus(null);
        setConfirm(null);
        return;
      }
      const sec = app.getSecret();
      if (!sec) throw new Error('no secret');
      const signer = signerFor(sec.kind, sec.secret);
      setStatus({ text: tr('get.waiting'), tone: 'info' });
      await sendCalldata(signer, MINTER, SEL.mint + encStr(checkedName));
      setStatus({ text: tr('get.done'), tone: 'ok' });
      setConfirm(null);
      clearNameCaches();
      await app.refreshMyTokens();
      await app.refreshBalances();
    } catch {
      setStatus({ text: tr('get.failed'), tone: 'err' });
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const statusStyle =
    status?.tone === 'ok' ? S.ok : status?.tone === 'err' ? S.err : S.small;

  return (
    <ScrollView style={S.screen} contentContainerStyle={S.scrollPad}>
      <Text style={S.h1}>{tr('get.title')}</Text>
      <Text style={[S.body, { marginTop: 8 }]}>{tr('get.desc')}</Text>

      <View style={[S.row, { marginTop: 18, gap: 10 }]}>
        <TextInput
          style={[S.input, { flex: 1 }]}
          value={input}
          onChangeText={onChangeInput}
          placeholder={tr('get.ph')}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          returnKeyType="search"
          onSubmitEditing={doCheck}
        />
        <Pressable
          style={[S.darkBtn, (checking || busy) && S.disabled]}
          disabled={checking || busy}
          onPress={doCheck}
        >
          <Text style={S.darkBtnText}>{tr('get.check')}</Text>
        </Pressable>
      </View>

      {checking ? (
        <View style={[S.row, { marginTop: 14, gap: 8 }]}>
          <ActivityIndicator color="#536471" />
          <Text style={S.small}>{tr('get.checking')}</Text>
        </View>
      ) : null}

      {check?.kind === 'invalid' ? (
        <Text style={[S.err, { marginTop: 14 }]}>{tr('get.invalid')}</Text>
      ) : null}
      {check?.kind === 'taken' ? (
        <View style={{ marginTop: 14 }}>
          <Text style={[S.body, { color: '#a15c00' }]}>{tr('get.taken')}</Text>
          <Pressable
            style={[S.ghostBtn, { marginTop: 10, alignSelf: 'flex-start' }]}
            onPress={() => app.openProfile(checkedName)}
          >
            <Text style={S.ghostBtnText}>{tr('get.viewProfile')}</Text>
          </Pressable>
        </View>
      ) : null}

      {check?.kind === 'available' && cost !== null ? (
        <View style={{ marginTop: 14 }}>
          <Text style={S.ok}>{tr('get.available')}</Text>
          <Text style={[S.body, { marginTop: 6 }]}>
            {tr('get.price')}: <Text style={{ fontWeight: '700' }}>{fmtAmount(cost)}</Text>{' '}
            qCAW
          </Text>
          <Text style={[S.small, { marginTop: 10 }]}>
            {tr('get.yourQcaw')}:{' '}
            {shownBalance !== null ? fmtAmount(shownBalance) : '…'} qCAW
          </Text>

          {notEnough ? (
            <View style={{ marginTop: 10 }}>
              <Text style={S.err}>{tr('get.notEnough')}</Text>
              <Pressable
                style={[S.bigBtn, { marginTop: 12 }]}
                onPress={() => setHsOpen(true)}
              >
                <Text style={S.bigBtnText}>{tr('hs.buy')}</Text>
              </Pressable>
            </View>
          ) : needsApprove ? (
            <View style={{ marginTop: 12 }}>
              <Text style={S.body}>{tr('get.step1')}</Text>
              <Pressable
                style={[S.bigBtn, { marginTop: 12 }, busy && S.disabled]}
                disabled={busy}
                onPress={() => setConfirm('approve')}
              >
                <Text style={S.bigBtnText}>
                  {tr('get.approveBtn')} ({fmtAmount(cost)} qCAW)
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ marginTop: 12 }}>
              <Text style={S.body}>{tr('get.step2')}</Text>
              <Pressable
                style={[S.bigBtn, { marginTop: 12 }, busy && S.disabled]}
                disabled={busy}
                onPress={() => setConfirm('mint')}
              >
                <Text style={S.bigBtnText}>{tr('get.mintBtn')}</Text>
              </Pressable>
            </View>
          )}
        </View>
      ) : null}

      {status ? (
        <Text style={[statusStyle, { marginTop: 14 }]}>{status.text}</Text>
      ) : null}

      <ConfirmSheet
        visible={confirm !== null && cost !== null}
        title={
          confirm === 'approve'
            ? tr('get.confirmApprove', { amount: fmtAmount(cost ?? 0n) })
            : tr('get.confirmMint', {
                name: checkedName,
                amount: fmtAmount(cost ?? 0n),
              })
        }
        confirmLabel={
          confirm === 'approve' ? tr('get.approveBtn') : tr('get.mintBtn')
        }
        cancelLabel={tr('settings.cancel')}
        onConfirm={confirm === 'approve' ? doApprove : doMint}
        onCancel={() => {
          if (!busy) setConfirm(null);
        }}
        busy={busy}
      />
      <HuntersSwapModal visible={hsOpen} onClose={() => setHsOpen(false)} />
    </ScrollView>
  );
}
