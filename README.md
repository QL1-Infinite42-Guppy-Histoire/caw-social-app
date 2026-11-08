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

- **現在版 / Current: v0.4.4** — released 2026-11-08.
  APK 直リンク / direct download:
  https://github.com/QL1-Infinite42-Guppy-Histoire/caw-social-app/releases/download/v0.4.4/caw-social.apk
  v0.4.4 fixes a HuntersDEX cash-out that could not
  bridge QOM from QL1 to 42 Chain (user report
  2026-11-08 12:16 JST): the sell's QL1 swap leg paid
  its proceeds out as NATIVE QOM while the next step —
  the QL1->42 bridge — spends the pair's ERC-20 (WQOM)
  via transferRemote, so the bridge step found a WQOM
  balance of 0 and the send could never proceed (the
  on-device sell of 12:13 JST swapped and approved,
  then nothing was ever broadcast). Root cause: a
  native/wrapped representation mismatch inside the
  sell flow — the mirror image of the buy-side bug
  fixed in v0.4.2/v0.4.3. buildRouteSwapTx resolved the
  route's QL1 end (the WQOM contract) by address lookup
  to the chain's "native" entry (same address, first
  match) and built swapExactTokensForETH. The builder
  now takes a toTokOverride, symmetric to the existing
  fromTokOverride, and the sell leg passes the pair's
  own QL1 token entry, so proceeds land as WQOM and the
  bridge step works as designed. The bridge step also
  reconciles representations for flows saved by older
  builds (lib/hunters ql1BridgePlan +
  runQl1BridgeBatch): if the WQOM balance is short of
  the bridge amount but the native surplus above the
  QL1 gas keep covers the shortfall, the step wraps
  exactly the shortfall (WQOM.deposit) inside its own
  send sequence — one confirmation, sub-statuses shown
  — and then bridges; if neither balance covers it, the
  step stops beforehand with the classified
  insufficient message, never a silent failure. The
  keep is never converted. Verified by
  scripts/verify-sellbridge.mjs (fresh sell leg builds
  swapExactTokensForTokens; the reporter's exact parked
  state — native QOM 11,370,689,767, WQOM 0 — wraps once
  and bridges in one sequence) plus the full existing
  suites, all green.
  versionCode 26. v0.4.3 fixes a HuntersDEX buy that stopped at the QL1
  gas-securing step (user report 2026-11-08 11:18 JST):
  after v0.4.2 advanced the stuck buy to the QL1 swap
  step, securing the gas keep ran THREE separate
  WQOM.withdraw transactions (11:16:51 / 11:17:16 /
  11:18:09 JST, all ok) and the swap never ran. Root
  cause: the step offered the unwrap as a standalone
  sheet that converted only the keep SHORTFALL — but a
  withdraw's own gas is paid from the same native balance
  the gate measures, so each unwrap landed native at
  (keep − one withdraw's gas), the plan still reported a
  shortfall, and the sheet re-fired; a gate that
  re-measures after its own remedy can never converge.
  The QL1 swap step now executes as ONE batch under the
  step's single confirmation (lib/hunters
  ql1FinishPlan + runQl1FinishBatch): one unwrap of the
  step's FULL working amount, any missing approval, and
  the swap — with per-leg sub-statuses in the step card
  and no separate gas step or per-leg sheet. The swap
  input is re-planned from fresh balances right before
  the swap leg, so it absorbs the withdraw's gas and the
  native balance lands exactly on the keep; the keep
  arithmetic itself is unchanged (346,500,000 QOM) and
  the planned input never includes it. The converted
  amount is persisted the moment the unwrap confirms, so
  an interrupted batch resumes with the unwrap credited
  and can never plan a second one for the same step; a
  landed-but-unconfirmed leg aborts the batch with the
  UNCONFIRMED outcome instead of proceeding on an
  unproven state. The batch is token-generic: what a
  part's input is comes from the bridge-pair / token
  registries (resolveQl1Input), with the
  native-vs-wrapped distinction carried as a registry
  property (the QL1 token whose address is the chain's
  native anchor) — a part delivered as BABY or any other
  token finishes through the same single batch, and the
  last symbol branches (`part.sym === 'QOM'` in the swap
  step, the arrival verdict, and the cross-quote engine)
  are gone. Holdings now drive display: tokens the
  wallet actually holds on 42 Chain / QL1 (read from the
  explorers' token-balances) appear in the HuntersDEX
  balance lists automatically, beyond the curated rows,
  and a held QL1 token with a live route to CAW becomes
  a direct start point — routing needs no list-keeping,
  and a held token with no route is simply not offered
  as a start. Verified by scripts/verify-batch.mjs
  (57 checks: full-amount single withdraw incl. a
  confirmation hiccup, interrupt/resume with zero
  further withdraws, the reporter's exact current
  balances, a BABY batch, a registry-only token, the
  keep matrix) plus verify-arrival 17 / verify-wqom 25 /
  verify-qomstart 24 / verify-resume 80 and the i18n
  audit, all green.
  versionCode 25. v0.4.2 fixes a HuntersDEX buy parked forever at
  「コインが届くのを待っています…」 even though every leg had
  executed (user report 2026-11-08 10:00 JST). Root cause:
  the 42->QL1 arrival watcher read the NATIVE QOM balance
  for the QOM pair, but QOM bridged into QL1 is delivered
  as WQOM — an ERC-20 — so the delivery never registered
  and the QL1 swap never ran. The watcher and the bridge
  baseline now read the delivered token's balance (WQOM);
  flows saved by older versions, whose baselines were
  captured from the native balance, are repaired by the
  watcher itself (cross-asset acceptance when the WQOM
  balance already covers the delivery, otherwise a
  one-time rebase onto the WQOM balance) and continue from
  where they stopped — no restart, no second swap. The
  QL1 swap step also treats the arrived token as the
  ERC-20 it is (allowance + token swap; it previously
  resolved WQOM to the native entry and built a
  native-spending swap that could only fail). QL1 WQOM is
  now shown as its own row in the HuntersDEX balance
  lists, and holding WQOM offers a mid-start straight at
  the QL1 swap step (same flow shape as a part that
  arrived there by bridging). Holding NATIVE QOM likewise
  offers a direct start at the same swap step: the part
  is born marked srcNativeQom, plans only against the
  native balance above the gas keep, spends natively
  (no allowance), and is keep-re-checked at broadcast
  time (scripts/verify-qomstart.mjs, 24 checks). New: ONE app-wide QL1 gas
  keep, defined once in lib/hunters and used by planning,
  mid-starts, resumes, execution re-checks and the
  faucet-guidance judgment: a native-QOM reserve sized
  from measured chain costs (processAction 106,316–
  136,258 gasUsed across 15 sampled real txs; swap
  183,917; bridge-out 233,913; approve ~46,900; unwrap
  36,042 by estimateGas; gas price 18 QOM/gas), namely
  100 SNS actions + 10 swap-class ops + 10% margin =
  19,250,000 gas = 346,500,000 QOM. DEX steps whose
  working funds are WQOM secure the keep first by
  unwrapping exactly the shortfall; only the surplus is
  spendable principal, the keep is re-checked from fresh
  balances at broadcast time, and when the keep cannot be
  secured (native balance too low to pay the unwrap
  itself) the step stops at the faucet guidance — never
  a partial execution. Verified by
  scripts/verify-arrival.mjs (17 checks, including the
  reporter's exact stuck state with their real numbers)
  and scripts/verify-wqom.mjs (25 checks) plus all
  previous suites.
  versionCode 24. v0.4.1 fixes a HuntersDEX buy that was shown as failed even
  though the swap had actually succeeded on-chain (user report
  2026-11-08 08:56 JST; BSC tx 0x7b5ac1… confirmed successful).
  Root cause: the send path confirmed receipts with a
  single-endpoint wait that could throw after the tx had
  already been mined, and the step's catch-all then showed the
  generic failure text — while the flow state stayed on the
  swap step, so "resume" later rendered an empty step whose
  Next re-ran a swap the wallet could no longer fund. Sends
  now confirm across all of the chain's RPC endpoints over a
  ~90-second window; a tx that cannot be confirmed gets its
  own "unconfirmed — it may have succeeded, check before
  retrying" message in all 13 languages (never the generic
  failure text), with the pending hash saved on the flow.
  Resume rebuilds the current step from fresh balances and a
  live quote before it becomes actionable, detects an
  already-executed step from balance evidence and lands on
  the next step, and Next stays disabled until the step holds
  valid data; if a step cannot be rebuilt, the flow restarts
  from that step's amount entry instead of an empty step.
  Errors at execution steps are classified: insufficient
  balance / network / no route / price moved / reverted /
  unconfirmed each show their own message. New start points
  (the user's rule: any intermediate asset you already hold
  can start the flow): buys can start from USDT on the entry
  chain (gas coin checked beforehand with its own message)
  or from USDT on 42 Chain; sells can start from USDT on
  42 Chain and can end with the USDT as-is instead of
  converting to BNB/ETH. The flow's end goal (final asset +
  chain + estimate) is stored in the saved state and shown
  on every step screen; the gas auto-keep ($3 of BNB, the
  ETH gas portion) is re-checked at execution and never
  spent by any start or resume. QL1 steps that lack native
  QOM for gas now stop with a dedicated faucet guidance
  (bridged QOM is WQOM and does not pay gas) and a button to
  the new in-app faucet screen — claims of 0.05 [42],
  10,000,000 QOM and 1 ZAP from the public faucet Worker,
  with every rejection code shown in plain language. Also:
  the Recaw choice sheet on the timeline now clears the
  Android navigation bar (bottom safe-area inset, the same
  pattern its Profile-screen sibling already used). The
  HuntersDEX entry is now framed by goal — 「CAW が欲しい人は
  これ」 / 「現金化したい人はこれ」 cards, with the natural
  continuation for the user's current position highlighted
  as おすすめ (holding CAW highlights cashing out) — and a
  U-turn action on the resume card and every step screen
  abandons the current direction and starts the reverse
  goal fresh from the assets currently held (sent legs are
  never reversed). Verified
  by scripts/verify-resume.mjs (75 checks, stubbed chain and
  stubbed faucet Worker) plus all previous suites.
  versionCode 23. v0.4.0 (the open-beta release) added:
  like rows leave the Latest/Following timelines, Recaw shows
  the original post, replies + quote Recaws via the app-level
  marker convention (CAW has no native reply), the
  HuntersDEX rename, and 5 more languages (13 total).
  v0.3.12 fixes the "my post does not appear in the timeline"
  bug (user report 2026-11-08). Root cause: the session page
  cache in cawApi cached the feed's HEAD page from its first
  fetch for the whole session, so mounts, pull-to-refresh and
  the Following walk were all served the same stale first page —
  a post could be confirmed on-chain yet never show up until
  the app process restarted. The head page is now shared only
  while a fetch is in flight and always refetched once settled
  (deeper cursor pages keep their session cache). On top of
  that, the post path now records the confirmed post in
  src/lib/feedSync.ts the moment the send returns its hash:
  the timeline inserts it at the head immediately and each head
  refetch reconciles — once the scanned copy of the same tx
  arrives it takes over, de-duplicated by hash, so no cache
  clearing is ever needed. The Following feed restarts its
  walk from the fresh head on the same signal (the persisted
  follow index is untouched). Verified by
  scripts/verify-feed.mjs (stubbed explorer; the head-refetch
  check fails on the pre-fix code, 9/9 after). versionCode 21.
  v0.3.11 changes no app behavior — it is Google Play
  submission prep. The Actions workflow now also builds a
  signed Android App Bundle (caw-social.aab, attached to the
  Release next to the APK) via the production EAS profile,
  signed with the same keystore as the APK. The app already
  targets Android API 36 (verified in the built v0.3.10 APK),
  which is what Play requires of new apps. Also added: a
  privacy policy page for the store listing
  (docs/privacy.html / docs/privacy-ja.html, live on the
  download site) and listing drafts + a declaration checklist
  (docs/play-listing.md). It also pins the Android versionCode
  in app.json (20) with eas.json appVersionSource set to
  "local": EAS --local builds had silently defaulted
  versionCode to 1 regardless of the old "remote" setting, so
  from now on the repo value is authoritative for BOTH the APK
  and the AAB — bump android.versionCode on every release.
  v0.3.10 is a small UX fix on top of v0.3.9: the restart
  notice shown when switching language across the RTL
  boundary fired on EVERY later switch in a Persian-booted
  session (fa->en, then en->ja, …). It now fires once per
  actual pending-direction change (src/lib/rtl.ts tracks the
  direction queued for the next launch). Nothing else
  changes.
  v0.3.9 adds real right-to-left layout support for Persian
  (fa), removing the limitation noted in v0.3.8: when Persian
  is the app language, the whole UI mirrors right-to-left
  (I18nManager forceRTL, driven from the saved language at
  boot by src/lib/rtl.ts); the other six languages are
  unchanged. Physical left/right styles were audited across
  every screen and converted to logical start/end properties,
  directional glyphs (back/forward arrows, next/expand
  chevrons) flip with the layout, and inherently LTR content
  stays LTR inside its own element — 0x addresses, tx hashes,
  and above all the secret-word grids (onboarding + reveal),
  whose numbered order is pinned left-to-right in every
  language. Switching across the RTL boundary applies from
  the next app start, so the switch shows a one-time notice
  in the newly picked language asking for a restart (there is
  no programmatic reload in this stack — expo-updates is not
  installed); switching within one direction needs no restart.
  v0.3.8 adds three things on top of v0.3.7. (1) A REAL NFT
  preview on the Mint screen: the CAW name NFT image is a
  data-URI SVG whose only variable part is the name itself
  (verified against the on-chain tokenURI of 600+ names; the
  local generator in src/lib/nameNftPreview.ts reproduces the
  contract's SVG byte-for-byte, font size per name length
  included), so once a name is checked the screen shows the
  exact image that name's NFT has / will have. (2) Two new
  languages — Turkish (Türkçe) and Persian (فارسی) — bringing
  the total to seven; every one of the 341 keys is translated
  for both (audit-i18n now checks 7 languages, 35/35). Persian
  initially shipped with the left-to-right layout; full RTL
  mirroring arrived in v0.3.9 (above). (3) A design polish pass in
  the v0.3.7 card language (shared S.cardBox / S.cardFlush /
  S.rowDivider / S.emptyCard primitives): Settings sections
  became cards with divider rows, the backup/reveal text
  blocks sit in cards, HuntersSwap confirm breakdowns and
  done states are cards (done gets a big ✓ badge), sell
  progress parts are a card, the Mint result blocks are
  cards, inbox rows carry a colored kind badge on the avatar
  (♥ pink / Recaw green / follow blue) with a soft empty
  card, post-detail section headers carry the same badges,
  the profile follow counts became a two-cell stat card, and
  timeline/profile empty states use the soft empty card.
  Display only — no behavior or wording changes.
  v0.3.7 is a small UI/wording release on top of v0.3.6: the
  v0.3.4 Home mini header is removed (it duplicated the app
  header — "CAW Social" appeared twice) and its notification
  bell, unread badge included, now lives in the app header next
  to the language selector, always visible without scrolling;
  the wallet card is the first element on Home again. Also, the
  repost action is renamed from Share/シェア to "Recaw" in all
  five languages (a fixed term, never translated) — action
  buttons, the confirm dialog, timeline attribution lines,
  inbox lines and the "Recawed by" header all use the chain
  action's own name. (No OS share-sheet exists in the app, so
  no genuine share label was touched.) The HuntersSwap
  「あなたのコイン」 balance lists (buy + sell entry views) are
  restyled: one rounded card with hairline dividers, a circular
  coin badge per row (brand colors; CAW uses the app logo),
  token name + small chain name on the left, bold amount + a
  small USD line on the right where a price already exists in
  the app (BNB/ETH spot, USDT at $1; 42/QOM/CAW show no USD
  line rather than a made-up figure), zero-balance rows dimmed
  to 45%. The entry-picker cards carry the same badges.
  Display only — no value or logic changes. The MyNames tab is
  compacted the same way: each owned name is now a single
  ~64px row (avatar, name + @handle/#id/followers, deposited
  CAW + chevron) that expands inline as an accordion (one open
  at a time; a name with a deposit/withdraw in flight stays
  open) to reveal the unchanged amount input and 入れる/出す
  controls, with a slim summary line on top (name count +
  total CAW held in names, new 'mine.summary' string in all
  five languages).
  v0.3.6 is a HOTFIX on top of everything in v0.3.4 (the v0.3.5
  build was superseded before release and folded in here): it
  fixes the critical bug that made EVERY HuntersSwap buy/sell
  execution fail before broadcast — engine route objects did not
  carry `amountIn`, so the swap-tx builder threw before any
  transaction reached the chain. Routes now carry `amountIn`
  from the quote that produced them, `freshRoute` normalizes it,
  `buildAggSwap` attaches its explicit amount, and the engine
  builder falls back to `amounts[0]` or throws a clear
  `bad-route` error. Also fixed: the sell progress header showed
  the raw `{a}`/`{b}` template (now passes the real counters).
  Covered by production-path harness tests (live quote ->
  freshRoute -> buildRouteSwapTx -> eth_call simulation from a
  real funded address) in scripts/verify-huntersswap.mjs.
  Also in v0.3.6: the bottom tab bar gets a visible frame
  (deeper top border + subtle upward shadow on solid white;
  flush layout kept so the safe-area and compose-FAB offsets
  stay exact) and the four tab labels get single-line
  shrink-to-fit in slightly wider slots (center slot narrowed),
  so labels like 自分の名前 are never squeezed under the
  raised center button.
  Everything from the folded-in v0.3.5 follows:
  the release makes every balance SENDABLE: a plain 送る (Send) flow
  (from the Home wallet card and from the HuntersSwap header) for
  all eight assets — BSC BNB/USDT, Ethereum ETH/USDT, 42 Chain
  [42]/USDT, QL1 QOM/CAW — pick the asset, type or paste the
  recipient (or pick it from the new address book), amount with
  25/50/75/MAX chips (native MAX leaves the live gas reserve
  behind), a confirm screen showing the FULL recipient address
  and the fee estimate, then the app's usual auth + sign + send.
  The address book is on-device only, shared across wallets:
  register label + address (duplicates are refused and pointed
  at the existing entry), edit/delete, quick-pick chips in the
  send form, and a one-tap save offer after a successful send to
  a new address. Verified read-only by scripts/verify-send.mjs
  (42 checks: calldata/selector per asset, decimals pinned
  against the chain config, address validation, MAX math,
  address-book CRUD + persistence round-trip). NO real sends
  were made from the build environment.
  v0.3.5 also carries the free parts of iPhone readiness: the
  iOS icon (same icon.png) verified alpha-free as iOS requires,
  and the monospace font for addresses/hashes is now
  platform-aware (Menlo on iOS — 'monospace' is Android-only).
  An actual iPhone install still needs the paid Apple Developer
  Program, which is shelved for now.
  v0.3.4 tidies the Home top area: the wallet info is now ONE
  clean card (posting name's avatar + display name + @username, a
  tappable address chip that copies the full address, then CAW
  as the large figure and QOM as the smaller one — single-line
  auto-shrinking numbers, so trillion-scale CAW balances never
  overflow), and the notification bell moved into a slim sticky
  mini header (app logo + "CAW Social" on the left, round bell
  button on the right) that stays on screen while the timeline
  scrolls, with an unread badge counted by the same inbox scan
  the bell opens. The 🐦 emoji that stood in for the app logo is
  gone: the real emblem artwork now appears in the app header,
  the boot screen, onboarding and the unlock screen.
  v0.3.3 adds one small thing: the HuntersSwap entry screen now
  shows your **deposit address above the balances** (both buy and
  sell views) — the active wallet's own address, the same on every
  chain (BSC / Ethereum / 42 Chain / QL1), in monospace with a
  copy button and a brief "Copied!" confirmation, so it can be
  pasted straight into an exchange or another wallet.
  v0.3.2 fixes the **HuntersSwap sell-quote failure** reported on a
  real device (a 532M qCAW sell sat on "checking…" then failed with
  the generic error). Root cause: the quote engine fired many
  SEQUENTIAL RPC calls with no timeout and no retry, so one stalled
  call on mobile data killed the whole quote (measured 26 s even on
  a wired connection). Now: transport failures retry twice with
  backoff and every attempt is time-boxed; bridge pairs quote
  concurrently (max 4 in flight) and are isolated — a failing route
  family is disabled, the plan still returns; the best single route
  is computed first and the split search only runs when the trade
  is worth ~$50+ (in the QL1->42 direction leg fees are 0, so
  splits "won" by dust on tiny outputs — the reported amount now
  quotes in ~4 s with the same result and no split). Quotes past
  ~15 s show a plain "still looking" line, and failures now say
  whether it was the connection or no-route. v0.3.2 also adds
  **quote-only mode**: amounts above your balance (and below the
  ETH $100 minimum) still get a full estimate — the balance gate
  moved to the start button on the confirm screen ("estimate
  only" note; send-time checks unchanged) — and moves the
  HuntersSwap entry to a **raised orange button in the center of
  the tab bar** (an action, not a tab; the big buy button on My
  Names is gone, the Get-Name shortfall prompt is now a link, and
  the modal header reads "Buy / sell CAW" in both directions).
  v0.3.2 also unifies the token's DISPLAY name: every screen now
  says **CAW**, never qCAW (display layer only — token ids,
  addresses and storage are unchanged).
  Verification: `scripts/verify-huntersswap.mjs` 44 checks incl.
  injected-fault runs (first QL1 calls throw; one route family
  always throws) and the exact reported amount timed live.
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
  v0.3.1 also ships the **new app icon** (the user's artwork:
  yellow emblem disc on navy #151426) — icon, Android adaptive
  icon (emblem padded to ~78% so launcher masks never clip it,
  navy background, monochrome silhouette generated from the
  artwork) and splash (navy background so it blends seamlessly).
  The source was 400x400, upscaled with Lanczos to 1024.
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
- Thirteen languages — English (default), 日本語， 简体中文， 한국어，
  Español, Türkçe, فارسی, Bahasa Indonesia, Tiếng Việt, Português,
  Nederlands, हिन्दी, Français — switchable in Settings.

## Replies and quote Recaws (v0.4.0) — an app-level convention

CAW itself has **no reply convention**: a full read of the on-chain
action feed (6,065 actions, 1,035 posts, checked 2026-11-08) shows
every post carries `receiverId = 0` and no post references a parent,
and the CawActions contract exposes no thread/reply notion. Plain
recaws and likes do reference their target (type 1/2 actions carry
the target's `cawId`), but posts do not.

So this app implements replies and quote Recaws as ordinary posts
with one extra marker, documented here so anyone can implement the
same reading rule:

- A reply or quote is a normal type-0 post: its own fresh random
  `cawId`, `receiverId` still `0`, sent through the unchanged
  signing path. Its **text ends with one marker line**:

  ```
  [caw:reply:<base64url(parent cawId, 32 bytes, no padding)>]
  [caw:quote:<base64url(parent cawId, 32 bytes, no padding)>]
  ```

  The keyword distinguishes reply from quote; a post without the
  marker is a plain post. The marker costs 56 bytes of the
  420-byte post budget.

**Honest interop note:** other CAW clients do not know this
convention. In them, a reply or quote from this app appears as an
ordinary post whose text ends with that small bracketed line.
Nothing on-chain changes for anyone; this app simply reads the
marker to build threads and quote frames, and any client can do
the same.

Also in v0.4.0: **likes no longer appear as rows** in the Latest
and Following feeds (presentation only — like counts, liked-by
lists and reaction summaries still read them), and a **Recaw row
shows the original post** it points to, X-style, instead of a bare
"recawed your post" line (with an explicit fallback when the
original is not in the local index).

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
