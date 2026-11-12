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
import {
  Avatar,
  BalanceGrid,
  BellIcon,
  BookmarkIcon,
  DownloadIcon,
  HAIRLINE,
  MONO,
  RepeatIcon,
  S,
  SendIcon,
  SettingsIcon,
  TipIcon,
  UserIcon,
  UserPlusIcon,
  WalletIcon,
} from '../components/ui';
import { fmtAmountCard } from '../lib/cawCore';
import { backArrow } from '../lib/rtl';
import MyNamesScreen from './MyNamesScreen';
import GetNameScreen from './GetNameScreen';
import SettingsScreen from './SettingsScreen';
import SendScreen from './SendScreen';
import InboxScreen from './InboxScreen';
import BookmarksScreen from './BookmarksScreen';
import { HuntersSwapModal } from './HuntersSwapScreen';

/**
 * The wallet detail (hub 'wallet' section): the full
 * BalanceGrid — the same cells in the same order as the old
 * Home card and the v0.6.0 hub card (wallet CAW | QOM /
 * in-name CAW | [42] / CAT42 | O / KET | —), tap-for-exact,
 * and the v0.4.7 rule inside the grid (unread renders the
 * dash, never a numeric 0). One tap from the hub's summary;
 * the deposited-CAW cell takes the acting name's balance.
 */
function WalletDetail() {
  const app = useApp();
  const { actingId, myTokens, qom, qcaw, f42, cat42, oTok, ket } = app;
  const acting =
    myTokens.find((t) => t.id === actingId) ?? myTokens[0] ?? null;
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 28 }}
    >
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
    </ScrollView>
  );
}

/**
 * The Profile tab — the hub that keeps EVERYTHING the old
 * tab bar and the old app header reached, reachable.
 *
 * v0.6.1 finish (concept images ②/⑦): the top of 'main' is
 * no longer the dense balance-grid card. It is a profile
 * summary (avatar, display name, @handle · #id, the copyable
 * address chip — tap the summary for the profile), ONE
 * prominent balance card (the active name's deposited CAW,
 * big, with the fees caption; tap → the wallet detail), and
 * icon rows for every destination. The full BalanceGrid —
 * same cells, same order, tap-for-exact — lives one tap
 * deeper in the 'wallet' section (WalletDetail below);
 * nothing was deleted, it moved.
 *
 * Sections: 'mine' / 'get' / 'settings' / 'wallet' render
 * under a back row. Send, HuntersExchange, Bookmarks and the
 * reactions inbox open as the same modals they always were.
 * The reachability map is pinned by scripts/verify-xui.mjs.
 */
