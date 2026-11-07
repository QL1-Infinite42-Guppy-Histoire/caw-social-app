import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ConfirmSheet, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import { APP_VERSION } from '../lib/appVersion';
import { deleteWallet } from '../lib/walletStore';

export default function SettingsScreen() {
  const app = useApp();
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

      {/* language */}
      <Text style={[S.h2, { marginTop: 22 }]}>{tr('settings.language')}</Text>
      <Pressable
        style={[styles.langRow, app.lang === 'en' && styles.langRowOn]}
        onPress={() => app.changeLang('en')}
      >
        <Text style={[S.body, app.lang === 'en' && styles.langOn]}>English</Text>
        {app.lang === 'en' ? <Text style={styles.check}>✓</Text> : null}
      </Pressable>
      <Pressable
        style={[styles.langRow, app.lang === 'ja' && styles.langRowOn]}
        onPress={() => app.changeLang('ja')}
      >
        <Text style={[S.body, app.lang === 'ja' && styles.langOn]}>日本語</Text>
        {app.lang === 'ja' ? <Text style={styles.check}>✓</Text> : null}
      </Pressable>

      {/* address */}
      <Text style={[S.h2, { marginTop: 24 }]}>{tr('settings.address')}</Text>
      {app.address ? (
        <Text style={[S.small, { marginTop: 6, fontSize: 12.5 }]}>
          {app.address}
        </Text>
      ) : null}
      <View style={[S.row, { marginTop: 10, gap: 12 }]}>
        <Pressable style={S.ghostBtn} onPress={doCopy}>
          <Text style={S.ghostBtnText}>{tr('settings.copy')}</Text>
        </Pressable>
        {copied ? <Text style={S.ok}>{tr('settings.copied')}</Text> : null}
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
      <Text style={[S.body, { marginTop: 6 }]}>{tr('settings.aboutBody')}</Text>
      <Text style={[S.tiny, { marginTop: 14 }]}>
        CAW Social v{APP_VERSION}
      </Text>
      <Text style={S.tiny}>one.guppyguide.cawsocial</Text>

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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#cfd9de',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 10,
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
});
