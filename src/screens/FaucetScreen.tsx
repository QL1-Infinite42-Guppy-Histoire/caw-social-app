import React, { useCallback, useEffect, useState } from 'react';
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { S } from '../components/ui';
import { useApp } from '../context/AppContext';
import { tr, type StrKey } from '../i18n';
import {
  claimFaucet,
  FAUCET_POOLS,
  faucetErrorKey,
  fetchFaucetStatus,
  isCooldownCode,
  retryParts,
  type ClaimErr,
  type FaucetPool,
  type FaucetStatus,
} from '../lib/faucet';

/* ==================================================================
 * Faucet (v0.4.1): claim small amounts of [42] / QOM / ZAP from
 * the user's public faucet Worker, straight into the app's own
 * wallet. The faucet's wallet signs and sends; this screen only
 * asks. Every worker rejection code shows its own plain message
 * (lib/faucet's taxonomy) — never the generic failure text.
 * ================================================================== */

const poolKey = (p: FaucetPool) => `${p.chain}:${p.token}`;

function cooldownSuffix(r: ClaimErr): string {
  if (!isCooldownCode(r.code) || r.retryAfterSec === undefined) return '';
  const p = retryParts(r.retryAfterSec);
  const key =
    p.unit === 'days'
      ? 'faucet.inDays'
      : p.unit === 'hours'
        ? 'faucet.inHours'
        : 'faucet.inMinutes';
  return tr(key as StrKey, { n: String(p.n) });
}

function claimErrorText(r: ClaimErr): string {
  if (r.code === 'network') return tr('faucet.loadFailed');
  const key = faucetErrorKey(r.code) as StrKey;
  const t = cooldownSuffix(r);
  return t ? tr(key, { t }) : tr(key);
}

export default function FaucetScreen({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const address = app.address ?? '';
  const [statuses, setStatuses] = useState<(FaucetStatus | null)[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [notes, setNotes] = useState<
    Record<string, { text: string; err: boolean; url?: string }>
  >({});

  const load = useCallback(async () => {
    const all = await Promise.all(FAUCET_POOLS.map((p) => fetchFaucetStatus(p)));
    setStatuses(all);
    setLoadFailed(all.every((s) => s === null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const claim = async (pool: FaucetPool) => {
    const k = poolKey(pool);
    setClaiming(k);
    try {
      const r = await claimFaucet(pool, address);
      if (r.ok) {
        setNotes((n) => ({
          ...n,
          [k]: {
            text: tr('faucet.doneAmt', { amount: r.amount, sym: pool.sym }),
            err: false,
            url: r.explorerUrl,
          },
        }));
        await load();
        app.refreshBalances().catch(() => {});
      } else {
        setNotes((n) => ({ ...n, [k]: { text: claimErrorText(r), err: true } }));
        await load();
      }
    } finally {
      setClaiming(null);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }} edges={['top', 'bottom']}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          paddingVertical: 12,
        }}
      >
        <Text style={S.h2}>{tr('faucet.title')}</Text>
        <Pressable onPress={onClose} hitSlop={10}>
          <Text style={{ fontSize: 20, color: '#536471' }}>✕</Text>
        </Pressable>
      </View>
      <ScrollView
        style={S.screen}
        contentContainerStyle={[S.scrollPad, { paddingBottom: 32 + insets.bottom }]}
      >
        <Text style={S.body}>{tr('faucet.intro')}</Text>
        {statuses === null ? (
          <Text style={[S.small, { marginTop: 16 }]}>{tr('hs.checking')}</Text>
        ) : loadFailed ? (
          <>
            <Text style={[S.err, { marginTop: 16 }]}>{tr('faucet.loadFailed')}</Text>
            <Pressable style={[S.ghostBtn, { marginTop: 12 }]} onPress={load}>
              <Text style={S.ghostBtnText}>{tr('hs.next')}</Text>
            </Pressable>
          </>
        ) : (
          FAUCET_POOLS.map((pool, i) => {
            const st = statuses[i];
            const k = poolKey(pool);
            const note = notes[k];
            const canClaim = !!st?.ready && claiming === null;
            return (
              <View key={k} style={[S.cardBox, { marginTop: 14 }]}>
                <View style={[S.row, { justifyContent: 'space-between' }]}>
                  <Text style={[S.body, { fontWeight: '700' }]}>
                    {st ? st.claimAmount : '—'} {pool.sym}
                  </Text>
                  <Text style={S.small}>{pool.chainLabel}</Text>
                </View>
                {st ? (
                  st.ready ? (
                    typeof st.claimsLeft === 'number' ? (
                      <Text style={[S.small, { marginTop: 4 }]}>
                        {tr('faucet.left', { n: String(st.claimsLeft) })}
                      </Text>
                    ) : null
                  ) : (
                    <Text style={[S.err, { marginTop: 4 }]}>
                      {tr('faucet.notReady')}
                      {st.reason ? ` — ${st.reason}` : ''}
                    </Text>
                  )
                ) : (
                  <Text style={[S.err, { marginTop: 4 }]}>{tr('faucet.loadFailed')}</Text>
                )}
                {note ? (
                  <Text style={[note.err ? S.err : S.small, { marginTop: 8 }]}>
                    {note.text}
                  </Text>
                ) : null}
                {note && !note.err && note.url ? (
                  <Pressable
                    style={{ marginTop: 6 }}
                    onPress={() => Linking.openURL(note.url!).catch(() => {})}
                  >
                    <Text style={[S.small, { color: '#1d9bf0' }]}>
                      {tr('faucet.viewTx')}
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={[S.bigBtn, { marginTop: 12 }, !canClaim && { opacity: 0.4 }]}
                  disabled={!canClaim}
                  onPress={() => claim(pool)}
                >
                  <Text style={S.bigBtnText}>
                    {claiming === k ? tr('faucet.claiming') : tr('faucet.claim')}
                  </Text>
                </Pressable>
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Self-contained faucet entry button (own modal state), used by
 * the Home wallet card, the HuntersDEX header, and — mandatorily
 * — the QL1 gas-shortage guidance in the guided flows.
 */
export function FaucetButton({
  label,
  primary,
}: {
  label?: string;
  primary?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        style={primary ? S.bigBtn : S.ghostBtn}
        onPress={() => setOpen(true)}
      >
        <Text style={primary ? S.bigBtnText : S.ghostBtnText}>
          {label ?? tr('faucet.goFaucet')}
        </Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <FaucetScreen onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}
