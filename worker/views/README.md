# CAW post view counter (v0.6.0)

A tiny Cloudflare Worker + KV that aggregates post view
counts for the CAW Social app.

**What the numbers are — and are not.** Views are not
on-chain and cannot be verified on-chain. This service
counts the views the app itself registers (at most one per
post per day per device; the device token is a random
on-device id, not an identity). The app states this method
in its About section and shows counts only when an operator
has deployed this counter and configured its URL — until
then the views element does not render at all.

## Deploy (operator's step)

```sh
cd worker/views
npx wrangler kv namespace create VIEWS_KV   # put the id in wrangler.toml
npx wrangler deploy
```

Then set `VIEWS_COUNTER_URL` in `src/config.ts` to the
deployed `*.workers.dev` URL and rebuild the app (a normal
release). No secrets are involved; the counter holds no
keys and can only ever affect the displayed numbers.

## Endpoints

- `POST /views` `{ ids: [cawId…] }` → `{ counts: { cawId: n } }`
- `POST /views/hit` `{ ids: [cawId…], deviceToken }` →
  `{ ok, counted, counts }` — a repeat view from the same
  device on the same UTC day does not increment.

The behaviour is specified by `countsCore.js` and verified
offline by `scripts/verify-xui.mjs` in the app repo (fake KV,
dedupe windows, malformed-input handling).
