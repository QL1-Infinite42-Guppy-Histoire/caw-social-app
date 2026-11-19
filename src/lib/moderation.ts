/**
 * Moderation state (v0.7.6) — the session's view of the media
 * server's admin world, mirroring the web viewer v38:
 *
 *   - the admin list and THIS wallet's role on it (the role
 *     gates every moderation control in the UI; non-admins
 *     never see the tools at all);
 *   - the hidden-post set (display-level filter — the posts
 *     stay on-chain; our frontends just do not render them
 *     for non-admins);
 *   - the hidden-MEDIA list, read through the signed
 *     `list-hidden` admin op, which is the durable truth:
 *     any hidden icon / header / audio / attachment can be
 *     unhidden or deleted from the list in ANY session.
 *
 * The store is a plain module-level snapshot + listeners
 * (the markedBurns pattern): AppContext triggers refreshes
 * (app start, wallet change, unlock, a 60 s tick), screens
 * subscribe through useModeration(). Every read resolves
 * quietly — a down media server changes nothing on screen
 * and keeps the last good snapshot.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Wallet } from 'ethers';

import { tr } from '../i18n';
import {
  MediaApiError,
  adminOp,
  adminOpErrorKey,
  fetchAdmins,
  fetchHiddenPosts,
  listHiddenMedia,
  type AdminEntry,
  type AdminOpFields,
  type AdminRole,
  type HiddenMediaEntry,
  type MediaKind,
} from './mediaApi';
import { signerFor } from './wallet';
import type { WalletKind } from './walletStore';

export interface WalletSecretLike {
  kind: WalletKind;
  secret: string;
}

export interface ModSnapshot {
  admins: AdminEntry[];
  role: AdminRole | null;
  hiddenPosts: Set<string>;
  hiddenMedia: HiddenMediaEntry[];
}

const EMPTY: ModSnapshot = {
  admins: [],
  role: null,
  hiddenPosts: new Set<string>(),
  hiddenMedia: [],
};

let snapshot: ModSnapshot = EMPTY;
const listeners = new Set<() => void>();

export function subscribeModeration(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

export function moderationSnapshot(): ModSnapshot {
  return snapshot;
}

export function isPostHidden(cawId: string | null | undefined): boolean {
  return !!cawId && snapshot.hiddenPosts.has(String(cawId).toLowerCase());
}

/** Hidden profile-media entries for one name, by kind. */
export function hiddenMediaForProfile(
  nameId: bigint | string | number,
): Partial<Record<MediaKind, HiddenMediaEntry>> {
  const out: Partial<Record<MediaKind, HiddenMediaEntry>> = {};
  for (const e of snapshot.hiddenMedia) {
    if (e.kind !== 'attach' && e.nameId === String(nameId)) {
      out[e.kind] = e;
    }
  }
  return out;
}

/** Hidden attachment entries for one post (newest first). */
export function hiddenAttachEntries(cawId: string): HiddenMediaEntry[] {
  const key = String(cawId).toLowerCase();
  return snapshot.hiddenMedia.filter(
    (e) => e.kind === 'attach' && e.cawId === key,
  );
}

let refreshInFlight: Promise<void> | null = null;

/**
 * Re-read the admin world: the admin list + hidden posts
 * (public GETs), this wallet's role from its address, and —
 * when the wallet is an admin AND its secret is in memory —
 * the hidden-media list (a signed op). A failed read keeps
 * the last good piece; the promise never rejects.
 */
