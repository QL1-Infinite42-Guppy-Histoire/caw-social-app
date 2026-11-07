import React, { useEffect, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Avatar, ConfirmSheet, S } from '../components/ui';
import { CAW_NAME, QCAW, SEL } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import { clearNameCaches, followerCount, qcawAllowance } from '../lib/cawApi';
import {
  encAddr,
  fmtAmount,
  parseAmount,
  word,
  type NameToken,
} from '../lib/cawCore';
import { sendCalldata, signerFor } from '../lib/wallet';

type PendingAction = 'deposit' | 'withdraw';

interface CardStatus {
  text: string;
  kind: 'info' | 'ok' | 'err';
}

function NameCard({ token }: { token: NameToken }) {
  const app = useApp();
  const [amount, setAmount] = useState('');
  const [followers, setFollowers] = useState<bigint | null>(null);
  const [status, setStatus] = useState<CardStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pendingAmt, setPendingAmt] = useState<bigint | null>(null);

  useEffect(() => {
    let live = true;
    followerCount(token.id)
      .then((n) => {
        if (live) setFollowers(n);
      })
      .catch(() => {
        /* follower count is optional — omit it when the read fails */
      });
    return () => {
      live = false;
    };
  }, [token.id]);

  const ask = (action: PendingAction) => {
    const amt = parseAmount(amount);
    if (amt === null || amt <= 0n) {
      setStatus({ text: tr('mine.badAmount'), kind: 'err' });
      return;
    }
    setStatus(null);
    setPendingAmt(amt);
    setPending(action);
  };

  const afterSuccess = async () => {
    setStatus({ text: tr('mine.done'), kind: 'ok' });
    setPending(null);
    setPendingAmt(null);
    setAmount('');
    clearNameCaches();
    await app.refreshMyTokens();
    await app.refreshBalances();
  };

  const doDeposit = async () => {
    if (pendingAmt === null) return;
    const amt = pendingAmt;
    setBusy(true);
    setStatus({ text: tr('mine.sending'), kind: 'info' });
    try {
      const ok = await app.requireAuth();
      if (!ok) {
        setStatus(null);
        setPending(null);
        return;
      }
      const sec = app.getSecret();
      if (!sec) throw new Error('no secret');
      const signer = signerFor(sec.kind, sec.secret);
      // The name contract pulls qCAW in, so it needs an allowance first.
      if (app.address) {
        const allow = await qcawAllowance(app.address, CAW_NAME);
        if (allow < amt) {
          setStatus({ text: tr('mine.approveFirst'), kind: 'info' });
          await sendCalldata(
            signer,
            QCAW,
            SEL.approve + encAddr(CAW_NAME) + word(amt),
          );
        }
      }
      setStatus({ text: tr('mine.waiting'), kind: 'info' });
      await sendCalldata(
        signer,
        CAW_NAME,
        SEL.deposit + word(token.id) + word(amt),
      );
      await afterSuccess();
    } catch {
      setStatus({ text: tr('mine.failed'), kind: 'err' });
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const doWithdraw = async () => {
    if (pendingAmt === null) return;
    const amt = pendingAmt;
    setBusy(true);
    setStatus({ text: tr('mine.sending'), kind: 'info' });
    try {
      const ok = await app.requireAuth();
      if (!ok) {
        setStatus(null);
        setPending(null);
        return;
      }
      const sec = app.getSecret();
      if (!sec) throw new Error('no secret');
      const signer = signerFor(sec.kind, sec.secret);
      setStatus({ text: tr('mine.waiting'), kind: 'info' });
      await sendCalldata(
        signer,
        CAW_NAME,
        SEL.withdraw + word(token.id) + word(amt),
      );
      await afterSuccess();
    } catch {
      setStatus({ text: tr('mine.failed'), kind: 'err' });
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const custom = app.customFor(token.id);
  return (
    <View style={styles.card}>
      <View style={S.row}>
        <Avatar
          nameId={token.id}
          size={48}
          customUri={custom ? custom.avatarPath : undefined}
          onPress={
            token.username ? () => app.openProfile(token.username) : undefined
          }
        />
        <View style={{ marginLeft: 12, flex: 1 }}>
          <Text style={styles.name}>
            {custom && custom.displayName
              ? custom.displayName
              : token.username
                ? '@' + token.username
                : '#' + token.id.toString()}
          </Text>
          {custom && custom.displayName && token.username ? (
            <Text style={S.small}>@{token.username}</Text>
          ) : null}
          <Text style={S.small}>
            #{token.id.toString()}
            {followers !== null
              ? ' · ' + followers.toString() + ' ' + tr('mine.followers')
              : ''}
          </Text>
        </View>
      </View>

      <Text style={[S.body, { marginTop: 12 }]}>
        {tr('mine.inName')}:{' '}
        <Text style={{ fontWeight: '700' }}>{fmtAmount(token.balance)}</Text>{' '}
        qCAW
      </Text>

      <TextInput
        style={[S.input, { marginTop: 12 }]}
        value={amount}
        onChangeText={setAmount}
        placeholder={tr('mine.amountPh')}
        keyboardType="decimal-pad"
        autoCorrect={false}
      />
      <View style={[S.row, { marginTop: 10, gap: 10 }]}>
        <Pressable
          style={[S.darkBtn, { flex: 1 }, busy && S.disabled]}
          disabled={busy}
          onPress={() => ask('deposit')}
        >
          <Text style={S.darkBtnText}>{tr('mine.deposit')}</Text>
        </Pressable>
        <Pressable
          style={[S.ghostBtn, { flex: 1 }, busy && S.disabled]}
          disabled={busy}
          onPress={() => ask('withdraw')}
        >
          <Text style={S.ghostBtnText}>{tr('mine.withdraw')}</Text>
        </Pressable>
      </View>

      {status ? (
        <Text
          style={[
            status.kind === 'err'
              ? S.err
              : status.kind === 'ok'
                ? S.ok
                : S.small,
            { marginTop: 10 },
          ]}
        >
          {status.text}
        </Text>
      ) : null}

      <ConfirmSheet
        visible={pending !== null && pendingAmt !== null}
        title={
          pending === 'deposit'
            ? tr('mine.confirmDeposit', {
                amount: fmtAmount(pendingAmt ?? 0n),
                name: token.username,
              })
            : tr('mine.confirmWithdraw', {
                amount: fmtAmount(pendingAmt ?? 0n),
                name: token.username,
              })
        }
        confirmLabel={
          pending === 'deposit' ? tr('mine.deposit') : tr('mine.withdraw')
        }
        cancelLabel={tr('settings.cancel')}
        onConfirm={pending === 'deposit' ? doDeposit : doWithdraw}
        onCancel={() => {
          if (!busy) setPending(null);
        }}
        busy={busy}
      />
    </View>
  );
}

export default function MyNamesScreen() {
  const app = useApp();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    app.refreshMyTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      clearNameCaches();
      await app.refreshMyTokens();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <ScrollView
      style={S.screen}
      contentContainerStyle={S.scrollPad}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      <Text style={S.h1}>{tr('mine.title')}</Text>
      <View style={styles.card}>
        <Text style={S.body}>
          qCAW: <Text style={{ fontWeight: '700' }}>{app.qcaw !== null ? fmtAmount(app.qcaw) : '…'}</Text>
        </Text>
        {/* v0.3.2: the big buy button is gone — HuntersSwap now
            opens from the orange button in the middle of the tab
            bar. The qCAW balance line above stays. */}
      </View>
      {app.myTokens.length === 0 ? (
        <Text style={[S.body, { marginTop: 14 }]}>{tr('mine.none')}</Text>
      ) : (
        app.myTokens.map((t) => (
          <NameCard key={t.id.toString()} token={t} />
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: '#eff3f4',
    borderRadius: 14,
    padding: 14,
    marginTop: 14,
    backgroundColor: '#fff',
  },
  name: { fontSize: 16, fontWeight: '700', color: '#0f1419' },
});
