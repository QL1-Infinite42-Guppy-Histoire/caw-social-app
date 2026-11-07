import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { AppLogo, PasswordPrompt, S } from './src/components/ui';
import OnboardingScreen from './src/screens/OnboardingScreen';
import UnlockScreen from './src/screens/UnlockScreen';
import TimelineScreen from './src/screens/TimelineScreen';
import GetNameScreen from './src/screens/GetNameScreen';
import MyNamesScreen from './src/screens/MyNamesScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import ComposeScreen from './src/screens/ComposeScreen';
import PostDetailScreen from './src/screens/PostDetailScreen';
import { HuntersSwapModal } from './src/screens/HuntersSwapScreen';
import InboxScreen from './src/screens/InboxScreen';
import { loadSeen, scanReactions } from './src/lib/inbox';
import { storeKV } from './src/lib/stores';

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
  const { address, myTokens } = useApp();
  const [inboxOpen, setInboxOpen] = useState(false);
  /* Unread-reaction bell (v0.3.7): the v0.3.4 Home mini header
   * duplicated this app header ("CAW Social" twice), so the mini
   * header is gone and the bell lives HERE, next to the language
   * selector — always visible at the top, no scrolling. The badge
   * machinery is unchanged from v0.3.4: the count is exactly what
   * the inbox will show (loadSeen + scanReactions), refreshed on
   * mount, when my names change, and after the inbox closes (the
   * inbox marks everything seen, so the count drops to zero). */
  const [unread, setUnread] = useState(0);
  const badgeBusyRef = useRef(false);
  const refreshBadge = useCallback(async () => {
    if (!address || myTokens.length === 0) {
      setUnread(0);
      return;
    }
    if (badgeBusyRef.current) return;
    badgeBusyRef.current = true;
    try {
      const myIds = new Set(myTokens.map((t) => t.id.toString()));
      const seen = await loadSeen(storeKV, address);
      const r = await scanReactions(myIds, seen);
      setUnread(r.items.length);
    } catch {
      /* keep the last count; the next refresh retries */
    } finally {
      badgeBusyRef.current = false;
    }
  }, [address, myTokens]);

  useEffect(() => {
    refreshBadge();
  }, [refreshBadge]);

  const wasInboxOpenRef = useRef(false);
  useEffect(() => {
    if (wasInboxOpenRef.current && !inboxOpen) refreshBadge();
    wasInboxOpenRef.current = inboxOpen;
  }, [inboxOpen, refreshBadge]);

  return (
    <View style={styles.header}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
        <AppLogo size={34} />
        <View>
          <Text style={styles.brand}>{tr('app.name')}</Text>
          <Text style={S.tiny}>{tr('app.tagline')}</Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Pressable
          onPress={() => setInboxOpen(true)}
          hitSlop={8}
          style={({ pressed }) => [
            styles.bellBtn,
            pressed && { backgroundColor: '#e3e8ea' },
          ]}
          accessibilityLabel={tr('inbox.title')}
        >
          <Text style={{ fontSize: 19 }}>🔔</Text>
          {unread > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {unread > 99 ? '99+' : String(unread)}
              </Text>
            </View>
          ) : null}
        </Pressable>
        <LangToggle />
      </View>
      <Modal
        visible={inboxOpen}
        animationType="slide"
        onRequestClose={() => setInboxOpen(false)}
      >
        <InboxScreen onClose={() => setInboxOpen(false)} />
      </Modal>
    </View>
  );
}

// Height of the bottom tab bar below: navItem paddingVertical 12+12
// plus the ~17px label line, plus the 1px top border.
const TAB_BAR_HEIGHT = 42;

