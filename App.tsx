import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { ACCENT } from './src/config';
import { AppProvider, useApp } from './src/context/AppContext';
import { LANGS, tr } from './src/i18n';
import {
  AppLogo,
  Avatar,
  BalanceGrid,
  HomeIcon,
  PasswordPrompt,
  S,
  SearchIcon,
  SettingsIcon,
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

function Header({
  onBrandPress,
  cardOpen,
}: {
  onBrandPress?: () => void;
  cardOpen?: boolean;
}) {
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
      {/* v0.4.5: tapping the brand (logo + title) toggles the name
       * card under the header. The bell and the language selector
       * are siblings of this Pressable and keep their own taps. */}
      <Pressable
        onPress={onBrandPress}
        style={({ pressed }) => [
          { flexDirection: 'row', alignItems: 'center', gap: 9 },
          pressed && { opacity: 0.7 },
        ]}
        accessibilityRole="button"
      >
        {/* The logo artwork itself is the app's real asset,
         * untouched — the only addition is the small chevron
         * beside the title text, marking the brand as the
         * name-card toggle. */}
        <AppLogo size={34} />
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={styles.brand}>{tr('app.name')}</Text>
            <Text style={{ fontSize: 11, color: '#536471', fontWeight: '700' }}>
              {cardOpen ? '▴' : '▾'}
            </Text>
          </View>
          <Text style={S.tiny}>{tr('app.tagline')}</Text>
        </View>
      </Pressable>
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

/**
 * The name card (v0.4.5): drops down under the brand header when
 * the brand is tapped. It is an OVERLAY — the feed underneath
 * never moves. Shows the active CAW name the way the Home wallet
 * card does (custom avatar / display name when set, address
 * chip, CAW + QOM balances), a notifications entry (the same
 * inbox as the header bell), and a jump to the profile.
 * Switching the active name deliberately does NOT live here —
 * it belongs to the My Names screen (user decision 2026-11-09).
 * A wallet with no name yet gets the plain state plus the way
 * to the Get-a-name tab.
 */
function NameCard({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const { address, myTokens, actingId, qcaw, qom, f42, cat42, oTok, ket } = app;
  const acting =
    myTokens.find((t) => t.id === actingId) ?? myTokens[0] ?? null;
  const custom = acting ? app.customFor(acting.id) : undefined;
  const [copied, setCopied] = useState(false);
  /* Notifications entry (v0.4.5 addition): the same inbox the
   * header bell opens, with the unread count from the same
   * source (loadSeen + scanReactions). The card stays mounted
   * behind the inbox modal — closing the card first would take
   * the modal down with it. */
  const [unread, setUnread] = useState(0);
  const [inboxOpen, setInboxOpen] = useState(false);
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

  if (!acting) {
    return (
      <View>
        <Text style={S.body}>{tr('mine.none')}</Text>
        <Pressable
          style={[S.bigBtn, { marginTop: 12 }]}
          onPress={() => {
            onClose();
            app.openHub('get');
          }}
        >
          <Text style={S.bigBtnText}>{tr('nav.getName')}</Text>
        </Pressable>
      </View>
    );
  }

  const displayName = custom?.displayName
    ? custom.displayName
    : '@' + acting.username;
  const chipAddress = address
    ? address.slice(0, 6) + '…' + address.slice(-4)
    : '—';

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar
          nameId={acting.id}
          size={52}
          customUri={custom?.avatarPath}
        />
        <View style={{ flex: 1 }}>
          {/* X-style order (user, 2026-11-09): the DISPLAY NAME is
           * the big primary line; the @handle and the name number
           * share the smaller line under it. */}
          <Text style={styles.cardName} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={S.small} numberOfLines={1}>
            {custom?.displayName ? '@' + acting.username + ' · ' : ''}
            {'#' + acting.id.toString()}
          </Text>
          <Pressable
            onPress={async () => {
              if (!address) return;
              await Clipboard.setStringAsync(address);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            style={({ pressed }) => [
              styles.addrChip,
              { alignSelf: 'flex-start', marginTop: 5 },
              pressed && { backgroundColor: '#e3e8ea' },
            ]}
            accessibilityRole="button"
          >
            <Text style={styles.addrChipText}>
              {copied ? '✓' : chipAddress + ' 📋'}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Balances (v0.4.10): the SAME BalanceGrid as the Home
       * wallet card — same cells, same order (the grid's own
       * comment in ui.tsx carries the layout history). The
       * deposited CAW is acting.balance = cawBalanceOf from
       * the same enumeration the profile and My Names read —
       * same source, same freshness. The v0.4.7 unread rule
       * holds inside the grid: the dash, never a 0. The card
       * overlay below still caps its height and this content
       * scrolls inside the card; the header stays outside,
       * untouched. */}
      <View style={{ marginTop: 14 }}>
        <BalanceGrid
          cells={[
            { label: tr('home.qcaw'), unit: 'CAW', raw: qcaw },
            { label: tr('home.qom'), unit: 'QOM', raw: qom },
            { label: tr('card.inName'), unit: 'CAW', raw: acting.balance },
            { label: tr('card.f42'), unit: '42', raw: f42 },
            { label: tr('card.cat42'), unit: 'CAT42', raw: cat42 },
            {
              label: 'O',
              unit: 'O',
              raw: oTok ? oTok.raw : null,
              decimals: oTok ? oTok.decimals : 18,
            },
            {
              label: 'KET',
              unit: 'KET',
              raw: ket ? ket.raw : null,
              decimals: ket ? ket.decimals : 18,
            },
            null,
          ]}
        />
      </View>

      {/* Notifications (v0.4.5 addition): same destination as
       * the header bell, badge only when something is unread. */}
      <Pressable
        onPress={() => setInboxOpen(true)}
        style={({ pressed }) => [
          styles.cardSwitchRow,
          {
            marginTop: 12,
            borderTopWidth: 1,
            borderTopColor: '#eff3f4',
            paddingTop: 12,
          },
          pressed && { backgroundColor: '#f7f9f9' },
        ]}
        accessibilityRole="button"
        accessibilityLabel={tr('inbox.title')}
      >
        <Text style={{ fontSize: 19 }}>🔔</Text>
        <Text style={[S.body, { flex: 1, fontWeight: '700' }]}>
          {tr('inbox.title')}
        </Text>
        {unread > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              {unread > 99 ? '99+' : String(unread)}
            </Text>
          </View>
        ) : null}
      </Pressable>
      <Modal
        visible={inboxOpen}
        animationType="slide"
        onRequestClose={() => setInboxOpen(false)}
      >
        <InboxScreen onClose={() => setInboxOpen(false)} />
      </Modal>

      <Pressable
        style={[S.bigBtn, { marginTop: 14 }]}
        onPress={() => {
          onClose();
          app.openProfile(acting.username);
        }}
      >
        <Text style={S.bigBtnText}>{tr('home.profile')}</Text>
      </Pressable>
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
  // Name card (v0.4.5): dropped from the brand header. Mounted
  // only while open or animating shut; navigating anywhere
  // closes it.
  const [cardOpen, setCardOpen] = useState(false);
  const [cardMounted, setCardMounted] = useState(false);
  const cardAnim = useRef(new Animated.Value(0)).current;
  /* v0.4.8: five balance frames make the name card taller than
   * short screens. The content column's measured height caps the
   * card (its ScrollView then scrolls INSIDE the card — the
   * header above stays put and tappable). Until the first layout
   * lands, fall back to a window-height fraction. */
  const { height: winH } = useWindowDimensions();
  const [contentH, setContentH] = useState(0);
  const cardMaxH =
    (contentH > 0 ? contentH : Math.round(winH * 0.86)) - 10;
  useEffect(() => {
    if (cardOpen) setCardMounted(true);
    Animated.timing(cardAnim, {
      toValue: cardOpen ? 1 : 0,
      duration: 180,
      easing: Easing.out(Easing.ease),
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && !cardOpen) setCardMounted(false);
    });
  }, [cardOpen, cardAnim]);
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
      if (cardOpen) {
        setCardOpen(false);
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
  }, [cardOpen, composeOpen, profileName, postDetail, closeCompose, closeProfile, closePost]);

  // Navigating anywhere closes the name card (v0.4.5).
  useEffect(() => {
    setCardOpen(false);
  }, [tab, profileName, postDetail, composeOpen]);

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
      <Header
        onBrandPress={() => setCardOpen((o) => !o)}
        cardOpen={cardOpen}
      />
      <View
        style={{ flex: 1 }}
        onLayout={(e) => setContentH(e.nativeEvent.layout.height)}
      >
        {tab === 'home' && <TimelineScreen />}
        {tab === 'search' && <SearchScreen />}
        {tab === 'profile' && <MeScreen />}
        {cardMounted ? (
          /* The name-card overlay: mounted INSIDE the content
           * column, which begins exactly under the header — so
           * the overlay's top IS the header's bottom edge on
           * every device, with no measurement involved, and the
           * card (marginTop in nameCard) hangs below it with a
           * clear gap. The header lives OUTSIDE this box: the
           * backdrop can never cover it, the brand stays
           * tappable while the card is open, and re-tapping it
           * closes the card (the toggle in Header). The
           * transparent backdrop takes every outside tap inside
           * the content area and closes the card; later siblings
           * (tab bar, compose button) still receive their own
           * taps — and switching tabs closes the card anyway.
           * v0.4.5 anchored the overlay to the SafeAreaView with
           * a measured header height; the safe-area inset offset
           * the two coordinate systems, so the card crept up over
           * the header and its backdrop swallowed header taps
           * (user screenshot, 2026-11-09). The card itself only
           * fades/slides; nothing underneath moves. */
          <View style={styles.cardOverlay}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => setCardOpen(false)}
              accessibilityRole="button"
            />
            <Animated.View
              style={[
                styles.nameCard,
                {
                  // v0.4.8: capped at the content column's
                  // height (minus the card's 10px top margin);
                  // the ScrollView inside scrolls the card's
                  // content when five frames don't fit.
                  maxHeight: cardMaxH,
                  opacity: cardAnim,
                  transform: [
                    {
                      translateY: cardAnim.interpolate({
                        inputRange: [0, 1],
                        // -6 against the card's 10px top margin:
                        // even mid-slide the card's top edge
                        // stays below the header's bottom edge.
                        outputRange: [-6, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
              <ScrollView
                style={{ maxHeight: cardMaxH - 32 }}
                showsVerticalScrollIndicator={false}
                bounces={false}
              >
                <NameCard onClose={() => setCardOpen(false)} />
              </ScrollView>
            </Animated.View>
          </View>
        ) : null}
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
  brand: { fontSize: 19, fontWeight: '800', color: '#0f1419' },
  /* Name card (v0.4.5) */
  cardOverlay: {
    // Anchored to the content column (see Main), so top: 0 is
    // the header's bottom edge — never over the header.
    position: 'absolute',
    top: 0,
    start: 0,
    end: 0,
    bottom: 0,
  },
  nameCard: {
    marginHorizontal: 12,
    // The visible gap between the header's bottom edge and the
    // card's top edge (v0.4.6; was 6 in v0.4.5).
    marginTop: 10,
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#eff3f4',
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  cardName: { fontSize: 18, fontWeight: '800', color: '#0f1419' },
  addrChip: {
    backgroundColor: '#f0f3f5',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  addrChipText: { fontSize: 12, color: '#536471', fontWeight: '600' },
  cardSwitchBox: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#eff3f4',
    paddingTop: 6,
  },
  cardSwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderRadius: 10,
  },
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
