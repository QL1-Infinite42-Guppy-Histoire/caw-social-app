import { CAT42, O_TOKEN } from '../config';
import type { AppContextValue } from '../context/AppContext';
import {
  invalidateFeedHead,
  nameOwner,
  nameOwnerAlt,
  type TimelineItem,
} from './cawApi';
import { isSelfFollowOwners, type CawAction } from './cawCore';
import {
  buildSuperlikeData,
  oBalanceOf,
  refreshSuperlikesFor,
  superlikeBlockReason,
  superlikeShortfall,
} from './superlike';
import {
  buildSuperRecawData,
  clearSrcBurn,
  pendingSrcBurnFor,
  recordSrcBurn,
} from './superRecaw';
import { MARKED_BURN_PRICE_RAW } from './markedBurns';
import {
  buildTipData,
  cat42BalanceOf,
  tipBlockReason,
  tipRecipientVerdict,
  tipShortfall,
} from './tip';
import {
  nowSec,
  randomCawId,
  sendCalldata,
  signerFor,
  signerForHsChain,
  submitAction,
} from './wallet';
import { noteOwnPost } from './feedSync';
import { xMirrorStore } from './stores';
import { POST_COST_RAW, type XPost } from './xmirror';

/**
 * Shared "confirm → authenticate → sign & submit" flow for
 * like / share / follow actions (and, generically, posts).
 *
 * The caller is responsible for showing the confirmation UI first;
 * this helper resolves the acting (posting) name, runs the fresh
 * authentication gate, and submits the signed action.
 *
 * Throws:
 *  - Error('need-name') when the wallet owns no CAW name
 *  - Error('auth')      when requireAuth() returns false
 *  - Error('locked')    when no wallet secret is available
 *  - Error('self-follow') when a follow's sender and receiver
 *    names belong to the same owner (v0.4.5 — the chain allows
 *    it, the app does not)
 */
export async function performAction(
  app: AppContextValue,
  args: {
    kind: 0 | 1 | 2 | 3;
    target?: TimelineItem;
    receiverId?: bigint;
    text: string;
  },
): Promise<string> {
  const acting =
    app.myTokens.find((t) => t.id === app.actingId) ?? app.myTokens[0];
  if (!acting) throw new Error('need-name');
  if (!app.address) throw new Error('locked');

  if (args.kind === 3) {
    // Self-follow guard (v0.4.5): never sign a follow whose
    // receiver name belongs to the same owner as the acting name
    // — including the acting name itself and any sibling name of
    // this wallet. The fast local check covers the names this
    // wallet has loaded; the ownerOf pair covers the rest (e.g. a
    // name held by the same address that is not in the local
    // list). If the owner reads fail, the local verdict stands —
    // a public-RPC hiccup must not block ordinary follows.
    if (args.receiverId === undefined) throw new Error('need-receiver');
    if (app.myTokens.some((t) => t.id === args.receiverId)) {
      throw new Error('self-follow');
    }
    try {
      const [senderOwner, receiverOwner] = await Promise.all([
        nameOwner(acting.id),
        nameOwner(args.receiverId),
      ]);
      if (isSelfFollowOwners(senderOwner, receiverOwner)) {
        throw new Error('self-follow');
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'self-follow') throw e;
      /* owner read failed — the local check above already ran */
    }
  }

  const ok = await app.requireAuth();
  if (!ok) throw new Error('auth');

  const secret = app.getSecret();
  if (!secret) throw new Error('locked');

  let action: CawAction;
  if (args.kind === 1 || args.kind === 2) {
    if (!args.target) throw new Error('need-target');
    action = {
      type: args.kind,
      senderId: acting.id,
      receiverId: args.target.senderId,
      ts: nowSec(),
      sender: app.address,
      cawId: args.target.cawId,
      text: args.kind === 1 ? 'LIKE' : 'REPOST',
    };
  } else if (args.kind === 3) {
    if (args.receiverId === undefined) throw new Error('need-receiver');
    const cawId = await randomCawId();
    action = {
      type: 3,
      senderId: acting.id,
      receiverId: args.receiverId,
      ts: nowSec(),
      sender: app.address,
      cawId,
      text: 'FOLLOW',
    };
  } else {
    // kind 0 — Compose normally builds this itself; handled here
    // for completeness so callers can reuse the same flow.
    const cawId = await randomCawId();
    action = {
      type: 0,
      senderId: acting.id,
      receiverId: args.receiverId ?? 0n,
      ts: nowSec(),
      sender: app.address,
      cawId,
      text: args.text,
    };
  }

  return submitAction(secret.kind, secret.secret, action);
}

