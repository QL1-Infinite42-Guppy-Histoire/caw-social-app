/* Verification for the share payload (v0.6.7). Run:
 * node scripts/verify-share.mjs
 *
 * Purely local: postPageUrl / viewerTopUrl / shareTargetUrl /
 * resolveShareUrl from src/lib/share.ts, with the shortener
 * FAKED (no network, no chain, no keys). Pins:
 *   1. the link format is the web viewer's own post page:
 *      <viewer base>/en.html?post=<cawId> — the exact shape the
 *      viewer's postUrl() builds and its ?post= gate accepts
 *      (/^0x[0-9a-fA-F]{64}$/);
 *   2. page selection: the app's Japanese UI gets ja.html,
 *      every other language gets en.html (the viewer is EN/JA
 *      only) — and that choice is the URL handed to the
 *      shortener, so it survives shortening;
 *   3. the payload is EXACTLY ONE URL and nothing else — no
 *      post text, no author line (the link-only share);
 *   4. when the shortener answers, the payload is the short
 *      (cawl) URL; when it returns null or throws, the payload
 *      is the full viewer URL;
 *   5. the target is a pure function of the cawId PASSED IN —
 *      the PostCard passes the cawId of the post the button
 *      sits on, which in a Recaw row is the nested ORIGINAL
 *      post, so a share from a Recaw names the original;
 *   6. a missing or malformed cawId targets the viewer's TOP
 *      page for the current language (shortened when possible)
 *      — a post link is never fabricated.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname;
const BUILD = new URL('./.build-share', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

execFileSync(
  'npx',
  [
    'tsc', '--ignoreConfig',
    'src/lib/share.ts',
    '--outDir', BUILD, '--rootDir', 'src', '--module', 'commonjs',
    '--target', 'es2022', '--esModuleInterop', '--skipLibCheck',
  ],
  { stdio: 'inherit', cwd: ROOT },
);
const {
  VIEWER_BASE_URL,
  postPageUrl,
  viewerTopUrl,
  shareTargetUrl,
  resolveShareUrl,
} = require(BUILD + '/lib/share.js');

/* Real cawIds from the QL1 feed (decoded from CawActions
 * processAction calldata, the viewer's own data path). */
const POST_ID =
  '0xadebe720ecc1cdb76b229cb5537f885a0fc9bb77a29bbbc0b60195575c5c7dbe';
const OTHER_ID =
  '0xff8208746a61ffd982bec4c5ee4cf571e263988bd1dff80f68019f58d70de162';
const EN_URL = VIEWER_BASE_URL + '/en.html?post=' + POST_ID;
const JA_URL = VIEWER_BASE_URL + '/ja.html?post=' + POST_ID;
const EN_TOP = VIEWER_BASE_URL + '/en.html';
const JA_TOP = VIEWER_BASE_URL + '/ja.html';
const SHORT = 'https://c.qql1.com/AbC123'; // issuing base since 2026-11-18 (was cawl.nepicobsv.workers.dev)

/* Fake shorteners: one that records what it was asked to
 * shorten and answers a fixed short URL, one that fails soft
 * (null), one that throws. */
const recordingShorten = (answer) => {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return answer;
  };
  fn.calls = calls;
  return fn;
};
const nullShorten = async () => null;
const throwingShorten = async () => {
  throw new Error('offline');
};

const isSingleUrl = (s) =>
  typeof s === 'string' && /^https:\/\/\S+$/.test(s) && !s.includes('\n');

/* ---------- 1. link format ---------- */
check('link: en page URL matches the viewer postUrl shape',
  postPageUrl(POST_ID, 'en') === EN_URL, EN_URL);
check('link: base is the live community viewer',
  VIEWER_BASE_URL ===
    'https://ql1-infinite42-guppy-histoire.github.io/caw-social-ql1');
check('link: mixed-case cawId accepted (viewer gate allows A-F) and passed through as-is',
  postPageUrl('0x' + POST_ID.slice(2).toUpperCase(), 'en') ===
    VIEWER_BASE_URL + '/en.html?post=0x' + POST_ID.slice(2).toUpperCase());

/* ---------- 2. page selection ---------- */
check('page: ja UI → ja.html', postPageUrl(POST_ID, 'ja') === JA_URL);
check('page: any other language → en.html',
  postPageUrl(POST_ID, 'fr') === EN_URL &&
    postPageUrl(POST_ID, 'zh') === EN_URL &&
    postPageUrl(POST_ID, '') === EN_URL);
check('page: top page follows the same selection',
  viewerTopUrl('ja') === JA_TOP && viewerTopUrl('en') === EN_TOP);

/* ---------- target selection ---------- */
check('target: valid cawId → the post page',
  shareTargetUrl(POST_ID, 'en') === EN_URL &&
    shareTargetUrl(POST_ID, 'ja') === JA_URL);
for (const bad of [null, undefined, '', '0x1234', POST_ID.slice(2), '0x' + 'z'.repeat(64)]) {
  check('target: cawId ' + JSON.stringify(bad) + ' → viewer top page, no fabricated post link',
    postPageUrl(bad, 'en') === null &&
      shareTargetUrl(bad, 'en') === EN_TOP &&
      shareTargetUrl(bad, 'ja') === JA_TOP);
}

/* ---------- 3+4. resolution: short when possible, full on failure ---------- */
{
  const fake = recordingShorten(SHORT);
  const payload = await resolveShareUrl(POST_ID, 'en', fake);
  check('payload: shortener answer is the payload, exactly one URL',
    payload === SHORT && isSingleUrl(payload), payload);
  check('payload: the shortener was asked for the FULL viewer URL',
    fake.calls.length === 1 && fake.calls[0] === EN_URL);
}
{
  const fake = recordingShorten(SHORT);
  const payload = await resolveShareUrl(POST_ID, 'ja', fake);
  check('payload: ja choice flows into the shortened target',
    payload === SHORT && fake.calls[0] === JA_URL);
}
check('payload: shortener null → the full viewer URL',
  (await resolveShareUrl(POST_ID, 'en', nullShorten)) === EN_URL);
check('payload: shortener throws → the full viewer URL',
  (await resolveShareUrl(POST_ID, 'en', throwingShorten)) === EN_URL);
check('payload: fallback payload is still exactly one URL',
  isSingleUrl(await resolveShareUrl(POST_ID, 'ja', nullShorten)));

/* ---------- 5. the passed cawId decides (Recaw → original) ---------- */
{
  const fake = recordingShorten(SHORT);
  await resolveShareUrl(POST_ID, 'en', fake);
  check('recaw: resolving with the ORIGINAL post cawId shortens the original\u2019s link',
    fake.calls[0] === EN_URL && !fake.calls[0].includes(OTHER_ID));
}

/* ---------- 6. missing cawId → top page link ---------- */
{
  const fake = recordingShorten(SHORT);
  const payload = await resolveShareUrl(null, 'en', fake);
  check('top: missing cawId shortens the viewer top page',
    payload === SHORT && fake.calls[0] === EN_TOP);
}
check('top: missing cawId + shortener failure → the full top page URL',
  (await resolveShareUrl(undefined, 'ja', nullShorten)) === JA_TOP);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
