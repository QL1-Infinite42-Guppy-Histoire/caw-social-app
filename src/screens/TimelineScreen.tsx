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
  BalanceGrid,
  ConfirmSheet,
  HAIRLINE,
  LoadMoreFooter,
  MONO,
  PostCard,
  S,
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
  const { lang, address, qom, qcaw, f42, cat42, oTok, ket, myTokens, actingId } = app;

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
        {/* Balances (v0.4.10): the two-column BalanceGrid —
         * the same component, cells and order as the name
         * card. History: v0.4.5's squeezed row -> v0.4.6's
         * full-width frames (five by v0.4.8, compacted in
         * v0.4.9) -> this grid, which fits SEVEN balances in
         * less height than the five frames took. The grid
         * formats each cell itself (fmtCardDisplay: B/M
         * abbreviation for big figures, tap for the exact
         * number). The deposited CAW is the active name's
         * in-name balance (cawBalanceOf, carried on the token
         * from the same enumeration); no name yet -> the
         * honest dash. Every balance follows the v0.4.7 rule
         * exactly: unread/failed reads render the dash,
         * never a numeric 0. v0.4.10's additions: O
         * (Childhoods End — read on QL1, the chain its
         * contract lives on) and KET (42 Chain), each at the
         * decimals its contract reports. CAT42's caption now
         * says it is the tip currency (user direction
         * 2026-11-10); SuperLike itself is unchanged. */}
        <View style={{ marginTop: 12 }}>
          <BalanceGrid
            cells={[
              { label: tr('home.qcaw'), unit: 'CAW', raw: qcaw },
              { label: tr('home.qom'), unit: 'QOM', raw: qom },
              {
                label: tr('card.inName'),
                unit: 'CAW',
                raw: acting ? acting.balance : null,
              },
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
            onTip={handleTip}
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
              <Text style={S.bigBtnText}>
                ⭐ {tr('tl.superRecaw')}（
                {fmtAmountCardDec(MARKED_BURN_PRICE_RAW, 18)} O）
              </Text>
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
     grid (shared BalanceGrid, v0.4.10) and the button row. */
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
