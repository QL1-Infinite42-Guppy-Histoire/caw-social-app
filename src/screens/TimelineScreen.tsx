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
  AppLogo,
  ConfirmSheet,
  LoadMoreFooter,
  PostCard,
  S,
  StarIcon,
  TipSheet,
} from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import {
  fetchTimelinePage,
  nameOwner,
  resolveName,
  type TimelineItem,
} from '../lib/cawApi';
import {
  insertOwnPost,
  reconcileOwnPosts,
  subscribeOwnPosts,
  visibleFeedItems,
} from '../lib/feedSync';
import {
  performAction,
  performSuperRecaw,
  performSuperRecawBurn,
  performSuperlike,
  performTip,
} from '../lib/actionFlow';
import { SUPERLIKE_PRICE_RAW } from '../lib/superlike';
import { pendingSrcBurnFor } from '../lib/superRecaw';
import { MARKED_BURN_PRICE_RAW } from '../lib/markedBurns';
import { fmtAmountCard, fmtAmountCardDec } from '../lib/cawCore';
import {
  buildFollowIndex,
  refinedFollowListsOf,
} from '../lib/followIndex';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  const insets = useSafeAreaInsets();
  const app = useApp();
  const { lang, address, qom, qcaw, f42, cat42, oTok, ket, myTokens, actingId } = app;

  const [items, setItems] = useState<TimelineItem[]>(
    () => feedCache?.items ?? [],
  );
  const [next, setNext] = useState<Record<string, unknown> | null>(
    () => feedCache?.next ?? null,
  );
  const [loading, setLoading] = useState(!feedCache);
  /* v0.6.0: the Search and Send modals that used to hang off
   * this screen are gone — Search is a bottom tab now, and
   * Send is an entry on the Profile hub (MeScreen). */
  /* "Following" feed (v0.2.0): posts + shares by the names my
   * acting name follows, filtered from the same public feed. */
  const [mode, setMode] = useState<'latest' | 'following'>('latest');
  const [followSet, setFollowSet] = useState<Set<string> | null>(null);
  const [fItems, setFItems] = useState<TimelineItem[]>([]);
  const [fLoading, setFLoading] = useState(false);
  const [fDone, setFDone] = useState(false);
  const fCursorRef = React.useRef<Record<string, unknown> | null>(null);
  const fBusyRef = React.useRef(false);
  /* Own-post sync plumbing (v0.3.12): mirrors/refs so the
   * module-level own-post subscription can act on the freshest
   * closures without re-subscribing. */
  const followSetRef = React.useRef<Set<string> | null>(null);
  const loadFollowingRef = React.useRef<((reset: boolean) => Promise<void>) | null>(null);
  const fTouchedRef = React.useRef(false);
  const fRefreshWantedRef = React.useRef(false);
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
      // The head page is always a fresh fetch (cawApi never serves
      // it settled from the session cache); reconcile keeps a
      // just-posted own post pinned at the head until the scanned
      // copy of the same tx shows up in a fetched page. Likes are
      // filtered out of the feed view (v0.4.0) — presentation
      // only; the raw page still carries them for other readers.
      setItems(visibleFeedItems(reconcileOwnPosts(page.items)));
      setNext(page.next);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // v0.5.1 (F4): the feed's first page is issued FIRST, so
    // it never queues behind name enumeration on the shared
    // RPC endpoints. Balances and names start right after,
    // unchanged — names still paint snapshot-first and finish
    // in the background; only the issuance order moved.
    loadFirst();
    app.refreshBalances().catch(() => {});
    app.refreshMyTokens().catch(() => {});
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
      fTouchedRef.current = true;
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
        // The Following walk only collects posts and recaws, so
        // likes never enter here; visibleFeedItems keeps the
        // no-like-rows rule uniform across both feeds.
        setFItems((prev) =>
          reset
            ? visibleFeedItems(found)
            : [...prev, ...visibleFeedItems(found)],
        );
      } catch {
        // Keep what we have; pulling again retries.
      } finally {
        fBusyRef.current = false;
        setFLoading(false);
        // A post landed while this walk was in flight (its pages
        // predate the post): restart the walk once from the head.
        if (fRefreshWantedRef.current) {
          fRefreshWantedRef.current = false;
          fCursorRef.current = null;
          setFDone(false);
          setTimeout(() => {
            loadFollowingRef.current?.(true);
          }, 0);
        }
      }
    },
    [followSet, fDone],
  );

  useEffect(() => {
    loadFollowingRef.current = loadFollowing;
  }, [loadFollowing]);
  useEffect(() => {
    followSetRef.current = followSet;
  }, [followSet]);

  /* Restart the Following walk from the (always fresh) head so a
   * new post is picked up promptly. Only when the feed has been
   * used this mount; if a walk is busy, its finally block retries. */
  const refreshFollowing = useCallback(() => {
    if (!followSetRef.current || !fTouchedRef.current) return;
    if (fBusyRef.current) {
      fRefreshWantedRef.current = true;
      return;
    }
    fCursorRef.current = null;
    setFDone(false);
    loadFollowingRef.current?.(true);
  }, []);

  /* A post just confirmed (ComposeScreen recorded it in feedSync):
   * show it at the head of Latest immediately, reconcile with a
   * fresh head fetch, and refresh the Following walk the same way. */
  useEffect(() => {
    return subscribeOwnPosts((item) => {
      setItems((prev) => insertOwnPost(prev, item));
      loadFirst();
      refreshFollowing();
    });
  }, [loadFirst, refreshFollowing]);

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
      setItems((prev) => [...prev, ...visibleFeedItems(page.items)]);
      setNext(page.next);
    } catch {
      // Keep what we have; the button stays so the user can retry.
    } finally {
      setLoadingMore(false);
    }
  }, [next, loadingMore]);

  /* Recaw offers a choice (v0.4.0): the plain recaw action, or
   * a quote Recaw (a new post referencing this one). */
  const [recawChoice, setRecawChoice] = useState<TimelineItem | null>(null);

  const handleAction = useCallback(
    (kind: 1 | 2, item: TimelineItem) => {
      if (!acting) {
        setStatusByHash((prev) => ({
          ...prev,
          [item.hash]: tr('compose.needName'),
        }));
        return;
      }
      if (kind === 2) {
        // v0.5.0: a SuperRecaw whose recaw landed but whose O
        // burn is still owed opens the BURN-ONLY sheet instead
        // of the choice — its retry can never recaw twice.
        if (app.address) {
          pendingSrcBurnFor(app.address, item.cawId)
            .then((pending) => {
              if (pending) {
                setSrcBurnItem(item);
                return;
              }
              setRecawChoice(item);
            })
            .catch(() => setRecawChoice(item));
          return;
        }
        setRecawChoice(item);
        return;
      }
      setPending({ kind, item });
    },
    [acting, app],
  );

  const openReplyCb = useCallback(
    (item: TimelineItem) => app.openCompose({ kind: 'reply', post: item }),
    [app],
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

  /* ---------- SuperLike (v0.4.8; O-burn design v0.5.0) ----------
   * One burn transaction of exactly 1,000,000 O on QL1 — no
   * second leg, no debt state: a failure simply means nothing
   * happened. performSuperlike re-checks the guards against
   * fresh chain reads before signing. */
  const [slItem, setSlItem] = useState<TimelineItem | null>(null);
  const [slName, setSlName] = useState('');
  const [slOwner, setSlOwner] = useState('');
  const [slBusy, setSlBusy] = useState(false);

  const handleSuperlike = useCallback(
    (item: TimelineItem) => {
      // Instant local verdicts first: my own names' posts are
      // blocked, and a known-insufficient O balance is a hard
      // stop with guidance — no sheet.
      if (app.myTokens.some((t) => t.id === item.senderId)) {
        setStatusByHash((prev) => ({
          ...prev,
          [item.hash]: tr('sl.self'),
        }));
        return;
      }
      openSuperlikeSheet(item);
    },
    [app],
  );

  const openSuperlikeSheet = useCallback(
    (item: TimelineItem) => {
      if (app.oTok !== null && app.oTok.raw < SUPERLIKE_PRICE_RAW) {
        setStatusByHash((prev) => ({
          ...prev,
          [item.hash]: tr('sl.shortfall'),
        }));
        return;
      }
      resolveName(item.senderId)
        .then((n) => setSlName(n ? '@' + n : ''))
        .catch(() => setSlName(''));
      nameOwner(item.senderId)
        .then((o) =>
          setSlOwner(o.slice(0, 6) + '…' + o.slice(-4)),
        )
        .catch(() => setSlOwner(''));
      setSlItem(item);
    },
    [app],
  );

  const confirmSuperlike = useCallback(async () => {
    if (!slItem) return;
    const item = slItem;
    setSlBusy(true);
    setBusyByHash((prev) => ({ ...prev, [item.hash]: true }));
    try {
      await performSuperlike(app, { target: item });
      setStatusByHash((prev) => ({
        ...prev,
        [item.hash]: tr('sl.done'),
      }));
    } catch (e) {
      const msg =
        e instanceof Error && e.message === 'self-superlike'
          ? tr('sl.self')
          : e instanceof Error && e.message === 'shortfall'
            ? tr('sl.shortfall')
            : tr('act.failed');
      setStatusByHash((prev) => ({ ...prev, [item.hash]: msg }));
    } finally {
      setSlBusy(false);
      setBusyByHash((prev) => ({ ...prev, [item.hash]: false }));
      setSlItem(null);
    }
  }, [app, slItem]);

  /* ---------- SuperRecaw (v0.5.0) ----------
   * From the recaw choice sheet: the normal Recaw lands first,
   * then the 1,000,000 O burn marks it as a SuperRecaw. A burn
   * that fails after the recaw landed leaves a debt whose only
   * retry is the burn-only sheet below. */
  const [srcItem, setSrcItem] = useState<TimelineItem | null>(null);
  const [srcBusy, setSrcBusy] = useState(false);
  const [srcBurnItem, setSrcBurnItem] = useState<TimelineItem | null>(null);
  const [srcBurnBusy, setSrcBurnBusy] = useState(false);

  const oBalanceText = useCallback((): string => {
    return app.oTok !== null
      ? fmtAmountCardDec(app.oTok.raw, app.oTok.decimals)
      : '—';
  }, [app]);

  const confirmSuperRecaw = useCallback(async () => {
    if (!srcItem) return;
    const item = srcItem;
    setSrcBusy(true);
    setBusyByHash((prev) => ({ ...prev, [item.hash]: true }));
    // The recaw lights up as soon as it lands; undone only when
    // the recaw itself never happened (a burn debt keeps it).
    app.markMyAction(2, item, true).catch(() => {});
    try {
      await performSuperRecaw(app, { target: item });
      setStatusByHash((prev) => ({
        ...prev,
        [item.hash]: tr('src.done'),
      }));
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      // A burn debt means the recaw DID land — keep it lit.
      // Every other failure (including the pre-recaw shortfall
      // refusal) means it did not — the light goes back off.
      if (code !== 'src-burn-pending') {
        app.markMyAction(2, item, false).catch(() => {});
      }
      const msg =
        code === 'shortfall'
          ? tr('src.shortfall')
          : code === 'src-burn-pending'
            ? tr('src.burnPending')
            : code === 'need-name'
              ? tr('compose.needName')
              : tr('act.failed');
      setStatusByHash((prev) => ({ ...prev, [item.hash]: msg }));
    } finally {
      setSrcBusy(false);
      setBusyByHash((prev) => ({ ...prev, [item.hash]: false }));
      setSrcItem(null);
    }
  }, [app, srcItem]);

  const confirmSrcBurn = useCallback(async () => {
    if (!srcBurnItem) return;
    const item = srcBurnItem;
    setSrcBurnBusy(true);
    setBusyByHash((prev) => ({ ...prev, [item.hash]: true }));
    try {
      await performSuperRecawBurn(app, { target: item });
      setStatusByHash((prev) => ({
        ...prev,
        [item.hash]: tr('src.burnDone'),
      }));
    } catch (e) {
      const msg =
        e instanceof Error && e.message === 'shortfall'
          ? tr('src.burnShortfall')
          : tr('src.burnPending');
      setStatusByHash((prev) => ({ ...prev, [item.hash]: msg }));
    } finally {
      setSrcBurnBusy(false);
      setBusyByHash((prev) => ({ ...prev, [item.hash]: false }));
      setSrcBurnItem(null);
    }
  }, [app, srcBurnItem]);

  /* ---------- Tip (v0.5.0) ---------- */
  const [tipItem, setTipItem] = useState<TimelineItem | null>(null);
  const [tipName, setTipName] = useState('');
  const [tipRecipient, setTipRecipient] = useState<string | null>(null);
  const [tipBusy, setTipBusy] = useState(false);

  const handleTip = useCallback(
    (item: TimelineItem) => {
      if (app.myTokens.some((t) => t.id === item.senderId)) {
        setStatusByHash((prev) => ({
          ...prev,
          [item.hash]: tr('tip.self'),
        }));
        return;
      }
      resolveName(item.senderId)
        .then((n) => setTipName(n ? '@' + n : ''))
        .catch(() => setTipName(''));
      /* M1: resolve the recipient for display on the sheet —
       * the send itself re-resolves and cross-checks in
       * performTip; this read only fills the spot-check line. */
      setTipRecipient(null);
      nameOwner(item.senderId)
        .then((a) => setTipRecipient(a))
        .catch(() => setTipRecipient(null));
      setTipItem(item);
    },
    [app],
  );

  const confirmTip = useCallback(
    async (amountRaw: bigint) => {
      if (!tipItem) return;
      const item = tipItem;
      setTipBusy(true);
      setBusyByHash((prev) => ({ ...prev, [item.hash]: true }));
      try {
        await performTip(app, { target: item, amountRaw });
        setStatusByHash((prev) => ({
          ...prev,
          [item.hash]: tr('tip.done'),
        }));
        setTipItem(null);
      } catch (e) {
        const msg =
          e instanceof Error && e.message === 'self-tip'
            ? tr('tip.self')
            : e instanceof Error && e.message === 'shortfall'
              ? tr('tip.shortfall')
              : e instanceof Error && e.message === 'recipient-mismatch'
                ? tr('tip.mismatch')
                : tr('act.failed');
        setStatusByHash((prev) => ({ ...prev, [item.hash]: msg }));
        setTipItem(null);
      } finally {
        setTipBusy(false);
        setBusyByHash((prev) => ({ ...prev, [item.hash]: false }));
      }
    },
    [app, tipItem],
  );

  /* ---------- header (v0.6.0) ----------
   * X-style: the Home header is ONLY the Latest / Following
   * segment row (blue underline on the active segment). The
   * wallet card that used to sit here — identity, balances,
   * Profile / Send / Deposit buttons — moved to the Profile
   * hub (MeScreen), and the search pill is gone because
   * Search is a tab now. Nothing was removed from the app:
   * the reachability map lives in the v0.6.0 release notes
   * and is pinned by scripts/verify-xui.mjs. */
  const header = (
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
            onReply={openReplyCb}
            onSuperlike={handleSuperlike}
            onTip={handleTip}
            onBookmark={app.toggleBookmark}
            isBookmarked={app.isBookmarked}
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
              <View style={[S.emptyCard, { marginHorizontal: 16, alignSelf: 'stretch' }]}>
                <AppLogo size={40} />
                <Text style={[S.small, { marginTop: 8, textAlign: 'center' }]}>
                  {mode === 'following'
                    ? acting
                      ? tr('tl.followingEmpty')
                      : tr('compose.needName')
                    : tr('tl.empty')}
                </Text>
              </View>
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
      <ConfirmSheet
        visible={!!slItem}
        title={tr('sl.title')}
        body={
          slItem
            ? tr('sl.body', {
                name: slName || '—',
                addr: slOwner || '—',
                price: fmtAmountCardDec(SUPERLIKE_PRICE_RAW, 18),
                balance: oBalanceText(),
              })
            : ''
        }
        confirmLabel={tr('sl.confirm')}
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmSuperlike}
        onCancel={() => setSlItem(null)}
        busy={slBusy}
      />
      <ConfirmSheet
        visible={!!srcItem}
        title={tr('src.title')}
        body={
          srcItem
            ? tr('src.body', {
                price: fmtAmountCardDec(MARKED_BURN_PRICE_RAW, 18),
                balance: oBalanceText(),
              })
            : ''
        }
        confirmLabel={tr('src.confirm')}
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmSuperRecaw}
        onCancel={() => setSrcItem(null)}
        busy={srcBusy}
      />
      <ConfirmSheet
        visible={!!srcBurnItem}
        title={tr('src.burnTitle')}
        body={
          srcBurnItem
            ? tr('src.burnBody', {
                price: fmtAmountCardDec(MARKED_BURN_PRICE_RAW, 18),
                balance: oBalanceText(),
              })
            : ''
        }
        confirmLabel={tr('src.burnConfirm')}
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmSrcBurn}
        onCancel={() => setSrcBurnItem(null)}
        busy={srcBurnBusy}
      />
      <TipSheet
        visible={!!tipItem}
        authorLabel={tipName}
        recipient={tipRecipient}
        balanceRaw={cat42}
        busy={tipBusy}
        onConfirm={confirmTip}
        onCancel={() => setTipItem(null)}
      />
      <Modal
        visible={!!recawChoice}
        transparent
        animationType="slide"
        onRequestClose={() => setRecawChoice(null)}
      >
        <View style={styles.choiceBackdrop}>
          <View style={[styles.choiceSheet, { paddingBottom: 30 + insets.bottom }]}>
            <Text style={S.h2}>{tr('act.recawChoiceTitle')}</Text>
            <View style={{ height: 16 }} />
            <Pressable
              style={S.bigBtn}
              onPress={() => {
                const it = recawChoice;
                setRecawChoice(null);
                if (it) setPending({ kind: 2, item: it });
              }}
            >
              <Text style={S.bigBtnText}>{tr('act.share')}</Text>
            </Pressable>
            <View style={{ height: 10 }} />
            <Pressable
              style={[S.bigBtn, { backgroundColor: '#d6336c' }]}
              onPress={() => {
                const it = recawChoice;
                setRecawChoice(null);
                if (it) {
                  if (
                    app.oTok !== null &&
                    app.oTok.raw < MARKED_BURN_PRICE_RAW
                  ) {
                    setStatusByHash((prev) => ({
                      ...prev,
                      [it.hash]: tr('src.shortfall'),
                    }));
                    return;
                  }
                  setSrcItem(it);
                }
              }}
            >
              <View style={[S.row, { alignItems: 'center', gap: 6 }]}>
                <StarIcon size={16} color="#fff" filled />
                <Text style={S.bigBtnText}>
                  {tr('tl.superRecaw')}（
                  {fmtAmountCardDec(MARKED_BURN_PRICE_RAW, 18)} O）
                </Text>
              </View>
            </Pressable>
            <View style={{ height: 10 }} />
            <Pressable
              style={S.ghostBtn}
              onPress={() => {
                const it = recawChoice;
                setRecawChoice(null);
                if (it) app.openCompose({ kind: 'quote', post: it });
              }}
            >
              <Text style={S.ghostBtnText}>{tr('act.quoteRecaw')}</Text>
            </Pressable>
            <View style={{ height: 10 }} />
            <Pressable
              style={S.ghostBtn}
              onPress={() => setRecawChoice(null)}
            >
              <Text style={S.ghostBtnText}>{tr('compose.cancel')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  /* v0.6.0: the wallet-card styles (chip / walletCard) and the
     search pill moved out with the card — the card lives in
     MeScreen now, with its own copies of these styles. */
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  /* Recaw choice sheet (v0.4.0) — same bottom-sheet language as
   * the shared ConfirmSheet. */
  choiceBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  choiceSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    paddingBottom: 30,
  },
});
