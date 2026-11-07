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

- **現在版 / Current: v0.3.1** — released 2026-11-08.
  APK 直リンク / direct download:
  https://github.com/QL1-Infinite42-Guppy-Histoire/caw-social-app/releases/download/v0.3.1/caw-social.apk
  v0.3.1 adds a **wallet backup / secret reveal page** (Settings ->
  Wallet backup), copying MetaMask's ceremony: for the phrase —
  intro, a 2-question safety quiz (wrong answers retry, correct
  answers show the explanation), then the app password, then a
  blurred reveal with decoy words underneath (tap to show, auto
  re-hide after 60 s, copy only while shown). The private key
  skips the quiz (it is phrase-specific, as in MetaMask) but
  keeps the password gate. The gate is ALWAYS the app password:
  biometric-only users (no password verifier) set an app password
  in-flow first, and that password becomes the gate. Key-imported
  wallets have no phrase — the page says so plainly and offers
  the key instead. Secrets are loaded only after the password
  verifies (scripts/verify-reveal.mjs, 16 checks) and are never
  stored anywhere new.
  v0.3.0 adds **HuntersSwap** and a follow-list speed fix:
  - **HuntersSwap (buy).** A guided, one-step-at-a-time flow from
    BNB (BSC) or ETH (Ethereum) to QL1 qCAW, entirely in-app:
    entry swap (PancakeSwap / Uniswap V2) -> bridge to 42 Chain
    (-2 USDT on arrival) -> best route to QL1 quoted by the DEX
    aggregator engine (split routes offered only when they beat
    the best single route after fees). The 42->QL1 bridge fee is
    USD-fixed at $2 per leg (the [42] amount floats with the
    price — live quoteNative, 2.947 [42] at ship time), the token
    fee is 0 on every pair (live quoteBridge), and the fee + gas
    [42] is set aside from the flow itself; every fee is itemised
    on the confirm screen and the headline estimate is net of the
    set-aside. BSC keeps $3 of BNB for gas; the ETH entry starts
    at $100. Progress is saved on the phone and can be resumed.
  - **HuntersSwap (sell).** The same flow in reverse: qCAW ->
    USDT on 42 Chain -> bridge to BSC / Ethereum (flat 2 USDT,
    message fee 0) -> BNB / ETH. If the target chain has no gas
    coin, the flow can stop cleanly at "USDT arrived" and resume
    later; a missing [42] gas balance on 42 Chain is warned about
    before starting.
  - **Follow lists open instantly.** The follow index now renders
    progressively (cached / partially built lists show right away
    and update as the build walks the feed, with a slim progress
    note), persists its progress every 10 pages with a resume
    cursor (closing the app mid-build no longer restarts from
    page 1), and applies the balance refinement after first paint.
  - Verification: `scripts/verify-huntersswap.mjs` (live quotes
    for both directions, the full 42->QL1 fee stack, calldata
    selectors) and the extended `scripts/verify-follow.mjs`
    (interrupted + resumed build == uninterrupted build).
    No real-money send has been made yet — the first live run
    should be a small test.
  v0.2.0 added the five features approved the night before:
  - **"Following" timeline.** Home gains Latest / Following tabs;
    the Following tab shows only posts and shares by the names
    your acting name follows (same follow index as the profile
    lists).
  - **Reactions to you.** A bell on Home opens an in-app inbox:
    likes / shares on your names' posts and follows of your names
    since you last opened it. There is no server, so there are no
    push notifications — the page says so, gathers everything on
    the phone, and remembers the read position per wallet.
  - **Post detail.** Tapping a post opens its page with the names
    that liked it and the names that shared it, gathered from the
    feed between the post and now. Cross-checked live against the
    chain's own like counter (`scripts/verify-reactions.mjs`,
    9/9; like lists matched `likesCount` exactly on 6/6 sampled
    posts).
  - **Drafts.** The composer auto-saves on this phone as you type
    and restores the draft when reopened; posting clears it.
  - **Multiple wallets.** Keep several wallets on one phone and
    switch between them in Settings (switching asks for
    authentication; each wallet has its own names, acting name,
    drafts and reaction state, and keys stay in SecureStore only).
    The v0.1.x single wallet is adopted automatically.
  - **Tips: deliberately NOT included.** The action format has two
    tip lists, but a full-corpus scan (all 6,044 processAction
    transactions / 5,297 actions) found not one action that uses
    them — there is no real behaviour to verify a tip button
    against, so none was built.
  Previous release: v0.1.5 (2026-11-08) —
  v0.1.5 fixes the two safe-area problems reported from real-device
  use — the orange compose button sat half-hidden under the bottom
  tab bar, and the compose screen's title and close button slid
  under the status bar — by offsetting the button (tab bar height +
  safe-area inset + margin) and giving the compose screen (and,
  following the same audit, the profile screens, their edit modal,
  the new follow-list modal and the confirm/password sheets) proper
  top/bottom insets. On top of that:
  - **Follow lists.** A profile now shows Following / Followers
    counts and tappable lists, from a whole-feed follow index the
    app builds on the phone: the latest action per (sender,
    receiver) pair decides, unfollows (action type 4 — newly
    decoded; earlier versions dropped them) close a pair, and
    follows from names with a zero name balance (which never
    registered on-chain) are excluded. The Followers number itself
    is the exact on-chain `followerCount`. Verified live
    (`node scripts/verify-follow.mjs`, 16/16): name #10's refined
    follower list is 8 names, exactly the chain count; #27 is
    153 = 153.
  - **Name search.** X-style search on Home: exact names resolve
    instantly via `idByUsername`; partial matches come from a full
    on-device directory of every minted name (3,916 at release,
    built in ~12 s from the corrected `usernames(id − 1)` slot,
    cached on the phone and topped up as new names are minted).
  - **Five languages.** English / 日本語 / 简体中文 / 한국어 /
    Español for every string (164 × 5), switchable in Settings and
    from the globe button in the header. A string-length audit
    (`node scripts/audit-i18n.mjs`, 20/20) keeps tab names, buttons
    and chips inside their layout budgets in all five languages.
  - **More X-like, and faster.** Pressed-state pills on like/share,
    the profile header rebuilt to the X layout (banner, overlapping
    avatar, follow-button states, tappable counts), the composer
    shows the acting name's avatar, unfollows get a context line,
    and under the hood: a session page cache shared by the
    timeline, profiles and the follow-index build, parallel name
    enumeration, memoized post rows with tuned list windowing, and
    Home restoring the last feed instantly when you come back.
  Previous release: v0.1.4 (2026-11-07) —
  v0.1.4 fixes three things reported from real-device use the same
  evening: (1) the Settings "about" line still showed a hardcoded
  "v0.1.0" — the version is now read from app.json at runtime via
  expo-constants (`src/lib/appVersion.ts`), so it cannot go stale
  again; (2) the "load more" buttons at the end of the timeline and
  of profile post lists were small, pale ghost buttons at the very
  bottom edge of the screen (on profiles, half under the gesture
  area) — they are now a shared full-width dark button, 52px+ tall,
  in a footer with bottom padding that includes the safe-area
  inset (`LoadMoreFooter` in `src/components/ui.tsx`); (3) on the
  compose screen the on-screen keyboard hid the text input,
  especially for accounts holding many names (the name-picker chip
  grid alone took ~11 rows / ~450px) — the compose screen now sits
  in a KeyboardAvoidingView, the chip grid is capped at 118px with
  its own scrolling, and the composer block scrolls into view on
  focus and whenever the keyboard appears, so the input and what
  you are typing are always visible above the keyboard.
  Previous release: v0.1.3 (2026-11-07) —
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

## Features (v0.3.0)

- Wallet: create new (secret words) or import (secret words / private
  key). QL1 only. Unlock by password or biometrics — asked when the
  app opens and again before every signature.
- Timeline in the familiar X style (white, one accent colour), with
  like / share / follow context lines, plus a Following tab and a
  reactions inbox (in-app only — no server, no push).
- Tap a post for its detail page: who liked it, who shared it.
- Post, like, share, follow — confirmed on a sheet, signed in-app,
  sent as a `processAction` batch. Drafts auto-save on the phone.
- Several wallets on one phone, switchable in Settings.
- Profile pages: banner + avatar in the X layout, Following /
  Followers counts with tappable lists, that name's posts, follow
  button.
- Name search on Home: exact and partial matches, tap to open the
  profile.
- Get a name: availability + price check, qCAW approve → mint; a
  taken name links straight to its profile.
- My names: per-name qCAW balance inside the name, deposit / withdraw.
- Five languages — English (default), 日本語， 简体中文， 한국어，
  Español — switchable in Settings.

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
