# HuntersExchange order server

A Cloudflare Worker + KV bulletin board for signed
HuntersExchange orders (42 Chain). It stores and serves
EIP-712 signed orders for the escrow contract in
`../contracts/HuntersExchange.sol`; it holds no keys and can
never move funds. If this server is down, deposits,
withdrawals, fills and on-chain cancels all keep working —
only the shared book view disappears.

## Files

- `worker.js` — the fetch handler (endpoints below).
- `orderStore.js` — pure listing logic (shape validation,
  duplicates, expiry, cancel, escrow-commitment totals).
- `verify.js` — signature recovery (EIP-712 order signature,
  personal-sign cancel signature) and on-chain escrow reads.
- `dist/worker.js` — the esbuild bundle wrangler deploys
  (build artifact; regenerate with `npm run build`).

## Endpoints

- `GET /book?contract=0x…` → `{ orders: [...] }` (unexpired)
- `GET /orders?contract=0x…&maker=0x…` → the maker's listings
- `POST /orders { contract, order, signature }` — accepted
  only when the signature recovers the maker AND the maker's
  on-chain escrow balance covers their total committed give.
- `POST /cancel { contract, order, signature }` — signature
  is the maker's personal-sign of the order hash; removes
  the listing. The authoritative cancel is the contract's
  `cancelOrder()`; this is only the display-side removal.

KV layout: one key per contract, `orders:<contract>` → JSON
array of listings. KV is eventually consistent; a listing
can take a few seconds to appear everywhere. The contract
remains the source of truth for fills and cancels — the app
re-checks chain state before any fill.

## Deploy (user's step — their Cloudflare account)

```sh
cd worker
npm install
npm run build
npx wrangler kv namespace create HX_KV   # paste the id into wrangler.toml
npx wrangler deploy
```

Then set `EXCHANGE_SERVER_URL` in `../src/config.ts` to the
deployed URL and rebuild the app. Until then the app shows
an honest "server not connected" state on the book screen.

## X mirror notifications (v0.5.0-x)

The same Worker also powers the X mirror's push path, so one
deploy covers both. A cron trigger (every 15 minutes, see
`wrangler.toml`) polls each registered X account once and
sends one Expo push notification per new post; tapping it
(or its 刻む action) opens the app on that post's engraving
confirmation sheet. The pure logic is in `xmirror.js`:

- `POST /x/register` — the app registers its Expo push
  token, the X account id, and the X session (access +
  refresh token + the user's own Client ID). The token is
  READ-ONLY by OAuth scope (`tweet.read`): this server can
  never post to X, and it holds no wallet material of any
  kind — engraving is always signed in the app.
- `POST /x/unregister { xUserId }` — removes the
  subscription and its seen set.
- The first poll after registering is a silent BASELINE:
  everything already on the timeline becomes "seen" and
  nothing notifies. After that, each post notifies exactly
  once (seen record in KV, `xseen:<xUserId>` →
  `{ ids, sinceId }`); the app remains the source of truth
  for what is actually engraved.
- Polls pass `since_id` (the newest post id seen), so a
  poll that finds nothing new returns an empty page. X
  reads are pay-per-use and reading your OWN posts is an
  Owned Read at $0.001 per post returned — an idle poll
  therefore costs zero, and a personal account's mirror
  costs a few cents a month at most. (There are no
  subscription tiers anymore; new developer accounts start
  with one-time starter credits.)
- Push payloads carry only the X post id and a short text
  preview — no tokens, no account secrets.

### Setup (user's steps)

1. Deploy this Worker as above (the same `wrangler deploy`
   ships the cron poller; check the trigger appears in the
   deploy output).
2. Set `X_MIRROR_SERVER_URL` in `../src/config.ts` to the
   same deployed URL and rebuild the app.
3. In your X developer app (developer.x.com): enable OAuth
   2.0, and register the callback URL `cawsocial://x-callback`.
   In the app: Settings → Link X → paste the Client ID →
   Connect. Registration with the Worker happens as part of
   connecting.
4. Android push delivery uses the Expo Push Service; the
   EAS project needs its standard FCM setup
   (google-services.json in the project) for remote
   notifications to reach Android devices. Without it, push
   registration reports itself honestly in Settings and the
   in-app detection (posts found when the app opens) keeps
   working — timely notification is the only thing lost.

Until `X_MIRROR_SERVER_URL` is filled in, the app shows the
notification section as "not set up yet" and mirroring works
without notifications.
