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

- **現在版 / Current: v0.1.0** — released 2026-11-07.
  APK 直リンク / direct download:
  https://github.com/QL1-Infinite42-Guppy-Histoire/caw-social-app/releases/download/v0.1.0/caw-social.apk
  First end-to-end check still open: one real post from a real phone.
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

## Features (v0.1.0)

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
