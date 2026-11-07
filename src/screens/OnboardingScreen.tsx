import React, { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useApp } from '../context/AppContext';
import { LANGS, tr } from '../i18n';
import {
  addressFromPhrase,
  addressFromPrivateKey,
  createWallet,
  normalizePhrase,
} from '../lib/wallet';
import {
  isBiometricAvailable,
  saveWallet,
  setPasswordVerifier,
  setUnlockMethodStored,
  type UnlockMethod,
  type WalletKind,
} from '../lib/walletStore';
import { AppLogo, S } from '../components/ui';

type Step = 'choose' | 'showWords' | 'import' | 'unlockSetup';

interface Pending {
  kind: WalletKind;
  secret: string;
  address: string;
  phrase?: string;
}

export default function OnboardingScreen() {
  const app = useApp();
  const [step, setStep] = useState<Step>('choose');
  const [pending, setPending] = useState<Pending | null>(null);
  const [importText, setImportText] = useState('');
  const [importErr, setImportErr] = useState('');
  const [method, setMethod] = useState<UnlockMethod>('password');
  const [bioOk, setBioOk] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [busy, setBusy] = useState(false);

  React.useEffect(() => {
    isBiometricAvailable().then((ok) => {
      setBioOk(ok);
      if (ok) setMethod('biometric');
    });
  }, []);

  const words = useMemo(
    () => (pending?.phrase ? pending.phrase.split(' ') : []),
    [pending],
  );

  const startCreate = () => {
    const w = createWallet();
    setPending({ kind: 'mnemonic', secret: w.phrase, address: w.address, phrase: w.phrase });
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
      setPending({ kind: 'privateKey', secret: text, address: addr });
      setStep('unlockSetup');
      return;
    }
    const addr = addressFromPhrase(text);
    if (!addr) {
      setImportErr(tr('wallet.badWords'));
      return;
    }
    setPending({
      kind: 'mnemonic',
      secret: normalizePhrase(text),
      address: addr,
    });
    setStep('unlockSetup');
  };

  const finish = async () => {
    if (!pending) return;
    setPwErr('');
    if (method === 'password') {
      if (pw.length < 6) {
        setPwErr(tr('wallet.pwShort'));
        return;
      }
      if (pw !== pw2) {
        setPwErr(tr('wallet.pwMismatch'));
        return;
      }
    }
    setBusy(true);
    try {
      if (method === 'password') await setPasswordVerifier(pw);
      await setUnlockMethodStored(method);
      await saveWallet(pending.kind, pending.secret, {
        kind: pending.kind,
        address: pending.address,
      });
      await app.completeOnboarding();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={S.screen} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={S.scrollPad}>
        <View style={[S.row, { justifyContent: 'space-between' }]}>
          <AppLogo size={38} />
          <Pressable
            onPress={() => {
              const idx = LANGS.findIndex((l) => l.code === app.lang);
              app.changeLang(LANGS[(idx + 1) % LANGS.length].code);
            }}
            hitSlop={8}
          >
            <Text style={styles.langBtn}>
              🌐 {LANGS.find((l) => l.code === app.lang)?.label} ▾
            </Text>
          </Pressable>
        </View>
        <Text style={[S.h1, { marginTop: 6 }]}>{tr('app.name')}</Text>
        <Text style={S.small}>{tr('app.notOfficial')}</Text>

        {step === 'choose' && (
          <View style={{ marginTop: 28, gap: 14 }}>
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
          <View style={{ marginTop: 24 }}>
            <Text style={S.h2}>{tr('wallet.wordsTitle')}</Text>
            <View style={styles.wordGrid}>
              {words.map((w, i) => (
                <View key={i} style={styles.wordCell}>
                  <Text style={S.tiny}>{i + 1}</Text>
                  <Text style={styles.word}>{w}</Text>
                </View>
              ))}
            </View>
            <Text style={[S.err, { marginTop: 10 }]}>{tr('wallet.wordsWarn')}</Text>
            <Text style={[S.small, { marginTop: 10 }]}>
              {tr('wallet.address')}: {pending.address}
            </Text>
            <Pressable
              style={[S.bigBtn, { marginTop: 18 }]}
              onPress={() => setStep('unlockSetup')}
            >
              <Text style={S.bigBtnText}>{tr('wallet.savedIt')}</Text>
            </Pressable>
          </View>
        )}

        {step === 'import' && (
          <View style={{ marginTop: 24 }}>
            <Text style={S.h2}>{tr('wallet.import')}</Text>
            <TextInput
              style={[S.input, styles.importBox, { marginTop: 12 }]}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              value={importText}
              onChangeText={setImportText}
              placeholder={tr('wallet.pasteWords')}
            />
            {importErr ? (
              <Text style={[S.err, { marginTop: 8 }]}>{importErr}</Text>
            ) : null}
            <Pressable style={[S.bigBtn, { marginTop: 16 }]} onPress={doImport}>
              <Text style={S.bigBtnText}>{tr('wallet.importBtn')}</Text>
            </Pressable>
            <Pressable
              style={[S.ghostBtn, { marginTop: 10 }]}
              onPress={() => setStep('choose')}
            >
              <Text style={S.ghostBtnText}>{tr('common.back')}</Text>
            </Pressable>
          </View>
        )}

        {step === 'unlockSetup' && pending && (
          <View style={{ marginTop: 24 }}>
            <Text style={S.h2}>{tr('wallet.setupTitle')}</Text>
            <Text style={[S.small, { marginTop: 6 }]}>
              {tr('wallet.address')}: {pending.address}
            </Text>
            <Text style={[S.body, { marginTop: 16 }]}>{tr('wallet.chooseUnlock')}</Text>
            {bioOk && (
              <Pressable
                style={[styles.methodRow, method === 'biometric' && styles.methodOn]}
                onPress={() => setMethod('biometric')}
              >
                <Text style={S.body}>{tr('wallet.unlockBio')}</Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.methodRow, method === 'password' && styles.methodOn]}
              onPress={() => setMethod('password')}
            >
              <Text style={S.body}>{tr('wallet.unlockPw')}</Text>
            </Pressable>
            {method === 'password' && (
              <View style={{ marginTop: 12, gap: 10 }}>
                <TextInput
                  style={S.input}
                  secureTextEntry
                  value={pw}
                  onChangeText={setPw}
                  placeholder={tr('wallet.pwPh')}
                />
                <TextInput
                  style={S.input}
                  secureTextEntry
                  value={pw2}
                  onChangeText={setPw2}
                  placeholder={tr('wallet.pw2Ph')}
                />
              </View>
            )}
            {pwErr ? <Text style={[S.err, { marginTop: 8 }]}>{pwErr}</Text> : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 18 }, busy && S.disabled]}
              disabled={busy}
              onPress={finish}
            >
              <Text style={S.bigBtnText}>{tr('wallet.done')}</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  langBtn: { fontSize: 13.5, color: '#536471', marginStart: 12, paddingVertical: 4 },
  langOn: { color: '#0f1419', fontWeight: '700', textDecorationLine: 'underline' },
  // direction:'ltr' on purpose (v0.3.9): secret-word order is the
  // secret — the numbered grid reads left-to-right in every
  // language, Persian included.
  wordGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12, direction: 'ltr' },
  wordCell: {
    width: '31%',
    borderWidth: 1,
    borderColor: '#eff3f4',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#f7f9f9',
  },
  word: { fontSize: 15, fontWeight: '600', color: '#0f1419' },
  // Pasted secret words / keys are Latin text; keep the box LTR
  // even in a mirrored layout (v0.3.9).
  importBox: { minHeight: 110, textAlignVertical: 'top', writingDirection: 'ltr', textAlign: 'left' },
  methodRow: {
    borderWidth: 1,
    borderColor: '#cfd9de',
    borderRadius: 10,
    padding: 13,
    marginTop: 10,
  },
  methodOn: { borderColor: '#e8590c', backgroundColor: '#fff7f2' },
});
