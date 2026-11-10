/**
 * HuntersExchange guided deposit / withdraw flows (v0.5.0
 * formal). "Deposit" in this app means what the user named it:
 * bridge the coin to 42 Chain, then hold it in the Exchange
 * escrow contract. The four flows:
 *
 *   depUsdt  BSC USDT ──bridge──▶ 42 USDT ──▶ escrow
 *            (or start from USDT already in the 42 wallet)
 *   depCaw   QL1 qCAW ──warp────▶ 42 CAW ───▶ escrow
 *            (or start from CAW already in the 42 wallet)
 *   depQom   QL1 QOM ──wrap+bridge──▶ 42 QOM ──▶ escrow
 *            (native QOM wraps to WQOM and bridges; it lands
 *            as the 42-side QOM token. Or start from QOM
 *            already in the 42 wallet)
 *   wdUsdt   escrow ──▶ 42 USDT ──bridge──▶ BSC USDT
 *            (or stop in the 42 wallet)
 *   wdCaw    escrow ──▶ 42 CAW ───warp────▶ QL1 qCAW
 *            (or stop in the 42 wallet)
 *   wdQom    escrow ──▶ 42 QOM ───bridge──▶ QL1 native QOM
 *            (or stop in the 42 wallet)
 *
 * Discipline, mirroring the app's established step/resume
 * rules:
 *  - the step list is FIXED at flow start by (kind, route) —
 *    xStepsFor is the single source of truth, used by the UI,
 *    by resume, and by the verify harness alike;
 *  - every send is confirmed (sendTxReq) BEFORE the step
 *    advances, and the advance is persisted immediately, so a
 *    killed app resumes at the first step that has NOT
 *    completed — a confirmed bridge/deposit/withdraw send is
 *    never re-planned;
 *  - bridge arrivals are judged by balance DELTA against the
 *    baseline recorded just before the bridge send
 *    (xArrivalVerdict) — never by the wallet's total;
 *  - fees are quoted LIVE at send time in the screen layer
 *    (quoteBridgeIn / quoteBridgeOut42 / quoteCawDeliveryFee);
 *    the pure helpers here only shape the setup previews.
 *
 * Amounts are raw base units throughout: USDT flows are kept
 * in 18 dp (BSC USDT, 42 USDT and the escrow all use 18 dp),
 * CAW is 18 dp on both chains.
 */
import { Interface, getAddress, zeroPadValue } from 'ethers';

import { DOMAIN_42 } from './chains';
import { expected42Usdt, toTargetUsdtRaw, type TxReq } from './hunters';
import type { KVStorage } from './myActions';

/** qCAW token on QL1 (the CAW the user holds on QL1). */
export const QCAW_TOKEN_QL1 = '0xd2140E16aDf37194036865E90BbCA1139b739d0D';
/** CAW warp router on QL1 (QL1 -> 42 direction), verified in
 *  ~/workspace/huntersexchange/DESIGN.md: mutually registered
 *  with the 42-side route, lockbox == 42-side supply (1:1),
 *  transferRemote carries no native fee on this direction. */
export const CAW_WARP_ROUTER_QL1 = '0xD14cF03D3753d80a1f6fb818Aa1c728D5c36B3bf';

export type XFlowKind =
  | 'depUsdt'
  | 'depCaw'
  | 'depQom'
  | 'wdUsdt'
  | 'wdCaw'
  | 'wdQom';

export type XStepId =
  | 'bridgeIn' // depUsdt: BSC USDT -> 42 (BridgeRouter)
  | 'bridgeQl1' // depCaw: QL1 qCAW -> 42 (warp transferRemote)
  | 'bridgeQl1Qom' // depQom: QL1 wrap+bridge batch -> 42 QOM
  | 'wait42' // wait for the bridged amount to land on 42
  | 'deposit' // escrow deposit from the 42 wallet
  | 'escrowOut' // escrow withdraw to the 42 wallet
  | 'bridgeOut' // wdUsdt: 42 USDT -> BSC (BridgeRouter, flat fee)
  | 'waitBsc' // wait for the bridged USDT to land on BSC
  | 'deliverQl1' // wdCaw: 42 CAW -> QL1 as qCAW (warp bridgeToken)
  | 'bridge42Qom' // wdQom: 42 QOM -> QL1 (pair BridgeRouter)
  | 'waitQl1'; // wait for native QOM to land on QL1

