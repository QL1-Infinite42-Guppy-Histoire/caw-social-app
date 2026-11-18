/* Verification for the media-server client (v0.7.3).
 * Run: node scripts/verify-media.mjs
 *
 * Purely local: src/lib/mediaApi.ts compiled and exercised in
 * Node with fetch FAKED (no network, no chain, no real keys —
 * the signing check uses a throwaway wallet). Pins:
 *   1. buildMediaMessage is byte-identical to the shared
 *      "CAW Media v1" format the server rebuilds and the web
 *      viewer signs (literals below are the contract — they
 *      match server/src/main.js buildMessage and viewer.js
 *      buildMediaMessage field for field);
 *   2. an ethers personal_sign over that message verifies back
 *      to the signer (the exact check the server performs);
 *   3. sha256Hex matches the known SHA-256 test vectors, and
 *      MEDIA_EMPTY_SHA256 is the empty-string digest the
 *      clear-* actions sign;
 *   4. MEDIA_API / MEDIA_CAPS mirror the live server;
 *   5. mediaFor caches per name, returns the profile when any
 *      field is set, and resolves null (never rejects) on an
 *      empty profile, an HTTP error and a network failure;
 *   6. attachmentsFor fetches every uncached id in ONE GET,
 *      caches per cawId, caps at 4 per post, and resolves
 *      empty (uncached) on failure; attachmentLookup coalesces
 *      simultaneous per-card lookups into that same one GET;
 *   7. static wiring: the Avatar + PostCard (ui.tsx), the
 *      profile screen (display + edit + audio) and the
 *      composer (attach AFTER submitAction) all use the lib,
 *      and app.json carries 0.7.3 / versionCode 51.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname;
const BUILD = new URL('./.build-media', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

execFileSync(
  'npx',
  [
    'tsc', '--ignoreConfig',
    'src/lib/mediaApi.ts',
    '--outDir', BUILD, '--rootDir', 'src', '--module', 'commonjs',
    '--target', 'es2022', '--esModuleInterop', '--skipLibCheck',
  ],
  { stdio: 'inherit', cwd: ROOT },
);

const api = require(BUILD + '/lib/mediaApi.js');
const { Wallet, verifyMessage } = require('ethers');

/* ---- 1. the signed message, byte for byte ---- */
const HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
check(
  'message: set-icon literal',
  api.buildMediaMessage({ action: 'set-icon', nameId: '191', sha256: HASH, ts: 1700000000 }) ===
    'CAW Media v1\naction: set-icon\nname: 191\nsha256: ' + HASH + '\ncaw: -\ntx: -\nts: 1700000000',
);
check(
  'message: attach literal (caw + tx filled)',
  api.buildMediaMessage({
    action: 'attach', nameId: '7', sha256: HASH,
    caw: '0x' + 'ab'.repeat(32), tx: '0x' + 'cd'.repeat(32), ts: 1700000123,
  }) ===
    'CAW Media v1\naction: attach\nname: 7\nsha256: ' + HASH +
    '\ncaw: 0x' + 'ab'.repeat(32) + '\ntx: 0x' + 'cd'.repeat(32) + '\nts: 1700000123',
);
check(
  'message: clear-audio signs the empty hash, dashes elsewhere',
  api.buildMediaMessage({
    action: 'clear-audio', nameId: '42', sha256: api.MEDIA_EMPTY_SHA256, ts: 1,
  }) ===
    'CAW Media v1\naction: clear-audio\nname: 42\nsha256: ' +
    api.MEDIA_EMPTY_SHA256 + '\ncaw: -\ntx: -\nts: 1',
);
check(
  'message: no trailing newline, exactly 7 lines',
  (() => {
    const m = api.buildMediaMessage({ action: 'set-header', nameId: '1', sha256: HASH, ts: 9 });
    return !m.endsWith('\n') && m.split('\n').length === 7;
  })(),
);

