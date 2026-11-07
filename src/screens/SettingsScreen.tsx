import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ConfirmSheet, MONO, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { LANGS, tr } from '../i18n';
import { APP_VERSION } from '../lib/appVersion';
import {
  deleteWallet,
  deleteWalletByAddress,
  type WalletPublicInfo,
} from '../lib/walletStore';
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
          <Text style={[S.small, { fontSize: 12.5, fontFamily: MONO }]}>
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
