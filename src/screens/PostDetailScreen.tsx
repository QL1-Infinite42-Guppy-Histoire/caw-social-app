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

import { NameRow, PostCard, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import {
  fetchPostReactions,
  type TimelineItem,
} from '../lib/cawApi';

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

  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={styles.backText}>← {tr('common.back')}</Text>
        </Pressable>
        <Text style={S.h2}>{tr('detail.title')}</Text>
        <View style={{ width: 60 }} />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 + insets.bottom }}>
        <PostCard
          item={post}
          lang={app.lang}
          onOpenProfile={openProfile}
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
            <Text style={[S.h2, styles.section]}>
              {tr('detail.likedBy')} · {likes.length}
            </Text>
            {likes.length === 0 ? (
              <Text style={[S.small, styles.empty]}>
                {tr('detail.noneYet')}
              </Text>
            ) : (
              likes.map((id) => (
                <NameRow
                  key={'l' + id.toString()}
                  nameId={id}
                  onOpenProfile={openProfile}
                />
              ))
            )}
            <Text style={[S.h2, styles.section]}>
              {tr('detail.sharedBy')} · {shares.length}
            </Text>
            {shares.length === 0 ? (
              <Text style={[S.small, styles.empty]}>
                {tr('detail.noneYet')}
              </Text>
            ) : (
              shares.map((id) => (
                <NameRow
                  key={'s' + id.toString()}
                  nameId={id}
                  onOpenProfile={openProfile}
                />
              ))
            )}
            {!complete ? (
              <Text style={[S.tiny, styles.note]}>
                {tr('detail.incomplete')}
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
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
  section: { marginTop: 20, marginBottom: 4, paddingHorizontal: 16 },
  empty: { paddingHorizontal: 16, paddingVertical: 8 },
  note: { paddingHorizontal: 16, paddingVertical: 12 },
});
