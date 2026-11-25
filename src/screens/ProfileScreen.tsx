import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';

import {
  Avatar,
  ConfirmSheet,
  LoadMoreFooter,
  PostCard,
  S,
  StarIcon,
  TipSheet,
  useNameLabel,
} from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { LOCALES, tr } from '../i18n';
import {
  fetchProfilePosts,
  followerCount,
  mintDateOf,
  nameBalance,
  nameOwner,
  resolveName,
  resolveNameId,
  type TimelineItem,
} from '../lib/cawApi';
import { backArrow } from '../lib/rtl';
import {
  buildFollowIndex,
  followIndexProgress,
  followIndexReady,
  followListsOf,
  refinedFollowListsOf,
  subscribeFollowIndex,
  type FollowLists,
} from '../lib/followIndex';
import {
  performAction,
  performAuthorPay,
  performSuperRecaw,
  performSuperRecawBurn,
  performSuperlike,
  performTip,
} from '../lib/actionFlow';
import {
  SUPERLIKE_AUTHOR_RAW,
  SUPERLIKE_BURN_RAW,
  SUPERLIKE_TOTAL_RAW,
} from '../lib/superlike';
import { pendingSrcBurnFor } from '../lib/superRecaw';
import {
  SUPERRECAW_AUTHOR_RAW,
  SUPERRECAW_BURN_RAW,
  SUPERRECAW_TOTAL_RAW,
} from '../lib/markedBurns';
import {
  pendingAuthorPayFor,
  type AuthorPayKind,
} from '../lib/authorPay';
import {
  fmtAmount,
  fmtAmountCard,
  fmtAmountCardDec,
} from '../lib/cawCore';
import {
  deleteProfileImage,
  pickAndStoreProfileImage,
} from '../lib/profileImage';
import {
  MediaApiError,
  clearProfileMedia,
  filterModeratedItems,
  filterSanctionedItems,
  hashFromMediaUrl,
  invalidateAttachments,
  invalidateMedia,
  isSanctionedError,
  mediaErrorDetail,
  mediaFor,
  setProfileMedia,
  type HiddenMediaEntry,
  type MediaKind,
  type PostAttachment,
  type ProfileMedia,
} from '../lib/mediaApi';
import { signerFor } from '../lib/wallet';
import {
  applyMediaHidden,
  applyMediaUnhidden,
  applyPostHidden,
  applySanctionLocal,
  applyUnsanctionLocal,
  modErrorText,
  refreshHiddenMedia,
  refreshModeration,
  runAdminOp,
  useModeration,
} from '../lib/moderation';

type PendingAction = { kind: 1 | 2; item: TimelineItem };
type LoadState = 'loading' | 'ok' | 'fail' | 'notfound';