/* ---- 2. the signature verifies the way the server checks it ---- */
{
  const w = Wallet.createRandom();
  const msg = api.buildMediaMessage({ action: 'set-icon', nameId: '191', sha256: HASH, ts: 1700000000 });
  const sig = await w.signMessage(msg);
  check('sign: personal_sign over the message recovers the signer',
    verifyMessage(msg, sig) === w.address);
  check('sign: signature shape is 0x + 130 hex',
    /^0x[0-9a-fA-F]{130}$/.test(sig));
}

/* ---- 3. hashing ---- */
check('sha256Hex("abc") is the known vector',
  api.sha256Hex(new TextEncoder().encode('abc')) === HASH);
check('sha256Hex("") equals MEDIA_EMPTY_SHA256',
  api.sha256Hex(new Uint8Array(0)) === api.MEDIA_EMPTY_SHA256);
check('MEDIA_EMPTY_SHA256 is the published empty digest',
  api.MEDIA_EMPTY_SHA256 ===
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

/* ---- 4. server constants ---- */
check('MEDIA_API is the live media base',
  api.MEDIA_API === 'https://vps-2026-11-12-16-49-27.tail303bfa.ts.net:10000');
check('MEDIA_CAPS mirror the server caps (icon 2 / header 4 / audio 10 / attach 8 MB)',
  api.MEDIA_CAPS.icon === 2 * 1024 * 1024 &&
  api.MEDIA_CAPS.header === 4 * 1024 * 1024 &&
  api.MEDIA_CAPS.audio === 10 * 1024 * 1024 &&
  api.MEDIA_CAPS.attach === 8 * 1024 * 1024 &&
  api.MEDIA_ATTACH_PER_POST === 4);

/* ---- 5/6. reads against a faked fetch ---- */
const realFetch = globalThis.fetch;
let fetchCalls = [];
function fakeFetch(handler) {
  fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push(String(url));
    return handler(String(url), init);
  };
}
const jsonRes = (obj, ok = true, status = 200) => ({
  ok, status, json: async () => obj,
});

fakeFetch((url) => {
  if (url === api.MEDIA_API + '/v1/profile/5') {
    return jsonRes({ nameId: '5', icon: { url: 'https://x/media/i.jpg', size: 10 }, header: null, audio: null });
  }
  if (url === api.MEDIA_API + '/v1/profile/6') {
    return jsonRes({ nameId: '6', icon: null, header: null, audio: null });
  }
  if (url === api.MEDIA_API + '/v1/profile/7') return jsonRes({}, false, 500);
  throw new Error('network down');
});
{
  const a = await api.mediaFor(5n);
  const b = await api.mediaFor('5');
  check('mediaFor: returns the profile when a field is set',
    !!a && a.icon && a.icon.url === 'https://x/media/i.jpg');
  check('mediaFor: cached — two calls, one fetch, same object',
    a === b && fetchCalls.filter((u) => u.includes('/v1/profile/5')).length === 1);
  check('mediaFor: all-null profile resolves null',
    (await api.mediaFor(6n)) === null);
  check('mediaFor: HTTP 500 resolves null, never rejects',
    (await api.mediaFor(7n)) === null);
  check('mediaFor: network failure resolves null, never rejects',
    (await api.mediaFor(8n)) === null);
  api.invalidateMedia(5n);
  await api.mediaFor(5n);
  check('invalidateMedia: the next call refetches',
    fetchCalls.filter((u) => u.includes('/v1/profile/5')).length === 2);
}