function Main() {
  const app = useApp();
  const insets = useSafeAreaInsets();
  // HuntersSwap opens from the tab bar's center action button. It is
  // an ACTION, not a tab: opening/closing it never changes `tab`.
  const [hsOpen, setHsOpen] = React.useState(false);
  const {
    tab,
    setTab,
    profileName,
    closeProfile,
    composeOpen,
    openCompose,
    closeCompose,
    postDetail,
    closePost,
  } = app;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (hsOpen) {
        setHsOpen(false);
        return true;
      }
      if (composeOpen) {
        closeCompose();
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
  }, [hsOpen, composeOpen, profileName, postDetail, closeCompose, closeProfile, closePost]);

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
          onPress={() => openCompose()}
        >
          <Text style={styles.fabText}>✎</Text>
        </Pressable>
      )}
      <View style={styles.bottomNav}>
        {tabs.slice(0, 2).map((t) => (
          <Pressable
            key={t.key}
            style={styles.navItem}
            onPress={() => setTab(t.key)}
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.75}
              style={[
                styles.navLabel,
                tab === t.key && styles.navLabelOn,
              ]}
            >
              {t.label}
            </Text>
          </Pressable>
        ))}
        {/* Center action (v0.3.2): a raised orange circle that opens
            HuntersSwap. It only opens the modal — the selected tab
            underneath does not change. The circle rises ABOVE the
            bar (negative margin), so it never collides with the
            Android system navigation below the bar. */}
        <View style={styles.navItemCenter}>
          <Pressable
            accessibilityLabel={tr('hs.trade')}
            accessibilityRole="button"
            style={({ pressed }) => [styles.tradeBtn, pressed && { opacity: 0.75 }]}
            onPress={() => setHsOpen(true)}
          >
            <Text style={styles.tradeBtnText}>⇄</Text>
          </Pressable>
        </View>
        {tabs.slice(2).map((t) => (
          <Pressable
            key={t.key}
            style={styles.navItem}
            onPress={() => setTab(t.key)}
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.75}
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
      <HuntersSwapModal visible={hsOpen} onClose={() => setHsOpen(false)} />

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
        onRequestClose={closeCompose}
      >
        <ComposeScreen onClose={closeCompose} />
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
        <AppLogo size={56} />
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
  bellBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#eff3f4',
    backgroundColor: '#f7f9f9',
  },
  badge: {
    position: 'absolute',
    top: -5,
    // Logical end (v0.3.9 RTL): the badge hugs the bell's outer
    // top corner — right in LTR, left when mirrored for Persian.
    end: -5,
    minWidth: 19,
    height: 19,
    borderRadius: 10,
    paddingHorizontal: 5,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  badgeText: { fontSize: 10.5, fontWeight: '800', color: '#fff' },
  langCycle: { paddingVertical: 6, paddingHorizontal: 8, marginStart: 8 },
  langCycleText: { fontSize: 13.5, color: '#536471', fontWeight: '600' },
  bottomNav: {
    flexDirection: 'row',
    // v0.3.6: a visible frame for the bar — the old #eff3f4
    // hairline was effectively invisible, so timeline content
    // visually ran into the labels. Solid white + a deeper top
    // border + a subtle UPWARD shadow read as a distinct bar.
    // (A floating rounded pill was rejected: it would fight the
    // safe-area handling and the compose FAB's bottom offset,
    // which is computed from TAB_BAR_HEIGHT.)
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    backgroundColor: '#fff',
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: -2 },
    zIndex: 10,
  },
  navItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  // The center slot is narrower than the label slots so the four
  // labels get the room; the 56px circle still fits inside it on
  // standard-width phones and never overlaps a label.
  navItemCenter: { flex: 0.8, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  navLabel: {
    fontSize: 12,
    color: '#536471',
    fontWeight: '600',
    textAlign: 'center',
    width: '100%',
    paddingHorizontal: 2,
  },
  navLabelOn: { color: ACCENT, fontWeight: '800' },
  tradeBtn: {
    // Absolutely positioned inside its (normal-height) tab slot, so
    // the bar keeps its usual height (TAB_BAR_HEIGHT stays valid
    // and the compose FAB offset is untouched) while the circle
    // floats above the bar: top -22 -> spans y -22..34 of the 42px
    // bar, never reaching the system navigation underneath.
    position: 'absolute',
    top: -22,
    // Physical left/marginLeft on purpose: the math (50% - half
    // the width) centers the circle in BOTH layout directions,
    // so the center tab button stays exactly centered under RTL.
    left: '50%',
    marginLeft: -28,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#fff',
    elevation: 5,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  tradeBtnText: { color: '#fff', fontSize: 25, lineHeight: 28, fontWeight: '800' },
  fab: {
    position: 'absolute',
    // Logical end (v0.3.9 RTL): bottom-right in LTR, bottom-left
    // when the layout mirrors for Persian.
    end: 18,
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