export interface XFlow {
  v: 1;
  kind: XFlowKind;
  /** Start / destination side, fixed at flow start:
   *  depUsdt 'bsc' | '42'; depCaw 'ql1' | '42';
   *  depQom 'ql1' | '42'; wdUsdt 'bsc' | '42';
   *  wdCaw 'ql1' | '42'; wdQom 'ql1' | '42'. */
  route: string;
  /** Flow token amount, raw (USDT / CAW / QOM, all 18 dp). */
  amountRaw: string;
  /** Index into xStepsFor(kind, route). */
  step: number;
  /** 42-side balance baseline recorded just before a bridge
   *  send toward 42, and the expected arrival (raw). */
  base42?: string;
  expected42?: string;
  /** BSC USDT baseline + expected arrival (wdUsdt to BSC). */
  baseBsc?: string;
  expectedBsc?: string;
  /** QL1 NATIVE QOM baseline + expected arrival (wdQom to
   *  QL1 — the arrival is judged on the native balance). */
  baseQl1?: string;
  expectedQl1?: string;
  /** Hash of the bridge send, once broadcast+confirmed. A flow
   *  whose bridgeHash is set NEVER re-plans its bridge step:
   *  the step index has already advanced past it. */
  bridgeHash?: string;
  savedAt: number;
}

export const XFLOW_KINDS: XFlowKind[] = [
  'depUsdt',
  'depCaw',
  'depQom',
  'wdUsdt',
  'wdCaw',
  'wdQom',
];

/** The QOM pair's bridge entry (aggEngine BRIDGE_PAIRS,
 *  sym 'QOM'): QL1 warp router + the 42-side BridgeRouter.
 *  The bridge's 42-side token is HX_QOM (lib/exchange.ts);
 *  its QL1-side token is WQOM (lib/hunters.ts WQOM_ADDR),
 *  which native QOM wraps into. */
export const QOM_BRIDGE_PAIR = {
  sym: 'QOM',
  br: '0x049a78fe311cf1c23f09cdd4f12420ffc917c8db',
  ql1Router: '0x30da1e7c8de5fa75b593002e0b2d2910ffcadcb6',
};

/** The fixed step sequence of a flow. Bridge steps come
 *  before their wait steps; the escrow step is last for
 *  deposits and first for withdrawals; a flow that starts (or
 *  ends) in the 42 wallet has no bridge steps at all — the
 *  holdings-driven mid-start of the app's standing principle. */
export function xStepsFor(kind: XFlowKind, route: string): XStepId[] {
  switch (kind) {
    case 'depUsdt':
      return route === 'bsc'
        ? ['bridgeIn', 'wait42', 'deposit']
        : ['deposit'];
    case 'depCaw':
      return route === 'ql1'
        ? ['bridgeQl1', 'wait42', 'deposit']
        : ['deposit'];
    case 'depQom':
      return route === 'ql1'
        ? ['bridgeQl1Qom', 'wait42', 'deposit']
        : ['deposit'];
    case 'wdUsdt':
      return route === 'bsc'
        ? ['escrowOut', 'bridgeOut', 'waitBsc']
        : ['escrowOut'];
    case 'wdCaw':
      return route === 'ql1' ? ['escrowOut', 'deliverQl1'] : ['escrowOut'];
    case 'wdQom':
      return route === 'ql1'
        ? ['escrowOut', 'bridge42Qom', 'waitQl1']
        : ['escrowOut'];
  }
}

export function xCurrentStep(flow: XFlow): XStepId | null {
  const steps = xStepsFor(flow.kind, flow.route);
  return flow.step >= 0 && flow.step < steps.length ? steps[flow.step] : null;
}

export function xFlowComplete(flow: XFlow): boolean {
  return xCurrentStep(flow) === null;
}

/** Advance to the next step (pure; returns a new object). */
export function xAdvance(flow: XFlow, now: number): XFlow {
  return { ...flow, step: flow.step + 1, savedAt: now };
}

export function xIsWaitStep(step: XStepId): boolean {
  return step === 'wait42' || step === 'waitBsc' || step === 'waitQl1';
}

export function xTokenOf(kind: XFlowKind): 'usdt' | 'caw' | 'qom' {
  if (kind === 'depUsdt' || kind === 'wdUsdt') return 'usdt';
  if (kind === 'depQom' || kind === 'wdQom') return 'qom';
  return 'caw';
}

/** Holdings-driven default route: a deposit starts from the
 *  outside holding when there is one (the user's named flows),
 *  otherwise from the 42 wallet; a withdrawal defaults to
 *  leaving to the outside chain. The user can always switch —
 *  this only picks the initially selected chip. */
export function xDefaultRoute(
  kind: XFlowKind,
  held: { bscUsdt: bigint; ql1Caw: bigint; ql1Qom?: bigint },
): string {
  switch (kind) {
    case 'depUsdt':
      return held.bscUsdt > 0n ? 'bsc' : '42';
    case 'depCaw':
      return held.ql1Caw > 0n ? 'ql1' : '42';
    case 'depQom':
      return (held.ql1Qom ?? 0n) > 0n ? 'ql1' : '42';
    case 'wdUsdt':
      return 'bsc';
    case 'wdCaw':
      return 'ql1';
    case 'wdQom':
      return 'ql1';
  }
}

