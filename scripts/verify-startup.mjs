#!/usr/bin/env node
/**
 * Startup performance verification (v0.5.1) — the F1/F2/F4/F5
 * fixes from the 2026-11-11 startup investigation
 * (docs/audit/STARTUP_PERF_2026-11-11.md):
 *
 *  F1  busy feedback on unlock — statics pin the busy state in
 *      BOTH unlock paths (UnlockScreen.attempt and the
 *      PasswordPrompt/answerPwPrompt flow), and pin that the
 *      prompt stays mounted (busy) while verification runs.
 *  F2  walletBalances in-flight dedupe — behavioral, with a
 *      stubbed fetch: two concurrent calls cost ONE 8-RPC set,
 *      a post-settle call fetches fresh (in-flight only, not a
 *      result cache), and one token's failed read stays that
 *      token's null (v0.4.7 discipline preserved per field).
 *  F4  feed-before-names issuance order on the timeline mount
 *      effect — statics.
 *  F5  boot reads parallelized — statics: lang + wallet info +
 *      unlock method in one Promise.all; the wallet list stays
 *      ordered after the batch.
 *
 *  Plus the F3 non-change proof: the scrypt verifier's
 *  parameters are pinned (N=16384/r=8/p=1/dkLen=32) and its
 *  node benchmark is re-run — v0.5.1 must NOT have touched it.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\\$/, '');
const OUT = ROOT + '/scripts/.build-startup';
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
      'src/lib/cawCore.ts',
      'src/lib/chains.ts',
      'src/lib/cawApi.ts',
      'src/lib/pwVerifier.ts',
      '--outDir',
      OUT,
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
} catch {
  console.log('tsc build failed');
  process.exit(1);
}

const read = (rel) => readFileSync(ROOT + rel, 'utf8');

const CAW = await import(OUT + '/lib/cawApi.js');
const CFG = await import(OUT + '/config.js');
const PW = await import(OUT + '/lib/pwVerifier.js');

/* ---------- F2: walletBalances in-flight dedupe (behavioral) ---------- */
{
  const ADDR = '0x000000000000000000000000000000000000dEaD';
  const BAL = { [CFG.QCAW.toLowerCase()]: 111n, [CFG.O_TOKEN.toLowerCase()]: 222n, [CFG.CAT42.toLowerCase()]: 333n, [CFG.KET42.toLowerCase()]: 444n };
  const encUint = (v) => '0x' + v.toString(16).padStart(64, '0');
  let fetches = 0;
  let failQcaw = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetches++;
    const body = JSON.parse(init.body);
    const { method, params } = body;
    let result;
    if (method === 'eth_getBalance') {
      result = String(url).includes('ql1') ? '0x3e8' : '0x7d0';
    } else if (method === 'eth_call') {
      const { to, data } = params[0];
      if (data.startsWith('0x70a08231')) {
        // balanceOf
        if (failQcaw && to.toLowerCase() === CFG.QCAW.toLowerCase()) {
          throw new Error('stubbed qcaw failure');
        }
        result = encUint(BAL[to.toLowerCase()] ?? 0n);
      } else if (data.startsWith('0x313ce567')) {
        result = encUint(18n); // decimals
      } else {
        throw new Error('unexpected eth_call data ' + data);
      }
    } else {
      throw new Error('unexpected method ' + method);
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', result }) };
  };
  try {
    // Two concurrent calls (the unlock + timeline double-fire)
    // must collapse into ONE underlying 8-RPC fetch set.
    fetches = 0;
    const [a, b] = await Promise.all([
      CAW.walletBalances(ADDR),
      CAW.walletBalances(ADDR.toLowerCase()),
    ]);
    ok(
      fetches === 8,
      `F2: two concurrent walletBalances calls = one 8-RPC fetch set (got ${fetches})`,
    );
    ok(
      a.qom === 1000n && a.qcaw === 111n && a.f42 === 2000n &&
        a.cat42 === 333n && a.oTok?.raw === 222n && a.oTok?.decimals === 18 &&
        a.ket?.raw === 444n && a.ket?.decimals === 18,
      'F2: the shared fetch resolves every field with its own value',
    );
    ok(
      b.qom === a.qom && b.qcaw === a.qcaw && b.oTok?.raw === a.oTok?.raw,
      'F2: both concurrent callers receive the shared result',
    );
    // In-flight ONLY: once settled, the next call reads fresh.
    fetches = 0;
    const c = await CAW.walletBalances(ADDR);
    ok(
      fetches === 8 && c.qcaw === 111n,
      `F2: a post-settle call fetches fresh (in-flight dedupe, not a result cache) — ${fetches} fetches`,
    );
    // Per-token failure isolation: the qCAW read fails (a
    // non-retried read), everything else still lands; qCAW is
    // null, never a fake 0, and no other field is disturbed.
    failQcaw = true;
    fetches = 0;
    const d = await CAW.walletBalances(ADDR);
    ok(
      d.qcaw === null && d.qom === 1000n && d.f42 === 2000n &&
        d.cat42 === 333n && d.oTok?.raw === 222n && d.ket?.raw === 444n,
      'F2: one token\'s failed read stays that token\'s null — no cross-field contamination',
    );
    failQcaw = false;
  } finally {
    globalThis.fetch = realFetch;
  }
  const api = read('/src/lib/cawApi.ts');
  ok(
    api.includes('balancesInFlight') &&
      api.includes('export function walletBalances'),
    'F2 wiring: walletBalances is the dedupe wrapper over the fetch',
  );
}

