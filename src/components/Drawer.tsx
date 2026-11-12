import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  I18nManager,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import {
  Avatar,
  BellIcon,
  BookmarkIcon,
  RepeatIcon,
  S,
  SettingsIcon,
  UserIcon,
  UserPlusIcon,
  WalletIcon,
} from './ui';
import { followerCount } from '../lib/cawApi';
import { followListsOf, subscribeFollowIndex } from '../lib/followIndex';
import BookmarksScreen from '../screens/BookmarksScreen';
import { HuntersSwapModal } from '../screens/HuntersSwapScreen';

/**
 * The X-style left drawer (v0.6.2, user instruction
 * 2026-11-13) — the app's menu home, replacing the MeScreen
 * hub home (retired with it; the hub's sections survive as
 * the section host behind these rows).
 *
 * Form, per the user's X reference: a white panel sliding in
 * from the START side at ~84% of the screen width — never
 * full-screen; the uncovered strip shows the screen beneath,
 * dimmed by a scrim. Tap the scrim (or Android back, wired
 * in App) to close. The slide is RN's built-in Animated only
 * — no gesture libraries, no new native dependencies. In RTL
 * the panel anchors to the logical start (the right edge)
 * and slides from there.
 *
 * Opening: the header avatar, on every tab.
 *
 * Contents (X layout):
 *  1. Profile summary — larger avatar, display name,
 *     "@handle · #id", and the follow line "N フォロー中 ·
 *     M フォロワー" from the EXISTING follow reads, the
 *     same sources ProfileScreen shows: followers = the
 *     chain's followerCount, following = the follow index's
 *     list length (refined live while the drawer is open).
 *     Unread renders the dash, never an invented number.
 *     Tapping the summary opens the user's OWN profile page
 *     (the existing openProfile route). No name yet: the
 *     honest prompt + the Get-a-name entry.
 *  2. Menu rows (vector icon + bold label): プロフィール
 *     (own profile page) / ウォレット (the wallet section) /
 *     自分の名前 (My names; the row's icon is the name's own
 *     avatar — names ARE avatars everywhere in this app) /
 *     名前を取る (Get a name) / HuntersExchange (the same
 *     modal as ever) / ブックマーク (the bookmarks modal) /
 *     あなたへの反応 (the reactions inbox — the same one the
 *     tab-bar bell opens, via App).
 *  3. A hairline, then 設定 low (X places settings low).
 *
 * Send/Deposit deliberately have NO drawer rows: they are
 * consolidated into the wallet screen's action buttons
 * (confirmed user instruction, 2026-11-13).
 *
 * Reachability (old → new, pinned by verify-xui): every hub
 * row lands on one of these rows with the same destination;
 * the hub summary lands here (1) and on the wallet screen;
 * the hero card's figure is the wallet list's in-name CAW
 * row. Nothing the hub reached is unreachable.
 */
