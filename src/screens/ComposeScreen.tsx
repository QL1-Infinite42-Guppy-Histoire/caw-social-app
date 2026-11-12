import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, ConfirmSheet, QuotedPostFrame, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import {
  indexPostRef,
  invalidateFeedHead,
  resolveName,
} from '../lib/cawApi';
import { fmtAmountCard, textBytes, type CawAction } from '../lib/cawCore';
import { composeCostRaw } from '../lib/actionCosts';
import { clearDraft, loadDraft, saveDraft } from '../lib/drafts';
import { noteOwnPost } from '../lib/feedSync';
import {
  appendPostRef,
  postRefOverhead,
  type PostRef,
} from '../lib/postRef';
import { nowSec, randomCawId, submitAction } from '../lib/wallet';

export default function ComposeScreen({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const { myTokens, actingId, chooseActing } = app;
  /* Reply / quote target (v0.4.0): when set, the sent post is an
   * ordinary post whose text gains a parent-reference marker
   * line (lib/postRef.ts). Drafts belong to plain posts only —
   * a targeted composer never loads or overwrites them. */
  const target = app.composeTarget;
  const postRef: PostRef | null = target
    ? { kind: target.kind, parentCawId: target.post.cawId }
    : null;
  const [targetName, setTargetName] = useState<string | null>(null);
  useEffect(() => {
    if (!target) {
      setTargetName(null);
      return;
    }
    let live = true;
    resolveName(target.post.senderId)
      .then((n) => live && setTargetName(n))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [target]);

  const [text, setText] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
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
    // Restore this wallet's saved draft, if any (v0.2.0). A
    // targeted (reply/quote) composer starts empty and leaves
    // the plain-post draft untouched.
    if (!target && app.address) {
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
    if (!app.address || postedRef.current || target) return;
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

  const trimmed = text.trim();
  /* The 420-byte budget covers the FINAL text — for a reply /
   * quote that includes the parent-reference marker line. */
  const overhead = postRef ? postRefOverhead(postRef) : 0;
  const bytes = textBytes(trimmed) + overhead;
  const remaining = 420 - bytes;
  const canPost = !!acting && trimmed.length > 0 && bytes <= 420 && !sending;
  /* Cost-line kind (v0.6.0): a plain composer posts; a
   * targeted one replies or quotes — all three are the same
   * type-0 post on-chain at the same price (actionCosts). */
  const costKind = target ? target.kind : 'post';

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
        text: postRef ? appendPostRef(trimmed, postRef) : trimmed,
      };
      const hash = await submitAction(secret.kind, secret.secret, action);
      postedRef.current = true;
      // A reply/quote is indexed by its parent reference right
      // away, so counts and the parent's thread include it
      // without waiting for the next feed walk.
      if (postRef) indexPostRef({ ...action, hash });
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
      if (!postRef && app.address) await clearDraft(app.address);
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
      {/* X-style header (v0.6.0): ✕ closes at the left, the
          blue Post pill at the right. The pill opens the SAME
          confirmation sheet the old bottom button did — the
          reply/quote/plain titles live on that sheet now, so
          no context is lost. No image/GIF/poll/location
          buttons anywhere: media attach is a separate phase
          and this screen ships no dead buttons. */}
      <View style={styles.headerRow}>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
          <Text style={styles.closeX}>✕</Text>
        </Pressable>
        <Pressable
          style={[styles.postPill, !canPost && S.disabled]}
          disabled={!canPost}
          onPress={() => setConfirmOpen(true)}
          accessibilityRole="button"
        >
          <Text style={styles.postPillText}>{tr('compose.post')}</Text>
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
            {target ? (
              <View style={{ marginBottom: 4 }}>
                {target.kind === 'reply' && targetName ? (
                  <Text style={[S.small, { marginBottom: 2 }]}>
                    {tr('tl.replyTo', { name: '@' + targetName })}
                  </Text>
                ) : null}
                <QuotedPostFrame
                  post={target.post}
                  lang={app.lang}
                  onOpenProfile={(u) => {
                    onClose();
                    app.openProfile(u);
                  }}
                />
              </View>
            ) : null}
            {/* Name-switch chip (v0.6.0): ONE chip showing the
                acting name (@name ▾). Tapping it (when the
                wallet holds more than one name) opens the
                picker below; switching goes through the same
                chooseActing the old chip grid used, and the
                cost line under the input follows the newly
                active name's deposited balance immediately.
                The old always-visible chip grid is gone — it
                pushed the input down for many-name wallets,
                which is exactly the always-on clutter the
                overhaul removes. */}
            <View style={[S.row, { alignItems: 'center', gap: 8 }]}>
              <Text style={S.small}>{tr('compose.postAs')}:</Text>
              {myTokens.length > 1 ? (
                <Pressable
                  onPress={() => setPickerOpen(true)}
                  style={({ pressed }) => [
                    styles.nameChip,
                    pressed && { backgroundColor: '#e8f5fe' },
                  ]}
                  accessibilityRole="button"
                >
                  <Text style={styles.nameChipText}>
                    @{acting.username} ▾
                  </Text>
                </Pressable>
              ) : (
                <View style={styles.nameChip}>
                  <Text style={styles.nameChipText}>
                    @{acting.username}
                  </Text>
                </View>
              )}
            </View>

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
            {/* Cost line (v0.6.0): what this post costs and
                what the ACTIVE name holds — the two numbers a
                poster needs at the moment of posting, and
                nothing else. Reply and quote posts are plain
                posts carrying a reference marker, so their
                on-chain cost is the same 5,000 CAW
                (lib/actionCosts.ts); the balance half reads
                the acting token directly, so it updates the
                moment the chip above switches names. */}
            <Text style={[S.tiny, { marginTop: 8 }]}>
              {tr('compose.cost', {
                cost: fmtAmountCard(composeCostRaw(costKind)),
              })}
              {'  '}
              {tr('compose.costFrom', {
                balance: fmtAmountCard(acting.balance),
              })}
            </Text>
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

          </>
        )}
      </ScrollView>

      {/* Name picker (v0.6.0): the chip's sheet — avatar,
          @name and the name's deposited CAW balance per row.
          Picking a row switches via chooseActing and closes;
          the cost line above re-reads the new acting name. */}
      <Modal
        visible={pickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable
          style={styles.pickerBackdrop}
          onPress={() => setPickerOpen(false)}
        >
          <View style={styles.pickerSheet}>
            <Text style={[S.small, { marginBottom: 6 }]}>
              {tr('compose.postAs')}
            </Text>
            <ScrollView style={{ maxHeight: 320 }}>
              {myTokens.map((t) => {
                const c = app.customFor(t.id);
                return (
                  <Pressable
                    key={t.id.toString()}
                    onPress={() => {
                      chooseActing(t.id);
                      setPickerOpen(false);
                    }}
                    style={({ pressed }) => [
                      styles.pickerRow,
                      pressed && { backgroundColor: '#f7f9f9' },
                    ]}
                    accessibilityRole="button"
                  >
                    <Avatar
                      nameId={t.id}
                      size={36}
                      customUri={c ? c.avatarPath : undefined}
                    />
                    <View style={{ flex: 1, marginStart: 10 }}>
                      <Text style={{ fontSize: 15, fontWeight: '700', color: '#0f1419' }}>
                        {c && c.displayName ? c.displayName : '@' + t.username}
                      </Text>
                      <Text style={S.tiny}>
                        @{t.username} · {fmtAmountCard(t.balance)} CAW
                      </Text>
                    </View>
                    {acting && acting.id === t.id ? (
                      <Text style={{ color: ACCENT, fontWeight: '800' }}>✓</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>

      <ConfirmSheet
        visible={confirmOpen}
        title={
          target
            ? target.kind === 'reply'
              ? tr('compose.replyTitle')
              : tr('compose.quoteTitle')
            : tr('compose.confirmTitle')
        }
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
  closeX: { fontSize: 19, color: '#0f1419', fontWeight: '400' },
  // The blue Post pill in the header (v0.6.0) — X's composer
  // affordance, wired to the same confirmation sheet.
  postPill: {
    backgroundColor: ACCENT,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 7,
  },
  postPillText: { color: '#fff', fontSize: 14.5, fontWeight: '700' },
  // The single name-switch chip (v0.6.0).
  nameChip: {
    borderWidth: 1,
    borderColor: '#cfd9de',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: '#fff',
  },
  nameChipText: { fontSize: 13.5, color: ACCENT, fontWeight: '700' },
  pickerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 16,
    paddingBottom: 26,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
  },
  input: { minHeight: 140, textAlignVertical: 'top', fontSize: 16 },
});
