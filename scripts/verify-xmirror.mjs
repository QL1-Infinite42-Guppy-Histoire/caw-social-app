#!/usr/bin/env node
/**
 * X mirror verification (v0.5.0-x).
 *
 * Pins the whole mirror design with stubbed X API fixtures —
 * no live X call is possible (or wanted) from here:
 *  §1 OAuth/PKCE shapes: authorize URL, token bodies (a
 *     client_secret must NEVER appear — PKCE is the proof),
 *     redirect parsing incl. state-mismatch refusal, session
 *     expiry arithmetic, refresh shapes, read-only scopes.
 *  §2 Timeline fixtures: paging, quote posts included,
 *     retweets and replies excluded (both marker shapes),
 *     malformed entries dropped, page-merge dedupe, the
 *     engraved-set dedupe, error classification (429 / 403
 *     plan / 401 / errors-array), the post-cost constant.
 *  §3 The engraved store: record → has across instances,
 *     per-account isolation, reset, broken-record tolerance.
 *  §4 The Worker half (worker/xmirror.js): registration
 *     validation, poll planning (first poll = silent
 *     baseline, then exactly-once notify, oldest first),
 *     push payloads carry ONLY post id + preview,
 *     token-refresh bookkeeping.
 *  §5 Wiring statics: tokens live ONLY in the secure store,
 *     the Client ID is user-entered (no credential literal
 *     anywhere), engraving passes through the standard sign
 *     flow (auth → shortfall → submit → record, text EXACT),
 *     the notification deep link routes to the mirror
 *     screen, the Worker bundle builds with the cron poller.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = ROOT + '/scripts/.build-xmirror';
let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log('  ok  ' + label);
  } else {
    fail++;
    console.log('  FAIL ' + label);
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
try {
  execFileSync(
    'npx',
    [
      'tsc',
      '--ignoreConfig',
      'src/config.ts',
      'src/lib/myActions.ts',
      'src/lib/xmirror.ts',
      'src/lib/xMirrorStore.ts',
      '--outDir',
      OUT,
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: ROOT, stdio: 'pipe' },
  );
  ok(true, 'tsc compiles the xmirror graph');
} catch (e) {
  ok(false, 'tsc: ' + (e.stdout || '').toString().slice(0, 400));
  process.exit(1);
}
writeFileSync(OUT + '/package.json', '{"type":"commonjs"}');

const XM = await import(OUT + '/lib/xmirror.js');
const XS = await import(OUT + '/lib/xMirrorStore.js');
const WX = await import(pathToFileURL(ROOT + '/worker/xmirror.js').href);

/* ================= §1 OAuth / PKCE / sessions ================= */
{
  ok(
    XM.base64UrlEncode(new Uint8Array([251, 255, 190])) === '-_--',
    'base64url: encodes the +/ alphabet as -_',
  );
  ok(XM.base64ToBase64Url('ab+/cd==') === 'ab-_cd', 'base64 → base64url strips padding');
  const verifier = XM.pkceVerifier(new Uint8Array(32).fill(7));
  ok(verifier.length === 43 && !verifier.includes('='), 'PKCE verifier: 43 chars, unpadded');

  const url = XM.buildAuthorizeUrl({
    clientId: 'USER-ENTERED-ID',
    redirectUri: XM.X_REDIRECT_URI,
    codeChallenge: 'CH',
    state: 'ST',
  });
  ok(url.startsWith('https://twitter.com/i/oauth2/authorize?'), 'authorize URL host');
  ok(url.includes('response_type=code'), 'authorize URL: response_type=code');
  ok(url.includes('code_challenge_method=S256'), 'authorize URL: S256');
  ok(
    decodeURIComponent(url)
      .replace(/\+/g, ' ')
      .includes('scope=tweet.read users.read offline.access'),
    'authorize URL: read + offline scopes',
  );
  ok(XM.scopesAreReadOnly() === true, 'scopes are read-only (no write anywhere)');
  ok(XM.X_REDIRECT_URI === 'cawsocial://x-callback', 'redirect URI is the app scheme');

  const body = XM.buildTokenExchangeBody({
    clientId: 'USER-ENTERED-ID',
    redirectUri: XM.X_REDIRECT_URI,
    code: 'CODE1',
    codeVerifier: verifier,
  });
  ok(body.includes('grant_type=authorization_code'), 'exchange body: grant type');
  ok(body.includes('code_verifier=' + verifier), 'exchange body: PKCE verifier');
  ok(body.includes('client_id=USER-ENTERED-ID'), 'exchange body: client id in body');
  ok(!body.includes('secret'), 'exchange body: NO secret of any kind');

  const rb = XM.buildRefreshBody({ clientId: 'USER-ENTERED-ID', refreshToken: 'RT1' });
  ok(
    rb.includes('grant_type=refresh_token') && rb.includes('refresh_token=RT1') &&
      !rb.includes('secret'),
    'refresh body: grant + token, no secret',
  );

  const good = XM.parseAuthRedirect(
    'cawsocial://x-callback?code=CODE1&state=ST',
    'ST',
  );
  ok(good.ok && good.code === 'CODE1', 'redirect: code accepted on state match');
  ok(
    XM.parseAuthRedirect('cawsocial://x-callback?code=CODE1&state=XX', 'ST').ok === false,
    'redirect: state mismatch refused',
  );
  ok(
    XM.parseAuthRedirect('cawsocial://x-callback?error=access_denied&state=ST', 'ST').ok ===
      false,
    'redirect: user denial surfaced, no code',
  );
  ok(
    XM.parseAuthRedirect('cawsocial://x-callback?state=ST', 'ST').ok === false,
    'redirect: missing code refused',
  );

  const grant = XM.sessionFromTokenResponse(
    {
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expires_in: 7200,
      token_type: 'bearer',
      scope: 'tweet.read users.read offline.access',
    },
    1000,
  );
  ok(grant && grant.expiresAt === 8200, 'session: expiry = obtained + expires_in');
  ok(
    XM.sessionFromTokenResponse({ access_token: 'at-1' }, 0) === null,
    'session: a body without refresh token is not a session',
  );
  ok(
    XM.sessionFromTokenResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 0 }, 0) === null,
    'session: non-positive expiry refused',
  );
  const sess = { ...grant, userId: '42', username: 'someone' };
  ok(XM.accessTokenUsable(sess, 8000) === true, 'usable: well before expiry');
  ok(XM.accessTokenUsable(sess, 8180) === false, 'usable: 30 s slack before expiry refuses');
}

