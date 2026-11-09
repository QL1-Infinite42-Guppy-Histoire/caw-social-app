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
  BalanceFrame,
  ConfirmSheet,
  HAIRLINE,
  LoadMoreFooter,
  MONO,
  PostCard,
  S,
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
  performSuperlike,
  performSuperlikeBurn,
} from '../lib/actionFlow';
import {
  pendingBurnFor,
  SUPERLIKE_AUTHOR_CAT42,
  SUPERLIKE_BURN_CAT42,
  SUPERLIKE_TOTAL_CAT42,
  SUPERLIKE_TOTAL_RAW,
} from '../lib/superlike';
import { fmtAmountCard } from '../lib/cawCore';
import {
  buildFollowIndex,
  refinedFollowListsOf,
} from '../lib/followIndex';
import SearchScreen from './SearchScreen';
import SendScreen from './SendScreen';
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
  const { lang, address, qom, qcaw, f42, cat42, myTokens, actingId } = app;

  const [items, setItems] = useState<TimelineItem[]>(
    () => feedCache?.items ?? [],
  );
  const [next, setNext] = useState<Record<string, unknown> | null>(
    () => feedCache?.next ?? null,
  );
  const [loading, setLoading] = useState(!feedCache);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
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
        setRecawChoice(item);
        return;
      }
      setPending({ kind, item });
    },
    [acting],
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

  /* ---------- SuperLike (v0.4.8) ---------- */
  const [slItem, setSlItem] = useState<TimelineItem | null>(null);
  const [slName, setSlName] = useState('');
  const [slOwner, setSlOwner] = useState('');
  const [slBusy, setSlBusy] = useState(false);

  const handleSuperlike = useCallback(
    (item: TimelineItem) => {
      // Instant local verdicts first (performSuperlike re-checks
      // everything against fresh chain reads before signing):
      // my own names' posts are blocked, and a known-insufficient
      // CAT42 balance is a hard stop with guidance — no sheet.
      if (app.myTokens.some((t) => t.id === item.senderId)) {
        setStatusByHash((prev) => ({
          ...prev,
          [item.hash]: tr('sl.self'),
        }));
        return;
      }
      // v0.4.9: a SuperLike whose author leg landed but whose
      // burn is still owed opens the BURN-ONLY sheet instead —
      // its retry can never pay the author twice.
      if (app.address) {
        pendingBurnFor(app.address, item.cawId)
          .then((pending) => {
            if (pending) {
              setSlBurnItem(item);
              return;
            }
            openSuperlikeSheet(item);
          })
          .catch(() => openSuperlikeSheet(item));
        return;
      }
      openSuperlikeSheet(item);
    },
    [app],
  );

  const openSuperlikeSheet = useCallback(
    (item: TimelineItem) => {
      if (app.cat42 !== null && app.cat42 < SUPERLIKE_TOTAL_RAW) {
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
            : e instanceof Error && e.message === 'burn-pending'
              ? tr('sl.burnPending')
              : tr('act.failed');
      setStatusByHash((prev) => ({ ...prev, [item.hash]: msg }));
    } finally {
      setSlBusy(false);
      setBusyByHash((prev) => ({ ...prev, [item.hash]: false }));
      setSlItem(null);
    }
  }, [app, slItem]);

  /* ---------- pending-burn retry (v0.4.9) ---------- */
  const [slBurnItem, setSlBurnItem] = useState<TimelineItem | null>(null);
  const [slBurnBusy, setSlBurnBusy] = useState(false);

  const confirmBurn = useCallback(async () => {
    if (!slBurnItem) return;
    const item = slBurnItem;
    setSlBurnBusy(true);
    setBusyByHash((prev) => ({ ...prev, [item.hash]: true }));
    try {
      await performSuperlikeBurn(app, { target: item });
      setStatusByHash((prev) => ({
        ...prev,
        [item.hash]: tr('sl.burnDone'),
      }));
    } catch (e) {
      const msg =
        e instanceof Error && e.message === 'shortfall'
          ? tr('sl.burnShortfall')
          : tr('sl.burnPending');
      setStatusByHash((prev) => ({ ...prev, [item.hash]: msg }));
    } finally {
      setSlBurnBusy(false);
      setBusyByHash((prev) => ({ ...prev, [item.hash]: false }));
      setSlBurnItem(null);
    }
  }, [app, slBurnItem]);

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

  const header = (
    <View>
      <View style={styles.walletCard}>
        {/* v0.4.5: the card's display area (identity + balances)
         * opens my own profile. The button row below is a
         * sibling, NOT part of this Pressable, and the address
         * chip inside keeps its own copy action — nested
         * Pressables answer their own taps, so nothing steals
         * from anything. */}
        <Pressable
          onPress={
            acting ? () => app.openProfile(acting.username) : undefined
          }
          style={({ pressed }) => [pressed && { opacity: 0.8 }]}
          accessibilityRole="button"
        >
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
        {/* Balances (v0.4.6): full-width bordered frames, the
         * same BalanceFrame the name card uses — the v0.4.5
         * three-across row squeezed the labels until they
         * wrapped/truncated and the amounts overflowed (user
         * screenshots, 2026-11-09). Amounts are fmtAmountCard:
         * display-only, truncated to 2 decimals. The deposited
         * CAW is the active name's in-name balance
         * (cawBalanceOf, carried on the token from the same
         * enumeration); no name yet -> the honest dash.
         * v0.4.8: the same wallet's two 42 Chain balances join
         * underneath, in the same frames and the same order as
         * the name card: native [42], then CAT42 — the
         * SuperLike currency, labelled as such. They follow
         * the v0.4.7 rule exactly: unread/failed reads render
         * the dash, never a numeric 0. */}
        <View style={{ marginTop: 12, gap: 6 }}>
          <BalanceFrame
            label={tr('home.qcaw')}
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
            amount={acting ? fmtAmountCard(acting.balance) : null}
            unit="CAW"
          />
          <BalanceFrame
            label={tr('card.f42')}
            amount={f42 !== null ? fmtAmountCard(f42) : null}
            unit="42"
          />
          <BalanceFrame
            label={tr('card.cat42')}
            amount={cat42 !== null ? fmtAmountCard(cat42) : null}
            unit="CAT42"
          />
        </View>
        </Pressable>
        <View style={[S.row, { gap: 10, marginTop: 12 }]}>
          {/* v0.4.5 (spec change): the profile jump is a VISIBLE
           * button — the main path to my page, so a beginner sees
           * the tappable place instead of having to discover the
           * card-body tap above. Same button shape/size as its
           * neighbours (44dp target, clear 10px gaps), with an
           * accent label so it reads as navigation, not an action
           * on the money.
           * v0.4.6: the third button is DEPOSIT, not the faucet
           * (user decision, 2026-11-09) — it lands on the My
           * names screen with the active name's deposit controls
           * already open (the existing deposit flow, reached via
           * focusMine). With no name yet there is nothing to
           * deposit into, so it routes to Get-a-name instead —
           * the same answer the name card's no-name state gives.
           * The faucet itself is untouched and stays reachable
           * from the HuntersDEX gas guidance.
           * All three labels are numberOfLines=1 with
           * shrink-to-fit: the v0.4.5 faucet button's label
           * collapsed and split character-by-character
           * vertically on device; three IDENTICAL ghost-button
           * structures leave no room for that failure mode. */}
          <Pressable
            style={[S.ghostBtn, { flex: 1 }]}
            onPress={
              acting ? () => app.openProfile(acting.username) : undefined
            }
            accessibilityRole="button"
          >
            <Text
              style={[S.ghostBtnText, { color: ACCENT, fontWeight: '800' }]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
            >
              {tr('home.profile')}
            </Text>
          </Pressable>
          <Pressable
            style={[S.ghostBtn, { flex: 1 }]}
            onPress={() => setSendOpen(true)}
            accessibilityRole="button"
          >
            <Text
              style={S.ghostBtnText}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
            >
              {tr('send.title')}
            </Text>
          </Pressable>
          <Pressable
            style={[S.ghostBtn, { flex: 1 }]}
            onPress={
              acting
                ? () => app.focusMine(acting.id)
                : () => app.setTab('get')
            }
            accessibilityRole="button"
          >
            <Text
              style={S.ghostBtnText}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
            >
              {tr('home.deposit')}
            </Text>
          </Pressable>
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
                total: String(SUPERLIKE_TOTAL_CAT42),
                author: String(SUPERLIKE_AUTHOR_CAT42),
                burn: String(SUPERLIKE_BURN_CAT42),
                balance:
                  cat42 !== null ? fmtAmountCard(cat42) : '—',
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
        visible={!!slBurnItem}
        title={tr('sl.burnTitle')}
        body={
          slBurnItem
            ? tr('sl.burnBody', {
                burn: String(SUPERLIKE_BURN_CAT42),
                balance:
                  cat42 !== null ? fmtAmountCard(cat42) : '—',
              })
            : ''
        }
        confirmLabel={tr('sl.burnConfirm')}
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmBurn}
        onCancel={() => setSlBurnItem(null)}
        busy={slBurnBusy}
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
      <Modal
        visible={searchOpen}
        animationType="slide"
        onRequestClose={() => setSearchOpen(false)}
      >
        <SearchScreen onClose={() => setSearchOpen(false)} />
      </Modal>
      <Modal
        visible={sendOpen}
        animationType="slide"
        onRequestClose={() => setSendOpen(false)}
      >
        <SendScreen onClose={() => setSendOpen(false)} />
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  /* Wallet card: one clean card — identity + copyable address
     chip on top, then the balances as full-width bordered
     frames (shared BalanceFrame, v0.4.6) and the button row. */
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
    fontFamily: MONO,
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