/**
 * X mirror engraving (v0.5.0-x): post an X post's text on CAW
 * as a NORMAL post — the same kind-0 action the composer
 * sends, through the same standard sign flow (requireAuth →
 * getSecret → submitAction, whose pre-sign ownership proof
 * applies unchanged). Nothing here can run unattended: every
 * engraving starts from the user's tap on the confirmation
 * sheet.
 *
 * Guards, all BEFORE anything is signed:
 *  - the X post must not already be engraved
 *    (Error('already-engraved')) — the mapping in
 *    xMirrorStore is the source of truth;
 *  - the acting name's deposited balance is re-read fresh
 *    (refreshMyTokens) and short of the normal post cost is
 *    a hard stop (Error('shortfall'), the balance attached
 *    as `balance`) — the same shortfall shape the tip and
 *    SuperLike flows use.
 *
 * The text is the X post's text EXACTLY — no marker, no
 * suffix, no link added. On success the mapping is recorded
 * (only after submitAction's receipt) and the feed head is
 * reconciled exactly like a composed post.
 */
export async function performMirrorPost(
  app: AppContextValue,
  args: { post: XPost },
): Promise<{ hash: string; cawId: string }> {
  const acting =
    app.myTokens.find((t) => t.id === app.actingId) ?? app.myTokens[0];
  if (!acting) throw new Error('need-name');
  if (!app.address) throw new Error('locked');
  if (xMirrorStore.has(args.post.id)) {
    throw new Error('already-engraved');
  }
  const fresh = await app.refreshMyTokens().catch(() => app.myTokens);
  const me = fresh.find((t) => t.id === acting.id) ?? acting;
  if (me.balance < POST_COST_RAW) {
    throw Object.assign(new Error('shortfall'), { balance: me.balance });
  }

  const ok = await app.requireAuth();
  if (!ok) throw new Error('auth');

  const secret = app.getSecret();
  if (!secret) throw new Error('locked');

  const cawId = await randomCawId();
  const action: CawAction = {
    type: 0,
    senderId: acting.id,
    receiverId: 0n,
    ts: nowSec(),
    sender: app.address,
    cawId,
    text: args.post.text,
  };
  const hash = await submitAction(secret.kind, secret.secret, action);
  await xMirrorStore.record(args.post.id, cawId);
  invalidateFeedHead();
  noteOwnPost({ ...action, hash, blockTs: new Date().toISOString() });
  app.refreshBalances().catch(() => {});
  return { hash, cawId };
}

/**
 * SuperLike （超いいね, v0.4.8; O-burn design v0.5.0): see
 * lib/superlike.ts. NOT a CAW protocol action: the whole
 * payment is ONE ordinary QL1 transaction — an O transfer of
 * exactly 1,000,000 O to the burn address, carrying the post
 * binding as trailing calldata. If it fails, nothing happened
 * and the user simply retries; there is no second leg and no
 * debt state. (The v0.4.9 CAT42 design — author leg + burn
 * leg + pending-burn store — is gone; no SuperLike was ever
 * sent at the CAT42 prices.)
 *
 * Guards, all BEFORE anything is signed:
 *  - self-SuperLike is blocked (Error('self-superlike')): the
 *    post's name in my tokens, or the author owner (resolved
 *    fresh) being my own address;
 *  - the O balance is re-read fresh on QL1; short of the
 *    1,000,000 price is a hard stop (Error('shortfall'), the
 *    balance attached as `balance`).
 * Throws Error('auth') / Error('locked') like performAction.
 * On success the marked-burn index is nudged (the count itself
 * still comes from the chain scan) and balances refresh.
 */