/* ================= §2 Timeline fixtures ================= */
const PAGE1 = {
  data: [
    { id: '1005', text: 'gm — shipping day', created_at: '2026-11-10T09:00:00.000Z' },
    {
      id: '1004',
      text: 'quoting a friend',
      created_at: '2026-11-09T08:00:00.000Z',
      referenced_tweets: [{ type: 'quoted', id: '999' }],
    },
    {
      id: '1003',
      text: 'RT @someone: not my words',
      created_at: '2026-11-09T07:00:00.000Z',
      referenced_tweets: [{ type: 'retweeted', id: '998' }],
    },
    {
      id: '1002',
      text: 'a reply in a thread',
      created_at: '2026-11-09T06:00:00.000Z',
      referenced_tweets: [{ type: 'replied_to', id: '997' }],
      in_reply_to_user_id: '42',
    },
    {
      id: '1001',
      text: 'reply flagged only by in_reply_to_user_id',
      created_at: '2026-11-09T05:00:00.000Z',
      in_reply_to_user_id: '42',
    },
    { id: '1000' },
    'garbage',
  ],
  meta: { next_token: 'PAGE2TOKEN', result_count: 7 },
};
const PAGE2 = {
  data: [
    {
      id: '1004',
      text: 'quoting a friend',
      created_at: '2026-11-09T08:00:00.000Z',
      referenced_tweets: [{ type: 'quoted', id: '999' }],
    },
    { id: '999', text: 'an older original', created_at: '2026-11-08T05:00:00.000Z' },
  ],
  meta: {},
};
{
  const p1 = XM.parseTimelinePage(PAGE1);
  ok(
    p1.posts.map((p) => p.id).join(',') === '1005,1004',
    'timeline: originals + quotes in, RT/replies/malformed out',
  );
  ok(p1.nextToken === 'PAGE2TOKEN', 'timeline: next_token passes through');
  const p2 = XM.parseTimelinePage(PAGE2);
  ok(p2.nextToken === null, 'timeline: last page has no next token');
  const merged = XM.mergePages([p1.posts, p2.posts]);
  ok(
    merged.map((p) => p.id).join(',') === '1005,1004,999',
    'merge: page overlap deduped, order preserved',
  );
  const cand = XM.mirrorCandidates(merged, new Set(['1004']));
  ok(
    cand.map((p) => p.id).join(',') === '1005,999',
    'candidates: engraved ids leave the inbox',
  );
  ok(
    XM.mirrorCandidates(merged, new Map([['1005', '0xabc']]))
      .map((p) => p.id)
      .join(',') === '1004,999',
    'candidates: works against the engraved MAP too',
  );
  ok(
    XM.timelinePath('42').includes('exclude=retweets%2Creplies'),
    'timeline path: API-level exclusion requested as first net',
  );
  ok(
    XM.timelinePath('42', 'TOK').includes('pagination_token=TOK'),
    'timeline path: paging token wired',
  );
  ok(XM.POST_COST_RAW === 5000n * 10n ** 18n, 'post cost constant = 5,000 CAW');

  const e429 = XM.classifyXError(429, {
    title: 'Too Many Requests',
    detail: 'Too Many Requests',
  });
  ok(e429.kind === 'rate-limit', 'error: 429 → rate-limit');
  const e403 = XM.classifyXError(403, {
    title: 'Forbidden',
    detail: 'Your current plan does not allow access to this endpoint.',
  });
  ok(
    e403.kind === 'no-access' && e403.detail.includes('plan'),
    'error: 403 → no-access (the plan verdict), detail kept',
  );
  const e401 = XM.classifyXError(401, {
    errors: [{ message: 'Invalid or expired token' }],
  });
  ok(
    e401.kind === 'auth' && e401.detail === 'Invalid or expired token',
    'error: 401 → auth, errors-array detail kept',
  );
  ok(
    XM.classifyXError(500, null).kind === 'unknown',
    'error: anything else → unknown, never disguised',
  );
  ok(
    XM.networkErrorInfo(new Error('boom')).kind === 'network',
    'error: a thrown fetch is a network error',
  );
  ok(XM.previewSnippet('a\n\n  b   c').length <= 80, 'preview: flattened');
  ok(
    XM.previewSnippet('x'.repeat(200)).length === 80,
    'preview: capped at 80 chars',
  );
}