export default function ProfileScreen({
  username,
  onBack,
}: {
  username: string;
  onBack: () => void;
}) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  // v0.1.5 fix: the profile (and its edit dialog) run inside Modals,
  // outside the main SafeAreaView, so the back row at the very top
  // used to sit under the status bar — same overlap the compose
  // header had. Reserve the top inset on every root view here,
  // matching the bottom-inset pattern LoadMoreFooter already uses.
  const rootStyle = [S.screen, { paddingTop: insets.top }];
  const { lang, address, myTokens, actingId } = app;

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [profileId, setProfileId] = useState<bigint | null>(null);
  const [resolvedName, setResolvedName] = useState<string>(username);
  const [followers, setFollowers] = useState<bigint | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [mintDate, setMintDate] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);

  const [posts, setPosts] = useState<TimelineItem[]>([]);
  const [next, setNext] = useState<Record<string, unknown> | null>(null);
  const [done, setDone] = useState(true);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [statusByHash, setStatusByHash] = useState<Record<string, string>>({});
  const [busyByHash, setBusyByHash] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<PendingAction | null>(null);

  /* ---------- Moderation (v0.7.6) ----------
   * Admins get, on ANY profile: Hide/Unhide/Delete for the
   * profile's icon / header / audio (the ops pin the item's
   * CURRENT hash, read from the media layer), the usual post
   * + attachment controls on the profile's posts, and the
   * hidden state of each media kind from the server's
   * list-hidden truth — so a hide can be undone here in any
   * session, not just the one that hid it. */
  const mod = useModeration();
  const [modPostPending, setModPostPending] = useState<TimelineItem | null>(
    null,
  );
  const [modAttPending, setModAttPending] = useState<{
    item: TimelineItem;
    hash: string;
    verb: 'hide' | 'unhide' | 'delete';
  } | null>(null);
  const [modMediaPending, setModMediaPending] = useState<{
    kind: MediaKind;
    verb: 'hide' | 'unhide' | 'delete';
    hash: string;
  } | null>(null);
  const [modBusy, setModBusy] = useState(false);
  const [modMediaNote, setModMediaNote] = useState('');
  const [mediaTick, setMediaTick] = useState(0);
  const [attTicks, setAttTicks] = useState<Record<string, number>>({});

  const bumpAttTick = useCallback((cawId: string) => {
    const key = cawId.toLowerCase();
    setAttTicks((t) => ({ ...t, [key]: (t[key] ?? 0) + 1 }));
  }, []);

  const confirmModPost = useCallback(async () => {
    const item = modPostPending;
    if (!item) return;
    const hidden = mod.isPostHidden(item.cawId);
    setModBusy(true);
    try {
      await runAdminOp(app.getSecret(), {
        action: hidden ? 'unhide-post' : 'hide-post',
        cawId: item.cawId,
      });
      applyPostHidden(item.cawId, !hidden);
    } catch (e) {
      setStatusByHash((prev) => ({
        ...prev,
        [item.hash]: modErrorText(e),
      }));
    } finally {
      setModBusy(false);
      setModPostPending(null);
    }
  }, [app, mod, modPostPending]);

  const confirmModAtt = useCallback(async () => {
    const p = modAttPending;
    if (!p) return;
    setModBusy(true);
    try {
      await runAdminOp(app.getSecret(), {
        action: p.verb + '-attach',
        cawId: p.item.cawId,
        sha256: p.hash,
      });
      const entry = {
        kind: 'attach' as const,
        cawId: p.item.cawId.toLowerCase(),
        hash: p.hash,
        hiddenBy: app.address ?? '',
        ts: Date.now(),
      };
      if (p.verb === 'hide') applyMediaHidden(entry);
      else applyMediaUnhidden(entry);
      if (p.verb === 'delete') {
        invalidateAttachments(p.item.cawId);
        bumpAttTick(p.item.cawId);
      }
      refreshHiddenMedia(app.getSecret()).catch(() => {});
    } catch (e) {
      setStatusByHash((prev) => ({
        ...prev,
        [p.item.hash]: modErrorText(e),
      }));
      if (e instanceof MediaApiError && e.status === 409) {
        invalidateAttachments(p.item.cawId);
        bumpAttTick(p.item.cawId);
      }
    } finally {
      setModBusy(false);
      setModAttPending(null);
    }
  }, [app, modAttPending, bumpAttTick]);

  const confirmModMedia = useCallback(async () => {
    const p = modMediaPending;
    if (!p || profileId === null) return;
    setModBusy(true);
    try {
      await runAdminOp(app.getSecret(), {
        action: p.verb + '-' + p.kind,
        nameId: profileId.toString(),
        sha256: p.hash,
      });
      const entry: HiddenMediaEntry = {
        kind: p.kind,
        nameId: profileId.toString(),
        hash: p.hash,
        hiddenBy: app.address ?? '',
        ts: Date.now(),
      };
      if (p.verb === 'hide') applyMediaHidden(entry);
      else applyMediaUnhidden(entry);
      setModMediaNote('');
      // The profile's media reads refresh: the cached copy
      // is dropped, the header re-reads, and the big avatar
      // remounts onto the fresh state.
      invalidateMedia(profileId);
      mediaFor(profileId)
        .then((m) => setServerMedia(m))
        .catch(() => {});
      setMediaTick((t) => t + 1);
      refreshHiddenMedia(app.getSecret()).catch(() => {});
    } catch (e) {
      // 409 included: modErrorText carries the honest
      // "changed since this screen opened" wording, and the
      // refetch below shows the current version.
      setModMediaNote(modErrorText(e));
      invalidateMedia(profileId);
      mediaFor(profileId)
        .then((m) => setServerMedia(m))
        .catch(() => {});
      setMediaTick((t) => t + 1);
    } finally {
      setModBusy(false);
      setModMediaPending(null);
    }
  }, [app, modMediaPending, profileId]);

  const onModTogglePost = useCallback(
    (item: TimelineItem) => setModPostPending(item),
    [],
  );
  const onModAttach = useCallback(
    (
      item: TimelineItem,
      hash: string,
      _att: PostAttachment | null,
      verb: 'hide' | 'unhide' | 'delete',
    ) => setModAttPending({ item, hash, verb }),
    [],
  );

  /* This profile's hidden media kinds, from the server's
   * list-hidden truth (any session's hides included). */
  const profHiddenMedia: Partial<Record<MediaKind, HiddenMediaEntry>> =
    {};
  if (profileId !== null) {
    for (const e of mod.hiddenMedia) {
      if (e.kind !== 'attach' && e.nameId === profileId.toString()) {
        profHiddenMedia[e.kind] = e;
      }
    }
  }

  const visiblePosts = filterSanctionedItems(
    filterModeratedItems(posts, mod.hiddenPosts, mod.isAdmin),
    mod.sanctionedNames,
    mod.isAdmin,
  );

  /* ---------- Sanctions (v0.7.9) ----------
   * This profile's sanction state, and the admin ops on it:
   * freeze (24h / 7d / 30d) / ban / lift, all behind
   * ConfirmSheets. The same pending state also serves the
   * card-level Lift (which acts on a post's author — here,
   * always this profile's name). Errors land in the
   * moderation note line. */
  const profSanction =
    profileId !== null ? mod.sanctionFor(profileId) : null;
  const [sanctPending, setSanctPending] = useState<{
    verb: 'freeze' | 'ban' | 'lift';
    dur?: '24h' | '7d' | '30d';
    nameId: string;
  } | null>(null);
  const [sanctBusy, setSanctBusy] = useState(false);
  const confirmSanction = useCallback(async () => {
    const p = sanctPending;
    if (!p) return;
    setSanctBusy(true);
    try {
      if (p.verb === 'lift') {
        await runAdminOp(app.getSecret(), {
          action: 'unsanction-user',
          nameId: p.nameId,
        });
        applyUnsanctionLocal(p.nameId);
      } else if (p.verb === 'freeze') {
        const j = await runAdminOp(app.getSecret(), {
          action: 'freeze-user',
          nameId: p.nameId,
          target: p.dur,
        });
        applySanctionLocal({
          nameId: p.nameId,
          kind: 'freeze',
          until: typeof j.until === 'number' ? j.until : null,
          ts: Date.now(),
        });
      } else {
        await runAdminOp(app.getSecret(), {
          action: 'ban-user',
          nameId: p.nameId,
        });
        applySanctionLocal({
          nameId: p.nameId,
          kind: 'ban',
          until: null,
          ts: Date.now(),
        });
      }
      setModMediaNote('');
      refreshModeration(app.address, app.getSecret()).catch(() => {});
    } catch (e) {
      setModMediaNote(modErrorText(e));
    } finally {
      setSanctBusy(false);
      setSanctPending(null);
    }
  }, [app, sanctPending]);
  const onModUnsanction = useCallback(
    (item: TimelineItem) =>
      setSanctPending({ verb: 'lift', nameId: item.senderId.toString() }),
    [],
  );

  const [followConfirmOpen, setFollowConfirmOpen] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [followStatus, setFollowStatus] = useState('');

  // Following / followers, rebuilt from the public follow records
  // (see followIndex.ts). The followers NUMBER shown is always the
  // chain's own followerCount; these lists are the reconstruction.
  const [followLists, setFollowLists] = useState<FollowLists | null>(null);
  const [listOpen, setListOpen] = useState<'following' | 'followers' | null>(
    null,
  );
  const [listLoading, setListLoading] = useState(false);
  const [listFail, setListFail] = useState(false);
  const [followProgress, setFollowProgress] = useState<number | null>(null);
  /** True once the balance refinement has been applied for the
   *  current profile — progressive (unrefined) updates stop
   *  overwriting the lists after that. */
  const refinedRef = React.useRef(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  const acting =
    myTokens.find((t) => t.id === actingId) ?? myTokens[0] ?? null;
  const actingLabel = acting ? '@' + acting.username : '';

  const isOwn =
    !!address &&
    !!owner &&
    address.toLowerCase() === owner.toLowerCase();
  // The same verdict from the wallet's own loaded name list —
  // synchronous, no chain read to wait for (v0.4.5). The edit
  // entry and the follow-button suppression key off (isOwn ||
  // isMine): a name this wallet holds must never offer a follow
  // button, even while the ownerOf read is still in flight (that
  // gap is how an own profile briefly wore a "Following" pill).
  const isMine =
    profileId !== null && myTokens.some((t) => t.id === profileId);

  // On-device custom look (off-chain) — only ever set for my own names.
  const custom = profileId !== null ? app.customFor(profileId) : undefined;
  const followedByMe =
    profileId !== null ? app.hasFollowed(profileId) : false;

  /* Shared profile media (v0.7.3, media server): the icon /
   * header / audio this name's owner published for everyone.
   * Display priority everywhere: server media → on-device
   * custom (own names only) → the NFT card look. mediaFor
   * never rejects; null = nothing shared (or server down). The
   * Avatar component resolves the icon itself (ui.tsx); this
   * screen needs the header + audio, so it keeps its own copy. */
  const [serverMedia, setServerMedia] = useState<ProfileMedia | null>(
    null,
  );
  useEffect(() => {
    if (profileId === null) {
      setServerMedia(null);
      return;
    }
    let live = true;
    setServerMedia(null);
    mediaFor(profileId).then((m) => live && setServerMedia(m));
    return () => {
      live = false;
    };
  }, [profileId]);

  /* Profile audio playback (v0.7.3): one player per profile
   * screen; the source follows the profile's shared audio.
   * Playback only — the app never records. */
  const audioPlayer = useAudioPlayer();
  const audioStatus = useAudioPlayerStatus(audioPlayer);
  const audioUrl = serverMedia?.audio?.url ?? null;
  useEffect(() => {
    audioPlayer.pause();
    if (audioUrl) audioPlayer.replace({ uri: audioUrl });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);
  const toggleAudio = useCallback(() => {
    if (audioStatus.playing) audioPlayer.pause();
    else audioPlayer.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioStatus.playing]);

  const openEditor = useCallback(() => {
    setEditName(custom && custom.displayName ? custom.displayName : '');
    setEditBio(custom && custom.bio ? custom.bio : '');
    setEditNote('');
    setEditOpen(true);
  }, [custom]);

  /** One save for both text fields (display name + bio, v0.4.5). */
  const saveTexts = useCallback(async () => {
    if (profileId === null) return;
    setEditBusy(true);
    try {
      await app.saveCustom(profileId, {
        displayName: editName.trim(),
        bio: editBio.trim(),
      });
      setEditNote('');
    } finally {
      setEditBusy(false);
    }
  }, [app, profileId, editName, editBio]);

  const pickImage = useCallback(
    async (kind: 'avatar' | 'header') => {
      if (profileId === null) return;
      setEditBusy(true);
      try {
        const uri = await pickAndStoreProfileImage(profileId, kind);
        if (uri) {
          const old =
            kind === 'avatar'
              ? custom && custom.avatarPath
              : custom && custom.headerPath;
          if (old && old !== uri) deleteProfileImage(old);
          await app.saveCustom(
            profileId,
            kind === 'avatar' ? { avatarPath: uri } : { headerPath: uri },
          );
          setEditNote('');
          /* Publish it (v0.7.3, media server): the same stored
           * copy is uploaded under a signature from this name's
           * wallet, so every client shows it. Best effort — the
           * on-device save above already succeeded, so a failed
           * upload only changes the note, never the local look. */
          const secret = app.getSecret();
          if (secret) {
            try {
              setEditNote(tr('media.uploading'));
              await setProfileMedia(
                kind === 'avatar' ? 'icon' : 'header',
                uri,
                undefined,
                signerFor(secret.kind, secret.secret),
                profileId,
              );
              setServerMedia(await mediaFor(profileId));
              setEditNote(tr('media.uploaded'));
            } catch (e) {
              setEditNote(
                isSanctionedError(e)
                  ? tr('media.sanctioned')
                  : (e instanceof MediaApiError && e.status === 413
                      ? tr('media.tooLarge')
                      : tr('media.uploadFail')) +
                    ' — ' +
                    mediaErrorDetail(e),
              );
            }
          }
        }
        // uri === null: the user cancelled (or denied the photo
        // permission) — not an error, nothing to report.
      } catch {
        // Storing the picked picture failed. Until v0.4.5 this was
        // swallowed silently, which read as "the setting does not
        // work"; say so on screen instead.
        setEditNote(tr('custom.pickFail'));
      } finally {
        setEditBusy(false);
      }
    },
    [app, profileId, custom],
  );

  const resetCustom = useCallback(async () => {
    if (profileId === null) return;
    setEditBusy(true);
    try {
      const old = await app.clearCustom(profileId);
      if (old) {
        deleteProfileImage(old.avatarPath);
        deleteProfileImage(old.headerPath);
      }
      /* Unpublish the shared pictures too (v0.7.3): the reset
       * promises "back to the default look", which since the
       * media server includes the icon/header everyone else
       * sees. Best effort — a down server must not block the
       * local reset. (Profile audio has its own remove row.) */
      const secret = app.getSecret();
      if (secret) {
        const signer = signerFor(secret.kind, secret.secret);
        await clearProfileMedia('icon', signer, profileId).catch(
          () => {},
        );
        await clearProfileMedia('header', signer, profileId).catch(
          () => {},
        );
        setServerMedia(await mediaFor(profileId));
      }
      setEditName('');
      setEditBio('');
      setEditNote('');
    } finally {
      setEditBusy(false);
    }
  }, [app, profileId]);

  /* Profile audio (v0.7.3): pick an audio file and publish it,
   * or remove the published one. There is no on-device custom
   * audio — the media server is its only home. */
  const pickAudio = useCallback(async () => {
    if (profileId === null) return;
    let picked: DocumentPicker.DocumentPickerAsset | null = null;
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/*'],
        copyToCacheDirectory: true,
      });
      if (!res.canceled && res.assets && res.assets.length > 0) {
        picked = res.assets[0];
      }
    } catch (e) {
      setEditNote(
        isSanctionedError(e)
          ? tr('media.sanctioned')
          : tr('media.uploadFail') + ' — ' + mediaErrorDetail(e),
      );
      return;
    }
    if (!picked) return; // cancelled — not an error
    const secret = app.getSecret();
    if (!secret) {
      setEditNote(tr('media.uploadFail'));
      return;
    }
    setEditBusy(true);
    try {
      setEditNote(tr('media.uploading'));
      await setProfileMedia(
        'audio',
        picked.uri,
        picked.mimeType ?? undefined,
        signerFor(secret.kind, secret.secret),
        profileId,
      );
      setServerMedia(await mediaFor(profileId));
      setEditNote(tr('media.uploaded'));
    } catch (e) {
      setEditNote(
        isSanctionedError(e)
          ? tr('media.sanctioned')
          : (e instanceof MediaApiError && e.status === 413
              ? tr('media.tooLarge')
              : tr('media.uploadFail')) +
            ' — ' +
            mediaErrorDetail(e),
      );
    } finally {
      setEditBusy(false);
    }
  }, [app, profileId]);

  const removeAudio = useCallback(async () => {
    if (profileId === null) return;
    const secret = app.getSecret();
    if (!secret) {
      setEditNote(tr('media.uploadFail'));
      return;
    }
    setEditBusy(true);
    try {
      await clearProfileMedia(
        'audio',
        signerFor(secret.kind, secret.secret),
        profileId,
      );
      setServerMedia(await mediaFor(profileId));
      setEditNote('');
    } catch (e) {
      setEditNote(
        isSanctionedError(e)
          ? tr('media.sanctioned')
          : tr('media.uploadFail') + ' — ' + mediaErrorDetail(e),
      );
    } finally {
      setEditBusy(false);
    }
  }, [app, profileId]);

  /** Build (or refresh) the follow index and refine this name's
   *  lists. Progressive (v0.3.0): whatever the index already holds
   *  is shown immediately and updated as each page lands; the
   *  balance refinement is applied only when it is ready, so it
   *  never blocks the first paint. */
  const loadFollowLists = useCallback(async (id: bigint) => {
    if (!refinedRef.current) setFollowLists(followListsOf(id));
    await buildFollowIndex((pages) => {
      setFollowProgress(pages);
      if (!refinedRef.current) setFollowLists(followListsOf(id));
    });
    setFollowProgress(null);
    const lists = await refinedFollowListsOf(id);
    refinedRef.current = true;
    setFollowLists(lists);
    return lists;
  }, []);

  const openFollowList = useCallback(
    (which: 'following' | 'followers') => {
      setListOpen(which);
      if (profileId === null) return;
      // Render instantly from whatever the index already holds;
      // the build keeps updating the list while it runs.
      if (!refinedRef.current) setFollowLists(followListsOf(profileId));
      if (followLists) return;
      setListLoading(!followIndexReady());
      setListFail(false);
      loadFollowLists(profileId)
        .catch(() => {
          if (!followIndexReady()) setListFail(true);
        })
        .finally(() => setListLoading(false));
    },
    [followLists, profileId, loadFollowLists],
  );

  // Live-update the open list as the index build merges pages.
  useEffect(() => {
    const unsub = subscribeFollowIndex(() => {
      if (profileId !== null && !refinedRef.current) {
        setFollowLists(followListsOf(profileId));
        if (followIndexReady()) setListLoading(false);
      }
      const p = followIndexProgress();
      setFollowProgress(p.building ? p.pages : null);
    });
    return unsub;
  }, [profileId]);

  const loadProfile = useCallback(async () => {
    setLoadState('loading');
    setFollowers(null);
    setBalance(null);
    setMintDate(null);
    setOwner(null);
    setFollowLists(null);
    refinedRef.current = false;
    setListOpen(null);
    setPosts([]);
    setNext(null);
    setDone(true);
    try {
      const res = await resolveNameId(username);
      if (res.status === 'notfound') {
        setLoadState('notfound');
        return;
      }
      setProfileId(res.id);
      setResolvedName(res.username);
      setLoadState('ok');

      followerCount(res.id)
        .then((v) => setFollowers(v))
        .catch(() => setFollowers(null));
      // Background: follow lists (first build walks the whole feed,
      // later builds are incremental). Never blocks the profile.
      loadFollowLists(res.id).catch(() => {});
      nameBalance(res.id)
        .then((v) => setBalance(v))
        .catch(() => setBalance(null));
      mintDateOf(res.id)
        .then((v) => setMintDate(v))
        .catch(() => setMintDate(null));
      nameOwner(res.id)
        .then((v) => setOwner(v))
        .catch(() => setOwner(null));

      setLoadingPosts(true);
      try {
        const page = await fetchProfilePosts(res.id, null);
        setPosts(page.items);
        setNext(page.next);
        setDone(page.done);
      } catch {
        setPosts([]);
        setDone(true);
      } finally {
        setLoadingPosts(false);
      }
    } catch {
      setLoadState('fail');
    }
  }, [username, loadFollowLists]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const loadMorePosts = useCallback(async () => {
    if (profileId === null || done || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchProfilePosts(profileId, next);
      setPosts((prev) => [...prev, ...page.items]);
      setNext(page.next);
      setDone(page.done);
    } catch {
      // Keep existing posts; the button remains for retry.
    } finally {
      setLoadingMore(false);
    }
  }, [profileId, next, done, loadingMore]);

  /* Recaw offers the same choice as the timeline (v0.4.0):
   * the plain recaw action, or a quote Recaw. */
  const [recawChoice, setRecawChoice] = useState<TimelineItem | null>(null);

  const handleAction = useCallback(
    (kind: 1 | 2, item: TimelineItem) => {
      if (!acting) {
        setStatusByHash((prev) => ({
          ...prev,
          [item.hash]: tr('compose.needName'),
        }));
        return;
      }
      if (kind === 2) {
        // v0.5.0: an owed SuperRecaw burn opens the burn-only
        // sheet instead of the choice (same rule as the feed).
        // v0.6.3: an owed author payment (burn already landed)
        // opens the payment-only sheet instead.
        if (app.address) {
          const addr = app.address;
          pendingSrcBurnFor(addr, item.cawId)
            .then(async (pending) => {
              if (pending) {
                setSrcBurnItem(item);
                return;
              }
              const pay = await pendingAuthorPayFor(
                addr,
                'src',
                item.cawId,
              ).catch(() => null);
              if (pay) {
                openPaySheet(item, 'src', pay.amountRaw, pay.author);
                return;
              }
              setRecawChoice(item);
            })
            .catch(() => setRecawChoice(item));
          return;
        }
        setRecawChoice(item);
        return;
      }
      setPending({ kind, item });
    },
    [acting, app],
  );

  const confirmAction = useCallback(async () => {
    if (!pending) return;
    const { kind, item } = pending;
    setBusyByHash((prev) => ({ ...prev, [item.hash]: true }));
    // Light the button up right away; undo if the send fails.
    app.markMyAction(kind, item, true).catch(() => {});
    try {
      await performAction(app, {
        kind,
        target: item,
        text: kind === 1 ? 'LIKE' : 'REPOST',
      });
      setStatusByHash((prev) => ({ ...prev, [item.hash]: tr('act.done') }));
    } catch (e) {
      app.markMyAction(kind, item, false).catch(() => {});
      const msg =
        e instanceof Error && e.message === 'need-name'
          ? tr('compose.needName')
          : tr('act.failed');
      setStatusByHash((prev) => ({ ...prev, [item.hash]: msg }));
    } finally {
      setBusyByHash((prev) => ({ ...prev, [item.hash]: false }));
      setPending(null);
    }
  }, [app, pending]);

  /* ---------- SuperLike (v0.4.9: wired here too — v0.4.8 had
   * the send flow only on the feed cards; O-burn design
   * v0.5.0; two-leg design v0.6.3) ---------- Same flow,
   * guards and sheets as the timeline: own-post block,
   * known-shortfall hard stop. performSuperlike re-checks
   * everything against fresh chain reads before signing.
   * 5,000,000 O in two legs (v0.7.0 pricing) — burn first, then the author
   * payment; a failed payment leaves the payment-only debt. */
  const [slItem, setSlItem] = useState<TimelineItem | null>(null);
  const [slName, setSlName] = useState('');
  const [slOwner, setSlOwner] = useState('');
  const [slBusy, setSlBusy] = useState(false);

  const oBalanceText = useCallback((): string => {
    return app.oTok !== null
      ? fmtAmountCardDec(app.oTok.raw, app.oTok.decimals)
      : '—';
  }, [app]);

  const openSuperlikeSheet = useCallback(
    (item: TimelineItem) => {
      if (app.oTok !== null && app.oTok.raw < SUPERLIKE_TOTAL_RAW) {
        setStatusByHash((prev) => ({
          ...prev,
          [item.hash]: tr('sl.shortfall'),
        }));
        return;
      }
      resolveName(item.senderId)
        .then((n) => setSlName(n ? '@' + n : ''))
        .catch(() => setSlName(''));
      nameOwner(item.senderId)
        .then((o) => setSlOwner(o.slice(0, 6) + '…' + o.slice(-4)))
        .catch(() => setSlOwner(''));
      setSlItem(item);
    },
    [app],
  );

  const handleSuperlike = useCallback(
    (item: TimelineItem) => {
      // v0.6.3: an owed author payment opens the payment-only
      // sheet — a fresh SuperLike would burn a second time.
      if (app.address) {
        pendingAuthorPayFor(app.address, 'sl', item.cawId)
          .then((pay) => {
            if (pay) {
              openPaySheet(item, 'sl', pay.amountRaw, pay.author);
              return;
            }
            startSuperlike(item);
          })
          .catch(() => startSuperlike(item));
        return;
      }
      startSuperlike(item);
    },
    [app],
  );

  const startSuperlike = useCallback(
    (item: TimelineItem) => {
      if (app.myTokens.some((t) => t.id === item.senderId)) {
        setStatusByHash((prev) => ({
          ...prev,
          [item.hash]: tr('sl.self'),
        }));
        return;
      }
      openSuperlikeSheet(item);
    },
    [app, openSuperlikeSheet],
  );

  const confirmSuperlike = useCallback(async () => {
    if (!slItem) return;
    const item = slItem;
    setSlBusy(true);
    setBusyByHash((prev) => ({ ...prev, [item.hash]: true }));
    try {
      await performSuperlike(app, { target: item });
      setStatusByHash((prev) => ({
        ...prev,
        [item.hash]: tr('sl.done'),
      }));
    } catch (e) {
      const msg =
        e instanceof Error && e.message === 'self-superlike'
          ? tr('sl.self')
          : e instanceof Error && e.message === 'shortfall'
            ? tr('sl.shortfall')
            : e instanceof Error && e.message === 'sl-pay-pending'
              ? tr('sl.payPending')
              : tr('act.failed');
      setStatusByHash((prev) => ({ ...prev, [item.hash]: msg }));
    } finally {
      setSlBusy(false);
      setBusyByHash((prev) => ({ ...prev, [item.hash]: false }));
      setSlItem(null);
    }
  }, [app, slItem]);

  /* ---------- SuperRecaw (v0.5.0; two money legs v0.6.3) ---------- */
  const [srcItem, setSrcItem] = useState<TimelineItem | null>(null);
  const [srcBusy, setSrcBusy] = useState(false);
  const [srcBurnItem, setSrcBurnItem] = useState<TimelineItem | null>(null);
  const [srcBurnBusy, setSrcBurnBusy] = useState(false);

  const confirmSuperRecaw = useCallback(async () => {
    if (!srcItem) return;
    const item = srcItem;
    setSrcBusy(true);
    setBusyByHash((prev) => ({ ...prev, [item.hash]: true }));
    app.markMyAction(2, item, true).catch(() => {});
    try {
      await performSuperRecaw(app, { target: item });
      setStatusByHash((prev) => ({
        ...prev,
        [item.hash]: tr('src.done'),
      }));
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      // A burn debt or a payment debt means the recaw DID
      // land — keep it lit; anything else un-lights it.
      if (code !== 'src-burn-pending' && code !== 'src-pay-pending') {
        app.markMyAction(2, item, false).catch(() => {});
      }
      const msg =
        code === 'shortfall'
          ? tr('src.shortfall')
          : code === 'src-burn-pending'
            ? tr('src.burnPending')
            : code === 'src-pay-pending'
              ? tr('src.payPending')
              : code === 'need-name'
                ? tr('compose.needName')
                : tr('act.failed');
      setStatusByHash((prev) => ({ ...prev, [item.hash]: msg }));
    } finally {
      setSrcBusy(false);
      setBusyByHash((prev) => ({ ...prev, [item.hash]: false }));
      setSrcItem(null);
    }
  }, [app, srcItem]);

  const confirmSrcBurn = useCallback(async () => {
    if (!srcBurnItem) return;
    const item = srcBurnItem;
    setSrcBurnBusy(true);
    setBusyByHash((prev) => ({ ...prev, [item.hash]: true }));
    try {
      await performSuperRecawBurn(app, { target: item });
      // v0.6.3: the landed burn hands the debt over to the
      // author payment — say which state the post is in.
      const pay = app.address
        ? await pendingAuthorPayFor(app.address, 'src', item.cawId).catch(
            () => null,
          )
        : null;
      setStatusByHash((prev) => ({
        ...prev,
        [item.hash]: pay ? tr('src.payPending') : tr('src.burnDone'),
      }));
    } catch (e) {
      const msg =
        e instanceof Error && e.message === 'shortfall'
          ? tr('src.burnShortfall')
          : tr('src.burnPending');
      setStatusByHash((prev) => ({ ...prev, [item.hash]: msg }));
    } finally {
      setSrcBurnBusy(false);
      setBusyByHash((prev) => ({ ...prev, [item.hash]: false }));
      setSrcBurnItem(null);
    }
  }, [app, srcBurnItem]);

  /* ---------- Author-payment debt (v0.6.3) ----------
   * Same retry as the timeline: this sheet can only send the
   * plain transfer owed by a SuperLike / SuperRecaw whose
   * defining legs already landed — never a burn, never a
   * recaw. */
  const [payTarget, setPayTarget] = useState<{
    item: TimelineItem;
    kind: AuthorPayKind;
    amountRaw: bigint;
    author: string;
  } | null>(null);
  const [payName, setPayName] = useState('');
  const [payAddr, setPayAddr] = useState('');
  const [payBusy, setPayBusy] = useState(false);

  const openPaySheet = useCallback(
    (
      item: TimelineItem,
      kind: AuthorPayKind,
      amountRaw: bigint,
      author: string,
    ) => {
      // Before any retry the balance is re-checked; short of
      // the owed amount the sheet never opens and the status
      // line says so honestly.
      if (app.oTok !== null && app.oTok.raw < amountRaw) {
        setStatusByHash((prev) => ({
          ...prev,
          [item.hash]: tr('pay.shortfall'),
        }));
        return;
      }
      resolveName(item.senderId)
        .then((n) => setPayName(n ? '@' + n : ''))
        .catch(() => setPayName(''));
      // The sheet names the recipient: the address pinned in
      // the debt record wins; an unresolved record falls back
      // to a fresh owner read for display.
      const short = (a: string) =>
        a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
      setPayAddr(short(author));
      if (!author) {
        nameOwner(item.senderId)
          .then((o) => setPayAddr(short(o)))
          .catch(() => setPayAddr(''));
      }
      setPayTarget({ item, kind, amountRaw, author });
    },
    [app],
  );

  const confirmAuthorPay = useCallback(async () => {
    if (!payTarget) return;
    const { item, kind } = payTarget;
    setPayBusy(true);
    setBusyByHash((prev) => ({ ...prev, [item.hash]: true }));
    try {
      await performAuthorPay(app, { target: item, kind });
      setStatusByHash((prev) => ({
        ...prev,
        [item.hash]: tr('pay.done'),
      }));
    } catch (e) {
      const msg =
        e instanceof Error && e.message === 'shortfall'
          ? tr('pay.shortfall')
          : tr('act.failed');
      setStatusByHash((prev) => ({ ...prev, [item.hash]: msg }));
    } finally {
      setPayBusy(false);
      setBusyByHash((prev) => ({ ...prev, [item.hash]: false }));
      setPayTarget(null);
    }
  }, [app, payTarget]);

  /* ---------- Tip (v0.5.0) ---------- */
  const [tipItem, setTipItem] = useState<TimelineItem | null>(null);
  const [tipName, setTipName] = useState('');
  const [tipRecipient, setTipRecipient] = useState<string | null>(null);
  const [tipBusy, setTipBusy] = useState(false);

  const handleTip = useCallback(
    (item: TimelineItem) => {
      if (app.myTokens.some((t) => t.id === item.senderId)) {
        setStatusByHash((prev) => ({
          ...prev,
          [item.hash]: tr('tip.self'),
        }));
        return;
      }
      resolveName(item.senderId)
        .then((n) => setTipName(n ? '@' + n : ''))
        .catch(() => setTipName(''));
      /* M1: recipient for the sheet's spot-check line —
       * performTip re-resolves and cross-checks at send. */
      setTipRecipient(null);
      nameOwner(item.senderId)
        .then((a) => setTipRecipient(a))
        .catch(() => setTipRecipient(null));
      setTipItem(item);
    },
    [app],
  );

  const confirmTip = useCallback(
    async (amountRaw: bigint) => {
      if (!tipItem) return;
      const item = tipItem;
      setTipBusy(true);
      setBusyByHash((prev) => ({ ...prev, [item.hash]: true }));
      try {
        await performTip(app, { target: item, amountRaw });
        setStatusByHash((prev) => ({
          ...prev,
          [item.hash]: tr('tip.done'),
        }));
      } catch (e) {
        const msg =
          e instanceof Error && e.message === 'self-tip'
            ? tr('tip.self')
            : e instanceof Error && e.message === 'shortfall'
              ? tr('tip.shortfall')
              : e instanceof Error && e.message === 'recipient-mismatch'
                ? tr('tip.mismatch')
                : tr('act.failed');
        setStatusByHash((prev) => ({ ...prev, [item.hash]: msg }));
      } finally {
        setTipBusy(false);
        setBusyByHash((prev) => ({ ...prev, [item.hash]: false }));
        setTipItem(null);
      }
    },
    [app, tipItem],
  );

  const confirmFollow = useCallback(async () => {
    if (profileId === null) return;
    setFollowBusy(true);
    app.markFollowed(profileId, true).catch(() => {});
    try {
      await performAction(app, {
        kind: 3,
        receiverId: profileId,
        text: 'FOLLOW',
      });
      setFollowStatus(tr('act.followed'));
      setFollowers((f) => (f === null ? f : f + 1n));
    } catch (e) {
      app.markFollowed(profileId, false).catch(() => {});
      const msg =
        e instanceof Error && e.message === 'need-name'
          ? tr('compose.needName')
          : e instanceof Error && e.message === 'self-follow'
            ? tr('act.selfFollow')
            : tr('act.failed');
      setFollowStatus(msg);
    } finally {
      setFollowBusy(false);
      setFollowConfirmOpen(false);
    }
  }, [app, profileId]);

  const backRow = (
    <View style={styles.backRow}>
      <Pressable onPress={onBack} hitSlop={8}>
        <Text style={styles.backText}>{backArrow()} {tr('common.back')}</Text>
      </Pressable>
    </View>
  );

  if (loadState === 'loading') {
    return (
      <View style={rootStyle}>
        {backRow}
        <View style={styles.center}>
          <ActivityIndicator color={ACCENT} />
          <Text style={[S.small, { marginTop: 10 }]}>
            {tr('common.loading')}
          </Text>
        </View>
      </View>
    );
  }

  if (loadState === 'fail') {
    return (
      <View style={rootStyle}>
        {backRow}
        <View style={styles.center}>
          <Text style={S.err}>{tr('profile.loadFail')}</Text>
          <Pressable
            style={[S.ghostBtn, { marginTop: 14 }]}
            onPress={loadProfile}
          >
            <Text style={S.ghostBtnText}>{tr('profile.retry')}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (loadState === 'notfound') {
    return (
      <View style={rootStyle}>
        {backRow}
        <View style={styles.center}>
          <Text style={S.body}>{tr('profile.notFound')}</Text>
        </View>
      </View>
    );
  }

  let mintLabel: string | null = null;
  if (mintDate) {
    try {
      mintLabel = new Date(mintDate).toLocaleDateString(LOCALES[lang]);
    } catch {
      mintLabel = mintDate;
    }
  }

  const header = (
    <View>
      {backRow}
      {serverMedia?.header ? (
        <Image
          source={{ uri: serverMedia.header.url }}
          style={styles.banner}
          resizeMode="cover"
        />
      ) : custom && custom.headerPath ? (
        <Image
          source={{ uri: custom.headerPath }}
          style={styles.banner}
          resizeMode="cover"
        />
      ) : (
        <LinearGradient
          colors={['#e8590c', '#ffb59e']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.banner}
        />
      )}
      {/* X-style header row: avatar overlapping the banner on the
          left, the page's main action (edit / follow) on the right. */}
      <View style={styles.avatarRow}>
        <View style={styles.avatarWrap}>
          {profileId !== null ? (
            <View style={styles.avatarRing}>
              <Avatar
                key={'avatar-' + mediaTick}
                nameId={profileId}
                size={96}
                customUri={custom ? custom.avatarPath : undefined}
              />
            </View>
          ) : null}
        </View>
        <View style={styles.headerAction}>
          {isOwn || isMine ? (
            <Pressable
              style={({ pressed }) => [
                S.ghostBtn,
                pressed && { backgroundColor: '#f7f9f9' },
              ]}
              onPress={openEditor}
            >
              <Text style={S.ghostBtnText}>{tr('custom.edit')}</Text>
            </Pressable>
          ) : followedByMe ? (
            <View style={styles.followingPill}>
              <Text style={styles.followingPillText}>
                ✓ {tr('act.following')}
              </Text>
            </View>
          ) : acting ? (
            <Pressable
              style={({ pressed }) => [
                S.darkBtn,
                pressed && { opacity: 0.85 },
              ]}
              onPress={() => setFollowConfirmOpen(true)}
            >
              <Text style={S.darkBtnText}>{tr('act.follow')}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <View style={{ paddingHorizontal: 16 }}>
        {custom && custom.displayName ? (
          <>
            <Text style={styles.username}>{custom.displayName}</Text>
            <Text style={S.small}>@{resolvedName}</Text>
          </>
        ) : (
          <Text style={styles.username}>@{resolvedName}</Text>
        )}

        {custom && custom.bio ? (
          <Text style={[S.body, { marginTop: 8 }]}>{custom.bio}</Text>
        ) : null}

        {/* Profile audio (v0.7.3, media server): a play/pause
            row on ANY profile that published one. The player
            itself lives with the state above; this is just the
            button. */}
        {audioUrl ? (
          <Pressable
            style={({ pressed }) => [
              styles.audioRow,
              pressed && { backgroundColor: '#f7f9f9' },
            ]}
            onPress={toggleAudio}
            accessibilityRole="button"
          >
            <Text style={styles.audioGlyph}>
              {audioStatus.playing ? '❚❚' : '▶'}
            </Text>
            <Text style={[S.body, { marginStart: 9 }]}>
              {tr('media.audio')}
            </Text>
          </Pressable>
        ) : null}

        {isOwn || isMine ? (
          <Text style={[S.ok, { marginTop: 6 }]}>{tr('profile.yourName')}</Text>
        ) : null}
        {followStatus ? (
          <Text style={[S.small, { marginTop: 6 }]}>{followStatus}</Text>
        ) : null}

        <View style={styles.chipRow}>
          {profileId !== null ? (
            <View style={S.chip}>
              <Text style={S.chipText}>#{profileId.toString()}</Text>
            </View>
          ) : null}
          {balance !== null ? (
            <View style={S.chip}>
              <Text style={S.chipText}>
                {tr('profile.inName')} {fmtAmount(balance)} CAW
              </Text>
            </View>
          ) : null}
          {mintLabel ? (
            <View style={S.chip}>
              <Text style={S.chipText}>
                {tr('profile.nameMade')} {mintLabel}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Following / followers counts — tappable, X-style. The
            followers number is the chain's own count; the lists
            behind both numbers are rebuilt from the public follow
            records (followIndex.ts). */}
        <View style={styles.countsRow}>
          <Pressable
            onPress={() => openFollowList('following')}
            hitSlop={6}
            style={({ pressed }) => [styles.countCell, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.countNum}>
              {followLists ? followLists.following.length : '—'}
            </Text>
            <Text style={S.tiny}>{tr('followlist.following')}</Text>
          </Pressable>
          <View style={styles.countDivider} />
          <Pressable
            onPress={() => openFollowList('followers')}
            hitSlop={6}
            style={({ pressed }) => [styles.countCell, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.countNum}>
              {followers !== null ? followers.toString() : '—'}
            </Text>
            <Text style={S.tiny}>{tr('followlist.followers')}</Text>
          </Pressable>
        </View>

        {/* Sanction notice (v0.7.9): a plain statement for
            every viewer when this name is frozen or banned
            — no reason is ever shown. Admins additionally
            get the expiry and the Lift button right here. */}
        {profSanction ? (
          <View
            style={{
              marginTop: 16,
              borderWidth: 1,
              borderColor: '#f0b429',
              backgroundColor: '#fff8e1',
              borderRadius: 12,
              padding: 12,
            }}
          >
            <Text style={[S.body, { fontWeight: '700' }]}>
              {profSanction.kind === 'freeze'
                ? tr('sanct.frozenNote')
                : tr('sanct.bannedNote')}
            </Text>
            {mod.isAdmin ? (
              <>
                {profSanction.kind === 'freeze' &&
                profSanction.until !== null ? (
                  <Text style={[S.small, { marginTop: 4 }]}>
                    {tr('sanct.until', {
                      date: new Date(
                        profSanction.until,
                      ).toLocaleString(),
                    })}
                  </Text>
                ) : null}
                <Pressable
                  onPress={() =>
                    profileId !== null &&
                    setSanctPending({
                      verb: 'lift',
                      nameId: profileId.toString(),
                    })
                  }
                  hitSlop={6}
                  style={{ marginTop: 8, alignSelf: 'flex-start' }}
                >
                  <Text style={styles.modBtnText}>
                    {tr('sanct.liftBtn')}
                  </Text>
                </Pressable>
              </>
            ) : null}
          </View>
        ) : null}

        {/* Sanction controls (v0.7.9, admins only): freeze
            for 24h / 7d / 30d, or ban outright. A name owned
            by an admin cannot be sanctioned — the server
            refuses and the refusal shows in the note. */}
        {mod.isAdmin && profileId !== null && !profSanction ? (
          <View style={{ marginTop: 16 }}>
            <Text style={S.h2}>{tr('sanct.applyTitle')}</Text>
            <View
              style={[
                S.row,
                { marginTop: 8, gap: 16, flexWrap: 'wrap' },
              ]}
            >
              {(
                [
                  ['24h', 'sanct.dur24h'],
                  ['7d', 'sanct.dur7d'],
                  ['30d', 'sanct.dur30d'],
                ] as const
              ).map(([dur, key]) => (
                <Pressable
                  key={dur}
                  onPress={() =>
                    setSanctPending({
                      verb: 'freeze',
                      dur,
                      nameId: profileId.toString(),
                    })
                  }
                  hitSlop={6}
                >
                  <Text style={styles.modBtnText}>
                    {tr('sanct.freezeBtn')} · {tr(key)}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                onPress={() =>
                  setSanctPending({
                    verb: 'ban',
                    nameId: profileId.toString(),
                  })
                }
                hitSlop={6}
              >
                <Text
                  style={[styles.modBtnText, { color: '#b3261e' }]}
                >
                  {tr('sanct.banBtn')}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {/* Media moderation (v0.7.6, admins only): one row
            per media kind this profile has — or has hidden.
            A visible item's buttons pin its CURRENT hash
            (from the media layer's own read); a hidden item
            stays listed from the server's hidden-media list
            so the hide can be undone right here. */}
        {mod.isAdmin && profileId !== null ? (
          <View style={{ marginTop: 16 }}>
            <Text style={S.h2}>{tr('mod.mediaTitle')}</Text>
            {(['icon', 'header', 'audio'] as MediaKind[]).map(
              (kind) => {
                const hiddenEntry = profHiddenMedia[kind];
                const current = serverMedia?.[kind] ?? null;
                const currentHash = current
                  ? hashFromMediaUrl(current.url)
                  : null;
                if (!hiddenEntry && !currentHash) return null;
                const label =
                  kind === 'icon'
                    ? tr('mod.kindIcon')
                    : kind === 'header'
                      ? tr('mod.kindHeader')
                      : tr('media.audio');
                return (
                  <View
                    key={kind}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      marginTop: 8,
                    }}
                  >
                    <Text style={[S.body, { flex: 1 }]}>
                      {label}
                      {hiddenEntry
                        ? ' · ' + tr('mod.hiddenBadge')
                        : ''}
                    </Text>
                    {hiddenEntry ? (
                      <>
                        <Pressable
                          onPress={() =>
                            setModMediaPending({
                              kind,
                              verb: 'unhide',
                              hash: hiddenEntry.hash,
                            })
                          }
                          hitSlop={6}
                        >
                          <Text style={styles.modBtnText}>
                            {tr('mod.unhideBtn')}
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() =>
                            setModMediaPending({
                              kind,
                              verb: 'delete',
                              hash: hiddenEntry.hash,
                            })
                          }
                          hitSlop={6}
                        >
                          <Text
                            style={[
                              styles.modBtnText,
                              { color: '#b3261e' },
                            ]}
                          >
                            {tr('mod.deleteBtn')}
                          </Text>
                        </Pressable>
                      </>
                    ) : (
                      <>
                        <Pressable
                          onPress={() =>
                            setModMediaPending({
                              kind,
                              verb: 'hide',
                              hash: currentHash as string,
                            })
                          }
                          hitSlop={6}
                        >
                          <Text style={styles.modBtnText}>
                            {tr('mod.hideMediaBtn')}
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() =>
                            setModMediaPending({
                              kind,
                              verb: 'delete',
                              hash: currentHash as string,
                            })
                          }
                          hitSlop={6}
                        >
                          <Text
                            style={[
                              styles.modBtnText,
                              { color: '#b3261e' },
                            ]}
                          >
                            {tr('mod.deleteBtn')}
                          </Text>
                        </Pressable>
                      </>
                    )}
                  </View>
                );
              },
            )}
            {modMediaNote ? (
              <Text style={[S.small, { marginTop: 8 }]}>
                {modMediaNote}
              </Text>
            ) : null}
          </View>
        ) : null}

        <Text style={[S.h2, { marginTop: 18, marginBottom: 4 }]}>
          {tr('profile.posts')}
        </Text>
      </View>
    </View>
  );

  return (
    <View style={rootStyle}>
      <FlatList
        data={visiblePosts}
        keyExtractor={(item, idx) => item.hash + ':' + idx}
        ListHeaderComponent={header}
        renderItem={({ item }) => (
          <PostCard
            item={item}
            lang={lang}
            onOpenProfile={(name) => app.openProfile(name)}
            onAction={handleAction}
            onSuperlike={handleSuperlike}
            onTip={handleTip}
            onBookmark={app.toggleBookmark}
            isBookmarked={app.isBookmarked}
            onOpenPost={(it) => app.openPost(it)}
            onReply={(it) => app.openCompose({ kind: 'reply', post: it })}
            actionStatus={statusByHash[item.hash]}
            busy={!!busyByHash[item.hash]}
            liked={app.hasMyAction(1, item)}
            recawed={app.hasMyAction(2, item)}
            custom={app.customFor(item.senderId)}
            modAdmin={mod.isAdmin}
            modHiddenFor={mod.isPostHidden}
            modHiddenAttFor={mod.hiddenAttHashesFor}
            onModTogglePost={mod.isAdmin ? onModTogglePost : undefined}
            onModAttach={mod.isAdmin ? onModAttach : undefined}
            modSanctionFor={mod.sanctionFor}
            onModUnsanction={mod.isAdmin ? onModUnsanction : undefined}
            attTick={attTicks[item.cawId.toLowerCase()] ?? 0}
          />
        )}
        ListEmptyComponent={
          loadingPosts ? (
            <View style={styles.center}>
              <ActivityIndicator color={ACCENT} />
              <Text style={[S.small, { marginTop: 10 }]}>
                {tr('profile.searching')}
              </Text>
            </View>
          ) : (
            <View style={{ paddingHorizontal: 16 }}>
              <View style={S.emptyCard}>
                <Text style={S.small}>{tr('profile.empty')}</Text>
              </View>
            </View>
          )
        }
        ListFooterComponent={
          !done && visiblePosts.length > 0 ? (
            <LoadMoreFooter
              loading={loadingMore}
              onPress={loadMorePosts}
              label={tr('profile.more')}
            />
          ) : undefined
        }
        windowSize={7}
        maxToRenderPerBatch={12}
        removeClippedSubviews
      />

      <ConfirmSheet
        visible={!!pending}
        title={
          pending
            ? pending.kind === 1
              ? tr('act.confirmLike', { name: actingLabel })
              : tr('act.confirmShare', { name: actingLabel })
            : ''
        }
        confirmLabel={
          pending
            ? pending.kind === 1
              ? tr('act.like')
              : tr('act.share')
            : ''
        }
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmAction}
        onCancel={() => setPending(null)}
        busy={pending ? !!busyByHash[pending.item.hash] : false}
      />
      <ConfirmSheet
        visible={!!slItem}
        title={tr('sl.title')}
        body={
          slItem
            ? tr('sl.body', {
                name: slName || '—',
                addr: slOwner || '—',
                total: fmtAmountCardDec(SUPERLIKE_TOTAL_RAW, 18),
                author: fmtAmountCardDec(SUPERLIKE_AUTHOR_RAW, 18),
                burn: fmtAmountCardDec(SUPERLIKE_BURN_RAW, 18),
                balance: oBalanceText(),
              })
            : ''
        }
        confirmLabel={tr('sl.confirm')}
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmSuperlike}
        onCancel={() => setSlItem(null)}
        busy={slBusy}
      />
      <ConfirmSheet
        visible={!!srcItem}
        title={tr('src.title')}
        body={
          srcItem
            ? app.myTokens.some((t) => t.id === srcItem.senderId)
              ? tr('src.bodySelf', {
                  burn: fmtAmountCardDec(SUPERRECAW_BURN_RAW, 18),
                  balance: oBalanceText(),
                })
              : tr('src.body', {
                  total: fmtAmountCardDec(SUPERRECAW_TOTAL_RAW, 18),
                  author: fmtAmountCardDec(SUPERRECAW_AUTHOR_RAW, 18),
                  burn: fmtAmountCardDec(SUPERRECAW_BURN_RAW, 18),
                  balance: oBalanceText(),
                })
            : ''
        }
        confirmLabel={tr('src.confirm')}
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmSuperRecaw}
        onCancel={() => setSrcItem(null)}
        busy={srcBusy}
      />
      <ConfirmSheet
        visible={!!srcBurnItem}
        title={tr('src.burnTitle')}
        body={
          srcBurnItem
            ? tr('src.burnBody', {
                price: fmtAmountCardDec(SUPERRECAW_BURN_RAW, 18),
                balance: oBalanceText(),
              })
            : ''
        }
        confirmLabel={tr('src.burnConfirm')}
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmSrcBurn}
        onCancel={() => setSrcBurnItem(null)}
        busy={srcBurnBusy}
      />
      <ConfirmSheet
        visible={!!payTarget}
        title={tr('pay.title')}
        body={
          payTarget
            ? tr('pay.body', {
                amount: fmtAmountCardDec(payTarget.amountRaw, 18),
                name: payName || '—',
                addr: payAddr || '—',
                balance: oBalanceText(),
              })
            : ''
        }
        confirmLabel={
          payTarget
            ? tr('pay.confirm', {
                amount: fmtAmountCardDec(payTarget.amountRaw, 18),
              })
            : tr('pay.title')
        }
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmAuthorPay}
        onCancel={() => setPayTarget(null)}
        busy={payBusy}
      />
      <TipSheet
        visible={!!tipItem}
        authorLabel={tipName}
        recipient={tipRecipient}
        balanceRaw={app.hawk ? app.hawk.raw : null}
        busy={tipBusy}
        onConfirm={confirmTip}
        onCancel={() => setTipItem(null)}
      />
      <ConfirmSheet
        visible={!!modPostPending}
        title={
          modPostPending
            ? mod.isPostHidden(modPostPending.cawId)
              ? tr('mod.unhideTitle')
              : tr('mod.hideTitle')
            : ''
        }
        body={
          modPostPending && !mod.isPostHidden(modPostPending.cawId)
            ? tr('mod.hideNote')
            : undefined
        }
        confirmLabel={
          modPostPending
            ? mod.isPostHidden(modPostPending.cawId)
              ? tr('mod.unhideBtn')
              : tr('mod.hideBtn')
            : ''
        }
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmModPost}
        onCancel={() => setModPostPending(null)}
        busy={modBusy}
      />
      <ConfirmSheet
        visible={!!modAttPending}
        title={
          modAttPending
            ? modAttPending.verb === 'delete'
              ? tr('mod.deleteTitle')
              : modAttPending.verb === 'hide'
                ? tr('mod.hideMediaTitle')
                : tr('mod.unhideMediaTitle')
            : ''
        }
        body={
          modAttPending && modAttPending.verb === 'delete'
            ? tr('mod.deleteWarn')
            : undefined
        }
        confirmLabel={
          modAttPending
            ? modAttPending.verb === 'delete'
              ? tr('mod.deleteBtn')
              : modAttPending.verb === 'hide'
                ? tr('mod.hideMediaBtn')
                : tr('mod.unhideBtn')
            : ''
        }
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmModAtt}
        onCancel={() => setModAttPending(null)}
        busy={modBusy}
      />
      <ConfirmSheet
        visible={!!modMediaPending}
        title={
          modMediaPending
            ? modMediaPending.verb === 'delete'
              ? tr('mod.deleteTitle')
              : modMediaPending.verb === 'hide'
                ? tr('mod.hideMediaTitle')
                : tr('mod.unhideMediaTitle')
            : ''
        }
        body={
          modMediaPending && modMediaPending.verb === 'delete'
            ? tr('mod.deleteWarn')
            : undefined
        }
        confirmLabel={
          modMediaPending
            ? modMediaPending.verb === 'delete'
              ? tr('mod.deleteBtn')
              : modMediaPending.verb === 'hide'
                ? tr('mod.hideMediaBtn')
                : tr('mod.unhideBtn')
            : ''
        }
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmModMedia}
        onCancel={() => setModMediaPending(null)}
        busy={modBusy}
      />
      <ConfirmSheet
        visible={!!sanctPending}
        title={
          sanctPending
            ? sanctPending.verb === 'freeze'
              ? tr('sanct.freezeTitle')
              : sanctPending.verb === 'ban'
                ? tr('sanct.banTitle')
                : tr('sanct.liftTitle')
            : ''
        }
        body={
          sanctPending
            ? sanctPending.verb === 'freeze'
              ? tr('sanct.freezeNote') +
                ' (' +
                tr(
                  sanctPending.dur === '7d'
                    ? 'sanct.dur7d'
                    : sanctPending.dur === '30d'
                      ? 'sanct.dur30d'
                      : 'sanct.dur24h',
                ) +
                ')'
              : sanctPending.verb === 'ban'
                ? tr('sanct.banNote')
                : tr('sanct.liftNote')
            : undefined
        }
        confirmLabel={
          sanctPending
            ? sanctPending.verb === 'freeze'
              ? tr('sanct.freezeBtn')
              : sanctPending.verb === 'ban'
                ? tr('sanct.banBtn')
                : tr('sanct.liftBtn')
            : ''
        }
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmSanction}
        onCancel={() => setSanctPending(null)}
        busy={sanctBusy}
      />
      <Modal
        visible={!!recawChoice}
        transparent
        animationType="slide"
        onRequestClose={() => setRecawChoice(null)}
      >
        <View style={styles.choiceBackdrop}>
          <View style={[styles.choiceSheet, { paddingBottom: 30 + insets.bottom }]}>
            <Text style={S.h2}>{tr('act.recawChoiceTitle')}</Text>
            <View style={{ height: 16 }} />
            <Pressable
              style={S.bigBtn}
              onPress={() => {
                const it = recawChoice;
                setRecawChoice(null);
                if (it) setPending({ kind: 2, item: it });
              }}
            >
              <Text style={S.bigBtnText}>{tr('act.share')}</Text>
            </Pressable>
            <View style={{ height: 10 }} />
            <Pressable
              style={[S.bigBtn, { backgroundColor: '#d6336c' }]}
              onPress={() => {
                const it = recawChoice;
                setRecawChoice(null);
                if (it) {
                  // The gate mirrors the flow — the
                  // full 5,000,000 total (SUPERRECAW_TOTAL_RAW), or the burn alone
                  // for one's own post (no author leg exists).
                  const need = app.myTokens.some(
                    (t) => t.id === it.senderId,
                  )
                    ? SUPERRECAW_BURN_RAW
                    : SUPERRECAW_TOTAL_RAW;
                  if (app.oTok !== null && app.oTok.raw < need) {
                    setStatusByHash((prev) => ({
                      ...prev,
                      [it.hash]: tr('src.shortfall'),
                    }));
                    return;
                  }
                  setSrcItem(it);
                }
              }}
            >
              <View style={[S.row, { alignItems: 'center', gap: 6 }]}>
                <StarIcon size={16} color="#fff" filled />
                <Text style={S.bigBtnText}>
                  {tr('tl.superRecaw')}（
                  {fmtAmountCardDec(SUPERRECAW_TOTAL_RAW, 18)} O）
                </Text>
              </View>
            </Pressable>
            <View style={{ height: 10 }} />
            <Pressable
              style={S.ghostBtn}
              onPress={() => {
                const it = recawChoice;
                setRecawChoice(null);
                if (it) app.openCompose({ kind: 'quote', post: it });
              }}
            >
              <Text style={S.ghostBtnText}>{tr('act.quoteRecaw')}</Text>
            </Pressable>
            <View style={{ height: 10 }} />
            <Pressable
              style={S.ghostBtn}
              onPress={() => setRecawChoice(null)}
            >
              <Text style={S.ghostBtnText}>{tr('compose.cancel')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      <ConfirmSheet
        visible={followConfirmOpen}
        title={tr('act.confirmFollow', {
          name: actingLabel,
          target: '@' + resolvedName,
        })}
        confirmLabel={tr('act.follow')}
        cancelLabel={tr('compose.cancel')}
        onConfirm={confirmFollow}
        onCancel={() => setFollowConfirmOpen(false)}
        busy={followBusy}
      />

      {/* Following / followers list */}
      <Modal
        visible={listOpen !== null}
        animationType="slide"
        onRequestClose={() => setListOpen(null)}
      >
        <View style={rootStyle}>
          <View style={styles.backRow}>
            <Pressable onPress={() => setListOpen(null)} hitSlop={8}>
              <Text style={styles.backText}>{backArrow()} {tr('common.back')}</Text>
            </Pressable>
            <Text style={styles.listTitle}>@{resolvedName}</Text>
          </View>
          <View style={styles.tabRow}>
            {(['following', 'followers'] as const).map((t) => (
              <Pressable
                key={t}
                style={styles.tabItem}
                onPress={() => setListOpen(t)}
              >
                <Text
                  style={[
                    styles.tabLabel,
                    listOpen === t && styles.tabLabelOn,
                  ]}
                >
                  {t === 'following'
                    ? tr('followlist.following')
                    : tr('followlist.followers')}
                  {'  '}
                  {t === 'following'
                    ? followLists
                      ? followLists.following.length
                      : ''
                    : followers !== null
                      ? followers.toString()
                      : ''}
                </Text>
                {listOpen === t ? <View style={styles.tabBar} /> : null}
              </Pressable>
            ))}
          </View>
          {(followLists === null && !listFail) ||
          (listLoading && !followIndexReady() && followLists === null) ? (
            <View style={styles.center}>
              <ActivityIndicator color={ACCENT} />
              <Text style={[S.small, { marginTop: 10 }]}>
                {tr('followlist.loading')}
              </Text>
            </View>
          ) : listFail ? (
            <View style={styles.center}>
              <Text style={S.err}>{tr('followlist.loadFail')}</Text>
              <Pressable
                style={[S.ghostBtn, { marginTop: 14 }]}
                onPress={() => {
                  if (profileId === null) return;
                  setListFail(false);
                  setListLoading(true);
                  loadFollowLists(profileId)
                    .catch(() => setListFail(true))
                    .finally(() => setListLoading(false));
                }}
              >
                <Text style={S.ghostBtnText}>{tr('profile.retry')}</Text>
              </Pressable>
            </View>
          ) : (
            <FlatList
              data={
                followLists
                  ? listOpen === 'following'
                    ? followLists.following
                    : followLists.followers
                  : []
              }
              keyExtractor={(id) => id.toString()}
              renderItem={({ item }) => (
                <FollowRow
                  id={item}
                  customUri={
                    app.customFor(item)
                      ? app.customFor(item)!.avatarPath
                      : undefined
                  }
                  onOpen={(name) => {
                    setListOpen(null);
                    app.openProfile(name);
                  }}
                />
              )}
              ListHeaderComponent={
                followProgress !== null ? (
                  <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                    <Text style={S.tiny}>
                      {tr('followlist.building', {
                        pages: String(followProgress),
                      })}
                    </Text>
                  </View>
                ) : undefined
              }
              ListEmptyComponent={
                <View style={{ padding: 24, alignItems: 'center' }}>
                  <Text style={S.small}>{tr('followlist.empty')}</Text>
                </View>
              }
              windowSize={7}
              maxToRenderPerBatch={16}
            />
          )}
        </View>
      </Modal>

      <Modal
        visible={editOpen}
        animationType="slide"
        onRequestClose={() => setEditOpen(false)}
      >
        <View style={rootStyle}>
          <View style={styles.backRow}>
            <Pressable onPress={() => setEditOpen(false)} hitSlop={8}>
              <Text style={styles.backText}>{backArrow()} {tr('common.back')}</Text>
            </Pressable>
          </View>
          <View style={S.scrollPad}>
            <Text style={S.h1}>{tr('custom.title')}</Text>
            <Text style={[S.small, { marginTop: 8 }]}>{tr('custom.note')}</Text>

            <Text style={S.h2}>{tr('custom.displayName')}</Text>
            <TextInput
              style={[S.input, { marginTop: 8 }]}
              value={editName}
              onChangeText={setEditName}
              placeholder={tr('custom.displayNamePh')}
              maxLength={40}
              autoCorrect={false}
            />
            <Text style={[S.h2, { marginTop: 18 }]}>{tr('custom.bio')}</Text>
            <TextInput
              style={[S.input, { marginTop: 8, minHeight: 72, textAlignVertical: 'top' }]}
              value={editBio}
              onChangeText={setEditBio}
              placeholder={tr('custom.bioPh')}
              maxLength={160}
              multiline
              autoCorrect={false}
            />
            <Pressable
              style={[S.bigBtn, { marginTop: 12 }, editBusy && S.disabled]}
              disabled={editBusy}
              onPress={saveTexts}
            >
              <Text style={S.bigBtnText}>{tr('custom.save')}</Text>
            </Pressable>

            <View style={{ height: 18 }} />
            <Pressable
              style={[S.ghostBtn, editBusy && S.disabled]}
              disabled={editBusy}
              onPress={() => pickImage('avatar')}
            >
              <Text style={S.ghostBtnText}>
                {tr('custom.pickAvatar')}
                {(custom && custom.avatarPath) || serverMedia?.icon
                  ? ''
                  : '（' + tr('custom.notSet') + '）'}
              </Text>
            </Pressable>
            <View style={{ height: 10 }} />
            <Pressable
              style={[S.ghostBtn, editBusy && S.disabled]}
              disabled={editBusy}
              onPress={() => pickImage('header')}
            >
              <Text style={S.ghostBtnText}>
                {tr('custom.pickHeader')}
                {(custom && custom.headerPath) || serverMedia?.header
                  ? ''
                  : '（' + tr('custom.notSet') + '）'}
              </Text>
            </Pressable>
            {/* Shared media (v0.7.3): unlike the display name
                and bio above, pictures and audio are published
                for everyone — the note says so where the user
                acts on it. */}
            <Text style={[S.small, { marginTop: 12 }]}>
              {tr('media.note')}
            </Text>

            <Text style={[S.h2, { marginTop: 18 }]}>
              {tr('media.audio')}
            </Text>
            <View style={{ height: 8 }} />
            <Pressable
              style={[S.ghostBtn, editBusy && S.disabled]}
              disabled={editBusy}
              onPress={pickAudio}
            >
              <Text style={S.ghostBtnText}>
                {tr('media.pickAudio')}
                {serverMedia?.audio
                  ? ''
                  : '（' + tr('custom.notSet') + '）'}
              </Text>
            </Pressable>
            {serverMedia?.audio ? (
              <>
                <View style={{ height: 10 }} />
                <Pressable
                  style={[S.ghostBtn, editBusy && S.disabled]}
                  disabled={editBusy}
                  onPress={removeAudio}
                >
                  <Text style={S.ghostBtnText}>
                    {tr('media.removeAudio')}
                  </Text>
                </Pressable>
              </>
            ) : null}

            {editNote ? (
              <Text style={[S.err, { marginTop: 14 }]}>{editNote}</Text>
            ) : null}

            <View style={{ height: 18 }} />
            <Pressable
              style={[S.ghostBtn, editBusy && S.disabled]}
              disabled={editBusy}
              onPress={resetCustom}
            >
              <Text style={S.ghostBtnText}>{tr('custom.reset')}</Text>
            </Pressable>
            {editBusy ? (
              <ActivityIndicator color={ACCENT} style={{ marginTop: 16 }} />
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

/** One row in the following / followers list. */
function FollowRow({
  id,
  customUri,
  onOpen,
}: {
  id: bigint;
  customUri?: string | null;
  onOpen: (name: string) => void;
}) {
  const label = useNameLabel(id);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    resolveName(id).then((n) => live && setName(n));
    return () => {
      live = false;
    };
  }, [id]);
  return (
    <Pressable
      style={({ pressed }) => [
        styles.followRow,
        pressed && { backgroundColor: '#f7f9f9' },
      ]}
      onPress={name ? () => onOpen(name) : undefined}
    >
      <Avatar nameId={id} size={44} customUri={customUri} />
      <View style={{ marginStart: 10, flex: 1 }}>
        <Text style={styles.followName}>{label}</Text>
        <Text style={S.tiny}>#{id.toString()}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /* Recaw choice sheet (v0.4.0) — same bottom-sheet language as
   * the shared ConfirmSheet. */
  choiceBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  choiceSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    paddingBottom: 30,
  },
  backRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
    backgroundColor: '#fff',
  },
  backText: { fontSize: 15, color: ACCENT, fontWeight: '600' },
  banner: { height: 110 },
  /* Profile audio playback row (v0.7.3). */
  audioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#cfd9de',
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
    backgroundColor: '#fff',
  },
  audioGlyph: { fontSize: 14, color: ACCENT, fontWeight: '700' },
  avatarRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
  },
  avatarWrap: { marginTop: -48 },
  headerAction: { paddingTop: 10 },
  avatarRing: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  followingPill: {
    borderWidth: 1,
    borderColor: '#cfd9de',
    borderRadius: 999,
    paddingVertical: 9,
    paddingHorizontal: 16,
    backgroundColor: '#fff',
  },
  followingPillText: { fontSize: 14, fontWeight: '700', color: '#0f1419' },
  username: { fontSize: 20, fontWeight: '800', color: '#0f1419', marginTop: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  /* Media moderation rows (v0.7.6): the small text buttons
   * (Hide / Unhide / Delete) beside each media kind. */
  modBtnText: {
    fontSize: 13.5,
    fontWeight: '700',
    color: ACCENT,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  countsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#eff3f4',
    borderRadius: 14,
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  countCell: { flex: 1, alignItems: 'center', paddingVertical: 10, gap: 1 },
  countDivider: { width: 1, backgroundColor: '#eff3f4' },
  countNum: { fontSize: 16, fontWeight: '800', color: '#0f1419' },
  listTitle: { fontSize: 16, fontWeight: '800', color: '#0f1419', marginTop: 6 },
  tabRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
  },
  tabItem: { flex: 1, alignItems: 'center', paddingTop: 12, paddingBottom: 0 },
  tabLabel: { fontSize: 14.5, fontWeight: '600', color: '#536471', paddingBottom: 10 },
  tabLabelOn: { color: '#0f1419', fontWeight: '800' },
  tabBar: {
    height: 3,
    width: '70%',
    borderRadius: 2,
    backgroundColor: ACCENT,
    marginBottom: -1,
  },
  followRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eff3f4',
    backgroundColor: '#fff',
  },
  followName: { fontSize: 15, fontWeight: '700', color: '#0f1419' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
