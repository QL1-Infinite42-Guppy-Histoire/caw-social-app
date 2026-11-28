import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';
import { SvgXml } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ACCENT, X_GOLD, X_SUPER_WASH_LIGHT } from '../config';
import { LOCALES, isLang, tr } from '../i18n';
import {
  avatarFor,
  findPostByCawId,
  knownRecawCount,
  knownReplyCount,
  likesCount,
  nameOwner,
  resolveName,
  txUrl,
} from '../lib/cawApi';
import {
  subscribeSuperlike,
  superlikeCount,
  superlikeCountCached,
} from '../lib/superlike';
import { subscribeMarkedBurns } from '../lib/markedBurns';
import {
  hasSuperRecawFor,
  superRecawCachedFor,
} from '../lib/superRecaw';
import {
  TIP_PRESETS,
  parseTipAmount,
  tipChipAmount,
  tipPresetRaw,
} from '../lib/tip';
import {
  avatarSpec,
  fmtAmountCard,
  fmtCardDisplay,
  fmtExactDec,
  svgFromImageUri,
} from '../lib/cawCore';
import { displayTextOf, parsePostText } from '../lib/postRef';
import {
  extractUrls,
  fetchPreview,
  shortenUrl,
  splitRichSegments,
  type LinkPreview,
} from '../lib/linkify';
import {
  VIEWS_ENABLED,
  formatViewCount,
  registerView,
  subscribeViews,
  viewCountCached,
} from '../lib/views';
import { resolveShareUrl } from '../lib/share';
import {
  attachmentLookup,
  hashFromMediaUrl,
  mediaFor,
  type PostAttachment,
  type SanctionEntry,
} from '../lib/mediaApi';
import type { TimelineItem } from '../lib/cawApi';
import type { ProfileCustom } from '../lib/profileCustom';

export const HAIRLINE = '#eff3f4';

/**
 * Monospace font for addresses / hashes (iOS readiness, v0.3.5):
 * 'monospace' is an Android generic family — iOS has no such
 * family and would silently fall back to the default font. Menlo
 * is iOS's bundled monospace; Android keeps its generic.
 */
export const MONO: string = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
}) as string;

/**
 * Guard for content that must stay left-to-right even when the
 * layout mirrors for Persian (v0.3.9): 0x addresses, tx hashes,
 * secret words/keys — their character order is the data. Apply
 * to the Text (or TextInput) that renders them.
 */
export const LTR_TEXT: { writingDirection: 'ltr' } = {
  writingDirection: 'ltr',
};

/**
 * The app logo (v0.3.4): the user's emblem artwork, the same image
 * as the launcher icon (assets/icon.png — yellow emblem on navy).
 * Replaces the 🐦 emoji that used to stand in for the app mark in
 * headers, onboarding and the unlock screen. Rounded corners so
 * the navy square reads as an app icon at small sizes.
 */
export function AppLogo({
  size = 28,
  radius,
}: {
  size?: number;
  radius?: number;
}) {
  return (
    <Image
      source={require('../../assets/icon.png')}
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? Math.max(4, Math.round(size * 0.26)),
      }}
    />
  );
}

export const S = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  scrollPad: { padding: 16, paddingBottom: 32 },
  h1: { fontSize: 22, fontWeight: '800', color: '#0f1419' },
  h2: { fontSize: 17, fontWeight: '700', color: '#0f1419', marginTop: 8 },
  /* Line heights sit at ~1.45x the font size (v0.4.0): Devanagari
   * (Hindi) combining marks reach above and below the base glyph,
   * and tighter explicit line heights can clip them on Android.
   * Styles without a lineHeight use the font's own metrics and
   * need no help. */
  body: { fontSize: 15, color: '#0f1419', lineHeight: 22 },
  small: { fontSize: 13, color: '#536471', lineHeight: 19 },
  tiny: { fontSize: 12, color: '#536471' },
  err: { fontSize: 14, color: '#c62828', lineHeight: 21 },
  ok: { fontSize: 14, color: '#1b7a43', lineHeight: 21 },
  input: {
    borderWidth: 1,
    borderColor: '#cfd9de',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: '#0f1419',
    backgroundColor: '#fff',
  },
  bigBtn: {
    backgroundColor: ACCENT,
    borderRadius: 999,
    paddingVertical: 13,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  bigBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  darkBtn: {
    backgroundColor: '#0f1419',
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  darkBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  ghostBtn: {
    borderWidth: 1,
    borderColor: '#cfd9de',
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    backgroundColor: '#fff',
  },
  ghostBtnText: { color: '#0f1419', fontSize: 15, fontWeight: '600' },
  moreBtn: {
    backgroundColor: '#0f1419',
    borderRadius: 999,
    paddingVertical: 15,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  moreBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  /* Shared polish primitives (v0.3.8 design pass): one card
   * language across the app — white surface, hairline border,
   * radius 16 — matching the Home wallet card and the v0.3.7
   * HuntersSwap balance cards. cardBox pads its content;
   * cardFlush is for divider lists (rows carry their own
   * padding, separated by rowDivider). */
  cardBox: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: HAIRLINE,
    borderRadius: 16,
    padding: 14,
    marginTop: 10,
  },
  cardFlush: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: HAIRLINE,
    borderRadius: 16,
    marginTop: 10,
    overflow: 'hidden',
  },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: HAIRLINE },
  emptyCard: {
    alignItems: 'center',
    paddingVertical: 26,
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: HAIRLINE,
    borderRadius: 16,
    backgroundColor: '#fbfcfc',
    marginTop: 14,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  chip: {
    backgroundColor: '#f0f3f4',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: { fontSize: 12.5, color: '#0f1419' },
});

/* ---------- line icons (same feather-style paths as the web) ---------- */
export function StarIcon({ size = 18, color = '#536471', filled = false }: { size?: number; color?: string; filled?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : 'none'} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </Svg>
  );
}
/** Tip coin (v0.5.0): a gold CAT42 coin — a filled circle with
 *  a "C" arc cut in the idle colour, so it reads as money next
 *  to the outline action icons. */
export function TipIcon({ size = 18, color = X_GOLD }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={10} fill={color} />
      <Path
        d="M15.5 9.2a4.6 4.6 0 1 0 0 5.6"
        fill="none"
        stroke="#fff"
        strokeWidth={2.2}
        strokeLinecap="round"
      />
    </Svg>
  );
}
export function HeartIcon({ size = 18, color = '#536471', filled = false }: { size?: number; color?: string; filled?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : 'none'} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </Svg>
  );
}
export function RepeatIcon({ size = 18, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Polyline points="17 1 21 5 17 9" />
      <Path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <Polyline points="7 23 3 19 7 15" />
      <Path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </Svg>
  );
}
/** Bridge (v0.7.11): the planned ETH⇄QL1 Bridge drawer row's
 *  mark — two opposing horizontal arrows (the lucide
 *  arrow-right-left paths), same feather stroke style. The
 *  row is an announcement only; the bridge is not deployed. */
export function BridgeIcon({ size = 18, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M8 3 4 7l4 4" />
      <Path d="M4 7h16" />
      <Path d="m16 21 4-4-4-4" />
      <Path d="M20 17H4" />
    </Svg>
  );
}
/** Flame (v0.7.0): the BurnHawk drawer row's mark — a simple
 *  flame outline in the same feather stroke style. */
export function FlameIcon({ size = 18, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 22c4.1 0 7-2.9 7-6.8 0-3.2-2.1-5.4-3.6-7C14.2 6.9 13 5.2 13 2c-3 2-5.5 4.6-5.6 7.6-.3-.5-.6-1.2-.7-2C5.6 9.2 5 11.4 5 13.4 5 18.9 7.9 22 12 22z" />
    </Svg>
  );
}
/** Bookmark (v0.6.0): the feather bookmark outline, filled in
 *  the accent when the post is saved — X's exact treatment. */
export function BookmarkIcon({ size = 18, color = '#536471', filled = false }: { size?: number; color?: string; filled?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : 'none'} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </Svg>
  );
}
/** Share (v0.6.4; link-only since v0.6.7): the feather upload
 *  glyph — X's share mark, last in the action row. It opens the
 *  OS share sheet carrying ONLY a link: the post's page on the
 *  community web viewer, shortened through cawl (see
 *  onSharePost in PostCardBase and lib/share.ts). */
export function ShareIcon({ size = 18, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <Polyline points="17 8 12 3 7 8" />
      <Line x1="12" y1="3" x2="12" y2="15" />
    </Svg>
  );
}
/** Views (v0.6.0): X's bar-chart impressions glyph. Rendered
 *  ONLY when the view counter is configured and has answered
 *  for the post — see lib/views.ts (absent, never a fake 0). */
export function ViewsIcon({ size = 18, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 3v18h18" />
      <Path d="M8 17v-6" />
      <Path d="M13 17V7" />
      <Path d="M18 17v-9" />
    </Svg>
  );
}
export function ReplyIcon({ size = 18, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </Svg>
  );
}
/* Bottom tab icons (v0.4.6): the same feather set as the rest of
 * the app, drawn as vector so the marks render identically on
 * every device (an emoji house/gear depends on the phone's emoji
 * font). The tab bar colours them with the label: gray when
 * idle, ACCENT on the active tab. */
export function HomeIcon({ size = 22, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <Polyline points="9 22 9 12 15 12 15 22" />
    </Svg>
  );
}
export function SearchIcon({ size = 22, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="11" cy="11" r="8" />
      <Line x1="21" y1="21" x2="16.65" y2="16.65" />
    </Svg>
  );
}
export function UserIcon({ size = 22, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <Circle cx="12" cy="7" r="4" />
    </Svg>
  );
}
/** Bell (v0.6.1): the reactions-inbox mark for the X-style
 *  header and the hub row — vector, replacing the emoji bell
 *  the header button used through v0.6.0. */
