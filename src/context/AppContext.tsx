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
  setActionObserver,
  tokensOf,
  walletBalances,
  type TimelineItem,
} from '../lib/cawApi';
import type { NameToken } from '../lib/cawCore';
import { initDrafts } from '../lib/drafts';
import { initFollowIndex } from '../lib/followIndex';
import { initNameDirectory } from '../lib/nameDirectory';
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
  refreshBalances: () => Promise<void>;
  /* acting (posting) name, remembered per account like the web version */
  actingId: bigint | null;
  myTokens: NameToken[];
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
  profileName: string | null;
  openProfile: (username: string) => void;
  closeProfile: () => void;
  postDetail: TimelineItem | null;
  openPost: (item: TimelineItem) => void;
  closePost: () => void;
  composeOpen: boolean;
  setComposeOpen: (open: boolean) => void;
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
  const [actingId, setActingId] = useState<bigint | null>(null);
  const [myTokens, setMyTokens] = useState<NameToken[]>([]);
  const [tab, setTab] = useState<Tab>('home');
  const [profileName, setProfileName] = useState<string | null>(null);
  const [postDetail, setPostDetail] = useState<TimelineItem | null>(null);
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
    return () => {
      off1();
      off2();
      setActionObserver(null);
    };
  }, []);

  useEffect(() => {
    if (address) myActionStore.init(storeKV, address).catch(() => {});
  }, [address]);

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
    setQom(b.qom);
    setQcaw(b.qcaw);
  }, []);

  const refreshMyTokens = useCallback(async (): Promise<NameToken[]> => {
    const addr = addressRef.current;
    if (!addr) return [];
    const toks = await tokensOf(addr);
    setMyTokens(toks);
    myActionStore.registerOwnIds(toks.map((t) => t.id));
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
    setProfileName(null);
    setPostDetail(null);
    setComposeOpen(false);
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
    setMyTokens([]);
    setActingId(null);
    setLocked(false);
    setTab('home');
    setProfileName(null);
    setPostDetail(null);
    setComposeOpen(false);
  }, []);

  const openProfile = useCallback((username: string) => {
    setProfileName(username);
  }, []);
  const closeProfile = useCallback(() => setProfileName(null), []);
  const openPost = useCallback((item: TimelineItem) => {
    setPostDetail(item);
  }, []);
  const closePost = useCallback(() => setPostDetail(null), []);

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
    refreshBalances,
    actingId,
    myTokens,
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
    profileName,
    openProfile,
    closeProfile,
    postDetail,
    openPost,
    closePost,
    composeOpen,
    setComposeOpen,
    pwPrompt,
    answerPwPrompt,
    onWalletDeleted,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
