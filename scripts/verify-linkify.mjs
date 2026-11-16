/* Verification for linkify (v0.6.5). Run: node scripts/verify-linkify.mjs
 *
 * Purely local: extractUrls / splitLinkSegments / shortenUrlsInText /
 * fetchPreview from src/lib/linkify.ts, exercised with a MOCKED fetch
 * (no network, no chain, no keys). Pins:
 *   1. extraction: URL at start / middle / end of a text; several
 *      URLs in one text; order preserved;
 *   2. trailing punctuation is not part of the URL (sentence period,
 *      comma, Japanese 。), while a BALANCED closing paren stays
 *      (Wikipedia-style URLs) and an unbalanced one is trimmed;
 *   3. a URL pasted directly against Japanese text is found cleanly
 *      (the ASCII charset stops the candidate at the Japanese char);
 *   4. shortening replaces every occurrence of a long URL with the
 *      short form, dedupes repeat URLs into one request, and leaves
 *      short URLs (not longer than the short form) untouched without
 *      any request at all;
 *   5. shortening failure (offline / Worker 500) leaves the text
 *      byte-for-byte untouched — posting is never blocked;
 *   6. the compose contract: shortening runs on the BODY only, the
 *      [caw:reply:…] marker appended afterwards still parses back to
 *      exactly the shortened body + the parent ref (lib/postRef.ts);
 *   7. fetchPreview maps the Worker's JSON through, and returns null
 *      (no card) on an error status.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname;
const BUILD = new URL('./.build-linkify', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

execFileSync(
  'npx',
  [
    'tsc', '--ignoreConfig',
    'src/config.ts', 'src/lib/linkify.ts', 'src/lib/postRef.ts',
    '--outDir', BUILD, '--module', 'commonjs', '--target', 'es2022',
    '--esModuleInterop', '--skipLibCheck',
  ],
  { stdio: 'inherit', cwd: ROOT },
);
const { extractUrls, splitLinkSegments, shortenUrlsInText, fetchPreview } =
  require(BUILD + '/lib/linkify.js');
const { appendPostRef, parsePostText } = require(BUILD + '/lib/postRef.js');
const { LINK_SERVICE_URL } = require(BUILD + '/config.js');

const LONG1 =
  'https://en.wikipedia.org/wiki/Interstellar_travel?so=search&useskin=vector';
const LONG2 =
  'https://example.com/articles/2026/11/a-very-long-slug indeed'.replace(' ', '%20') +
  '?utm_source=feed&utm_medium=social';
const SHORT_FORM = LINK_SERVICE_URL + '/XyZ123';

/* ---------- mocked fetch ---------- */
let shortenCalls = [];
const mockOk = async (input, init) => {
  const url = String(input);
  if (url.endsWith('/api/shorten')) {
    const body = JSON.parse(init.body);
    shortenCalls.push(body.url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 'XyZ123', short: SHORT_FORM }),
    };
  }
  if (url.includes('/api/preview')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        url: 'https://en.wikipedia.org/wiki/Interstellar_travel',
        title: 'Interstellar travel - Wikipedia',
        description: '',
        image: 'https://example.com/og.jpg',
        domain: 'en.wikipedia.org',
      }),
    };
  }
  throw new Error('unexpected fetch ' + url);
};
const mockFail = async () => {
  throw new Error('offline');
};
const mock500 = async () => ({
  ok: false,
  status: 500,
  json: async () => ({ error: 'boom' }),
});

/* ---------- 1–3. extraction ---------- */
check('extract: URL at start', JSON.stringify(extractUrls(LONG1 + ' is great')) === JSON.stringify([LONG1]));
check('extract: URL at end', JSON.stringify(extractUrls('see this ' + LONG1)) === JSON.stringify([LONG1]));
check('extract: URL in middle', JSON.stringify(extractUrls('a ' + LONG1 + ' b')) === JSON.stringify([LONG1]));
check('extract: two URLs keep order',
  JSON.stringify(extractUrls(LONG1 + ' and ' + LONG2)) === JSON.stringify([LONG1, LONG2]));
