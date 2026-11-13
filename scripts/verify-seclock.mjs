#!/usr/bin/env node
/**
 * Security-lock verification (v0.5.0-fix) — audit items M3,
 * M4 and S1.
 *
 *  M3: the password verifier moved from single-round
 *      SHA-256 to scrypt (memory-hard; the implementation
 *      ethers already ships — no new dependency), with a
 *      version-marked record. Legacy records must still
 *      verify (flagged, so walletStore re-hashes them on
 *      that success — nobody gets locked out), and the
 *      unlock path is throttled: progressive, persisted
 *      delays after consecutive failures.
 *  M4: the auto-lock state machine — background starts a
 *      60 s clock; still backgrounded when it runs out →
 *      lock; foreground inside the grace cancels.
 *  S1: Android backup is off in the resolved Expo config
 *      and via the local config plugin.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = ROOT + '/scripts/.build-seclock';
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
      'src/lib/pwVerifier.ts',
      'src/lib/autoLock.ts',
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
  ok(true, 'tsc compiles the seclock graph');
} catch (e) {
  ok(false, 'tsc: ' + (e.stdout || '').toString().slice(0, 400));
  process.exit(1);
}
writeFileSync(OUT + '/package.json', '{"type":"commonjs"}');

const PW = await import(OUT + '/lib/pwVerifier.js');
const AL = await import(OUT + '/lib/autoLock.js');

/* ---------- M3: the KDF records ---------- */
{
  const salt = '00112233445566778899aabbccddeeff';
  const password = 'correct horse battery staple';
  // The legacy digest, computed INDEPENDENTLY (node:crypto).
  const legacyHash = createHash('sha256')
    .update(`${salt}:${password}`)
    .digest('hex');
  ok(
    PW.legacyPwHash(salt, password) === legacyHash,
    'M3: the legacy digest still reproduces exactly (SHA-256 of salt:password) — old installs keep verifying',
  );
  const legacyRecord = { salt, hash: legacyHash };
  const lv = await PW.checkPwRecord(legacyRecord, password);
  ok(
    lv.ok === true && lv.legacy === true,
    'M3: a legacy record verifies and is FLAGGED legacy (the migration trigger)',
  );
  ok(
    (await PW.checkPwRecord(legacyRecord, 'wrong')).ok === false,
    'M3: a legacy record still rejects a wrong password',
  );
  const v2 = await PW.makePwRecord(password, salt);
  ok(
    v2.v === 2 && v2.kdf === 'scrypt' && v2.N === 16384 && v2.r === 8 &&
      v2.p === 1 && v2.salt === salt && v2.hash.length === 64,
    'M3: new records are version-marked scrypt (N=16384, r=8, p=1, 32-byte digest)',
  );
  const vv = await PW.checkPwRecord(v2, password);
  ok(vv.ok === true && vv.legacy === false, 'M3: a v2 record verifies as current-format');
  ok(
    (await PW.checkPwRecord(v2, 'wrong')).ok === false &&
      (await PW.checkPwRecord({ ...v2, hash: '0'.repeat(64) }, password)).ok === false,
    'M3: a v2 record rejects wrong passwords and tampered digests',
  );
  // The migration composition walletStore performs: legacy
  // success → re-hash → the stored record is v2 and the
  // same password still verifies, now unflagged.
  const migrated = lv.ok && lv.legacy ? await PW.makePwRecord(password, salt) : null;
  const mv = migrated ? await PW.checkPwRecord(migrated, password) : { ok: false };
  ok(
    migrated !== null && migrated.v === 2 && mv.ok === true && mv.legacy === false,
    'M3: migration — a legacy-verified password re-hashes to v2 and keeps working (nobody locked out)',
  );
  ok(
    (await PW.checkPwRecord(null, password)).ok === false &&
      (await PW.checkPwRecord({}, password)).ok === false &&
      (await PW.checkPwRecord({ v: 2, kdf: 'scrypt' }, password)).ok === false &&
      (await PW.checkPwRecord({ salt: 5, hash: 'x' }, password)).ok === false,
    'M3: malformed records never verify',
  );
  ok(
    PW.PW_SCRYPT_N >= 16384,
    'M3: the scrypt cost is memory-hard grade (N ≥ 2^14), not a token round count',
  );
}

