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
  RepeatIcon,
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
  performAuthorPay,
  performSuperlike,
  performTip,
} from '../lib/actionFlow';
import {
  SUPERLIKE_AUTHOR_RAW,
  SUPERLIKE_BURN_RAW,
  SUPERLIKE_TOTAL_RAW,
} from '../lib/superlike';
import {
  pendingAuthorPayFor,
  type AuthorPayKind,
} from '../lib/authorPay';
import { fmtAmountCardDec } from '../lib/cawCore';
import { backArrow } from '../lib/rtl';
import {
  MediaApiError,
  filterModeratedItems,
  invalidateAttachments,
  type PostAttachment,
} from '../lib/mediaApi';
import {
  applyMediaHidden,
  applyMediaUnhidden,
  applyPostHidden,
  modErrorText,
  refreshHiddenMedia,
  runAdminOp,
  useModeration,
} from '../lib/moderation';

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

  /* ---------- Moderation (v0.7.6) ----------
   * A hidden post opened directly shows the hidden-by-a-
   * moderator state to non-admins (its content, reactions
   * and thread are not rendered); admins see the post itself
   * (dimmed + badged) with the Hide/Unhide control. Hidden
   * replies leave the thread for non-admins. */
  const mod = useModeration();
  const postHidden = mod.isPostHidden(post.cawId);
  const [modPostPending, setModPostPending] = useState<TimelineItem | null>(
    null,
  );
  const [modAttPending, setModAttPending] = useState<{
    item: TimelineItem;
    hash: string;
    verb: 'hide' | 'unhide' | 'delete';
  } | null>(null);
  const [modBusy, setModBusy] = useState(false);
  const [attTicks, setAttTicks] = useState<Record<string, number>>({});

  const bumpAttTick = useCallback((cawId: string) => {
    const key = cawId.toLowerCase();
    setAttTicks((t) => ({ ...t, [key]: (t[key] ?? 0) + 1 }));
  }, []);

  const confirmModPost = useCallback(async () => {
    const item = modPostPending;
    if (!item) return;
    const hidden = mod.isPostHidden(item.cawId);
    setModBusy(true);
    try {
      await runAdminOp(app.getSecret(), {
        action: hidden ? 'unhide-post' : 'hide-post',
        cawId: item.cawId,
      });
      applyPostHidden(item.cawId, !hidden);
    } catch (e) {
      setSlStatus((prev) => ({ ...prev, [item.hash]: modErrorText(e) }));
    } finally {
      setModBusy(false);
      setModPostPending(null);
    }
  }, [app, mod, modPostPending]);

  const confirmModAtt = useCallback(async () => {
    const p = modAttPending;
    if (!p) return;
    setModBusy(true);
    try {
      await runAdminOp(app.getSecret(), {
        action: p.verb + '-attach',
        cawId: p.item.cawId,
        sha256: p.hash,
      });
      const entry = {
        kind: 'attach' as const,
        cawId: p.item.cawId.toLowerCase(),
        hash: p.hash,
        hiddenBy: app.address ?? '',
        ts: Date.now(),
      };
      if (p.verb === 'hide') applyMediaHidden(entry);
      else applyMediaUnhidden(entry);
      if (p.verb === 'delete') {
        invalidateAttachments(p.item.cawId);
        bumpAttTick(p.item.cawId);
      }
      refreshHiddenMedia(app.getSecret()).catch(() => {});
    } catch (e) {
      setSlStatus((prev) => ({
        ...prev,
        [p.item.hash]: modErrorText(e),
      }));
      if (e instanceof MediaApiError && e.status === 409) {
        invalidateAttachments(p.item.cawId);
        bumpAttTick(p.item.cawId);
      }
    } finally {
      setModBusy(false);
      setModAttPending(null);
    }
  }, [app, modAttPending, bumpAttTick]);

  const onModTogglePost = useCallback(
    (item: TimelineItem) => setModPostPending(item),
    [],
  );
  const onModAttach = useCallback(
    (
      item: TimelineItem,
      hash: string,
      _att: PostAttachment | null,
      verb: 'hide' | 'unhide' | 'delete',
    ) => setModAttPending({ item, hash, verb }),
    [],
  );

  const shownReplies = replies
    ? filterModeratedItems(replies, mod.hiddenPosts, mod.isAdmin)
    : null;

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

  /* ---------- SuperLike (v0.4.9; O-burn design v0.5.0; two-leg
   * design v0.6.3) ----------
   * The detail view renders the same PostCard as the feed and
   * the profile lists, so it offers the same SuperLike flow with
   * the same guards (own-post block, fresh-balance hard stop).
   * 25,000,000 O in two legs; a failed author payment after
   * the burn leaves the payment-only debt, retried from the
   * ⭐ tap like everywhere else. */
  const [slStatus, setSlStatus] = useState<Record<string, string>>({});
  const [slBusyHash, setSlBusyHash] = useState<Record<string, boolean>>({});
  const [slItem, setSlItem] = useState<TimelineItem | null>(null);
  const [slName, setSlName] = useState('');
  const [slOwner, setSlOwner] = useState('');
  const [slBusy, setSlBusy] = useState(false);

  const oBalanceText = useCallback((): string => {
    return app.oTok !== null
      ? fmtAmountCardDec(app.oTok.raw, app.oTok.decimals)
      : '—';
  }, [app]);

  const openSuperlikeSheet = useCallback(
    (item: TimelineItem) => {
      if (app.oTok !== null && app.oTok.raw < SUPERLIKE_TOTAL_RAW) {
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
      // v0.6.3: an owed author payment opens the payment-only
      // sheet — a fresh SuperLike would burn a second time.
      if (app.address) {
        pendingAuthorPayFor(app.address, 'sl', item.cawId)
          .then((pay) => {
            if (pay) {
              openPaySheet(item, 'sl', pay.amountRaw, pay.author);
              return;
            }
            startSuperlike(item);
          })
          .catch(() => startSuperlike(item));
        return;
      }
      startSuperlike(item);
    },
    [app],
  );

  const startSuperlike = useCallback(
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
            : e instanceof Error && e.message === 'sl-pay-pending'
              ? tr('sl.payPending')
              : tr('act.failed');
      setSlStatus((prev) => ({ ...prev, [item.hash]: msg }));
    } finally {
      setSlBusy(false);
      setSlBusyHash((prev) => ({ ...prev, [item.hash]: false }));
      setSlItem(null);
    }
  }, [app, slItem]);

  /* ---------- Author-payment debt (v0.6.3) ----------
   * The payment-only retry (see the timeline): this sheet can
   * send ONLY the plain transfer — never a second burn. */
  const [payTarget, setPayTarget] = useState<{
    item: TimelineItem;
    kind: AuthorPayKind;
    amountRaw: bigint;
    author: string;
  } | null>(null);
  const [payName, setPayName] = useState('');
  const [payAddr, setPayAddr] = useState('');
  const [payBusy, setPayBusy] = useState(false);

  const openPaySheet = useCallback(
    (
      item: TimelineItem,
      kind: AuthorPayKind,
      amountRaw: bigint,
      author: string,
    ) => {
      // Balance re-check before any retry; short of the owed
      // amount the sheet never opens and the status says so.
      if (app.oTok !== null && app.oTok.raw < amountRaw) {
        setSlStatus((prev) => ({
          ...prev,
          [item.hash]: tr('pay.shortfall'),
        }));
        return;
      }
      resolveName(item.senderId)
        .then((n) => setPayName(n ? '@' + n : ''))
        .catch(() => setPayName(''));
      const short = (a: string) =>
        a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
      setPayAddr(short(author));
      if (!author) {
        nameOwner(item.senderId)
          .then((o) => setPayAddr(short(o)))
          .catch(() => setPayAddr(''));
      }
      setPayTarget({ item, kind, amountRaw, author });
    },
    [app],
  );

  const confirmAuthorPay = useCallback(async () => {
    if (!payTarget) return;
    const { item, kind } = payTarget;
    setPayBusy(true);
    setSlBusyHash((prev) => ({ ...prev, [item.hash]: true }));
    try {
      await performAuthorPay(app, { target: item, kind });
      setSlStatus((prev) => ({ ...prev, [item.hash]: tr('pay.done') }));
    } catch (e) {
      const msg =
        e instanceof Error && e.message === 'shortfall'
          ? tr('pay.shortfall')
          : tr('act.failed');
      setSlStatus((prev) => ({ ...prev, [item.hash]: msg }));
    } finally {
      setPayBusy(false);
      setSlBusyHash((prev) => ({ ...prev, [item.hash]: false }));
      setPayTarget(null);
    }
  }, [app, payTarget]);

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
        {postHidden && !mod.isAdmin ? (
          /* Direct-open of a hidden post (v0.7.6): the
           * hidden-by-a-moderator state stands in place of
           * the post, its reactions and its thread. */
          <View style={[S.emptyCard, styles.emptyCardPad]}>
            <Text style={S.small}>{tr('mod.hiddenNote')}</Text>
          </View>
        ) : (
        <>
        <PostCard
          item={post}
          lang={app.lang}
          onOpenProfile={openProfile}
          onOpenPost={(it) => app.openPost(it)}
          onReply={(it) => app.openCompose({ kind: 'reply', post: it })}
          onSuperlike={handleSuperlike}
          onTip={handleTip}
          onBookmark={app.toggleBookmark}
          isBookmarked={app.isBookmarked}
          actionStatus={slStatus[post.hash]}
          busy={!!slBusyHash[post.hash]}
          liked={app.hasMyAction(1, post)}
          recawed={app.hasMyAction(2, post)}
          custom={app.customFor(post.senderId)}
          modAdmin={mod.isAdmin}
          modHiddenFor={mod.isPostHidden}
          modHiddenAttFor={mod.hiddenAttHashesFor}
          onModTogglePost={mod.isAdmin ? onModTogglePost : undefined}
          onModAttach={mod.isAdmin ? onModAttach : undefined}
          attTick={attTicks[post.cawId.toLowerCase()] ?? 0}
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
                <RepeatIcon size={13} color="#fff" />
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
                {tr('detail.replies')} ·{' '}
                {shownReplies ? shownReplies.length : '…'}
              </Text>
            </View>
            {shownReplies === null ? (
              <View style={styles.center}>
                <ActivityIndicator color={ACCENT} />
              </View>
            ) : shownReplies.length === 0 ? (
              <View style={[S.emptyCard, styles.emptyCardPad]}>
                <Text style={S.small}>{tr('detail.noneYet')}</Text>
              </View>
            ) : (
              shownReplies.map((r) => (
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
          onBookmark={app.toggleBookmark}
          isBookmarked={app.isBookmarked}
                  actionStatus={slStatus[r.hash]}
                  busy={!!slBusyHash[r.hash]}
                  liked={app.hasMyAction(1, r)}
                  recawed={app.hasMyAction(2, r)}
                  custom={app.customFor(r.senderId)}
                  modAdmin={mod.isAdmin}
                  modHiddenFor={mod.isPostHidden}
                  modHiddenAttFor={mod.hiddenAttHashesFor}
                  onModTogglePost={
                    mod.isAdmin ? onModTogglePost : undefined
                  }
                  onModAttach={mod.isAdmin ? onModAttach : undefined}
                  attTick={attTicks[r.cawId.toLowerCase()] ?? 0}
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
                total: fmtAmountCardDec(SUPERLIKE_TOTAL_RAW, 18),
                author: fmtAmountCardDec(SUPERLIKE_AUTHOR_RAW, 18),
                burn: fmtAmountCardDec(SUPERLIKE_BURN_RAW, 18),
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
        visible={!!payTarget}
        title={tr('pay.title')}
        body={
          payTarget
            ? tr('pay.body', {
                amount: fmtAmountCardDec(payTarget.amountRaw, 18),
                name: payName || '—',
                addr: payAddr || '—',
                balance: oBalanceText(),
              })
            : ''
        }
        confirmLabel={
          payTarget
            ? tr('pay.confirm', {
                amount: fmtAmountCardDec(payTarget.amountRaw, 18),
              })
            : tr('pay.title')
        }
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmAuthorPay}
        onCancel={() => setPayTarget(null)}
        busy={payBusy}
      />
      <TipSheet
        visible={!!tipItem}
        authorLabel={tipName}
        recipient={tipRecipient}
        balanceRaw={app.phoenix ? app.phoenix.raw : null}
        busy={tipBusy}
        onConfirm={confirmTip}
        onCancel={() => setTipItem(null)}
      />
      <ConfirmSheet
        visible={!!modPostPending}
        title={
          modPostPending
            ? mod.isPostHidden(modPostPending.cawId)
              ? tr('mod.unhideTitle')
              : tr('mod.hideTitle')
            : ''
        }
        body={
          modPostPending && !mod.isPostHidden(modPostPending.cawId)
            ? tr('mod.hideNote')
            : undefined
        }
        confirmLabel={
          modPostPending
            ? mod.isPostHidden(modPostPending.cawId)
              ? tr('mod.unhideBtn')
              : tr('mod.hideBtn')
            : ''
        }
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmModPost}
        onCancel={() => setModPostPending(null)}
        busy={modBusy}
      />
      <ConfirmSheet
        visible={!!modAttPending}
        title={
          modAttPending
            ? modAttPending.verb === 'delete'
              ? tr('mod.deleteTitle')
              : modAttPending.verb === 'hide'
                ? tr('mod.hideMediaTitle')
                : tr('mod.unhideMediaTitle')
            : ''
        }
        body={
          modAttPending && modAttPending.verb === 'delete'
            ? tr('mod.deleteWarn')
            : undefined
        }
        confirmLabel={
          modAttPending
            ? modAttPending.verb === 'delete'
              ? tr('mod.deleteBtn')
              : modAttPending.verb === 'hide'
                ? tr('mod.hideMediaBtn')
                : tr('mod.unhideBtn')
            : ''
        }
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmModAtt}
        onCancel={() => setModAttPending(null)}
        busy={modBusy}
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