/* ================= §3 Engraved store ================= */
{
  const backing = new Map();
  const kv = {
    getItem: async (k) => backing.get(k) ?? null,
    setItem: async (k, v) => {
      backing.set(k, v);
    },
  };
  const s1 = new XS.XMirrorStore();
  await s1.init(kv, '42');
  ok(!s1.has('1005'), 'store: cold start knows nothing');
  await s1.record('1005', '0xcaw1');
  ok(s1.has('1005') && s1.cawIdOf('1005') === '0xcaw1', 'store: record → has + cawId');
  const s2 = new XS.XMirrorStore();
  await s2.init(kv, '42');
  ok(s2.has('1005'), 'store: the mapping survives across instances (KV)');
  const s3 = new XS.XMirrorStore();
  await s3.init(kv, '777');
  ok(!s3.has('1005'), 'store: a different X account starts clean');
  await s2.reset();
  const s4 = new XS.XMirrorStore();
  await s4.init(kv, '42');
  ok(!s4.has('1005'), 'store: reset forgets (disconnect semantics)');
  backing.set('caw-xmirror-engraved-42', '{broken json');
  const s5 = new XS.XMirrorStore();
  await s5.init(kv, '42');
  ok(!s5.has('1005'), 'store: a broken record reads as empty, never crashes');
}