/* ---------- M3: the throttle ---------- */
{
  ok(
    PW.pwDelayMs(0) === 0 && PW.pwDelayMs(4) === 0 &&
      PW.pwDelayMs(5) === 5000 && PW.pwDelayMs(6) === 10000 &&
      PW.pwDelayMs(7) === 20000 && PW.pwDelayMs(8) === 40000 &&
      PW.pwDelayMs(9) === 60000 && PW.pwDelayMs(50) === 60000,
    'M3 throttle: free through 4 failures, then 5 s doubling to a 60 s cap',
  );
  const st = { fails: 5, lastFailAt: 1000 };
  ok(
    PW.pwWaitMs(st, 3000) === 3000 && PW.pwWaitMs(st, 6000) === 0 &&
      PW.pwWaitMs({ fails: 0, lastFailAt: 0 }, 999999) === 0,
    'M3 throttle: the wait counts down from the last failure and expires',
  );
  const f1 = PW.pwNoteFailure({ fails: 0, lastFailAt: 0 }, 500);
  ok(
    f1.fails === 1 && f1.lastFailAt === 500 &&
      PW.pwNoteSuccess().fails === 0,
    'M3 throttle: failures accumulate, a success resets the count',
  );
  const rt = PW.parsePwThrottle(JSON.stringify({ fails: 7, lastFailAt: 42 }));
  ok(
    rt.fails === 7 && rt.lastFailAt === 42 &&
      PW.parsePwThrottle('garbage').fails === 0 &&
      PW.parsePwThrottle(null).fails === 0,
    'M3 throttle: the persisted state round-trips; corrupt state degrades to zero, never to a lockout',
  );
}

/* ---------- M4: the auto-lock machine ---------- */
{
  ok(AL.AUTO_LOCK_MS === 60000, 'M4: the background grace is 60 seconds');
  const t0 = 1000000;
  ok(AL.autoLockDue(AL.autoLockInitial, t0 + 999999) === false, 'M4: foregrounded → never due');
  const bg = AL.autoLockOnBackground(AL.autoLockInitial, t0);
  ok(
    AL.autoLockDue(bg, t0 + 59999) === false &&
      AL.autoLockDue(bg, t0 + 60000) === true,
    'M4: backgrounded past the grace → lock is due (boundary inclusive)',
  );
  const back = AL.autoLockOnForeground(bg);
  ok(
    AL.autoLockDue(back, t0 + 999999) === false,
    'M4: returning inside the grace cancels the lock',
  );
}

/* ---------- wiring statics ---------- */
{
  const read = (p) => readFileSync(ROOT + '/' + p, 'utf8');
  const ws = read('src/lib/walletStore.ts');
  ok(
    ws.includes('makePwRecord') && ws.includes('checkPwRecord') &&
      ws.includes('ok && legacy'),
    'M3 wiring: walletStore writes scrypt records and migrates on a legacy success',
  );
  ok(
    !ws.includes('digestStringAsync'),
    'M3 wiring: the fast single-round digest is gone from the store',
  );
  ok(
    ws.includes('verifyPasswordThrottled') && ws.includes('PW_THROTTLE_KEY') &&
      ws.includes('pwWaitMs'),
    'M3 wiring: the throttled verify exists and persists its state in the secure store',
  );
  const ctx = read('src/context/AppContext.tsx');
  ok(
    ctx.includes('verifyPasswordThrottled') &&
      !/prompt\.resolve\(await verifyPassword\(/.test(ctx),
    'M3 wiring: the unlock prompt uses ONLY the throttled verify',
  );
  ok(
    ctx.includes("AppState.addEventListener('change'") &&
      ctx.includes('autoLockDue') && ctx.includes('AUTO_LOCK_MS') &&
      ctx.includes("next === 'background'"),
    'M4 wiring: AppContext starts the clock on background and locks via the state machine',
  );
  const reveal = read('src/screens/RevealSecretScreen.tsx');
  ok(
    reveal.includes('verifyPasswordThrottled'),
    'M3 wiring: the secret-reveal gate uses the throttled verify too',
  );
}

/* ---------- S1: backup off ---------- */
{
  const appJson = JSON.parse(readFileSync(ROOT + '/app.json', 'utf8'));
  ok(
    appJson.expo.android.allowBackup === false,
    'S1: expo.android.allowBackup is explicitly false in app.json',
  );
  ok(
    appJson.expo.plugins.includes('./plugins/withAllowBackupFalse.js'),
    'S1: the local manifest plugin is registered',
  );
  ok(appJson.expo.android.versionCode === 44, 'release: versionCode is 44');
  const plugin = readFileSync(ROOT + '/plugins/withAllowBackupFalse.js', 'utf8');
  ok(
    plugin.includes('withAndroidManifest') &&
      plugin.includes("app.$['android:allowBackup'] = 'false'"),
    'S1: the plugin pins android:allowBackup="false" in the generated manifest',
  );
  try {
    const out = execFileSync('npx', ['expo', 'config', '--json'], {
      cwd: ROOT,
      stdio: 'pipe',
    }).toString();
    const cfg = JSON.parse(out.slice(out.indexOf('{')));
    ok(
      cfg.android.allowBackup === false &&
        cfg.plugins.includes('./plugins/withAllowBackupFalse.js'),
      'S1: the RESOLVED Expo config carries allowBackup=false and the plugin (schema accepts both)',
    );
  } catch (e) {
    ok(false, 'S1: expo config failed: ' + String(e).slice(0, 200));
  }
}

console.log(`\nseclock: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
