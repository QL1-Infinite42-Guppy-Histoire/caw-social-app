# CAW Social — Android app (QL1)

The community CAW SocialFi network on **QL1**, as a native Android app.
Timeline, names, posting, likes, shares and follows — with the signing
done **inside the app**, so no wallet browser is needed.

🐦 Web version (same network, read + wallet-browser writes):
https://ql1-infinite42-guppy-histoire.github.io/caw-social-ql1/

> This is a community app made by a fan. It is **not** run by the
> official CAW team. The CAW contracts on QL1 are a community port.

## 開発状況 / Status

![Build APK](https://github.com/QL1-Infinite42-Guppy-Histoire/caw-social-app/actions/workflows/build-apk.yml/badge.svg)

- **現在版 / Current: v0.1.3** — released 2026-11-07.
  APK 直リンク / direct download:
  https://github.com/QL1-Infinite42-Guppy-Histoire/caw-social-app/releases/download/v0.1.3/caw-social.apk
  v0.1.3 corrects the name source — with an apology: v0.1.2 (and a
  first v0.1.3 draft) had the one-id shift backwards. The mint
  transactions settle it: `Minter.mint("dreamin")` created token
  189 (tx `0xc4ac11ad…`, block 5189285, to the wallet that still
  holds it) and `Minter.mint("neptune")` created token 190 (tx
  `0x9c374074…`, block 5189287, later transferred to its current
  owner) — exactly the names on the tokens' CARDS (`tokenURI`).
  The one broken getter is `usernames()`: `usernames(n)` returns
  token n+1's minted name (a 0-based list read against 1-based
  token ids; slot 0 holds token 1's name, "elonmusk"). `tokenURI`,
  `tokens()` and `idByUsername` all agree with the mint records.
  So in v0.1.3 every displayed name (name picker, my-names list,
  profiles, timeline, compose) comes from the token's card —
  fallback `usernames(id − 1)`, the corrected slot — and the
  avatar again renders the card picture, so picture and caption
  always describe the same name. What v0.1.2 got right is kept:
  "my names" is built from the ERC-721 enumeration (`balanceOf` +
  `tokenOfOwnerByIndex`), every id is cross-checked with
  `ownerOf(id)`, and signing is fail-closed (the app refuses to
  sign for a token id the wallet does not provably own). Verified
  with `node scripts/verify-display.mjs` (17/17, live, ids
  188–191) and `node scripts/verify-identity.mjs` (19/19, live,
  expectations corrected to the mint records), plus the earlier
  suites (9/9, 26/26).
  v0.1.2 addressed the identity mix-up reported the same evening
  ("the app shows me as @loveforqom, but I am @neptune") by
  rebuilding "my names" from the ERC-721 enumeration with
  `ownerOf(id)` cross-checks — that part stands — but it took the
  names from `usernames(id)`, which the mint records have since
  proven to be the shifted source; v0.1.3 above corrects it.
  (Signature recovery also showed the day's #190 actions were
  signed by #190's owner's key — the user's own wallet, acting as
  his own "neptune", exactly as recorded on-chain.)
  v0.1.0 was confirmed on a real phone the same day (name mint, post,
  like and share all work). v0.1.1 fixes the three problems reported
  from that check and adds on-device profile customization:

  - **Likes / shares now light up and stay lit.** The app remembers
    your own like / share / follow actions on the device (per wallet
    and per name), lights the button the moment you confirm, keeps it
    across restarts, and also notices your past actions when they
    scroll by in the feed.
  - **Missing content fixed.** Like / share entries now show the
    original post they point at (quoted box). Profile pages scan much
    deeper for a name's posts — the old 4-page scan found none at all
    for quieter names.
  - **Wrong / unreachable profiles fixed.** A name/avatar read that
    fails once no longer stays broken for the whole session.
    (This bullet originally also claimed the `tokens()` rows were
    shifted and moved names to `usernames(id)` — the mint records
    later proved the opposite; see the v0.1.3 note above.)
  - **Profile customization (off-chain).** On your own profile you
    can set a display name, a profile picture and a header picture
    (picked from your photos, copied into the app's own storage).
    This is a look for this phone only — chain data and your username
    never change — and it can be reset to the default look anytime.

  Verified with `npm run verify` (9/9) and
  `node scripts/verify-fixes.mjs` (26/26, including live checks of
  the exact cases above).
- Android package: `one.guppyguide.cawsocial`
- APK: from the GitHub Releases page (asset `caw-social.apk`), or the
  `caw-social-apk` artifact of the latest Actions run.

## Why an app?

CAW posts are authorized by a plain ECDSA signature over a raw digest
(no message prefix). Today's wallet apps refuse that on purpose —
FoxWallet answers "does not support eth_sign", and current MetaMask
builds have removed the option — so posting from a wallet browser no
longer works. This app keeps the key on your phone (Android
Keystore-backed secure storage) and signs in-app, exactly like the
original signers did.

## Features (v0.1.3)

- Wallet: create new (secret words) or import (secret words / private
  key). QL1 only. Unlock by password or biometrics — asked when the
  app opens and again before every signature.
- Timeline in the familiar X style (white, one accent colour), with
  like / share / follow context lines.
- Post, like, share, follow — confirmed on a sheet, signed in-app,
  sent as a `processAction` batch.
- Profile pages: header band, avatar, follower count, that name's
  posts, follow button.
- Get a name: availability + price check, qCAW approve → mint.
- My names: per-name qCAW balance inside the name, deposit / withdraw.
- English by default, 日本語 switchable in Settings.

## Verification

The signing core (`src/lib/cawCore.ts`) is a TypeScript port of the
web front end's verified code. Before release it was checked with
`npm run verify`:

- All **264 real on-chain actions** in the reference corpus recover
  their sender from this port's digests (ecrecover), and all 300
  reference batches re-encode **byte-for-byte**.
- Live smoke against the QL1 RPC / Blockscout API: timeline decoding,
  name resolution (including the name desk's `idByUsername = tokenId+1`
  quirk, verified against the on-chain name list), balances.

No real funds were sent for testing; the first real post from a user's
own wallet is the end-to-end check, as with the web version.

## Tech notes

- Expo + React Native + TypeScript, ethers v6.
- Contracts (QL1, chain id 766): CawName
  `0x864f08Af11F6DC2c0De42562e4664d4f033D393f`, CawNameMinter
  `0xFC2f8743E3b09a6c973B114c3a082433e974eD9f`, CawActions
  `0x95c2AFEc2dE8b09323Cdc7E40Bcce42C3C49E496`, qCAW
  `0xd2140E16aDf37194036865E90BbCA1139b739d0D`.
- Keys never leave the phone: the secret lives only in
  expo-secure-store; the password gate stores a salted hash only.
- Builds run on GitHub Actions (`eas build --local`, preview profile),
  the same way as GuppyWallet.

## License

MIT — see [LICENSE](LICENSE).
