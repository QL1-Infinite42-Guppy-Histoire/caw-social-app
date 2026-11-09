import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Avatar,
  ConfirmSheet,
  LoadMoreFooter,
  PostCard,
  S,
  useNameLabel,
} from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { LOCALES, tr } from '../i18n';
import {
  fetchProfilePosts,
  followerCount,
  mintDateOf,
  nameBalance,
  nameOwner,
  resolveName,
  resolveNameId,
  type TimelineItem,
} from '../lib/cawApi';
import { backArrow } from '../lib/rtl';
import {
  buildFollowIndex,
  followIndexProgress,
  followIndexReady,
  followListsOf,
  refinedFollowListsOf,
  subscribeFollowIndex,
  type FollowLists,
} from '../lib/followIndex';
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
import { fmtAmount, fmtAmountCard } from '../lib/cawCore';
import {
  deleteProfileImage,
  pickAndStoreProfileImage,
} from '../lib/profileImage';

type PendingAction = { kind: 1 | 2; item: TimelineItem };
type LoadState = 'loading' | 'ok' | 'fail' | 'notfound';

export default function ProfileScreen({
  username,
  onBack,
}: {
  username: string;
  onBack: () => void;
}) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  // v0.1.5 fix: the profile (and its edit dialog) run inside Modals,
  // outside the main SafeAreaView, so the back row at the very top
  // used to sit under the status bar — same overlap the compose
  // header had. Reserve the top inset on every root view here,
  // matching the bottom-inset pattern LoadMoreFooter already uses.
  const rootStyle = [S.screen, { paddingTop: insets.top }];
  const { lang, address, myTokens, actingId } = app;

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [profileId, setProfileId] = useState<bigint | null>(null);
  const [resolvedName, setResolvedName] = useState<string>(username);
  const [followers, setFollowers] = useState<bigint | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [mintDate, setMintDate] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);

  const [posts, setPosts] = useState<TimelineItem[]>([]);
  const [next, setNext] = useState<Record<string, unknown> | null>(null);
  const [done, setDone] = useState(true);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [statusByHash, setStatusByHash] = useState<Record<string, string>>({});
  const [busyByHash, setBusyByHash] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<PendingAction | null>(null);

  const [followConfirmOpen, setFollowConfirmOpen] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [followStatus, setFollowStatus] = useState('');

  // Following / followers, rebuilt from the public follow records
  // (see followIndex.ts). The followers NUMBER shown is always the
  // chain's own followerCount; these lists are the reconstruction.
  const [followLists, setFollowLists] = useState<FollowLists | null>(null);
  const [listOpen, setListOpen] = useState<'following' | 'followers' | null>(
    null,
  );
  const [listLoading, setListLoading] = useState(false);
  const [listFail, setListFail] = useState(false);
  const [followProgress, setFollowProgress] = useState<number | null>(null);
  /** True once the balance refinement has been applied for the
   *  current profile — progressive (unrefined) updates stop
   *  overwriting the lists after that. */
  const refinedRef = React.useRef(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  const acting =
    myTokens.find((t) => t.id === actingId) ?? myTokens[0] ?? null;
  const actingLabel = acting ? '@' + acting.username : '';

  const isOwn =
    !!address &&
    !!owner &&
    address.toLowerCase() === owner.toLowerCase();
  // The same verdict from the wallet's own loaded name list —
  // synchronous, no chain read to wait for (v0.4.5). The edit
  // entry and the follow-button suppression key off (isOwn ||
  // isMine): a name this wallet holds must never offer a follow
  // button, even while the ownerOf read is still in flight (that
  // gap is how an own profile briefly wore a "Following" pill).
  const isMine =
    profileId !== null && myTokens.some((t) => t.id === profileId);

  // On-device custom look (off-chain) — only ever set for my own names.
  const custom = profileId !== null ? app.customFor(profileId) : undefined;
  const followedByMe =
    profileId !== null ? app.hasFollowed(profileId) : false;

  const openEditor = useCallback(() => {
    setEditName(custom && custom.displayName ? custom.displayName : '');
    setEditBio(custom && custom.bio ? custom.bio : '');
    setEditNote('');
    setEditOpen(true);
  }, [custom]);

  /** One save for both text fields (display name + bio, v0.4.5). */
  const saveTexts = useCallback(async () => {
    if (profileId === null) return;
    setEditBusy(true);
    try {
      await app.saveCustom(profileId, {
        displayName: editName.trim(),
        bio: editBio.trim(),
      });
      setEditNote('');
    } finally {
      setEditBusy(false);
    }
  }, [app, profileId, editName, editBio]);

  const pickImage = useCallback(
    async (kind: 'avatar' | 'header') => {
      if (profileId === null) return;
      setEditBusy(true);
      try {
        const uri = await pickAndStoreProfileImage(profileId, kind);
        if (uri) {
          const old =
            kind === 'avatar'
              ? custom && custom.avatarPath
              : custom && custom.headerPath;
          if (old && old !== uri) deleteProfileImage(old);
          await app.saveCustom(
            profileId,
            kind === 'avatar' ? { avatarPath: uri } : { headerPath: uri },
          );
          setEditNote('');
        }
        // uri === null: the user cancelled (or denied the photo
        // permission) — not an error, nothing to report.
      } catch {
        // Storing the picked picture failed. Until v0.4.5 this was
        // swallowed silently, which read as "the setting does not
        // work"; say so on screen instead.
        setEditNote(tr('custom.pickFail'));
      } finally {
        setEditBusy(false);
      }
    },
    [app, profileId, custom],
  );

  const resetCustom = useCallback(async () => {
    if (profileId === null) return;
    setEditBusy(true);
    try {
      const old = await app.clearCustom(profileId);
      if (old) {
        deleteProfileImage(old.avatarPath);
        deleteProfileImage(old.headerPath);
      }
      setEditName('');
      setEditBio('');
      setEditNote('');
    } finally {
      setEditBusy(false);
    }
  }, [app, profileId]);

  /** Build (or refresh) the follow index and refine this name's
   *  lists. Progressive (v0.3.0): whatever the index already holds
   *  is shown immediately and updated as each page lands; the
   *  balance refinement is applied only when it is ready, so it
   *  never blocks the first paint. */
  const loadFollowLists = useCallback(async (id: bigint) => {
    if (!refinedRef.current) setFollowLists(followListsOf(id));
    await buildFollowIndex((pages) => {
      setFollowProgress(pages);
      if (!refinedRef.current) setFollowLists(followListsOf(id));
    });
    setFollowProgress(null);
    const lists = await refinedFollowListsOf(id);
    refinedRef.current = true;
    setFollowLists(lists);
    return lists;
  }, []);

  const openFollowList = useCallback(
    (which: 'following' | 'followers') => {
      setListOpen(which);
      if (profileId === null) return;
      // Render instantly from whatever the index already holds;
      // the build keeps updating the list while it runs.
      if (!refinedRef.current) setFollowLists(followListsOf(profileId));
      if (followLists) return;
      setListLoading(!followIndexReady());
      setListFail(false);
      loadFollowLists(profileId)
        .catch(() => {
          if (!followIndexReady()) setListFail(true);
        })
        .finally(() => setListLoading(false));
    },
    [followLists, profileId, loadFollowLists],
  );

  // Live-update the open list as the index build merges pages.
  useEffect(() => {
    const unsub = subscribeFollowIndex(() => {
      if (profileId !== null && !refinedRef.current) {
        setFollowLists(followListsOf(profileId));
        if (followIndexReady()) setListLoading(false);
      }
      const p = followIndexProgress();
      setFollowProgress(p.building ? p.pages : null);
    });
    return unsub;
  }, [profileId]);

  const loadProfile = useCallback(async () => {
    setLoadState('loading');
    setFollowers(null);
    setBalance(null);
    setMintDate(null);
    setOwner(null);
    setFollowLists(null);
    refinedRef.current = false;
    setListOpen(null);
    setPosts([]);
    setNext(null);
    setDone(true);
    try {
      const res = await resolveNameId(username);
      if (res.status === 'notfound') {
        setLoadState('notfound');
        return;
      }
      setProfileId(res.id);
      setResolvedName(res.username);
      setLoadState('ok');

      followerCount(res.id)
        .then((v) => setFollowers(v))
        .catch(() => setFollowers(null));
      // Background: follow lists (first build walks the whole feed,
      // later builds are incremental). Never blocks the profile.
      loadFollowLists(res.id).catch(() => {});
      nameBalance(res.id)
        .then((v) => setBalance(v))
        .catch(() => setBalance(null));
      mintDateOf(res.id)
        .then((v) => setMintDate(v))
        .catch(() => setMintDate(null));
      nameOwner(res.id)
        .then((v) => setOwner(v))
        .catch(() => setOwner(null));

      setLoadingPosts(true);
      try {
        const page = await fetchProfilePosts(res.id, null);
        setPosts(page.items);
        setNext(page.next);
        setDone(page.done);
      } catch {
        setPosts([]);
        setDone(true);
      } finally {
        setLoadingPosts(false);
      }
    } catch {
      setLoadState('fail');
    }
  }, [username, loadFollowLists]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const loadMorePosts = useCallback(async () => {
    if (profileId === null || done || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchProfilePosts(profileId, next);
      setPosts((prev) => [...prev, ...page.items]);
      setNext(page.next);
      setDone(page.done);
    } catch {
      // Keep existing posts; the button remains for retry.
    } finally {
      setLoadingMore(false);
    }
  }, [profileId, next, done, loadingMore]);

  /* Recaw offers the same choice as the timeline (v0.4.0):
   * the plain recaw action, or a quote Recaw. */
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

  /* ---------- SuperLike (v0.4.9: wired here too — v0.4.8 had
   * the send flow only on the feed cards, so profile post
   * lists showed the ⭐ count with no way to send one) ----------
   * Same flow, guards and sheets as the timeline: own-post
   * block, known-shortfall hard stop, pending-burn retry that
   * can only send the burn leg. performSuperlike re-checks
   * everything against fresh chain reads before signing. */
  const [slItem, setSlItem] = useState<TimelineItem | null>(null);
  const [slName, setSlName] = useState('');
  const [slOwner, setSlOwner] = useState('');
  const [slBusy, setSlBusy] = useState(false);
  const [slBurnItem, setSlBurnItem] = useState<TimelineItem | null>(null);
  const [slBurnBusy, setSlBurnBusy] = useState(false);

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
        .then((o) => setSlOwner(o.slice(0, 6) + '…' + o.slice(-4)))
        .catch(() => setSlOwner(''));
      setSlItem(item);
    },
    [app],
  );

  const handleSuperlike = useCallback(
    (item: TimelineItem) => {
      if (app.myTokens.some((t) => t.id === item.senderId)) {
        setStatusByHash((prev) => ({
          ...prev,
          [item.hash]: tr('sl.self'),
        }));
        return;
      }
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
    [app, openSuperlikeSheet],
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

  const confirmFollow = useCallback(async () => {
    if (profileId === null) return;
    setFollowBusy(true);
    app.markFollowed(profileId, true).catch(() => {});
    try {
      await performAction(app, {
        kind: 3,
        receiverId: profileId,
        text: 'FOLLOW',
      });
      setFollowStatus(tr('act.followed'));
      setFollowers((f) => (f === null ? f : f + 1n));
    } catch (e) {
      app.markFollowed(profileId, false).catch(() => {});
      const msg =
        e instanceof Error && e.message === 'need-name'
          ? tr('compose.needName')
          : e instanceof Error && e.message === 'self-follow'
            ? tr('act.selfFollow')
            : tr('act.failed');
      setFollowStatus(msg);
    } finally {
      setFollowBusy(false);
      setFollowConfirmOpen(false);
    }
  }, [app, profileId]);

  const backRow = (
    <View style={styles.backRow}>
      <Pressable onPress={onBack} hitSlop={8}>
        <Text style={styles.backText}>{backArrow()} {tr('common.back')}</Text>
      </Pressable>
    </View>
  );

  if (loadState === 'loading') {
    return (
      <View style={rootStyle}>
        {backRow}
        <View style={styles.center}>
          <ActivityIndicator color={ACCENT} />
          <Text style={[S.small, { marginTop: 10 }]}>
            {tr('common.loading')}
          </Text>
        </View>
      </View>
    );
  }

  if (loadState === 'fail') {
    return (
      <View style={rootStyle}>
        {backRow}
        <View style={styles.center}>
          <Text style={S.err}>{tr('profile.loadFail')}</Text>
          <Pressable
            style={[S.ghostBtn, { marginTop: 14 }]}
            onPress={loadProfile}
          >
            <Text style={S.ghostBtnText}>{tr('profile.retry')}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (loadState === 'notfound') {
    return (
      <View style={rootStyle}>
        {backRow}
        <View style={styles.center}>
          <Text style={S.body}>{tr('profile.notFound')}</Text>
        </View>
      </View>
    );
  }

  let mintLabel: string | null = null;
  if (mintDate) {
    try {
      mintLabel = new Date(mintDate).toLocaleDateString(LOCALES[lang]);
    } catch {
      mintLabel = mintDate;
    }
  }

  const header = (
    <View>
      {backRow}
      {custom && custom.headerPath ? (
        <Image
          source={{ uri: custom.headerPath }}
          style={styles.banner}
          resizeMode="cover"
        />
      ) : (
        <LinearGradient
          colors={['#e8590c', '#ffb59e']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.banner}
        />
      )}
      {/* X-style header row: avatar overlapping the banner on the
          left, the page's main action (edit / follow) on the right. */}
      <View style={styles.avatarRow}>
        <View style={styles.avatarWrap}>
          {profileId !== null ? (
            <View style={styles.avatarRing}>
              <Avatar
                nameId={profileId}
                size={96}
                customUri={custom ? custom.avatarPath : undefined}
              />
            </View>
          ) : null}
        </View>
        <View style={styles.headerAction}>
          {isOwn || isMine ? (
            <Pressable
              style={({ pressed }) => [
                S.ghostBtn,
                pressed && { backgroundColor: '#f7f9f9' },
              ]}
              onPress={openEditor}
            >
              <Text style={S.ghostBtnText}>{tr('custom.edit')}</Text>
            </Pressable>
          ) : followedByMe ? (
            <View style={styles.followingPill}>
              <Text style={styles.followingPillText}>
                ✓ {tr('act.following')}
              </Text>
            </View>
          ) : acting ? (
            <Pressable
              style={({ pressed }) => [
                S.darkBtn,
                pressed && { opacity: 0.85 },
              ]}
              onPress={() => setFollowConfirmOpen(true)}
            >
              <Text style={S.darkBtnText}>{tr('act.follow')}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <View style={{ paddingHorizontal: 16 }}>
        {custom && custom.displayName ? (
          <>
            <Text style={styles.username}>{custom.displayName}</Text>
            <Text style={S.small}>@{resolvedName}</Text>
          </>
        ) : (
          <Text style={styles.username}>@{resolvedName}</Text>
        )}

        {custom && custom.bio ? (
          <Text style={[S.body, { marginTop: 8 }]}>{custom.bio}</Text>
        ) : null}

        {isOwn || isMine ? (
          <Text style={[S.ok, { marginTop: 6 }]}>{tr('profile.yourName')}</Text>
        ) : null}
        {followStatus ? (
          <Text style={[S.small, { marginTop: 6 }]}>{followStatus}</Text>
        ) : null}

        <View style={styles.chipRow}>
          {profileId !== null ? (
            <View style={S.chip}>
              <Text style={S.chipText}>#{profileId.toString()}</Text>
            </View>
          ) : null}
          {balance !== null ? (
            <View style={S.chip}>
              <Text style={S.chipText}>
                {tr('profile.inName')} {fmtAmount(balance)} CAW
              </Text>
            </View>
          ) : null}
          {mintLabel ? (
            <View style={S.chip}>
              <Text style={S.chipText}>
                {tr('profile.nameMade')} {mintLabel}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Following / followers counts — tappable, X-style. The
            followers number is the chain's own count; the lists
            behind both numbers are rebuilt from the public follow
            records (followIndex.ts). */}
        <View style={styles.countsRow}>
          <Pressable
            onPress={() => openFollowList('following')}
            hitSlop={6}
            style={({ pressed }) => [styles.countCell, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.countNum}>
              {followLists ? followLists.following.length : '—'}
            </Text>
            <Text style={S.tiny}>{tr('followlist.following')}</Text>
          </Pressable>
          <View style={styles.countDivider} />
          <Pressable
            onPress={() => openFollowList('followers')}
            hitSlop={6}
            style={({ pressed }) => [styles.countCell, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.countNum}>
              {followers !== null ? followers.toString() : '—'}
            </Text>
            <Text style={S.tiny}>{tr('followlist.followers')}</Text>
          </Pressable>
        </View>

        <Text style={[S.h2, { marginTop: 18, marginBottom: 4 }]}>
          {tr('profile.posts')}
        </Text>
      </View>
    </View>
  );

  return (
    <View style={rootStyle}>
      <FlatList
        data={posts}
        keyExtractor={(item, idx) => item.hash + ':' + idx}
        ListHeaderComponent={header}
        renderItem={({ item }) => (
          <PostCard
            item={item}
            lang={lang}
            onOpenProfile={(name) => app.openProfile(name)}
            onAction={handleAction}
            onSuperlike={handleSuperlike}
            onOpenPost={(it) => app.openPost(it)}
            onReply={(it) => app.openCompose({ kind: 'reply', post: it })}
            actionStatus={statusByHash[item.hash]}
            busy={!!busyByHash[item.hash]}
            liked={app.hasMyAction(1, item)}
            recawed={app.hasMyAction(2, item)}
            custom={app.customFor(item.senderId)}
          />
        )}
        ListEmptyComponent={
          loadingPosts ? (
            <View style={styles.center}>
              <ActivityIndicator color={ACCENT} />
              <Text style={[S.small, { marginTop: 10 }]}>
                {tr('profile.searching')}
              </Text>
            </View>
          ) : (
            <View style={{ paddingHorizontal: 16 }}>
              <View style={S.emptyCard}>
                <Text style={S.small}>{tr('profile.empty')}</Text>
              </View>
            </View>
          )
        }
        ListFooterComponent={
          !done && posts.length > 0 ? (
            <LoadMoreFooter
              loading={loadingMore}
              onPress={loadMorePosts}
              label={tr('profile.more')}
            />
          ) : undefined
        }
        windowSize={7}
        maxToRenderPerBatch={12}
        removeClippedSubviews
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
                  app.cat42 !== null ? fmtAmountCard(app.cat42) : '—',
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
                  app.cat42 !== null ? fmtAmountCard(app.cat42) : '—',
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
      <ConfirmSheet
        visible={followConfirmOpen}
        title={tr('act.confirmFollow', {
          name: actingLabel,
          target: '@' + resolvedName,
        })}
        confirmLabel={tr('act.follow')}
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmFollow}
        onCancel={() => setFollowConfirmOpen(false)}
        busy={followBusy}
      />

      {/* Following / followers list */}
      <Modal
        visible={listOpen !== null}
        animationType="slide"
        onRequestClose={() => setListOpen(null)}
      >
        <View style={rootStyle}>
          <View style={styles.backRow}>
            <Pressable onPress={() => setListOpen(null)} hitSlop={8}>
              <Text style={styles.backText}>{backArrow()} {tr('common.back')}</Text>
            </Pressable>
            <Text style={styles.listTitle}>@{resolvedName}</Text>
          </View>
          <View style={styles.tabRow}>
            {(['following', 'followers'] as const).map((t) => (
              <Pressable
                key={t}
                style={styles.tabItem}
                onPress={() => setListOpen(t)}
              >
                <Text
                  style={[
                    styles.tabLabel,
                    listOpen === t && styles.tabLabelOn,
                  ]}
                >
                  {t === 'following'
                    ? tr('followlist.following')
                    : tr('followlist.followers')}
                  {'  '}
                  {t === 'following'
                    ? followLists
                      ? followLists.following.length
                      : ''
                    : followers !== null
                      ? followers.toString()
                      : ''}
                </Text>
                {listOpen === t ? <View style={styles.tabBar} /> : null}
              </Pressable>
            ))}
          </View>
          {(followLists === null && !listFail) ||
          (listLoading && !followIndexReady() && followLists === null) ? (
            <View style={styles.center}>
              <ActivityIndicator color={ACCENT} />
              <Text style={[S.small, { marginTop: 10 }]}>
                {tr('followlist.loading')}
              </Text>
            </View>
          ) : listFail ? (
            <View style={styles.center}>
              <Text style={S.err}>{tr('followlist.loadFail')}</Text>
              <Pressable
                style={[S.ghostBtn, { marginTop: 14 }]}
                onPress={() => {
                  if (profileId === null) return;
                  setListFail(false);
                  setListLoading(true);
                  loadFollowLists(profileId)
                    .catch(() => setListFail(true))
                    .finally(() => setListLoading(false));
                }}
              >
                <Text style={S.ghostBtnText}>{tr('profile.retry')}</Text>
              </Pressable>
            </View>
          ) : (
            <FlatList
              data={
                followLists
                  ? listOpen === 'following'
                    ? followLists.following
                    : followLists.followers
                  : []
              }
              keyExtractor={(id) => id.toString()}
              renderItem={({ item }) => (
                <FollowRow
                  id={item}
                  customUri={
                    app.customFor(item)
                      ? app.customFor(item)!.avatarPath
                      : undefined
                  }
                  onOpen={(name) => {
                    setListOpen(null);
                    app.openProfile(name);
                  }}
                />
              )}
              ListHeaderComponent={
                followProgress !== null ? (
                  <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                    <Text style={S.tiny}>
                      {tr('followlist.building', {
                        pages: String(followProgress),
                      })}
                    </Text>
                  </View>
                ) : undefined
              }
              ListEmptyComponent={
                <View style={{ padding: 24, alignItems: 'center' }}>
                  <Text style={S.small}>{tr('followlist.empty')}</Text>
                </View>
              }
              windowSize={7}
              maxToRenderPerBatch={16}
            />
          )}
        </View>
      </Modal>

      <Modal
        visible={editOpen}
        animationType="slide"
        onRequestClose={() => setEditOpen(false)}
      >
        <View style={rootStyle}>
          <View style={styles.backRow}>
            <Pressable onPress={() => setEditOpen(false)} hitSlop={8}>
              <Text style={styles.backText}>{backArrow()} {tr('common.back')}</Text>
            </Pressable>
          </View>
          <View style={S.scrollPad}>
            <Text style={S.h1}>{tr('custom.title')}</Text>
            <Text style={[S.small, { marginTop: 8 }]}>{tr('custom.note')}</Text>

            <Text style={S.h2}>{tr('custom.displayName')}</Text>
            <TextInput
              style={[S.input, { marginTop: 8 }]}
              value={editName}
              onChangeText={setEditName}
              placeholder={tr('custom.displayNamePh')}
              maxLength={40}
              autoCorrect={false}
            />
            <Text style={[S.h2, { marginTop: 18 }]}>{tr('custom.bio')}</Text>
            <TextInput
              style={[S.input, { marginTop: 8, minHeight: 72, textAlignVertical: 'top' }]}
              value={editBio}
              onChangeText={setEditBio}
              placeholder={tr('custom.bioPh')}
              maxLength={160}
              multiline
              autoCorrect={false}
            />
            <Pressable
              style={[S.bigBtn, { marginTop: 12 }, editBusy && S.disabled]}
              disabled={editBusy}
              onPress={saveTexts}
            >
              <Text style={S.bigBtnText}>{tr('custom.save')}</Text>
            </Pressable>

            <View style={{ height: 18 }} />
            <Pressable
              style={[S.ghostBtn, editBusy && S.disabled]}
              disabled={editBusy}
              onPress={() => pickImage('avatar')}
            >
              <Text style={S.ghostBtnText}>
                {tr('custom.pickAvatar')}
                {custom && custom.avatarPath ? '' : '（' + tr('custom.notSet') + '）'}
              </Text>
            </Pressable>
            <View style={{ height: 10 }} />
            <Pressable
              style={[S.ghostBtn, editBusy && S.disabled]}
              disabled={editBusy}
              onPress={() => pickImage('header')}
            >
              <Text style={S.ghostBtnText}>
                {tr('custom.pickHeader')}
                {custom && custom.headerPath ? '' : '（' + tr('custom.notSet') + '）'}
              </Text>
            </Pressable>

            {editNote ? (
              <Text style={[S.err, { marginTop: 14 }]}>{editNote}</Text>
            ) : null}

            <View style={{ height: 18 }} />
            <Pressable
              style={[S.ghostBtn, editBusy && S.disabled]}
              disabled={editBusy}
              onPress={resetCustom}
            >
              <Text style={S.ghostBtnText}>{tr('custom.reset')}</Text>
            </Pressable>
            {editBusy ? (
              <ActivityIndicator color={ACCENT} style={{ marginTop: 16 }} />
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

/** One row in the following / followers list. */
function FollowRow({
  id,
  customUri,
  onOpen,
}: {
  id: bigint;
  customUri?: string | null;
  onOpen: (name: string) => void;
}) {
  const label = useNameLabel(id);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    resolveName(id).then((n) => live && setName(n));
    return () => {
      live = false;
    };
  }, [id]);
  return (
    <Pressable
      style={({ pressed }) => [
        styles.followRow,
        pressed && { backgroundColor: '#f7f9f9' },
      ]}
      onPress={name ? () => onOpen(name) : undefined}
    >
      <Avatar nameId={id} size={44} customUri={customUri} />
      <View style={{ marginStart: 10, flex: 1 }}>
        <Text style={styles.followName}>{label}</Text>
        <Text style={S.tiny}>#{id.toString()}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
  backRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
    backgroundColor: '#fff',
  },
  backText: { fontSize: 15, color: ACCENT, fontWeight: '600' },
  banner: { height: 110 },
  avatarRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
  },
  avatarWrap: { marginTop: -48 },
  headerAction: { paddingTop: 10 },
  avatarRing: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  followingPill: {
    borderWidth: 1,
    borderColor: '#cfd9de',
    borderRadius: 999,
    paddingVertical: 9,
    paddingHorizontal: 16,
    backgroundColor: '#fff',
  },
  followingPillText: { fontSize: 14, fontWeight: '700', color: '#0f1419' },
  username: { fontSize: 20, fontWeight: '800', color: '#0f1419', marginTop: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  countsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#eff3f4',
    borderRadius: 14,
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  countCell: { flex: 1, alignItems: 'center', paddingVertical: 10, gap: 1 },
  countDivider: { width: 1, backgroundColor: '#eff3f4' },
  countNum: { fontSize: 16, fontWeight: '800', color: '#0f1419' },
  listTitle: { fontSize: 16, fontWeight: '800', color: '#0f1419', marginTop: 6 },
  tabRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
  },
  tabItem: { flex: 1, alignItems: 'center', paddingTop: 12, paddingBottom: 0 },
  tabLabel: { fontSize: 14.5, fontWeight: '600', color: '#536471', paddingBottom: 10 },
  tabLabelOn: { color: '#0f1419', fontWeight: '800' },
  tabBar: {
    height: 3,
    width: '70%',
    borderRadius: 2,
    backgroundColor: ACCENT,
    marginBottom: -1,
  },
  followRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
    backgroundColor: '#fff',
  },
  followName: { fontSize: 15, fontWeight: '700', color: '#0f1419' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