/* ================= §4 Worker half ================= */
{
  const goodReg = {
    pushToken: 'ExponentPushToken[abc123]',
    xUserId: '42',
    username: 'someone',
    clientId: 'USER-ENTERED-ID',
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: 8200,
  };
  ok(WX.validateRegistration(goodReg) === null, 'worker: a well-formed registration passes');
  ok(
    WX.validateRegistration({ ...goodReg, pushToken: 'not-a-token' }) === 'bad-push-token',
    'worker: bad push token refused',
  );
  ok(
    WX.validateRegistration({ ...goodReg, xUserId: 'x42' }) === 'bad-user-id',
    'worker: non-numeric user id refused',
  );
  ok(
    WX.validateRegistration({ ...goodReg, refreshToken: '' }) === 'bad-refresh-token',
    'worker: a registration without a refresh token refused (polling would die in 2 h)',
  );

  const posts = [
    { id: '3', text: 'third', createdAt: '' },
    { id: '2', text: 'second', createdAt: '' },
    { id: '1', text: 'first', createdAt: '' },
  ];
  const base = WX.planPoll(null, posts);
  ok(
    base.baseline === true && base.fresh.length === 0 &&
      base.nextSeen.join(',') === '3,2,1',
    'poll: FIRST poll is a silent baseline — no flood of history',
  );
  const next = WX.planPoll(base.nextSeen, [
    { id: '5', text: 'fifth', createdAt: '' },
    { id: '4', text: 'fourth', createdAt: '' },
    ...posts,
  ]);
  ok(
    next.fresh.map((p) => p.id).join(',') === '4,5',
    'poll: new posts notify OLDEST FIRST',
  );
  const again = WX.planPoll(next.nextSeen, [
    { id: '5', text: 'fifth', createdAt: '' },
    { id: '4', text: 'fourth', createdAt: '' },
    ...posts,
  ]);
  ok(again.fresh.length === 0, 'poll: seen posts never notify twice');

  const msgs = WX.buildPushMessages(next.fresh, goodReg.pushToken);
  ok(msgs.length === 2, 'push: one message per fresh post');
  const m = msgs[0];
  ok(
    m.to === goodReg.pushToken && m.categoryId === 'xmirror',
    'push: addressed to the device, xmirror category (the 刻む button)',
  );
  ok(
    m.data.xPostId === '4' && typeof m.data.preview === 'string',
    'push: payload carries the post id + preview',
  );
  const flat = JSON.stringify(msgs);
  ok(
    !flat.includes('accessToken') && !flat.includes('refreshToken') &&
      !flat.includes('at-1') && !flat.includes('rt-1'),
    'push: NO token material anywhere in the payload',
  );

  const wposts = WX.parseTimeline(PAGE1);
  ok(
    wposts.map((p) => p.id).join(',') === '1005,1004',
    'worker timeline: same classification as the app',
  );

  const sub = { ...goodReg };
  ok(WX.tokenNeedsRefresh(sub, 8000) === false, 'worker refresh: fresh token left alone');
  ok(WX.tokenNeedsRefresh(sub, 8150) === true, 'worker refresh: expiring token refreshed');
  const applied = WX.applyTokenResponse(
    sub,
    { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 7200 },
    1000,
  );
  ok(
    applied && applied.accessToken === 'at-2' && applied.expiresAt === 8200,
    'worker refresh: grant applied with new expiry',
  );
  ok(
    WX.applyTokenResponse(sub, { error: 'invalid_grant' }, 1000) === null,
    'worker refresh: a non-grant leaves the subscription untouched',
  );
  ok(
    !WX.refreshBody(sub).includes('secret'),
    'worker refresh body: no secret exists to send',
  );
}

