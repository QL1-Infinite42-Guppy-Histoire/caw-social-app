/* Verification for the share message (v0.6.6). Run:
 * node scripts/verify-share.mjs
 *
 * Purely local: postPageUrl / composeShareMessage from
 * src/lib/share.ts — no network, no chain, no keys. Pins:
 *   1. the link format is the web viewer's own post page:
 *      <viewer base>/en.html?post=<cawId> — the exact shape the
 *      viewer's postUrl() builds and its ?post= gate accepts
 *      (/^0x[0-9a-fA-F]{64}$/);
 *   2. page selection: the app's Japanese UI gets ja.html,
 *      every other language gets en.html (the viewer is EN/JA
 *      only);
 *   3. the composed message is the v0.6.4 text (body + "— @handle
 *      · CAW Social") with the link appended on its own line;
 *   4. the link is a pure function of the cawId PASSED IN — the
 *      PostCard passes the cawId of the post the button sits on,
 *      which in a Recaw row is the nested ORIGINAL post, so a
 *      share from a Recaw names the original, never the Recaw;
 *   5. a missing or malformed cawId falls back to the exact
 *      v0.6.4 text-only message — no link is fabricated;
 *   6. an empty body still yields the author line + link.
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
const { VIEWER_BASE_URL, postPageUrl, composeShareMessage } =
  require(BUILD + '/lib/share.js');

/* Real cawIds from the QL1 feed (decoded from CawActions
 * processAction calldata, the viewer's own data path). */
const POST_ID =
  '0xadebe720ecc1cdb76b229cb5537f885a0fc9bb77a29bbbc0b60195575c5c7dbe';
const OTHER_ID =
  '0xff8208746a61ffd982bec4c5ee4cf571e263988bd1dff80f68019f58d70de162';
const EN_URL = VIEWER_BASE_URL + '/en.html?post=' + POST_ID;
const JA_URL = VIEWER_BASE_URL + '/ja.html?post=' + POST_ID;

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

/* ---------- 3. composition ---------- */
check('message: body + author line + link line',
  composeShareMessage('hello caw', '@alice', POST_ID, 'en') ===
    'hello caw\n— @alice · CAW Social\n' + EN_URL);
check('message: ja UI links the ja page',
  composeShareMessage('hello caw', '@alice', POST_ID, 'ja') ===
    'hello caw\n— @alice · CAW Social\n' + JA_URL);

/* ---------- 4. the passed cawId decides (Recaw → original) ---------- */
check('recaw: composing with the ORIGINAL post cawId links the original',
  composeShareMessage('orig words', '@bob', POST_ID, 'en').endsWith(EN_URL) &&
    !composeShareMessage('orig words', '@bob', POST_ID, 'en').includes(OTHER_ID));

/* ---------- 5. fallback: no fabricated link ---------- */
for (const bad of [null, undefined, '', '0x1234', POST_ID.slice(2), '0x' + 'z'.repeat(64)]) {
  check('fallback: cawId ' + JSON.stringify(bad) + ' → text-only v0.6.4 message',
    composeShareMessage('hello caw', '@alice', bad, 'en') ===
      'hello caw\n— @alice · CAW Social' &&
      postPageUrl(bad, 'en') === null);
}

/* ---------- 6. empty body ---------- */
check('message: empty body → author line + link',
  composeShareMessage('', '@alice', POST_ID, 'en') ===
    '— @alice · CAW Social\n' + EN_URL);
check('message: empty body + no cawId → author line only',
  composeShareMessage('', '@alice', null, 'en') === '— @alice · CAW Social');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
