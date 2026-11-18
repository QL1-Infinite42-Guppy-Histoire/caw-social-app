/* Verification for the media-server client (v0.7.5).
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
 *      caches NON-EMPTY results per cawId, caps at 4 per post,
 *      and resolves empty (uncached) on failure AND on an
 *      empty success — an empty answer is never cached, so a
 *      lookup repeated after the upload lands finds the image
 *      (the v0.7.5 display fix); attachmentLookup coalesces
 *      simultaneous per-card lookups into that same one GET;
 *   7. buildMultipartBody's byte framing is exact, and the
 *      write path — with expo-file-system FAKED at the module
 *      loader, so the real read code runs — sends ONE
 *      hand-built multipart POST whose sig verifies over the
 *      message for the very bytes inside the body; a
 *      content:// URI is read through a cache copy;
 *   8. static wiring: the Avatar + PostCard (ui.tsx), the
 *      profile screen (display + edit + audio) and the
 *      composer (attach AFTER submitAction) all use the lib;
 *      mediaApi.ts has no legacy FS import and no FormData;
 *      the screens append mediaErrorDetail to the failure
 *      notes; the read timeouts are pinned at 15 s; and
 *      app.json carries 0.7.5 / versionCode 53.
 */
import { execFileSync } from 'node:child_process';
import Module, { createRequire } from 'node:module';
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
{
  // v0.7.5: an empty result is NEVER cached. The normal posting
  // flow mounts the new post's card before the composer's
  // upload finishes, so the first lookup legitimately answers
  // empty; v0.7.4 cached that [] for the whole session and the
  // uploaded image stayed invisible until an app restart.
  const CAW_F = '0x' + 'ff'.repeat(32);
  let serverHasIt = false;
  fakeFetch((url) => {
    if (url.startsWith(api.MEDIA_API + '/v1/posts?caw=')) {
      return jsonRes({
        media: serverHasIt
          ? { [CAW_F]: [{ url: 'https://x/media/late.jpg', size: 9 }] }
          : {},
      });
    }
    throw new Error('network down');
  });
  const first = await api.attachmentsFor([CAW_F]);
  check('attachmentsFor: a fresh post first resolves empty',
    Array.isArray(first.get(CAW_F)) && first.get(CAW_F).length === 0);
  const callsAfterFirst = fetchCalls.length;
  serverHasIt = true;
  const second = await api.attachmentsFor([CAW_F]);
  check('attachmentsFor: empty NOT cached — a later lookup refetches and finds the attachment',
    fetchCalls.length > callsAfterFirst &&
      second.get(CAW_F)?.length === 1 &&
      second.get(CAW_F)[0].url === 'https://x/media/late.jpg');
  const callsAfterSecond = fetchCalls.length;
  const third = await api.attachmentsFor([CAW_F]);
  check('attachmentsFor: a non-empty result IS cached (no refetch)',
    fetchCalls.length === callsAfterSecond && third.get(CAW_F)?.length === 1);
  const viaLookup = await api.attachmentLookup(CAW_F);
  check('attachmentLookup: the cached non-empty list is served without a fetch',
    viaLookup.length === 1 && fetchCalls.length === callsAfterSecond);
}
globalThis.fetch = realFetch;

/* ---- 7. multipart framing + the write path (FS faked) ---- */
{
  const B = '----CAWMediaBoundary7MA4YWxkTrZu0gW';
  check('MEDIA_MULTIPART_BOUNDARY is the fixed boundary',
    api.MEDIA_MULTIPART_BOUNDARY === B);
  const fileBytes = new Uint8Array([0xff, 0xd8, 0x00, 0x41]);
  const body = api.buildMultipartBody(
    [['nameId', '191'], ['kind', 'icon']],
    'file', 'icon.jpg', 'image/jpeg', fileBytes, B,
  );
  const head =
    '--' + B + '\r\nContent-Disposition: form-data; name="nameId"\r\n\r\n191\r\n' +
    '--' + B + '\r\nContent-Disposition: form-data; name="kind"\r\n\r\nicon\r\n' +
    '--' + B + '\r\nContent-Disposition: form-data; name="file"; filename="icon.jpg"\r\nContent-Type: image/jpeg\r\n\r\n';
  const expected = Buffer.concat([
    Buffer.from(head, 'latin1'),
    Buffer.from(fileBytes),
    Buffer.from('\r\n--' + B + '--\r\n', 'latin1'),
  ]);
  check('buildMultipartBody: exact byte framing (fields in order, file part, closing boundary)',
    Buffer.from(body).equals(expected));
}

/* Fake expo-file-system at the module loader so the REAL
 * readFileBytes / setProfileMedia / attachToPost run in Node:
 * File.bytes() returns fixed bytes; copy() is a no-op that
 * records its source. */
