import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import { S } from '../components/ui';

export default function UnlockScreen() {
  const app = useApp();
  const [failed, setFailed] = useState(false);
  const [tried, setTried] = useState(false);

  const attempt = async () => {
    setFailed(false);
    const ok = await app.unlock();
    setTried(true);
    if (!ok) setFailed(true);
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
      <Text style={{ fontSize: 48 }}>🐦</Text>
      <Text style={[S.h1, { marginTop: 10 }]}>{tr('app.name')}</Text>
      <Text style={[S.body, { marginTop: 6 }]}>{tr('unlock.title')}</Text>
      {app.address ? (
        <Text style={[S.small, { marginTop: 6 }]}>
          {app.address.slice(0, 10)}…{app.address.slice(-6)}
        </Text>
      ) : null}
      <View style={{ height: 22 }} />
      <Pressable style={[S.bigBtn, { alignSelf: 'stretch' }]} onPress={attempt}>
        <Text style={S.bigBtnText}>
          {app.unlockMethod === 'password' ? tr('unlock.open') : tr('unlock.bio')}
        </Text>
      </Pressable>
      {failed && app.unlockMethod === 'password' ? (
        <Text style={[S.err, { marginTop: 12 }]}>{tr('unlock.wrong')}</Text>
      ) : null}
      {failed && app.unlockMethod === 'biometric' && tried ? (
        <Text style={[S.small, { marginTop: 12 }]}>{tr('unlock.title')}</Text>
      ) : null}
    </SafeAreaView>
  );
}