export function BellIcon({ size = 22, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <Path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </Svg>
  );
}
/** Wallet (v0.6.1): the hub's balance-detail row mark. */
export function WalletIcon({ size = 22, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
      <Path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
      <Path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
    </Svg>
  );
}
/** Send (v0.6.1): the paper plane, for the hub's Send row. */
export function SendIcon({ size = 22, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Line x1="22" y1="2" x2="11" y2="13" />
      <Path d="M22 2 15 22l-4-9-9-4Z" />
    </Svg>
  );
}
/** Deposit (v0.6.1): an arrow down into a tray, for the hub's
 *  Deposit row (the focusMine route into My names). */
export function DownloadIcon({ size = 22, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <Polyline points="7 10 12 15 17 10" />
      <Line x1="12" y1="15" x2="12" y2="3" />
    </Svg>
  );
}
/** Get a name (v0.6.1): user-plus, for the hub's mint row. */
export function UserPlusIcon({ size = 22, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <Circle cx="8.5" cy="7" r="4" />
      <Line x1="20" y1="8" x2="20" y2="14" />
      <Line x1="23" y1="11" x2="17" y2="11" />
    </Svg>
  );
}
/** Check (v0.6.1): a plain tick for completed flow steps —
 *  replaces the emoji check in the Exchange step list. */
export function CheckIcon({ size = 16, color = '#1b7a43' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Polyline points="20 6 9 17 4 12" />
    </Svg>
  );
}
/** Copy (v0.6.1): two stacked pages, for address copy chips —
 *  replaces the clipboard emoji. */
export function CopyIcon({ size = 14, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="9" y="9" width="13" height="13" rx="2" />
      <Path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}
export function SettingsIcon({ size = 22, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="12" cy="12" r="3" />
      <Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}

/* ---------- balance list (v0.6.2; grid v0.4.10–v0.6.1) ---------- */
/**
 * The balances as a vertical asset list — MetaMask's token
 * list form, which replaced the two-column BalanceGrid on
 * the wallet screen in v0.6.2 (the grid's only home was that
 * screen). Same discipline as the grid carried:
 *
 * A row is { label, unit, raw, decimals }: `raw` is the
 * unscaled on-chain amount and null keeps the honest dash of
 * the v0.4.7 rule (unread / no name yet), never a numeric 0.
 * The amount text comes from fmtCardDisplay (cawCore): big
 * balances are abbreviated "x.xxB" / "x.xxM" (truncated,
 * never rounded), the rest use the card format at the
 * token's own decimals. Tapping a row swaps its amount for
 * the EXACT full figure (fmtExactDec); tapping it again — or
 * tapping another row — swaps back / moves over. The hint
 * line under the list says the tap rule in the current
 * language (card.tapHint). No prices and no fiat totals are
 * shown anywhere: the app has no price source it trusts, so
 * MetaMask's total-balance figure is deliberately absent.
 */
export interface BalanceRowData {
  label: string;
  unit: string;
  raw: bigint | null;
  decimals?: number;
}

export function BalanceList({ rows }: { rows: BalanceRowData[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <View>
      <View style={balanceStyles.list}>
        {rows.map((row, idx) => {
          const dec = row.decimals ?? 18;
          const shown =
            row.raw === null
              ? null
              : open === idx
                ? fmtExactDec(row.raw, dec)
                : fmtCardDisplay(row.raw, dec).text;
          return (
            <Pressable
              key={idx}
              style={({ pressed }) => [
                balanceStyles.row,
                idx === rows.length - 1 && balanceStyles.rowLast,
                pressed && { backgroundColor: '#f7f9f9' },
              ]}
              onPress={() =>
                row.raw !== null &&
                setOpen((o) => (o === idx ? null : idx))
              }
              accessibilityRole="button"
            >
              <Text
                style={balanceStyles.label}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
              >
                {row.label}
              </Text>
              <Text
                style={balanceStyles.amount}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.4}
              >
                {shown === null ? '—' : shown}
                {shown === null ? null : (
                  <Text style={balanceStyles.unit}> {row.unit}</Text>
                )}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={balanceStyles.hint}>{tr('card.tapHint')}</Text>
    </View>
  );
}

const balanceStyles = StyleSheet.create({
  /* The list keeps the grid's bordered-table look (outer box
   * border #d9dee2, radius 12) and its amount metrics (amount
   * 17, unit 11.5); rows are full-width with a hairline
   * between them and list air (paddingVertical 11). */
  list: {
    borderWidth: 1,
    borderColor: '#d9dee2',
    borderRadius: 12,
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
  },
  rowLast: { borderBottomWidth: 0 },
  label: { flex: 1, fontSize: 14, color: '#0f1419', fontWeight: '600' },
  amount: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0f1419',
    fontVariant: ['tabular-nums'],
  },
  unit: { fontSize: 11.5, fontWeight: '600', color: '#536471' },
  hint: { fontSize: 11, color: '#8a97a3', marginTop: 6 },
});

/* ---------- avatar (the name's card picture) ---------- */
/**
 * The avatar is the picture from the name's card (tokenURI) — the
 * same metadata whose name field matches the mint records, so the
 * picture and the displayed name always belong to the same name.
 * While it loads (or when a token has no picture) a generated
 * initial-letter avatar stands in, derived from the card name via
 * avatarSpec. A user's own off-chain custom picture (profileCustom)
 * wins over both.
 */
function AvatarBase({
  nameId,
  size = 44,
  onPress,
  customUri,
}: {
  nameId: bigint;
  size?: number;
  onPress?: () => void;
  /** On-device custom picture (off-chain) — wins over the card one. */
  customUri?: string | null;
}) {
  const [img, setImg] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  /* Shared profile icon (v0.7.3, media server): an icon the
   * name's owner published for everyone wins over the on-device
   * custom picture and the card image. mediaFor never rejects —
   * null means "no shared icon" (or the server is down) and the
   * older fallbacks below apply unchanged. */
  const [serverIcon, setServerIcon] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setServerIcon(null);
    mediaFor(nameId).then(
      (m) => live && setServerIcon(m?.icon?.url ?? null),
    );
    return () => {
      live = false;
    };
  }, [nameId]);
  useEffect(() => {
    if (customUri) return; // the custom picture needs no chain reads
    let live = true;
    avatarFor(nameId).then((u) => live && setImg(u));
    resolveName(nameId).then((n) => live && setName(n));
    return () => {
      live = false;
    };
  }, [nameId, customUri]);
  let inner: React.ReactNode;
  const shownUri = serverIcon || customUri;
  if (shownUri) {
    inner = <Image source={{ uri: shownUri }} style={{ width: size, height: size }} />;
  }
  if (!inner && img) {
    // The card image is a BASE64 svg data URI — decode it with
    // svgFromImageUri (v0.4.9; the pre-fix decodeURIComponent
    // handed the raw base64 text to <SvgXml>, which rendered
    // nothing and blocked the letter fallback: plain gray
    // circles for every name without an on-device custom
    // picture). A URI that does not decode to SVG falls
    // through to the raster / letter branches below.
    const svg = svgFromImageUri(img);
    if (svg) {
      inner = <SvgXml xml={svg} width={size} height={size} />;
    }
  }
  if (!inner && img) {
    inner = <Image source={{ uri: img }} style={{ width: size, height: size }} />;
  }
  if (!inner) {
    const spec = avatarSpec(name, nameId);
    inner = (
      <View
        style={{
          width: size,
          height: size,
          backgroundColor: name ? spec.bg : '#f0f3f4',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            fontSize: size * 0.42,
            fontWeight: '700',
            color: name ? '#fff' : '#536471',
          }}
        >
          {spec.letter}
        </Text>
      </View>
    );
  }
  const content = (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: 'hidden',
        backgroundColor: '#f0f3f4',
      }}
    >
      {inner}
    </View>
  );
  if (onPress) {
    return <Pressable onPress={onPress}>{content}</Pressable>;
  }
  return content;
}

/** Memoized: timeline rows re-render often; an avatar's inputs
 *  (name id, size, custom picture) rarely change. */
export const Avatar = React.memo(AvatarBase);

/** Resolved display name for a token id ("@name" or "name #id"). */
export function useNameLabel(id: bigint): string {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    resolveName(id).then((n) => live && setName(n));
    return () => {
      live = false;
    };
  }, [id]);
  return name ? '@' + name : tr('tl.unknownName') + id.toString();
}

/**
 * X-style relative time for post rows (v0.6.0): "12s", "2m",
 * "5h", "3d" — the compact units the approved mock shows,
 * identical in every language (as on X itself in most
 * locales). A week and older falls back to the absolute
 * localised date (formatTime), so an old post never shows a
 * silly "214d".
 */
export function formatRelativeTime(tsSec: number, lang: string): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - tsSec);
  if (diff < 60) return diff + 's';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  if (diff < 7 * 86400) return Math.floor(diff / 86400) + 'd';
  return formatTime(tsSec, lang);
}

export function formatTime(tsSec: number, lang: string): string {
  try {
    return new Date(tsSec * 1000).toLocaleString(
      isLang(lang) ? LOCALES[lang] : 'en-US',
      {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      },
    );
  } catch {
    return new Date(tsSec * 1000).toISOString();
  }
}

/**
 * Full-width "load more" footer for the lists (timeline / profile).
 * v0.1.4 fix: the old footer was a small low-contrast ghost button
 * sitting at the very bottom edge of the screen — on the profile
 * (shown in a Modal, no SafeAreaView of its own) it ended up half
 * hidden under the gesture area and was hard to tap. This footer is
 * a large dark high-contrast button (52px+ tall, full width) with
 * generous bottom padding that includes the device safe-area inset,
 * so it always scrolls fully clear of the tab bar / gesture area.
 */
export function LoadMoreFooter({
  loading,
  onPress,
  label,
}: {
  loading: boolean;
  onPress: () => void;
  label: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 28 + insets.bottom,
      }}
    >
      {loading ? (
        <View style={{ minHeight: 52, justifyContent: 'center' }}>
          <ActivityIndicator color={ACCENT} />
        </View>
      ) : (
        <Pressable
          style={({ pressed }) => [
            S.moreBtn,
            pressed && { opacity: 0.85 },
          ]}
          onPress={onPress}
        >
          <Text style={S.moreBtnText}>{label}</Text>
        </Pressable>
      )}
    </View>
  );
}

