/**
 * BurnHawk (v0.7.0) — the in-app HAWK burn screen.
 *
 * Burns QL1 HAWK through the PHOENIX contract's burnToMint
 * (100 HAWK → 1 PHOENIX), the same flow as the standalone
 * site hawk.qql1.com; the money rules live in lib/burnHawk.ts
 * and are unit-tested there. Opened from the drawer's
 * BurnHawk row (between HuntersDEX and ブックマーク).
 *
 * The send is two confirmed steps, each shown as it runs:
 *   1. HAWK approve(PHOENIX, amount) — only when the current
 *      allowance is short, for the exact burn amount;
 *   2. PHOENIX burnToMint(amount).
 * The amount is rounded DOWN to a multiple of 100 HAWK
 * before sending; the screen says so and previews both the
 * rounded burn amount and the PHOENIX received before the
 * user confirms. Balances come from the app context (the
 * same reads the wallet list shows) and refresh afterwards.
 */
import React, { useMemo, useState } from 'react';
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

import { ConfirmSheet, HAIRLINE, S } from '../components/ui';
import { ACCENT, HAWK, PHOENIX } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import { fmtAmountCardDec, parseAmount } from '../lib/cawCore';
import {
  allowanceCovers,
  buildApproveData,
  buildBurnToMintData,
  hawkAllowanceForPhoenix,
  receiveRawFor,
  roundDownBurnRaw,
} from '../lib/burnHawk';
import { TxUnconfirmedError } from '../lib/hunters';
import { sendTxReq, signerFor } from '../lib/wallet';

type Status = { text: string; tone: 'info' | 'ok' | 'err' } | null;

const CHIP_PCTS = [25, 50, 75, 100] as const;

