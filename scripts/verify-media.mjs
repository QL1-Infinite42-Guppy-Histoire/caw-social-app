/* Verification for the media-server client (v0.7.6).
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
 *      app.json carries the current release version;
 *   9. moderation (v0.7.6): buildAdminMessage is byte-identical
 *      to the server's admin format (the media format plus a
 *      `target:` line; list-hidden signs all placeholders);
 *      adminOp sends ONLY the fields the action uses and its
 *      sig verifies; listHiddenMedia parses both entry shapes
 *      and drops malformed ones; adminOpErrorKey maps the
 *      statuses the way the web viewer does; the hidden-post
 *      filter drops type 0/2 for non-admins only; the wiring
 *      pins cover the store, the context refresh triggers,
 *      every screen's moderation surface, and the profile
 *      rendering NO owner address;
 *  10. sanctions (v0.7.9): the freeze-user / ban-user signed
 *      messages are byte-exact (the duration rides the
 *      target line; ban signs a placeholder); adminOp sends
 *      only the fields each sanction action uses and its sig
 *      verifies; adminOpErrorKey maps the cannot-sanction
 *      refusal; fetchSanctions parses the public list and
 *      drops malformed rows; the sanction filter drops a
 *      sanctioned author's posts/recaws for non-admins only;
 *      isSanctionedError matches the server's 403 wording;
 *      and the wiring pins cover the store, the profile
 *      notice + controls, the Settings sanctions card, the
 *      card badge, and the upload sanction wording.
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

{
  // v0.7.10: a FAILED profile-media fetch is cached only for
  // the short MEDIA_NEGATIVE_CACHE_MS TTL — within the TTL a
  // repeat lookup does not refetch (no retry loop), but once
  // it lapses the next lookup refetches and a recovered
  // server's media shows within the same session. A success
  // is then session-cached as before. Date.now is faked past
  // the TTL so the test does not wait it out.
  check('mediaFor: the negative-cache TTL is a short 30 s',
    api.MEDIA_NEGATIVE_CACHE_MS === 30000);
  let serverDown = true;
  fakeFetch((url) => {
    if (url === api.MEDIA_API + '/v1/profile/20') {
      return serverDown
        ? jsonRes({}, false, 500)
        : jsonRes({ nameId: '20', icon: { url: 'https://x/media/back.jpg', size: 3 }, header: null, audio: null });
    }
    if (url === api.MEDIA_API + '/v1/profile/21') {
      if (serverDown) throw new Error('network down');
      return jsonRes({ nameId: '21', icon: { url: 'https://x/media/back21.jpg', size: 4 }, header: null, audio: null });
    }
    throw new Error('network down');
  });
  const realDateNow = Date.now;
  const baseNow = realDateNow();
  check('mediaFor: HTTP failure resolves null (negative entry)',
    (await api.mediaFor(20n)) === null);
  check('mediaFor: network failure resolves null (negative entry)',
    (await api.mediaFor(21n)) === null);
  check('mediaFor: within the TTL a failed lookup is NOT refetched',
    (await api.mediaFor(20n)) === null &&
      fetchCalls.filter((u) => u.includes('/v1/profile/20')).length === 1 &&
      fetchCalls.filter((u) => u.includes('/v1/profile/21')).length === 1);
  serverDown = false;
  check('mediaFor: within the TTL the negative entry still serves null after recovery',
    (await api.mediaFor(20n)) === null &&
      fetchCalls.filter((u) => u.includes('/v1/profile/20')).length === 1);
  Date.now = () => baseNow + api.MEDIA_NEGATIVE_CACHE_MS + 1000;
  try {
    const back = await api.mediaFor(20n);
    check('mediaFor: after the TTL the HTTP failure is refetched and recovers',
      !!back && back.icon && back.icon.url === 'https://x/media/back.jpg' &&
        fetchCalls.filter((u) => u.includes('/v1/profile/20')).length === 2);
    const back21 = await api.mediaFor(21n);
    check('mediaFor: after the TTL the network failure is refetched and recovers',
      !!back21 && back21.icon && back21.icon.url === 'https://x/media/back21.jpg' &&
        fetchCalls.filter((u) => u.includes('/v1/profile/21')).length === 2);
    const again = await api.mediaFor(20n);
    check('mediaFor: the recovered success is session-cached (no refetch)',
      again === back &&
        fetchCalls.filter((u) => u.includes('/v1/profile/20')).length === 2);
  } finally {
    Date.now = realDateNow;
  }
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
check('reads: mediaFor caches failures only for the negative TTL (v0.7.10)',
  mediaSrc.includes('MEDIA_NEGATIVE_CACHE_MS = 30000') &&
  mediaSrc.includes('entry.negativeUntil = Date.now() + MEDIA_NEGATIVE_CACHE_MS'));
const appJson = JSON.parse(readFileSync(ROOT + 'app.json', 'utf8'));
check('app.json: version 0.7.13 / versionCode 61',
  appJson.expo.version === '0.7.13' && appJson.expo.android.versionCode === 61);

/* ---- 9. moderation (v0.7.6) ---- */
const EMPTY = api.MEDIA_EMPTY_SHA256;
const HASH2 = 'cd'.repeat(32);
check('admin message: hide-post literal (empty hash signed, caw lowercased)',
  api.buildAdminMessage({ action: 'hide-post', cawId: '0x' + 'AB'.repeat(32), ts: 1700000000 }) ===
    'CAW Media v1\naction: hide-post\nname: -\nsha256: ' + EMPTY +
    '\ncaw: 0x' + 'ab'.repeat(32) + '\ntx: -\ntarget: -\nts: 1700000000');
