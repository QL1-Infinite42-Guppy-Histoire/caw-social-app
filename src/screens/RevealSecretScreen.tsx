/**
 * Secret reveal (v0.3.1) — MetaMask's ceremony, faithfully:
 *
 *   phrase: pick wallet -> intro -> 2-question quiz -> app
 *           password -> blurred reveal (decoy words underneath)
 *   key:    pick wallet -> app password -> blurred reveal
 *
 * The gate is ALWAYS the app password (walletStore.verifyPassword)
 * — biometrics alone never reveals. Biometric-only users have no
 * password verifier: they set one in-flow first (setPasswordVerifier)
 * and that password becomes the gate. Secrets are loaded through
 * gatedReveal (lib/reveal.ts) only after the password checks out,
 * live in this screen's state only, and are wiped on close and
 * auto-hidden after 60 s.
 */
import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LTR_TEXT, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';

import { nextChevron } from '../lib/rtl';
import {
  REVEAL_AUTO_HIDE_MS,
  gatedReveal,
  makeDecoyKey,
  makeDecoyWords,
  quizInitial,
  quizReduce,
  type QuizState,
} from '../lib/reveal';
import { normalizePhrase, privateKeyOf } from '../lib/wallet';
import {
  hasPasswordVerifier,
  loadWalletSecret,
  setPasswordVerifier,
  verifyPassword,
  type WalletPublicInfo,
} from '../lib/walletStore';

type Step =
  | 'pick'
  | 'choice'
  | 'noPhrase'
  | 'intro'
  | 'quiz'
  | 'password'
  | 'setup'
  | 'reveal';

