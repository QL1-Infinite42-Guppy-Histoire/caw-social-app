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
      <Pressable
        style={({ pressed }) => [
          styles.searchPill,
          pressed && { backgroundColor: '#e3e8ea' },
        ]}
        onPress={() => setSearchOpen(true)}
      >
        <Text style={styles.searchPillText}>🔍 {tr('search.ph')}</Text>
      </Pressable>
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
          {qcaw !== null ? fmtAmount(qcaw) : '—'} qCAW
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
    </View>
  );

  if (loading && items.length === 0) {
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

  if (loadFailed && items.length === 0) {
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

  return (
    <View style={S.screen}>
      <FlatList
        data={items}
        keyExtractor={(item, idx) => item.hash + ':' + idx}
        ListHeaderComponent={header}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        renderItem={({ item }) => (
          <PostCard
            item={item}
            lang={lang}
            onOpenProfile={openProfileCb}
            onAction={handleAction}
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
            <Text style={S.small}>{tr('tl.empty')}</Text>
          </View>
        }
        ListFooterComponent={
          next ? (
            <LoadMoreFooter
              loading={loadingMore}
              onPress={loadMore}
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
    </View>
  );
}

const styles = StyleSheet.create({
  searchPill: {
    marginHorizontal: 16,
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