check('admin message: hide-icon literal (name + pinned hash lowercased)',
  api.buildAdminMessage({ action: 'hide-icon', nameId: 190, sha256: HASH.toUpperCase(), ts: 5 }) ===
    'CAW Media v1\naction: hide-icon\nname: 190\nsha256: ' + HASH +
    '\ncaw: -\ntx: -\ntarget: -\nts: 5');
check('admin message: appoint-admin literal (target line filled, lowercased)',
  api.buildAdminMessage({ action: 'appoint-admin', target: '0x' + 'AB'.repeat(20), ts: 7 }) ===
    'CAW Media v1\naction: appoint-admin\nname: -\nsha256: ' + EMPTY +
    '\ncaw: -\ntx: -\ntarget: 0x' + 'ab'.repeat(20) + '\nts: 7');
check('admin message: list-hidden signs all placeholders',
  api.buildAdminMessage({ action: 'list-hidden', ts: 9 }) ===
    'CAW Media v1\naction: list-hidden\nname: -\nsha256: ' + EMPTY +
    '\ncaw: -\ntx: -\ntarget: -\nts: 9');
check('admin message: exactly 8 lines, no trailing newline',
  (() => {
    const m = api.buildAdminMessage({ action: 'hide-post', cawId: '0x' + 'ab'.repeat(32), ts: 1 });
    return !m.endsWith('\n') && m.split('\n').length === 8;
  })());
{
  const w = Wallet.createRandom();
  const msg = api.buildAdminMessage({ action: 'revoke-admin', target: w.address, ts: 1700000001 });
  const sig = await w.signMessage(msg);
  check('admin sign: personal_sign over the admin message recovers the signer',
    verifyMessage(msg, sig) === w.address);
}
check('adminOpErrorKey: the status mapping (403 splits on the server text)',
  api.adminOpErrorKey(403, 'not an admin') === 'notAdmin' &&
  api.adminOpErrorKey(403, 'root only') === 'rootOnly' &&
  api.adminOpErrorKey(409, 'media changed') === 'changed' &&
  api.adminOpErrorKey(404, '') === 'notFound' &&
  api.adminOpErrorKey(401, '') === 'sig' &&
  api.adminOpErrorKey(429, '') === 'throttle' &&
  api.adminOpErrorKey(400, '') === 'bad' &&
  api.adminOpErrorKey(500, '') === 'fail');
check('hashFromMediaUrl: the content hash out of a media URL; null elsewhere',
  api.hashFromMediaUrl(api.MEDIA_API + '/media/' + HASH + '.jpg') === HASH &&
  api.hashFromMediaUrl('https://x/media/nope.jpg') === null &&
  api.hashFromMediaUrl('') === null);

