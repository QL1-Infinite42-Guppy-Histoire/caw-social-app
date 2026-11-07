# CAW Social — Google Play listing drafts and submission checklist

DRAFT ONLY — nothing here has been submitted anywhere. This file collects
the store copy and the declaration answers the publisher will face in
Play Console, prepared in advance so the Console session is short.

Package: `one.guppyguide.cawsocial` · Publisher: Guppy's Guide
(QL1-Infinite42-Guppy-Histoire) · License: MIT (open source)

---

## App name (30 characters max)

CAW Social

## Short description (80 characters max)

EN (74 chars):
On-chain social on QL1: post, follow and use CAW in one non-custodial app.

JP:
QL1のオンチェーンSNS。投稿・フォロー・CAWの管理がこの1つで。

## Full description — EN

CAW Social is a community-made Android app for CAW, the social network
that runs entirely on the QL1 blockchain — no company server in the
middle. Your posts, likes and follows are recorded on-chain, and your
account is a name you truly own as an NFT.

Everything happens inside the app. There is no wallet browser and no
separate wallet app to connect: CAW Social carries its own
non-custodial wallet. Your keys and recovery phrase are created and
stored only on your phone, and never leave it.

WHAT YOU CAN DO
• Read the timeline, post, like, Recaw and follow — all on-chain
• Get your own CAW name (an NFT) and build your profile around it
• Hold CAW and QOM on QL1, plus balances on 42 Chain, BNB Smart Chain
  and Ethereum, in one place
• Buy and sell CAW with a guided step-by-step flow (HuntersDEX) that
  swaps and bridges across chains for you
• Send any of your balances, with an on-device address book
• Use the app in 13 languages: English, Japanese, Korean, Chinese,
  Spanish, Turkish, Persian, Indonesian, Vietnamese, Portuguese,
  Dutch, Hindi and French — including a full right-to-left layout
  for Persian

PLEASE KNOW
• This is a community app, made by a fan. It is not operated by the
  official CAW team.
• On-chain actions are public and cannot be undone or deleted — by
  design of the blockchain itself.
• The swap and bridge features are new. They are built on public
  on-chain exchanges and bridges, but please start with small amounts
  while the app is in beta.
• No analytics, no ads, no tracking. The app is free and fully open
  source under the MIT license — anyone can read exactly what it does.

Part of Guppy's Guide — "Don't Panic", a hitchhiker's toolbox for
42 Chain & QL1.

## Full description — JP

CAW Social は、QL1 ブロックチェーンの上だけで動く SNS「CAW」のための、
コミュニティ製 Android アプリです。会社のサーバーは間にありません。
投稿・いいね・フォローはすべてチェーンに記録され、あなたのアカウントは
NFT として本当に自分のものになる「名前」です。

操作はすべてアプリの中で完結します。ウォレットブラウザも、別のウォレット
アプリとの接続も要りません。CAW Social 自体がノンカストディアル
（資産を預からない）ウォレットを内蔵していて、キーと復旧フレーズは
あなたのスマホの中だけに作られ、保存されます。外に出ることはありません。

できること
• タイムラインの閲覧、投稿、いいね、Recaw、フォロー — すべてオンチェーン
• 自分だけの CAW 名前（NFT）を取得して、プロフィールの中心に
• CAW と QOM（QL1）に加えて、42 Chain、BNB Smart Chain、Ethereum の残高を
  まとめて管理
• チェーンをまたぐスワップとブリッジを、1つずつ案内する買い方・売り方
  （HuntersDEX）で CAW を売買
• どの残高からでも送金、端末内アドレス帳つき
• 13言語対応：英語、日本語、韓国語、中国語、スペイン語、トルコ語、
  ペルシャ語、インドネシア語、ベトナム語、ポルトガル語、オランダ語、
  ヒンディー語、フランス語（ペルシャ語は右から左のレイアウトに完全対応）

知っておいてほしいこと
• これはファンが作ったコミュニティアプリです。CAW 公式チームが運営する
  ものではありません。
• チェーン上の操作は公開情報で、取り消しや削除はできません
  （ブロックチェーンの仕様です）。
• スワップとブリッジは新しい機能です。公開されたチェーン上の取引所と
  ブリッジを使いますが、ベータの間は少額から始めてください。
• アクセス分析なし、広告なし、トラッキングなし。無料で、MIT ライセンスの
  完全なオープンソースです — 何をしているか、誰でも読んで確認できます。

Guppy's Guide の製品の1つです — Don't Panic（あわてないで）。
42 Chain と QL1 のための道具箱。

---

## Play Console declarations — DRAFT checklist (publisher fills these in)

