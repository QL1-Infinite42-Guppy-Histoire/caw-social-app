import React, { useCallback, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import { Avatar, BalanceGrid, HAIRLINE, MONO, S } from '../components/ui';
import { backArrow } from '../lib/rtl';
import MyNamesScreen from './MyNamesScreen';
import GetNameScreen from './GetNameScreen';
import SettingsScreen from './SettingsScreen';
import SendScreen from './SendScreen';
import InboxScreen from './InboxScreen';
import BookmarksScreen from './BookmarksScreen';
import { HuntersSwapModal } from './HuntersSwapScreen';

/**
 * The Profile tab (v0.6.0, X-style overhaul) — the hub that
 * keeps EVERYTHING the old tab bar and the old Home header
 * reached, reachable:
 *
 *   - 'main' (this screen): the wallet card that lived at the
 *     top of Home through v0.5.1 (identity + copyable address
 *     chip + the SAME BalanceGrid cells in the SAME order +
 *     the Profile / Send / Deposit button row), followed by
 *     clearly-labelled entries for My names, Get a name,
 *     HuntersExchange, Bookmarks, the reactions inbox and
 *     Settings.
 *   - 'mine' / 'get' / 'settings': the pre-existing screens,
 *     rendered unchanged as hub sections under a back row.
 *
 * Send, HuntersExchange, Bookmarks and the inbox open as the
 * same modals they always were. The reachability map for
 * every v0.5.1 entry point is in the v0.6.0 release notes
 * and pinned by scripts/verify-xui.mjs.
 */
export default function MeScreen() {
  const app = useApp();
  const {
    hubSection,
    openHub,
    actingId,
    myTokens,
    address,
    qom,
    qcaw,
    f42,
    cat42,
    oTok,
    ket,
  } = app;
  const [sendOpen, setSendOpen] = useState(false);
  const [hsOpen, setHsOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [addrCopied, setAddrCopied] = useState(false);

  const acting =
    myTokens.find((t) => t.id === actingId) ?? myTokens[0] ?? null;
  const actingCustom = acting ? app.customFor(acting.id) : undefined;
  const displayName = acting
    ? actingCustom?.displayName
      ? actingCustom.displayName
      : '@' + acting.username
    : '—';
  const subName =
    acting && actingCustom?.displayName ? '@' + acting.username : null;
  const chipAddress = address
    ? address.slice(0, 6) + '…' + address.slice(-4)
    : '—';
  const copyAddr = useCallback(async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2000);
  }, [address]);

  if (hubSection !== 'main') {
    return (
      <View style={S.screen}>
        <View style={styles.backRow}>
          <Pressable onPress={() => openHub('main')} hitSlop={8}>
            <Text style={styles.backText}>
              {backArrow()} {tr('common.back')}
            </Text>
          </Pressable>
          <Text style={styles.backTitle}>
            {hubSection === 'mine'
              ? tr('nav.myNames')
              : hubSection === 'get'
                ? tr('nav.getName')
                : tr('nav.settings')}
          </Text>
        </View>
        {hubSection === 'mine' && <MyNamesScreen />}
        {hubSection === 'get' && <GetNameScreen />}
        {hubSection === 'settings' && <SettingsScreen />}
      </View>
    );
  }

  return (
    <View style={S.screen}>
      <ScrollView contentContainerStyle={{ paddingBottom: 28 }}>
        {/* The wallet card — moved, unchanged, from the old
            Home header (see the v0.6.0 note at the top). */}
        <View style={styles.walletCard}>
          <Pressable
            onPress={
              acting ? () => app.openProfile(acting.username) : undefined
            }
            style={({ pressed }) => [pressed && { opacity: 0.8 }]}
            accessibilityRole="button"
          >
            <View style={[S.row, { alignItems: 'center', gap: 10 }]}>
              {acting ? (
                <Avatar
                  nameId={acting.id}
                  size={42}
                  customUri={actingCustom?.avatarPath}
                />
              ) : null}
              <View style={{ flex: 1 }}>
                <Text
                  style={[S.body, { fontWeight: '800' }]}
                  numberOfLines={1}
                >
                  {displayName}
                </Text>
                {subName ? (
                  <Text style={S.small} numberOfLines={1}>
                    {subName}
                  </Text>
                ) : null}
              </View>
              <Pressable
                style={({ pressed }) => [
                  styles.chip,
                  pressed && { backgroundColor: '#e3e8ea' },
                ]}
                onPress={copyAddr}
                accessibilityLabel={tr('hs.depositAddress')}
              >
                <Text style={styles.chipText}>
                  {addrCopied ? tr('hs.addressCopied') : chipAddress}
                </Text>
              </Pressable>
            </View>
            {/* Balances: the same BalanceGrid, cells and
                order as the old Home card and the name card
                (wallet CAW | QOM / in-name CAW | [42] /
                CAT42 | O / KET | —). Unread balances render
                the honest dash, never a numeric 0 (v0.4.7
                rule, unchanged). */}
            <View style={{ marginTop: 12 }}>
              <BalanceGrid
                cells={[
                  { label: tr('home.qcaw'), unit: 'CAW', raw: qcaw },
                  { label: tr('home.qom'), unit: 'QOM', raw: qom },
                  {
                    label: tr('card.inName'),
                    unit: 'CAW',
                    raw: acting ? acting.balance : null,
                  },
                  { label: tr('card.f42'), unit: '42', raw: f42 },
                  { label: tr('card.cat42'), unit: 'CAT42', raw: cat42 },
                  {
                    label: 'O',
                    unit: 'O',
                    raw: oTok ? oTok.raw : null,
                    decimals: oTok ? oTok.decimals : 18,
                  },
                  {
                    label: 'KET',
                    unit: 'KET',
                    raw: ket ? ket.raw : null,
                    decimals: ket ? ket.decimals : 18,
                  },
                  null,
                ]}
              />
            </View>
          </Pressable>
          {acting ? (
            <View style={[S.row, { gap: 10, marginTop: 12 }]}>
              <Pressable
                style={[S.ghostBtn, { flex: 1 }]}
                onPress={() => app.openProfile(acting.username)}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    S.ghostBtnText,
                    { color: ACCENT, fontWeight: '800' },
                  ]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.6}
                >
                  {tr('home.profile')}
                </Text>
              </Pressable>
              <Pressable
                style={[S.ghostBtn, { flex: 1 }]}
                onPress={() => setSendOpen(true)}
                accessibilityRole="button"
              >
                <Text
                  style={S.ghostBtnText}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.6}
                >
                  {tr('send.title')}
                </Text>
              </Pressable>
              <Pressable
                style={[S.ghostBtn, { flex: 1 }]}
                onPress={() => app.focusMine(acting.id)}
                accessibilityRole="button"
              >
                <Text
                  style={S.ghostBtnText}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.6}
                >
                  {tr('home.deposit')}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ marginTop: 12 }}>
              <Text style={S.body}>{tr('mine.none')}</Text>
              <Pressable
                style={[S.bigBtn, { marginTop: 12 }]}
                onPress={() => openHub('get')}
              >
                <Text style={S.bigBtnText}>{tr('nav.getName')}</Text>
              </Pressable>
            </View>
          )}
        </View>

        {/* Entries — everything the removed tabs held, one
            labelled row each. */}
        <View style={styles.entryGroup}>
          <EntryRow
            label={tr('nav.myNames')}
            onPress={() => openHub('mine')}
          />
          <EntryRow
            label={tr('nav.getName')}
            onPress={() => openHub('get')}
          />
          <EntryRow
            label="HuntersExchange"
            caption={tr('hs.title')}
            onPress={() => setHsOpen(true)}
          />
          <EntryRow
            label={tr('bm.title')}
            onPress={() => setBookmarksOpen(true)}
          />
          <EntryRow
            label={tr('inbox.title')}
            onPress={() => setInboxOpen(true)}
          />
          <EntryRow
            label={tr('nav.settings')}
            onPress={() => openHub('settings')}
            last
          />
        </View>
      </ScrollView>

      <Modal
        visible={sendOpen}
        animationType="slide"
        onRequestClose={() => setSendOpen(false)}
      >
        <SendScreen onClose={() => setSendOpen(false)} />
      </Modal>
      <HuntersSwapModal visible={hsOpen} onClose={() => setHsOpen(false)} />
      <Modal
        visible={inboxOpen}
        animationType="slide"
        onRequestClose={() => setInboxOpen(false)}
      >
        <InboxScreen onClose={() => setInboxOpen(false)} />
      </Modal>
      <Modal
        visible={bookmarksOpen}
        animationType="slide"
        onRequestClose={() => setBookmarksOpen(false)}
      >
        <BookmarksScreen onClose={() => setBookmarksOpen(false)} />
      </Modal>
    </View>
  );
}