const CAW_A = '0x' + 'aa'.repeat(32);
const CAW_B = '0x' + 'bb'.repeat(32);
const CAW_C = '0x' + 'cc'.repeat(32);
fakeFetch((url) => {
  if (url.startsWith(api.MEDIA_API + '/v1/posts?caw=')) {
    return jsonRes({
      media: {
        [CAW_A]: [{ url: 'https://x/media/1.jpg', size: 1 }],
        [CAW_B]: [1, 2, 3, 4, 5].map((i) => ({ url: 'https://x/media/' + i + '.jpg', size: i })),
      },
    });
  }
  throw new Error('network down');
});
{
  const map = await api.attachmentsFor([CAW_A, CAW_B, CAW_C]);
  check('attachmentsFor: one GET for the whole batch',
    fetchCalls.length === 1 && fetchCalls[0].includes('/v1/posts?caw='));
  check('attachmentsFor: known ids resolve their lists',
    map.get(CAW_A)?.length === 1 && map.get(CAW_B)?.length === 4);
  check('attachmentsFor: capped at 4 per post', map.get(CAW_B)?.length === 4);
  check('attachmentsFor: unknown id resolves an empty list',
    Array.isArray(map.get(CAW_C)) && map.get(CAW_C).length === 0);
  const before = fetchCalls.length;
  const again = await api.attachmentsFor([CAW_A]);
  check('attachmentsFor: cached ids are not refetched',
    fetchCalls.length === before && again.get(CAW_A)?.length === 1);
}
{
  // Coalescing: three per-card lookups in the same tick, one GET.
  const CAW_D = '0x' + 'dd'.repeat(32);
  const CAW_E = '0x' + 'ee'.repeat(32);
  const before = fetchCalls.length;
  const [d, e, d2] = await Promise.all([
    api.attachmentLookup(CAW_D), api.attachmentLookup(CAW_E), api.attachmentLookup(CAW_D),
  ]);
  check('attachmentLookup: simultaneous lookups share one GET',
    fetchCalls.length === before + 1);
  check('attachmentLookup: every waiter resolves (empty here)',
    Array.isArray(d) && Array.isArray(e) && Array.isArray(d2));
}
globalThis.fetch = realFetch;

/* ---- 7. static wiring ---- */
const ui = readFileSync(ROOT + 'src/components/ui.tsx', 'utf8');
check('wiring: Avatar feeds the server icon through mediaFor (ui.tsx)',
  ui.includes('mediaFor(nameId)') && ui.includes('serverIcon'));
check('wiring: PostCard renders attachments under the text (ui.tsx)',
  ui.includes('attachmentLookup(item.cawId)') && ui.includes('PostMediaGrid'));
const prof = readFileSync(ROOT + 'src/screens/ProfileScreen.tsx', 'utf8');
check('wiring: profile shows the server header before the local one',
  prof.indexOf('serverMedia?.header') > -1 &&
  prof.indexOf('serverMedia?.header') <
    prof.indexOf('source={{ uri: custom.headerPath }}'));
check('wiring: profile publishes picks + clears on reset (ProfileScreen)',
  prof.includes("kind === 'avatar' ? 'icon' : 'header'") &&
  prof.includes("clearProfileMedia('icon'") &&
  prof.includes("clearProfileMedia('header'"));
check('wiring: profile audio pick / remove / playback (ProfileScreen)',
  prof.includes("setProfileMedia(\n        'audio'") &&
  prof.includes("clearProfileMedia(\n        'audio'") &&
  prof.includes('useAudioPlayer') &&
  prof.includes('getDocumentAsync'));
const comp = readFileSync(ROOT + 'src/screens/ComposeScreen.tsx', 'utf8');
check('wiring: composer attaches AFTER the post submits (ComposeScreen)',
  comp.includes('attachToPost') &&
  comp.indexOf('await submitAction(') > -1 &&
  comp.indexOf('await submitAction(') < comp.indexOf('await attachToPost('));
check('wiring: composer picker caps at MEDIA_ATTACH_PER_POST',
  comp.includes('MEDIA_ATTACH_PER_POST'));
const appJson = JSON.parse(readFileSync(ROOT + 'app.json', 'utf8'));
check('app.json: version 0.7.3 / versionCode 51',
  appJson.expo.version === '0.7.3' && appJson.expo.android.versionCode === 51);

console.log(`\nmedia: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
