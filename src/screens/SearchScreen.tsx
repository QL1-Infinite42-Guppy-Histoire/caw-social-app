import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import { resolveNameId } from '../lib/cawApi';
import { backArrow } from '../lib/rtl';
import {
  directoryStatus,
  ensureDirectory,
  searchDirectory,
  type NameEntry,
} from '../lib/nameDirectory';

/**
 * Name search (X-style): type part of a name and tap a result to
 * open its profile. Backed by the on-device name directory
 * (nameDirectory.ts): an exact name resolves immediately through
 * idByUsername, and partial matches come from the directory, which
 * fills in the background (progress shown honestly while the first
 * full read is still running) and afterwards only ever fetches
 * newly minted names.
 */
export default function SearchScreen({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NameEntry[]>([]);
  const [exact, setExact] = useState<NameEntry | null>(null);
  const [progress, setProgress] = useState(directoryStatus());
  const [loadFailed, setLoadFailed] = useState(false);
  const runRef = useRef(0);

  const refreshResults = useCallback((q: string) => {
    setResults(searchDirectory(q));
  }, []);

  useEffect(() => {
    let live = true;
    ensureDirectory((p) => {
      if (!live) return;
      setProgress({ ...p, ready: p.done > 0 });
      refreshResults(query);
    })
      .then(() => {
        if (live) refreshResults(query);
      })
      .catch(() => {
        if (live && directoryStatus().done === 0) setLoadFailed(true);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced: partial results from the directory + an exact-match
  // fast path through idByUsername (works even mid-directory-load).
  useEffect(() => {
    const q = query.trim().toLowerCase();
    refreshResults(q);
    setExact(null);
    if (q.length < 2) return;
    const run = ++runRef.current;
    const t = setTimeout(() => {
      resolveNameId(q)
        .then((r) => {
          if (runRef.current !== run) return;
          if (r.status === 'ok') {
            setExact({ id: r.id, name: r.username });
          }
        })
        .catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [query, refreshResults]);

  const merged: NameEntry[] = [];
  if (exact) merged.push(exact);
  for (const r of results) {
    if (!exact || r.id !== exact.id) merged.push(r);
  }

  const loading = progress.total > progress.done;

  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <View style={styles.topRow}>
        <Pressable onPress={onClose} hitSlop={8}>
          <Text style={styles.backText}>{backArrow()} {tr('common.back')}</Text>
        </Pressable>
        <View style={styles.inputWrap}>
          <Text style={styles.mag}>🔍</Text>
          <TextInput
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            placeholder={tr('search.ph')}
            placeholderTextColor="#536471"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            autoFocus
            returnKeyType="search"
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Text style={styles.clear}>✕</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {loadFailed ? (
        <View style={styles.center}>
          <Text style={S.err}>{tr('search.loadFail')}</Text>
          <Pressable
            style={[S.ghostBtn, { marginTop: 14 }]}
            onPress={() => {
              setLoadFailed(false);
              ensureDirectory((p) =>
                setProgress({ ...p, ready: p.done > 0 }),
              )
                .then(() => refreshResults(query))
                .catch(() => setLoadFailed(true));
            }}
          >
            <Text style={S.ghostBtnText}>{tr('profile.retry')}</Text>
          </Pressable>
        </View>
      ) : !query.trim() ? (
        <View style={styles.center}>
          <Text style={S.small}>{tr('search.hint')}</Text>
          {loading ? (
            <Text style={[S.tiny, { marginTop: 10 }]}>
              {tr('search.loading', {
                done: String(progress.done),
                total: String(progress.total),
              })}
            </Text>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={merged}
          keyExtractor={(e) => e.id.toString()}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [
                styles.row,
                pressed && { backgroundColor: '#f7f9f9' },
              ]}
              onPress={() => {
                onClose();
                app.openProfile(item.name);
              }}
            >
              <Avatar nameId={item.id} size={44} />
              <View style={{ marginStart: 10, flex: 1 }}>
                <Text style={styles.name}>@{item.name}</Text>
                <Text style={S.tiny}>#{item.id.toString()}</Text>
              </View>
            </Pressable>
          )}
          ListHeaderComponent={
            loading ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color={ACCENT} size="small" />
                <Text style={[S.tiny, { marginStart: 8 }]}>
                  {tr('search.loading', {
                    done: String(progress.done),
                    total: String(progress.total),
                  })}
                </Text>
              </View>
            ) : undefined
          }
          ListEmptyComponent={
            loading ? undefined : (
              <View style={{ padding: 24, alignItems: 'center' }}>
                <Text style={S.small}>{tr('search.empty')}</Text>
              </View>
            )
          }
          windowSize={7}
          maxToRenderPerBatch={16}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
  },
  backText: { fontSize: 15, color: ACCENT, fontWeight: '600' },
  inputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#eff3f4',
    borderRadius: 999,
    paddingHorizontal: 12,
    minHeight: 42,
  },
  mag: { fontSize: 14, marginEnd: 6 },
  input: { flex: 1, fontSize: 15, color: '#0f1419', paddingVertical: 8 },
  clear: { fontSize: 14, color: '#536471', paddingHorizontal: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
    backgroundColor: '#fff',
  },
  name: { fontSize: 15, fontWeight: '700', color: '#0f1419' },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