function EntryRow({
  label,
  caption,
  onPress,
  last,
}: {
  label: string;
  caption?: string;
  onPress: () => void;
  last?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.entryRow,
        !last && styles.entryRowLine,
        pressed && { backgroundColor: '#f7f9f9' },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.entryLabel}>{label}</Text>
        {caption ? <Text style={S.tiny}>{caption}</Text> : null}
      </View>
      <Text style={styles.entryChevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
    backgroundColor: '#fff',
  },
  backText: { fontSize: 15, color: ACCENT, fontWeight: '600' },
  backTitle: { fontSize: 16, fontWeight: '800', color: '#0f1419' },
  walletCard: {
    marginHorizontal: 12,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: HAIRLINE,
    borderRadius: 16,
    backgroundColor: '#fff',
    shadowColor: '#0f1419',
    shadowOpacity: 0.07,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  chip: {
    backgroundColor: '#eff3f4',
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  chipText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#0f1419',
    fontFamily: MONO,
  },
  entryGroup: {
    marginTop: 18,
    borderTopWidth: 1,
    borderTopColor: '#eff3f4',
    backgroundColor: '#fff',
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  entryRowLine: {
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
  },
  entryLabel: { fontSize: 15.5, fontWeight: '600', color: '#0f1419' },
  entryChevron: { fontSize: 20, color: '#536471', marginStart: 8 },
});
