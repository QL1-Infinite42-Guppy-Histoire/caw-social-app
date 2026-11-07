import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import * as Clipboard from 'expo-clipboard';

import {
  AppLogo,
  Avatar,
  ConfirmSheet,
  HAIRLINE,
  LoadMoreFooter,
  PostCard,
  S,
} from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import { fetchTimelinePage, type TimelineItem } from '../lib/cawApi';
import { performAction } from '../lib/actionFlow';
import { fmtAmount } from '../lib/cawCore';
import {
  buildFollowIndex,
  refinedFollowListsOf,
} from '../lib/followIndex';
import { loadSeen, scanReactions } from '../lib/inbox';
import { storeKV } from '../lib/stores';
import InboxScreen from './InboxScreen';
import SearchScreen from './SearchScreen';

type PendingAction = { kind: 1 | 2; item: TimelineItem };

/**
 * Last feed shown, kept at module level: switching tabs unmounts
 * this screen, and re-walking the explorer pages from scratch made
 * coming back to Home feel slow. The cached feed renders instantly
 * and a background refresh replaces it.
 */
let feedCache: {
  items: TimelineItem[];
  next: Record<string, unknown> | null;
} | null = null;

export default function TimelineScreen() {
  const app = useApp();
  const { lang, address, qom, qcaw, myTokens, actingId } = app;

  const [items, setItems] = useState<TimelineItem[]>(
    () => feedCache?.items ?? [],
  );
  const [next, setNext] = useState<Record<string, unknown> | null>(
    () => feedCache?.next ?? null,
  );
  const [loading, setLoading] = useState(!feedCache);
  const [searchOpen, setSearchOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  /* "Following" feed (v0.2.0): posts + shares by the names my
   * acting name follows, filtered from the same public feed. */
  const [mode, setMode] = useState<'latest' | 'following'>('latest');
  const [followSet, setFollowSet] = useState<Set<string> | null>(null);
  const [fItems, setFItems] = useState<TimelineItem[]>([]);
  const [fLoading, setFLoading] = useState(false);
  const [fDone, setFDone] = useState(false);
  const fCursorRef = React.useRef<Record<string, unknown> | null>(null);
  const fBusyRef = React.useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [statusByHash, setStatusByHash] = useState<Record<string, string>>({});
  const [busyByHash, setBusyByHash] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<PendingAction | null>(null);

  const acting =
    myTokens.find((t) => t.id === actingId) ?? myTokens[0] ?? null;
  const actingLabel = acting ? '@' + acting.username : '';

  const loadFirst = useCallback(async () => {
    setLoadFailed(false);
    try {
      const page = await fetchTimelinePage(null);
      setItems(page.items);
      setNext(page.next);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    app.refreshBalances().catch(() => {});
    app.refreshMyTokens().catch(() => {});
    loadFirst();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadFirst]);

  // Keep the module-level feed cache in step with what is on screen.
  useEffect(() => {
    if (items.length > 0) feedCache = { items, next };
  }, [items, next]);

  const openProfileCb = useCallback(
    (username: string) => app.openProfile(username),
    [app],
  );
  const openPostCb = useCallback(
    (item: TimelineItem) => app.openPost(item),
    [app],
  );

  /* ---------- "Following" feed ---------- */
  // Resolve who the acting name follows (follow index, v0.1.5)
  // whenever the Following tab is opened or the acting name changes.
  useEffect(() => {
    if (mode !== 'following' || !acting) return;
    let live = true;
    setFollowSet(null);
    setFItems([]);
    setFDone(false);
    fCursorRef.current = null;
    buildFollowIndex()
      .then(() => refinedFollowListsOf(acting.id))
      .then((lists) => {
        if (live) {
          setFollowSet(new Set(lists.following.map((x) => x.toString())));
        }
      })
      .catch(() => {
        if (live) setFollowSet(new Set());
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, acting?.id]);

  const loadFollowing = useCallback(
    async (reset: boolean) => {
      if (!followSet || fBusyRef.current) return;
      if (!reset && fDone) return;
      fBusyRef.current = true;
      setFLoading(true);
      try {
        let cursor = reset ? null : fCursorRef.current;
        const found: TimelineItem[] = [];
        let done = false;
        // Followed names may post rarely: walk several pages per
        // chunk until enough matches turn up or the feed ends.
        for (let p = 0; p < 25; p++) {
          const page = await fetchTimelinePage(cursor);
          for (const it of page.items) {
            if (
              (it.type === 0 || it.type === 2) &&
              followSet.has(it.senderId.toString())
            ) {
              found.push(it);
            }
          }
          cursor = page.next;
          if (!cursor) {
            done = true;
            break;
          }
          if (found.length >= 8) break;
        }
        fCursorRef.current = cursor;
        setFDone(done);
        setFItems((prev) => (reset ? found : [...prev, ...found]));
      } catch {
        // Keep what we have; pulling again retries.
      } finally {
        fBusyRef.current = false;
        setFLoading(false);
      }
    },
    [followSet, fDone],
  );

  useEffect(() => {
    if (mode === 'following' && followSet && fItems.length === 0 && !fDone) {
      loadFollowing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, followSet]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    app.refreshBalances().catch(() => {});
    app.refreshMyTokens().catch(() => {});
    loadFirst();
  }, [app, loadFirst]);

  const loadMore = useCallback(async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchTimelinePage(next);
      setItems((prev) => [...prev, ...page.items]);
      setNext(page.next);
    } catch {
      // Keep what we have; the button stays so the user can retry.
    } finally {
      setLoadingMore(false);
    }
  }, [next, loadingMore]);

  const handleAction = useCallback(
    (kind: 1 | 2, item: TimelineItem) => {
      if (!acting) {
        setStatusByHash((prev) => ({
          ...prev,
          [item.hash]: tr('compose.needName'),
        }));
        return;
      }
      setPending({ kind, item });
    },
    [acting],
  );

  const confirmAction = useCallback(async () => {
    if (!pending) return;
    const { kind, item } = pending;
    setBusyByHash((prev) => ({ ...prev, [item.hash]: true }));
    // Light the button up right away; undo if the send fails.
    app.markMyAction(kind, item, true).catch(() => {});
    try {
      await performAction(app, {
        kind,
        target: item,
        text: kind === 1 ? 'LIKE' : 'REPOST',
      });
      setStatusByHash((prev) => ({ ...prev, [item.hash]: tr('act.done') }));
    } catch (e) {
      app.markMyAction(kind, item, false).catch(() => {});
      const msg =
        e instanceof Error && e.message === 'need-name'
          ? tr('compose.needName')
          : tr('act.failed');
      setStatusByHash((prev) => ({ ...prev, [item.hash]: msg }));
    } finally {
      setBusyByHash((prev) => ({ ...prev, [item.hash]: false }));
      setPending(null);
    }
  }, [app, pending]);

  /* ---------- sticky mini header: unread badge (v0.3.4) ----------
   * The bell moved out of the scrolling list header into a slim
   * bar that stays on screen. Its badge is the count of reactions
   * newer than the inbox read position — the exact same scan the
   * Inbox screen itself runs (loadSeen + scanReactions), so the
   * number always matches what opening the bell will show. After
   * the inbox closes (it marks everything seen), the count is
   * refreshed and drops to zero. */
  const [unread, setUnread] = useState(0);
  const badgeBusyRef = React.useRef(false);
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

  const wasInboxOpenRef = React.useRef(false);
  useEffect(() => {
    if (wasInboxOpenRef.current && !inboxOpen) refreshBadge();
    wasInboxOpenRef.current = inboxOpen;
  }, [inboxOpen, refreshBadge]);

  /* ---------- wallet card identity + address chip (v0.3.4) ---------- */
  const actingCustom = acting ? app.customFor(acting.id) : undefined;
  const displayName = acting
    ? actingCustom?.displayName
      ? actingCustom.displayName
      : '@' + acting.username
    : '—';
  const subName =
    acting && actingCustom?.displayName ? '@' + acting.username : null;
  const chipAddress = address
    ? address.slice(0, 6) + '…' + address.slice(-4)
    : '—';
  const [addrCopied, setAddrCopied] = useState(false);
  const copyAddr = useCallback(async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2000);
  }, [address]);

  const miniHeader = (
    <View style={styles.miniHeader}>
      <View style={styles.miniBrand}>
        <AppLogo size={26} />
        <Text style={styles.miniBrandText}>{tr('app.name')}</Text>
      </View>
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
    </View>
  );

  const header = (
    <View>
      <View style={styles.walletCard}>
        <View style={[S.row, { alignItems: 'center', gap: 10 }]}>
          {acting ? (
            <Avatar
              nameId={acting.id}
              size={42}
              customUri={actingCustom?.avatarPath}
            />
          ) : null}
          <View style={{ flex: 1 }}>
            <Text
              style={[S.body, { fontWeight: '800' }]}
              numberOfLines={1}
            >
              {displayName}
            </Text>
            {subName ? (
              <Text style={S.small} numberOfLines={1}>
                {subName}
              </Text>
            ) : null}
          </View>
          <Pressable
            style={({ pressed }) => [
              styles.chip,
              pressed && { backgroundColor: '#e3e8ea' },
            ]}
            onPress={copyAddr}
            accessibilityLabel={tr('hs.depositAddress')}
          >
            <Text style={styles.chipText}>
              {addrCopied ? tr('hs.addressCopied') : chipAddress}
            </Text>
          </Pressable>
        </View>
        <View style={[S.row, { marginTop: 14, gap: 16 }]}>
          <View style={{ flex: 1.35 }}>
            <Text style={styles.statLabel}>{tr('home.qcaw')}</Text>
            <Text
              style={styles.statBig}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.45}
            >
              {qcaw !== null ? fmtAmount(qcaw) : '—'} CAW
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.statLabel}>{tr('home.qom')}</Text>
            <Text
              style={styles.statSmall}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.45}
            >
              {qom !== null ? fmtAmount(qom) : '—'} QOM
            </Text>
          </View>
        </View>
      </View>
      <View style={styles.searchRow}>
        <Pressable
          style={({ pressed }) => [
            styles.searchPill,
            { flex: 1 },
            pressed && { backgroundColor: '#e3e8ea' },
          ]}
          onPress={() => setSearchOpen(true)}
        >
          <Text style={styles.searchPillText}>🔍 {tr('search.ph')}</Text>
        </Pressable>
      </View>
      <View style={styles.segRow}>
        <Pressable
          style={[styles.segBtn, mode === 'latest' && styles.segBtnOn]}
          onPress={() => setMode('latest')}
        >
          <Text
            style={[styles.segText, mode === 'latest' && styles.segTextOn]}
          >
            {tr('tl.tabLatest')}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.segBtn, mode === 'following' && styles.segBtnOn]}
          onPress={() => setMode('following')}
        >
          <Text
            style={[
              styles.segText,
              mode === 'following' && styles.segTextOn,
            ]}
          >
            {tr('tl.tabFollowing')}
          </Text>
        </Pressable>
      </View>
    </View>
  );

  if (mode === 'latest' && loading && items.length === 0) {
    return (
      <View style={S.screen}>
        {miniHeader}
        {header}
        <View style={styles.center}>
          <ActivityIndicator color={ACCENT} />
          <Text style={[S.small, { marginTop: 10 }]}>{tr('tl.loading')}</Text>
        </View>
      </View>
    );
  }

  if (mode === 'latest' && loadFailed && items.length === 0) {
    return (
      <View style={S.screen}>
        {miniHeader}
        {header}
        <View style={styles.center}>
          <Text style={S.err}>{tr('tl.loadFail')}</Text>
          <Pressable
            style={[S.ghostBtn, { marginTop: 14 }]}
            onPress={() => {
              setLoading(true);
              loadFirst();
            }}
          >
            <Text style={S.ghostBtnText}>{tr('profile.retry')}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const shownItems = mode === 'latest' ? items : fItems;
  const onRefreshList = () => {
    if (mode === 'following') {
      setFItems([]);
      setFDone(false);
      fCursorRef.current = null;
      loadFollowing(true);
    } else {
      onRefresh();
    }
  };

  return (
    <View style={S.screen}>
      {miniHeader}
      <FlatList
        data={shownItems}
        keyExtractor={(item, idx) => item.hash + ':' + idx}
        ListHeaderComponent={header}
        refreshControl={
          <RefreshControl
            refreshing={mode === 'latest' ? refreshing : fLoading}
            onRefresh={onRefreshList}
          />
        }
        renderItem={({ item }) => (
          <PostCard
            item={item}
            lang={lang}
            onOpenProfile={openProfileCb}
            onAction={handleAction}
            onOpenPost={openPostCb}
            actionStatus={statusByHash[item.hash]}
            busy={!!busyByHash[item.hash]}
            liked={app.hasMyAction(1, item)}
            recawed={app.hasMyAction(2, item)}
            custom={app.customFor(item.senderId)}
          />
        )}
        windowSize={7}
        maxToRenderPerBatch={12}
        removeClippedSubviews
        ListEmptyComponent={
          <View style={styles.center}>
            {mode === 'following' && (fLoading || !followSet) ? (
              <>
                <ActivityIndicator color={ACCENT} />
                <Text style={[S.small, { marginTop: 10 }]}>
                  {tr('tl.loading')}
                </Text>
              </>
            ) : (
              <Text style={S.small}>
                {mode === 'following'
                  ? acting
                    ? tr('tl.followingEmpty')
                    : tr('compose.needName')
                  : tr('tl.empty')}
              </Text>
            )}
          </View>
        }
        ListFooterComponent={
          mode === 'latest' ? (
            next ? (
              <LoadMoreFooter
                loading={loadingMore}
                onPress={loadMore}
                label={tr('tl.more')}
              />
            ) : undefined
          ) : !fDone && fItems.length > 0 ? (
            <LoadMoreFooter
              loading={fLoading}
              onPress={() => loadFollowing(false)}
              label={tr('tl.more')}
            />
          ) : undefined
        }
      />
      <ConfirmSheet
        visible={!!pending}
        title={
          pending
            ? pending.kind === 1
              ? tr('act.confirmLike', { name: actingLabel })
              : tr('act.confirmShare', { name: actingLabel })
            : ''
        }
        confirmLabel={
          pending
            ? pending.kind === 1
              ? tr('act.like')
              : tr('act.share')
            : ''
        }
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmAction}
        onCancel={() => setPending(null)}
        busy={pending ? !!busyByHash[pending.item.hash] : false}
      />
      <Modal
        visible={searchOpen}
        animationType="slide"
        onRequestClose={() => setSearchOpen(false)}
      >
        <SearchScreen onClose={() => setSearchOpen(false)} />
      </Modal>
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

const styles = StyleSheet.create({
  /* Sticky mini header (v0.3.4): rendered OUTSIDE the FlatList, so
     the bell (and its unread badge) is reachable at any scroll
     position. */
  miniHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 7,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: HAIRLINE,
  },
  miniBrand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  miniBrandText: { fontSize: 15.5, fontWeight: '800', color: '#0f1419' },
  bellBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: HAIRLINE,
    backgroundColor: '#f7f9f9',
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -5,
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
  /* Wallet card (v0.3.4): one clean card — identity + copyable
     address chip on row 1, CAW (large) and QOM (smaller) stats on
     row 2. Numbers are single-line with adjustsFontSizeToFit so
     trillion-scale CAW amounts shrink instead of overflowing. */
  chip: {
    backgroundColor: '#eff3f4',
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  chipText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#0f1419',
    fontFamily: 'monospace',
  },
  statLabel: { fontSize: 12.5, color: '#536471', fontWeight: '600' },
  statBig: {
    fontSize: 21,
    fontWeight: '800',
    color: '#0f1419',
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  statSmall: {
    fontSize: 16.5,
    fontWeight: '700',
    color: '#0f1419',
    marginTop: 3,
    fontVariant: ['tabular-nums'],
  },
  searchRow: { paddingHorizontal: 16, paddingTop: 12 },
  segRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
    backgroundColor: '#fff',
  },
  segBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  segBtnOn: { borderBottomColor: ACCENT },
  segText: { fontSize: 14.5, color: '#536471', fontWeight: '600' },
  segTextOn: { color: '#0f1419', fontWeight: '800' },
  searchPill: {
    backgroundColor: '#eff3f4',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  searchPillText: { fontSize: 14.5, color: '#536471' },
  walletCard: {
    marginHorizontal: 12,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: HAIRLINE,
    borderRadius: 16,
    backgroundColor: '#fff',
    shadowColor: '#0f1419',
    shadowOpacity: 0.07,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
