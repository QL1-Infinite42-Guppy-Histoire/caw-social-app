import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, ConfirmSheet, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import { invalidateFeedHead } from '../lib/cawApi';
import { textBytes, type CawAction } from '../lib/cawCore';
import { clearDraft, loadDraft, saveDraft } from '../lib/drafts';
import { noteOwnPost } from '../lib/feedSync';
import { nowSec, randomCawId, submitAction } from '../lib/wallet';

export default function ComposeScreen({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const { myTokens, actingId, chooseActing } = app;

  const [text, setText] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState('');
  const [statusOk, setStatusOk] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const postedRef = useRef(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrollRef = useRef<any>(null);

  // Keep the composer (input + counter + post button) visible above
  // the keyboard: whenever the keyboard appears — on focus it is the
  // last block of the scroll content, so scrolling to the end pins it
  // right above the keyboard. (v0.1.4 fix: with many names the chip
  // grid pushed the input below the keyboard and nothing scrolled.)
  const scrollComposerIntoView = useRef(() => {
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 60);
  }).current;

  useEffect(() => {
    app.refreshMyTokens().catch(() => {});
    // Restore this wallet's saved draft, if any (v0.2.0).
    if (app.address) {
      loadDraft(app.address)
        .then((d) => {
          if (d && d.text.trim().length > 0) {
            setText(d.text);
            setDraftRestored(true);
          }
        })
        .catch(() => {});
    }
    const sub = Keyboard.addListener(
      'keyboardDidShow',
      scrollComposerIntoView,
    );
    return () => {
      sub.remove();
      if (timerRef.current) clearTimeout(timerRef.current);
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save the draft as the user types (debounced, on-device
  // only). A successful post clears it in doPost.
  useEffect(() => {
    if (!app.address || postedRef.current) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      if (app.address) {
        saveDraft(app.address, {
          text,
          actingId: actingId ? actingId.toString() : null,
          savedAt: Date.now(),
        }).catch(() => {});
      }
    }, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const discardDraft = async () => {
    if (app.address) await clearDraft(app.address);
    setText('');
    setDraftRestored(false);
  };

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
      const hash = await submitAction(secret.kind, secret.secret, action);
      postedRef.current = true;
      // The tx is confirmed (submitAction waits for the receipt).
      // Record the post so the timeline shows it at the head the
      // moment this modal closes — the explorer may still be a few
      // seconds behind the receipt, so the feed reconciles this
      // local copy against scanned pages until the scanned copy of
      // the same hash takes over (see lib/feedSync.ts).
      invalidateFeedHead();
      noteOwnPost({
        ...action,
        hash,
        blockTs: new Date().toISOString(),
      });
      if (app.address) await clearDraft(app.address);
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
    // v0.1.5 fix: this screen runs inside a Modal, outside the main
    // SafeAreaView, so the header used to start at the very top edge
    // of the screen — the title overlapped the status-bar clock and
    // the Close label sat under the battery icons. Reserve the top
    // safe-area inset here (same pattern as LoadMoreFooter uses for
    // the bottom) so the header is fully visible and tappable.
    <KeyboardAvoidingView
      style={[S.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
    >
      <View style={styles.headerRow}>
        <Text style={S.h1}>{tr('compose.title')}</Text>
        <Pressable onPress={onClose} hitSlop={8}>
          <Text style={styles.closeText}>{tr('common.close')}</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          S.scrollPad,
          // Modal again: keep the Post button clear of the gesture
          // area at the bottom edge, same inset pattern as the top.
          { paddingBottom: 32 + insets.bottom },
        ]}
      >
        {!acting ? (
          <Text style={S.body}>{tr('compose.needName')}</Text>
        ) : (
          <>
            {myTokens.length > 1 ? (
              <>
                <Text style={S.small}>{tr('compose.postAs')}</Text>
                <ScrollView
                  style={styles.chipScroll}
                  contentContainerStyle={styles.chipRow}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator
                >
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
                          {c && c.displayName
                            ? c.displayName
                            : '@' + t.username}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </>
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
                <Text style={[S.small, { marginStart: 8 }]}>
                  {tr('compose.postAs')}:{' '}
                  {app.customFor(acting.id) &&
                  app.customFor(acting.id)!.displayName
                    ? app.customFor(acting.id)!.displayName
                    : '@' + acting.username}
                </Text>
              </View>
            )}

            {/* X-style composer: the posting name's avatar sits at
                the left of the text field. */}
            <View style={{ flexDirection: 'row', marginTop: 14, gap: 10 }}>
              <Avatar
                nameId={acting.id}
                size={40}
                customUri={
                  app.customFor(acting.id)
                    ? app.customFor(acting.id)!.avatarPath
                    : undefined
                }
              />
              <TextInput
                style={[S.input, styles.input, { flex: 1 }]}
                multiline
                autoFocus
                value={text}
                onChangeText={setText}
                onFocus={scrollComposerIntoView}
                placeholder={tr('compose.ph')}
                placeholderTextColor="#536471"
              />
            </View>
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
            {draftRestored ? (
              <View style={[S.row, { marginTop: 8, gap: 12 }]}>
                <Text style={S.small}>{tr('draft.restored')}</Text>
                <Pressable onPress={discardDraft} hitSlop={6}>
                  <Text style={[S.small, { color: ACCENT, fontWeight: '700' }]}>
                    {tr('draft.discard')}
                  </Text>
                </Pressable>
              </View>
            ) : text.trim().length > 0 ? (
              <Text style={[S.tiny, { marginTop: 8 }]}>
                {tr('draft.autoSaved')}
              </Text>
            ) : null}

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
    </KeyboardAvoidingView>
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
  // The name picker gets a capped viewport (about 3 rows of chips)
  // with its own scrolling, so an account holding many names (30+)
  // can never push the text input off the visible area — the input
  // always wins the space. (v0.1.4 fix)
  chipScroll: {
    maxHeight: 118,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#eff3f4',
    borderRadius: 10,
    padding: 8,
  },
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
