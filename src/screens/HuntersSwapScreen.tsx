/**
 * HuntersExchange (v0.5.0 formal) — the order book screen.
 *
 * The instant swap is GONE (user decision 2026-11-10:
 * 「いますぐ交換はいらない、板だけにして」): no goal cards, no
 * buy/sell toggle, no guided instant-swap flow. The screen
 * opens directly on the order book (ExchangeSection), which
 * also carries the guided DEPOSIT / WITHDRAW flows —
 * "deposit" in the user's own naming: the coin is bridged
 * to 42 Chain and held in the Exchange contract (BSC USDT
 * or QL1 qCAW in; withdrawals mirror back out).
 *
 * The swap/bridge LIBRARIES (lib/hunters.ts, lib/aggEngine.ts,
 * lib/flows.ts) are untouched and stay verified by their own
 * suites; only the instant-swap UX was removed. Internal ids
 * and storage keys still say HuntersSwap, as with every
 * display rename before this one.
 */
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';

import { HAIRLINE, MONO, S } from '../components/ui';
import ExchangeSection from './ExchangeSection';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { tr } from '../i18n';
import SendScreen from './SendScreen';
import FaucetScreen from './FaucetScreen';

/**
 * Deposit address card (v0.3.3): the active wallet's own address,
 * shown above the book so it can be copied and pasted into an
 * exchange / another wallet. The app uses ONE address on every
 * chain (BSC / Ethereum / 42 Chain / QL1), so a single row serves
 * all chains. Copying always takes the full 0x string; the
 * "copied" note follows the SettingsScreen pattern.
 */
function DepositAddressRow({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  if (!address) return null;
  const doCopy = async () => {
    await Clipboard.setStringAsync(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderBottomColor: '#eff3f4',
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <Text style={[S.body, { fontWeight: '700' }]}>{tr('hs.depositAddress')}</Text>
      <Text style={[S.small, { marginTop: 2 }]}>{tr('hs.depositSame')}</Text>
      <Text
        selectable
        style={{ fontFamily: MONO, fontSize: 13, color: '#0f1419', marginTop: 8, writingDirection: 'ltr', textAlign: 'left' }}
      >
        {address}
      </Text>
      <Pressable style={[S.ghostBtn, { marginTop: 10 }]} onPress={doCopy}>
        <Text style={S.ghostBtnText}>
          {copied ? tr('hs.addressCopied') : tr('hs.copyAddress')}
        </Text>
      </Pressable>
    </View>
  );
}

/** Faucet entry in the Exchange header (v0.4.1), pill-styled
 *  to match the Send / Close pills beside it. */
function FaucetPillButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={{
          backgroundColor: '#eff3f4',
          borderRadius: 999,
          paddingHorizontal: 14,
          paddingVertical: 8,
        }}
      >
        <Text style={{ color: '#0f1419', fontSize: 14, fontWeight: '600' }}>
          {tr('faucet.title')}
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

export default function HuntersSwapScreen({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [sendOpen, setSendOpen] = useState(false);
  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      {/* Brand header: the feature's name is HuntersExchange
       * (a proper noun, never translated); the localized
       * "Buy / sell CAW" line stays as its caption. */}
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 12,
          borderBottomWidth: 1,
          borderBottomColor: HAIRLINE,
        }}
      >
        {/* v0.6.1: the title gets its own full-width line.
            Squeezed into a flex row beside three pills it was
            left ~40% of the width and wrapped mid-word
            ("Exchang/e") on the user's phone. One line,
            fit-to-width, never a break inside the word; the
            pills move to their own row under the caption. */}
        <Text
          style={{ fontSize: 22, fontWeight: '800', color: '#0f1419', letterSpacing: 0.2 }}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
        >
          Hunters<Text style={{ color: ACCENT }}>Exchange</Text>
        </Text>
        <Text style={[S.small, { marginTop: 1 }]}>{tr('hs.title')}</Text>
        <View>
          <View style={[S.row, { gap: 8, marginTop: 10 }]}>
            <FaucetPillButton />
            <Pressable
              onPress={() => setSendOpen(true)}
              style={{
                backgroundColor: ACCENT,
                borderRadius: 999,
                paddingHorizontal: 14,
                paddingVertical: 8,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>{tr('send.title')}</Text>
            </Pressable>
            <Pressable
              onPress={onClose}
              style={{
                backgroundColor: '#eff3f4',
                borderRadius: 999,
                paddingHorizontal: 14,
                paddingVertical: 8,
              }}
            >
              <Text style={{ color: '#0f1419', fontSize: 14, fontWeight: '600' }}>{tr('common.close')}</Text>
            </Pressable>
          </View>
        </View>
      </View>
      <Modal
        visible={sendOpen}
        animationType="slide"
        onRequestClose={() => setSendOpen(false)}
      >
        <SendScreen onClose={() => setSendOpen(false)} />
      </Modal>
      {/* The order book, directly — no mode toggle. The
       * deposit address card rides on top of the book: an
       * outside deposit to this same address is the manual
       * way in, the guided flows in the book are the
       * in-app way. */}
      <ScrollView
        style={S.screen}
        contentContainerStyle={{ paddingBottom: 32 + insets.bottom }}
      >
        <DepositAddressRow address={app.address ?? ''} />
        <ExchangeSection />
      </ScrollView>
    </View>
  );
}

export function HuntersSwapModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <HuntersSwapScreen onClose={onClose} />
    </Modal>
  );
}
