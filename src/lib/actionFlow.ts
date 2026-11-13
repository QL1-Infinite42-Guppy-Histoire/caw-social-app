import { CAT42, O_TOKEN } from '../config';
import type { AppContextValue } from '../context/AppContext';
import {
  nameOwner,
  nameOwnerAlt,
  type TimelineItem,
} from './cawApi';
import { isSelfFollowOwners, type CawAction } from './cawCore';
import {
  SUPERLIKE_AUTHOR_RAW,
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
import {
  SUPERRECAW_AUTHOR_RAW,
  SUPERRECAW_BURN_RAW,
} from './markedBurns';
import {
  buildAuthorPayData,
  clearAuthorPay,
  pendingAuthorPayFor,
  recordAuthorPay,
  type AuthorPayKind,
} from './authorPay';
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
 * SuperLike （超いいね, v0.4.8; O-burn design v0.5.0; two-leg
 * design v0.6.3): see lib/superlike.ts. NOT a CAW protocol
 * action: the payment is TWO ordinary QL1 transactions —
 *   leg 1: the BURN of 10,000,000 O to the burn address,
 *          carrying the post binding as trailing calldata.
 *          This leg defines the action (it is what the ⭐
 *          count reads), so it goes first: if it fails,
 *          nothing happened and there is no debt state.
 *   leg 2: a plain transfer of 15,000,000 O to the post
 *          author's owner. If THIS fails after the burn
 *          landed, the payment is recorded as a debt
 *          (lib/authorPay.ts) and Error('sl-pay-pending') is
 *          thrown — the only way forward is performAuthorPay,
 *          which sends the transfer alone.
 * (v0.5.0–v0.6.2 had ONE leg: a 1,000,000 O burn. Those
 * burns stay counted — see the detection sets in
 * lib/markedBurns.ts.)
 *
 * Guards, all BEFORE anything is signed:
 *  - self-SuperLike is blocked (Error('self-superlike')): the
 *    post's name in my tokens, or the author owner (resolved
 *    fresh) being my own address — so the author leg can
 *    never be a payment to oneself;
 *  - the O balance is re-read fresh on QL1; short of the
 *    25,000,000 total is a hard stop (Error('shortfall'),
 *    the balance attached as `balance`).
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
  // Leg 1 — the burn. A throw here is an ordinary failure:
  // nothing else has run and nothing is owed.
  const hash = await sendCalldata(signer, O_TOKEN, data);
  // Leg 2 — the author payment (plain transfer, no marker).
  try {
    await sendCalldata(
      signer,
      O_TOKEN,
      buildAuthorPayData(authorOwner, SUPERLIKE_AUTHOR_RAW),
    );
  } catch {
    await recordAuthorPay(app.address, 'sl', {
      cawId: args.target.cawId,
      author: authorOwner,
      amountRaw: SUPERLIKE_AUTHOR_RAW,
      ts: nowSec(),
    });
    refreshSuperlikesFor();
    app.refreshBalances().catch(() => {});
    throw new Error('sl-pay-pending');
  }
  refreshSuperlikesFor();
  app.refreshBalances().catch(() => {});
  return hash;
}

/**
 * SuperRecaw (v0.5.0; two money legs since v0.6.3): the
 * normal Recaw action FIRST, then — only after it landed —
 * the 20,000,000 O burn carrying the SRC1 marker for the
 * original post, and last the 5,000,000 O plain transfer to
 * the original author. The O balance is checked fresh BEFORE
 * the recaw is signed, so an O shortfall refuses the whole
 * Super path (Error('shortfall')) and the UI can offer the
 * plain Recaw instead — never a half state.
 *
 * One authentication covers all signatures (the flow mirrors
 * performAction's kind-2 construction directly so the user is
 * not prompted repeatedly back-to-back).
 *
 * If the burn fails AFTER the recaw landed, the debt is
 * recorded (pendingSrcBurnFor) and Error('src-burn-pending')
 * is thrown — the recaw stands, and the only way forward is
 * performSuperRecawBurn, which can never resend the recaw;
 * when that burn lands, the author payment becomes the owed
 * leg in turn. If the payment fails after the burn landed,
 * it is recorded (lib/authorPay.ts) and
 * Error('src-pay-pending') is thrown — the only retry sends
 * the transfer alone.
 *
 * Self-SuperRecaw: unlike SuperLike, a SuperRecaw of one's
 * OWN post has never been blocked (there is no self check —
 * a recaw of your own post is a normal CAW action), and
 * v0.6.3 keeps that behavior. The author leg is the only
 * difference: when the author owner IS the sender, nobody
 * is owed anything, so the payment leg is skipped, no debt
 * can arise from it, and the balance gate drops to the burn
 * alone.
 */
