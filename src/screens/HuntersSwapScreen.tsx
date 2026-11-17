/**
 * HuntersDEX (v0.7.0; HuntersExchange through v0.6.7) — the
 * DEX screen.
 *
 * v0.7.0 (user decision 2026-11-18): the feature is renamed
 * HuntersDEX and the order book is replaced by a NORMAL DEX
 * flow — pick from/to, amount, live quote, swap — over the
 * app's aggregator engine (lib/aggEngine) on QL1, limited
 * to six tokens (QOM / O / qCAW / KET / HAWK / PHOENIX). The
 * new body is DexSwapSection. The order-book component
 * (ExchangeSection, with its guided deposit/withdraw flows)
 * is no longer mounted here; its code stays in the repo,
 * unmounted, and the swap/bridge LIBRARIES (lib/hunters.ts,
 * lib/aggEngine.ts, lib/flows.ts) are untouched and stay
 * verified by their own suites.
 *
 * History: v0.5.0 removed the instant swap in favour of the
 * book (user decision 2026-11-10); v0.7.0 reverses that
 * shape on the user's new instruction. Internal ids and
 * storage keys still say HuntersSwap, as with every display
 * rename before this one.
 */
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';

import { HAIRLINE, MONO, S } from '../components/ui';
import DexSwapSection from './DexSwapSection';
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
      {/* Brand header: the feature's name is HuntersDEX
       * (a proper noun, never translated); the localized
       * "Swap on QL1" line is its caption. */}
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
          Hunters<Text style={{ color: ACCENT }}>DEX</Text>
        </Text>
        <Text style={[S.small, { marginTop: 1 }]}>{tr('dex.caption')}</Text>
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
      {/* The DEX swap section, directly — no mode toggle.
       * The deposit address card rides on top: an outside
       * deposit to this same address stays the manual way
       * in. */}
      <ScrollView
        style={S.screen}
        contentContainerStyle={{ paddingBottom: 32 + insets.bottom }}
      >
        <DepositAddressRow address={app.address ?? ''} />
        <DexSwapSection />
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