const opCalls = [];
fakeFetch((url, init) => {
  if (url === api.MEDIA_API + '/v1/admins') {
    return jsonRes({ admins: [
      { address: '0x' + 'AA'.repeat(20), role: 'root' },
      { address: '0x' + 'bb'.repeat(20), role: 'mod' },
      { address: '0xjunk', role: 'nope' },
    ] });
  }
  if (url === api.MEDIA_API + '/v1/hidden-posts') {
    return jsonRes({ posts: ['0x' + 'AB'.repeat(32)] });
  }
  if (url === api.MEDIA_API + '/v1/admin/op') {
    const body = JSON.parse(init.body);
    opCalls.push(body);
    if (body.action === 'list-hidden') {
      return jsonRes({ ok: true, action: 'list-hidden', hidden: [
        { kind: 'icon', nameId: '190', hash: HASH, hiddenBy: '0xroot', ts: 1700000000000 },
        { kind: 'attach', cawId: '0x' + 'AB'.repeat(32), hash: HASH2, hiddenBy: '0xroot', ts: 1700000000001 },
        { kind: 'bogus', hash: HASH },
      ] });
    }
    if (body.action === 'hide-icon') {
      return jsonRes({ error: 'media changed since read' }, false, 409);
    }
    return jsonRes({ ok: true, action: body.action });
  }
  throw new Error('network down');
});
{
  const admins = await api.fetchAdmins();
  check('fetchAdmins: roles kept, addresses lowercased, junk rows dropped',
    !!admins && admins.length === 2 &&
    admins[0].address === '0x' + 'aa'.repeat(20) && admins[0].role === 'root' &&
    admins[1].role === 'mod');
  const posts = await api.fetchHiddenPosts();
  check('fetchHiddenPosts: cawIds lowercased',
    !!posts && posts.length === 1 && posts[0] === '0x' + 'ab'.repeat(32));
  const w = Wallet.createRandom();
  const CAW = '0x' + 'ab'.repeat(32);
  const before = opCalls.length;
  await api.adminOp(w, { action: 'hide-post', cawId: CAW });
  const body = opCalls[before];
  check('adminOp: the body carries ONLY the fields the action uses (+ action/ts/sig)',
    !!body &&
    Object.keys(body).sort().join(',') === 'action,cawId,sig,ts' &&
    body.action === 'hide-post' && body.cawId === CAW);
  check('adminOp: the sent sig verifies over the canonical admin message',
    !!body &&
    verifyMessage(
      api.buildAdminMessage({ action: 'hide-post', cawId: CAW, ts: body.ts }),
      body.sig,
    ) === w.address);
  let err = null;
  try {
    await api.adminOp(w, { action: 'hide-icon', nameId: '190', sha256: HASH });
  } catch (e) {
    err = e;
  }
  check('adminOp: a 409 rejects with MediaApiError(status, server text)',
    err instanceof api.MediaApiError && err.status === 409 &&
    err.serverError === 'media changed since read');
  const hidden = await api.listHiddenMedia(w);
  check('listHiddenMedia: both entry shapes parsed, malformed dropped',
    hidden.length === 2 &&
    hidden[0].kind === 'icon' && hidden[0].nameId === '190' && hidden[0].hash === HASH &&
    hidden[1].kind === 'attach' && hidden[1].cawId === CAW && hidden[1].hash === HASH2);
  const lhBody = opCalls[opCalls.length - 1];
  check('listHiddenMedia: its op body is action/ts/sig only',
    !!lhBody && lhBody.action === 'list-hidden' &&
    Object.keys(lhBody).sort().join(',') === 'action,sig,ts');
}
fakeFetch(() => {
  throw new Error('network down');
});
check('admin reads: failures resolve null, never reject',
  (await api.fetchAdmins()) === null &&
  (await api.fetchHiddenPosts()) === null);
globalThis.fetch = realFetch;

{
  const HSET = new Set(['0x' + 'ab'.repeat(32)]);
  const rows = [
    { type: 0, cawId: '0x' + 'AB'.repeat(32) },
    { type: 2, cawId: '0x' + 'ab'.repeat(32) },
    { type: 1, cawId: '0x' + 'ab'.repeat(32) },
    { type: 0, cawId: '0x' + 'ff'.repeat(32) },
  ];
  const kept = api.filterModeratedItems(rows, HSET, false);
  check('filter: hidden posts + recaws drop for non-admins; likes and other posts stay',
    kept.length === 2 && kept[0].type === 1 && kept[1].type === 0);
  check('filter: admins keep everything (same array back)',
    api.filterModeratedItems(rows, HSET, true) === rows);
  check('filter: an empty hidden set is a no-op (same array back)',
    api.filterModeratedItems(rows, new Set(), false) === rows);
  check('postVisible: hidden shows only to admins',
    api.postVisible(true, false) === false &&
    api.postVisible(true, true) === true &&
    api.postVisible(false, false) === true);
}

const modLib = readFileSync(ROOT + 'src/lib/moderation.ts', 'utf8');
check('wiring: the moderation store sits on the admin client (moderation.ts)',
  modLib.includes('fetchAdmins') &&
  modLib.includes('fetchHiddenPosts') &&
  modLib.includes('listHiddenMedia') &&
  modLib.includes('useModeration'));
