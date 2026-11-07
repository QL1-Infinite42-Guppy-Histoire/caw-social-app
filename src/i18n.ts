/**
 * Minimal i18n: English by default, Japanese selectable — the same
 * language scheme as the user's other recent products. Plain everyday
 * words only; no jargon on screen.
 *
 * The current language lives in a module-level variable (set by
 * LanguageContext) so plain library code can translate too, mirroring
 * the GuppyWallet pattern.
 */
export type Lang = 'en' | 'ja';

let current: Lang = 'en';
export function setLang(l: Lang): void {
  current = l;
}
export function getLang(): Lang {
  return current;
}

const STRINGS = {
  en: {
    'app.name': 'CAW Social',
    'app.tagline': 'CAW on QL1',
    'app.notOfficial':
      'A community app made by a fan. Not run by the official CAW team.',
    'nav.home': 'Home',
    'nav.getName': 'Get a name',
    'nav.myNames': 'My names',
    'nav.settings': 'Settings',

    'wallet.create': 'Make a new wallet',
    'wallet.import': 'Bring in a wallet you already have',
    'wallet.createDesc':
      'You will get a list of secret words. They are the only way back into your wallet — write them down on paper and keep them safe.',
    'wallet.importDesc':
      'Type the secret words (or a private key) of the wallet you want to use. They never leave this phone.',
    'wallet.wordsTitle': 'Your secret words',
    'wallet.wordsWarn':
      'Anyone who sees these words can take everything in the wallet. Never share them, never type them into a website.',
    'wallet.savedIt': 'I wrote them down',
    'wallet.pasteWords': 'Secret words (12 or 24, in order)',
    'wallet.pasteKey': 'Private key (0x…) — or paste secret words above',
    'wallet.importBtn': 'Bring it in',
    'wallet.badWords': 'Those words do not look right. Please check them.',
    'wallet.badKey': 'That key does not look right. Please check it.',
    'wallet.setupTitle': 'Set up your wallet',
    'wallet.chooseUnlock': 'How do you want to open the app?',
    'wallet.unlockBio': 'Fingerprint / face (if your phone has it)',
    'wallet.unlockPw': 'A password you choose',
    'wallet.pwPh': 'Password (6 letters or more)',
    'wallet.pw2Ph': 'Same password again',
    'wallet.pwShort': 'Please use at least 6 characters.',
    'wallet.pwMismatch': 'The two passwords are different.',
    'wallet.done': 'Done',
    'wallet.address': 'Your address',

    'unlock.title': 'Welcome back',
    'unlock.pwPh': 'Password',
    'unlock.open': 'Open',
    'unlock.wrong': 'That password is not right.',
    'unlock.bio': 'Use fingerprint / face',

    'auth.reason': 'To open CAW Social',
    'auth.signReason': 'To OK this action',

    'home.qom': 'QOM (for small fees)',
    'home.qcaw': 'qCAW in wallet',
    'home.post': 'Post',
    'home.postAs': 'Posting as',
    'home.connecting': 'Loading…',

    'tl.loading': 'Loading…',
    'tl.loadFail': 'Could not load the timeline. Please try again later.',
    'tl.empty': 'No actions found yet.',
    'tl.more': 'See more',
    'tl.like': 'Like',
    'tl.recaw': 'Share',
    'tl.likes': 'likes',
    'tl.viewTx': 'see the record',
    'tl.ctxLike': 'Liked a post by {name}',
    'tl.ctxRecaw': 'Shared a post by {name}',
    'tl.ctxFollow': 'Followed {name}',
    'tl.unknownName': 'name #',

    'compose.title': 'New post',
    'compose.ph': 'What is happening?',
    'compose.help': 'Up to 420 letters. A Japanese letter counts as 3.',
    'compose.post': 'Post',
    'compose.postAs': 'Post as',
    'compose.needName': 'Get a name first — then you can post.',
    'compose.confirmTitle': 'Send this post?',
    'compose.confirmPost': 'You are about to post this as {name}.',
    'compose.send': 'Send it',
    'compose.cancel': 'Not yet',
    'compose.sending': 'Sending…',
    'compose.posted': 'Posted!',
    'compose.failed': 'It did not go through. Please try again.',
    'compose.authFirst': 'First, OK it is really you.',

    'act.like': 'Like',
    'act.share': 'Share',
    'act.follow': 'Follow',
    'act.followed': 'Followed!',
    'act.confirmLike': 'Like this post as {name}?',
    'act.confirmShare': 'Share this post as {name}?',
    'act.confirmFollow': 'Follow {target} as {name}?',
    'act.sending': 'Sending…',
    'act.done': 'Done!',
    'act.failed': 'It did not go through. Please try again.',

    'profile.posts': 'Posts',
    'profile.followers': 'followers',
    'profile.inName': 'inside this name',
    'profile.nameMade': 'Name made on',
    'profile.owner': 'Owner',
    'profile.yourName': 'This is your name',
    'profile.notFound': 'That name was not found.',
    'profile.loadFail':
      'Could not read this name. Please check your connection and try again.',
    'profile.retry': 'Try again',
    'profile.more': 'See more',
    'profile.empty': 'No posts yet.',

    'get.title': 'Get a name',
    'get.desc':
      'Your name is how people find you on CAW. Names use small letters, numbers and underscores.',
    'get.ph': 'the name you want',
    'get.check': 'Check',
    'get.checking': 'Checking…',
    'get.invalid':
      'That name cannot be used. Names use small letters, numbers and underscores.',
    'get.taken': 'That name is already taken.',
    'get.available': 'This name is available!',
    'get.price': 'Price',
    'get.checkFail': 'Could not check. Please try again.',
    'get.yourQcaw': 'Your qCAW',
    'get.step1': 'Step 1 of 2 — let the app use your qCAW to pay for the name',
    'get.step2': 'Step 2 of 2 — one more tap and the name is yours',
    'get.approveBtn': 'OK, allow it',
    'get.mintBtn': 'Get this name',
    'get.notEnough': 'Not enough qCAW for this name.',
    'get.confirmApprove': 'Allow {amount} qCAW to be used for this name?',
    'get.confirmMint': 'Get the name @{name} for {amount} qCAW?',
    'get.sending': 'Check the “it is really you” step…',
    'get.waiting': 'Waiting for the chain…',
    'get.done': 'Done!',
    'get.failed': 'The transaction failed. Please try again.',

    'mine.title': 'My names',
    'mine.none': 'This wallet has no CAW names yet. Get one in “Get a name”!',
    'mine.inName': 'inside this name',
    'mine.followers': 'followers',
    'mine.amountPh': 'amount (qCAW)',
    'mine.deposit': 'Put in',
    'mine.withdraw': 'Take out',
    'mine.approveFirst': 'One quick OK first, so your qCAW can move into the name',
    'mine.confirmDeposit': 'Put {amount} qCAW into @{name}?',
    'mine.confirmWithdraw': 'Take {amount} qCAW out of @{name}?',
    'mine.badAmount': 'Please type an amount.',
    'mine.sending': 'Sending…',
    'mine.waiting': 'Waiting for the chain…',
    'mine.done': 'Done!',
    'mine.failed': 'It did not go through. Please try again.',
    'mine.loadFail': 'Could not load your names. Please try again.',

    'settings.title': 'Settings',
    'settings.language': 'Language',
    'settings.address': 'Your wallet address',
    'settings.copy': 'Copy',
    'settings.copied': 'Copied!',
    'settings.lockNow': 'Lock now',
    'settings.about': 'About this app',
    'settings.aboutBody':
      'CAW Social for QL1. Read the timeline, get a name, post and follow — all signed right here in the app, so no other wallet app is needed. This is a community app, not run by the official CAW team.',
    'settings.danger': 'Danger zone',
    'settings.delete': 'Remove the wallet from this phone',
    'settings.deleteWarn':
      'This removes the wallet from this phone only. If you did not write down your secret words, the wallet is gone for good. Your names and coins stay on the chain.',
    'settings.deleteConfirm': 'Remove it',
    'settings.cancel': 'Cancel',
    'common.back': 'Back',
    'common.close': 'Close',
    'common.loading': 'Loading…',
  },
  ja: {
    'app.name': 'CAW Social',
    'app.tagline': 'QL1 版',
    'app.notOfficial': '有志が作ったアプリです。CAW 公式チームの運営ではありません。',
    'nav.home': 'ホーム',
    'nav.getName': '名前を取る',
    'nav.myNames': '自分の名前',
    'nav.settings': '設定',

    'wallet.create': '新しいウォレットを作る',
    'wallet.import': '持っているウォレットを取り込む',
    'wallet.createDesc':
      '秘密の言葉の一覧が表示されます。ウォレットに戻る唯一の手がかりです。紙に書いて大切に保管してください。',
    'wallet.importDesc':
      '使いたいウォレットの秘密の言葉（または秘密キー）を入力してください。このスマホの外には出ません。',
    'wallet.wordsTitle': 'あなたの秘密の言葉',
    'wallet.wordsWarn':
      'この言葉を見た人は、ウォレットの中身を全部取れてしまいます。誰にも見せず、ウェブサイトに入力しないでください。',
    'wallet.savedIt': '書き留めました',
    'wallet.pasteWords': '秘密の言葉（12個か24個、順番どおりに）',
    'wallet.pasteKey': '秘密キー（0x…）— 言葉は上の欄へ',
    'wallet.importBtn': '取り込む',
    'wallet.badWords': '言葉が正しくないようです。確認してください。',
    'wallet.badKey': 'キーが正しくないようです。確認してください。',
    'wallet.setupTitle': 'ウォレットの準備',
    'wallet.chooseUnlock': 'アプリを開く方法を選んでください',
    'wallet.unlockBio': '指紋・顔（スマホに対応があれば）',
    'wallet.unlockPw': '自分で決めるパスワード',
    'wallet.pwPh': 'パスワード（6文字以上）',
    'wallet.pw2Ph': '同じパスワードをもう一度',
    'wallet.pwShort': '6文字以上にしてください。',
    'wallet.pwMismatch': '2つのパスワードが違います。',
    'wallet.done': '完了',
    'wallet.address': 'あなたのアドレス',

    'unlock.title': 'おかえりなさい',
    'unlock.pwPh': 'パスワード',
    'unlock.open': '開く',
    'unlock.wrong': 'パスワードが違います。',
    'unlock.bio': '指紋・顔で開く',

    'auth.reason': 'CAW Social を開くため',
    'auth.signReason': 'この操作の確認のため',

    'home.qom': 'QOM（手数料用）',
    'home.qcaw': 'ウォレットの qCAW',
    'home.post': '投稿する',
    'home.postAs': 'この名前で投稿',
    'home.connecting': '読み込み中…',

    'tl.loading': '読み込み中…',
    'tl.loadFail': 'タイムラインを読み込めませんでした。しばらくしてからお試しください。',
    'tl.empty': 'まだアクションがありません。',
    'tl.more': 'もっと見る',
    'tl.like': 'いいね',
    'tl.recaw': 'シェア',
    'tl.likes': 'いいね',
    'tl.viewTx': '記録を見る',
    'tl.ctxLike': '{name} さんの投稿にいいね',
    'tl.ctxRecaw': '{name} さんの投稿をシェア',
    'tl.ctxFollow': '{name} さんをフォロー',
    'tl.unknownName': '名前 #',

    'compose.title': '新しい投稿',
    'compose.ph': 'いま何してる？',
    'compose.help': '最大420文字分まで（日本語は1文字で3文字分です）',
    'compose.post': '投稿する',
    'compose.postAs': 'この名前で投稿',
    'compose.needName': '投稿するには、先に名前を取ってください。',
    'compose.confirmTitle': 'この内容で投稿しますか？',
    'compose.confirmPost': '{name} として投稿します。',
    'compose.send': '投稿する',
    'compose.cancel': 'やめておく',
    'compose.sending': '送信しています…',
    'compose.posted': '投稿しました！',
    'compose.failed': '送信できませんでした。もう一度お試しください。',
    'compose.authFirst': 'まず「本人確認」をお願いします。',

    'act.like': 'いいね',
    'act.share': 'シェア',
    'act.follow': 'フォローする',
    'act.followed': 'フォローしました！',
    'act.confirmLike': '{name} として、この投稿にいいねしますか？',
    'act.confirmShare': '{name} として、この投稿をシェアしますか？',
    'act.confirmFollow': '{name} として {target} さんをフォローしますか？',
    'act.sending': '送信しています…',
    'act.done': 'できました！',
    'act.failed': '送信できませんでした。もう一度お試しください。',

    'profile.posts': '投稿',
    'profile.followers': 'フォロワー',
    'profile.inName': 'この名前の中にある qCAW',
    'profile.nameMade': '名前が作られた日',
    'profile.owner': '持ち主',
    'profile.yourName': 'これはあなたの名前です',
    'profile.notFound': 'その名前は見つかりませんでした。',
    'profile.loadFail': '名前を読み取れませんでした。通信を確認してもう一度お試しください。',
    'profile.retry': 'もう一度試す',
    'profile.more': 'もっと見る',
    'profile.empty': 'まだ投稿がありません。',

    'get.title': '名前を取る',
    'get.desc': '名前は、CAW であなたを見つけてもらうためのものです。名前は小文字・数字・アンダースコアです。',
    'get.ph': 'ほしい名前',
    'get.check': '調べる',
    'get.checking': '調べています…',
    'get.invalid': 'その名前は使えません。名前は小文字・数字・アンダースコアです。',
    'get.taken': 'その名前はすでに使われています。',
    'get.available': 'この名前は取れます！',
    'get.price': '価格',
    'get.checkFail': '調べられませんでした。もう一度お試しください。',
    'get.yourQcaw': 'あなたの qCAW',
    'get.step1': 'ステップ 1/2：名前の料金に、あなたの qCAW を使う許可を出します',
    'get.step2': 'ステップ 2/2：あと1タップで名前が取れます',
    'get.approveBtn': '許可する',
    'get.mintBtn': 'この名前を取る',
    'get.notEnough': 'qCAW が足りません。',
    'get.confirmApprove': 'この名前のために {amount} qCAW の使用を許可しますか？',
    'get.confirmMint': '{amount} qCAW で @{name} を取りますか？',
    'get.sending': '本人確認をお願いします…',
    'get.waiting': 'チェーンの確定を待っています…',
    'get.done': 'できました！',
    'get.failed': '取引が失敗しました。もう一度お試しください。',

    'mine.title': '自分の名前',
    'mine.none': 'このウォレットには、まだ CAW の名前がありません。「名前を取る」で取ってみましょう！',
    'mine.inName': 'この名前の中にある qCAW',
    'mine.followers': 'フォロワー',
    'mine.amountPh': '量（qCAW）',
    'mine.deposit': '入れる',
    'mine.withdraw': '出す',
    'mine.approveFirst': '先に、qCAW を名前へ移す許可が必要です',
    'mine.confirmDeposit': '@{name} に {amount} qCAW を入れますか？',
    'mine.confirmWithdraw': '@{name} から {amount} qCAW を出しますか？',
    'mine.badAmount': '量を入力してください。',
    'mine.sending': '送信しています…',
    'mine.waiting': 'チェーンの確定を待っています…',
    'mine.done': 'できました！',
    'mine.failed': '送信できませんでした。もう一度お試しください。',
    'mine.loadFail': '名前を読み込めませんでした。もう一度お試しください。',

    'settings.title': '設定',
    'settings.language': '言語 / Language',
    'settings.address': 'あなたのウォレットのアドレス',
    'settings.copy': 'コピー',
    'settings.copied': 'コピーしました！',
    'settings.lockNow': '今すぐロックする',
    'settings.about': 'このアプリについて',
    'settings.aboutBody':
      'QL1 の CAW Social です。タイムラインを見る、名前を取る、投稿する、フォローする——署名まで全部このアプリの中で完結するので、他のウォレットアプリは要りません。有志が作ったアプリで、CAW 公式チームの運営ではありません。',
    'settings.danger': '危険な操作',
    'settings.delete': 'このスマホからウォレットを消す',
    'settings.deleteWarn':
      'このスマホからウォレットを消すだけです。秘密の言葉を書き留めていないと、ウォレットには二度と戻れません。名前とコインはチェーン上に残ります。',
    'settings.deleteConfirm': '消す',
    'settings.cancel': 'やめておく',
    'common.back': '戻る',
    'common.close': '閉じる',
    'common.loading': '読み込み中…',
  },
} as const;

export type StrKey = keyof (typeof STRINGS)['en'];

export function tr(key: StrKey, vars?: Record<string, string>): string {
  let s: string = STRINGS[current][key] || STRINGS.en[key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split('{' + k + '}').join(v);
    }
  }
  return s;
}
