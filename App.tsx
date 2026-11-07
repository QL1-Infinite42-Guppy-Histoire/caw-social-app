import React, { useEffect } from 'react';
import {
  BackHandler,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { ACCENT } from './src/config';
import { AppProvider, useApp } from './src/context/AppContext';
import { tr } from './src/i18n';
import { PasswordPrompt, S } from './src/components/ui';
import OnboardingScreen from './src/screens/OnboardingScreen';
import UnlockScreen from './src/screens/UnlockScreen';
import TimelineScreen from './src/screens/TimelineScreen';
import GetNameScreen from './src/screens/GetNameScreen';
import MyNamesScreen from './src/screens/MyNamesScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import ComposeScreen from './src/screens/ComposeScreen';

function LangToggle() {
  const { lang, changeLang } = useApp();
  return (
    <View style={S.row}>
      <Pressable onPress={() => changeLang('en')}>
        <Text style={[styles.langBtn, lang === 'en' && styles.langOn]}>English</Text>
      </Pressable>
      <Pressable onPress={() => changeLang('ja')}>
        <Text style={[styles.langBtn, lang === 'ja' && styles.langOn]}>日本語</Text>
      </Pressable>
    </View>
  );
}

function Header() {
  return (
    <View style={styles.header}>
      <View>
        <Text style={styles.brand}>🐦 {tr('app.name')}</Text>
        <Text style={S.tiny}>{tr('app.tagline')}</Text>
      </View>
      <LangToggle />
    </View>
  );
}

function Main() {
  const app = useApp();
  const { tab, setTab, profileName, closeProfile, composeOpen, setComposeOpen } =
    app;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (composeOpen) {
        setComposeOpen(false);
        return true;
      }
      if (profileName) {
        closeProfile();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [composeOpen, profileName, setComposeOpen, closeProfile]);

  const tabs: { key: typeof tab; label: string }[] = [
    { key: 'home', label: tr('nav.home') },
    { key: 'get', label: tr('nav.getName') },
    { key: 'mine', label: tr('nav.myNames') },
    { key: 'settings', label: tr('nav.settings') },
  ];

  return (
    <SafeAreaView style={S.screen} edges={['top', 'bottom']}>
      <Header />
      <View style={{ flex: 1 }}>
        {tab === 'home' && <TimelineScreen />}
        {tab === 'get' && <GetNameScreen />}
        {tab === 'mine' && <MyNamesScreen />}
        {tab === 'settings' && <SettingsScreen />}
      </View>
      {tab === 'home' && !profileName && (
        <Pressable style={styles.fab} onPress={() => setComposeOpen(true)}>
          <Text style={styles.fabText}>✎</Text>
        </Pressable>
      )}
      <View style={styles.bottomNav}>
        {tabs.map((t) => (
          <Pressable
            key={t.key}
            style={styles.navItem}
            onPress={() => setTab(t.key)}
          >
            <Text
              style={[
                styles.navLabel,
                tab === t.key && styles.navLabelOn,
              ]}
            >
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Modal
        visible={!!profileName}
        animationType="slide"
        onRequestClose={closeProfile}
      >
        {profileName ? (
          <ProfileScreen username={profileName} onBack={closeProfile} />
        ) : null}
      </Modal>
      <Modal
        visible={composeOpen}
        animationType="slide"
        onRequestClose={() => setComposeOpen(false)}
      >
        <ComposeScreen onClose={() => setComposeOpen(false)} />
      </Modal>
    </SafeAreaView>
  );
}

function Shell() {
  const app = useApp();
  let content: React.ReactNode;
  if (!app.ready) {
    content = (
      <SafeAreaView style={[S.screen, styles.center]}>
        <Text style={{ fontSize: 44 }}>🐦</Text>
        <Text style={S.h1}>{tr('app.name')}</Text>
        <Text style={S.small}>{tr('common.loading')}</Text>
      </SafeAreaView>
    );
  } else if (!app.hasWallet) {
    content = <OnboardingScreen />;
  } else if (app.locked) {
    content = <UnlockScreen />;
  } else {
    content = <Main />;
  }
  return (
    <>
      <StatusBar style="dark" />
      {content}
      <PasswordPrompt
        visible={!!app.pwPrompt}
        onAnswer={(pw) => {
          app.answerPwPrompt(pw);
        }}
      />
    </>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <Shell />
      </AppProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', gap: 8 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
    backgroundColor: '#fff',
  },
  brand: { fontSize: 19, fontWeight: '800', color: '#0f1419' },
  langBtn: { fontSize: 13.5, color: '#536471', marginLeft: 12, paddingVertical: 4 },
  langOn: { color: '#0f1419', fontWeight: '700', textDecorationLine: 'underline' },
  bottomNav: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#eff3f4',
    backgroundColor: '#fff',
  },
  navItem: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  navLabel: { fontSize: 12.5, color: '#536471', fontWeight: '600' },
  navLabelOn: { color: ACCENT, fontWeight: '800' },
  fab: {
    position: 'absolute',
    right: 18,
    bottom: 76,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  fabText: { color: '#fff', fontSize: 24, lineHeight: 26 },
});
