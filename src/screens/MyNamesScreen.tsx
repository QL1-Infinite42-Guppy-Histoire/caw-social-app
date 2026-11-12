import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Avatar, ConfirmSheet, S } from '../components/ui';
import { expandChevron } from '../lib/rtl';
import { ACCENT, CAW_NAME, QCAW, SEL } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import { clearNameCaches, followerCount, qcawAllowance } from '../lib/cawApi';
import {
  encAddr,
  fmtAmount,
  fmtCardDisplay,
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

function NameCard({
  token,
  expanded,
  onToggle,
  onBusyChange,
}: {
  token: NameToken;
  expanded: boolean;
  onToggle: () => void;
  onBusyChange: (id: string, busy: boolean) => void;
}) {
  const app = useApp();
  const [amount, setAmount] = useState('');
  const [followers, setFollowers] = useState<bigint | null>(null);
  const [status, setStatus] = useState<CardStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pendingAmt, setPendingAmt] = useState<bigint | null>(null);

  // The parent keeps a busy name's row expanded (its progress
  // display must stay visible), so report busy changes upward.
  useEffect(() => {
    onBusyChange(token.id.toString(), busy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

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
      // The name contract pulls CAW in, so it needs an allowance first.
      if (app.address) {
        const allow = await qcawAllowance(app.address, CAW_NAME);
        // L1: an unreadable allowance is null (unknown), not
        // 0 — the honest response is to approve the exact
        // amount anyway (harmless if already covered; the
        // deposit send below surfaces any real failure).
        if (allow === null || allow < amt) {
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
    <View style={styles.nameRow}>
      {/* Compact row (v0.3.7): one line per name — avatar, name +
       * handle/#id/followers, deposited CAW + chevron on the
       * right. Tapping toggles the deposit/withdraw controls
       * below (accordion). */}
      <Pressable
        onPress={onToggle}
        style={({ pressed }) => [styles.rowHead, pressed && { opacity: 0.6 }]}
        accessibilityRole="button"
      >
        <Avatar
          nameId={token.id}
          size={40}
          customUri={custom ? custom.avatarPath : undefined}
          onPress={
            token.username ? () => app.openProfile(token.username) : undefined
          }
        />
        <View style={{ marginStart: 10, flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {custom && custom.displayName
              ? custom.displayName
              : token.username
                ? '@' + token.username
                : '#' + token.id.toString()}
          </Text>
          <Text style={S.small} numberOfLines={1}>
            {custom && custom.displayName && token.username
              ? '@' + token.username + ' · '
              : ''}
            #{token.id.toString()}
            {followers !== null
              ? ' · ' + followers.toString() + ' ' + tr('mine.followers')
              : ''}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end', marginStart: 8 }}>
          <Text
            style={styles.rowAmount}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
          >
            {fmtCardDisplay(token.balance, 18).text}
            <Text style={styles.rowUnit}> CAW</Text>
          </Text>
          <Text style={S.tiny}>{tr('mine.inName')}</Text>
        </View>
        <Text style={styles.chevron}>{expandChevron(expanded)}</Text>
      </Pressable>

      {/* Posting-name switch (v0.4.5 refresh): this screen is
       * where the active name is chosen. The active name wears
       * a visible badge; every other name gets one clear,
       * deliberate button. It calls the same chooseActing the
       * composer uses, so the posting identity changes in
       * exactly the same way. */}
      {(app.actingId ?? app.myTokens[0]?.id ?? null) === token.id ? (
        <View style={styles.actingRow}>
          <Text style={styles.actingBadge}>{tr('mine.active')}</Text>
        </View>
      ) : (
        <Pressable
          style={({ pressed }) => [
            styles.useBtn,
            pressed && { opacity: 0.7 },
          ]}
          onPress={() => app.chooseActing(token.id)}
          accessibilityRole="button"
        >
          <Text style={styles.useBtnText}>{tr('mine.useBtn')}</Text>
        </Pressable>
      )}

      {expanded ? (
        <View style={styles.expanded}>
          <TextInput
            style={S.input}
            value={amount}
            onChangeText={setAmount}
            placeholder={tr('mine.amountPh')}
            keyboardType="decimal-pad"
            autoCorrect={false}
          />
          <View style={[S.row, { marginTop: 10, gap: 10 }]}>
            <Pressable
              style={[S.bigBtn, { flex: 1, minHeight: 44 }, busy && S.disabled]}
              disabled={busy}
              onPress={() => ask('deposit')}
            >
              <Text style={S.bigBtnText}>{tr('mine.deposit')}</Text>
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
        </View>
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
  /* Accordion state (v0.3.7): one name open at a time — except a
   * name with a deposit/withdraw in flight, which always stays
   * open so its progress remains visible. */
  const [openSet, setOpenSet] = useState<ReadonlySet<string>>(new Set());
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const onBusyChange = (id: string, busy: boolean) => {
    setBusyIds((prev) => {
      if (prev.has(id) === busy) return prev;
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
    if (busy) {
      setOpenSet((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    }
  };
  const toggle = (id: string) => {
    setOpenSet((prev) => {
      const next = new Set<string>();
      busyIds.forEach((b) => next.add(b));
      if (!prev.has(id) || busyIds.has(id)) next.add(id);
      return next;
    });
  };
  const totalInNames = app.myTokens.reduce((s, t) => s + t.balance, 0n);

  useEffect(() => {
    app.refreshMyTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* One-shot focus hand-off (v0.4.6): the Home wallet card's
   * Deposit button lands here with the active name's controls
   * already open — this screen's existing deposit flow, not a
   * second copy. The id enters the open set even before the
   * token paints (enumeration is progressive) and `expanded`
   * is derived from the set, so the card opens the moment it
   * renders. Consumed once; a later plain visit opens nothing. */
  useEffect(() => {
    const f = app.mineFocusId;
    if (f !== null) {
      setOpenSet(new Set([f.toString()]));
      app.clearMineFocus();
    }
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
      contentContainerStyle={{ paddingBottom: 32 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      {/* v0.6.1: the duplicated screen title is gone (the hub
          back row already names this section); the balance
          lines sit flat above the list, amounts abbreviated
          (fmtCardDisplay — no raw 99,929,339.38 strings). */}
      <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
        <Text style={S.body}>
          CAW: <Text style={{ fontWeight: '700' }}>{app.qcaw !== null ? fmtCardDisplay(app.qcaw, 18).text : '…'}</Text>
        </Text>
        {app.myTokens.length > 0 ? (
          <Text style={[S.small, { marginTop: 6 }]}>
            {tr('mine.summary', {
              count: String(app.myTokens.length),
              total: fmtCardDisplay(totalInNames, 18).text,
            })}
          </Text>
        ) : null}
      </View>
      {app.myTokens.length === 0 && !app.myTokensReady ? (
        /* Still reading (v0.4.5): an empty list here means the
         * enumeration has not finished — show progress, never
         * the "no names" verdict. Placeholder rows keep the wait
         * shaped like the list that is coming. */
        <View style={{ marginTop: 14, alignItems: 'center' }}>
          <ActivityIndicator color={ACCENT} />
          <Text style={[S.small, { marginTop: 10 }]}>
            {tr('mine.loading')}
          </Text>
          <View style={{ alignSelf: 'stretch', marginTop: 6 }}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={styles.skeletonRow}>
                <View style={styles.skeletonCircle} />
                <View style={{ flex: 1, marginStart: 10, gap: 6 }}>
                  <View style={[styles.skeletonBar, { width: '45%' }]} />
                  <View style={[styles.skeletonBar, { width: '70%' }]} />
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : app.myTokens.length === 0 ? (
        <Text style={[S.body, { marginTop: 14, paddingHorizontal: 16 }]}>{tr('mine.none')}</Text>
      ) : (
        app.myTokens.map((t) => (
          <NameCard
            key={t.id.toString()}
            token={t}
            expanded={openSet.has(t.id.toString())}
            onToggle={() => toggle(t.id.toString())}
            onBusyChange={onBusyChange}
          />
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  actingRow: { marginTop: 8, marginBottom: 12, marginStart: 16, alignItems: 'flex-start' },
  actingBadge: {
    backgroundColor: ACCENT,
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
  },
  useBtn: {
    marginTop: 8,
    marginBottom: 12,
    marginStart: 16,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: ACCENT,
    borderRadius: 999,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  useBtnText: { color: ACCENT, fontSize: 13.5, fontWeight: '800' },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
  },
  skeletonCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#eff3f4',
  },
  skeletonBar: { height: 10, borderRadius: 5, backgroundColor: '#eff3f4' },
  /* Flat X-style rows (v0.6.1): hairline dividers instead of
   * bordered cards; the row owns its horizontal padding so
   * the list runs edge to edge. */
  nameRow: {
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
    backgroundColor: '#fff',
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  expanded: {
    borderTopWidth: 1,
    borderTopColor: '#eff3f4',
    paddingTop: 12,
    paddingBottom: 10,
    paddingHorizontal: 16,
    marginTop: 2,
  },
  name: { fontSize: 15, fontWeight: '700', color: '#0f1419' },
  rowAmount: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f1419',
    fontVariant: ['tabular-nums'],
  },
  rowUnit: { fontSize: 11, fontWeight: '600', color: '#536471' },
  chevron: { fontSize: 15, color: '#536471', marginStart: 8, width: 16, textAlign: 'center' },
});
