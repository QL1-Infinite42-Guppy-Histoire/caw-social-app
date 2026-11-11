import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Circle, Line, Path, Polyline } from 'react-native-svg';
import { SvgXml } from 'react-native-svg';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ACCENT } from '../config';
import { LOCALES, isLang, tr } from '../i18n';
import {
  avatarFor,
  findPostByCawId,
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
  TIP_PRESETS_CAT42,
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
export function TipIcon({ size = 18, color = '#f5a623' }: { size?: number; color?: string }) {
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
export function SettingsIcon({ size = 22, color = '#536471' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="12" cy="12" r="3" />
      <Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}

/* ---------- balance grid (v0.4.10) ---------- */
/**
 * The balances as a two-column grid with shared hairline
 * borders — an Excel-like table (user request, 2026-11-10;
 * mock approved the same day). It replaces the stacked
 * full-width frames of v0.4.6–v0.4.9: seven balances now take
 * less vertical room than five frames did. The Home wallet
 * card and the header name card render this same component
 * with the same cells in the same order.
 *
 * A cell is { label, unit, raw, decimals }: `raw` is the
 * unscaled on-chain amount and null keeps the honest dash of
 * the v0.4.7 rule (unread / no name yet), never a numeric 0.
 * The amount text comes from fmtCardDisplay (cawCore): big
 * balances are abbreviated "x.xxB" / "x.xxM" (truncated,
 * never rounded), the rest use the card format at the
 * token's own decimals. Tapping a cell swaps its amount for
 * the EXACT full figure (fmtExactDec); tapping it again — or
 * tapping another cell — swaps back / moves over. A null
 * entry in the array renders an empty cell, completing the
 * grid. The hint line under the table says the tap rule in
 * the current language (card.tapHint).
 */
export interface BalanceCellData {
  label: string;
  unit: string;
  raw: bigint | null;
  decimals?: number;
}

export function BalanceGrid({
  cells,
}: {
  cells: (BalanceCellData | null)[];
}) {
  const [open, setOpen] = useState<number | null>(null);
  const list = cells.length % 2 === 1 ? [...cells, null] : cells;
  const rows: (BalanceCellData | null)[][] = [];
  for (let i = 0; i < list.length; i += 2) {
    rows.push([list[i], list[i + 1]]);
  }
  return (
    <View>
      <View style={balanceStyles.grid}>
        {rows.map((row, r) => (
          <View key={r} style={balanceStyles.row}>
            {row.map((cell, c) => {
              const idx = r * 2 + c;
              // The outer box owns the right/bottom edges; cells
              // only draw the hairlines BETWEEN cells.
              const edges = {
                borderRightWidth: c === 1 ? 0 : 1,
                borderBottomWidth: r === rows.length - 1 ? 0 : 1,
              };
              if (!cell) {
                return (
                  <View key={c} style={[balanceStyles.cell, edges]} />
                );
              }
              const dec = cell.decimals ?? 18;
              const shown =
                cell.raw === null
                  ? null
                  : open === idx
                    ? fmtExactDec(cell.raw, dec)
                    : fmtCardDisplay(cell.raw, dec).text;
              return (
                <Pressable
                  key={c}
                  style={({ pressed }) => [
                    balanceStyles.cell,
                    edges,
                    balanceStyles.cellBtn,
                    pressed && { backgroundColor: '#f7f9f9' },
                  ]}
                  onPress={() =>
                    cell.raw !== null &&
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
                    {cell.label}
                  </Text>
                  <Text
                    style={balanceStyles.amount}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.4}
                  >
                    {shown === null ? '—' : shown}
                    {shown === null ? null : (
                      <Text style={balanceStyles.unit}> {cell.unit}</Text>
                    )}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
      <Text style={balanceStyles.hint}>{tr('card.tapHint')}</Text>
    </View>
  );
}

const balanceStyles = StyleSheet.create({
  /* The shared borders are drawn by the table itself: the
   * outer box carries the border and radius, rows and cells
   * meet on single hairlines (right / bottom) instead of each
   * cell owning a full frame. Type sizes keep the compact
   * v0.4.9 metrics (amount 17, label/unit 11.5). */
  grid: {
    borderWidth: 1,
    borderColor: '#d9dee2',
    borderRadius: 12,
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  row: { flexDirection: 'row' },
  cell: {
    flex: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#d9dee2',
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  cellBtn: { justifyContent: 'center' },
  label: { fontSize: 11.5, color: '#536471', fontWeight: '600' },
  amount: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0f1419',
    marginTop: 1,
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
  if (customUri) {
    inner = <Image source={{ uri: customUri }} style={{ width: size, height: size }} />;
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
/** SuperLike gold (v0.4.8) — distinct from like pink / recaw green. */
const SUPERLIKE_ON = '#f5a623';

/** The original post a like / share points at, shown as a quote box. */
function TargetPostQuote({
  item,
  lang,
  onOpenProfile,
}: {
  item: TimelineItem;
  lang: string;
  onOpenProfile: (username: string) => void;
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
  const authorLabel = author
    ? '@' + author
    : tr('tl.unknownName') + post.senderId.toString();
  return (
    <Pressable
      style={postStyles.quote}
      onPress={author ? () => onOpenProfile(author) : undefined}
    >
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
      <Text style={postStyles.quoteText} numberOfLines={4}>
        {post.text}
      </Text>
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
}: {
  post: TimelineItem;
  lang: string;
  onOpenProfile: (username: string) => void;
  onOpenPost?: (item: TimelineItem) => void;
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
      <Text style={postStyles.quoteText} numberOfLines={4}>
        {displayTextOf(post.text)}
      </Text>
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
}: {
  cawId: string;
  lang: string;
  onOpenProfile: (username: string) => void;
  onOpenPost?: (item: TimelineItem) => void;
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
  return (
    <QuotedPostFrame
      post={post}
      lang={lang}
      onOpenProfile={onOpenProfile}
      onOpenPost={onOpenPost}
    />
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
   *  Without a handler the ⭐ count still shows when it is > 0. */
  onSuperlike?: (item: TimelineItem) => void;
  /** Tip button (v0.5.0): send CAT42 to the post's author. */
  onTip?: (item: TimelineItem) => void;
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
  actionStatus,
  busy,
  liked,
  recawed,
  nested,
}: PostCardProps) {
  const [name, setName] = useState<string | null>(null);
  const [original, setOriginal] = useState<TimelineItem | null | undefined>(
    undefined,
  );
  /* SuperRecaw detection (v0.5.0): the flashy treatment shows
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
  const row = (
    <>
      <Avatar
        nameId={item.senderId}
        size={44}
        onPress={name ? () => onOpenProfile(name) : undefined}
      />
      <View style={{ flex: 1, marginStart: 10 }}>
        {isSuper ? (
          <View style={[S.row, { marginBottom: 4 }]}>
            <View style={postStyles.superBadge}>
              <Text style={postStyles.superBadgeText}>
                ⭐ {tr('tl.superRecaw')}
              </Text>
            </View>
          </View>
        ) : null}
        <View style={S.row}>
          <RepeatIcon size={14} color={RECAW_ON} />
          <Text style={[S.tiny, { marginStart: 5, fontWeight: '700' }]}>
            {tr('tl.recawedBy', { name: who })}
          </Text>
        </View>
        {original === undefined ? (
          <View style={postStyles.quote}>
            <Text style={S.small}>{tr('tl.loading')}</Text>
          </View>
        ) : original === null ? (
          <View style={postStyles.quote}>
            <Text style={S.small}>{tr('tl.originalMissing')}</Text>
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
            busy={busy}
            liked={liked}
            recawed={recawed}
            nested
          />
        )}
        <View style={[S.row, { marginTop: 8 }]}>
          <Pressable onPress={() => Linking.openURL(txUrl(item.hash))}>
            <Text style={[S.tiny, { color: ACCENT }]}>
              {tr('tl.viewTx')} ↗
            </Text>
          </Pressable>
        </View>
        {actionStatus ? (
          <Text style={[S.tiny, { marginTop: 4 }]}>{actionStatus}</Text>
        ) : null}
      </View>
    </>
  );
  if (isSuper && !nested) {
    /* The flashy treatment (v0.5.0, per the approved concept):
     * a gold → pink → purple gradient frame around a warm
     * tinted card, so a SuperRecaw stands out of the feed at a
     * glance. Nested rows keep the plain frame — the outer row
     * carries the treatment. */
    return (
      <LinearGradient
        colors={['#f5a623', '#e84393', '#6c5ce7']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={postStyles.superFrame}
      >
        <View style={[postStyles.post, postStyles.superInner]}>{row}</View>
      </LinearGradient>
    );
  }
  return (
    <View style={nested ? postStyles.postNested : postStyles.post}>{row}</View>
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
  actionStatus,
  busy,
  liked,
  recawed,
  custom,
  nested,
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
  const showLikes =
    item.type === 0 && ((likes !== null && likes > 0n) || liked);
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
        actionStatus={actionStatus}
        busy={busy}
        liked={liked}
        recawed={recawed}
        nested={nested}
      />
    );
  }
  /* Posts: the display body hides the parent-reference marker
   * line (replies / quote Recaws, lib/postRef.ts). */
  const parsed = item.type === 0 ? parsePostText(item.text) : null;
  const bodyText = parsed ? parsed.body : item.text;
  return (
    <View style={nested ? postStyles.postNested : postStyles.post}>
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
        <View style={S.row}>
          <Pressable onPress={name ? () => onOpenProfile(name) : undefined}>
            <Text style={postStyles.name}>{displayName || who}</Text>
          </Pressable>
          {displayName ? <Text style={S.tiny}>{'  ' + who}</Text> : null}
          <Text style={S.tiny}>
            {'  ·  '}
            {formatTime(item.ts, lang)}
          </Text>
        </View>
        {parsed?.ref?.kind === 'reply' && replyToName ? (
          <Text style={S.tiny}>
            {tr('tl.replyTo', { name: '@' + replyToName })}
          </Text>
        ) : null}
        {item.type === 0 && bodyText ? (
          onOpenPost ? (
            <Pressable onPress={() => onOpenPost(item)}>
              <Text style={postStyles.text}>{bodyText}</Text>
            </Pressable>
          ) : (
            <Text style={postStyles.text}>{bodyText}</Text>
          )
        ) : null}
        {parsed?.ref?.kind === 'quote' ? (
          <OriginalFrame
            cawId={parsed.ref.parentCawId}
            lang={lang}
            onOpenProfile={onOpenProfile}
            onOpenPost={onOpenPost}
          />
        ) : null}
        {item.type === 1 ? (
          <TargetPostQuote item={item} lang={lang} onOpenProfile={onOpenProfile} />
        ) : null}
        <View style={[S.row, { marginTop: 8, flexWrap: 'wrap', gap: 14 }]}>
          {showLikes ? (
            <View style={S.row}>
              <HeartIcon size={15} color={liked ? LIKE_ON : '#536471'} filled={!!liked} />
              <Text style={[S.tiny, { marginStart: 4 }]}>
                {(likes !== null ? likes : liked ? 1n : 0n).toString()}
              </Text>
            </View>
          ) : null}
          {item.type === 0 && onAction ? (
            <>
              <Pressable
                disabled={busy}
                onPress={() => onAction(1, item)}
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
                  {tr('tl.like')}
                </Text>
              </Pressable>
              <Pressable
                disabled={busy}
                onPress={() => onAction(2, item)}
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
                  {tr('tl.recaw')}
                </Text>
              </Pressable>
            </>
          ) : null}
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
                {replyCount > 0 ? replyCount.toString() : tr('tl.reply')}
              </Text>
            </Pressable>
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
                {slCount !== null && slCount > 0
                  ? slCount.toString()
                  : tr('tl.superlike')}
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
          <Pressable onPress={() => Linking.openURL(txUrl(item.hash))}>
            <Text style={[S.tiny, { color: ACCENT }]}>
              {tr('tl.viewTx')} ↗
            </Text>
          </Pressable>
        </View>
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
  // X-style action buttons: a soft pill highlight while pressed.
  actionBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginStart: -8,
    borderRadius: 999,
  },
  actionBtnOn: { backgroundColor: '#f7f9f9' },
  /* SuperRecaw treatment (v0.5.0): the gradient lives on the
   * wrapper (LinearGradient), the card inside is warm-tinted
   * and borderless so the frame reads as one piece. */
  superFrame: {
    borderRadius: 18,
    padding: 3,
    marginHorizontal: 8,
    marginVertical: 6,
  },
  superInner: {
    borderBottomWidth: 0,
    borderRadius: 15,
    backgroundColor: '#fff7e8',
  },
  superBadge: {
    backgroundColor: '#d6336c',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  superBadgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
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
   * SHOWS where the CAT42 will actually go — shortened with
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
  const [preset, setPreset] = useState<number | null>(10);
  const [custom, setCustom] = useState('');
  useEffect(() => {
    if (visible) {
      setPreset(10);
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
            {TIP_PRESETS_CAT42.map((p) => {
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
                    {p} CAT42
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
