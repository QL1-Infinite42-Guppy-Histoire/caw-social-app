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

import {
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

  const shortAddress = address
    ? address.slice(0, 10) + '…' + address.slice(-6)
    : '—';

  const header = (
    <View>
      <View style={styles.topRow}>
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
        <Pressable
          onPress={() => setInboxOpen(true)}
          hitSlop={10}
          style={({ pressed }) => [
            styles.bellBtn,
            pressed && { backgroundColor: '#e3e8ea' },
          ]}
          accessibilityLabel={tr('inbox.title')}
        >
          <Text style={{ fontSize: 19 }}>🔔</Text>
        </Pressable>
      </View>
      <View style={styles.walletCard}>
        <Text style={styles.walletAddr}>{shortAddress}</Text>
      <View style={[S.row, { marginTop: 8, flexWrap: 'wrap', gap: 16 }]}>
        <Text style={S.body}>
          {qom !== null ? fmtAmount(qom) : '—'} QOM
        </Text>
        <Text style={S.small}>{tr('home.qom')}</Text>
      </View>
      <View style={[S.row, { marginTop: 4, flexWrap: 'wrap', gap: 16 }]}>
        <Text style={S.body}>
          {qcaw !== null ? fmtAmount(qcaw) : '—'} CAW
        </Text>
        <Text style={S.small}>{tr('home.qcaw')}</Text>
      </View>
        <View style={[S.row, { marginTop: 8, flexWrap: 'wrap', gap: 8 }]}>
          <Text style={S.small}>{tr('home.postAs')}</Text>
          <Text style={[S.body, { fontWeight: '700' }]}>
            {acting
              ? app.customFor(acting.id) &&
                app.customFor(acting.id)!.displayName
                ? app.customFor(acting.id)!.displayName
                : '@' + acting.username
              : '—'}
          </Text>
        </View>
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
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 12,
  },
  bellBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    marginLeft: 6,
  },
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
    marginLeft: 16,
    marginRight: 4,
    marginTop: 12,
    backgroundColor: '#eff3f4',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  searchPillText: { fontSize: 14.5, color: '#536471' },
  walletCard: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: HAIRLINE,
    backgroundColor: '#fff',
  },
  walletAddr: { fontSize: 13, color: '#536471', fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
