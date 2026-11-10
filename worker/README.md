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