export async function performSuperRecaw(
  app: AppContextValue,
  args: { target: TimelineItem },
): Promise<{ recawHash: string; burnHash: string }> {
  const acting =
    app.myTokens.find((t) => t.id === app.actingId) ?? app.myTokens[0];
  if (!acting) throw new Error('need-name');
  if (!app.address) throw new Error('locked');
  // The author's owner decides the payment leg (and whether
  // there is one at all). A read failure does NOT block the
  // Recaw path: the payment is then recorded as owed with
  // the recipient resolved at retry time.
  let authorOwner = '';
  try {
    authorOwner = await nameOwner(args.target.senderId);
  } catch {
    /* resolved at the payment step or at retry */
  }
  const selfPay =
    authorOwner !== '' &&
    authorOwner.toLowerCase() === app.address.toLowerCase();
  const balance = await oBalanceOf(app.address);
  const needed =
    SUPERRECAW_BURN_RAW + (selfPay ? 0n : SUPERRECAW_AUTHOR_RAW);
  if (balance < needed) {
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
  const signer = signerFor(secret.kind, secret.secret);
  let burnHash: string;
  try {
    burnHash = await sendCalldata(signer, O_TOKEN, burnData);
  } catch {
    await recordSrcBurn(app.address, {
      cawId: args.target.cawId,
      ts: nowSec(),
      author: authorOwner,
    });
    app.refreshBalances().catch(() => {});
    throw new Error('src-burn-pending');
  }
  // Step 3 — the author payment (plain transfer, no marker).
  // Skipped when the author is the sender (self-SuperRecaw).
  if (!selfPay) {
    try {
      if (!authorOwner) {
        authorOwner = await nameOwner(args.target.senderId);
      }
      await sendCalldata(
        signer,
        O_TOKEN,
        buildAuthorPayData(authorOwner, SUPERRECAW_AUTHOR_RAW),
      );
    } catch {
      await recordAuthorPay(app.address, 'src', {
        cawId: args.target.cawId,
        author: authorOwner,
        amountRaw: SUPERRECAW_AUTHOR_RAW,
        ts: nowSec(),
      });
      refreshSuperlikesFor();
      app.refreshBalances().catch(() => {});
      throw new Error('src-pay-pending');
    }
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
 * fresh; short of the burn price is a hard stop
 * (Error('shortfall')) and the debt stays recorded.
 *
 * v0.6.3: once this burn lands, the SuperRecaw's author
 * payment (never attempted while the burn was outstanding)
 * becomes the owed leg and is handed over to the author-pay
 * debt (lib/authorPay.ts) — the recipient is the one pinned
 * in the burn record when the action was taken, or resolved
 * fresh now for older records. When the author IS the
 * sender, nobody is owed anything and nothing is recorded.
 */
export async function performSuperRecawBurn(
  app: AppContextValue,
  args: { target: TimelineItem },
): Promise<string> {
  if (!app.address) throw new Error('locked');
  const pending = await pendingSrcBurnFor(app.address, args.target.cawId);
  if (!pending) throw new Error('no-pending-src-burn');
  const balance = await oBalanceOf(app.address);
  if (balance < SUPERRECAW_BURN_RAW) {
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
  let author = pending.author ?? '';
  if (!author) {
    try {
      author = await nameOwner(args.target.senderId);
    } catch {
      /* stays unresolved; the payment retry resolves it */
    }
  }
  if (author.toLowerCase() !== app.address.toLowerCase()) {
    await recordAuthorPay(app.address, 'src', {
      cawId: args.target.cawId,
      author,
      amountRaw: SUPERRECAW_AUTHOR_RAW,
      ts: nowSec(),
    });
  }
  refreshSuperlikesFor();
  app.refreshBalances().catch(() => {});
  return hash;
}

/**
 * The pending author-payment retry (v0.6.3): sends ONLY the
 * plain O transfer owed by a SuperLike or a SuperRecaw whose
 * defining legs already landed. The pending record is
 * required — without it there is nothing to finish
 * (Error('no-pending-author-pay')) — and the transfer is the
 * only thing this function can build: no burn, no recaw, no
 * second action of any kind.
 *
 * The recipient is the address pinned in the record when the
 * action was taken (by design it cannot drift); only a
 * record left unresolved resolves fresh from the post here.
 * The O balance is re-read fresh; short of the owed amount
 * is a hard stop (Error('shortfall')) and the debt stays
 * recorded. The record clears only on the transfer's
 * confirmed success.
 */
export async function performAuthorPay(
  app: AppContextValue,
  args: { target: TimelineItem; kind: AuthorPayKind },
): Promise<string> {
  if (!app.address) throw new Error('locked');
  const pending = await pendingAuthorPayFor(
    app.address,
    args.kind,
    args.target.cawId,
  );
  if (!pending) throw new Error('no-pending-author-pay');
  const balance = await oBalanceOf(app.address);
  if (balance < pending.amountRaw) {
    throw Object.assign(new Error('shortfall'), { balance });
  }
  let author = pending.author;
  if (!author) {
    author = await nameOwner(args.target.senderId);
  }

  const ok = await app.requireAuth();
  if (!ok) throw new Error('auth');

  const secret = app.getSecret();
  if (!secret) throw new Error('locked');

  const signer = signerFor(secret.kind, secret.secret);
  const hash = await sendCalldata(
    signer,
    O_TOKEN,
    buildAuthorPayData(author, pending.amountRaw),
  );
  await clearAuthorPay(app.address, args.kind, args.target.cawId);
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
