import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ConfirmSheet, LTR_TEXT, MONO, S } from '../components/ui';
import { ACCENT, X_MIRROR_SERVER_URL } from '../config';
import { useApp } from '../context/AppContext';
import { LANGS, tr } from '../i18n';
import { APP_VERSION } from '../lib/appVersion';
import {
  deleteWallet,
  deleteWalletByAddress,
  type WalletPublicInfo,
} from '../lib/walletStore';
import {
  connectX,
  disconnectX,
  loadPushRegistration,
  loadXClientId,
  loadXSession,
  registerPush,
  saveXClientId,
} from '../lib/xconnect';
import { X_REDIRECT_URI, type XSession } from '../lib/xmirror';
import AddWalletModal from './AddWalletModal';
import RevealSecretScreen from './RevealSecretScreen';

export default function SettingsScreen() {
  const app = useApp();
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [revealOpen, setRevealOpen] = useState(false);
  const [deleteOne, setDeleteOne] = useState<WalletPublicInfo | null>(null);
  const [deletingOne, setDeletingOne] = useState(false);
  const [switching, setSwitching] = useState(false);

  const doDeleteOne = async () => {
    if (!deleteOne) return;
    setDeletingOne(true);
    try {
      const wasLast = app.wallets.length <= 1;
      await deleteWalletByAddress(deleteOne.address);
      if (wasLast) {
        // Removing the final wallet also clears the unlock setup,
        // exactly like the full reset below.
        await deleteWallet();
        app.onWalletDeleted();
      } else {
        await app.refreshWalletState();
      }
    } finally {
      setDeletingOne(false);
      setDeleteOne(null);
    }
  };

  const doSwitch = async (w: WalletPublicInfo) => {
    if (switching) return;
    setSwitching(true);
    try {
      await app.switchWallet(w.address);
    } finally {
      setSwitching(false);
    }
  };

  const doCopy = async () => {
    if (!app.address) return;
    await Clipboard.setStringAsync(app.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /* ---------- X mirror linking (v0.5.0-x) ---------- */
  const [xClientId, setXClientId] = useState('');
  const [xSession, setXSession] = useState<XSession | null>(null);
  const [xBusy, setXBusy] = useState(false);
  const [xMsg, setXMsg] = useState('');
  const [xMsgOk, setXMsgOk] = useState(false);
  const [pushState, setPushState] = useState<
    'unknown' | 'no-server' | 'ready' | 'no-token' | 'failed' | 'off'
  >('unknown');

  useEffect(() => {
    (async () => {
      setXClientId(await loadXClientId());
      const s = await loadXSession();
      setXSession(s);
      if (!X_MIRROR_SERVER_URL) {
        setPushState('no-server');
      } else if (s) {
        const reg = await loadPushRegistration();
        setPushState(
          reg && reg.xUserId === s.userId ? 'ready' : 'off',
        );
      } else {
        setPushState('off');
      }
    })().catch(() => {});
  }, []);

  const doSaveXClientId = async () => {
    await saveXClientId(xClientId);
    setXMsgOk(true);
    setXMsg(tr('xset.saved'));
  };

  const doConnectX = async () => {
    if (xBusy) return;
    setXBusy(true);
    setXMsg('');
    try {
      await saveXClientId(xClientId);
      const s = await connectX(xClientId.trim());
      setXSession(s);
      setXMsgOk(true);
      setXMsg(tr('xset.connectedAs', { name: s.username }));
      // Push registration is part of connecting when the
      // server exists; its outcome is shown, never hidden.
      if (X_MIRROR_SERVER_URL) {
        const r = await registerPush(s);
        setPushState(
          r === 'ok'
            ? 'ready'
            : r === 'no-token'
              ? 'no-token'
              : r === 'no-server'
                ? 'no-server'
                : 'failed',
        );
      }
    } catch {
      setXMsgOk(false);
      setXMsg(tr('xset.connectFailed'));
    } finally {
      setXBusy(false);
    }
  };

  const doRegisterPush = async () => {
    if (!xSession || xBusy) return;
    setXBusy(true);
    try {
      const r = await registerPush(xSession);
      setPushState(
        r === 'ok'
          ? 'ready'
          : r === 'no-token'
            ? 'no-token'
            : r === 'no-server'
              ? 'no-server'
              : 'failed',
      );
    } finally {
      setXBusy(false);
    }
  };

  const doDisconnectX = async () => {
    if (xBusy) return;
    setXBusy(true);
    try {
      await disconnectX();
      setXSession(null);
      setPushState(X_MIRROR_SERVER_URL ? 'off' : 'no-server');
      setXMsgOk(true);
      setXMsg(tr('xset.disconnected'));
    } finally {
      setXBusy(false);
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      await deleteWallet();
      app.onWalletDeleted();
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <ScrollView style={S.screen} contentContainerStyle={S.scrollPad}>
      <Text style={S.h1}>{tr('settings.title')}</Text>

      {/* language — section card with divider rows (v0.3.8) */}
      <Text style={[S.h2, { marginTop: 22 }]}>{tr('settings.language')}</Text>
      <View style={S.cardFlush}>
        {LANGS.map((l, i) => (
          <Pressable
            key={l.code}
            style={[
              styles.langRow,
              i < LANGS.length - 1 && S.rowDivider,
              app.lang === l.code && styles.langRowOn,
            ]}
            onPress={() => app.changeLang(l.code)}
          >
            <Text style={[S.body, app.lang === l.code && styles.langOn]}>
              {l.label}
            </Text>
            {app.lang === l.code ? <Text style={styles.check}>✓</Text> : null}
          </Pressable>
        ))}
      </View>

      {/* address */}
      <Text style={[S.h2, { marginTop: 24 }]}>{tr('settings.address')}</Text>
      <View style={S.cardBox}>
        {app.address ? (
          <Text style={[S.small, { fontSize: 12.5, fontFamily: MONO }, LTR_TEXT, { textAlign: 'left' }]}>
            {app.address}
          </Text>
        ) : null}
        <View style={[S.row, { marginTop: 10, gap: 12 }]}>
          <Pressable style={S.ghostBtn} onPress={doCopy}>
            <Text style={S.ghostBtnText}>{tr('settings.copy')}</Text>
          </Pressable>
          {copied ? <Text style={S.ok}>{tr('settings.copied')}</Text> : null}
        </View>
      </View>

      {/* backup / secret reveal (v0.3.1) */}
      <Text style={[S.h2, { marginTop: 24 }]}>{tr('settings.backup')}</Text>
      <View style={S.cardBox}>
        <Pressable style={[S.ghostBtn, { alignSelf: 'flex-start' }]} onPress={() => setRevealOpen(true)}>
          <Text style={S.ghostBtnText}>{tr('settings.backup')}</Text>
        </Pressable>
      </View>

      {/* wallets (v0.2.0: several can live on this phone) */}
      <Text style={[S.h2, { marginTop: 24 }]}>{tr('wallets.title')}</Text>
      <View style={S.cardFlush}>
        {app.wallets.map((w, i) => {
          const active =
            app.address &&
            w.address.toLowerCase() === app.address.toLowerCase();
          return (
            <View
              key={w.address}
              style={[
                styles.walletRow,
                i < app.wallets.length - 1 && S.rowDivider,
              ]}
            >
              <Pressable
                style={{ flex: 1 }}
                onPress={() => {
                  if (!active) doSwitch(w);
                }}
              >
                <Text style={[S.body, active && { fontWeight: '700' }]}>
                  {w.address.slice(0, 10)}…{w.address.slice(-6)}
                  {active ? '  ✓' : ''}
                </Text>
                <Text style={S.tiny}>
                  {w.kind === 'mnemonic'
                    ? tr('wallets.kindWords')
                    : tr('wallets.kindKey')}
                  {active ? ' · ' + tr('wallets.inUse') : ''}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setDeleteOne(w)}
                hitSlop={8}
                style={styles.walletDel}
              >
                <Text style={styles.walletDelText}>
                  {tr('wallets.deleteOne')}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>
      <Pressable
        style={[S.ghostBtn, { marginTop: 12, alignSelf: 'flex-start' }]}
        onPress={() => setAddOpen(true)}
      >
        <Text style={S.ghostBtnText}>{tr('wallets.add')}</Text>
      </Pressable>

      {/* X mirror linking (v0.5.0-x) */}
      <Text style={[S.h2, { marginTop: 24 }]}>{tr('xset.title')}</Text>
      <View style={S.cardBox}>
        <Text style={S.small}>{tr('xset.intro')}</Text>
        {xSession ? (
          <>
            <Text style={[S.body, { marginTop: 12, fontWeight: '700' }]}>
              {tr('xset.connectedAs', { name: xSession.username })}
            </Text>
            {app.mirrorNewCount !== null && app.mirrorNewCount > 0 ? (
              <Text style={[S.small, { marginTop: 4 }]}>
                {tr('xset.newCount', {
                  count: String(app.mirrorNewCount),
                })}
              </Text>
            ) : null}
            <View style={[S.row, { marginTop: 12, gap: 12, flexWrap: 'wrap' }]}>
              <Pressable
                style={S.ghostBtn}
                onPress={() => app.openMirror()}
              >
                <Text style={S.ghostBtnText}>{tr('xset.openMirror')}</Text>
              </Pressable>
              <Pressable
                style={S.ghostBtn}
                onPress={doDisconnectX}
                disabled={xBusy}
              >
                <Text style={S.ghostBtnText}>{tr('xset.disconnect')}</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Text style={[S.small, { marginTop: 10 }]}>
              {tr('xset.needDev')}
            </Text>
            <Text style={[S.tiny, { marginTop: 10 }]}>
              {tr('xset.callbackLabel')}
            </Text>
            <Text
              style={[
                S.small,
                { fontSize: 12.5, fontFamily: MONO },
                LTR_TEXT,
                { textAlign: 'left' },
              ]}
            >
              {X_REDIRECT_URI}
            </Text>
            <TextInput
              style={[S.input, { marginTop: 12 }]}
              value={xClientId}
              onChangeText={setXClientId}
              placeholder={tr('xset.clientIdPh')}
              placeholderTextColor="#536471"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={[S.row, { marginTop: 12, gap: 12, flexWrap: 'wrap' }]}>
              <Pressable style={S.ghostBtn} onPress={doSaveXClientId}>
                <Text style={S.ghostBtnText}>{tr('xset.saveId')}</Text>
              </Pressable>
              <Pressable
                style={[
                  S.ghostBtn,
                  (!xClientId.trim() || xBusy) && S.disabled,
                ]}
                disabled={!xClientId.trim() || xBusy}
                onPress={doConnectX}
              >
                <Text style={S.ghostBtnText}>{tr('xset.connect')}</Text>
              </Pressable>
            </View>
          </>
        )}
        {xMsg ? (
          <Text style={[xMsgOk ? S.ok : S.err, { marginTop: 10 }]}>
            {xMsg}
          </Text>
        ) : null}

        {/* push notifications for new posts */}
        <Text style={[S.h2, { marginTop: 18, fontSize: 15 }]}>
          {tr('xpush.title')}
        </Text>
        <Text style={[S.small, { marginTop: 6 }]}>
          {pushState === 'no-server'
            ? tr('xpush.notConfigured')
            : pushState === 'ready'
              ? tr('xpush.ready')
              : pushState === 'no-token'
                ? tr('xpush.noToken')
                : pushState === 'failed'
                  ? tr('xpush.failed')
                  : tr('xpush.notConfigured')}
        </Text>
        {xSession &&
        X_MIRROR_SERVER_URL &&
        pushState !== 'ready' &&
        pushState !== 'no-server' ? (
          <Pressable
            style={[S.ghostBtn, { marginTop: 10, alignSelf: 'flex-start' }]}
            onPress={doRegisterPush}
            disabled={xBusy}
          >
            <Text style={S.ghostBtnText}>{tr('xpush.title')}</Text>
          </Pressable>
        ) : null}
        <Text style={[S.tiny, { marginTop: 10 }]}>{tr('xpush.note')}</Text>
      </View>

      {/* lock */}
      <Pressable
        style={[S.darkBtn, { marginTop: 26, alignSelf: 'flex-start' }]}
        onPress={() => app.lock()}
      >
        <Text style={S.darkBtnText}>{tr('settings.lockNow')}</Text>
      </Pressable>

      {/* about */}
      <Text style={[S.h2, { marginTop: 26 }]}>{tr('settings.about')}</Text>
      <View style={S.cardBox}>
        <Text style={S.body}>{tr('settings.aboutBody')}</Text>
        <Text style={[S.tiny, { marginTop: 12 }]}>
          CAW Social v{APP_VERSION}
        </Text>
        <Text style={S.tiny}>one.guppyguide.cawsocial</Text>
      </View>

      {/* danger zone */}
      <Text style={[S.h2, { marginTop: 28, color: '#c62828' }]}>
        {tr('settings.danger')}
      </Text>
      <Pressable
        style={[styles.deleteBtn, { marginTop: 12 }]}
        onPress={() => setConfirmDelete(true)}
      >
        <Text style={styles.deleteBtnText}>{tr('settings.delete')}</Text>
      </Pressable>

      <ConfirmSheet
        visible={confirmDelete}
        title={tr('settings.delete')}
        body={tr('settings.deleteWarn')}
        confirmLabel={tr('settings.deleteConfirm')}
        cancelLabel={tr('settings.cancel')}
        onConfirm={doDelete}
        onCancel={() => {
          if (!deleting) setConfirmDelete(false);
        }}
        busy={deleting}
      />
      <ConfirmSheet
        visible={!!deleteOne}
        title={tr('wallets.deleteOne')}
        body={
          deleteOne
            ? tr('wallets.deleteOneWarn', {
                addr:
                  deleteOne.address.slice(0, 10) +
                  '…' +
                  deleteOne.address.slice(-6),
              })
            : undefined
        }
        confirmLabel={tr('settings.deleteConfirm')}
        cancelLabel={tr('settings.cancel')}
        onConfirm={doDeleteOne}
        onCancel={() => {
          if (!deletingOne) setDeleteOne(null);
        }}
        busy={deletingOne}
      />
      <Modal
        visible={revealOpen}
        animationType="slide"
        onRequestClose={() => setRevealOpen(false)}
      >
        <RevealSecretScreen onClose={() => setRevealOpen(false)} />
      </Modal>
      <Modal
        visible={addOpen}
        animationType="slide"
        onRequestClose={() => setAddOpen(false)}
      >
        <AddWalletModal onClose={() => setAddOpen(false)} />
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  langRowOn: { borderColor: ACCENT, backgroundColor: '#fff7f2' },
  langOn: { fontWeight: '700' },
  check: { fontSize: 15, fontWeight: '700', color: ACCENT },
  deleteBtn: {
    borderWidth: 1,
    borderColor: '#c62828',
    borderRadius: 999,
    paddingVertical: 11,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    backgroundColor: '#fff',
  },
  deleteBtnText: { color: '#c62828', fontSize: 15, fontWeight: '700' },
  walletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 14,
    gap: 10,
  },
  walletDel: { paddingVertical: 6, paddingHorizontal: 4 },
  walletDelText: { color: '#c62828', fontSize: 13.5, fontWeight: '600' },
});
