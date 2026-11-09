import { CAT42 } from '../config';
import type { AppContextValue } from '../context/AppContext';
import { nameOwner, type TimelineItem } from './cawApi';
import { isSelfFollowOwners, type CawAction } from './cawCore';
import {
  buildBurnData,
  buildSuperlikeData,
  cat42BalanceOf,
  clearPendingBurn,
  pendingBurnFor,
  recordPendingBurn,
  refreshSuperlikesFor,
  superlikeBlockReason,
  superlikeBurnShortfall,
  superlikeShortfall,
} from './superlike';
import {
  nowSec,
  randomCawId,
  sendCalldata,
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
 * SuperLike （超いいね, v0.4.8; price/split v0.4.9): the
 * fixed-price CAT42 tip bound to a post — see lib/superlike.ts
 * for the binding design and its pre-design verification. NOT
 * a CAW protocol action: the payment is two ordinary 42 Chain
 * CAT42 transfers from this wallet — 500 to the post author's
 * owner address FIRST (with the marker as trailing calldata,
 * so the ⭐ count lands immediately), then a plain 500 to the
 * burn address. The same key signs both, gated by the same
 * fresh authentication as every other send.
 *
 * Guards, all BEFORE anything is signed:
 *  - the author's owner is resolved fresh (ownerOf) — an
 *    unresolved author refuses the send rather than paying a
 *    guessed address;
 *  - self-SuperLike is blocked (Error('self-superlike')): the
 *    post's name in my tokens, or the author owner being my
 *    own address;
 *  - the CAT42 balance is re-read fresh; short of the 1,000
 *    total is a hard stop (Error('shortfall'), the balance
 *    attached as `balance`) — never a partial action.
 * Throws Error('auth') / Error('locked') like performAction.
 *
 * If the burn leg fails AFTER the author leg landed, the debt
 * is recorded (pendingBurnFor) and Error('burn-pending') is
 * thrown — the author keeps the share, the count stands, and
 * the only way forward is performSuperlikeBurn, which can
 * never resend the author leg.
 * On success the author's count scan is nudged (the count
 * itself still comes from the chain scan, not from here) and
 * the wallet balances refresh, so the spent CAT42 shows.
 */
export async function performSuperlike(
  app: AppContextValue,
  args: { target: TimelineItem },
): Promise<{ authorHash: string; burnHash: string }> {
  if (!app.address) throw new Error('locked');
  const authorOwner = await nameOwner(args.target.senderId);
  const blocked = superlikeBlockReason({
    senderId: args.target.senderId,
    myTokenIds: app.myTokens.map((t) => t.id),
    authorOwner,
    myAddress: app.address,
  });
  if (blocked) throw new Error('self-superlike');
  const balance = await cat42BalanceOf(app.address);
  if (superlikeShortfall(balance)) {
    throw Object.assign(new Error('shortfall'), { balance });
  }
  const authorData = buildSuperlikeData(authorOwner, args.target.cawId);
  if (!authorData) throw new Error('bad-post');
  const burnData = buildBurnData();

  const ok = await app.requireAuth();
  if (!ok) throw new Error('auth');

  const secret = app.getSecret();
  if (!secret) throw new Error('locked');

  const signer = signerForHsChain(secret.kind, secret.secret, 'infinite');
  // Leg 1 — the author, marked. If this throws, nothing else ran.
  const authorHash = await sendCalldata(signer, CAT42, authorData);
  refreshSuperlikesFor(authorOwner);
  // Leg 2 — the burn, plain. Its failure leaves an honest debt,
  // never a second author payment.
  let burnHash: string;
  try {
    burnHash = await sendCalldata(signer, CAT42, burnData);
  } catch {
    await recordPendingBurn(app.address, {
      cawId: args.target.cawId,
      author: authorOwner,
      ts: nowSec(),
    });
    app.refreshBalances().catch(() => {});
    throw new Error('burn-pending');
  }
  app.refreshBalances().catch(() => {});
  return { authorHash, burnHash };
}

/**
 * The pending-burn retry (v0.4.9): sends ONLY the burn leg of
 * a SuperLike whose author leg already landed (see
 * performSuperlike). The pending record is required — without
 * it there is nothing to finish (Error('no-pending-burn')) —
 * and the burn calldata is the only thing this function can
 * build, so the author leg cannot be resent from here. The
 * CAT42 balance is re-read fresh; short of the burn share is
 * a hard stop (Error('shortfall')) and the debt stays recorded.
 */
export async function performSuperlikeBurn(
  app: AppContextValue,
  args: { target: TimelineItem },
): Promise<string> {
  if (!app.address) throw new Error('locked');
  const pending = await pendingBurnFor(app.address, args.target.cawId);
  if (!pending) throw new Error('no-pending-burn');
  const balance = await cat42BalanceOf(app.address);
  if (superlikeBurnShortfall(balance)) {
    throw Object.assign(new Error('shortfall'), { balance });
  }

  const ok = await app.requireAuth();
  if (!ok) throw new Error('auth');

  const secret = app.getSecret();
  if (!secret) throw new Error('locked');

  const signer = signerForHsChain(secret.kind, secret.secret, 'infinite');
  const hash = await sendCalldata(signer, CAT42, buildBurnData());
  await clearPendingBurn(app.address, args.target.cawId);
  app.refreshBalances().catch(() => {});
  return hash;
}