const LIKE_ON = '#e0245e';
const RECAW_ON = '#00ba7c';
/** SuperLike gold — distinct from like pink / recaw green.
 *  v0.6.0: the X gold token (#FFAC33 family), reserved for
 *  the SuperLike star and the tip coin, nothing else. */
const SUPERLIKE_ON = X_GOLD;
/** SuperRecaw row wash (v0.6.4): the light-surface value of
 *  the config token pair — screens read the light values
 *  today, exactly as with the post surface '#fff' below; the
 *  stronger X_SUPER_WASH_DARK is defined alongside for the
 *  dark surface. Applied ONLY while a recaw row's isSuper
 *  detection state is true. */
const SUPER_RECAW_WASH = X_SUPER_WASH_LIGHT;

/** The Frozen / Banned badge line (v0.7.9), in the Hidden
 *  badge's slot and style. */
function SanctionBadge({ kind }: { kind: 'freeze' | 'ban' }) {
  return (
    <Text style={postStyles.modBadgeText}>
      {kind === 'freeze' ? tr('sanct.frozenBadge') : tr('sanct.bannedBadge')}
    </Text>
  );
}

/** The original post a like / share points at, shown as a quote box. */
function TargetPostQuote({
  item,
  lang,
  onOpenProfile,
  modAdmin,
  modHiddenFor,
  modSanctionFor,
}: {
  item: TimelineItem;
  lang: string;
  onOpenProfile: (username: string) => void;
  /** Moderation (v0.7.6): a hidden target post's content is
   *  not quoted for non-admins (the hidden note stands in
   *  its place); admins see it with the Hidden badge. */
  modAdmin?: boolean;
  modHiddenFor?: (cawId: string) => boolean;
  /** Sanctions (v0.7.9): same treatment when the target's
   *  AUTHOR is sanctioned. */
  modSanctionFor?: (senderId: bigint) => SanctionEntry | null;
}) {
  const [post, setPost] = useState<TimelineItem | null>(null);
  const [author, setAuthor] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    findPostByCawId(item.cawId)
      .then((p) => {
        if (!live) return;
        setPost(p);
        if (p) {
          resolveName(p.senderId).then((n) => live && setAuthor(n));
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [item.cawId]);
  if (!post || !post.text) return null;
  const targetHidden = !!(modHiddenFor && modHiddenFor(post.cawId));
  const targetSanction = modSanctionFor
    ? modSanctionFor(post.senderId)
    : null;
  if ((targetHidden || targetSanction) && !modAdmin) {
    return (
      <View style={postStyles.quote}>
        <Text style={S.small}>{tr('mod.hiddenNote')}</Text>
      </View>
    );
  }
  const authorLabel = author
    ? '@' + author
    : tr('tl.unknownName') + post.senderId.toString();
  return (
    <Pressable
      style={postStyles.quote}
      onPress={author ? () => onOpenProfile(author) : undefined}
    >
      {targetHidden ? (
        <Text style={postStyles.modBadgeText}>
          {tr('mod.hiddenBadge')}
        </Text>
      ) : null}
      {targetSanction ? (
        <SanctionBadge kind={targetSanction.kind} />
      ) : null}
      <View style={S.row}>
        <Avatar nameId={post.senderId} size={20} />
        <Text style={[postStyles.quoteName, { marginStart: 6 }]}>
          {authorLabel}
        </Text>
        <Text style={S.tiny}>
          {'  ·  '}
          {formatTime(post.ts, lang)}
        </Text>
      </View>
      <LinkifiedText
        text={post.text}
        style={postStyles.quoteText}
        numberOfLines={4}
        onMention={onOpenProfile}
      />
    </Pressable>
  );
}

/**
 * A resolved original post inside a quote frame — used by quote
 * Recaws (their embedded original) and by the composer (the post
 * being quoted/replied to). Text shown is the display body
 * (any parent-reference marker line hidden).
 */
export function QuotedPostFrame({
  post,
  lang,
  onOpenProfile,
  onOpenPost,
  modHidden,
  modSanction,
}: {
  post: TimelineItem;
  lang: string;
  onOpenProfile: (username: string) => void;
  onOpenPost?: (item: TimelineItem) => void;
  /** Moderation (v0.7.6): the quoted post is on the hidden
   *  list and the viewer is an admin — badge it. */
  modHidden?: boolean;
  /** Sanctions (v0.7.9): the quoted post's author is
   *  sanctioned and the viewer is an admin — badge it. */
  modSanction?: 'freeze' | 'ban' | null;
}) {
  const [author, setAuthor] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    resolveName(post.senderId).then((n) => live && setAuthor(n));
    return () => {
      live = false;
    };
  }, [post.senderId]);
  const authorLabel = author
    ? '@' + author
    : tr('tl.unknownName') + post.senderId.toString();
  return (
    <Pressable
      style={postStyles.quote}
      onPress={
        onOpenPost
          ? () => onOpenPost(post)
          : author
            ? () => onOpenProfile(author)
            : undefined
      }
    >
      {modHidden ? (
        <Text style={postStyles.modBadgeText}>
          {tr('mod.hiddenBadge')}
        </Text>
      ) : null}
      {modSanction ? <SanctionBadge kind={modSanction} /> : null}
      <View style={S.row}>
        <Avatar nameId={post.senderId} size={20} />
        <Text style={[postStyles.quoteName, { marginStart: 6 }]}>
          {authorLabel}
        </Text>
        <Text style={S.tiny}>
          {'  ·  '}
          {formatTime(post.ts, lang)}
        </Text>
      </View>
      <LinkifiedText
        text={displayTextOf(post.text)}
        style={postStyles.quoteText}
        numberOfLines={4}
        onMention={onOpenProfile}
      />
    </Pressable>
  );
}

/**
 * The original post referenced by cawId (a quote Recaw's parent),
 * resolved from the feed index. While the lookup runs a plain
 * loading frame shows; when the original cannot be found the
 * frame says so honestly instead of inventing content.
 */
export function OriginalFrame({
  cawId,
  lang,
  onOpenProfile,
  onOpenPost,
  modAdmin,
  modHiddenFor,
  modSanctionFor,
}: {
  cawId: string;
  lang: string;
  onOpenProfile: (username: string) => void;
  onOpenPost?: (item: TimelineItem) => void;
  /** Moderation (v0.7.6): a hidden original is not quoted
   *  for non-admins; admins see it badged. */
  modAdmin?: boolean;
  modHiddenFor?: (cawId: string) => boolean;
  /** Sanctions (v0.7.9): same treatment when the original's
   *  AUTHOR is sanctioned. */
  modSanctionFor?: (senderId: bigint) => SanctionEntry | null;
}) {
  const [post, setPost] = useState<TimelineItem | null | undefined>(
    undefined,
  );
  useEffect(() => {
    let live = true;
    findPostByCawId(cawId)
      .then((p) => live && setPost(p))
      .catch(() => live && setPost(null));
    return () => {
      live = false;
    };
  }, [cawId]);
  if (post === undefined) {
    return (
      <View style={postStyles.quote}>
        <Text style={S.small}>{tr('tl.loading')}</Text>
      </View>
    );
  }
  if (!post) {
    return (
      <View style={postStyles.quote}>
        <Text style={S.small}>{tr('tl.originalMissing')}</Text>
      </View>
    );
  }
  const origHidden = !!(modHiddenFor && modHiddenFor(post.cawId));
  const origSanction = modSanctionFor
    ? modSanctionFor(post.senderId)
    : null;
  if ((origHidden || origSanction) && !modAdmin) {
    return (
      <View style={postStyles.quote}>
        <Text style={S.small}>{tr('mod.hiddenNote')}</Text>
      </View>
    );
  }
  return (
    <QuotedPostFrame
      post={post}
      lang={lang}
      onOpenProfile={onOpenProfile}
      onOpenPost={onOpenPost}
      modHidden={origHidden}
      modSanction={origSanction ? origSanction.kind : null}
    />
  );
}

/**
 * Post body text with tappable links (v0.6.5): URL segments
 * render in the accent colour and open the URL on tap; every
 * other segment is plain text. With no URL in the text this is
 * exactly the plain <Text> it replaces.
 *
 * v0.7.0 adds @mentions: an @name segment renders in the
 * accent colour too and, when the caller passes onMention,
 * opens that name's profile on tap. Without a handler the
 * mention is plain text — never a dead link. (Mentions are a
 * display affordance only: no notification is sent — the
 * standing QL1 decision omits notifications.)
 */
export function LinkifiedText({
  text,
  style,
  numberOfLines,
  onMention,
}: {
  text: string;
  style?: React.ComponentProps<typeof Text>['style'];
  numberOfLines?: number;
  onMention?: (username: string) => void;
}) {
  const segments = splitRichSegments(text);
  if (!segments.some((s) => s.url || (s.mention && onMention))) {
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {text}
      </Text>
    );
  }
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {segments.map((s, i) =>
        s.url ? (
          <Text
            key={i}
            style={{ color: ACCENT }}
            onPress={() => Linking.openURL(s.url as string)}
          >
            {s.text}
          </Text>
        ) : s.mention && onMention ? (
          <Text
            key={i}
            style={{ color: ACCENT }}
            onPress={() => onMention(s.mention as string)}
          >
            {s.text}
          </Text>
        ) : (
          <Text key={i}>{s.text}</Text>
        ),
      )}
    </Text>
  );
}

/**
 * The link snippet card under a post (v0.6.5): the preview of
 * the post body's FIRST URL, served by the cawl Worker — image,
 * title and description exactly as found on the target page,
 * plus the domain of the resolved destination (for our short
 * links, the original site's domain, never the shortener's).
 * While the preview loads, and whenever it is unavailable,
 * NOTHING renders — no placeholder, no fabricated data; the
 * tappable link in the body text remains either way. Tapping
 * the card opens the resolved (original) URL.
 */
/**
 * A post's attached images (v0.7.3, media server): one image
 * spans the column; two or more tile in a 2-up grid. The URLs
 * are the server's content-addressed media URLs — plain remote
 * images, so a dead media server just leaves broken-image
 * placeholders out entirely (the grid only renders when the
 * lookup already returned entries).
 */
