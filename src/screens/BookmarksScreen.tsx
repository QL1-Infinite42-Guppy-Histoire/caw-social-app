import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import { ConfirmSheet, PostCard, S } from '../components/ui';
import { backArrow } from '../lib/rtl';
import { findPostByCawId, type TimelineItem } from '../lib/cawApi';
import { bookmarkStore } from '../lib/stores';
import {
  MediaApiError,
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
 * Bookmarks (v0.6.0) — the saved-posts list, reached from
 * the Profile hub. Bookmarks are cawIds stored ON THIS
 * DEVICE only (lib/bookmarks.ts, per wallet); the rows are
 * the timeline's own PostCard, resolved live from the chain
 * readers at open, so counts and content are never stale
 * copies. A saved post that no longer resolves renders an
 * honest placeholder with a remove button — never a crash,
 * never a fabricated row. Resolution runs a few lookups at
 * a time so a long list cannot flood the RPC endpoints.
 */
export default function BookmarksScreen({
  onClose,
}: {
  onClose: () => void;
}) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [ids, setIds] = useState<string[]>(() => bookmarkStore.list());
  const [resolved, setResolved] = useState<
    Record<string, TimelineItem | null>
  >({});
  const [resolving, setResolving] = useState(true);
  const runRef = useRef(0);

  /* ---------- Moderation (v0.7.6) ----------
   * A bookmarked post that lands on the hidden list leaves
   * this list for non-admins (the bookmark itself is kept —
   * unhiding brings the row back). Admins keep the row,
   * marked, with the usual controls. Op errors surface in
   * the note line under the header. */
  const mod = useModeration();
  const [modNote, setModNote] = useState('');
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
      setModNote('');
    } catch (e) {
      setModNote(modErrorText(e));
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
      setModNote('');
    } catch (e) {
      setModNote(modErrorText(e));
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

  useEffect(() => bookmarkStore.subscribe(() => setIds(bookmarkStore.list())), []);

  useEffect(() => {
    const run = ++runRef.current;
    if (ids.length === 0) {
      setResolving(false);
      return;
    }
    setResolving(true);
    let cursor = 0;
    let settled = 0;
    const queue = [...ids];
    const worker = async () => {
      while (cursor < queue.length) {
        const id = queue[cursor++];
        let item: TimelineItem | null = null;
        try {
          item = await findPostByCawId(id);
        } catch {
          item = null;
        }
        if (runRef.current !== run) return;
        setResolved((prev) => ({ ...prev, [id]: item }));
        settled++;
        if (settled >= queue.length && runRef.current === run) {
          setResolving(false);
        }
      }
    };
    const lanes = Math.min(4, queue.length);
    for (let i = 0; i < lanes; i++) void worker();
    return () => {
      runRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: '#eff3f4',
        }}
      >
        <Pressable onPress={onClose} hitSlop={8}>
          <Text style={{ fontSize: 15, color: ACCENT, fontWeight: '600' }}>
            {backArrow()} {tr('common.back')}
          </Text>
        </Pressable>
        <Text style={{ fontSize: 16, fontWeight: '800', color: '#0f1419' }}>
          {tr('bm.title')}
        </Text>
      </View>
      {modNote ? (
        <Text
          style={[S.small, { paddingHorizontal: 16, paddingVertical: 8 }]}
        >
          {modNote}
        </Text>
      ) : null}
      {ids.length === 0 ? (
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <Text style={[S.small, { textAlign: 'center' }]}>
            {tr('bm.empty')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={ids}
          keyExtractor={(id) => id}
          renderItem={({ item: id }) => {
            const post = resolved[id];
            if (post && mod.isPostHidden(post.cawId) && !mod.isAdmin) {
              return (
                <View
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                    borderBottomWidth: 1,
                    borderBottomColor: '#eff3f4',
                  }}
                >
                  <Text style={S.small}>{tr('mod.hiddenNote')}</Text>
                </View>
              );
            }
            if (post) {
              return (
                <PostCard
                  item={post}
                  lang={app.lang}
                  onOpenProfile={(name) => {
                    onClose();
                    app.openProfile(name);
                  }}
                  onOpenPost={(p) => {
                    onClose();
                    app.openPost(p);
                  }}
                  onReply={(p) => {
                    onClose();
                    app.openCompose({ kind: 'reply', post: p });
                  }}
                  onBookmark={app.toggleBookmark}
                  isBookmarked={app.isBookmarked}
                  liked={app.hasMyAction(1, post)}
                  recawed={app.hasMyAction(2, post)}
                  custom={app.customFor(post.senderId)}
                  modAdmin={mod.isAdmin}
                  modHiddenFor={mod.isPostHidden}
                  modHiddenAttFor={mod.hiddenAttHashesFor}
                  onModTogglePost={
                    mod.isAdmin ? onModTogglePost : undefined
                  }
                  onModAttach={mod.isAdmin ? onModAttach : undefined}
                  attTick={attTicks[post.cawId.toLowerCase()] ?? 0}
                />
              );
            }
            if (post === null) {
              return (
                <View
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                    borderBottomWidth: 1,
                    borderBottomColor: '#eff3f4',
                  }}
                >
                  <Text style={S.small}>{tr('bm.unavailable')}</Text>
                  <Pressable
                    onPress={() => void bookmarkStore.toggle(id)}
                    style={{ marginTop: 8 }}
                    accessibilityRole="button"
                  >
                    <Text
                      style={{
                        fontSize: 13.5,
                        color: ACCENT,
                        fontWeight: '700',
                      }}
                    >
                      {tr('bm.remove')}
                    </Text>
                  </Pressable>
                </View>
              );
            }
            return (
              <View
                style={{
                  paddingVertical: 18,
                  alignItems: 'center',
                  borderBottomWidth: 1,
                  borderBottomColor: '#eff3f4',
                }}
              >
                <ActivityIndicator color={ACCENT} />
              </View>
            );
          }}
        />
      )}
      {resolving && ids.length > 0 ? (
        <View style={{ paddingVertical: 10, alignItems: 'center' }}>
          <ActivityIndicator color={ACCENT} />
        </View>
      ) : null}
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
