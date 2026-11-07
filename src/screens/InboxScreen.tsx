import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import { resolveName } from '../lib/cawApi';
import {
  loadSeen,
  saveSeen,
  scanReactions,
  type Reaction,
} from '../lib/inbox';
import { storeKV } from '../lib/stores';

/**
 * Reactions to me (v0.2.0). Honest framing, in the UI itself: this
 * app has no server, so there are no push notifications — this
 * page gathers, on the phone, the likes / shares / follows aimed
 * at your names since you last opened it.
 */
export default function InboxScreen({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<Reaction[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [capped, setCapped] = useState(false);
  const ranRef = useRef(false);

  const load = useCallback(async () => {
    if (!app.address || app.myTokens.length === 0) {
      setItems([]);
      return;
    }
    setFailed(false);
    try {
      const myIds = new Set(app.myTokens.map((t) => t.id.toString()));
      const seen = await loadSeen(storeKV, app.address);
      const r = await scanReactions(myIds, seen);
      setItems(r.items);
      setCapped(r.capped);
      // Everything on screen now counts as read.
      if (r.newest && app.address) {
        await saveSeen(storeKV, app.address, r.newest);
      }
    } catch {
      setFailed(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.address, app.myTokens]);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    load();
  }, [load]);

  const openActor = useCallback(
    (actorId: bigint) => {
      resolveName(actorId)
        .then((n) => {
          if (n) {
            onClose();
            app.openProfile(n);
          }
        })
        .catch(() => {});
    },
    [app, onClose],
  );

  const renderItem = useCallback(
    ({ item }: { item: Reaction }) => (
      <ReactionRow
        reaction={item}
        onActor={() => openActor(item.actorId)}
        onPost={
          item.post
            ? () => {
                onClose();
                app.openPost(item.post!);
              }
            : undefined
        }
      />
    ),
    [app, onClose, openActor],
  );

  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <Text style={S.h1}>{tr('inbox.title')}</Text>
        <Pressable onPress={onClose} hitSlop={8}>
          <Text style={styles.closeText}>{tr('common.close')}</Text>
        </Pressable>
      </View>
      <Text style={[S.small, styles.note]}>{tr('inbox.note')}</Text>
      {failed ? (
        <View style={styles.center}>
          <Text style={S.err}>{tr('inbox.loadFail')}</Text>
          <Pressable
            style={[S.ghostBtn, { marginTop: 12 }]}
            onPress={() => {
              setItems(null);
              load();
            }}
          >
            <Text style={S.ghostBtnText}>{tr('profile.retry')}</Text>
          </Pressable>
        </View>
      ) : items === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={ACCENT} />
          <Text style={[S.small, { marginTop: 10 }]}>
            {tr('inbox.loading')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(r, i) => r.hash + ':' + i}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 32 + insets.bottom }}
          ListEmptyComponent={
            <View style={{ paddingHorizontal: 16 }}>
              <View style={S.emptyCard}>
                <Text style={{ fontSize: 26 }}>🔔</Text>
                <Text style={[S.small, { marginTop: 8, textAlign: 'center' }]}>
                  {tr('inbox.empty')}
                </Text>
              </View>
            </View>
          }
          ListFooterComponent={
            capped ? (
              <Text style={[S.tiny, styles.note]}>
                {tr('inbox.capped')}
              </Text>
            ) : undefined
          }
        />
      )}
    </View>
  );
}

function ReactionRow({
  reaction,
  onActor,
  onPost,
}: {
  reaction: Reaction;
  onActor: () => void;
  onPost?: () => void;
}) {
  const [actorName, setActorName] = useState<string | null>(null);
  const [targetName, setTargetName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    resolveName(reaction.actorId)
      .then((n) => live && setActorName(n))
      .catch(() => {});
    if (reaction.targetNameId) {
      resolveName(reaction.targetNameId)
        .then((n) => live && setTargetName(n))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [reaction]);
  const who = actorName
    ? '@' + actorName
    : tr('tl.unknownName') + reaction.actorId.toString();
  const verb =
    reaction.kind === 1
      ? tr('inbox.likedPost')
      : reaction.kind === 2
        ? tr('inbox.sharedPost')
        : reaction.kind === 3
          ? tr('inbox.followed', {
              name: targetName
                ? '@' + targetName
                : '#' + (reaction.targetNameId?.toString() ?? ''),
            })
          : tr('inbox.unfollowed', {
              name: targetName
                ? '@' + targetName
                : '#' + (reaction.targetNameId?.toString() ?? ''),
            });
  const icon =
    reaction.kind === 1
      ? '♥'
      : reaction.kind === 2
        ? '🔁'
        : reaction.kind === 3
          ? '👤'
          : '👤';
  // Kind badge (v0.3.8): a small colored circle on the avatar's
  // corner, X-notification style — like pink, recaw green,
  // follow blue.
  const badgeBg =
    reaction.kind === 1
      ? '#e0245e'
      : reaction.kind === 2
        ? '#17bf63'
        : '#1d9bf0';
  return (
    <View style={styles.row}>
      <View>
        <Pressable onPress={onActor}>
          <Avatar nameId={reaction.actorId} size={40} />
        </Pressable>
        <View style={[styles.kindBadge, { backgroundColor: badgeBg }]}>
          <Text style={styles.kindBadgeText}>{icon}</Text>
        </View>
      </View>
      <View style={{ flex: 1, marginLeft: 10 }}>
        <Text style={S.body}>
          <Text style={{ fontWeight: '700' }}>{who}</Text>
          {'  '}
          {verb}
        </Text>
        {reaction.post ? (
          <Pressable onPress={onPost}>
            <Text style={[S.small, styles.postText]} numberOfLines={2}>
              {reaction.post.text}
            </Text>
          </Pressable>
        ) : null}
      </View>
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
  },
  closeText: { fontSize: 15, color: ACCENT, fontWeight: '600' },
  note: { paddingHorizontal: 16, paddingBottom: 10 },
  center: { alignItems: 'center', padding: 28 },
  row: {
    flexDirection: 'row',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
    backgroundColor: '#fff',
  },
  postText: { marginTop: 3 },
  kindBadge: {
    position: 'absolute',
    right: -5,
    bottom: -5,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  kindBadgeText: { fontSize: 10, color: '#fff', fontWeight: '700' },
});
