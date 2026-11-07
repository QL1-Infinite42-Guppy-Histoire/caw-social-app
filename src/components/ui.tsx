import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Path, Polyline } from 'react-native-svg';
import { SvgXml } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ACCENT } from '../config';
import { tr } from '../i18n';
import {
  avatarFor,
  findPostByCawId,
  likesCount,
  resolveName,
  txUrl,
} from '../lib/cawApi';
import { avatarSpec } from '../lib/cawCore';
import type { TimelineItem } from '../lib/cawApi';
import type { ProfileCustom } from '../lib/profileCustom';

export const HAIRLINE = '#eff3f4';

export const S = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  scrollPad: { padding: 16, paddingBottom: 32 },
  h1: { fontSize: 22, fontWeight: '800', color: '#0f1419' },
  h2: { fontSize: 17, fontWeight: '700', color: '#0f1419', marginTop: 8 },
  body: { fontSize: 15, color: '#0f1419', lineHeight: 21 },
  small: { fontSize: 13, color: '#536471', lineHeight: 18 },
  tiny: { fontSize: 12, color: '#536471' },
  err: { fontSize: 14, color: '#c62828', lineHeight: 20 },
  ok: { fontSize: 14, color: '#1b7a43', lineHeight: 20 },
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
export function Avatar({
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
  if (!inner && img && img.startsWith('data:image/svg+xml')) {
    try {
      const svg = decodeURIComponent(img.split(',').slice(1).join(','));
      inner = <SvgXml xml={svg} width={size} height={size} />;
    } catch {
      inner = null;
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
    return new Date(tsSec * 1000).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
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
        <Text style={[postStyles.quoteName, { marginLeft: 6 }]}>
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

/* ---------- one timeline entry ---------- */
export function PostCard({
  item,
  lang,
  onOpenProfile,
  onAction,
  actionStatus,
  busy,
  liked,
  recawed,
  custom,
}: {
  item: TimelineItem;
  lang: string;
  onOpenProfile: (username: string) => void;
  onAction?: (kind: 1 | 2, item: TimelineItem) => void;
  actionStatus?: string;
  busy?: boolean;
  /** This wallet already liked this post (remembered on the device). */
  liked?: boolean;
  /** This wallet already shared this post. */
  recawed?: boolean;
  /** Sender's on-device custom look (only ever set for my own names). */
  custom?: ProfileCustom | null;
}) {
  const [name, setName] = useState<string | null>(null);
  const [targetName, setTargetName] = useState<string | null>(null);
  const [likes, setLikes] = useState<bigint | null>(null);
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
    }
    return () => {
      live = false;
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
          : null;
  const targetLabel = targetName
    ? '@' + targetName
    : tr('tl.unknownName') + item.receiverId.toString();
  const showLikes =
    item.type === 0 && ((likes !== null && likes > 0n) || liked);
  return (
    <View style={postStyles.post}>
      <Avatar
        nameId={item.senderId}
        size={44}
        customUri={custom ? custom.avatarPath : undefined}
        onPress={name ? () => onOpenProfile(name) : undefined}
      />
      <View style={{ flex: 1, marginLeft: 10 }}>
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
        {item.type === 0 && item.text ? (
          <Text style={postStyles.text}>{item.text}</Text>
        ) : null}
        {item.type === 1 || item.type === 2 ? (
          <TargetPostQuote item={item} lang={lang} onOpenProfile={onOpenProfile} />
        ) : null}
        <View style={[S.row, { marginTop: 8, flexWrap: 'wrap', gap: 14 }]}>
          {showLikes ? (
            <View style={S.row}>
              <HeartIcon size={15} color={liked ? LIKE_ON : '#536471'} filled={!!liked} />
              <Text style={[S.tiny, { marginLeft: 4 }]}>
                {(likes !== null ? likes : liked ? 1n : 0n).toString()}
              </Text>
            </View>
          ) : null}
          {item.type === 0 && onAction ? (
            <>
              <Pressable
                disabled={busy}
                onPress={() => onAction(1, item)}
                style={[S.row, busy && S.disabled]}
              >
                <HeartIcon size={16} color={liked ? LIKE_ON : '#536471'} filled={!!liked} />
                <Text
                  style={[
                    S.tiny,
                    { marginLeft: 4 },
                    liked && { color: LIKE_ON, fontWeight: '700' },
                  ]}
                >
                  {tr('tl.like')}
                </Text>
              </Pressable>
              <Pressable
                disabled={busy}
                onPress={() => onAction(2, item)}
                style={[S.row, busy && S.disabled]}
              >
                <RepeatIcon size={16} color={recawed ? RECAW_ON : '#536471'} />
                <Text
                  style={[
                    S.tiny,
                    { marginLeft: 4 },
                    recawed && { color: RECAW_ON, fontWeight: '700' },
                  ]}
                >
                  {tr('tl.recaw')}
                </Text>
              </Pressable>
            </>
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

const postStyles = StyleSheet.create({
  post: {
    flexDirection: 'row',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: HAIRLINE,
    backgroundColor: '#fff',
  },
  name: { fontSize: 15, fontWeight: '700', color: '#0f1419' },
  text: { fontSize: 15, color: '#0f1419', lineHeight: 21, marginTop: 2 },
  quote: {
    borderWidth: 1,
    borderColor: '#cfd9de',
    borderRadius: 12,
    padding: 10,
    marginTop: 8,
  },
  quoteName: { fontSize: 13.5, fontWeight: '700', color: '#0f1419' },
  quoteText: { fontSize: 14, color: '#0f1419', lineHeight: 19, marginTop: 4 },
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
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={sheetStyles.backdrop}>
        <View style={sheetStyles.sheet}>
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

/* ---------- password prompt (for the password unlock method) ---------- */
export function PasswordPrompt({
  visible,
  onAnswer,
}: {
  visible: boolean;
  onAnswer: (password: string | null) => void;
}) {
  const [pw, setPw] = useState('');
  useEffect(() => {
    if (visible) setPw('');
  }, [visible]);
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={sheetStyles.backdrop}>
        <View style={sheetStyles.sheet}>
          <Text style={S.h2}>{tr('auth.signReason')}</Text>
          <TextInput
            style={[S.input, { marginTop: 12 }]}
            secureTextEntry
            value={pw}
            onChangeText={setPw}
            placeholder={tr('unlock.pwPh')}
            autoFocus
          />
          <View style={{ height: 14 }} />
          <Pressable
            style={S.bigBtn}
            onPress={() => onAnswer(pw)}
          >
            <Text style={S.bigBtnText}>OK</Text>
          </Pressable>
          <View style={{ height: 10 }} />
          <Pressable style={S.ghostBtn} onPress={() => onAnswer(null)}>
            <Text style={S.ghostBtnText}>{tr('settings.cancel')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