Nothing below is submitted by the code or the repo; each item is a form
the publisher answers in Play Console. Suggested answers are derived
from the app's actual behavior and the privacy policy
(docs/privacy.html / docs/privacy-ja.html).

- [ ] **Developer account** — Play Console registration is the
      publisher's own account ($25 one-time, identity verification).
      Nobody else can do this step.
- [ ] **Privacy policy URL** —
      https://ql1-infinite42-guppy-histoire.github.io/caw-social-app/privacy.html
      (JP: …/privacy-ja.html)
- [ ] **App access** — No login is provided by a server; the app is
      usable immediately after creating/importing a wallet on-device.
      Answer: all functionality available without special access.
- [ ] **Ads** — "No, my app does not contain ads."
- [ ] **Data safety** — Suggested: Data collected by the developer:
      **None**. Data shared: **None**. Rationale: no servers, no
      analytics, keys never leave the device. Notes for the form's
      free-text/review stage: the app connects directly to public
      blockchain nodes, block explorers and an IPFS gateway at the
      user's own action; those services see the user's IP address and
      public wallet address, and confirmed transactions are public
      on-chain records. All traffic is encrypted in transit (HTTPS).
      Data deletion: no developer-side data exists to delete; local
      data is erased by uninstalling / deleting the wallet in-app.
- [ ] **Financial features** — Complete the Console's financial
      features declaration. Declare truthfully: the app is a
      **non-custodial cryptocurrency wallet**; users hold their own
      keys; the app itself does not custody funds, does not operate
      an exchange, and does not lend. Swaps/bridges are executed by
      public on-chain contracts at the user's direction. If the form
      offers "cryptocurrency wallet / software wallet" categories,
      use them; do not declare exchange or banking features.
- [ ] **NFTs** — CAW names are ERC-721 NFTs minted and held on-chain.
      If any declaration or questionnaire asks about NFT
      functionality, answer yes and describe: user-owned identity
      names; the app does not sell NFTs itself (minting costs are
      paid in CAW to the public contract).
- [ ] **Content rating (IARC)** — Complete the questionnaire as a
      social networking app with user-generated content and
      cryptocurrency features. Expect questions about UGC, user
      interaction, and digital purchases — note: there are NO in-app
      purchases and no fiat purchases of crypto in the app. Be honest
      that on-chain posts cannot be moderated or removed by the
      developer (they are blockchain records), and that there is no
      central reporting/moderation service; blocking/reporting is
      limited to what the app itself provides.
- [ ] **Target audience** — 18+ is the honest choice (cryptocurrency
      wallet; not directed at children). Do not enroll in the
      Families program.
- [ ] **Account creation / deletion declarations** — The app creates
      no server accounts. Wallet creation is on-device only. Answer
      the account-deletion questions accordingly ("app does not
      support account creation" path), and note that deleting the
      wallet in-app removes the local keys.
- [ ] **News / health / government** — No to all.
- [ ] **Store listing assets still needed** — Feature graphic
      (1024×500), at least 2 phone screenshots (the publisher can
      capture these from the real device), hi-res icon 512×512
      (assets/icon.png is 1024×1024 and can be downscaled).
- [ ] **Testing tracks** — A beta can go to the **Open testing**
      track as soon as the listing and declarations are complete.
      Note: for a brand-new personal developer account, Google may
      additionally require a **closed test with 12+ testers for 14
      days** before Production access is granted — check what
      Play Console shows for the account at submission time.
- [ ] **Version codes** — `android.versionCode` in app.json is the
      single source for both the APK and the AAB (eas.json uses
      appVersionSource "local"). It is 20 in v0.3.11. **Bump it on
      every release** — Play rejects any upload whose versionCode
      is not higher than all previous ones, and Android refuses to
      install a lower-versionCode APK over a higher one.
- [ ] **Signing** — Upload the `caw-social.aab` from the GitHub
      Release (built by the repo's Actions workflow, production EAS
      profile). It is signed with the same key the GitHub APKs use.
      Enroll in Play App Signing on first upload and keep using the
      same upload key for every future release — never rotate it
      casually; losing it means contacting Google to reset it.
- [ ] **Known behavior worth a reviewer note** (App review may ask):
      the app needs no demo account; reviewers can create a wallet
      in-app in under a minute. Some features (posting, swapping)
      require small on-chain balances, which is normal for a
      blockchain client.

## Honest-status notes for the publisher (not for the listing)

- The v0.3.6 execution-bug fix was verified off-device and the sell
  path was later proven on a real device through the bridge leg.
  The publisher's own full buy-side round trip with real funds had
  not been done at the time this draft was written — keep the
  "start with small amounts" wording in the listing until it has.
- The manifest currently allows Android backups (allowBackup). For a
  wallet app the publisher may want this revisited in a future
  release; it does not block submission.