/* ---------- F1: busy feedback on both unlock paths (statics) ---------- */
{
  const unlock = read('/src/screens/UnlockScreen.tsx');
  ok(
    unlock.includes("tr('unlock.checking')") &&
      unlock.includes('disabled={busy}') &&
      unlock.includes('ActivityIndicator'),
    'F1: UnlockScreen shows a spinner + checking line and disables the button while unlocking',
  );
  ok(
    unlock.includes('busyRef') && unlock.indexOf('if (busyRef.current) return') > 0,
    'F1: UnlockScreen attempt is re-entry guarded (no double unlock)',
  );

  const ui = read('/src/components/ui.tsx');
  const prompt = ui.slice(ui.indexOf('export function PasswordPrompt'));
  ok(
    prompt.includes('busy') &&
      prompt.includes("tr('unlock.checking')") &&
      prompt.includes('editable={!busy}') &&
      prompt.includes('disabled={busy}'),
    'F1: PasswordPrompt takes a busy prop — spinner, checking line, locked input and buttons',
  );

  const ctx = read('/src/context/AppContext.tsx');
  ok(
    ctx.includes('pwBusy: boolean') && ctx.includes('pwBusy,'),
    'F1: AppContext exposes pwBusy (interface + value)',
  );
  const answer = ctx.slice(ctx.indexOf('const answerPwPrompt'));
  const iBusy = answer.indexOf('setPwBusy(true)');
  const iVerify = answer.indexOf('verifyPasswordThrottled');
  const iFinally = answer.indexOf('finally');
  ok(
    iBusy > 0 && iVerify > iBusy,
    'F1: answerPwPrompt flags busy BEFORE the verify await (the wait is presented, not hidden)',
  );
  ok(
    iFinally > iVerify &&
      answer.slice(iFinally, iFinally + 200).includes('setPwPrompt(null)'),
    'F1: the prompt is dismissed only after verification settles (finally) — it stays mounted, busy, during the wait',
  );
  const app = read('/App.tsx');
  ok(
    app.includes('busy={app.pwBusy}'),
    'F1: App wires pwBusy into PasswordPrompt',
  );
}

/* ---------- F5: boot reads parallelized (statics) ---------- */
{
  const ctx = read('/src/context/AppContext.tsx');
  const boot = ctx.slice(
    ctx.indexOf('/* ---------- boot ---------- */'),
    ctx.indexOf('const changeLang'),
  );
  const iBatch = boot.indexOf('Promise.all([');
  ok(iBatch > 0, 'F5: the boot effect runs one Promise.all batch');
  const batch = boot.slice(iBatch, boot.indexOf(']);', iBatch));
  ok(
    batch.includes('AsyncStorage.getItem(LANG_KEY)') &&
      batch.includes('getWalletPublicInfo()') &&
      batch.includes('getUnlockMethod()'),
    'F5: the batch covers the saved language, the active wallet info and the unlock method',
  );
  ok(
    boot.indexOf('await listWallets()') > iBatch,
    'F5: the wallet list stays an ordered read AFTER the batch (it re-reads the registry the migration may rewrite)',
  );
}

/* ---------- F4: feed issued before names (statics) ---------- */
{
  const tl = read('/src/screens/TimelineScreen.tsx');
  const marker = tl.indexOf('F4');
  const region = tl.slice(marker, marker + 900);
  const iFeed = region.indexOf('loadFirst();');
  const iBal = region.indexOf('app.refreshBalances()');
  const iNames = region.indexOf('app.refreshMyTokens()');
  ok(
    marker > 0 && iFeed > 0 && iBal > iFeed && iNames > iBal,
    'F4: the timeline mount effect issues loadFirst() before refreshBalances/refreshMyTokens',
  );
}

/* ---------- verifier untouched: parameter pin + benchmark ---------- */
{
  ok(
    PW.PW_SCRYPT_N === 16384 && PW.PW_SCRYPT_R === 8 &&
      PW.PW_SCRYPT_P === 1 && PW.PW_DKLEN === 32,
    'F3 non-change: scrypt parameters are exactly the v0.5.0 ones (N=16384, r=8, p=1, dkLen=32)',
  );
  const record = await PW.makePwRecord('startup-benchmark', '00112233445566778899aabbccddeeff');
  const times = [];
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    const verdict = await PW.checkPwRecord(record, 'startup-benchmark');
    times.push(performance.now() - t0);
    if (!verdict.ok) break;
  }
  times.sort((x, y) => x - y);
  const median = times[Math.floor(times.length / 2)];
  console.log(`  scrypt benchmark: median ${median.toFixed(1)} ms over ${times.length} runs (audit reference ~113 ms)`);
  ok(
    times.length === 7 && median > 40 && median < 400,
    'F3 non-change: the verifier still verifies and its cost is unchanged (median in the audit\'s range)',
  );
}

/* ---------- release pins ---------- */
{
  const appJson = JSON.parse(read('/app.json'));
  ok(
    appJson.expo.version === '0.6.2' && appJson.expo.android.versionCode === 42,
    'release: versionName 0.6.2, versionCode 42 (the F1/F2/F4/F5 fixes ride along from v0.5.1)',
  );
}

console.log(`\nverify-startup: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
