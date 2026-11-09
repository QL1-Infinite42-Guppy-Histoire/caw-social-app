import type { AppContextValue } from '../context/AppContext';
import { nameOwner, type TimelineItem } from './cawApi';
import { isSelfFollowOwners, type CawAction } from './cawCore';
import { nowSec, randomCawId, submitAction } from './wallet';

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