check('extract: no URL', extractUrls('ただの文章です').length === 0);
check('extract: trailing period trimmed',
  JSON.stringify(extractUrls('Read ' + LONG1 + '.')) === JSON.stringify([LONG1]));
check('extract: trailing comma trimmed',
  JSON.stringify(extractUrls('a ' + LONG1 + ', b')) === JSON.stringify([LONG1]));
check('extract: balanced parens kept',
  JSON.stringify(extractUrls('wiki https://en.wikipedia.org/wiki/Caw_(bird) end')) ===
    JSON.stringify(['https://en.wikipedia.org/wiki/Caw_(bird)']));
check('extract: unbalanced closing paren trimmed',
  JSON.stringify(extractUrls('(see https://example.com/abcdef)')) ===
    JSON.stringify(['https://example.com/abcdef']));
check('extract: URL against Japanese text (before)',
  JSON.stringify(extractUrls('これ見て ' + LONG1 + ' すごい')) === JSON.stringify([LONG1]));
check('extract: URL directly against Japanese char',
  JSON.stringify(extractUrls(LONG1 + 'を見てね')) === JSON.stringify([LONG1]));
check('extract: Japanese full stop trimmed',
  JSON.stringify(extractUrls('リンクは' + LONG1 + '。')) === JSON.stringify([LONG1]));
const segs = splitLinkSegments('x ' + LONG1 + ' y');
check('segments: plain/url/plain',
  segs.length === 3 && segs[0].text === 'x ' && segs[1].url === LONG1 && segs[2].text === ' y');

/* ---------- 4–5. shortening ---------- */
shortenCalls = [];
const body1 = 'これ見て ' + LONG1 + ' すごい';
const out1 = await shortenUrlsInText(body1, mockOk);
check('shorten: long URL replaced', out1 === 'これ見て ' + SHORT_FORM + ' すごい', out1);
check('shorten: one request for one URL', shortenCalls.length === 1 && shortenCalls[0] === LONG1);

shortenCalls = [];
const out2 = await shortenUrlsInText(LONG1 + ' / ' + LONG1, mockOk);
check('shorten: repeated URL replaced everywhere, one request',
  out2 === SHORT_FORM + ' / ' + SHORT_FORM && shortenCalls.length === 1);

shortenCalls = [];
const shortBody = 'site: https://qom.network now';
const out3 = await shortenUrlsInText(shortBody, mockOk);
check('shorten: already-short URL untouched, no request',
  out3 === shortBody && shortenCalls.length === 0);

const out4 = await shortenUrlsInText(body1, mockFail);
check('shorten: offline leaves text untouched', out4 === body1);
const out5 = await shortenUrlsInText(body1, mock500);
check('shorten: worker 500 leaves text untouched', out5 === body1);
const out6 = await shortenUrlsInText('URLなしの文章', mockOk);
check('shorten: no URL → unchanged', out6 === 'URLなしの文章');

/* ---------- 6. compose contract: body only, marker intact ---------- */
const parentCawId = '0x' + 'ab'.repeat(32);
const finalText = appendPostRef(out1, { kind: 'reply', parentCawId });
const parsedBack = parsePostText(finalText);
check('marker: shortened body round-trips through parsePostText',
  parsedBack.body === out1 &&
    parsedBack.ref !== null &&
    parsedBack.ref.kind === 'reply' &&
    parsedBack.ref.parentCawId === parentCawId);

/* ---------- 7. preview ---------- */
const pv = await fetchPreview(LONG1, mockOk);
check('preview: fields mapped',
  pv !== null &&
    pv.title === 'Interstellar travel - Wikipedia' &&
    pv.domain === 'en.wikipedia.org' &&
    pv.url === 'https://en.wikipedia.org/wiki/Interstellar_travel');
const pvFail = await fetchPreview('https://example.com/no-preview-here-xyz', mock500);
check('preview: error status → null (no card)', pvFail === null);
const pvOff = await fetchPreview('https://example.com/offline-xyz', mockFail);
check('preview: offline → null (no card)', pvOff === null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