export async function performSuperlike(
  app: AppContextValue,
  args: { target: TimelineItem },
): Promise<string> {
  if (!app.address) throw new Error('locked');
  const authorOwner = await nameOwner(args.target.senderId);
  const blocked = superlikeBlockReason({
    senderId: args.target.senderId,
    myTokenIds: app.myTokens.map((t) => t.id),
    authorOwner,
    myAddress: app.address,
  });
  if (blocked) throw new Error('self-superlike');
  const balance = await oBalanceOf(app.address);
  if (superlikeShortfall(balance)) {
    throw Object.assign(new Error('shortfall'), { balance });
  }
  const data = buildSuperlikeData(args.target.cawId);
  if (!data) throw new Error('bad-post');

  const ok = await app.requireAuth();
  if (!ok) throw new Error('auth');

  const secret = app.getSecret();
  if (!secret) throw new Error('locked');

  const signer = signerFor(secret.kind, secret.secret);
  const hash = await sendCalldata(signer, O_TOKEN, data);
  refreshSuperlikesFor();
  app.refreshBalances().catch(() => {});
  return hash;
}

/**
 * SuperRecaw (v0.5.0): the normal Recaw action FIRST, then —
 * only after it landed — the 1,000,000 O burn carrying the
 * SRC1 marker for the original post. The O balance is checked
 * fresh BEFORE the recaw is signed, so an O shortfall refuses
 * the whole Super path (Error('shortfall')) and the UI can
 * offer the plain Recaw instead — never a half state.
 *
 * One authentication covers both signatures (the flow mirrors
 * performAction's kind-2 construction directly so the user is
 * not prompted twice back-to-back).
 *
 * If the burn fails AFTER the recaw landed, the debt is
 * recorded (pendingSrcBurnFor) and Error('src-burn-pending')
 * is thrown — the recaw stands, and the only way forward is
 * performSuperRecawBurn, which can never resend the recaw.
 */
export async function performSuperRecaw(
  app: AppContextValue,
  args: { target: TimelineItem },
): Promise<{ recawHash: string; burnHash: string }> {
  const acting =
    app.myTokens.find((t) => t.id === app.actingId) ?? app.myTokens[0];
  if (!acting) throw new Error('need-name');
  if (!app.address) throw new Error('locked');
  const balance = await oBalanceOf(app.address);
  if (balance < MARKED_BURN_PRICE_RAW) {
    throw Object.assign(new Error('shortfall'), { balance });
  }
  const burnData = buildSuperRecawData(args.target.cawId);
  if (!burnData) throw new Error('bad-post');

  const ok = await app.requireAuth();
  if (!ok) throw new Error('auth');

  const secret = app.getSecret();
  if (!secret) throw new Error('locked');

  // Step 1 — the normal Recaw action (same construction as
  // performAction kind 2; submitAction re-proves name ownership
  // before signing). If this throws, nothing else ran.
  const action: CawAction = {
    type: 2,
    senderId: acting.id,
    receiverId: args.target.senderId,
    ts: nowSec(),
    sender: app.address,
    cawId: args.target.cawId,
    text: 'REPOST',
  };
  const recawHash = await submitAction(secret.kind, secret.secret, action);
  // Step 2 — the marked O burn (QL1). Its failure leaves an
  // honest debt, never a second recaw.
  let burnHash: string;
  try {
    const signer = signerFor(secret.kind, secret.secret);
    burnHash = await sendCalldata(signer, O_TOKEN, burnData);
  } catch {
    await recordSrcBurn(app.address, {
      cawId: args.target.cawId,
      ts: nowSec(),
    });
    app.refreshBalances().catch(() => {});
    throw new Error('src-burn-pending');
  }
  refreshSuperlikesFor();
  app.refreshBalances().catch(() => {});
  return { recawHash, burnHash };
}

