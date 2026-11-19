import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ConfirmSheet, LTR_TEXT, MONO, S } from '../components/ui';
import { ACCENT } from '../config';
import { useApp } from '../context/AppContext';
import { LANGS, tr } from '../i18n';
import { APP_VERSION } from '../lib/appVersion';
import {
  deleteWallet,
  deleteWalletByAddress,
  type WalletPublicInfo,
} from '../lib/walletStore';
import { resolveNameId, tokensOf } from '../lib/cawApi';
import type { AdminEntry, HiddenMediaEntry } from '../lib/mediaApi';
import {
  applyMediaUnhidden,
  applyPostHidden,
  modErrorText,
  refreshModeration,
  runAdminOp,
  useModeration,
} from '../lib/moderation';
import AddWalletModal from './AddWalletModal';
import RevealSecretScreen from './RevealSecretScreen';

export default function SettingsScreen() {
  const app = useApp();
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [revealOpen, setRevealOpen] = useState(false);
  const [deleteOne, setDeleteOne] = useState<WalletPublicInfo | null>(null);
  const [deletingOne, setDeletingOne] = useState(false);
  const [switching, setSwitching] = useState(false);

  /* ---------- Moderation (v0.7.6) ----------
   * Admins (mod/root) get the moderation section: the role
   * definition, the hidden-post list with per-post Unhide,
   * and the hidden-MEDIA list from the server's list-hidden
   * truth (Unhide / Delete per entry — works in any session).
   * The root alone additionally gets the moderator
   * management card: the admin list with roles and resolved
   * names, appoint by CAW name or address, revoke per mod.
   * Mods never see the management card. */
  const mod = useModeration();
  const [modBusy, setModBusy] = useState(false);
  const [modNote, setModNote] = useState('');
  const [adminNote, setAdminNote] = useState('');
  const [unhidePostId, setUnhidePostId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AdminEntry | null>(
    null,
  );
  const [appointInput, setAppointInput] = useState('');
  const [appointPending, setAppointPending] = useState<{
    nameId?: string;
    target?: string;
    label: string;
  } | null>(null);
  const [hiddenMediaPending, setHiddenMediaPending] = useState<{
    entry: HiddenMediaEntry;
    verb: 'unhide' | 'delete';
  } | null>(null);
  const [adminNames, setAdminNames] = useState<
    Record<string, string | null>
  >({});

  useEffect(() => {
    let live = true;
    for (const a of mod.admins) {
      if (adminNames[a.address] !== undefined) continue;
      tokensOf(a.address)
        .then((toks) => {
          if (!live) return;
          const named = toks.find((t) => t.username);
          setAdminNames((prev) => ({
            ...prev,
            [a.address]: named ? named.username : null,
          }));
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.admins]);

  const afterModOp = async () => {
    await refreshModeration(app.address, app.getSecret()).catch(
      () => {},
    );
  };

  const doUnhidePost = async () => {
    if (!unhidePostId) return;
    setModBusy(true);
    try {
      await runAdminOp(app.getSecret(), {
        action: 'unhide-post',
        cawId: unhidePostId,
      });
      applyPostHidden(unhidePostId, false);
      setModNote('');
      await afterModOp();
    } catch (e) {
      setModNote(modErrorText(e));
    } finally {
      setModBusy(false);
      setUnhidePostId(null);
    }
  };

  const doHiddenMediaOp = async () => {
    const p = hiddenMediaPending;
    if (!p) return;
    setModBusy(true);
    try {
      const e = p.entry;
      if (e.kind === 'attach') {
        await runAdminOp(app.getSecret(), {
          action: p.verb + '-attach',
          cawId: e.cawId,
          sha256: e.hash,
        });
      } else {
        await runAdminOp(app.getSecret(), {
          action: p.verb + '-' + e.kind,
          nameId: e.nameId,
          sha256: e.hash,
        });
      }
      applyMediaUnhidden(e);
      setModNote('');
      await afterModOp();
    } catch (err) {
      setModNote(modErrorText(err));
      await afterModOp();
    } finally {
      setModBusy(false);
      setHiddenMediaPending(null);
    }
  };

  const doRevoke = async () => {
    if (!revokeTarget) return;
    setModBusy(true);
    try {
      await runAdminOp(app.getSecret(), {
        action: 'revoke-admin',
        target: revokeTarget.address,
      });
      setAdminNote('');
      await afterModOp();
    } catch (e) {
      setAdminNote(modErrorText(e));
    } finally {
      setModBusy(false);
      setRevokeTarget(null);
    }
  };

  const startAppoint = async () => {
    const raw = appointInput.trim().replace(/^@/, '');
    if (!raw) return;
    if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      setAppointPending({ target: raw.toLowerCase(), label: raw });
      return;
    }
    try {
      const res = await resolveNameId(raw);
      if (res.status === 'ok') {
        setAppointPending({
          nameId: res.id.toString(),
          label: '@' + res.username,
        });
      } else {
        setAdminNote(tr('profile.notFound'));
      }
    } catch {
      setAdminNote(tr('mod.errFail'));
    }
  };

  const doAppoint = async () => {
    if (!appointPending) return;
    setModBusy(true);
    try {
      await runAdminOp(app.getSecret(), {
        action: 'appoint-admin',
        nameId: appointPending.nameId,
        target: appointPending.target,
      });
      setAdminNote('');
      setAppointInput('');
      await afterModOp();
    } catch (e) {
      setAdminNote(modErrorText(e));
    } finally {
      setModBusy(false);
      setAppointPending(null);
    }
  };

  const shortCawId = (id: string) =>
    id.length > 14 ? id.slice(0, 10) + '…' + id.slice(-4) : id;
  const adminLabel = (a: AdminEntry) => {
    const n = adminNames[a.address];
    return n
      ? '@' + n
      : a.address.slice(0, 10) + '…' + a.address.slice(-6);
  };
  const hiddenMediaLabel = (e: HiddenMediaEntry) => {
    if (e.kind === 'attach') {
      return tr('mod.attHidden') + ' · ' + shortCawId(e.cawId);
    }
    const kind =
      e.kind === 'icon'
        ? tr('mod.kindIcon')
        : e.kind === 'header'
          ? tr('mod.kindHeader')
          : tr('media.audio');
    return kind + ' · #' + e.nameId;
  };

  const doDeleteOne = async () => {
    if (!deleteOne) return;
    setDeletingOne(true);
    try {
      const wasLast = app.wallets.length <= 1;
      await deleteWalletByAddress(deleteOne.address);
      if (wasLast) {
        // Removing the final wallet also clears the unlock setup,
        // exactly like the full reset below.
        await deleteWallet();
        app.onWalletDeleted();
      } else {
        await app.refreshWalletState();
      }
    } finally {
      setDeletingOne(false);
      setDeleteOne(null);
    }
  };

  const doSwitch = async (w: WalletPublicInfo) => {
    if (switching) return;
    setSwitching(true);
    try {
      await app.switchWallet(w.address);
    } finally {
      setSwitching(false);
    }
  };

  const doCopy = async () => {
    if (!app.address) return;
    await Clipboard.setStringAsync(app.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      await deleteWallet();
      app.onWalletDeleted();
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <ScrollView style={S.screen} contentContainerStyle={S.scrollPad}>
      <Text style={S.h1}>{tr('settings.title')}</Text>

      {/* language — section card with divider rows (v0.3.8) */}
      <Text style={[S.h2, { marginTop: 22 }]}>{tr('settings.language')}</Text>
      <View style={S.cardFlush}>
        {LANGS.map((l, i) => (
          <Pressable
            key={l.code}
            style={[
              styles.langRow,
              i < LANGS.length - 1 && S.rowDivider,
              app.lang === l.code && styles.langRowOn,
            ]}
            onPress={() => app.changeLang(l.code)}
          >
            <Text style={[S.body, app.lang === l.code && styles.langOn]}>
              {l.label}
            </Text>
            {app.lang === l.code ? <Text style={styles.check}>✓</Text> : null}
          </Pressable>
        ))}
      </View>

      {/* address */}
      <Text style={[S.h2, { marginTop: 24 }]}>{tr('settings.address')}</Text>
      <View style={S.cardBox}>
        {app.address ? (
          <Text style={[S.small, { fontSize: 12.5, fontFamily: MONO }, LTR_TEXT, { textAlign: 'left' }]}>
            {app.address}
          </Text>
        ) : null}
        <View style={[S.row, { marginTop: 10, gap: 12 }]}>
          <Pressable style={S.ghostBtn} onPress={doCopy}>
            <Text style={S.ghostBtnText}>{tr('settings.copy')}</Text>
          </Pressable>
          {copied ? <Text style={S.ok}>{tr('settings.copied')}</Text> : null}
        </View>
      </View>

      {/* backup / secret reveal (v0.3.1) */}
      <Text style={[S.h2, { marginTop: 24 }]}>{tr('settings.backup')}</Text>
      <View style={S.cardBox}>
        <Pressable style={[S.ghostBtn, { alignSelf: 'flex-start' }]} onPress={() => setRevealOpen(true)}>
          <Text style={S.ghostBtnText}>{tr('settings.backup')}</Text>
        </Pressable>
      </View>

      {/* wallets (v0.2.0: several can live on this phone) */}
      <Text style={[S.h2, { marginTop: 24 }]}>{tr('wallets.title')}</Text>
      <View style={S.cardFlush}>
        {app.wallets.map((w, i) => {
          const active =
            app.address &&
            w.address.toLowerCase() === app.address.toLowerCase();
          return (
            <View
              key={w.address}
              style={[
                styles.walletRow,
                i < app.wallets.length - 1 && S.rowDivider,
              ]}
            >
              <Pressable
                style={{ flex: 1 }}
                onPress={() => {
                  if (!active) doSwitch(w);
                }}
              >
                <Text style={[S.body, active && { fontWeight: '700' }]}>
                  {w.address.slice(0, 10)}…{w.address.slice(-6)}
                  {active ? '  ✓' : ''}
                </Text>
                <Text style={S.tiny}>
                  {w.kind === 'mnemonic'
                    ? tr('wallets.kindWords')
                    : tr('wallets.kindKey')}
                  {active ? ' · ' + tr('wallets.inUse') : ''}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setDeleteOne(w)}
                hitSlop={8}
                style={styles.walletDel}
              >
                <Text style={styles.walletDelText}>
                  {tr('wallets.deleteOne')}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>
      <Pressable
        style={[S.ghostBtn, { marginTop: 12, alignSelf: 'flex-start' }]}
        onPress={() => setAddOpen(true)}
      >
        <Text style={S.ghostBtnText}>{tr('wallets.add')}</Text>
      </Pressable>

      {/* lock */}
      <Pressable
        style={[S.darkBtn, { marginTop: 26, alignSelf: 'flex-start' }]}
        onPress={() => app.lock()}
      >
        <Text style={S.darkBtnText}>{tr('settings.lockNow')}</Text>
      </Pressable>

      {/* moderation (v0.7.6 — admins only) */}
      {mod.isAdmin ? (
        <>
          <Text style={[S.h2, { marginTop: 26 }]}>
            {tr('mod.sectionTitle')}
          </Text>
          <View style={S.cardBox}>
            <Text style={S.body}>{tr('mod.roleNote')}</Text>
            <Text style={[S.h2, { marginTop: 16 }]}>
              {tr('mod.hiddenListLbl')}
            </Text>
            {mod.hiddenPosts.size === 0 ? (
              <Text style={[S.small, { marginTop: 6 }]}>
                {tr('mod.noneHidden')}
              </Text>
            ) : (
              [...mod.hiddenPosts].map((id) => (
                <View key={id} style={styles.modRow}>
                  <Text
                    style={[S.body, { flex: 1 }, LTR_TEXT]}
                    numberOfLines={1}
                  >
                    {shortCawId(id)}
                  </Text>
                  <Pressable
                    onPress={() => setUnhidePostId(id)}
                    hitSlop={6}
                  >
                    <Text style={styles.modBtnText}>
                      {tr('mod.unhideBtn')}
                    </Text>
                  </Pressable>
                </View>
              ))
            )}
            <Text style={[S.h2, { marginTop: 16 }]}>
              {tr('mod.hiddenMediaLbl')}
            </Text>
            {mod.hiddenMedia.length === 0 ? (
              <Text style={[S.small, { marginTop: 6 }]}>
                {tr('mod.noneHiddenMedia')}
              </Text>
            ) : (
              mod.hiddenMedia.map((e) => (
                <View
                  key={
                    (e.kind === 'attach'
                      ? 'a:' + e.cawId
                      : 'p:' + e.nameId + ':' + e.kind) +
                    ':' +
                    e.hash
                  }
                  style={styles.modRow}
                >
                  <Text style={[S.body, { flex: 1 }]} numberOfLines={1}>
                    {hiddenMediaLabel(e)}
                  </Text>
                  <Pressable
                    onPress={() =>
                      setHiddenMediaPending({ entry: e, verb: 'unhide' })
                    }
                    hitSlop={6}
                  >
                    <Text style={styles.modBtnText}>
                      {tr('mod.unhideBtn')}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() =>
                      setHiddenMediaPending({ entry: e, verb: 'delete' })
                    }
                    hitSlop={6}
                  >
                    <Text
                      style={[styles.modBtnText, { color: '#b3261e' }]}
                    >
                      {tr('mod.deleteBtn')}
                    </Text>
                  </Pressable>
                </View>
              ))
            )}
            {modNote ? (
              <Text style={[S.small, { marginTop: 10 }]}>{modNote}</Text>
            ) : null}
          </View>
        </>
      ) : null}

      {/* moderator management (v0.7.6 — root only) */}
      {mod.isRoot ? (
        <>
          <Text style={[S.h2, { marginTop: 26 }]}>
            {tr('mod.adminsTitle')}
          </Text>
          <View style={S.cardBox}>
            <Text style={S.body}>{tr('mod.roleNote')}</Text>
            <Text style={[S.small, { marginTop: 8 }]}>
              {tr('mod.appointNote')}
            </Text>
            {mod.admins.map((a) => (
              <View key={a.address} style={styles.modRow}>
                <Text style={[S.body, { flex: 1 }]} numberOfLines={1}>
                  {adminLabel(a)}
                  {'  ·  '}
                  {a.role === 'root'
                    ? tr('mod.roleRoot')
                    : tr('mod.roleMod')}
                </Text>
                {a.role === 'mod' ? (
                  <Pressable
                    onPress={() => setRevokeTarget(a)}
                    hitSlop={6}
                  >
                    <Text
                      style={[styles.modBtnText, { color: '#b3261e' }]}
                    >
                      {tr('mod.revokeBtn')}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
            <Text style={[S.h2, { marginTop: 16 }]}>
              {tr('mod.appointLbl')}
            </Text>
            <TextInput
              style={styles.appointInput}
              value={appointInput}
              onChangeText={setAppointInput}
              placeholder={tr('mod.appointPh')}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              style={[S.bigBtn, { marginTop: 10 }]}
              onPress={startAppoint}
            >
              <Text style={S.bigBtnText}>{tr('mod.appointBtn')}</Text>
            </Pressable>
            {adminNote ? (
              <Text style={[S.small, { marginTop: 10 }]}>
                {adminNote}
              </Text>
            ) : null}
          </View>
        </>
      ) : null}

      {/* about */}
      <Text style={[S.h2, { marginTop: 26 }]}>{tr('settings.about')}</Text>
      <View style={S.cardBox}>
        <Text style={S.body}>{tr('settings.aboutBody')}</Text>
        {/* View counts honesty (v0.6.0): the counts are an
            app-side aggregation, never on-chain — stated here
            in every language, whether or not the counter is
            currently configured. */}
        <Text style={[S.body, { marginTop: 10 }]}>{tr('views.note')}</Text>
        <Text style={[S.tiny, { marginTop: 12 }]}>
          CAW Social v{APP_VERSION}
        </Text>
        <Text style={S.tiny}>one.guppyguide.cawsocial</Text>
      </View>

      {/* danger zone */}
      <Text style={[S.h2, { marginTop: 28, color: '#c62828' }]}>
        {tr('settings.danger')}
      </Text>
      <Pressable
        style={[styles.deleteBtn, { marginTop: 12 }]}
        onPress={() => setConfirmDelete(true)}
      >
        <Text style={styles.deleteBtnText}>{tr('settings.delete')}</Text>
      </Pressable>

      <ConfirmSheet
        visible={confirmDelete}
        title={tr('settings.delete')}
        body={tr('settings.deleteWarn')}
        confirmLabel={tr('settings.deleteConfirm')}
        cancelLabel={tr('settings.cancel')}
        onConfirm={doDelete}
        onCancel={() => {
          if (!deleting) setConfirmDelete(false);
        }}
        busy={deleting}
      />
      <ConfirmSheet
        visible={!!deleteOne}
        title={tr('wallets.deleteOne')}
        body={
          deleteOne
            ? tr('wallets.deleteOneWarn', {
                addr:
                  deleteOne.address.slice(0, 10) +
                  '…' +
                  deleteOne.address.slice(-6),
              })
            : undefined
        }
        confirmLabel={tr('settings.deleteConfirm')}
        cancelLabel={tr('settings.cancel')}
        onConfirm={doDeleteOne}
        onCancel={() => {
          if (!deletingOne) setDeleteOne(null);
        }}
        busy={deletingOne}
      />
      <ConfirmSheet
        visible={!!unhidePostId}
        title={tr('mod.unhideTitle')}
        confirmLabel={tr('mod.unhideBtn')}
        cancelLabel={tr('settings.cancel')}
        onConfirm={doUnhidePost}
        onCancel={() => {
          if (!modBusy) setUnhidePostId(null);
        }}
        busy={modBusy}
      />
      <ConfirmSheet
        visible={!!hiddenMediaPending}
        title={
          hiddenMediaPending
            ? hiddenMediaPending.verb === 'delete'
              ? tr('mod.deleteTitle')
              : tr('mod.unhideMediaTitle')
            : ''
        }
        body={
          hiddenMediaPending && hiddenMediaPending.verb === 'delete'
            ? tr('mod.deleteWarn')
            : undefined
        }
        confirmLabel={
          hiddenMediaPending
            ? hiddenMediaPending.verb === 'delete'
              ? tr('mod.deleteBtn')
              : tr('mod.unhideBtn')
            : ''
        }
        cancelLabel={tr('settings.cancel')}
        onConfirm={doHiddenMediaOp}
        onCancel={() => {
          if (!modBusy) setHiddenMediaPending(null);
        }}
        busy={modBusy}
      />
      <ConfirmSheet
        visible={!!revokeTarget}
        title={tr('mod.revokeTitle')}
        body={
          revokeTarget
            ? adminLabel(revokeTarget) +
              ' · ' +
              revokeTarget.address.slice(0, 10) +
              '…' +
              revokeTarget.address.slice(-6)
            : undefined
        }
        confirmLabel={tr('mod.revokeBtn')}
        cancelLabel={tr('settings.cancel')}
        onConfirm={doRevoke}
        onCancel={() => {
          if (!modBusy) setRevokeTarget(null);
        }}
        busy={modBusy}
      />
      <ConfirmSheet
        visible={!!appointPending}
        title={tr('mod.appointLbl')}
        body={
          appointPending
            ? appointPending.label + ' — ' + tr('mod.appointNote')
            : undefined
        }
        confirmLabel={tr('mod.appointBtn')}
        cancelLabel={tr('settings.cancel')}
        onConfirm={doAppoint}
        onCancel={() => {
          if (!modBusy) setAppointPending(null);
        }}
        busy={modBusy}
      />
      <Modal
        visible={revealOpen}
        animationType="slide"
        onRequestClose={() => setRevealOpen(false)}
      >
        <RevealSecretScreen onClose={() => setRevealOpen(false)} />
      </Modal>
      <Modal
        visible={addOpen}
        animationType="slide"
        onRequestClose={() => setAddOpen(false)}
      >
        <AddWalletModal onClose={() => setAddOpen(false)} />
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  langRowOn: { borderColor: ACCENT, backgroundColor: '#fff7f2' },
  langOn: { fontWeight: '700' },
  check: { fontSize: 15, fontWeight: '700', color: ACCENT },
  deleteBtn: {
    borderWidth: 1,
    borderColor: '#c62828',
    borderRadius: 999,
    paddingVertical: 11,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    backgroundColor: '#fff',
  },
  deleteBtnText: { color: '#c62828', fontSize: 15, fontWeight: '700' },
  walletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 14,
    gap: 10,
  },
  walletDel: { paddingVertical: 6, paddingHorizontal: 4 },
  walletDelText: { color: '#c62828', fontSize: 13.5, fontWeight: '600' },
  /* Moderation (v0.7.6): list rows inside the moderation /
   * moderators cards, their small text buttons, and the
   * appoint input. */
  modRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 6,
  },
  modBtnText: {
    fontSize: 13.5,
    fontWeight: '700',
    color: ACCENT,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  appointInput: {
    borderWidth: 1,
    borderColor: '#cfd9de',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginTop: 10,
    color: '#0f1419',
  },
});