export default function BurnHawkScreen({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const hawkDec = app.hawk ? app.hawk.decimals : 18;
  const phoenixDec = app.phoenix ? app.phoenix.decimals : 18;
  const hawkRaw = app.hawk ? app.hawk.raw : null;

  // parseAmount is the app's 18-decimal parser; HAWK and
  // PHOENIX are both 18-decimal tokens (read live above for
  // display and rounding).
  const parsed = useMemo(() => parseAmount(amount), [amount]);
  const effective = parsed !== null ? roundDownBurnRaw(parsed, hawkDec) : 0n;
  const receive = receiveRawFor(effective, hawkDec, phoenixDec);
  const over = parsed !== null && hawkRaw !== null && parsed > hawkRaw;
  const canBurn =
    !busy && parsed !== null && effective > 0n && !over && !!app.address;

  const setPct = (pct: number) => {
    if (hawkRaw === null) return;
    const part = (hawkRaw * BigInt(pct)) / 100n;
    // Show the amount in whole HAWK (the input is whole-token;
    // any raw remainder below one token is dust the burn
    // rounds away anyway).
    setAmount((part / 10n ** BigInt(hawkDec)).toString());
    setStatus(null);
  };

  const doBurn = async () => {
    if (!canBurn || !app.address) return;
    setConfirming(false);
    setBusy(true);
    try {
      const ok = await app.requireAuth();
      if (!ok) {
        setStatus(null);
        return;
      }
      const sec = app.getSecret();
      if (!sec) throw new Error('no secret');
      const signer = signerFor(sec.kind, sec.secret);
      const allowance = await hawkAllowanceForPhoenix(app.address);
      if (!allowanceCovers(allowance, effective)) {
        setStatus({ text: tr('bh.stepApprove'), tone: 'info' });
        await sendTxReq(signer, {
          to: HAWK,
          data: buildApproveData(PHOENIX, effective),
          value: 0n,
        });
      }
      setStatus({ text: tr('bh.stepBurn'), tone: 'info' });
      await sendTxReq(signer, {
        to: PHOENIX,
        data: buildBurnToMintData(effective),
        value: 0n,
      });
      setStatus({ text: tr('bh.done'), tone: 'ok' });
      setAmount('');
      app.refreshBalances().catch(() => {});
    } catch (e) {
      if (e instanceof TxUnconfirmedError) {
        setStatus({ text: tr('hs.unconfirmed'), tone: 'err' });
      } else {
        setStatus({ text: tr('bh.failed'), tone: 'err' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 12,
          borderBottomWidth: 1,
          borderBottomColor: HAIRLINE,
        }}
      >
        <Text
          style={{ fontSize: 22, fontWeight: '800', color: '#0f1419', letterSpacing: 0.2 }}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
        >
          Burn<Text style={{ color: ACCENT }}>Hawk</Text>
        </Text>
        <View style={[S.row, { gap: 8, marginTop: 10 }]}>
          <Pressable
            onPress={onClose}
            style={{
              backgroundColor: '#eff3f4',
              borderRadius: 999,
              paddingHorizontal: 14,
              paddingVertical: 8,
            }}
          >
            <Text style={{ color: '#0f1419', fontSize: 14, fontWeight: '600' }}>
              {tr('common.close')}
            </Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={S.screen}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 + insets.bottom }}
      >
        <Text style={S.body}>{tr('bh.intro')}</Text>
        <Text style={[S.small, { marginTop: 12 }]}>
          {tr('bh.balanceHawk', {
            balance: app.hawk ? fmtAmountCardDec(app.hawk.raw, hawkDec) : '—',
          })}
        </Text>
        <Text style={[S.small, { marginTop: 4 }]}>
          {tr('bh.balancePhoenix', {
            balance: app.phoenix
              ? fmtAmountCardDec(app.phoenix.raw, phoenixDec)
              : '—',
          })}
        </Text>

        <Text style={[S.small, { marginTop: 20 }]}>{tr('send.amount')}</Text>
        <View style={[S.row, { marginTop: 8, gap: 8 }]}>
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
          <Text style={[S.body, { fontWeight: '700' }]}>HAWK</Text>
        </View>
        <View style={[S.row, { marginTop: 10, gap: 8 }]}>
          {CHIP_PCTS.map((pct) => (
            <Pressable
              key={pct}
              onPress={() => setPct(pct)}
              disabled={busy || hawkRaw === null}
              style={{
                backgroundColor: '#eff3f4',
                borderRadius: 999,
                paddingHorizontal: 14,
                paddingVertical: 7,
                opacity: busy || hawkRaw === null ? 0.5 : 1,
              }}
            >
              <Text style={{ color: '#0f1419', fontSize: 13.5, fontWeight: '700' }}>
                {pct === 100 ? 'MAX' : pct + '%'}
              </Text>
            </Pressable>
          ))}
        </View>

        {parsed !== null && parsed > 0n && effective === 0n ? (
          <Text style={[S.err, { marginTop: 12 }]}>{tr('bh.minNote')}</Text>
        ) : null}
        {parsed !== null && effective > 0n && effective !== parsed ? (
          <Text style={[S.small, { marginTop: 12 }]}>
            {tr('bh.roundNote')}{' '}
            {fmtAmountCardDec(effective, hawkDec)} HAWK
          </Text>
        ) : null}
        {effective > 0n ? (
          <Text style={[S.body, { marginTop: 12, fontWeight: '700' }]}>
            {tr('bh.receive', {
              amount: fmtAmountCardDec(receive, phoenixDec),
            })}
          </Text>
        ) : null}
        {over ? (
          <Text style={[S.err, { marginTop: 12 }]}>{tr('tip.over')}</Text>
        ) : null}

        <Pressable
          style={[S.bigBtn, { marginTop: 22 }, !canBurn && { opacity: 0.45 }]}
          disabled={!canBurn}
          onPress={() => setConfirming(true)}
        >
          <Text style={S.bigBtnText}>{tr('bh.burnCta')}</Text>
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
      </ScrollView>

      <ConfirmSheet
        visible={confirming}
        title={tr('bh.title')}
        body={tr('bh.confirm', {
          amount: fmtAmountCardDec(effective, hawkDec),
          receive: fmtAmountCardDec(receive, phoenixDec),
        })}
        confirmLabel={tr('bh.burnCta')}
        cancelLabel={tr('compose.cancel')}
        onConfirm={doBurn}
        onCancel={() => setConfirming(false)}
        busy={busy}
      />
    </View>
  );
}

export function BurnHawkModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <BurnHawkScreen onClose={onClose} />
    </Modal>
  );
}
