import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConfirmSheet, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { LOCALES, tr } from '../i18n';
import { performMirrorPost } from '../lib/actionFlow';
import { textBytes } from '../lib/cawCore';
import {
  XApiError,
  fetchMirrorCandidates,
  findMirrorCandidate,
} from '../lib/xconnect';
import {
  POST_COST_DISPLAY,
  type XErrorInfo,
  type XPost,
} from '../lib/xmirror';

/**
 * X mirror inbox (v0.5.0-x): the connected X account's own
 * posts that have not been engraved on CAW yet. Detection
 * happens HERE (on open + the refresh button) and, when the
 * notification Worker is set up, by push — tapping a
 * notification lands on this screen with that post's
 * confirmation sheet already open (focusPostId). Engraving
 * always goes through the confirmation sheet and the
 * standard sign flow; nothing is ever posted unattended.
 */
export default function XMirrScreen({
  onClose,
  focusPostId,
}: {
  onClose: () => void;
  focusPostId?: string | null;
}) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [posts, setPosts] = useState<XPost[] | null>(null);
  const [error, setError] = useState<XErrorInfo | null>(null);
  const [notLinked, setNotLinked] = useState(false);
  const [confirmPost, setConfirmPost] = useState<XPost | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [statusOk, setStatusOk] = useState(false);
  const ranRef = useRef(false);

  const acting =
    app.myTokens.find((t) => t.id === app.actingId) ?? app.myTokens[0] ?? null;

  const showError = useCallback((e: unknown) => {
    if (e instanceof XApiError) {
      if (e.info.kind === 'auth' && e.info.detail === 'not-connected') {
        setNotLinked(true);
        setError(null);
      } else {
        setError(e.info);
      }
    } else {
      setError({ kind: 'unknown', detail: e instanceof Error ? e.message : '' });
    }
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    setNotLinked(false);
    try {
      const { candidates } = await fetchMirrorCandidates(2);
      setPosts(candidates);
      app.noteMirrorCandidates(candidates.length);
      return candidates;
    } catch (e) {
      showError(e);
      setPosts((p) => p ?? []);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showError]);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    (async () => {
      const list = await refresh();
      // Notification deep link: find the tapped post even when
      // it sits beyond the first two pages, then open its
      // confirmation sheet directly.
      if (focusPostId) {
        const inList = (list ?? []).find((p) => p.id === focusPostId);
        if (inList) {
          setConfirmPost(inList);
        } else {
          const found = await findMirrorCandidate(focusPostId).catch(
            () => null,
          );
          if (found) {
            setPosts((p) => [found, ...(p ?? []).filter((x) => x.id !== found.id)]);
            setConfirmPost(found);
          }
        }
      }
    })();
  }, [refresh, focusPostId]);

  const doEngrave = useCallback(async () => {
    const post = confirmPost;
    if (!post) return;
    setBusyId(post.id);
    try {
      await performMirrorPost(app, { post });
      setPosts((p) => (p ?? []).filter((x) => x.id !== post.id));
      app.noteMirrorCandidates(Math.max(0, (posts?.length ?? 1) - 1));
      setConfirmPost(null);
      setStatusOk(true);
      setStatus(tr('xm.engraved'));
    } catch (e) {
      setConfirmPost(null);
      setStatusOk(false);
      if (e instanceof Error && e.message === 'shortfall') {
        setStatus(tr('xm.shortfall', { cost: POST_COST_DISPLAY }));
      } else if (e instanceof Error && e.message === 'already-engraved') {
        setPosts((p) => (p ?? []).filter((x) => x.id !== post.id));
        setStatus(tr('xm.engraved'));
        setStatusOk(true);
      } else if (e instanceof Error && e.message === 'need-name') {
        setStatus(tr('compose.needName'));
      } else {
        setStatus(tr('xm.failed'));
      }
    } finally {
      setBusyId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, confirmPost, posts]);

  const errText = (info: XErrorInfo): string => {
    switch (info.kind) {
      case 'rate-limit':
        return tr('xm.errRate');
      case 'no-access':
        return tr('xm.errAccess');
      case 'auth':
        return tr('xm.errAuth');
      default:
        return tr('xm.errGeneric');
    }
  };

  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <Text style={S.h1}>{tr('xm.title')}</Text>
        <Pressable onPress={onClose} hitSlop={8}>
          <Text style={styles.closeText}>{tr('common.close')}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={[S.scrollPad, { paddingBottom: 32 + insets.bottom }]}>
        <Text style={S.small}>{tr('xm.help')}</Text>

        <Pressable
          style={[S.ghostBtn, { marginTop: 14, alignSelf: 'flex-start' }]}
          onPress={() => {
            setPosts(null);
            refresh();
          }}
        >
          <Text style={S.ghostBtnText}>{tr('xm.refresh')}</Text>
        </Pressable>

        {status ? (
          <Text style={[statusOk ? S.ok : S.err, { marginTop: 12 }]}>
            {status}
          </Text>
        ) : null}

        {notLinked ? (
          <Text style={[S.body, { marginTop: 16 }]}>{tr('xm.notLinked')}</Text>
        ) : error ? (
          <View style={{ marginTop: 16 }}>
            <Text style={S.err}>{errText(error)}</Text>
            {error.detail ? (
              <Text style={[S.tiny, { marginTop: 6 }]}>{error.detail}</Text>
            ) : null}
          </View>
        ) : posts === null ? (
          <View style={[S.row, { marginTop: 18, gap: 8 }]}>
            <ActivityIndicator color={ACCENT} />
            <Text style={S.small}>{tr('common.loading')}</Text>
          </View>
        ) : posts.length === 0 ? (
          <Text style={[S.body, { marginTop: 16 }]}>{tr('xm.empty')}</Text>
        ) : (
          <View style={{ marginTop: 8 }}>
            {posts.map((p) => (
              <View key={p.id} style={styles.postCard}>
                <Text style={S.body}>{p.text}</Text>
                <View
                  style={[
                    S.row,
                    { marginTop: 10, justifyContent: 'space-between' },
                  ]}
                >
                  <Text style={S.tiny}>
                    {p.createdAt
                      ? new Date(p.createdAt).toLocaleString(
                          LOCALES[app.lang],
                        )
                      : ''}
                    {'  ·  '}
                    {textBytes(p.text)}/420
                  </Text>
                  <Pressable
                    style={[
                      styles.engraveBtn,
                      busyId === p.id && S.disabled,
                    ]}
                    disabled={busyId !== null}
                    onPress={() => setConfirmPost(p)}
                  >
                    {busyId === p.id ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <Text style={styles.engraveBtnText}>
                        {tr('xm.engrave')}
                      </Text>
                    )}
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      <ConfirmSheet
        visible={!!confirmPost}
        title={tr('xm.confirmTitle')}
        body={
          confirmPost
            ? tr('xm.confirmBody', {
                name: acting ? '@' + acting.username : '—',
                cost: POST_COST_DISPLAY,
              }) +
              '\n\n' +
              confirmPost.text
            : undefined
        }
        confirmLabel={tr('xm.engrave')}
        cancelLabel={tr('compose.cancel')}
        onConfirm={doEngrave}
        onCancel={() => {
          if (!busyId) setConfirmPost(null);
        }}
        busy={busyId !== null}
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
  closeText: { fontSize: 15, color: ACCENT, fontWeight: '600' },
  postCard: {
    borderWidth: 1,
    borderColor: '#eff3f4',
    borderRadius: 14,
    padding: 14,
    marginTop: 12,
    backgroundColor: '#fff',
  },
  engraveBtn: {
    backgroundColor: ACCENT,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
    minWidth: 96,
    alignItems: 'center',
  },
  engraveBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