export function PostMediaGrid({
  items,
  hiddenHashes,
  onMod,
}: {
  items: PostAttachment[];
  /** Moderation (v0.7.6, admins only): hashes of this post's
   *  server-hidden attachments — rendered as placeholder
   *  tiles, never as images. */
  hiddenHashes?: string[];
  /** Admin attachment ops: (hash, attachment-or-null, verb).
   *  Visible attachments pass themselves; placeholders pass
   *  null. Without a handler no controls render. */
  onMod?: (
    hash: string,
    att: PostAttachment | null,
    verb: 'hide' | 'unhide' | 'delete',
  ) => void;
}) {
  const shown = items.slice(0, 4);
  const hidden = (hiddenHashes ?? []).slice(0, 4);
  if (shown.length === 0 && hidden.length === 0) return null;
  const total = shown.length + hidden.length;
  const placeholder = (hash: string, single: boolean) => (
    <View
      key={'hidden-' + hash}
      style={
        single ? postStyles.mediaHiddenSingle : postStyles.mediaHiddenCell
      }
    >
      <Text style={postStyles.mediaHiddenText}>
        {tr('mod.attHidden')}
      </Text>
    </View>
  );
  const grid =
    total === 1 ? (
      <View style={postStyles.mediaGrid}>
        {shown.length === 1 ? (
          <Image
            source={{ uri: shown[0].url }}
            style={postStyles.mediaSingle}
            resizeMode="cover"
          />
        ) : (
          placeholder(hidden[0], true)
        )}
      </View>
    ) : (
      <View style={postStyles.mediaGrid}>
        <View style={postStyles.mediaRowWrap}>
          {shown.map((m) => (
            <Image
              key={m.url}
              source={{ uri: m.url }}
              style={postStyles.mediaCell}
              resizeMode="cover"
            />
          ))}
          {hidden.map((h) => placeholder(h, false))}
        </View>
      </View>
    );
  if (!onMod) return grid;
  /* Admin controls (v0.7.6): one compact row per attachment —
   * Hide / Delete for a visible image, Unhide / Delete for a
   * hidden one. The ops themselves (confirm + signing) live
   * in the screens; the grid only reports the intent. */
  return (
    <View>
      {grid}
      {shown.map((m) => {
        const hash = hashFromMediaUrl(m.url);
        if (!hash) return null;
        return (
          <View key={'mod-' + hash} style={postStyles.modAttRow}>
            <Text style={[S.tiny, { flex: 1 }]} numberOfLines={1}>
              {'🖼 ' + hash.slice(0, 10) + '…'}
            </Text>
            <Pressable
              onPress={() => onMod(hash, m, 'hide')}
              hitSlop={6}
            >
              <Text style={postStyles.modBtnText}>
                {tr('mod.hideMediaBtn')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => onMod(hash, m, 'delete')}
              hitSlop={6}
            >
              <Text style={[postStyles.modBtnText, { color: '#b3261e' }]}>
                {tr('mod.deleteBtn')}
              </Text>
            </Pressable>
          </View>
        );
      })}
      {hidden.map((hash) => (
        <View key={'modh-' + hash} style={postStyles.modAttRow}>
          <Text style={[S.tiny, { flex: 1 }]} numberOfLines={1}>
            {'🖼 ' + hash.slice(0, 10) + '… · ' + tr('mod.hiddenBadge')}
          </Text>
          <Pressable onPress={() => onMod(hash, null, 'unhide')} hitSlop={6}>
            <Text style={postStyles.modBtnText}>
              {tr('mod.unhideBtn')}
            </Text>
          </Pressable>
          <Pressable onPress={() => onMod(hash, null, 'delete')} hitSlop={6}>
            <Text style={[postStyles.modBtnText, { color: '#b3261e' }]}>
              {tr('mod.deleteBtn')}
            </Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

export function LinkSnippetCard({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreview | null | undefined>(
    undefined,
  );
  const [imgOk, setImgOk] = useState(true);
  useEffect(() => {
    let live = true;
    setPreview(undefined);
    setImgOk(true);
    fetchPreview(url)
      .then((p) => live && setPreview(p))
      .catch(() => live && setPreview(null));
    return () => {
      live = false;
    };
  }, [url]);
  if (!preview) return null;
  if (!preview.title && !preview.description && !preview.image) {
    return null;
  }
  const openTarget = preview.url || url;
  return (
    <Pressable
      style={postStyles.snippet}
      onPress={() => Linking.openURL(openTarget)}
    >
      {preview.image && imgOk ? (
        <Image
          source={{ uri: preview.image }}
          style={postStyles.snippetImg}
          onError={() => setImgOk(false)}
        />
      ) : null}
      <View style={postStyles.snippetBody}>
        {preview.title ? (
          <Text style={postStyles.snippetTitle} numberOfLines={2}>
            {preview.title}
          </Text>
        ) : null}
        {preview.description ? (
          <Text style={postStyles.snippetDesc} numberOfLines={2}>
            {preview.description}
          </Text>
        ) : null}
        {preview.domain ? (
          <Text style={postStyles.snippetDomain} numberOfLines={1}>
            {preview.domain}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/* ---------- one timeline entry ---------- */
export interface PostCardProps {
  item: TimelineItem;
  lang: string;
  onOpenProfile: (username: string) => void;
  onAction?: (kind: 1 | 2, item: TimelineItem) => void;
  /** Tap on a post's text opens its detail (v0.2.0). */
  onOpenPost?: (item: TimelineItem) => void;
  /** Reply button (v0.4.0): opens the composer targeted at this post. */
  onReply?: (item: TimelineItem) => void;
  /** SuperLike button (v0.4.8; O-burn since v0.5.0).
   *  Without a handler the star count still shows when it is > 0. */
  onSuperlike?: (item: TimelineItem) => void;
  /** Tip button (v0.5.0): send CAT42 to the post's author. */
  onTip?: (item: TimelineItem) => void;
  /** Bookmark toggle (v0.6.0): on-device saved posts. The
   *  state is asked per item (a function, not a flag) so a
   *  recaw's nested original reports its OWN state, not the
   *  recaw row's. Without a handler no toggle renders. */
  onBookmark?: (item: TimelineItem) => void;
  isBookmarked?: (item: TimelineItem) => boolean;
  actionStatus?: string;
  busy?: boolean;
  /** This wallet already liked this post (remembered on the device). */
  liked?: boolean;
  /** This wallet already shared this post. */
  recawed?: boolean;
  /** Sender's on-device custom look (only ever set for my own names). */
  custom?: ProfileCustom | null;
  /** Rendered inside another row (a recaw's embedded original):
   *  no outer padding / border of its own. */
  nested?: boolean;
  /** Moderation (v0.7.6): the viewer is an admin (mod/root) —
   *  hidden posts stay visible to admins, dimmed and badged,
   *  and the moderation controls render. Non-admin lists
   *  filter hidden posts out before render, so for them
   *  these props simply never matter. */
  modAdmin?: boolean;
  /** Is this cawId on the hidden-post list? (per-item function
   *  for the same reason as isBookmarked: a recaw's nested
   *  original reports its OWN state.) */
  modHiddenFor?: (cawId: string) => boolean;
  /** This post's server-hidden attachment hashes (admins). */
  modHiddenAttFor?: (cawId: string) => string[];
  /** Admin Hide/Unhide for the row's OWN post. */
  onModTogglePost?: (item: TimelineItem) => void;
  /** Sanctions (v0.7.9): the active sanction on a name, by
   *  sender id — a sanctioned author's posts stay visible
   *  to admins, dimmed and badged (Frozen / Banned), and
   *  nested frames of their posts are badged too. */
  modSanctionFor?: (senderId: bigint) => SanctionEntry | null;
  /** Admin: lift the sanction on this row's author. */
  onModUnsanction?: (item: TimelineItem) => void;
  /** Admin attachment op for this post. */
  onModAttach?: (
    item: TimelineItem,
    hash: string,
    att: PostAttachment | null,
    verb: 'hide' | 'unhide' | 'delete',
  ) => void;
  /** Bump to refetch this post's attachment list (an admin
   *  delete removed an image server-side; the cached list
   *  would otherwise keep serving it). */
  attTick?: number;
}

/**
 * A plain Recaw (type 2), X-style (v0.4.0): a small header line
 * naming the recawer, and the body is the ORIGINAL post itself,
 * rendered as a normal (nested) post card — its text, author,
 * like count and action row. Tapping the original opens ITS
 * detail. When the original cannot be found in the index, an
 * honest "not found" frame replaces it; content is never faked.
 */
function RecawCard({
  item,
  lang,
  onOpenProfile,
  onAction,
  onOpenPost,
  onReply,
  onSuperlike,
  onTip,
  onBookmark,
  isBookmarked,
  actionStatus,
  busy,
  liked,
  recawed,
  nested,
  modAdmin,
  modHiddenFor,
  modHiddenAttFor,
  onModTogglePost,
  onModAttach,
  modSanctionFor,
  onModUnsanction,
  attTick,
}: PostCardProps) {
  const [name, setName] = useState<string | null>(null);
  const [original, setOriginal] = useState<TimelineItem | null | undefined>(
    undefined,
  );
  /* SuperRecaw detection (v0.5.0): the gold attribution line shows
   * only when the marked-burn index holds an SRC1 burn by THIS
   * recawer's owner for the ORIGINAL post's cawId — chain data
   * only (lib/markedBurns.ts), never a local tally. */
  const [isSuper, setIsSuper] = useState(false);
  const superOwnerRef = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    resolveName(item.senderId).then((n) => live && setName(n));
    return () => {
      live = false;
    };
  }, [item.senderId]);
  useEffect(() => {
    let live = true;
    findPostByCawId(item.cawId)
      .then((p) => live && setOriginal(p))
      .catch(() => live && setOriginal(null));
    return () => {
      live = false;
    };
  }, [item.cawId]);
  useEffect(() => {
    let live = true;
    nameOwner(item.senderId)
      .then((owner) => {
        if (!live) return;
        superOwnerRef.current = owner;
        if (superRecawCachedFor(item.cawId, owner)) setIsSuper(true);
        return hasSuperRecawFor(item.cawId, owner).then((v) => {
          if (live) setIsSuper(v);
        });
      })
      .catch(() => {});
    const unsub = subscribeMarkedBurns(() => {
      const owner = superOwnerRef.current;
      if (owner && superRecawCachedFor(item.cawId, owner)) {
        setIsSuper(true);
      }
    });
    return () => {
      live = false;
      unsub();
    };
  }, [item]);
  const who = name
    ? '@' + name
    : tr('tl.unknownName') + item.senderId.toString();
  /* Moderation (v0.7.6): the recaw's OWN hidden state (the
   * recaw is itself a post on the hidden list) and the
   * original's — for a non-admin the original's content is
   * replaced by the hidden note; admins see it badged via
   * the nested card's own marking. */
  const ownHidden = !!(modHiddenFor && modHiddenFor(item.cawId));
  const origHidden = !!(
    original &&
    modHiddenFor &&
    modHiddenFor(original.cawId)
  );
  /* Sanctions (v0.7.9): the recawer's own sanction badges
   * the row; a sanctioned ORIGINAL author hides the nested
   * post for non-admins, exactly like a hidden original. */
  const ownSanction = modSanctionFor
    ? modSanctionFor(item.senderId)
    : null;
  const origSanction =
    original && modSanctionFor
      ? modSanctionFor(original.senderId)
      : null;
  const row = (
    <>
      <Avatar
        nameId={item.senderId}
        size={44}
        onPress={name ? () => onOpenProfile(name) : undefined}
      />
      <View style={{ flex: 1, marginStart: 10 }}>
        {/* Attribution line. A SuperRecaw renders FLAT like
            every other row (v0.6.1 finish — the v0.5.0 cream
            card, gradient frame and magenta badge stay gone);
            the treatment is this line — a gold star and gold
            text naming the recaw a SuperRecaw, in the same
            slot as the plain recaw line — plus, since v0.6.4,
            the gold row wash on the outer View below. */}
        <View style={S.row}>
          {isSuper ? (
            <StarIcon size={14} color={SUPERLIKE_ON} filled />
          ) : (
            <RepeatIcon size={14} color={RECAW_ON} />
          )}
          <Text
            style={[
              S.tiny,
              { marginStart: 5, fontWeight: '700' },
              isSuper && { color: SUPERLIKE_ON },
            ]}
            numberOfLines={1}
          >
            {tr('tl.recawedBy', { name: who })}
            {isSuper ? ' · ' + tr('tl.superRecaw') : ''}
          </Text>
        </View>
        {ownHidden ? (
          <Text style={postStyles.modBadgeText}>
            {tr('mod.hiddenBadge')}
          </Text>
        ) : null}
        {ownSanction ? <SanctionBadge kind={ownSanction.kind} /> : null}
        {original === undefined ? (
          <View style={postStyles.quote}>
            <Text style={S.small}>{tr('tl.loading')}</Text>
          </View>
        ) : original === null ? (
          <View style={postStyles.quote}>
            <Text style={S.small}>{tr('tl.originalMissing')}</Text>
          </View>
        ) : (origHidden || origSanction) && !modAdmin ? (
          <View style={postStyles.quote}>
            <Text style={S.small}>{tr('mod.hiddenNote')}</Text>
          </View>
        ) : (
          <PostCard
            item={original}
            lang={lang}
            onOpenProfile={onOpenProfile}
            onAction={onAction}
            onOpenPost={onOpenPost}
            onReply={onReply}
            onSuperlike={onSuperlike}
            onTip={onTip}
            onBookmark={onBookmark}
            isBookmarked={isBookmarked}
            busy={busy}
            liked={liked}
            recawed={recawed}
            nested
            modAdmin={modAdmin}
            modHiddenFor={modHiddenFor}
            modHiddenAttFor={modHiddenAttFor}
            onModTogglePost={onModTogglePost}
            onModAttach={onModAttach}
            modSanctionFor={modSanctionFor}
            onModUnsanction={onModUnsanction}
            attTick={attTick}
          />
        )}
        <View style={[S.row, { marginTop: 8 }]}>
          <Pressable onPress={() => Linking.openURL(txUrl(item.hash))}>
            <Text style={[S.tiny, { color: ACCENT }]}>
              {tr('tl.viewTx')} ↗
            </Text>
          </Pressable>
        </View>
        {/* The recaw's OWN moderation toggle (v0.7.6): it
            hides the recaw post itself, never the original.
            The sanction lift (v0.7.9) sits beside it — it
            acts on the recaw's AUTHOR, not the post. */}
        {modAdmin &&
        !nested &&
        (onModTogglePost || (ownSanction && onModUnsanction)) ? (
          <View style={[S.row, { marginTop: 6, gap: 16 }]}>
            {onModTogglePost ? (
              <Pressable
                onPress={() => onModTogglePost(item)}
                hitSlop={6}
              >
                <Text style={postStyles.modBtnText}>
                  {ownHidden ? tr('mod.unhideBtn') : tr('mod.hideBtn')}
                </Text>
              </Pressable>
            ) : null}
            {ownSanction && onModUnsanction ? (
              <Pressable
                onPress={() => onModUnsanction(item)}
                hitSlop={6}
              >
                <Text style={postStyles.modBtnText}>
                  {tr('sanct.liftBtn')}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {actionStatus ? (
          <Text style={[S.tiny, { marginTop: 4 }]}>{actionStatus}</Text>
        ) : null}
      </View>
    </>
  );
  /* SuperRecaws take the same FLAT row as plain recaws
   * (v0.6.1: no frame, no badge, no rounded card) — but
   * since v0.6.4 the row itself glows: while `isSuper` is
   * true (chain detection only, incl. the cached fast path —
   * never as a loading placeholder) the whole row carries
   * the soft gold wash, so a SuperRecaw is visibly LIT at a
   * glance, which the attribution line alone never achieved
   * (v0.6.3 on-device check: 「光ってない」). Plain recaws
   * stay untinted; the nested original shows through the
   * wash via its transparent surface. */
  return (
    <View
      style={[
        nested ? postStyles.postNested : postStyles.post,
        isSuper && { backgroundColor: SUPER_RECAW_WASH },
        (ownHidden || ownSanction) && { opacity: 0.55 },
      ]}
    >
      {row}
    </View>
  );
}

function PostCardBase({
  item,
  lang,
  onOpenProfile,
  onAction,
  onOpenPost,
  onReply,
  onSuperlike,
  onTip,
  onBookmark,
  isBookmarked,
  actionStatus,
  busy,
  liked,
  recawed,
  custom,
  nested,
  modAdmin,
  modHiddenFor,
  modHiddenAttFor,
  onModTogglePost,
  onModAttach,
  modSanctionFor,
  onModUnsanction,
  attTick,
}: PostCardProps) {
  const [name, setName] = useState<string | null>(null);
  const [targetName, setTargetName] = useState<string | null>(null);
  const [likes, setLikes] = useState<bigint | null>(null);
  /* Reply state (v0.4.0): the count comes from the reference
   * index (posts seen carrying this post's cawId in a reply
   * marker); the reply-to line names the parent post's author. */
  const [replyCount, setReplyCount] = useState(0);
  const [replyToName, setReplyToName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    resolveName(item.senderId).then((n) => live && setName(n));
    if (item.type !== 0 && item.receiverId > 0n) {
      resolveName(item.receiverId).then((n) => live && setTargetName(n));
    }
    if (item.type === 0) {
      likesCount(item)
        .then((v) => live && setLikes(v))
        .catch(() => {});
      setReplyCount(knownReplyCount(item.cawId));
      const ref = parsePostText(item.text).ref;
      if (ref && ref.kind === 'reply') {
        findPostByCawId(ref.parentCawId)
          .then((p) => {
            if (live && p) {
              resolveName(p.senderId).then(
                (n) => live && setReplyToName(n),
              );
            }
          })
          .catch(() => {});
      }
    }
    return () => {
      live = false;
    };
  }, [item]);
  /* SuperLike count (v0.4.8; O-burn index since v0.5.0):
   * counted from marked O burns on QL1 (lib/markedBurns.ts) —
   * chain data only, never a local tally. The burn's recipient
   * is the burn address for everyone, so the count is keyed by
   * the post alone; no author lookup is needed. null = not
   * loaded yet. */
  const [slCount, setSlCount] = useState<number | null>(null);
  useEffect(() => {
    if (item.type !== 0) return;
    let live = true;
    setSlCount(superlikeCountCached(item.cawId));
    superlikeCount(item.cawId)
      .then((n) => {
        if (live) setSlCount(n);
      })
      .catch(() => {});
    const unsub = subscribeSuperlike(() => {
      if (live) setSlCount(superlikeCountCached(item.cawId));
    });
    return () => {
      live = false;
      unsub();
    };
  }, [item]);
  /* Recaw count (v0.6.0): the same "indexed so far" semantics
   * as the reply count (knownRecawCount in cawApi.ts) — the
   * row snapshot plus my own recaw flip below. The detail
   * screen's reaction list stays the complete count. */
  const [recawCount, setRecawCount] = useState(0);
  useEffect(() => {
    if (item.type === 0) setRecawCount(knownRecawCount(item.cawId));
  }, [item]);
  const prevRecawed = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevRecawed.current === null) {
      prevRecawed.current = !!recawed;
      return;
    }
    if (!!recawed !== prevRecawed.current) {
      prevRecawed.current = !!recawed;
      setRecawCount((c) => Math.max(0, c + (recawed ? 1 : -1)));
    }
  }, [recawed]);
  /* View count (v0.6.0): only when the counter endpoint is
   * configured (lib/views.ts) — the row registers its own
   * view as it renders and shows the count once the counter
   * has answered. With no endpoint this is all inert and the
   * action row renders no views element at all. */
  const [viewCount, setViewCount] = useState<number | null>(null);
  useEffect(() => {
    if (!VIEWS_ENABLED || item.type !== 0) return;
    let live = true;
    registerView(item.cawId);
    setViewCount(viewCountCached(item.cawId));
    const unsub = subscribeViews(() => {
      if (live) setViewCount(viewCountCached(item.cawId));
    });
    return () => {
      live = false;
      unsub();
    };
  }, [item]);
  /* Post image attachments (v0.7.3, media server): looked up
   * through lib/mediaApi, which coalesces every card mounted in
   * the same render pass into ONE batch GET. An empty result —
   * no attachments, or the server unreachable — renders nothing;
   * the post itself never depends on the media server. */
  const [attachments, setAttachments] = useState<PostAttachment[]>([]);
  useEffect(() => {
    if (item.type !== 0) return;
    let live = true;
    attachmentLookup(item.cawId).then(
      (list) => live && setAttachments(list),
    );
    return () => {
      live = false;
    };
  }, [item, attTick]);
  /* Moderation (v0.7.6): this post's own hidden state, and
   * its hidden attachments (admins only — non-admin lists
   * never pass these props, and the server already omits
   * hidden attachments from their reads). A locally cached
   * attachment list can still contain an image hidden since
   * (this session's own hide, before any refetch) — those
   * are filtered out here and shown as placeholders. */
  const ownHidden = !!(modHiddenFor && modHiddenFor(item.cawId));
  /* Sanctions (v0.7.9): the AUTHOR's active sanction — the
   * card dims and badges like a hidden post (admins only;
   * non-admin lists filter sanctioned authors out). */
  const ownSanction = modSanctionFor
    ? modSanctionFor(item.senderId)
    : null;
  const hiddenAttHashes =
    modAdmin && modHiddenAttFor ? modHiddenAttFor(item.cawId) : [];
  const visibleAttachments = hiddenAttHashes.length
    ? attachments.filter((a) => {
        const h = hashFromMediaUrl(a.url);
        return !h || !hiddenAttHashes.includes(h);
      })
    : attachments;
  const bookmarked = isBookmarked ? isBookmarked(item) : false;
  // Keep the shown like count in step with my own like: +1 the moment
  // it lights up (the chain read above was taken before my like), back
  // down if the like is undone. On a fresh mount nothing changes — the
  // chain count already includes my earlier like.
  const prevLiked = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevLiked.current === null) {
      prevLiked.current = !!liked;
      return;
    }
    if (!!liked !== prevLiked.current) {
      prevLiked.current = !!liked;
      setLikes((l) => (l === null ? l : l + (liked ? 1n : -1n)));
    }
  }, [liked]);
  const who = name ? '@' + name : tr('tl.unknownName') + item.senderId.toString();
  const displayName = custom && custom.displayName ? custom.displayName : null;
  const ctxTpl =
    item.type === 1
      ? tr('tl.ctxLike')
      : item.type === 2
        ? tr('tl.ctxRecaw')
        : item.type === 3
          ? tr('tl.ctxFollow')
          : item.type === 4
            ? tr('tl.ctxUnfollow')
            : null;
  const targetLabel = targetName
    ? '@' + targetName
    : tr('tl.unknownName') + item.receiverId.toString();
  /* (v0.6.0: the likes count now lives inside the Like button
   * in the action row below — X style — so there is no
   * separate count chip anymore.) */
  /* A plain Recaw renders as its own X-style row (header + the
   * original post as the body) — see RecawCard above. */
  if (item.type === 2) {
    return (
      <RecawCard
        item={item}
        lang={lang}
        onOpenProfile={onOpenProfile}
        onAction={onAction}
        onOpenPost={onOpenPost}
        onReply={onReply}
        onSuperlike={onSuperlike}
        onTip={onTip}
        onBookmark={onBookmark}
        isBookmarked={isBookmarked}
        actionStatus={actionStatus}
        busy={busy}
        liked={liked}
        recawed={recawed}
        nested={nested}
        modAdmin={modAdmin}
        modHiddenFor={modHiddenFor}
        modHiddenAttFor={modHiddenAttFor}
        onModTogglePost={onModTogglePost}
        onModAttach={onModAttach}
        modSanctionFor={modSanctionFor}
        onModUnsanction={onModUnsanction}
        attTick={attTick}
      />
    );
  }
  /* Posts: the display body hides the parent-reference marker
   * line (replies / quote Recaws, lib/postRef.ts). */
  const parsed = item.type === 0 ? parsePostText(item.text) : null;
  const bodyText = parsed ? parsed.body : item.text;
  /* Link snippet (v0.6.5): the body's first URL gets a preview
   * card under the text (LinkSnippetCard) — the URL itself also
   * renders as a tappable link inside the body (LinkifiedText). */
  const firstUrl =
    item.type === 0 && bodyText ? (extractUrls(bodyText)[0] ?? null) : null;
  /* Share (v0.6.4; link-only since v0.6.7): the OS share
   * sheet carrying ONLY a link — the post's page on the
   * community web viewer (the viewer's ?post=<cawId> page,
   * following the app's language), shortened through cawl
   * (lib/share.ts resolves the one URL; lib/linkify.ts talks
   * to the shortener). If shortening fails the full viewer
   * URL is shared; a post without a well-formed cawId links
   * the viewer's top page — a post link is never fabricated,
   * and no text is shared anymore. The explorer record link
   * stays the separate in-app row below. Read-only: no
   * signing, no chain. In a recaw row this button renders on
   * the nested ORIGINAL post, so it shares the original's
   * link — the same target as the row's other actions. */
  const onSharePost = async () => {
    const message = await resolveShareUrl(item.cawId, lang, shortenUrl);
    Share.share({ message }).catch(() => {});
  };
  return (
    <View
      style={[
        nested ? postStyles.postNested : postStyles.post,
        (ownHidden || ownSanction) && { opacity: 0.55 },
      ]}
    >
      <Avatar
        nameId={item.senderId}
        size={44}
        customUri={custom ? custom.avatarPath : undefined}
        onPress={name ? () => onOpenProfile(name) : undefined}
      />
      <View style={{ flex: 1, marginStart: 10 }}>
        {ctxTpl && item.receiverId > 0n ? (
          <Text style={S.tiny}>{ctxTpl.replace('{name}', targetLabel)}</Text>
        ) : null}
        {/* X-style header (v0.6.0): the display name stands
            alone on line 1; line 2 is @handle · relative time
            (compact 2m / 5h, falling back to the full date for
            posts a week old or more). */}
        <Pressable onPress={name ? () => onOpenProfile(name) : undefined}>
          <Text style={postStyles.name} numberOfLines={1}>
            {displayName || who}
          </Text>
        </Pressable>
        <Text style={S.tiny} numberOfLines={1}>
          {displayName ? who + '  ·  ' : ''}
          {formatRelativeTime(item.ts, lang)}
        </Text>
        {ownHidden ? (
          <Text style={postStyles.modBadgeText}>
            {tr('mod.hiddenBadge')}
          </Text>
        ) : null}
        {ownSanction ? <SanctionBadge kind={ownSanction.kind} /> : null}
        {parsed?.ref?.kind === 'reply' && replyToName ? (
          <Text style={S.tiny}>
            {tr('tl.replyTo', { name: '@' + replyToName })}
          </Text>
        ) : null}
        {item.type === 0 && bodyText ? (
          onOpenPost ? (
            <Pressable onPress={() => onOpenPost(item)}>
              <LinkifiedText
                text={bodyText}
                style={postStyles.text}
                onMention={onOpenProfile}
              />
            </Pressable>
          ) : (
            <LinkifiedText
              text={bodyText}
              style={postStyles.text}
              onMention={onOpenProfile}
            />
          )
        ) : null}
        {firstUrl ? <LinkSnippetCard url={firstUrl} /> : null}
        {item.type === 0 &&
        (visibleAttachments.length > 0 || hiddenAttHashes.length > 0) ? (
          <PostMediaGrid
            items={visibleAttachments}
            hiddenHashes={hiddenAttHashes}
            onMod={
              modAdmin && onModAttach
                ? (hash, att, verb) => onModAttach(item, hash, att, verb)
                : undefined
            }
          />
        ) : null}
        {parsed?.ref?.kind === 'quote' ? (
          <OriginalFrame
            cawId={parsed.ref.parentCawId}
            lang={lang}
            onOpenProfile={onOpenProfile}
            onOpenPost={onOpenPost}
            modAdmin={modAdmin}
            modHiddenFor={modHiddenFor}
            modSanctionFor={modSanctionFor}
          />
        ) : null}
        {item.type === 1 ? (
          <TargetPostQuote
            item={item}
            lang={lang}
            onOpenProfile={onOpenProfile}
            modAdmin={modAdmin}
            modHiddenFor={modHiddenFor}
            modSanctionFor={modSanctionFor}
          />
        ) : null}
        {/* X-style action row (v0.6.0): icon + count, no word
            labels except Tip — Reply / Recaw / Like / Views /
            SuperLike (gold star) / Tip / Bookmark / Share
            (v0.6.4, icon-only, at the end — X's position). Every
            handler, menu and sheet behind these buttons is
            the pre-overhaul one; only the buttons moved. Views
            renders only when the counter is configured AND has
            answered (lib/views.ts — absent, never a fake 0).
            v0.6.1 finish: the row NEVER wraps (the v0.6.0
            flexWrap let it spill to a second line at 360dp) —
            it is a single space-between line with compact
            counts (formatViewCount: 285 / 1.2K), and the
            record link moved OUT of the row to its own line
            below (exactly one per post — see under the row). */}
        {item.type === 0 ? (
        <View style={postStyles.actionRow}>
          {item.type === 0 && (onReply || replyCount > 0) ? (
            <Pressable
              disabled={!onReply}
              onPress={onReply ? () => onReply(item) : undefined}
              style={({ pressed }) => [
                S.row,
                postStyles.actionBtn,
                pressed && postStyles.actionBtnOn,
              ]}
            >
              <ReplyIcon size={16} color="#536471" />
              <Text style={[S.tiny, { marginStart: 4 }]}>
                {replyCount > 0 ? formatViewCount(replyCount) : ''}
              </Text>
            </Pressable>
          ) : null}
          {item.type === 0 && (onAction || recawCount > 0) ? (
            <Pressable
              disabled={!onAction || busy}
              onPress={onAction ? () => onAction(2, item) : undefined}
              style={({ pressed }) => [
                S.row,
                postStyles.actionBtn,
                busy && S.disabled,
                pressed && postStyles.actionBtnOn,
              ]}
            >
              <RepeatIcon size={16} color={recawed ? RECAW_ON : '#536471'} />
              <Text
                style={[
                  S.tiny,
                  { marginStart: 4 },
                  recawed && { color: RECAW_ON, fontWeight: '700' },
                ]}
              >
                {recawCount > 0 ? formatViewCount(recawCount) : ''}
              </Text>
            </Pressable>
          ) : null}
          {item.type === 0 &&
          (onAction || (likes !== null && likes > 0n) || liked) ? (
            <Pressable
              disabled={!onAction || busy}
              onPress={onAction ? () => onAction(1, item) : undefined}
              style={({ pressed }) => [
                S.row,
                postStyles.actionBtn,
                busy && S.disabled,
                pressed && postStyles.actionBtnOn,
              ]}
            >
              <HeartIcon size={16} color={liked ? LIKE_ON : '#536471'} filled={!!liked} />
              <Text
                style={[
                  S.tiny,
                  { marginStart: 4 },
                  liked && { color: LIKE_ON, fontWeight: '700' },
                ]}
              >
                {likes !== null ? formatViewCount(Number(likes)) : liked ? '1' : ''}
              </Text>
            </Pressable>
          ) : null}
          {item.type === 0 && VIEWS_ENABLED && viewCount !== null ? (
            <View style={S.row}>
              <ViewsIcon size={16} color="#536471" />
              <Text style={[S.tiny, { marginStart: 4 }]}>
                {formatViewCount(viewCount)}
              </Text>
            </View>
          ) : null}
          {item.type === 0 &&
          (onSuperlike || (slCount !== null && slCount > 0)) ? (
            <Pressable
              disabled={!onSuperlike || busy}
              onPress={onSuperlike ? () => onSuperlike(item) : undefined}
              style={({ pressed }) => [
                S.row,
                postStyles.actionBtn,
                busy && S.disabled,
                pressed && postStyles.actionBtnOn,
              ]}
            >
              <StarIcon
                size={16}
                color={slCount ? SUPERLIKE_ON : '#536471'}
                filled={!!slCount}
              />
              <Text
                style={[
                  S.tiny,
                  { marginStart: 4 },
                  slCount
                    ? { color: SUPERLIKE_ON, fontWeight: '700' }
                    : null,
                ]}
              >
                {slCount !== null && slCount > 0 ? formatViewCount(slCount) : ''}
              </Text>
            </Pressable>
          ) : null}
          {item.type === 0 && onTip ? (
            <Pressable
              disabled={busy}
              onPress={() => onTip(item)}
              style={({ pressed }) => [
                S.row,
                postStyles.actionBtn,
                busy && S.disabled,
                pressed && postStyles.actionBtnOn,
              ]}
            >
              <TipIcon size={16} />
              <Text style={[S.tiny, { marginStart: 4 }]}>
                {tr('tl.tip')}
              </Text>
            </Pressable>
          ) : null}
          {item.type === 0 && onBookmark ? (
            <Pressable
              disabled={busy}
              onPress={() => onBookmark(item)}
              accessibilityLabel={bookmarked ? tr('bm.remove') : tr('bm.add')}
              style={({ pressed }) => [
                S.row,
                postStyles.actionBtn,
                busy && S.disabled,
                pressed && postStyles.actionBtnOn,
              ]}
            >
              <BookmarkIcon
                size={16}
                color={bookmarked ? ACCENT : '#536471'}
                filled={bookmarked}
              />
            </Pressable>
          ) : null}
          {item.type === 0 ? (
            <Pressable
              onPress={onSharePost}
              accessibilityLabel={tr('tl.share')}
              style={({ pressed }) => [
                S.row,
                postStyles.actionBtn,
                pressed && postStyles.actionBtnOn,
              ]}
            >
              <ShareIcon size={16} color="#536471" />
            </Pressable>
          ) : null}
        </View>
        ) : null}
        {/* The ONE record link per post (v0.6.1): through
            v0.6.0 a row could show two — this link inside the
            action row (the post's own tx) plus the recaw
            wrapper's link below a nested original. Now the
            action row carries no link at all; each top-level
            row renders exactly one, here, in the same spot
            for plain posts and (via RecawCard's own copy)
            for recaws. Nested rows render none — the outer
            row's link is the one. */}
        {!nested ? (
          <View style={[S.row, { marginTop: 6 }]}>
            <Pressable
              onPress={() => Linking.openURL(txUrl(item.hash))}
              hitSlop={6}
            >
              <Text style={[S.tiny, { color: ACCENT }]}>
                {tr('tl.viewTx')} ↗
              </Text>
            </Pressable>
          </View>
        ) : null}
        {/* Admin Hide/Unhide for THIS post (v0.7.6): the web
            viewer's "mod-row" position, under the record
            link. The confirm sheet (with the on-chain
            honesty copy) lives in the screens. The sanction
            lift (v0.7.9) sits beside it — it acts on the
            post's AUTHOR, not the post. */}
        {modAdmin &&
        item.type === 0 &&
        !nested &&
        (onModTogglePost || (ownSanction && onModUnsanction)) ? (
          <View style={[S.row, { marginTop: 6, gap: 16 }]}>
            {onModTogglePost ? (
              <Pressable
                onPress={() => onModTogglePost(item)}
                hitSlop={6}
              >
                <Text style={postStyles.modBtnText}>
                  {ownHidden ? tr('mod.unhideBtn') : tr('mod.hideBtn')}
                </Text>
              </Pressable>
            ) : null}
            {ownSanction && onModUnsanction ? (
              <Pressable
                onPress={() => onModUnsanction(item)}
                hitSlop={6}
              >
                <Text style={postStyles.modBtnText}>
                  {tr('sanct.liftBtn')}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {actionStatus ? (
          <Text style={[S.tiny, { marginTop: 4 }]}>{actionStatus}</Text>
        ) : null}
      </View>
    </View>
  );
}

/** Memoized row: with stable callbacks from the lists, a row only
 *  re-renders when its own item or its like/share state changes. */
export const PostCard = React.memo(PostCardBase);

/**
 * One name as a tappable row (avatar + @name + #id) — used by the
 * post detail's liked-by / shared-by lists and the reactions
 * inbox. The label comes from the name's card, like everywhere
 * else; a name that cannot be resolved shows as #id only.
 */
export function NameRow({
  nameId,
  onOpenProfile,
  right,
}: {
  nameId: bigint;
  onOpenProfile: (username: string) => void;
  right?: React.ReactNode;
}) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    resolveName(nameId)
      .then((n) => live && setLabel(n))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [nameId]);
  return (
    <Pressable
      style={({ pressed }) => [
        postStyles.nameRow,
        pressed && { backgroundColor: '#f7f9f9' },
      ]}
      onPress={label ? () => onOpenProfile(label) : undefined}
    >
      <Avatar nameId={nameId} size={40} />
      <View style={{ flex: 1, marginStart: 10 }}>
        <Text style={postStyles.name}>
          {label ? '@' + label : tr('tl.unknownName') + nameId.toString()}
        </Text>
        <Text style={S.tiny}>#{nameId.toString()}</Text>
      </View>
      {right ?? null}
    </Pressable>
  );
}

const postStyles = StyleSheet.create({
  post: {
    flexDirection: 'row',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: HAIRLINE,
    backgroundColor: '#fff',
  },
  /* A post embedded inside a recaw row: same row layout, but the
   * outer row owns the padding and the separator. */
  postNested: {
    flexDirection: 'row',
    paddingTop: 6,
    backgroundColor: 'transparent',
  },
  name: { fontSize: 15, fontWeight: '700', color: '#0f1419' },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: HAIRLINE,
    backgroundColor: '#fff',
  },
  text: { fontSize: 15, color: '#0f1419', lineHeight: 22, marginTop: 2 },
  quote: {
    borderWidth: 1,
    borderColor: '#cfd9de',
    borderRadius: 12,
    padding: 10,
    marginTop: 8,
  },
  quoteName: { fontSize: 13.5, fontWeight: '700', color: '#0f1419' },
  quoteText: { fontSize: 14, color: '#0f1419', lineHeight: 20, marginTop: 4 },
  /* Link snippet card (v0.6.5): the quote frame's hairline
   * shell, with the preview image as a top band when the page
   * provides one. No labels inside — image, title, description
   * and the resolved domain speak for themselves. */
  snippet: {
    borderWidth: 1,
    borderColor: '#cfd9de',
    borderRadius: 12,
    marginTop: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  snippetImg: { width: '100%', height: 150, backgroundColor: '#f7f9f9' },
  snippetBody: { padding: 10 },
  snippetTitle: { fontSize: 14.5, fontWeight: '700', color: '#0f1419' },
  snippetDesc: { fontSize: 13.5, color: '#536471', lineHeight: 19, marginTop: 3 },
  snippetDomain: { fontSize: 12.5, color: '#536471', marginTop: 5 },
  /* Attached images (v0.7.3): a rounded block under the text —
   * one wide image, or a 2-up tile grid for 2–4 images. */
  mediaGrid: { marginTop: 8, borderRadius: 12, overflow: 'hidden' },
  mediaSingle: { width: '100%', height: 210, backgroundColor: '#f7f9f9' },
  mediaRowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 3 },
  mediaCell: {
    width: '49.4%',
    height: 130,
    backgroundColor: '#f7f9f9',
  },
  /* Moderation (v0.7.6): a hidden attachment's placeholder
   * tile — the image itself is never rendered for anyone
   * while it is on the hidden list; admins get the tile plus
   * the Unhide / Delete row under the grid. */
  mediaHiddenSingle: {
    width: '100%',
    height: 210,
    backgroundColor: '#263238',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaHiddenCell: {
    width: '49.4%',
    height: 130,
    backgroundColor: '#263238',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaHiddenText: { fontSize: 13, color: '#cfd8dc', fontWeight: '700' },
  /* The "Hidden" badge line on a post / frame an admin is
   * still shown, and the small text buttons of the
   * moderation rows (post toggle + per-attachment ops). */
  modBadgeText: {
    fontSize: 11.5,
    fontWeight: '800',
    color: '#b3261e',
    marginTop: 2,
  },
  modBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: ACCENT,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  modAttRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  /* The action row (v0.6.1): ONE line, always — space-between
   * across the content column, no wrap, compact counts. At
   * 360dp the column is ~274dp wide. v0.6.4 adds the EIGHTH
   * element (Share, icon-only like Bookmark, at the row's
   * end); the button padding tightened 5 → 4 to hold the
   * line: eight buttons at these metrics (16px icon + up to
   * 5 chars of count, Tip's word label the widest, the two
   * icon-only buttons ~24dp each) still fit the column. */
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  // X-style action buttons: a soft pill highlight while pressed.
  actionBtn: {
    paddingHorizontal: 4,
    paddingVertical: 5,
    marginStart: -5,
    borderRadius: 999,
  },
  actionBtnOn: { backgroundColor: '#f7f9f9' },
  /* (v0.6.1: the SuperRecaw gradient frame / tinted card /
   * badge styles were removed with the flat rendering, and
   * they stay removed. The treatment since v0.6.4 is the
   * gold attribution line plus the gold row wash, applied
   * inline in RecawCard via SUPER_RECAW_WASH — deliberately
   * NOT a style here: the row keeps these flat styles, the
   * wash is a backgroundColor laid over them while isSuper.) */
});

/* ---------- bottom-sheet style confirm dialog ---------- */
export function ConfirmSheet({
  visible,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy,
}: {
  visible: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={sheetStyles.backdrop}>
        {/* v0.1.5: sheets render in a Modal, outside the main
            SafeAreaView — add the device bottom inset under the
            buttons, same pattern as LoadMoreFooter. */}
        <View style={[sheetStyles.sheet, { paddingBottom: 30 + insets.bottom }]}>
          <Text style={S.h2}>{title}</Text>
          {body ? <Text style={[S.body, { marginTop: 8 }]}>{body}</Text> : null}
          <View style={{ height: 16 }} />
          <Pressable
            style={[S.bigBtn, (busy) && S.disabled]}
            disabled={busy}
            onPress={onConfirm}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={S.bigBtnText}>{confirmLabel}</Text>
            )}
          </Pressable>
          <View style={{ height: 10 }} />
          <Pressable style={S.ghostBtn} disabled={busy} onPress={onCancel}>
            <Text style={S.ghostBtnText}>{cancelLabel}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const sheetStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    paddingBottom: 30,
  },
});

/** A raw CAT42 amount as a plain editable decimal string (no
 *  thousands separators — it goes back into a TextInput). */
function plainDecimal(raw: bigint): string {
  const s = raw.toString().padStart(19, '0');
  const whole = s.slice(0, -18);
  const frac = s.slice(-18).replace(/0+$/, '');
  return frac ? whole + '.' + frac : whole;
}

/**
 * Tip sheet (v0.5.0): choose how much CAT42 to send a post's
 * author — a preset (10 / 50 / 100) or a custom amount whose
 * input carries the app's usual 25 / 50 / 75 / MAX balance
 * chips. The sheet owns the amount state; the caller gets one
 * confirmed raw amount and runs the guarded send
 * (lib/actionFlow.ts performTip re-checks everything against
 * fresh reads, including the balance — the figures here are
 * the chooser, not the guard).
 */
export function TipSheet({
  visible,
  authorLabel,
  recipient,
  balanceRaw,
  busy,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  authorLabel: string;
  /**
   * The resolved recipient address (audit M1): a tip is a
   * plain transfer and cannot be recalled, so the sheet
   * SHOWS where the HAWK will actually go — shortened with
   * the last four characters emphasised, the app's usual
   * spot-check shape — instead of only naming the author.
   * Null while unresolved (the line is then omitted; the
   * send itself still re-resolves and cross-checks in
   * performTip before signing).
   */
  recipient?: string | null;
  balanceRaw: bigint | null;
  busy?: boolean;
  onConfirm: (amountRaw: bigint) => void;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [preset, setPreset] = useState<number | null>(TIP_PRESETS[0]);
  const [custom, setCustom] = useState('');
  useEffect(() => {
    if (visible) {
      setPreset(TIP_PRESETS[0]);
      setCustom('');
    }
  }, [visible]);
  const customRaw = custom.trim() ? parseTipAmount(custom) : null;
  const amountRaw =
    preset !== null ? tipPresetRaw(preset) : customRaw;
  const over =
    amountRaw !== null && balanceRaw !== null && amountRaw > balanceRaw;
  const valid = amountRaw !== null && amountRaw > 0n && !over;
  const setChip = (pct: number) => {
    if (balanceRaw === null) return;
    setPreset(null);
    setCustom(plainDecimal(tipChipAmount(balanceRaw, pct)));
  };
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onCancel}
    >
      <View style={sheetStyles.backdrop}>
        <View style={[sheetStyles.sheet, { paddingBottom: 30 + insets.bottom }]}>
          <Text style={S.h2}>{tr('tip.title')}</Text>
          <Text style={[S.body, { marginTop: 8 }]}>
            {tr('tip.body', { name: authorLabel || '—' })}
          </Text>
          {recipient ? (
            <Text style={[S.small, { marginTop: 6 }]}>
              {tr('tip.to')}: {recipient.slice(0, 6)}…
              <Text style={{ fontWeight: '700' }}>
                {recipient.slice(-4)}
              </Text>
            </Text>
          ) : null}
          <Text style={[S.small, { marginTop: 6 }]}>
            {tr('tip.balance', {
              balance:
                balanceRaw !== null ? fmtAmountCard(balanceRaw) : '—',
            })}
          </Text>
          <View style={[S.row, { gap: 8, marginTop: 14 }]}>
            {TIP_PRESETS.map((p) => {
              const on = preset === p;
              return (
                <Pressable
                  key={p}
                  onPress={() => setPreset(p)}
                  style={{
                    flex: 1,
                    borderRadius: 999,
                    paddingVertical: 9,
                    alignItems: 'center',
                    backgroundColor: on ? ACCENT : '#eff3f4',
                  }}
                >
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '700',
                      color: on ? '#fff' : '#0f1419',
                    }}
                  >
                    {p.toLocaleString('en-US')} HAWK
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => setPreset(null)}
              style={{
                flex: 1,
                borderRadius: 999,
                paddingVertical: 9,
                alignItems: 'center',
                backgroundColor: preset === null ? ACCENT : '#eff3f4',
              }}
            >
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: '700',
                  color: preset === null ? '#fff' : '#0f1419',
                }}
              >
                {tr('tip.custom')}
              </Text>
            </Pressable>
          </View>
          {preset === null ? (
            <>
              <TextInput
                style={[S.input, { marginTop: 12 }]}
                value={custom}
                onChangeText={(t) => setCustom(t.replace(/[^0-9.]/g, ''))}
                placeholder="0.0"
                keyboardType="decimal-pad"
              />
              <View style={[S.row, { gap: 8, marginTop: 10 }]}>
                {[25, 50, 75, 100].map((pct) => (
                  <Pressable
                    key={pct}
                    onPress={() => setChip(pct)}
                    style={{
                      flex: 1,
                      backgroundColor: '#eff3f4',
                      borderRadius: 999,
                      paddingVertical: 8,
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 13.5, fontWeight: '600' }}>
                      {pct === 100 ? 'MAX' : pct + '%'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}
          {over ? (
            <Text style={[S.err, { marginTop: 8 }]}>{tr('tip.over')}</Text>
          ) : null}
          <View style={{ height: 16 }} />
          <Pressable
            style={[S.bigBtn, (busy || !valid) && S.disabled]}
            disabled={busy || !valid}
            onPress={() => amountRaw !== null && onConfirm(amountRaw)}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={S.bigBtnText}>{tr('tip.send')}</Text>
            )}
          </Pressable>
          <View style={{ height: 10 }} />
          <Pressable style={S.ghostBtn} disabled={busy} onPress={onCancel}>
            <Text style={S.ghostBtnText}>{tr('compose.cancel')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/* ---------- password prompt (for the password unlock method) ---------- */
export function PasswordPrompt({
  visible,
  busy = false,
  onAnswer,
}: {
  visible: boolean;
  /** v0.5.1 (F1): true while the entered password is being
   *  verified — the sheet stays up with a spinner and locked
   *  controls instead of vanishing into a frozen screen. */
  busy?: boolean;
  onAnswer: (password: string | null) => void;
}) {
  const insets = useSafeAreaInsets();
  const [pw, setPw] = useState('');
  useEffect(() => {
    if (visible) setPw('');
  }, [visible]);
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={sheetStyles.backdrop}>
        <View style={[sheetStyles.sheet, { paddingBottom: 30 + insets.bottom }]}>
          <Text style={S.h2}>{tr('auth.signReason')}</Text>
          <TextInput
            style={[S.input, { marginTop: 12 }]}
            secureTextEntry
            value={pw}
            onChangeText={setPw}
            placeholder={tr('unlock.pwPh')}
            autoFocus
            editable={!busy}
          />
          <View style={{ height: 14 }} />
          <Pressable
            style={[S.bigBtn, busy && S.disabled]}
            disabled={busy}
            onPress={() => onAnswer(pw)}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={S.bigBtnText}>OK</Text>
            )}
          </Pressable>
          {busy ? (
            <Text style={[S.small, { marginTop: 10, textAlign: 'center' }]}>
              {tr('unlock.checking')}
            </Text>
          ) : null}
          <View style={{ height: 10 }} />
          <Pressable style={S.ghostBtn} disabled={busy} onPress={() => onAnswer(null)}>
            <Text style={S.ghostBtnText}>{tr('settings.cancel')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
