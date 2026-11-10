import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';
import React, {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { Lang, getLang, isLang, setLang, tr } from '../i18n';
import {
  nameCountOf,
  setActionObserver,
  subscribeOwnedTokens,
  tokensOf,
  walletBalances,
  type TimelineItem,
  type TokenBalance,
} from '../lib/cawApi';
import type { NameToken } from '../lib/cawCore';
import type { PostRefKind } from '../lib/postRef';

/** What the composer is aimed at (v0.4.0): a reply to, or a
 *  quote Recaw of, an existing post. */
export interface ComposeTarget {
  kind: PostRefKind;
  post: TimelineItem;
}
import { initDrafts } from '../lib/drafts';
import { initFollowIndex } from '../lib/followIndex';
import { initSuperlikeStore } from '../lib/superlike';
import {
  directoryName,
  hydrateNameDirectory,
  initNameDirectory,
} from '../lib/nameDirectory';
import type { MyActionKind } from '../lib/myActions';
import type { ProfileCustom } from '../lib/profileCustom';
import { applyLayoutDirection } from '../lib/rtl';
import { myActionStore, profileCustomStore, storeKV } from '../lib/stores';
import {
  UnlockMethod,
  authenticate,
  getUnlockMethod,
  getWalletPublicInfo,
  listWallets,
  loadWalletSecret,
  setActiveWallet,
  verifyPassword,
  type WalletKind,
  type WalletPublicInfo,
} from '../lib/walletStore';

export type Tab = 'home' | 'get' | 'mine' | 'settings';

export interface WalletSecretLoaded {
  kind: WalletKind;
  secret: string;
}

interface PwPromptState {
  resolve: (ok: boolean) => void;
}

export interface AppContextValue {
  lang: Lang;
  changeLang: (l: Lang) => void;
  ready: boolean;
  hasWallet: boolean;
  address: string | null;
  locked: boolean;
  unlockMethod: UnlockMethod;
  /** Mark onboarding complete (wallet saved + unlock set up). */
  completeOnboarding: () => Promise<void>;
  /** Unlock the app (biometric, or password via the prompt modal). */
  unlock: () => Promise<boolean>;
  /** Fresh authentication before a signature; true when passed. */
  requireAuth: () => Promise<boolean>;
  lock: () => void;
  /** The wallet secret (only after unlock). Null while locked. */
  getSecret: () => WalletSecretLoaded | null;
  /* balances */
  qom: bigint | null;
  qcaw: bigint | null;
  /** The same wallet's 42 Chain balances (v0.4.8): native [42]
   *  and CAT42 (SuperLike). Same null rule as qom/qcaw — null is
   *  "no successful read yet", never a value. */
  f42: bigint | null;
  cat42: bigint | null;
  /** O (Childhoods End, on QL1) and KET (42 Chain) balances
   *  (v0.4.10), each with the decimals its contract reports.
   *  Same null rule: null is "no successful read yet". */
  oTok: TokenBalance | null;
  ket: TokenBalance | null;
  refreshBalances: () => Promise<void>;
  /* acting (posting) name, remembered per account like the web version */
  actingId: bigint | null;
  myTokens: NameToken[];
  /** True once a fresh enumeration for the CURRENT wallet has
   *  completed (v0.4.5). Until then an empty myTokens means
   *  "still reading", never "this wallet has no names". */
  myTokensReady: boolean;
  refreshMyTokens: () => Promise<NameToken[]>;
  chooseActing: (id: bigint) => void;
  /* my like / share / follow state, remembered on this device */
  hasMyAction: (kind: MyActionKind, item: TimelineItem) => boolean;
  hasFollowed: (nameId: bigint) => boolean;
  markMyAction: (
    kind: MyActionKind,
    item: TimelineItem,
    on: boolean,
  ) => Promise<void>;
  markFollowed: (nameId: bigint, on: boolean) => Promise<void>;
  /* off-chain profile customization for my own names */
  customFor: (id: bigint) => ProfileCustom | undefined;
  saveCustom: (
    id: bigint,
    patch: Partial<ProfileCustom>,
  ) => Promise<ProfileCustom>;
  clearCustom: (id: bigint) => Promise<ProfileCustom | undefined>;
  /* wallets (v0.2.0: several can be kept on this phone) */
  wallets: WalletPublicInfo[];
  /** Switch the active wallet (asks for authentication first). */
  switchWallet: (address: string) => Promise<boolean>;
  /** Re-read the wallet registry after an add/delete in Settings. */
  refreshWalletState: () => Promise<void>;
  /* navigation */
  tab: Tab;
  setTab: (t: Tab) => void;
  /** One-shot hand-off to the My names screen (v0.4.6): the id
   *  whose deposit/withdraw controls should open expanded.
   *  Set by focusMine, consumed (and cleared) by MyNamesScreen
   *  on mount — it never persists, so a later plain visit to
   *  the tab opens nothing. */
  mineFocusId: bigint | null;
  focusMine: (id: bigint) => void;
  clearMineFocus: () => void;
  profileName: string | null;
  openProfile: (username: string) => void;
  closeProfile: () => void;
  postDetail: TimelineItem | null;
  openPost: (item: TimelineItem) => void;
  closePost: () => void;
  composeOpen: boolean;
  setComposeOpen: (open: boolean) => void;
  /** Reply / quote target for the composer (v0.4.0): the post a
   *  new post will reference. Null for a plain new post. */
  composeTarget: ComposeTarget | null;
  /** Open the composer, optionally targeted at a post. */
  openCompose: (target?: ComposeTarget | null) => void;
  /** Close the composer and forget its target. */
  closeCompose: () => void;
  /* password prompt plumbing (rendered by App) */
  pwPrompt: PwPromptState | null;
  answerPwPrompt: (password: string | null) => Promise<void>;
  onWalletDeleted: () => void;
}

const Ctx = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

const LANG_KEY = 'caw-app-lang';
const actingKey = (addr: string) => 'caw-acting-' + addr.toLowerCase();

export function AppProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(getLang());
  const [ready, setReady] = useState(false);
  const [hasWallet, setHasWallet] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [locked, setLocked] = useState(true);
  const [unlockMethod, setUnlockMethod] = useState<UnlockMethod>('biometric');
  const [qom, setQom] = useState<bigint | null>(null);
  const [qcaw, setQcaw] = useState<bigint | null>(null);
  const [f42, setF42] = useState<bigint | null>(null);
  const [cat42, setCat42] = useState<bigint | null>(null);
  const [oTok, setOTok] = useState<TokenBalance | null>(null);
  const [ket, setKet] = useState<TokenBalance | null>(null);
  const [actingId, setActingId] = useState<bigint | null>(null);
  const [myTokens, setMyTokens] = useState<NameToken[]>([]);
  const [myTokensReady, setMyTokensReady] = useState(false);
  /** Which wallet the saved my-names snapshot was last painted
   *  for (v0.4.5), so a wallet switch re-paints from its own
   *  snapshot instead of reusing the previous wallet's. */
  const tokensPaintedFor = useRef<string | null>(null);
  const myTokensRef = useRef<NameToken[]>([]);
  useEffect(() => {
    myTokensRef.current = myTokens;
  }, [myTokens]);
  const [tab, setTab] = useState<Tab>('home');
  const [mineFocusId, setMineFocusId] = useState<bigint | null>(null);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [postDetail, setPostDetail] = useState<TimelineItem | null>(null);
  const [composeTarget, setComposeTarget] = useState<ComposeTarget | null>(null);
  const [wallets, setWallets] = useState<WalletPublicInfo[]>([]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [pwPrompt, setPwPrompt] = useState<PwPromptState | null>(null);
  const [, setStoreTick] = useState(0);
  const secretRef = useRef<WalletSecretLoaded | null>(null);
  const addressRef = useRef<string | null>(null);

  /* ---------- on-device stores (my actions + profile looks) ---------- */
  useEffect(() => {
    const bump = () => setStoreTick((t) => t + 1);
    const off1 = myActionStore.subscribe(bump);
    const off2 = profileCustomStore.subscribe(bump);
    setActionObserver((a) => myActionStore.observe(a));
    profileCustomStore.init(storeKV).catch(() => {});
    initNameDirectory(storeKV);
    initFollowIndex(storeKV);
    initDrafts(storeKV);
    initSuperlikeStore(storeKV);
    return () => {
      off1();
      off2();
      setActionObserver(null);
    };
  }, []);

  useEffect(() => {
    if (address) myActionStore.init(storeKV, address).catch(() => {});
    // A new wallet's list is "not read yet" until its own fresh
    // enumeration completes (v0.4.5).
    setMyTokensReady(false);
  }, [address]);

  /* Progressive my-names (v0.4.5): the enumeration reports the
   * names it has already proven (snapshot-shaped partial lists);
   * paint them as they land for the CURRENT wallet. A partial is
   * only ever more complete than the one before, so a simple
   * (count, named-count) comparison keeps the freshest. */
  useEffect(() => {
    return subscribeOwnedTokens((owner, toks) => {
      const addr = addressRef.current;
      if (!addr || owner.toLowerCase() !== addr.toLowerCase()) return;
      setMyTokens((prev) => {
        const score = (l: NameToken[]) =>
          l.length * 100000 + l.filter((t) => t.username).length;
        return score(toks) >= score(prev) ? toks : prev;
      });
    });
  }, []);

  /* ---------- boot ---------- */
  useEffect(() => {
    (async () => {
      try {
        const savedLang = await AsyncStorage.getItem(LANG_KEY);
        if (isLang(savedLang)) {
          setLang(savedLang);
          setLangState(savedLang);
          // RTL (v0.3.9): set the layout direction from the saved
          // language NOW, before `ready` lets any real screen
          // mount — forceRTL only takes effect on a fresh start.
          applyLayoutDirection(savedLang);
        } else {
          // No saved language: pin the default (LTR) direction so
          // a device whose own locale is RTL does not mirror an
          // English UI.
          applyLayoutDirection(getLang());
        }
        const info = await getWalletPublicInfo();
        if (info) {
          setHasWallet(true);
          setAddress(info.address);
          addressRef.current = info.address;
          setUnlockMethod(await getUnlockMethod());
          setWallets(await listWallets());
        } else {
          setLocked(false); // nothing to unlock — onboarding shows
        }
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const changeLang = useCallback((l: Lang) => {
    setLang(l);
    setLangState(l);
    AsyncStorage.setItem(LANG_KEY, l).catch(() => {});
    // Crossing the RTL boundary (to/from Persian) only mirrors
    // after a restart — the flags are set for the next launch;
    // tell the user once, in the language they just picked.
    if (applyLayoutDirection(l)) {
      Alert.alert(tr('app.name'), tr('lang.restartNote'));
    }
  }, []);

  const refreshBalances = useCallback(async () => {
    const addr = addressRef.current;
    if (!addr) return;
    const b = await walletBalances(addr);
    // v0.4.7: a null field means that read failed — never let it
    // overwrite a good value, and before the first successful
    // read the state stays null so the cards render "—", not 0.
    if (b.qom !== null) setQom(b.qom);
    if (b.qcaw !== null) setQcaw(b.qcaw);
    if (b.f42 !== null) setF42(b.f42);
    if (b.cat42 !== null) setCat42(b.cat42);
    if (b.oTok !== null) setOTok(b.oTok);
    if (b.ket !== null) setKet(b.ket);
  }, []);

  const refreshMyTokens = useCallback(async (): Promise<NameToken[]> => {
    const addr = addressRef.current;
    if (!addr) return [];
    // Paint the last saved snapshot first (v0.4.5): a returning
    // wallet sees its names at once and the fresh enumeration
    // below replaces them. A snapshot never marks the list
    // "ready" — only a completed fresh read does.
    if (tokensPaintedFor.current !== addr.toLowerCase()) {
      tokensPaintedFor.current = addr.toLowerCase();
      try {
        const raw = await AsyncStorage.getItem(
          'caw-mytokens-v1-' + addr.toLowerCase(),
        );
        if (raw) {
          const arr = JSON.parse(raw) as {
            id: string;
            balance: string;
            username: string;
          }[];
          if (Array.isArray(arr) && arr.length > 0) {
            setMyTokens(
              arr.map((t) => ({
                id: BigInt(t.id),
                balance: BigInt(t.balance || '0'),
                username: t.username || '',
              })),
            );
          }
        }
      } catch {
        /* a broken snapshot just means a cold paint */
      }
    }
    await hydrateNameDirectory().catch(() => {});
    const toks = await tokensOf(addr, { nameOf: directoryName });
    // A resolved [] can mean a TRUE zero — or a failed enumeration
    // (tokensOf resolves [] on a transient RPC failure, and until
    // v0.4.5 the screen called both "no names"). One cheap
    // balanceOf probe tells them apart: only a proven zero may
    // clear what is painted or mark the list ready.
    if (toks.length === 0) {
      const probe = await nameCountOf(addr).catch(() => null);
      if (probe !== 0n) {
        return myTokensRef.current;
      }
    }
    setMyTokens(toks);
    setMyTokensReady(true);
    myActionStore.registerOwnIds(toks.map((t) => t.id));
    AsyncStorage.setItem(
      'caw-mytokens-v1-' + addr.toLowerCase(),
      JSON.stringify(
        toks.map((t) => ({
          id: t.id.toString(),
          balance: t.balance.toString(),
          username: t.username,
        })),
      ),
    ).catch(() => {});
    // restore the remembered acting name when still owned (web behaviour)
    try {
      const saved = await AsyncStorage.getItem(actingKey(addr));
      if (saved) {
        const id = BigInt(saved);
        if (toks.some((t) => t.id === id)) {
          setActingId(id);
          return toks;
        }
        await AsyncStorage.removeItem(actingKey(addr));
      }
    } catch {
      /* ignore */
    }
    setActingId(toks.length ? toks[0].id : null);
    return toks;
  }, []);

  const chooseActing = useCallback(
    (id: bigint) => {
      setActingId(id);
      const addr = addressRef.current;
      if (addr) {
        AsyncStorage.setItem(actingKey(addr), id.toString()).catch(() => {});
      }
    },
    [],
  );

  const loadSecretIntoMemory = useCallback(async (): Promise<boolean> => {
    const s = await loadWalletSecret();
    if (!s) return false;
    secretRef.current = { kind: s.kind, secret: s.secret };
    return true;
  }, []);

  const askPassword = useCallback((): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setPwPrompt({ resolve });
    });
  }, []);

  const answerPwPrompt = useCallback(
    async (password: string | null) => {
      const prompt = pwPrompt;
      setPwPrompt(null);
      if (!prompt) return;
      if (password === null) {
        prompt.resolve(false);
        return;
      }
      prompt.resolve(await verifyPassword(password));
    },
    [pwPrompt],
  );

  const runAuth = useCallback(async (): Promise<boolean> => {
    const method = await getUnlockMethod();
    setUnlockMethod(method);
    if (method === 'password') return askPassword();
    return authenticate(tr('auth.reason'));
  }, [askPassword]);

  const unlock = useCallback(async (): Promise<boolean> => {
    const ok = await runAuth();
    if (!ok) return false;
    const loaded = await loadSecretIntoMemory();
    if (!loaded) return false;
    setLocked(false);
    refreshBalances();
    refreshMyTokens();
    return true;
  }, [runAuth, loadSecretIntoMemory, refreshBalances, refreshMyTokens]);

  const requireAuth = useCallback(async (): Promise<boolean> => {
    if (locked) return unlock();
    return runAuth();
  }, [locked, runAuth, unlock]);

  const lock = useCallback(() => {
    secretRef.current = null;
    setLocked(true);
  }, []);

  const completeOnboarding = useCallback(async () => {
    const info = await getWalletPublicInfo();
    if (info) {
      setHasWallet(true);
      setAddress(info.address);
      addressRef.current = info.address;
      setUnlockMethod(await getUnlockMethod());
      setWallets(await listWallets());
    }
    await loadSecretIntoMemory();
    setLocked(false);
    refreshBalances();
    refreshMyTokens();
  }, [loadSecretIntoMemory, refreshBalances, refreshMyTokens]);

  /**
   * Sync all wallet-derived state with the registry's active
   * wallet (after a switch / add / delete). The secret of the newly
   * active wallet replaces the in-memory one; per-address stores
   * (my actions, acting name) re-init through the address effect.
   */
  const applyActiveWallet = useCallback(async () => {
    const info = await getWalletPublicInfo();
    setWallets(await listWallets());
    if (!info) return;
    setHasWallet(true);
    setAddress(info.address);
    addressRef.current = info.address;
    const s = await loadWalletSecret(info.address);
    secretRef.current = s ? { kind: s.kind, secret: s.secret } : null;
    setMyTokens([]);
    setActingId(null);
    setMineFocusId(null);
    setProfileName(null);
    setPostDetail(null);
    setComposeOpen(false);
    setComposeTarget(null);
    refreshBalances();
    refreshMyTokens();
  }, [refreshBalances, refreshMyTokens]);

  const switchWallet = useCallback(
    async (target: string): Promise<boolean> => {
      if (
        addressRef.current &&
        target.toLowerCase() === addressRef.current.toLowerCase()
      ) {
        return true;
      }
      const ok = await runAuth();
      if (!ok) return false;
      await setActiveWallet(target);
      await applyActiveWallet();
      setTab('home');
      return true;
    },
    [runAuth, applyActiveWallet],
  );

  const refreshWalletState = useCallback(async () => {
    await applyActiveWallet();
  }, [applyActiveWallet]);

  const actingNow = useCallback((): bigint | null => {
    return actingId ?? (myTokens.length ? myTokens[0].id : null);
  }, [actingId, myTokens]);

  const hasMyAction = useCallback(
    (kind: MyActionKind, item: TimelineItem): boolean =>
      myActionStore.has(kind, actingNow(), item.cawId),
    [actingNow],
  );
  const hasFollowed = useCallback(
    (nameId: bigint): boolean =>
      myActionStore.has(3, actingNow(), nameId.toString()),
    [actingNow],
  );
  const markMyAction = useCallback(
    async (kind: MyActionKind, item: TimelineItem, on: boolean) => {
      const id = actingNow();
      if (id === null) return;
      await myActionStore.set(kind, id, item.cawId, on);
    },
    [actingNow],
  );
  const markFollowed = useCallback(
    async (nameId: bigint, on: boolean) => {
      const id = actingNow();
      if (id === null) return;
      await myActionStore.set(3, id, nameId.toString(), on);
    },
    [actingNow],
  );

  const customFor = useCallback(
    (id: bigint): ProfileCustom | undefined => profileCustomStore.get(id),
    [],
  );
  const saveCustom = useCallback(
    (id: bigint, patch: Partial<ProfileCustom>) =>
      profileCustomStore.set(id, patch),
    [],
  );
  const clearCustom = useCallback(
    (id: bigint) => profileCustomStore.clear(id),
    [],
  );

  const onWalletDeleted = useCallback(() => {
    secretRef.current = null;
    addressRef.current = null;
    myActionStore.reset();
    setHasWallet(false);
    setAddress(null);
    setWallets([]);
    setQom(null);
    setQcaw(null);
    setF42(null);
    setCat42(null);
    setMyTokens([]);
    setMyTokensReady(false);
    tokensPaintedFor.current = null;
    setActingId(null);
    setMineFocusId(null);
    setLocked(false);
    setTab('home');
    setProfileName(null);
    setPostDetail(null);
    setComposeOpen(false);
    setComposeTarget(null);
  }, []);

  const focusMine = useCallback((id: bigint) => {
    setMineFocusId(id);
    setTab('mine');
  }, []);
  const clearMineFocus = useCallback(() => setMineFocusId(null), []);

  const openProfile = useCallback((username: string) => {
    setProfileName(username);
  }, []);
  const closeProfile = useCallback(() => setProfileName(null), []);
  const openPost = useCallback((item: TimelineItem) => {
    setPostDetail(item);
  }, []);
  const closePost = useCallback(() => setPostDetail(null), []);

  const openCompose = useCallback((target?: ComposeTarget | null) => {
    setComposeTarget(target ?? null);
    setComposeOpen(true);
  }, []);
  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    setComposeTarget(null);
  }, []);

  const value: AppContextValue = {
    lang,
    changeLang,
    ready,
    hasWallet,
    address,
    locked,
    unlockMethod,
    completeOnboarding,
    unlock,
    requireAuth,
    lock,
    getSecret: () => secretRef.current,
    qom,
    qcaw,
    f42,
    cat42,
    oTok,
    ket,
    refreshBalances,
    actingId,
    myTokens,
    myTokensReady,
    refreshMyTokens,
    chooseActing,
    hasMyAction,
    hasFollowed,
    markMyAction,
    markFollowed,
    customFor,
    saveCustom,
    clearCustom,
    wallets,
    switchWallet,
    refreshWalletState,
    tab,
    setTab,
    mineFocusId,
    focusMine,
    clearMineFocus,
    profileName,
    openProfile,
    closeProfile,
    postDetail,
    openPost,
    closePost,
    composeOpen,
    setComposeOpen,
    composeTarget,
    openCompose,
    closeCompose,
    pwPrompt,
    answerPwPrompt,
    onWalletDeleted,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