export default function MeScreen() {
  const app = useApp();
  const { hubSection, openHub, actingId, myTokens, address } = app;
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
  const subLine = acting
    ? actingCustom?.displayName
      ? '@' + acting.username + ' · #' + acting.id.toString()
      : '#' + acting.id.toString()
    : null;
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
                : hubSection === 'wallet'
                  ? tr('hub.wallet')
                  : tr('nav.settings')}
          </Text>
        </View>
        {hubSection === 'mine' && <MyNamesScreen />}
        {hubSection === 'get' && <GetNameScreen />}
        {hubSection === 'settings' && <SettingsScreen />}
        {hubSection === 'wallet' && <WalletDetail />}
      </View>
    );
  }

  return (
    <View style={S.screen}>
      <ScrollView contentContainerStyle={{ paddingBottom: 28 }}>
        {/* Profile summary — the hub's identity row. Tapping
            it opens the acting name's profile (the route the
            old card's Profile button took); the address chip
            keeps its copy behaviour. */}
        {acting ? (
          <Pressable
            onPress={() => app.openProfile(acting.username)}
            style={({ pressed }) => [pressed && { opacity: 0.8 }]}
            accessibilityRole="button"
          >
            <View style={styles.summaryRow}>
              <Avatar
                nameId={acting.id}
                size={48}
                customUri={actingCustom?.avatarPath}
              />
              <View style={{ flex: 1, marginStart: 12 }}>
                <Text style={styles.summaryName} numberOfLines={1}>
                  {displayName}
                </Text>
                <Text style={S.small} numberOfLines={1}>
                  {subLine}
                </Text>
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
          </Pressable>
        ) : (
          <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
            <Text style={S.body}>{tr('mine.none')}</Text>
            <Pressable
              style={[S.bigBtn, { marginTop: 12 }]}
              onPress={() => openHub('get')}
            >
              <Text style={S.bigBtnText}>{tr('nav.getName')}</Text>
            </Pressable>
          </View>
        )}

        {/* The ONE prominent balance (concept image ②): the
            active name's deposited CAW — the balance posts
            and actions draw their fees from — big, with its
            caption. Every other balance is one tap away in
            the wallet detail (the row right below, or tap
            this card). Unread stays the honest dash via the
            grid; here a name always has its enumerated
            balance, so the figure is the real one. */}
        {acting ? (
          <Pressable
            style={({ pressed }) => [
              styles.heroCard,
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => openHub('wallet')}
            accessibilityRole="button"
          >
            <View style={[S.row, { alignItems: 'center', gap: 8 }]}>
              <TipIcon size={22} />
              <Text style={S.small}>{tr('card.inName')}</Text>
            </View>
            <Text
              style={styles.heroAmount}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.5}
            >
              {fmtAmountCard(acting.balance)}
              <Text style={styles.heroUnit}> CAW</Text>
            </Text>
            <Text style={[S.tiny, { marginTop: 4 }]}>
              {tr('hub.balanceNote')}
            </Text>
          </Pressable>
        ) : null}

        {/* Entries — everything the removed tabs and the old
            header held, one icon row each (concept image ⑦). */}
        <View style={styles.entryGroup}>
          <EntryRow
            icon={<WalletIcon size={20} color="#0f1419" />}
            label={tr('hub.wallet')}
            onPress={() => openHub('wallet')}
          />
          <EntryRow
            icon={<UserIcon size={20} color="#0f1419" />}
            label={tr('nav.myNames')}
            onPress={() => openHub('mine')}
          />
          <EntryRow
            icon={<UserPlusIcon size={20} color="#0f1419" />}
            label={tr('nav.getName')}
            onPress={() => openHub('get')}
          />
          <EntryRow
            icon={<RepeatIcon size={20} color="#0f1419" />}
            label="HuntersExchange"
            caption={tr('hs.title')}
            onPress={() => setHsOpen(true)}
          />
          <EntryRow
            icon={<SendIcon size={20} color="#0f1419" />}
            label={tr('send.title')}
            onPress={() => setSendOpen(true)}
          />
          {acting ? (
            <EntryRow
              icon={<DownloadIcon size={20} color="#0f1419" />}
              label={tr('home.deposit')}
              onPress={() => app.focusMine(acting.id)}
            />
          ) : null}
          <EntryRow
            icon={<BookmarkIcon size={20} color="#0f1419" />}
            label={tr('bm.title')}
            onPress={() => setBookmarksOpen(true)}
          />
          <EntryRow
            icon={<BellIcon size={20} color="#0f1419" />}
            label={tr('inbox.title')}
            onPress={() => setInboxOpen(true)}
          />
          <EntryRow
            icon={<SettingsIcon size={20} color="#0f1419" />}
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
  icon,
  label,
  caption,
  onPress,
  last,
}: {
  icon: React.ReactNode;
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
      <View style={styles.entryIcon}>{icon}</View>
      <View style={{ flex: 1, marginStart: 12 }}>
        <Text style={styles.entryLabel} numberOfLines={1}>
          {label}
        </Text>
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
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  summaryName: { fontSize: 17, fontWeight: '800', color: '#0f1419' },
  chip: {
    backgroundColor: '#eff3f4',
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
    marginStart: 10,
  },
  chipText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#0f1419',
    fontFamily: MONO,
  },
  heroCard: {
    marginHorizontal: 12,
    marginTop: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
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
  heroAmount: {
    fontSize: 27,
    fontWeight: '800',
    color: '#0f1419',
    marginTop: 8,
    fontVariant: ['tabular-nums'],
  },
  heroUnit: { fontSize: 14, fontWeight: '700', color: '#536471' },
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
    paddingVertical: 12,
  },
  entryRowLine: {
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
  },
  entryIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#eff3f4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  entryLabel: { fontSize: 15.5, fontWeight: '600', color: '#0f1419' },
  entryChevron: { fontSize: 20, color: '#536471', marginStart: 8 },
});
