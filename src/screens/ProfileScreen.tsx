import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { Avatar, ConfirmSheet, PostCard, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import {
  fetchProfilePosts,
  followerCount,
  mintDateOf,
  nameBalance,
  nameOwner,
  resolveNameId,
  type TimelineItem,
} from '../lib/cawApi';
import { performAction } from '../lib/actionFlow';
import { fmtAmount } from '../lib/cawCore';

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

  const acting =
    myTokens.find((t) => t.id === actingId) ?? myTokens[0] ?? null;
  const actingLabel = acting ? '@' + acting.username : '';

  const isOwn =
    !!address &&
    !!owner &&
    address.toLowerCase() === owner.toLowerCase();

  const loadProfile = useCallback(async () => {
    setLoadState('loading');
    setFollowers(null);
    setBalance(null);
    setMintDate(null);
    setOwner(null);
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
  }, [username]);

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
    try {
      await performAction(app, {
        kind,
        target: item,
        text: kind === 1 ? 'LIKE' : 'REPOST',
      });
      setStatusByHash((prev) => ({ ...prev, [item.hash]: tr('act.done') }));
    } catch (e) {
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

  const confirmFollow = useCallback(async () => {
    if (profileId === null) return;
    setFollowBusy(true);
    try {
      await performAction(app, {
        kind: 3,
        receiverId: profileId,
        text: 'FOLLOW',
      });
      setFollowStatus(tr('act.followed'));
    } catch (e) {
      const msg =
        e instanceof Error && e.message === 'need-name'
          ? tr('compose.needName')
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
        <Text style={styles.backText}>← {tr('common.back')}</Text>
      </Pressable>
    </View>
  );

  if (loadState === 'loading') {
    return (
      <View style={S.screen}>
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
      <View style={S.screen}>
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
      <View style={S.screen}>
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
      mintLabel = new Date(mintDate).toLocaleDateString(
        lang === 'ja' ? 'ja-JP' : 'en-US',
      );
    } catch {
      mintLabel = mintDate;
    }
  }

  const header = (
    <View>
      {backRow}
      <LinearGradient
        colors={['#e8590c', '#ffb59e']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.banner}
      />
      <View style={styles.avatarWrap}>
        {profileId !== null ? (
          <View style={styles.avatarRing}>
            <Avatar nameId={profileId} size={96} />
          </View>
        ) : null}
      </View>
      <View style={{ paddingHorizontal: 16 }}>
        <Text style={styles.username}>@{resolvedName}</Text>

        <View style={styles.chipRow}>
          {profileId !== null ? (
            <View style={S.chip}>
              <Text style={S.chipText}>#{profileId.toString()}</Text>
            </View>
          ) : null}
          {followers !== null ? (
            <View style={S.chip}>
              <Text style={S.chipText}>
                {followers.toString()} {tr('profile.followers')}
              </Text>
            </View>
          ) : null}
          {balance !== null ? (
            <View style={S.chip}>
              <Text style={S.chipText}>
                {tr('profile.inName')} {fmtAmount(balance)} qCAW
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

        {isOwn ? (
          <Text style={[S.ok, { marginTop: 10 }]}>
            {tr('profile.yourName')}
          </Text>
        ) : acting ? (
          <View style={{ marginTop: 12, alignItems: 'flex-start' }}>
            <Pressable
              style={S.darkBtn}
              onPress={() => setFollowConfirmOpen(true)}
            >
              <Text style={S.darkBtnText}>{tr('act.follow')}</Text>
            </Pressable>
            {followStatus ? (
              <Text style={[S.small, { marginTop: 8 }]}>{followStatus}</Text>
            ) : null}
          </View>
        ) : followStatus ? (
          <Text style={[S.small, { marginTop: 10 }]}>{followStatus}</Text>
        ) : null}

        <Text style={[S.h2, { marginTop: 18, marginBottom: 4 }]}>
          {tr('profile.posts')}
        </Text>
      </View>
    </View>
  );

  return (
    <View style={S.screen}>
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
            actionStatus={statusByHash[item.hash]}
            busy={!!busyByHash[item.hash]}
          />
        )}
        ListEmptyComponent={
          loadingPosts ? (
            <View style={styles.center}>
              <ActivityIndicator color={ACCENT} />
            </View>
          ) : (
            <View style={{ padding: 24, alignItems: 'center' }}>
              <Text style={S.small}>{tr('profile.empty')}</Text>
            </View>
          )
        }
        ListFooterComponent={
          !done && posts.length > 0 ? (
            <View style={{ padding: 16, alignItems: 'center' }}>
              {loadingMore ? (
                <ActivityIndicator color={ACCENT} />
              ) : (
                <Pressable style={S.ghostBtn} onPress={loadMorePosts}>
                  <Text style={S.ghostBtnText}>{tr('profile.more')}</Text>
                </Pressable>
              )}
            </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  backRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
    backgroundColor: '#fff',
  },
  backText: { fontSize: 15, color: ACCENT, fontWeight: '600' },
  banner: { height: 110 },
  avatarWrap: { paddingHorizontal: 16, marginTop: -48 },
  avatarRing: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  username: { fontSize: 20, fontWeight: '800', color: '#0f1419', marginTop: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
