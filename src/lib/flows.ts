/**
 * HuntersSwap flow state — what the guided execution is doing, kept
 * on the device so closing the app mid-flow loses nothing.
 *
 * Shape mirrors the DEX aggregator's guided cross-chain flow: an
 * entry phase (swap on BSC/Ethereum, bridge to 42 Chain, wait for
 * arrival), then the back half as a list of parts (one part for a
 * single route, several for a split plan). Each part walks
 * swap1 (42) -> bridge (42->QL1) -> wait -> swap2 (QL1) -> done,
 * exactly like the aggregator's per-part step counter.
 *
 * All amounts are decimal strings (BigInt-safe JSON). Pure logic +
 * injected storage, verifiable in Node like the other stores.
 */
import type { KVStorage } from './myActions';

export type FlowPhase =
  | 'entrySwap'
  | 'entryBridge'
  | 'wait42'
  | 'back'
  | 'done';

/** Per-part progress: 0 swap1, 1 bridge, 2 wait, 3 swap2, 4 done. */
export type PartStep = 0 | 1 | 2 | 3 | 4;

export interface FlowPart {
  /** Bridge pair symbol this part travels as (QOM / CAW / ...). */
  sym: string;
  /** Share of the back-half input, percent (informational). */
  pct: number;
  /** USDT (42 Chain, 18 dec) this part starts with, as a string. */
  usdtIn: string;
  leg1Path: string[] | null;
  leg2Path: string[] | null;
  step: PartStep;
  /** Amount of the pair token sent over the bridge (string). */
  bridgedAmount?: string;
  /** QL1 balance of the pair token before this part's bridge. */
  dstBalanceBefore?: string;
}

export interface HuntersFlow {
  v: 1;
  id: string;
  address: string;
  entry: 'bsc' | 'ethereum';
  /** Native coin amount put in at the entry (string, 18 dec). */
  entryAmountRaw: string;
  /** USDT the entry swap is expected to make (string, entry dec). */
  entryUsdtExpected: string;
  /** USDT expected on 42 Chain after the -2 bridge deduction. */
  usdt42Expected: string;
  /** qCAW the user confirmed on the confirm screen (string). */
  confirmedOut: string;
  choice: 'single' | 'split';
  phase: FlowPhase;
  /** Entry USDT balance (source chain) before the entry swap. */
  entryUsdtBefore?: string;
  /** 42 Chain USDT balance before the entry bridge send. */
  usdt42Before?: string;
  /** True once the [42] carve-out swap has run (or was unneeded). */
  carveDone: boolean;
  /** USDT (42) set aside for the carve swap, as a string. */
  carveUsdtCost?: string;
  parts: FlowPart[];
  createdAt: number;
  updatedAt: number;
}

export function newFlow(init: Omit<HuntersFlow, 'v' | 'phase' | 'carveDone' | 'parts' | 'updatedAt'>): HuntersFlow {
  return {
    ...init,
    v: 1,
    phase: 'entrySwap',
    carveDone: false,
    parts: [],
    updatedAt: Date.now(),
  };
}

/** The next thing the user (or the watcher) has to do. */
export type NextStep =
  | { kind: 'entrySwap' }
  | { kind: 'entryBridge' }
  | { kind: 'wait42' }
  | { kind: 'carve' }
  | { kind: 'part'; partIdx: number; step: PartStep }
  | { kind: 'done' };

export function nextStep(flow: HuntersFlow): NextStep {
  switch (flow.phase) {
    case 'entrySwap':
      return { kind: 'entrySwap' };
    case 'entryBridge':
      return { kind: 'entryBridge' };
    case 'wait42':
      return { kind: 'wait42' };
    case 'done':
      return { kind: 'done' };
    case 'back': {
      if (!flow.carveDone) return { kind: 'carve' };
      for (let i = 0; i < flow.parts.length; i++) {
        if (flow.parts[i].step < 4) return { kind: 'part', partIdx: i, step: flow.parts[i].step };
      }
      return { kind: 'done' };
    }
  }
}

export function flowComplete(flow: HuntersFlow): boolean {
  return (
    flow.phase === 'done' ||
    (flow.phase === 'back' &&
      flow.carveDone &&
      flow.parts.every((p) => p.step >= 4))
  );
}

export function touch(flow: HuntersFlow): HuntersFlow {
  return { ...flow, updatedAt: Date.now() };
}

/* ---------------- persistence ---------------- */

const KEY_PREFIX = 'caw-huntersflow-';

export class HuntersFlowStore {
  private kv: KVStorage | null = null;
  private storageKey: string | null = null;

  async init(kv: KVStorage, address: string): Promise<void> {
    this.kv = kv;
    this.storageKey = KEY_PREFIX + address.toLowerCase();
  }

  async load(): Promise<HuntersFlow | null> {
    if (!this.kv || !this.storageKey) return null;
    try {
      const raw = await this.kv.getItem(this.storageKey);
      if (!raw) return null;
      const f = JSON.parse(raw) as HuntersFlow;
      if (!f || f.v !== 1 || typeof f.phase !== 'string') return null;
      return f;
    } catch {
      return null;
    }
  }

  async save(flow: HuntersFlow | null): Promise<void> {
    if (!this.kv || !this.storageKey) return;
    try {
      if (flow === null) {
        await this.kv.setItem(this.storageKey, '');
      } else {
        await this.kv.setItem(this.storageKey, JSON.stringify(touch(flow)));
      }
    } catch {
      /* persistence is best-effort; the chain state is the truth */
    }
  }

  async clear(): Promise<void> {
    await this.save(null);
  }
}
