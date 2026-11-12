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
  BalanceList,
  DownloadIcon,
  MONO,
  S,
  SendIcon,
} from '../components/ui';
import { backArrow } from '../lib/rtl';
import MyNamesScreen from './MyNamesScreen';
import GetNameScreen from './GetNameScreen';
import SettingsScreen from './SettingsScreen';
import SendScreen from './SendScreen';

/**
 * The wallet screen (hub 'wallet' section), redesigned in
 * v0.6.2 in MetaMask's layout (user instruction, 2026-11-13):
 *
 *  1. PROFILE SECTION at the top — the acting name's avatar,
 *     display name, "@handle · #id" and the copyable address
 *     chip, the same content the retired hub's summary
 *     carried. The whole section is tappable and opens the
 *     user's OWN profile page (the same openProfile route
 *     the hub summary tap used). No name yet: the honest
 *     prompt + the Get-a-name entry, as the hub had.
 *  2. ACTION BUTTONS — Send and Deposit, the app's primary
 *     (X-blue) treatment, opening the EXACT flows the retired
 *     hub rows opened: Send → the SendScreen modal; Deposit
 *     → focusMine(acting.id) (My names, deposit controls
 *     expanded). The hub's Send/Deposit menu rows are GONE
 *     (confirmed user instruction, 2026-11-13): the flows
 *     live here now, consolidated. Deposit keeps the hub
 *     row's precondition exactly — it renders only when an
 *     acting name exists (with no name there is nothing to
 *     deposit into, and the section above offers Get-a-name
 *     instead). The address chip in (1) covers receive/copy,
 *     as it did on the hub.
 *  3. ASSET LIST — the seven balances as a vertical list
 *     (BalanceList), same order and same raw sources as the
 *     grid it replaces: wallet CAW / QOM (fees) / in-name
 *     CAW (the acting name's deposited balance) / [42] /
 *     CAT42 (tips) / O / KET. Unread stays the dash, real
 *     zero stays 0; tapping an amount toggles the exact
 *     figure; no prices, no fiat totals (no trusted price
 *     source exists, so none is invented).
 */
function WalletDetail() {
  const app = useApp();
  const { actingId, myTokens, address, qom, qcaw, f42, cat42, oTok, ket } =
    app;
  const [sendOpen, setSendOpen] = useState(false);
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

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 28 }}
      >
        {/* (1) Profile section — tap for the own profile. */}
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
              onPress={() => app.openHub('get')}
            >
              <Text style={S.bigBtnText}>{tr('nav.getName')}</Text>
            </Pressable>
          </View>
        )}

        {/* (2) Actions — Send / Deposit (MetaMask-style row of
            primary buttons; the hub rows' flows, verbatim). */}
        <View style={styles.actionRow}>
          <Pressable
            style={({ pressed }) => [
              styles.actionBtn,
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => setSendOpen(true)}
            accessibilityRole="button"
          >
            <SendIcon size={19} color="#fff" />
            <Text style={styles.actionBtnText} numberOfLines={1}>
              {tr('send.title')}
            </Text>
          </Pressable>
          {acting ? (
            <Pressable
              style={({ pressed }) => [
                styles.actionBtn,
                pressed && { opacity: 0.85 },
              ]}
              onPress={() => app.focusMine(acting.id)}
              accessibilityRole="button"
            >
              <DownloadIcon size={19} color="#fff" />
              <Text style={styles.actionBtnText} numberOfLines={1}>
                {tr('home.deposit')}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {/* (3) Asset list — the seven balances, grid order,
            grid sources, as rows. */}
        <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
          <BalanceList
            rows={[
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
            ]}
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
    </View>
  );
}

/**
 * The hub SECTIONS host (v0.6.2). Through v0.6.1 this screen
 * was the Profile tab itself, with a hub home ('main': the
 * profile summary, the hero deposited-CAW card, the entry
 * rows) above the sections. The X-style drawer (components/
 * Drawer.tsx) replaced the hub home as the app's menu
 * surface, and the Profile tab now opens the user's own
 * profile page directly — so what remains here is exactly
 * the section host: a back row (← 戻る + the section title,
 * the pattern every section has always used) over My names /
 * Get a name / Settings / the wallet screen. App renders
 * this only while a section is open (hubSection !== 'main');
 * 'main' means "no section open" and never mounts it. Back
 * (openHub('main')) lands on the own-profile tab.
 *
 * The destinations the retired hub home held, and their new
 * homes (pinned by scripts/verify-xui.mjs): profile summary →
 * the drawer summary + the wallet screen's profile section;
 * hero deposited-CAW card → the 名前の中の CAW row of the
 * wallet asset list; entry rows → the drawer rows (same
 * destinations); Send/Deposit rows → the wallet screen's
 * action buttons (the flows themselves unchanged).
 */
export default function MeScreen() {
  const app = useApp();
  const { hubSection, openHub } = app;

  if (hubSection === 'main') {
    // App never mounts the host in this state; render nothing
    // rather than resurrect the retired hub home.
    return <View style={S.screen} />;
  }

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
  actionRow: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    marginTop: 18,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: ACCENT,
    borderRadius: 999,
    paddingVertical: 12,
  },
  actionBtnText: { fontSize: 15.5, fontWeight: '700', color: '#fff' },
});