export function refreshModeration(
  address: string | null,
  secret: WalletSecretLike | null,
): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const [admins, posts] = await Promise.all([
        fetchAdmins(),
        fetchHiddenPosts(),
      ]);
      const me = address ? address.toLowerCase() : null;
      const nextAdmins = admins ?? snapshot.admins;
      const mine = me
        ? nextAdmins.find((a) => a.address === me) ?? null
        : null;
      const role = mine ? mine.role : null;
      let hiddenMedia = snapshot.hiddenMedia;
      if (role && secret) {
        try {
          hiddenMedia = await listHiddenMedia(
            signerFor(secret.kind, secret.secret),
          );
        } catch {
          /* keep the last good list */
        }
      } else if (!role) {
        hiddenMedia = [];
      }
      const nextPosts =
        posts !== null
          ? new Set(posts)
          : snapshot.hiddenPosts;
      const changed =
        nextAdmins !== snapshot.admins ||
        role !== snapshot.role ||
        nextPosts !== snapshot.hiddenPosts ||
        hiddenMedia !== snapshot.hiddenMedia;
      snapshot = {
        admins: nextAdmins,
        role,
        hiddenPosts: nextPosts,
        hiddenMedia,
      };
      if (changed) notify();
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Re-read ONLY the hidden-media list (after a media op, so
 *  the list on screen reconciles with the server's truth). */
export async function refreshHiddenMedia(
  secret: WalletSecretLike | null,
): Promise<void> {
  if (!secret || !snapshot.role) return;
  try {
    const hiddenMedia = await listHiddenMedia(
      signerFor(secret.kind, secret.secret),
    );
    snapshot = { ...snapshot, hiddenMedia };
    notify();
  } catch {
    /* keep the last good list */
  }
}

/** Optimistic local update after a successful post op — the
 *  next refresh reconciles with the server either way. */
export function applyPostHidden(cawId: string, hidden: boolean): void {
  const key = String(cawId).toLowerCase();
  if (snapshot.hiddenPosts.has(key) === hidden) return;
  const next = new Set(snapshot.hiddenPosts);
  if (hidden) next.add(key);
  else next.delete(key);
  snapshot = { ...snapshot, hiddenPosts: next };
  notify();
}

function mediaKey(e: HiddenMediaEntry): string {
  return e.kind === 'attach'
    ? 'att:' + e.cawId + ':' + e.hash
    : 'prof:' + e.nameId + ':' + e.kind;
}

/** Optimistic local update after a successful media hide —
 *  the entry appears in the hidden list at once; the
 *  follow-up refresh replaces it with the server's own. */
export function applyMediaHidden(entry: HiddenMediaEntry): void {
  const key = mediaKey(entry);
  snapshot = {
    ...snapshot,
    hiddenMedia: [
      entry,
      ...snapshot.hiddenMedia.filter((e) => mediaKey(e) !== key),
    ],
  };
  notify();
}

/** Optimistic local update after a successful unhide/delete. */
export function applyMediaUnhidden(entry: HiddenMediaEntry): void {
  const key = mediaKey(entry);
  snapshot = {
    ...snapshot,
    hiddenMedia: snapshot.hiddenMedia.filter((e) => mediaKey(e) !== key),
  };
  notify();
}

/**
 * Run one admin op with the wallet secret (the media-write
 * pattern: the app is unlocked, the secret is in memory, the
 * ConfirmSheet WAS the confirmation). Rejects with
 * MediaApiError — map it for display with modErrorText.
 */
export async function runAdminOp(
  secret: WalletSecretLike | null,
  fields: AdminOpFields,
): Promise<Record<string, unknown>> {
  if (!secret) throw new MediaApiError(401, 'locked');
  const signer: Wallet = signerFor(secret.kind, secret.secret);
  return adminOp(signer, fields);
}

/** The display text for a failed admin op — the mapped,
 *  translated error for the server's rejection (the web's
 *  per-status wording), never the raw server string. */
export function modErrorText(e: unknown): string {
  if (e instanceof MediaApiError) {
    const key = adminOpErrorKey(e.status, e.serverError);
    switch (key) {
      case 'notAdmin':
        return tr('mod.errNotAdmin');
      case 'rootOnly':
        return tr('mod.errRootOnly');
      case 'changed':
        return tr('mod.errChanged');
      case 'notFound':
        return tr('mod.errNotFound');
      case 'sig':
        return tr('mod.errSig');
      case 'throttle':
        return tr('mod.errThrottle');
      case 'bad':
        return tr('mod.errBad');
      default:
        return tr('mod.errFail');
    }
  }
  return tr('mod.errFail');
}

/** Subscribe a component to the moderation snapshot. The two
 *  per-item lookups are memoised on the underlying set/list,
 *  so memoized post cards re-render exactly when the hidden
 *  data changes — not on every screen render. */
export function useModeration(): ModSnapshot & {
  isAdmin: boolean;
  isRoot: boolean;
  isPostHidden: (cawId: string | null | undefined) => boolean;
  hiddenAttHashesFor: (cawId: string) => string[];
} {
  const [snap, setSnap] = useState<ModSnapshot>(snapshot);
  useEffect(() => subscribeModeration(() => setSnap(snapshot)), []);
  const isPostHidden = useCallback(
    (cawId: string | null | undefined) =>
      !!cawId && snap.hiddenPosts.has(String(cawId).toLowerCase()),
    [snap.hiddenPosts],
  );
  const hiddenAttHashesFor = useCallback(
    (cawId: string) => {
      const key = String(cawId).toLowerCase();
      return snap.hiddenMedia
        .filter((e) => e.kind === 'attach' && e.cawId === key)
        .map((e) => e.hash);
    },
    [snap.hiddenMedia],
  );
  return {
    ...snap,
    isAdmin: !!snap.role,
    isRoot: snap.role === 'root',
    isPostHidden,
    hiddenAttHashesFor,
  };
}