export default function RevealSecretScreen({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<Step>('pick');
  const [wallet, setWallet] = useState<WalletPublicInfo | null>(null);
  const [mode, setMode] = useState<'phrase' | 'key'>('phrase');
  const [quiz, setQuiz] = useState<QuizState>(quizInitial);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [secretText, setSecretText] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wipe = useCallback(() => {
    setSecretText(null);
    setRevealed(false);
    setPw('');
    setPw2('');
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  /* Auto re-hide 60 s after each reveal. */
  useEffect(() => {
    if (!revealed) return;
    hideTimer.current = setTimeout(() => setRevealed(false), REVEAL_AUTO_HIDE_MS);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [revealed]);

  const chooseWallet = (w: WalletPublicInfo) => {
    setWallet(w);
    setErr('');
    setStep('choice');
  };

  const chooseMode = async (m: 'phrase' | 'key') => {
    if (!wallet) return;
    setMode(m);
    setErr('');
    if (m === 'phrase' && wallet.kind === 'privateKey') {
      setStep('noPhrase');
      return;
    }
    if (m === 'phrase') {
      setQuiz(quizInitial);
      setStep('intro');
      return;
    }
    await goPassword();
  };

  /** Password step entry: verifier exists -> enter it; biometric-
   *  only users (no verifier) -> set one first. */
  const goPassword = async () => {
    const has = await hasPasswordVerifier().catch(() => false);
    setPw('');
    setPw2('');
    setErr('');
    setStep(has ? 'password' : 'setup');
  };

  const onQuizDone = async () => {
    await goPassword();
  };

  useEffect(() => {
    if (quiz.phase === 'done' && step === 'quiz') {
      onQuizDone();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quiz.phase, step]);

  /** Load the secret through the gate, then show the reveal step. */
  const unlockAndReveal = async (password: string) => {
    if (!wallet) return;
    setBusy(true);
    setErr('');
    try {
      const loaded = await gatedReveal(
        () => verifyPassword(password),
        () => loadWalletSecret(wallet.address),
      );
      if (!loaded) {
        setErr(tr('reveal.wrongPw'));
        return;
      }
      const text =
        mode === 'phrase'
          ? normalizePhrase(loaded.secret)
          : privateKeyOf(loaded.kind, loaded.secret);
      setSecretText(text);
      setRevealed(false);
      setCopied(false);
      setPw('');
      setStep('reveal');
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async () => {
    if (pw.length === 0 || busy) return;
    await unlockAndReveal(pw);
  };

  const submitSetup = async () => {
    if (busy) return;
    if (pw.length < 6) {
      setErr(tr('wallet.pwShort'));
      return;
    }
    if (pw !== pw2) {
      setErr(tr('wallet.pwMismatch'));
      return;
    }
    setBusy(true);
    try {
      await setPasswordVerifier(pw);
    } finally {
      setBusy(false);
    }
    // The just-set password is now the gate — verify through the
    // same path as everyone else.
    await unlockAndReveal(pw);
  };

  const doCopy = async () => {
    if (!revealed || !secretText) return;
    await Clipboard.setStringAsync(secretText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const close = () => {
    wipe();
    onClose();
  };

  const realWords =
    mode === 'phrase' && secretText ? secretText.split(' ') : [];
  // Decoys are frozen per secret so re-renders never flicker them.
  const decoyWords = React.useMemo(
    () =>
      mode === 'phrase' && secretText
        ? makeDecoyWords(realWords, realWords.length)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [secretText, mode],
  );
  const decoyKey = React.useMemo(
    () => (mode === 'key' && secretText ? makeDecoyKey(secretText) : ''),
    [secretText, mode],
  );

  const quizKeys = (
    quiz.qIdx === 0
      ? { q: 'reveal.q1', a: 'reveal.q1a', b: 'reveal.q1b', fb: 'reveal.q1Feedback' }
      : { q: 'reveal.q2', a: 'reveal.q2a', b: 'reveal.q2b', fb: 'reveal.q2Feedback' }
  ) as {
    q: 'reveal.q1' | 'reveal.q2';
    a: 'reveal.q1a' | 'reveal.q2a';
    b: 'reveal.q1b' | 'reveal.q2b';
    fb: 'reveal.q1Feedback' | 'reveal.q2Feedback';
  };

  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <View style={[S.row, { paddingHorizontal: 16, paddingVertical: 10, justifyContent: 'space-between' }]}>
        <Text style={S.h1}>{tr('reveal.title')}</Text>
        <Pressable onPress={close} style={S.ghostBtn}>
          <Text style={S.ghostBtnText}>{tr('common.close')}</Text>
        </Pressable>
      </View>

      <ScrollView style={S.screen} contentContainerStyle={[S.scrollPad, { paddingBottom: 32 + insets.bottom }]}>
        {step === 'pick' ? (
          <>
            <Text style={S.h2}>{tr('reveal.pickWallet')}</Text>
            {app.wallets.map((w) => (
              <Pressable
                key={w.address}
                style={{ borderWidth: 1, borderColor: '#e5e5e5', borderRadius: 14, padding: 14, marginTop: 10, flexDirection: 'row', alignItems: 'center' }}
                onPress={() => chooseWallet(w)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[S.body, { fontWeight: '700' }]}>
                    {w.address.slice(0, 10)}…{w.address.slice(-6)}
                  </Text>
                  <Text style={[S.small, { marginTop: 4 }]}>
                    {w.kind === 'mnemonic' ? tr('reveal.phrase') : tr('reveal.key')}
                  </Text>
                </View>
                <Text style={{ fontSize: 17, color: '#536471' }}>{nextChevron()}</Text>
              </Pressable>
            ))}
          </>
        ) : null}

        {step === 'choice' && wallet ? (
          <>
            <Text style={S.h2}>
              {wallet.address.slice(0, 10)}…{wallet.address.slice(-6)}
            </Text>
            <Pressable style={[S.bigBtn, { marginTop: 16 }]} onPress={() => chooseMode('phrase')}>
              <Text style={S.bigBtnText}>{tr('reveal.phrase')}</Text>
            </Pressable>
            <Pressable style={[S.bigBtn, { marginTop: 12 }]} onPress={() => chooseMode('key')}>
              <Text style={S.bigBtnText}>{tr('reveal.key')}</Text>
            </Pressable>
          </>
        ) : null}

        {step === 'noPhrase' ? (
          <>
            <Text style={S.h2}>{tr('reveal.noPhraseTitle')}</Text>
            <View style={S.cardBox}>
              <Text style={S.body}>{tr('reveal.noPhraseBody')}</Text>
            </View>
            <Pressable style={[S.bigBtn, { marginTop: 18 }]} onPress={() => chooseMode('key')}>
              <Text style={S.bigBtnText}>{tr('reveal.key')}</Text>
            </Pressable>
          </>
        ) : null}

        {step === 'intro' ? (
          <>
            <Text style={S.h2}>{tr('reveal.introTitle')}</Text>
            <View style={S.cardBox}>
              <Text style={[S.body, { lineHeight: 22 }]}>{tr('reveal.introBody')}</Text>
            </View>
            <Pressable style={[S.bigBtn, { marginTop: 18 }]} onPress={() => setStep('quiz')}>
              <Text style={S.bigBtnText}>{tr('reveal.start')}</Text>
            </Pressable>
          </>
        ) : null}

        {step === 'quiz' ? (
          <>
            <Text style={[S.body, { fontWeight: '700', lineHeight: 24 }]}>{tr(quizKeys.q)}</Text>
            {quiz.phase === 'asking' ? (
              <>
                {[quizKeys.a, quizKeys.b].map((k, i) => (
                  <Pressable
                    key={k}
                    style={{
                      borderWidth: 2,
                      borderColor: quiz.wrong ? '#d64541' : '#e5e5e5',
                      borderRadius: 14,
                      padding: 14,
                      marginTop: 12,
                    }}
                    onPress={() => setQuiz((q) => quizReduce(q, { type: 'answer', choice: i }))}
                  >
                    <Text style={S.body}>{tr(k)}</Text>
                  </Pressable>
                ))}
                {quiz.wrong ? (
                  <Text style={[S.err, { marginTop: 12 }]}>{tr('reveal.wrong')}</Text>
                ) : null}
              </>
            ) : (
              <>
                <View style={{ backgroundColor: '#eef7ee', borderRadius: 14, padding: 14, marginTop: 14 }}>
                  <Text style={[S.body, { lineHeight: 22 }]}>{tr(quizKeys.fb)}</Text>
                </View>
                <Pressable
                  style={[S.bigBtn, { marginTop: 16 }]}
                  onPress={() => setQuiz((q) => quizReduce(q, { type: 'next' }))}
                >
                  <Text style={S.bigBtnText}>{tr('reveal.continue')}</Text>
                </Pressable>
              </>
            )}
          </>
        ) : null}

        {step === 'password' ? (
          <>
            <Text style={S.h2}>{tr('reveal.pwTitle')}</Text>
            <View style={S.cardBox}>
              <Text style={[S.body, { lineHeight: 22 }]}>{tr('reveal.pwBody')}</Text>
            </View>
            <TextInput
              style={[S.input, { marginTop: 14 }]}
              value={pw}
              onChangeText={setPw}
              secureTextEntry
              placeholder={tr('reveal.pwTitle')}
              autoCapitalize="none"
            />
            {err ? <Text style={[S.err, { marginTop: 10 }]}>{err}</Text> : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 16 }, (busy || pw.length === 0) && { opacity: 0.5 }]}
              disabled={busy || pw.length === 0}
              onPress={submitPassword}
            >
              <Text style={S.bigBtnText}>{tr('reveal.unlock')}</Text>
            </Pressable>
          </>
        ) : null}

        {step === 'setup' ? (
          <>
            <Text style={S.h2}>{tr('reveal.setupTitle')}</Text>
            <View style={S.cardBox}>
              <Text style={[S.body, { lineHeight: 22 }]}>{tr('reveal.setupBody')}</Text>
            </View>
            <TextInput
              style={[S.input, { marginTop: 14 }]}
              value={pw}
              onChangeText={setPw}
              secureTextEntry
              placeholder={tr('reveal.newPw')}
              autoCapitalize="none"
            />
            <TextInput
              style={[S.input, { marginTop: 10 }]}
              value={pw2}
              onChangeText={setPw2}
              secureTextEntry
              placeholder={tr('reveal.confirmPw')}
              autoCapitalize="none"
            />
            {err ? <Text style={[S.err, { marginTop: 10 }]}>{err}</Text> : null}
            <Pressable
              style={[S.bigBtn, { marginTop: 16 }, busy && { opacity: 0.5 }]}
              disabled={busy}
              onPress={submitSetup}
            >
              <Text style={S.bigBtnText}>{tr('reveal.continue')}</Text>
            </Pressable>
          </>
        ) : null}

        {step === 'reveal' && secretText ? (
          <>
            <Text style={S.h2}>{tr(mode === 'phrase' ? 'reveal.phraseTitle' : 'reveal.keyTitle')}</Text>
            <Text style={[S.err, { marginTop: 10 }]}>{tr('reveal.lookAround')}</Text>
            <Pressable
              onPress={() => setRevealed((r) => !r)}
              style={{ marginTop: 14, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: '#e5e5e5' }}
            >
              {mode === 'phrase' ? (
                // direction:'ltr' on purpose (v0.3.9): the words'
                // ORDER is the secret — the numbered grid must
                // read 1,2,3… left-to-right even when the rest of
                // the app mirrors for Persian.
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', padding: 10, direction: 'ltr' }}>
                  {(revealed ? realWords : decoyWords).map((w, i) => (
                    <View key={i} style={{ width: '50%', padding: 6 }}>
                      <Text style={[S.body, !revealed && { color: '#9aa0a6' }]}>
                        {i + 1}. {w}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <View style={{ padding: 14 }}>
                  <Text style={[S.body, { fontSize: 13 }, LTR_TEXT, !revealed && { color: '#9aa0a6' }]} selectable={revealed}>
                    {revealed ? secretText : decoyKey}
                  </Text>
                </View>
              )}
              {!revealed ? (
                <View
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: 0,
                    bottom: 0,
                    backgroundColor: 'rgba(255,255,255,0.72)',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={[S.body, { fontWeight: '700', color: ACCENT }]}>
                    {tr('reveal.tapShow')}
                  </Text>
                </View>
              ) : null}
            </Pressable>
            <Text style={[S.small, { marginTop: 8 }]}>
              {revealed ? tr('reveal.tapHide') : ''}
            </Text>
            {revealed ? (
              <>
                <Pressable style={[S.ghostBtn, { marginTop: 10, alignSelf: 'flex-start' }]} onPress={doCopy}>
                  <Text style={S.ghostBtnText}>{copied ? tr('reveal.copied') : tr('reveal.copy')}</Text>
                </Pressable>
                <Text style={[S.small, { marginTop: 8 }]}>{tr('reveal.copyWarn')}</Text>
              </>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
