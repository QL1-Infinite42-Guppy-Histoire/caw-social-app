import React, { useEffect, useRef, useState } from 'react';
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
import { PostCard, S } from '../components/ui';
import { backArrow } from '../lib/rtl';
import { findPostByCawId, type TimelineItem } from '../lib/cawApi';
import { bookmarkStore } from '../lib/stores';

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
    </View>
  );
}