/* ================= §5 Wiring statics ================= */
{
  const read = (p) => readFileSync(ROOT + '/' + p, 'utf8');
  const xc = read('src/lib/xconnect.ts');
  const xmSrc = read('src/lib/xmirror.ts');
  const af = read('src/lib/actionFlow.ts');
  const flow = af.slice(af.indexOf('export async function performMirrorPost'));
  const iShort = flow.indexOf("Error('shortfall')");
  const iAlready = flow.indexOf("Error('already-engraved')");
  const iAuth = flow.indexOf('app.requireAuth()');
  const iSubmit = flow.indexOf('submitAction(');
  const iRecord = flow.indexOf('xMirrorStore.record');
  ok(iAlready > 0 && iAlready < iSubmit, 'engrave: already-engraved check precedes signing');
  ok(iShort > 0 && iShort < iSubmit, 'engrave: shortfall hard stop precedes signing');
  ok(iAuth > 0 && iAuth < iSubmit, 'engrave: passes through requireAuth before submit');
  ok(iSubmit > 0 && iRecord > iSubmit, 'engrave: mapping recorded only AFTER the confirmed submit');
  ok(flow.includes('text: args.post.text'), 'engrave: the X text is posted EXACTLY');
  ok(
    !flow.includes('appendPostRef') && !flow.includes('postRef'),
    'engrave: no marker or suffix is ever added',
  );
  ok(flow.includes('type: 0'), 'engrave: a normal kind-0 post');

  ok(
    xc.includes('SecureStore.setItemAsync') && xc.includes('SESSION_KEY'),
    'tokens: the X session is written to the secure store',
  );
  ok(!xc.includes('AsyncStorage'), 'tokens: never in AsyncStorage');
  ok(
    xc.includes('WHEN_UNLOCKED_THIS_DEVICE_ONLY'),
    'tokens: same secure-store class as the wallet material',
  );
  ok(
    xc.includes('openAuthSessionAsync') && xc.includes('pkceVerifier'),
    'oauth: PKCE through the system browser',
  );
  const srcAll = [
    'src/lib/xconnect.ts',
    'src/lib/xmirror.ts',
    'src/screens/XMirrorScreen.tsx',
    'src/screens/SettingsScreen.tsx',
  ]
    .map(read)
    .join('\n');
  ok(!srcAll.includes('client_secret'), 'no client_secret anywhere in the feature');
  ok(
    !/clientId:\s*'[0-9a-zA-Z]{10,}'/.test(srcAll) &&
      !/CLIENT_ID\s*=\s*'/.test(srcAll),
    'no hardcoded Client ID literal anywhere',
  );
  ok(xmSrc.includes("X_SCOPES = 'tweet.read users.read offline.access'"), 'scopes pinned read-only');

  const screen = read('src/screens/XMirrorScreen.tsx');
  ok(
    screen.includes('performMirrorPost') && screen.includes('ConfirmSheet'),
    'screen: engraving goes through the confirmation sheet',
  );
  ok(
    screen.includes('focusPostId') && screen.includes('findMirrorCandidate'),
    'screen: notification focus finds the post and opens its sheet',
  );
  ok(
    screen.includes("tr('xm.errRate')") && screen.includes("tr('xm.errAccess')") &&
      screen.includes("tr('xm.errAuth')"),
    'screen: API errors surface in plain words',
  );

  const appTsx = read('App.tsx');
  ok(
    appTsx.includes('addNotificationResponseReceivedListener') &&
      appTsx.includes('getLastNotificationResponseAsync'),
    'deeplink: warm + cold notification taps are both routed',
  );
  ok(
    appTsx.includes('setNotificationCategoryAsync') &&
      appTsx.includes("tr('xpush.action')"),
    'deeplink: the 刻む action category is registered',
  );
  ok(
    appTsx.includes('openMirror(data.xPostId)'),
    'deeplink: a tap opens the mirror on the payload post id',
  );

  const settings = read('src/screens/SettingsScreen.tsx');
  ok(
    settings.includes('connectX') && settings.includes("tr('xset.needDev')") &&
      settings.includes('X_REDIRECT_URI'),
    'settings: connect flow + developer-account guidance + callback shown',
  );
  ok(
    settings.includes('registerPush') && settings.includes("tr('xpush.note')"),
    'settings: push registration + the read-only note',
  );
  const cfg = read('src/config.ts');
  ok(
    cfg.includes("export const X_MIRROR_SERVER_URL = '';"),
    'config: the mirror server URL ships EMPTY (honest not-configured state)',
  );
  const ctx = read('src/context/AppContext.tsx');
  ok(
    ctx.includes('refreshMirrorCount') && ctx.includes('openMirror'),
    'context: detection on unlock + mirror navigation state',
  );

  const workerJs = read('worker/worker.js');
  ok(
    workerJs.includes("url.pathname === '/x/register'") &&
      workerJs.includes("url.pathname === '/x/unregister'"),
    'worker: register/unregister endpoints wired',
  );
  ok(
    workerJs.includes('async scheduled') && workerJs.includes('planPoll'),
    'worker: the cron poller is wired into scheduled()',
  );
  const toml = read('worker/wrangler.toml');
  ok(toml.includes('crons = ['), 'worker: a cron trigger is configured');
  try {
    execFileSync('npm', ['run', 'build'], {
      cwd: ROOT + '/worker',
      stdio: 'pipe',
    });
    const bundle = read('worker/dist/worker.js');
    ok(
      bundle.includes('/x/register') && bundle.includes('xseen:'),
      'worker: bundle builds with the mirror poller inside',
    );
  } catch (e) {
    ok(false, 'worker build: ' + (e.stdout || '').toString().slice(0, 200));
  }
}

console.log(`\nxmirror: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