/**
 * The pending SuperRecaw-burn retry (v0.5.0): sends ONLY the
 * O burn of a SuperRecaw whose recaw already landed. The
 * pending record is required — without it there is nothing to
 * finish (Error('no-pending-src-burn')) — and the burn
 * calldata is the only thing this function can build, so the
 * recaw cannot be resent from here. The O balance is re-read
 * fresh; short of the price is a hard stop (Error('shortfall'))
 * and the debt stays recorded.
 */
export async function performSuperRecawBurn(
  app: AppContextValue,
  args: { target: TimelineItem },
): Promise<string> {
  if (!app.address) throw new Error('locked');
  const pending = await pendingSrcBurnFor(app.address, args.target.cawId);
  if (!pending) throw new Error('no-pending-src-burn');
  const balance = await oBalanceOf(app.address);
  if (balance < MARKED_BURN_PRICE_RAW) {
    throw Object.assign(new Error('shortfall'), { balance });
  }

  const ok = await app.requireAuth();
  if (!ok) throw new Error('auth');

  const secret = app.getSecret();
  if (!secret) throw new Error('locked');

  const signer = signerFor(secret.kind, secret.secret);
  const hash = await sendCalldata(
    signer,
    O_TOKEN,
    buildSuperRecawData(args.target.cawId) as string,
  );
  await clearSrcBurn(app.address, args.target.cawId);
  refreshSuperlikesFor();
  app.refreshBalances().catch(() => {});
  return hash;
}

/**
 * Tip （チップ, v0.5.0): a plain CAT42 transfer of the chosen
 * amount to the post author's owner address — CAT42's one job
 * since v0.5.0 (see lib/tip.ts). No marker, no counting.
 *
 * Guards, all BEFORE anything is signed: the author's owner
 * is resolved fresh (an unresolved author refuses the send
 * rather than paying a guessed address); self-tips are
 * blocked (Error('self-tip')); the CAT42 balance is re-read
 * fresh and short of the amount is a hard stop
 * (Error('shortfall'), the balance attached as `balance`).
 * Throws Error('auth') / Error('locked') like performAction.
 *
 * Recipient cross-check (v0.5.0-fix, audit M1): the resolved
 * owner is ALSO read through the second independent QL1
 * endpoint (nameOwnerAlt). When both endpoints answer and
 * DISAGREE, the tip is refused with
 * Error('recipient-mismatch') — a plain transfer cannot be
 * recalled, so two conflicting answers mean "do not send".
 * When the second endpoint cannot be read at all, the
 * primary's resolution stands (tipRecipientVerdict).
 */
export async function performTip(
  app: AppContextValue,
  args: { target: TimelineItem; amountRaw: bigint },
): Promise<string> {
  if (!app.address) throw new Error('locked');
  if (args.amountRaw <= 0n) throw new Error('bad-amount');
  const authorOwner = await nameOwner(args.target.senderId);
  const altOwner = await nameOwnerAlt(args.target.senderId).catch(
    () => null,
  );
  if (tipRecipientVerdict(authorOwner, altOwner) === 'mismatch') {
    throw new Error('recipient-mismatch');
  }
  const blocked = tipBlockReason({
    senderId: args.target.senderId,
    myTokenIds: app.myTokens.map((t) => t.id),
    authorOwner,
    myAddress: app.address,
  });
  if (blocked) throw new Error('self-tip');
  const balance = await cat42BalanceOf(app.address);
  if (tipShortfall(balance, args.amountRaw)) {
    throw Object.assign(new Error('shortfall'), { balance });
  }

  const ok = await app.requireAuth();
  if (!ok) throw new Error('auth');

  const secret = app.getSecret();
  if (!secret) throw new Error('locked');

  const signer = signerForHsChain(secret.kind, secret.secret, 'infinite');
  const hash = await sendCalldata(
    signer,
    CAT42,
    buildTipData(authorOwner, args.amountRaw),
  );
  app.refreshBalances().catch(() => {});
  return hash;
}
