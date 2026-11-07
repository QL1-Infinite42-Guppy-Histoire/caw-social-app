import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { Lang, getLang, setLang, tr } from '../i18n';
import { tokensOf, walletBalances } from '../lib/cawApi';
import type { NameToken } from '../lib/cawCore';
import {
  UnlockMethod,
  authenticate,
  getUnlockMethod,
  getWalletPublicInfo,
  loadWalletSecret,
  verifyPassword,
  type WalletKind,
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
  /* navigation */
  tab: Tab;
  setTab: (t: Tab) => void;
  profileName: string | null;
  openProfile: (username: string) => void;
  closeProfile: () => void;
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
  const [composeOpen, setComposeOpen] = useState(false);
  const [pwPrompt, setPwPrompt] = useState<PwPromptState | null>(null);
  const secretRef = useRef<WalletSecretLoaded | null>(null);
  const addressRef = useRef<string | null>(null);

  /* ---------- boot ---------- */
  useEffect(() => {
    (async () => {
      try {
        const savedLang = await AsyncStorage.getItem(LANG_KEY);
        if (savedLang === 'ja' || savedLang === 'en') {
          setLang(savedLang);
          setLangState(savedLang);
        }
        const info = await getWalletPublicInfo();
        if (info) {
          setHasWallet(true);
          setAddress(info.address);
          addressRef.current = info.address;
          setUnlockMethod(await getUnlockMethod());
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
    }
    await loadSecretIntoMemory();
    setLocked(false);
    refreshBalances();
    refreshMyTokens();
  }, [loadSecretIntoMemory, refreshBalances, refreshMyTokens]);

  const onWalletDeleted = useCallback(() => {
    secretRef.current = null;
    addressRef.current = null;
    setHasWallet(false);
    setAddress(null);
    setQom(null);
    setQcaw(null);
    setMyTokens([]);
    setActingId(null);
    setLocked(false);
    setTab('home');
    setProfileName(null);
    setComposeOpen(false);
  }, []);

  const openProfile = useCallback((username: string) => {
    setProfileName(username);
  }, []);
  const closeProfile = useCallback(() => setProfileName(null), []);

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
    tab,
    setTab,
    profileName,
    openProfile,
    closeProfile,
    composeOpen,
    setComposeOpen,
    pwPrompt,
    answerPwPrompt,
    onWalletDeleted,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
