import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  ConfirmSheet,
  NameRow,
  PostCard,
  ReplyIcon,
  S,
  TipSheet,
} from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import {
  fetchPostReactions,
  fetchPostThread,
  nameOwner,
  resolveName,
  type RefChild,
  type TimelineItem,
} from '../lib/cawApi';
import {
  performSuperlike,
  performTip,
} from '../lib/actionFlow';
import { SUPERLIKE_PRICE_RAW } from '../lib/superlike';
import { fmtAmountCardDec } from '../lib/cawCore';
import { backArrow } from '../lib/rtl';

/**
 * Post detail (v0.2.0): the post itself, then who liked it and who
 * shared it. The lists are gathered from the public action feed —
 * reactions can only exist after the post, so the scan window is
 * "from now back to the post", and the screen says so when even
 * that window had to be cut short.
 */
export default function PostDetailScreen({
  post,
  onBack,
}: {
  post: TimelineItem;
  onBack: () => void;
}) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [likes, setLikes] = useState<bigint[] | null>(null);
  const [shares, setShares] = useState<bigint[] | null>(null);
  const [complete, setComplete] = useState(true);
  const [failed, setFailed] = useState(false);
  /* Reply thread (v0.4.0): the original post, then its replies
   * in time order. Quote Recaws of this post are posts of their
   * own and never appear here; plain recaws are the shares list. */
  const [replies, setReplies] = useState<RefChild[] | null>(null);
  const [threadComplete, setThreadComplete] = useState(true);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const r = await fetchPostReactions(post);
      setLikes(r.likes);
      setShares(r.shares);
      setComplete(r.complete);
    } catch {
      setFailed(true);
    }
    try {
      const t = await fetchPostThread(post);
      setReplies(t.replies);
      setThreadComplete(t.complete);
    } catch {
      setReplies([]);
      setThreadComplete(false);
    }
  }, [post]);

  useEffect(() => {
    load();
  }, [load]);

  const openProfile = useCallback(
    (username: string) => {
      onBack();
      app.openProfile(username);
    },
    [app, onBack],
  );

  /* ---------- SuperLike (v0.4.9; O-burn design v0.5.0) ----------
   * The detail view renders the same PostCard as the feed and
   * the profile lists, so it offers the same ⭐ flow with the
   * same guards (own-post block, fresh-balance hard stop). One
   * O burn transaction — no debt state. */
  const [slStatus, setSlStatus] = useState<Record<string, string>>({});
  const [slBusyHash, setSlBusyHash] = useState<Record<string, boolean>>({});
  const [slItem, setSlItem] = useState<TimelineItem | null>(null);
  const [slName, setSlName] = useState('');
  const [slOwner, setSlOwner] = useState('');
  const [slBusy, setSlBusy] = useState(false);

  const openSuperlikeSheet = useCallback(
    (item: TimelineItem) => {
      if (app.oTok !== null && app.oTok.raw < SUPERLIKE_PRICE_RAW) {
        setSlStatus((prev) => ({ ...prev, [item.hash]: tr('sl.shortfall') }));
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
        setSlStatus((prev) => ({ ...prev, [item.hash]: tr('sl.self') }));
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
    setSlBusyHash((prev) => ({ ...prev, [item.hash]: true }));
    try {
      await performSuperlike(app, { target: item });
      setSlStatus((prev) => ({ ...prev, [item.hash]: tr('sl.done') }));
    } catch (e) {
      const msg =
        e instanceof Error && e.message === 'self-superlike'
          ? tr('sl.self')
          : e instanceof Error && e.message === 'shortfall'
            ? tr('sl.shortfall')
            : tr('act.failed');
      setSlStatus((prev) => ({ ...prev, [item.hash]: msg }));
    } finally {
      setSlBusy(false);
      setSlBusyHash((prev) => ({ ...prev, [item.hash]: false }));
      setSlItem(null);
    }
  }, [app, slItem]);

  /* ---------- Tip (v0.5.0) ---------- */
  const [tipItem, setTipItem] = useState<TimelineItem | null>(null);
  const [tipName, setTipName] = useState('');
  const [tipRecipient, setTipRecipient] = useState<string | null>(null);
  const [tipBusy, setTipBusy] = useState(false);

  const handleTip = useCallback(
    (item: TimelineItem) => {
      if (app.myTokens.some((t) => t.id === item.senderId)) {
        setSlStatus((prev) => ({ ...prev, [item.hash]: tr('tip.self') }));
        return;
      }
      resolveName(item.senderId)
        .then((n) => setTipName(n ? '@' + n : ''))
        .catch(() => setTipName(''));
      /* M1: recipient for the sheet's spot-check line —
       * performTip re-resolves and cross-checks at send. */
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
      setSlBusyHash((prev) => ({ ...prev, [item.hash]: true }));
      try {
        await performTip(app, { target: item, amountRaw });
        setSlStatus((prev) => ({ ...prev, [item.hash]: tr('tip.done') }));
      } catch (e) {
        const msg =
          e instanceof Error && e.message === 'self-tip'
            ? tr('tip.self')
            : e instanceof Error && e.message === 'shortfall'
              ? tr('tip.shortfall')
              : e instanceof Error && e.message === 'recipient-mismatch'
                ? tr('tip.mismatch')
                : tr('act.failed');
        setSlStatus((prev) => ({ ...prev, [item.hash]: msg }));
      } finally {
        setTipBusy(false);
        setSlBusyHash((prev) => ({ ...prev, [item.hash]: false }));
        setTipItem(null);
      }
    },
    [app, tipItem],
  );

  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={styles.backText}>{backArrow()} {tr('common.back')}</Text>
        </Pressable>
        <Text style={S.h2}>{tr('detail.title')}</Text>
        <View style={{ width: 60 }} />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 + insets.bottom }}>
        <PostCard
          item={post}
          lang={app.lang}
          onOpenProfile={openProfile}
          onOpenPost={(it) => app.openPost(it)}
          onReply={(it) => app.openCompose({ kind: 'reply', post: it })}
          onSuperlike={handleSuperlike}
          onTip={handleTip}
          actionStatus={slStatus[post.hash]}
          busy={!!slBusyHash[post.hash]}
          liked={app.hasMyAction(1, post)}
          recawed={app.hasMyAction(2, post)}
          custom={app.customFor(post.senderId)}
        />
        {failed ? (
          <View style={styles.center}>
            <Text style={S.err}>{tr('detail.loadFail')}</Text>
            <Pressable
              style={[S.ghostBtn, { marginTop: 12 }]}
              onPress={() => {
                setLikes(null);
                setShares(null);
                setReplies(null);
                load();
              }}
            >
              <Text style={S.ghostBtnText}>{tr('profile.retry')}</Text>
            </Pressable>
          </View>
        ) : likes === null || shares === null ? (
          <View style={styles.center}>
            <ActivityIndicator color={ACCENT} />
            <Text style={[S.small, { marginTop: 10 }]}>
              {tr('detail.loading')}
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.sectionRow}>
              <View style={[styles.sectionBadge, { backgroundColor: '#e0245e' }]}>
                <Text style={styles.sectionBadgeText}>♥</Text>
              </View>
              <Text style={S.h2}>
                {tr('detail.likedBy')} · {likes.length}
              </Text>
            </View>
            {likes.length === 0 ? (
              <View style={[S.emptyCard, styles.emptyCardPad]}>
                <Text style={S.small}>{tr('detail.noneYet')}</Text>
              </View>
            ) : (
              likes.map((id) => (
                <NameRow
                  key={'l' + id.toString()}
                  nameId={id}
                  onOpenProfile={openProfile}
                />
              ))
            )}
            <View style={styles.sectionRow}>
              <View style={[styles.sectionBadge, { backgroundColor: '#17bf63' }]}>
                <Text style={styles.sectionBadgeText}>🔁</Text>
              </View>
              <Text style={S.h2}>
                {tr('detail.sharedBy')} · {shares.length}
              </Text>
            </View>
            {shares.length === 0 ? (
              <View style={[S.emptyCard, styles.emptyCardPad]}>
                <Text style={S.small}>{tr('detail.noneYet')}</Text>
              </View>
            ) : (
              shares.map((id) => (
                <NameRow
                  key={'s' + id.toString()}
                  nameId={id}
                  onOpenProfile={openProfile}
                />
              ))
            )}
            <View style={styles.sectionRow}>
              <View style={[styles.sectionBadge, { backgroundColor: '#1d9bf0' }]}>
                <ReplyIcon size={13} color="#fff" />
              </View>
              <Text style={S.h2}>
                {tr('detail.replies')} · {replies ? replies.length : '…'}
              </Text>
            </View>
            {replies === null ? (
              <View style={styles.center}>
                <ActivityIndicator color={ACCENT} />
              </View>
            ) : replies.length === 0 ? (
              <View style={[S.emptyCard, styles.emptyCardPad]}>
                <Text style={S.small}>{tr('detail.noneYet')}</Text>
              </View>
            ) : (
              replies.map((r) => (
                <PostCard
                  key={r.hash + ':' + r.cawId}
                  item={r}
                  lang={app.lang}
                  onOpenProfile={openProfile}
                  onOpenPost={(it) => app.openPost(it)}
                  onReply={(it) =>
                    app.openCompose({ kind: 'reply', post: it })
                  }
                  onSuperlike={handleSuperlike}
                  onTip={handleTip}
                  actionStatus={slStatus[r.hash]}
                  busy={!!slBusyHash[r.hash]}
                  liked={app.hasMyAction(1, r)}
                  recawed={app.hasMyAction(2, r)}
                  custom={app.customFor(r.senderId)}
                />
              ))
            )}
            {!threadComplete ? (
              <Text style={[S.tiny, styles.note]}>
                {tr('detail.incomplete')}
              </Text>
            ) : null}
            {!complete ? (
              <Text style={[S.tiny, styles.note]}>
                {tr('detail.incomplete')}
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
      <ConfirmSheet
        visible={!!slItem}
        title={tr('sl.title')}
        body={
          slItem
            ? tr('sl.body', {
                name: slName || '—',
                addr: slOwner || '—',
                price: fmtAmountCardDec(SUPERLIKE_PRICE_RAW, 18),
                balance:
                  app.oTok !== null
                    ? fmtAmountCardDec(app.oTok.raw, app.oTok.decimals)
                    : '—',
              })
            : ''
        }
        confirmLabel={tr('sl.confirm')}
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmSuperlike}
        onCancel={() => setSlItem(null)}
        busy={slBusy}
      />
      <TipSheet
        visible={!!tipItem}
        authorLabel={tipName}
        recipient={tipRecipient}
        balanceRaw={app.cat42}
        busy={tipBusy}
        onConfirm={confirmTip}
        onCancel={() => setTipItem(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
  },
  backText: { fontSize: 15, color: ACCENT, fontWeight: '600', width: 60 },
  center: { alignItems: 'center', padding: 28 },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 20,
    marginBottom: 4,
    paddingHorizontal: 16,
  },
  sectionBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionBadgeText: { fontSize: 12, color: '#fff', fontWeight: '700' },
  emptyCardPad: { marginHorizontal: 16, paddingVertical: 18 },
  note: { paddingHorizontal: 16, paddingVertical: 12 },
});
