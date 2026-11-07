import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Avatar, ConfirmSheet, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import { textBytes, type CawAction } from '../lib/cawCore';
import { nowSec, randomCawId, submitAction } from '../lib/wallet';

export default function ComposeScreen({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const { myTokens, actingId, chooseActing } = app;

  const [text, setText] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState('');
  const [statusOk, setStatusOk] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    app.refreshMyTokens().catch(() => {});
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const acting =
    myTokens.find((t) => t.id === actingId) ?? myTokens[0] ?? null;

  const bytes = textBytes(text);
  const remaining = 420 - bytes;
  const trimmed = text.trim();
  const canPost = !!acting && trimmed.length > 0 && bytes <= 420 && !sending;

  const doPost = async () => {
    if (!acting || !app.address) {
      setConfirmOpen(false);
      setStatusOk(false);
      setStatus(tr('compose.failed'));
      return;
    }
    setSending(true);
    try {
      const ok = await app.requireAuth();
      if (!ok) throw new Error('auth');
      const secret = app.getSecret();
      if (!secret) throw new Error('locked');
      const cawId = await randomCawId();
      const action: CawAction = {
        type: 0,
        senderId: acting.id,
        receiverId: 0n,
        ts: nowSec(),
        sender: app.address,
        cawId,
        text: trimmed,
      };
      await submitAction(secret.kind, secret.secret, action);
      setConfirmOpen(false);
      setStatusOk(true);
      setStatus(tr('compose.posted'));
      timerRef.current = setTimeout(() => {
        onClose();
      }, 1200);
    } catch {
      setConfirmOpen(false);
      setStatusOk(false);
      setStatus(tr('compose.failed'));
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={S.screen}>
      <View style={styles.headerRow}>
        <Text style={S.h1}>{tr('compose.title')}</Text>
        <Pressable onPress={onClose} hitSlop={8}>
          <Text style={styles.closeText}>{tr('common.close')}</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={S.scrollPad}>
        {!acting ? (
          <Text style={S.body}>{tr('compose.needName')}</Text>
        ) : (
          <>
            {myTokens.length > 1 ? (
              <View style={styles.chipRow}>
                {myTokens.map((t) => {
                  const selected = acting.id === t.id;
                  const c = app.customFor(t.id);
                  return (
                    <Pressable
                      key={t.id.toString()}
                      onPress={() => chooseActing(t.id)}
                      style={[styles.chip, selected && styles.chipOn]}
                    >
                      <Text
                        style={[
                          S.chipText,
                          selected && styles.chipTextOn,
                        ]}
                      >
                        {c && c.displayName ? c.displayName : '@' + t.username}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <View style={S.row}>
                <Avatar
                  nameId={acting.id}
                  size={28}
                  customUri={
                    app.customFor(acting.id)
                      ? app.customFor(acting.id)!.avatarPath
                      : undefined
                  }
                />
                <Text style={[S.small, { marginLeft: 8 }]}>
                  {tr('compose.postAs')}:{' '}
                  {app.customFor(acting.id) &&
                  app.customFor(acting.id)!.displayName
                    ? app.customFor(acting.id)!.displayName
                    : '@' + acting.username}
                </Text>
              </View>
            )}

            <TextInput
              style={[S.input, styles.input, { marginTop: 14 }]}
              multiline
              autoFocus
              value={text}
              onChangeText={setText}
              placeholder={tr('compose.ph')}
              placeholderTextColor="#536471"
            />
            <View
              style={[
                S.row,
                { marginTop: 8, justifyContent: 'space-between' },
              ]}
            >
              <Text style={S.small}>{tr('compose.help')}</Text>
              <Text style={remaining < 0 ? S.err : S.small}>
                {remaining}
              </Text>
            </View>

            {sending ? (
              <View style={[S.row, { marginTop: 14, gap: 8 }]}>
                <ActivityIndicator color={ACCENT} />
                <Text style={S.small}>{tr('compose.sending')}</Text>
              </View>
            ) : null}
            {status ? (
              <Text
                style={[
                  statusOk ? S.ok : S.err,
                  { marginTop: 12 },
                ]}
              >
                {status}
              </Text>
            ) : null}

            <Pressable
              style={[S.bigBtn, { marginTop: 18 }, !canPost && S.disabled]}
              disabled={!canPost}
              onPress={() => setConfirmOpen(true)}
            >
              <Text style={S.bigBtnText}>{tr('compose.post')}</Text>
            </Pressable>
          </>
        )}
      </ScrollView>

      <ConfirmSheet
        visible={confirmOpen}
        title={tr('compose.confirmTitle')}
        body={
          acting
            ? tr('compose.confirmPost', { name: '@' + acting.username })
            : undefined
        }
        confirmLabel={tr('compose.send')}
        cancelLabel={tr('compose.cancel')}
        onConfirm={doPost}
        onCancel={() => setConfirmOpen(false)}
        busy={sending}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
  },
  closeText: { fontSize: 15, color: ACCENT, fontWeight: '600' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: '#cfd9de',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#fff',
  },
  chipOn: { borderColor: ACCENT, backgroundColor: '#fff7f2' },
  chipTextOn: { color: ACCENT, fontWeight: '700' },
  input: { minHeight: 140, textAlignVertical: 'top', fontSize: 16 },
});