export default function Drawer({
  open,
  onClose,
  onOpenInbox,
}: {
  open: boolean;
  onClose: () => void;
  onOpenInbox: () => void;
}) {
  const app = useApp();
  const { actingId, myTokens } = app;
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelW = Math.round(width * 0.84);
  const rtl = I18nManager.isRTL;

  const [mounted, setMounted] = useState(false);
  const [hsOpen, setHsOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (open) {
      setMounted(true);
      Animated.timing(anim, {
        toValue: 1,
        duration: 240,
        useNativeDriver: true,
      }).start();
    } else if (mounted) {
      Animated.timing(anim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  const acting =
    myTokens.find((t) => t.id === actingId) ?? myTokens[0] ?? null;
  const actingCustom = acting ? app.customFor(acting.id) : undefined;
  const displayName = acting
    ? actingCustom?.displayName
      ? actingCustom.displayName
      : '@' + acting.username
    : '—';
  const subLine = acting
    ? actingCustom?.displayName
      ? '@' + acting.username + ' · #' + acting.id.toString()
      : '#' + acting.id.toString()
    : null;

  /* Follow counts — ProfileScreen's sources, read while the
   * drawer is open; null (unread) renders the dash. */
  const [followers, setFollowers] = useState<bigint | null>(null);
  const [following, setFollowing] = useState<number | null>(null);
  const actingKey = acting ? acting.id.toString() : null;
  useEffect(() => {
    if (!open || !actingKey) return;
    const id = BigInt(actingKey);
    let live = true;
    setFollowers(null);
    setFollowing(null);
    followerCount(id)
      .then((v) => live && setFollowers(v))
      .catch(() => live && setFollowers(null));
    setFollowing(followListsOf(id).following.length);
    const unsub = subscribeFollowIndex(() => {
      if (live) setFollowing(followListsOf(id).following.length);
    });
    return () => {
      live = false;
      unsub();
    };
  }, [open, actingKey]);

  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const openExchange = () => {
    onClose();
    setHsOpen(true);
  };
  const openBookmarks = () => {
    onClose();
    setBookmarksOpen(true);
  };

  const translateX = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [rtl ? panelW : -panelW, 0],
  });
  const scrimOpacity = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });

  return (
    <>
      {mounted ? (
        <View style={styles.root} pointerEvents="box-none">
          <Animated.View
            style={[styles.scrim, { opacity: scrimOpacity }]}
          >
            <Pressable
              style={{ flex: 1 }}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={tr('common.back')}
            />
          </Animated.View>
          <Animated.View
            style={[
              styles.panel,
              {
                width: panelW,
                paddingTop: insets.top,
                paddingBottom: insets.bottom,
                transform: [{ translateX }],
              },
            ]}
          >
            {/* 1. Profile summary → the own profile page. */}
            {acting ? (
              <Pressable
                onPress={go(() => app.openProfile(acting.username))}
                style={({ pressed }) => [
                  styles.summary,
                  pressed && { opacity: 0.8 },
                ]}
                accessibilityRole="button"
              >
                <Avatar
                  nameId={acting.id}
                  size={52}
                  customUri={actingCustom?.avatarPath}
                />
                <Text style={styles.summaryName} numberOfLines={1}>
                  {displayName}
                </Text>
                <Text style={S.small} numberOfLines={1}>
                  {subLine}
                </Text>
                <Text style={styles.followLine} numberOfLines={1}>
                  <Text style={styles.followNum}>
                    {following !== null ? String(following) : '—'}
                  </Text>
                  <Text style={styles.followLabel}>
                    {' '}
                    {tr('followlist.following')}
                  </Text>
                  <Text style={styles.followNum}>
                    {'  '}
                    {followers !== null ? followers.toString() : '—'}
                  </Text>
                  <Text style={styles.followLabel}>
                    {' '}
                    {tr('followlist.followers')}
                  </Text>
                </Text>
              </Pressable>
            ) : (
              <View style={styles.summary}>
                <Text style={S.body}>{tr('mine.none')}</Text>
                <Pressable
                  style={[S.bigBtn, { marginTop: 12 }]}
                  onPress={go(() => app.openHub('get'))}
                >
                  <Text style={S.bigBtnText}>{tr('nav.getName')}</Text>
                </Pressable>
              </View>
            )}

            <View style={styles.hairline} />

            {/* 2. Menu rows — the old hub rows' destinations. */}
            {acting ? (
              <DrawerRow
                icon={<UserIcon size={23} color="#0f1419" />}
                label={tr('nav.profile')}
                onPress={go(() => app.openProfile(acting.username))}
              />
            ) : null}
            <DrawerRow
              icon={<WalletIcon size={23} color="#0f1419" />}
              label={tr('hub.wallet')}
              onPress={go(() => app.openHub('wallet'))}
            />
            <DrawerRow
              icon={
                acting ? (
                  <Avatar
                    nameId={acting.id}
                    size={24}
                    customUri={actingCustom?.avatarPath}
                  />
                ) : (
                  <UserIcon size={23} color="#0f1419" />
                )
              }
              label={tr('nav.myNames')}
              onPress={go(() => app.openHub('mine'))}
            />
            <DrawerRow
              icon={<UserPlusIcon size={23} color="#0f1419" />}
              label={tr('nav.getName')}
              onPress={go(() => app.openHub('get'))}
            />
            <DrawerRow
              icon={<RepeatIcon size={23} color="#0f1419" />}
              label="HuntersExchange"
              onPress={openExchange}
            />
            <DrawerRow
              icon={<BookmarkIcon size={23} color="#0f1419" />}
              label={tr('bm.title')}
              onPress={openBookmarks}
            />
            <DrawerRow
              icon={<BellIcon size={23} color="#0f1419" />}
              label={tr('inbox.title')}
              onPress={go(onOpenInbox)}
            />

            <View style={styles.hairline} />

            {/* 3. Settings, low (X's placement). */}
            <DrawerRow
              icon={<SettingsIcon size={23} color="#0f1419" />}
              label={tr('nav.settings')}
              onPress={go(() => app.openHub('settings'))}
            />
          </Animated.View>
        </View>
      ) : null}

      {/* The drawer's modals live at the component root (not
          inside the sliding overlay) so they survive the
          drawer's close animation — the same overlays the hub
          mounted, unchanged. */}
      <HuntersSwapModal visible={hsOpen} onClose={() => setHsOpen(false)} />
      <Modal
        visible={bookmarksOpen}
        animationType="slide"
        onRequestClose={() => setBookmarksOpen(false)}
      >
        <BookmarksScreen onClose={() => setBookmarksOpen(false)} />
      </Modal>
    </>
  );
}

function DrawerRow({
  icon,
  label,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: '#f7f9f9' },
      ]}
    >
      <View style={styles.rowIcon}>{icon}</View>
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    start: 0,
    end: 0,
    zIndex: 50,
  },
  scrim: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    start: 0,
    end: 0,
    backgroundColor: 'rgba(15, 20, 25, 0.45)',
  },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    start: 0,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 2, height: 0 },
    elevation: 16,
  },
  summary: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 },
  summaryName: {
    fontSize: 19,
    fontWeight: '800',
    color: '#0f1419',
    marginTop: 10,
  },
  followLine: { marginTop: 8, fontSize: 14 },
  followNum: { fontWeight: '800', color: '#0f1419' },
  followLabel: { color: '#536471' },
  hairline: {
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
    marginVertical: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 13,
  },
  rowIcon: {
    width: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0f1419',
    marginStart: 16,
  },
});
