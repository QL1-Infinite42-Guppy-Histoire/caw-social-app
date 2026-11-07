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
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { ACCENT } from './src/config';
import { AppProvider, useApp } from './src/context/AppContext';
import { LANGS, tr } from './src/i18n';
import { PasswordPrompt, S } from './src/components/ui';
import OnboardingScreen from './src/screens/OnboardingScreen';
import UnlockScreen from './src/screens/UnlockScreen';
import TimelineScreen from './src/screens/TimelineScreen';
import GetNameScreen from './src/screens/GetNameScreen';
import MyNamesScreen from './src/screens/MyNamesScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import ComposeScreen from './src/screens/ComposeScreen';
import PostDetailScreen from './src/screens/PostDetailScreen';

function LangToggle() {
  const { lang, changeLang } = useApp();
  // Five languages no longer fit as a row of buttons in the header.
  // One compact button showing the current language; tapping cycles
  // to the next. The full list lives in Settings.
  const idx = LANGS.findIndex((l) => l.code === lang);
  const cur = LANGS[idx >= 0 ? idx : 0];
  const next = LANGS[(idx + 1) % LANGS.length];
  return (
    <Pressable
      onPress={() => changeLang(next.code)}
      hitSlop={8}
      style={({ pressed }) => [styles.langCycle, pressed && { opacity: 0.6 }]}
    >
      <Text style={styles.langCycleText}>🌐 {cur.label} ▾</Text>
    </Pressable>
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

// Height of the bottom tab bar below: navItem paddingVertical 12+12
// plus the ~17px label line, plus the 1px top border.
const TAB_BAR_HEIGHT = 42;

function Main() {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const {
    tab,
    setTab,
    profileName,
    closeProfile,
    composeOpen,
    setComposeOpen,
    postDetail,
    closePost,
  } = app;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (composeOpen) {
        setComposeOpen(false);
        return true;
      }
      if (postDetail) {
        closePost();
        return true;
      }
      if (profileName) {
        closeProfile();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [composeOpen, profileName, postDetail, setComposeOpen, closeProfile, closePost]);

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
        <Pressable
          // v0.1.5 fix: the fixed bottom:76 left the compose button
          // straddling the bottom tab bar — its lower half sat under
          // the (later-painted, opaque) bar and was hard to tap.
          // Float it fully above the bar instead: tab-bar height +
          // the device bottom safe-area inset + a clear margin, the
          // same inset pattern as LoadMoreFooter.
          style={[
            styles.fab,
            { bottom: TAB_BAR_HEIGHT + insets.bottom + 14 },
          ]}
          onPress={() => setComposeOpen(true)}
        >
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
        visible={!!postDetail}
        animationType="slide"
        onRequestClose={closePost}
      >
        {postDetail ? (
          <PostDetailScreen post={postDetail} onBack={closePost} />
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
  langCycle: { paddingVertical: 6, paddingHorizontal: 8, marginLeft: 8 },
  langCycleText: { fontSize: 13.5, color: '#536471', fontWeight: '600' },
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
    // bottom is set inline (tab bar + safe-area inset + margin).
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