const FILE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
class FakeFile {
  constructor(...args) {
    this.uri = args
      .map((a) => (typeof a === 'string' ? a : (a && a.uri) || 'dir'))
      .join('/');
  }
  async copy(dest) {
    dest.copiedFrom = this.uri;
  }
  async bytes() {
    return FILE_BYTES;
  }
}
const fakeFS = {
  File: FakeFile,
  Paths: { cache: { uri: 'file:///cache' } },
  Directory: class {},
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'expo-file-system') return fakeFS;
  return origLoad.call(this, request, ...rest);
};
const writeCalls = [];
globalThis.fetch = async (url, init) => {
  writeCalls.push({ url: String(url), init });
  return jsonRes({ ok: true, url: 'https://x/media/stored.jpg', hash: 'h' });
};
{
  const direct = await api.readFileBytes('file:///plain.jpg');
  check('readFileBytes: a file:// URI reads through the File API',
    Buffer.from(direct).equals(Buffer.from(FILE_BYTES)));
  const viaCopy = await api.readFileBytes('content://media/external/audio.mp3');
  check('readFileBytes: a content:// URI is read through a cache copy',
    Buffer.from(viaCopy).equals(Buffer.from(FILE_BYTES)));

  const w = Wallet.createRandom();
  const out = await api.setProfileMedia('icon', 'file:///pic.jpg', 'image/jpeg', w, 191n);
  check('write: setProfileMedia resolves with the server entry',
    !!out && out.ok === true);
  check('write: exactly one POST to /v1/profile-media',
    writeCalls.length === 1 &&
      writeCalls[0].url === api.MEDIA_API + '/v1/profile-media' &&
      writeCalls[0].init.method === 'POST');
  const init = writeCalls[0].init;
  check('write: content-type carries the fixed boundary',
    init.headers['content-type'] ===
      'multipart/form-data; boundary=' + api.MEDIA_MULTIPART_BOUNDARY);
  const raw = Buffer.from(init.body);
  const text = raw.toString('latin1');
  check('write: body opens with the nameId field, fields in append order',
    text.startsWith(
      '--' + api.MEDIA_MULTIPART_BOUNDARY +
        '\r\nContent-Disposition: form-data; name="nameId"\r\n\r\n191\r\n') &&
      text.indexOf('name="kind"') < text.indexOf('name="ts"') &&
      text.indexOf('name="ts"') < text.indexOf('name="sig"') &&
      text.indexOf('name="sig"') < text.indexOf('name="file"'));
  check('write: the hashed file bytes sit verbatim before the closing boundary',
    raw.includes(Buffer.from(FILE_BYTES)) &&
      text.endsWith('\r\n--' + api.MEDIA_MULTIPART_BOUNDARY + '--\r\n'));
  const sig = /name="sig"\r\n\r\n(0x[0-9a-fA-F]+)/.exec(text)?.[1];
  const ts = /name="ts"\r\n\r\n(\d+)/.exec(text)?.[1];
  const msg = api.buildMediaMessage({
    action: 'set-icon', nameId: '191',
    sha256: api.sha256Hex(FILE_BYTES), ts,
  });
  check('write: the sig in the body verifies over the message for those bytes',
    !!sig && !!ts && verifyMessage(msg, sig) === w.address);
}
{
  writeCalls.length = 0;
  const w = Wallet.createRandom();
  const CAW = '0x' + 'ab'.repeat(32);
  const TX = '0x' + 'cd'.repeat(32);
  const out = await api.attachToPost(CAW, TX, 'file:///shot.png', w, 7n);
  const init = writeCalls[0] && writeCalls[0].init;
  const text = init ? Buffer.from(init.body).toString('latin1') : '';
  const sig = /name="sig"\r\n\r\n(0x[0-9a-fA-F]+)/.exec(text)?.[1];
  const ts = /name="ts"\r\n\r\n(\d+)/.exec(text)?.[1];
  const msg = api.buildMediaMessage({
    action: 'attach', nameId: '7',
    sha256: api.sha256Hex(FILE_BYTES), caw: CAW, tx: TX, ts,
  });
  check('write: attachToPost posts cawId + txHash and a verifying sig',
    writeCalls.length === 1 &&
      writeCalls[0].url === api.MEDIA_API + '/v1/attach' &&
      text.includes('name="cawId"\r\n\r\n' + CAW) &&
      text.includes('name="txHash"\r\n\r\n' + TX) &&
      !!sig && !!ts && verifyMessage(msg, sig) === w.address &&
      !!out && out.ok === true);
}
check('mediaErrorDetail: a MediaApiError message (status + server text) survives; long errors cap at 100',
  api.mediaErrorDetail(new api.MediaApiError(403, 'signer does not own this name')) ===
    'media 403: signer does not own this name' &&
    api.mediaErrorDetail(new Error('x'.repeat(300))).length === 100 &&
    api.mediaErrorDetail('plain') === 'plain');
Module._load = origLoad;
globalThis.fetch = realFetch;

/* ---- 8. static wiring ---- */
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
const mediaSrc = readFileSync(ROOT + 'src/lib/mediaApi.ts', 'utf8');
check('wiring: mediaApi reads via the current FS API, never the legacy one (v0.7.4)',
  mediaSrc.includes("await import('expo-file-system')") &&
  !mediaSrc.includes('expo-file-system/legacy') &&
  !mediaSrc.includes('readAsStringAsync'));
check('wiring: uploads are hand-built multipart bytes, never FormData file parts (v0.7.4)',
  mediaSrc.includes('buildMultipartBody') && !mediaSrc.includes('new FormData()'));
check('wiring: failure notes append the error detail (ProfileScreen + ComposeScreen)',
  prof.includes('mediaErrorDetail(e)') && comp.includes('mediaErrorDetail(e)'));
check('reads: mediaFor / attachmentsFor use the 15 s read timeout (v0.7.5)',
  mediaSrc.includes("'/v1/profile/' + key, undefined, 15000") &&
  /\/v1\/posts\?caw=' \+ chunk\.join\(','\),\s+undefined,\s+15000,?\s*\)/.test(mediaSrc));
check('reads: attachmentsFor caches only non-empty lists (v0.7.5)',
  mediaSrc.includes('if (okFetch && list.length > 0)'));
const appJson = JSON.parse(readFileSync(ROOT + 'app.json', 'utf8'));
check('app.json: version 0.7.5 / versionCode 53',
  appJson.expo.version === '0.7.5' && appJson.expo.android.versionCode === 53);

console.log(`\nmedia: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