const ctxSrc = readFileSync(ROOT + 'src/context/AppContext.tsx', 'utf8');
check('wiring: AppContext refreshes moderation on wallet change + a 60 s tick',
  ctxSrc.includes('refreshModeration(address, secretRef.current)') &&
  ctxSrc.includes('60000'));
const tlSrc = readFileSync(ROOT + 'src/screens/TimelineScreen.tsx', 'utf8');
check('wiring: the timeline filters hidden posts and wires the card ops',
  tlSrc.includes('filterModeratedItems') &&
  tlSrc.includes('onModTogglePost') &&
  tlSrc.includes('confirmModAtt'));
const pdSrc = readFileSync(ROOT + 'src/screens/PostDetailScreen.tsx', 'utf8');
check('wiring: post detail shows the hidden state to non-admins, filters replies',
  pdSrc.includes('(postHidden || postSanction) && !mod.isAdmin') &&
  pdSrc.includes("tr('mod.hiddenNote')") &&
  pdSrc.includes('filterModeratedItems(replies'));
const bmSrc = readFileSync(ROOT + 'src/screens/BookmarksScreen.tsx', 'utf8');
check('wiring: bookmarks drop hidden posts for non-admins',
  bmSrc.includes('mod.isPostHidden(post.cawId)') &&
  bmSrc.includes('mod.sanctionFor(post.senderId)') &&
  bmSrc.includes('!mod.isAdmin'));
const stSrc = readFileSync(ROOT + 'src/screens/SettingsScreen.tsx', 'utf8');
check('wiring: Settings carries the moderation section (admins) + moderators card (root only)',
  stSrc.includes("tr('mod.sectionTitle')") && stSrc.includes('mod.isAdmin') &&
  stSrc.includes("tr('mod.adminsTitle')") && stSrc.includes('mod.isRoot') &&
  stSrc.includes("tr('mod.roleNote')"));
check('wiring: profile media moderation rows (ProfileScreen)',
  prof.includes("tr('mod.mediaTitle')") && prof.includes('setModMediaPending'));
check('wiring: PostCard carries the moderation props + hidden placeholders (ui.tsx)',
  ui.includes('modHiddenFor') && ui.includes('onModTogglePost') &&
  ui.includes('modHiddenAttFor') && ui.includes('mod.attHidden'));
check('profile address: ProfileScreen never renders the owner address (v0.7.6)',
  !prof.includes('{owner}') && !prof.includes('owner.slice') &&
  !prof.includes('shortAddr(owner)'));

/* ---- 10. sanctions (v0.7.9) ---- */
check('sanction message: freeze-user literal (duration on the target line)',
  api.buildAdminMessage({ action: 'freeze-user', nameId: '190', target: '24h', ts: 1700000002 }) ===
    'CAW Media v1\naction: freeze-user\nname: 190\nsha256: ' + EMPTY +
    '\ncaw: -\ntx: -\ntarget: 24h\nts: 1700000002');
check('sanction message: ban-user literal (target placeholder)',
  api.buildAdminMessage({ action: 'ban-user', nameId: 190, ts: 3 }) ===
    'CAW Media v1\naction: ban-user\nname: 190\nsha256: ' + EMPTY +
    '\ncaw: -\ntx: -\ntarget: -\nts: 3');
check('sanction message: unsanction-user literal (target placeholder)',
  api.buildAdminMessage({ action: 'unsanction-user', nameId: '7', ts: 4 }) ===
    'CAW Media v1\naction: unsanction-user\nname: 7\nsha256: ' + EMPTY +
    '\ncaw: -\ntx: -\ntarget: -\nts: 4');
check('adminOpErrorKey: 403 cannot-sanction maps to its own key',
  api.adminOpErrorKey(403, 'cannot sanction an admin') === 'cannotSanction' &&
  api.adminOpErrorKey(403, 'not an admin') === 'notAdmin');
check('isSanctionedError: only the 403 sanction wording matches',
  api.isSanctionedError(new api.MediaApiError(403, 'account sanctioned')) === true &&
  api.isSanctionedError(new api.MediaApiError(403, 'not an admin')) === false &&
  api.isSanctionedError(new Error('account sanctioned')) === false);

