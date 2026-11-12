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
import { tr } from './src/i18n';
import {
  AppLogo,
  Avatar,
  BellIcon,
  HomeIcon,
  PasswordPrompt,
  S,
  SearchIcon,
  UserIcon,
} from './src/components/ui';
import OnboardingScreen from './src/screens/OnboardingScreen';
import UnlockScreen from './src/screens/UnlockScreen';
import TimelineScreen from './src/screens/TimelineScreen';
import MeScreen from './src/screens/MeScreen';
import SearchScreen from './src/screens/SearchScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import ComposeScreen from './src/screens/ComposeScreen';
import PostDetailScreen from './src/screens/PostDetailScreen';
import InboxScreen from './src/screens/InboxScreen';
import { loadSeen, scanReactions } from './src/lib/inbox';
import { storeKV } from './src/lib/stores';

/**
 * The app header (v0.6.1, X-style finish): as spare as X's
 * own — the active name's avatar at the start (tap → the
 * Profile hub), a small centered CAW mark, and the reactions
 * bell at the end, now a vector icon (the emoji bell button
 * of v0.6.0 and earlier is gone). The unread badge machinery is
 * the v0.3.4 one, unchanged: the count is exactly what the
 * inbox will show (loadSeen + scanReactions), refreshed on
 * mount, when my names change, and after the inbox closes.
 *
 * What the pre-v0.6.1 header carried, and where it went:
 *  - brand block ("CAW Social ▾ / QL1版") + name-card overlay:
 *    retired. The card's contents all live on the Profile
 *    hub now — profile summary (tap → the profile), the
 *    prominent deposited-CAW card, the full balance grid one
 *    tap deeper (hub → Wallet), the copyable address chip on
 *    the summary, the inbox entry (hub row + this bell).
 *  - language cycle button (globe emoji): retired. The full language
 *    list lives in the hub's Settings section, as it always
 *    has — Settings → Language.
 */
function Header() {
  const { address, myTokens, actingId, customFor, setTab } = useApp();
  const [inboxOpen, setInboxOpen] = useState(false);
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

  const acting =
    myTokens.find((t) => t.id === actingId) ?? myTokens[0] ?? null;
  const custom = acting ? customFor(acting.id) : undefined;

  return (
    <View style={styles.header}>
      <Pressable
        onPress={() => setTab('profile')}
        hitSlop={6}
        style={({ pressed }) => [
          styles.headerSide,
          pressed && { opacity: 0.7 },
        ]}
        accessibilityRole="button"
        accessibilityLabel={tr('nav.profile')}
      >
        {acting ? (
          <Avatar
            nameId={acting.id}
            size={32}
            customUri={custom?.avatarPath}
          />
        ) : (
          <View style={styles.headerAvatarFallback}>
            <UserIcon size={18} color="#536471" />
          </View>
        )}
      </Pressable>
      <View style={styles.headerMark} pointerEvents="none">
        <AppLogo size={20} />
        <Text style={styles.headerWord}>CAW</Text>
      </View>
      <View style={styles.headerSideEnd}>
        <Pressable
          onPress={() => setInboxOpen(true)}
          hitSlop={8}
          style={({ pressed }) => [
            styles.bellBtn,
            pressed && { backgroundColor: '#e3e8ea' },
          ]}
          accessibilityRole="button"
          accessibilityLabel={tr('inbox.title')}
        >
          <BellIcon size={21} color="#0f1419" />
          {unread > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {unread > 99 ? '99+' : String(unread)}
              </Text>
            </View>
          ) : null}
        </Pressable>
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

// Height of the bottom tab bar below: navItem paddingVertical
// 10+10 plus the 22px icon line, plus the 1px top border —
// v0.6.0 made the X-style bar icon-only (no label line). Only
// the compose FAB offset consumes this number.
const TAB_BAR_HEIGHT = 44;

function Main() {
  const app = useApp();
  const insets = useSafeAreaInsets();
  // v0.6.0: HuntersExchange no longer opens from a tab-bar
  // center button — it is an entry on the Profile hub
  // (MeScreen mounts the modal). Nothing about the exchange
  // itself changed.
  // v0.6.1: the name-card overlay is retired with the old
  // header — everything it showed lives on the Profile hub
  // (see the Header note above for the mapping).
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
  }, [composeOpen, profileName, postDetail, closeCompose, closeProfile, closePost]);

  /* Tabs (v0.6.0, X-style overhaul): exactly three —
   * Home / Search / Profile — ICON-ONLY, like the mock's
   * minimal bar. The labels survive as accessibility labels
   * (screen readers still announce them). Everything that
   * lived on the removed tabs (Get a name, My names,
   * Settings, the wallet card, HuntersExchange) is reachable
   * from the Profile hub screen; the reachability map is in
   * the v0.6.0 release notes and pinned by
   * scripts/verify-xui.mjs. No DM tab, no Notifications tab
   * (the stretch derivation did not verify complete — see
   * the release report). */
  const tabs: {
    key: typeof tab;
    label: string;
    Icon: React.ComponentType<{ size?: number; color?: string }>;
  }[] = [
    { key: 'home', label: tr('nav.home'), Icon: HomeIcon },
    { key: 'search', label: tr('nav.search'), Icon: SearchIcon },
    { key: 'profile', label: tr('nav.profile'), Icon: UserIcon },
  ];
  const renderTab = (t: (typeof tabs)[number]) => (
    <Pressable
      key={t.key}
      style={styles.navItem}
      onPress={() => setTab(t.key)}
      accessibilityRole="button"
      accessibilityLabel={t.label}
    >
      <t.Icon color={tab === t.key ? ACCENT : '#536471'} />
    </Pressable>
  );

  return (
    <SafeAreaView style={S.screen} edges={['top', 'bottom']}>
      <Header />
      <View style={{ flex: 1 }}>
        {tab === 'home' && <TimelineScreen />}
        {tab === 'search' && <SearchScreen />}
        {tab === 'profile' && <MeScreen />}
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
          <Text style={styles.fabText}>+</Text>
        </Pressable>
      )}
      <View style={styles.bottomNav}>{tabs.map(renderTab)}</View>

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
        busy={app.pwBusy}
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
  headerSide: {
    width: 44,
    height: 40,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  headerSideEnd: {
    width: 44,
    height: 40,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  headerAvatarFallback: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#eff3f4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerMark: {
    position: 'absolute',
    start: 0,
    end: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  headerWord: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0f1419',
    letterSpacing: 0.5,
  },
  bellBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
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
  // v0.6.0: the bar is icon-only (22px icon + 10+10 padding +
  // the 1px top border = TAB_BAR_HEIGHT 44). The bottom
  // safe-area inset is still the SafeAreaView's job (edges),
  // so gesture-nav and 3-button-nav devices get exactly one
  // inset, as before — nothing here adds bottom padding of
  // its own.
  navItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10 },
  // v0.6.0: the label styles and the raised center trade
  // button styles left with the features they styled (labels
  // are accessibility-only now; HuntersExchange opens from
  // the Profile hub).
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