/**
 * Arrival verdict from a balance DELTA: arrived only when the
 * destination balance has grown by at least the expected
 * amount over the baseline recorded before the bridge send.
 * Anything less stays 'pending' — a partial or unrelated
 * credit never completes a flow.
 */
export function xArrivalVerdict(
  baseRaw: bigint,
  nowRaw: bigint,
  expectedRaw: bigint,
): 'pending' | 'arrived' {
  if (expectedRaw <= 0n) return 'pending';
  return nowRaw - baseRaw >= expectedRaw ? 'arrived' : 'pending';
}

/** Setup preview for depUsdt from BSC: what should arrive on
 *  42 (the standard −2 USDT arrival deduction). The send
 *  itself re-quotes live. */
export function xPreviewDepUsdtArrival(bscRaw: bigint): bigint {
  return expected42Usdt(bscRaw, 18);
}

/** Setup preview for wdUsdt to BSC: the flat 2 USDT bridge
 *  fee deducted from the forwarded amount. The send itself
 *  re-quotes live (quoteBridgeOut42) and re-checks the fee. */
export function xPreviewWdUsdtArrival(usdt42Raw: bigint): bigint {
  const fee = 2n * 10n ** 18n;
  return usdt42Raw > fee ? usdt42Raw - fee : 0n;
}

/** Expected BSC arrival (BSC raw units) from a live
 *  quoteBridgeOut42 forward figure. */
export function xExpectedBscFromForward(forwardRaw: bigint): bigint {
  return toTargetUsdtRaw(forwardRaw, 'bsc');
}

const WARP_ABI = [
  'function transferRemote(uint32 _destination, bytes32 _recipient, uint256 _amount) payable returns (bytes32)',
];

/** QL1 -> 42 warp send for qCAW: transferRemote on the QL1
 *  warp router, no native value (the measured fee on this
 *  direction is 0). Mirrors the aggregator engine's QL1-side
 *  bridge encoding for the CAW pair. */
export function buildCawBridgeInTx(recipient: string, amount: bigint): TxReq {
  const iface = new Interface(WARP_ABI);
  return {
    to: CAW_WARP_ROUTER_QL1,
    data: iface.encodeFunctionData('transferRemote', [
      DOMAIN_42,
      zeroPadValue(getAddress(recipient), 32),
      amount,
    ]),
    value: 0n,
  };
}

/* ---------------- persistence ---------------- */

const KEY_PREFIX = 'caw-xflow-';

export function serializeXFlow(flow: XFlow): string {
  return JSON.stringify(flow);
}

/** Parse + validate a stored flow. Anything malformed, of an
 *  unknown kind, or pointing past its own step list is
 *  refused (null) rather than resumed into a wrong state. */
export function deserializeXFlow(raw: string | null): XFlow | null {
  if (!raw) return null;
  try {
    const f = JSON.parse(raw) as XFlow;
    if (!f || f.v !== 1) return null;
    if (!XFLOW_KINDS.includes(f.kind)) return null;
    if (typeof f.route !== 'string' || typeof f.amountRaw !== 'string') {
      return null;
    }
    if (!/^\d+$/.test(f.amountRaw)) return null;
    const steps = xStepsFor(f.kind, f.route);
    if (
      typeof f.step !== 'number' ||
      !Number.isInteger(f.step) ||
      f.step < 0 ||
      f.step > steps.length
    ) {
      return null;
    }
    return f;
  } catch {
    return null;
  }
}

/** On-device store for the ONE in-progress exchange flow,
 *  mirroring HuntersFlowStore's shape and discipline. */
export class XFlowStore {
  private kv: KVStorage | null = null;
  private storageKey: string | null = null;

  constructor(private readonly prefix: string = KEY_PREFIX) {}

  async init(kv: KVStorage, address: string): Promise<void> {
    this.kv = kv;
    this.storageKey = this.prefix + address.toLowerCase();
  }

  async load(): Promise<XFlow | null> {
    if (!this.kv || !this.storageKey) return null;
    try {
      return deserializeXFlow(await this.kv.getItem(this.storageKey));
    } catch {
      return null;
    }
  }

  async save(flow: XFlow | null): Promise<void> {
    if (!this.kv || !this.storageKey) return;
    try {
      await this.kv.setItem(
        this.storageKey,
        flow === null ? '' : serializeXFlow(flow),
      );
    } catch {
      /* best-effort persistence, same as the other flow stores */
    }
  }

  async clear(): Promise<void> {
    await this.save(null);
  }
}
