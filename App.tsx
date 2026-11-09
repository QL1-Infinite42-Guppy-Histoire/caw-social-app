import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
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
  BalanceFrame,
  HomeIcon,
  PasswordPrompt,
  S,
  SearchIcon,
  SettingsIcon,
  UserIcon,
} from './src/components/ui';
import { fmtAmountCard } from './src/lib/cawCore';
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
  const { address, myTokens, actingId, qcaw, qom } = app;
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
            app.setTab('get');
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

      {/* Balances (v0.4.6): full-width bordered frames, the
       * shared BalanceFrame — the v0.4.5 three-across row
       * wrapped its labels and overflowed its amounts (user
       * screenshots, 2026-11-09). The deposited CAW is
       * acting.balance = cawBalanceOf from the same enumeration
       * the profile and My Names read — same source, same
       * freshness. Amounts are fmtAmountCard (display-only,
       * truncated to 2 decimals). */}
      <View style={{ marginTop: 14, gap: 8 }}>
        <BalanceFrame
          label="CAW"
          amount={qcaw !== null ? fmtAmountCard(qcaw) : null}
          unit="CAW"
        />
        <BalanceFrame
          label={tr('home.qom')}
          amount={qom !== null ? fmtAmountCard(qom) : null}
          unit="QOM"
        />
        <BalanceFrame
          label={tr('card.inName')}
          amount={fmtAmountCard(acting.balance)}
          unit="CAW"
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
// 9+9 plus the 22px icon line and the ~19px label line (15px
// labels since v0.4.5, icons added v0.4.6), plus the 1px top
// border. Only the compose FAB offset consumes this number.
const TAB_BAR_HEIGHT = 62;

function Main() {
  const app = useApp();
  const insets = useSafeAreaInsets();
  // HuntersSwap opens from the tab bar's center action button. It is
  // an ACTION, not a tab: opening/closing it never changes `tab`.
  const [hsOpen, setHsOpen] = React.useState(false);
  // Name card (v0.4.5): dropped from the brand header. Mounted
  // only while open or animating shut; navigating anywhere
  // closes it.
  const [cardOpen, setCardOpen] = useState(false);
  const [cardMounted, setCardMounted] = useState(false);
  const [headerH, setHeaderH] = useState(0);
  const cardAnim = useRef(new Animated.Value(0)).current;
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
  }, [cardOpen, hsOpen, composeOpen, profileName, postDetail, closeCompose, closeProfile, closePost]);

  // Navigating anywhere closes the name card (v0.4.5).
  useEffect(() => {
    setCardOpen(false);
  }, [tab, profileName, postDetail, composeOpen, hsOpen]);

  /* Tab icons (v0.4.6): an icon over every label — the v0.4.5
   * bar was labels-only and the user asked where the marks
   * (house, magnifier, person, gear) had gone. The icons are
   * this app's feather-style vectors, so they render the same
   * on every phone; they take the label's colour (gray idle,
   * accent on the active tab). */
  const tabs: {
    key: typeof tab;
    label: string;
    Icon: React.ComponentType<{ size?: number; color?: string }>;
  }[] = [
    { key: 'home', label: tr('nav.home'), Icon: HomeIcon },
    { key: 'get', label: tr('nav.getName'), Icon: SearchIcon },
    { key: 'mine', label: tr('nav.myNames'), Icon: UserIcon },
    { key: 'settings', label: tr('nav.settings'), Icon: SettingsIcon },
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
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
        style={[
          styles.navLabel,
          { marginTop: 2 },
          tab === t.key && styles.navLabelOn,
        ]}
      >
        {t.label}
      </Text>
    </Pressable>
  );

  return (
    <SafeAreaView style={S.screen} edges={['top', 'bottom']}>
      <View
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          if (h > 0 && Math.abs(h - headerH) > 0.5) setHeaderH(h);
        }}
      >
        <Header
          onBrandPress={() => setCardOpen((o) => !o)}
          cardOpen={cardOpen}
        />
      </View>
      <View style={{ flex: 1 }}>
        {tab === 'home' && <TimelineScreen />}
        {tab === 'get' && <GetNameScreen />}
        {tab === 'mine' && <MyNamesScreen />}
        {tab === 'settings' && <SettingsScreen />}
      </View>
      {cardMounted ? (
        /* The name-card overlay (v0.4.5): starts exactly under
         * the header, so the header row (bell, language) stays
         * live above it; the transparent backdrop takes every
         * outside tap and closes the card. Later siblings (tab
         * bar, compose button) still receive their own taps —
         * and switching tabs closes the card anyway. The card
         * itself only fades/slides; nothing underneath moves. */
        <View style={[styles.cardOverlay, { top: headerH }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setCardOpen(false)}
            accessibilityRole="button"
          />
          <Animated.View
            style={[
              styles.nameCard,
              {
                opacity: cardAnim,
                transform: [
                  {
                    translateY: cardAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-10, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <NameCard onClose={() => setCardOpen(false)} />
          </Animated.View>
        </View>
      ) : null}
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
        {tabs.slice(0, 2).map(renderTab)}
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
        {tabs.slice(2).map(renderTab)}
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
  /* Name card (v0.4.5) */
  cardOverlay: {
    position: 'absolute',
    start: 0,
    end: 0,
    bottom: 0,
  },
  nameCard: {
    marginHorizontal: 12,
    marginTop: 6,
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
  // v0.4.5: the bar grew — labels 12px -> 15px and taller items,
  // so every tab is a comfortable >=48dp tap target. v0.4.6:
  // an icon line joins the label line (22px icon + 2px gap +
  // ~19px label + 9+9 padding = ~62px total, TAB_BAR_HEIGHT).
  // The bottom safe-area inset is still the SafeAreaView's job
  // (edges), so gesture-nav and 3-button-nav devices get
  // exactly one inset, as before — nothing here adds bottom
  // padding of its own.
  navItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 9 },
  // The center slot is narrower than the label slots so the four
  // labels get the room; the 62px circle still fits inside it on
  // standard-width phones and never overlaps a label.
  navItemCenter: { flex: 0.8, alignItems: 'center', justifyContent: 'center', paddingVertical: 9 },
  navLabel: {
    fontSize: 15,
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
    // and the compose FAB offset follows it) while the circle
    // floats above the bar: top -25 -> spans y -25..37 of the bar,
    // never reaching the system navigation underneath.
    position: 'absolute',
    top: -25,
    // Physical left/marginLeft on purpose: the math (50% - half
    // the width) centers the circle in BOTH layout directions,
    // so the center tab button stays exactly centered under RTL.
    left: '50%',
    marginLeft: -31,
    width: 62,
    height: 62,
    borderRadius: 31,
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
  tradeBtnText: { color: '#fff', fontSize: 27, lineHeight: 30, fontWeight: '800' },
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