const sanctCalls = [];
fakeFetch((url, init) => {
  if (url === api.MEDIA_API + '/v1/sanctions') {
    return jsonRes({ sanctions: [
      { nameId: '190', kind: 'freeze', until: 1700086400000, ts: 1700000000000 },
      { nameId: 42, kind: 'ban', until: null, ts: 1700000000001 },
      { nameId: '7', kind: 'bogus', until: null, ts: 1 },
      { kind: 'freeze', until: null, ts: 2 },
    ] });
  }
  if (url === api.MEDIA_API + '/v1/admin/op') {
    const body = JSON.parse(init.body);
    sanctCalls.push(body);
    return jsonRes({ ok: true, action: body.action, nameId: body.nameId, kind: 'freeze', until: 1700086400000 });
  }
  throw new Error('network down');
});
{
  const list = await api.fetchSanctions();
  check('fetchSanctions: valid rows kept (nameId stringified), malformed dropped',
    !!list && list.length === 2 &&
    list[0].nameId === '190' && list[0].kind === 'freeze' && list[0].until === 1700086400000 &&
    list[1].nameId === '42' && list[1].kind === 'ban' && list[1].until === null);
  const w = Wallet.createRandom();
  await api.adminOp(w, { action: 'freeze-user', nameId: '190', target: '7d' });
  const fb = sanctCalls[sanctCalls.length - 1];
  check('adminOp freeze-user: body = action/nameId/target/ts/sig only',
    !!fb && Object.keys(fb).sort().join(',') === 'action,nameId,sig,target,ts' &&
    fb.target === '7d' && fb.nameId === '190');
  check('adminOp freeze-user: the sent sig verifies over the canonical message',
    !!fb &&
    verifyMessage(
      api.buildAdminMessage({ action: 'freeze-user', nameId: '190', target: '7d', ts: fb.ts }),
      fb.sig,
    ) === w.address);
  await api.adminOp(w, { action: 'ban-user', nameId: '190' });
  const bb = sanctCalls[sanctCalls.length - 1];
  check('adminOp ban-user: body carries NO target key',
    !!bb && Object.keys(bb).sort().join(',') === 'action,nameId,sig,ts');
  await api.adminOp(w, { action: 'unsanction-user', nameId: '190' });
  const ub = sanctCalls[sanctCalls.length - 1];
  check('adminOp unsanction-user: body carries NO target key',
    !!ub && Object.keys(ub).sort().join(',') === 'action,nameId,sig,ts');
}
fakeFetch(() => {
  throw new Error('network down');
});
check('fetchSanctions: failure resolves null, never rejects',
  (await api.fetchSanctions()) === null);
globalThis.fetch = realFetch;

{
  const SSET = new Set(['190']);
  const rows = [
    { type: 0, senderId: 190n },
    { type: 2, senderId: 190n },
    { type: 1, senderId: 190n },
    { type: 0, senderId: 7n },
  ];
  const kept = api.filterSanctionedItems(rows, SSET, false);
  check('sanction filter: a sanctioned author\'s posts + recaws drop for non-admins; likes and others stay',
    kept.length === 2 && kept[0].type === 1 && kept[1].senderId === 7n);
  check('sanction filter: admins keep everything (same array back)',
    api.filterSanctionedItems(rows, SSET, true) === rows);
  check('sanction filter: an empty set is a no-op (same array back)',
    api.filterSanctionedItems(rows, new Set(), false) === rows);
}

check('wiring: the moderation store carries sanctions (moderation.ts)',
  modLib.includes('fetchSanctions') &&
  modLib.includes('applyUnsanctionLocal') &&
  modLib.includes('sanctionFor'));
check('wiring: the timeline + post detail filter sanctioned authors',
  tlSrc.includes('filterSanctionedItems') &&
  pdSrc.includes('filterSanctionedItems'));
check('wiring: profile shows the sanction notice + admin controls (ProfileScreen)',
  prof.includes("tr('sanct.frozenNote')") &&
  prof.includes("tr('sanct.bannedNote')") &&
  prof.includes('setSanctPending') &&
  prof.includes("'freeze-user'"));
check('wiring: profile + composer surface the sanctioned-upload wording',
  prof.includes('isSanctionedError(e)') &&
  comp.includes('isSanctionedError(e)') &&
  comp.includes("tr('media.sanctioned')"));
check('wiring: Settings carries the sanctions list + apply form',
  stSrc.includes("tr('sanct.listTitle')") &&
  stSrc.includes("tr('sanct.applyTitle')") &&
  stSrc.includes('startSanction'));
check('wiring: PostCard carries the sanction badge + lift (ui.tsx)',
  ui.includes('SanctionBadge') && ui.includes('modSanctionFor') &&
  ui.includes('onModUnsanction'));

console.log(`\nmedia: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
