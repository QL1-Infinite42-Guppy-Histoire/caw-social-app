import React, { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import {
  addressFromPhrase,
  addressFromPrivateKey,
  createWallet,
  normalizePhrase,
} from '../lib/wallet';
import { saveWallet, type WalletKind } from '../lib/walletStore';

/**
 * Add another wallet (v0.2.0) — create or import, same safety flow
 * as first-time setup, minus the unlock setup (the app password /
 * biometrics already guard every wallet on this phone). The new
 * wallet becomes the active one; keys go to SecureStore only.
 */
export default function AddWalletModal({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<'choose' | 'showWords' | 'import'>(
    'choose',
  );
  const [pending, setPending] = useState<{
    kind: WalletKind;
    secret: string;
    address: string;
    phrase?: string;
  } | null>(null);
  const [savedChecked, setSavedChecked] = useState(false);
  const [importText, setImportText] = useState('');
  const [importErr, setImportErr] = useState('');
  const [busy, setBusy] = useState(false);

  const words = useMemo(
    () => (pending?.phrase ? pending.phrase.split(' ') : []),
    [pending],
  );

  const finish = async (
    p: { kind: WalletKind; secret: string; address: string },
  ) => {
    setBusy(true);
    try {
      await saveWallet(p.kind, p.secret, {
        kind: p.kind,
        address: p.address,
      });
      await app.refreshWalletState();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const startCreate = () => {
    const w = createWallet();
    setPending({
      kind: 'mnemonic',
      secret: w.phrase,
      address: w.address,
      phrase: w.phrase,
    });
    setSavedChecked(false);
    setStep('showWords');
  };

  const doImport = () => {
    const text = importText.trim();
    setImportErr('');
    if (/^0x[0-9a-fA-F]{64}$/.test(text)) {
      const addr = addressFromPrivateKey(text);
      if (!addr) {
        setImportErr(tr('wallet.badKey'));
        return;
      }
      finish({ kind: 'privateKey', secret: text, address: addr });
      return;
    }
    const addr = addressFromPhrase(text);
    if (!addr) {
      setImportErr(tr('wallet.badWords'));
      return;
    }
    finish({
      kind: 'mnemonic',
      secret: normalizePhrase(text),
      address: addr,
    });
  };

  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <Text style={S.h1}>{tr('wallets.add')}</Text>
        <Pressable onPress={onClose} hitSlop={8}>
          <Text style={styles.closeText}>{tr('common.close')}</Text>
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={[
          S.scrollPad,
          { paddingBottom: 32 + insets.bottom },
        ]}
      >
        {step === 'choose' && (
          <View style={{ gap: 14 }}>
            <Pressable style={S.bigBtn} onPress={startCreate}>
              <Text style={S.bigBtnText}>{tr('wallet.create')}</Text>
            </Pressable>
            <Text style={S.small}>{tr('wallet.createDesc')}</Text>
            <Pressable style={S.ghostBtn} onPress={() => setStep('import')}>
              <Text style={S.ghostBtnText}>{tr('wallet.import')}</Text>
            </Pressable>
            <Text style={S.small}>{tr('wallet.importDesc')}</Text>
          </View>
        )}
        {step === 'showWords' && pending && (
          <View>
            <Text style={S.h2}>{tr('wallet.wordsTitle')}</Text>
            <Text style={[S.small, { marginTop: 6 }]}>
              {tr('wallet.wordsWarn')}
            </Text>
            <View style={styles.wordsBox}>
              {words.map((w, i) => (
                <Text key={i} style={styles.word}>
                  {i + 1}. {w}
                </Text>
              ))}
            </View>
            <Text style={[S.small, { marginTop: 10 }]}>
              {tr('wallet.address')}: {pending.address}
            </Text>
            <Pressable
              style={[S.row, { marginTop: 16, gap: 8 }]}
              onPress={() => setSavedChecked((v) => !v)}
            >
              <Text style={styles.checkbox}>{savedChecked ? '☑' : '☐'}</Text>
              <Text style={S.body}>{tr('wallet.savedIt')}</Text>
            </Pressable>
            <Pressable
              style={[
                S.bigBtn,
                { marginTop: 18 },
                (!savedChecked || busy) && S.disabled,
              ]}
              disabled={!savedChecked || busy}
              onPress={() => finish(pending)}
            >
              <Text style={S.bigBtnText}>{tr('wallet.done')}</Text>
            </Pressable>
          </View>
        )}
        {step === 'import' && (
          <View>
            <Text style={S.h2}>{tr('wallet.import')}</Text>
            <TextInput
              style={[S.input, { marginTop: 12, minHeight: 90 }]}
              multiline
              value={importText}
              onChangeText={setImportText}
              placeholder={tr('wallet.pasteWords')}
              placeholderTextColor="#536471"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {importErr ? (
              <Text style={[S.err, { marginTop: 8 }]}>{importErr}</Text>
            ) : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 16 }, busy && S.disabled]}
              disabled={busy}
              onPress={doImport}
            >
              <Text style={S.bigBtnText}>{tr('wallet.importBtn')}</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
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
  wordsBox: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#cfd9de',
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#f7f9f9',
  },
  word: { fontSize: 14.5, fontWeight: '600', width: '30%', color: '#0f1419' },
  checkbox: { fontSize: 20, color: ACCENT },
});
