import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import { AppLogo, S } from '../components/ui';

export default function UnlockScreen() {
  const app = useApp();
  const [failed, setFailed] = useState(false);
  const [tried, setTried] = useState(false);
  /* v0.5.1 (F1): busy feedback while unlock runs — the
   * scrypt verify behind the password prompt takes ~0.5–2 s
   * on device, and with no spinner the screen read as frozen.
   * The ref guards re-entry inside the same tick (the mount
   * auto-attempt plus a fast double tap). */
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const attempt = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const ok = await app.unlock();
      setTried(true);
      if (!ok) setFailed(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (app.unlockMethod === 'biometric') {
      attempt();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SafeAreaView
      style={[S.screen, { alignItems: 'center', justifyContent: 'center', padding: 24 }]}
      edges={['top', 'bottom']}
    >
      <AppLogo size={60} />
      <Text style={[S.h1, { marginTop: 10 }]}>{tr('app.name')}</Text>
      <Text style={[S.body, { marginTop: 6 }]}>{tr('unlock.title')}</Text>
      {app.address ? (
        <Text style={[S.small, { marginTop: 6 }]}>
          {app.address.slice(0, 10)}…{app.address.slice(-6)}
        </Text>
      ) : null}
      <View style={{ height: 22 }} />
      <Pressable
        style={[S.bigBtn, { alignSelf: 'stretch' }, busy && S.disabled]}
        disabled={busy}
        onPress={attempt}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={S.bigBtnText}>
            {app.unlockMethod === 'password' ? tr('unlock.open') : tr('unlock.bio')}
          </Text>
        )}
      </Pressable>
      {busy ? (
        <Text style={[S.small, { marginTop: 12 }]}>{tr('unlock.checking')}</Text>
      ) : null}
      {failed && app.unlockMethod === 'password' ? (
        <Text style={[S.err, { marginTop: 12 }]}>{tr('unlock.wrong')}</Text>
      ) : null}
      {failed && app.unlockMethod === 'biometric' && tried ? (
        <Text style={[S.small, { marginTop: 12 }]}>{tr('unlock.title')}</Text>
      ) : null}
    </SafeAreaView>
  );
}
