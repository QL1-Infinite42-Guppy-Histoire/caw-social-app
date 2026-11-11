/* Verification for the secret-reveal ceremony (v0.3.1).
 * Run: node scripts/verify-reveal.mjs
 *
 * Pure logic only — no real secrets anywhere: quiz pass/fail/retry,
 * decoy generation (decoys must NEVER equal a real word / the real
 * key), and the gate structure (the secret loader must not run
 * before the password check succeeds).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BUILD = new URL('./.build-reveal', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

execFileSync(
  'npx',
  [
    'tsc', '--ignoreConfig', 'src/lib/reveal.ts',
    '--module', 'commonjs', '--target', 'es2022',
    '--outDir', BUILD, '--skipLibCheck',
  ],
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'inherit' },
);
const R = require(BUILD + '/reveal.js');

/* ---- quiz: MetaMask's two questions ---- */
{
  let s = R.quizInitial;
  check('quiz starts asking Q1', s.qIdx === 0 && s.phase === 'asking');
  // Q1 correct is index 1 ("Can't help you")
  s = R.quizReduce(s, { type: 'answer', choice: 0 });
  check('Q1 wrong answer: error state, same question', s.phase === 'asking' && s.wrong === true && s.qIdx === 0);
  s = R.quizReduce(s, { type: 'answer', choice: 0 });
  check('Q1 wrong again: still retryable', s.phase === 'asking' && s.wrong === true);
  s = R.quizReduce(s, { type: 'answer', choice: 1 });
  check('Q1 correct: feedback panel', s.phase === 'feedback' && s.wrong === false);
  s = R.quizReduce(s, { type: 'answer', choice: 0 });
  check('answers ignored during feedback', s.phase === 'feedback');
  s = R.quizReduce(s, { type: 'next' });
  check('continue -> Q2 asking', s.qIdx === 1 && s.phase === 'asking');
  // Q2 correct is index 0 ("You're being scammed")
  s = R.quizReduce(s, { type: 'answer', choice: 1 });
  check('Q2 wrong answer: error state', s.phase === 'asking' && s.wrong === true);
  s = R.quizReduce(s, { type: 'answer', choice: 0 });
  check('Q2 correct: feedback panel', s.phase === 'feedback');
  s = R.quizReduce(s, { type: 'next' });
  check('continue after Q2: quiz done', s.phase === 'done');
  check('quiz has exactly 2 questions', R.QUIZ_COUNT === 2);
}

/* ---- decoys never equal real secrets ---- */
{
  // Seeded rand for reproducibility.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const real = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
  let allOk = true;
  for (let t = 0; t < 200; t++) {
    const d = R.makeDecoyWords(real, 12, rand);
    if (d.length !== 12) allOk = false;
    if (d.some((w) => real.includes(w))) allOk = false;
  }
  check('decoy words (200 trials): right count, never a real word', allOk);
  // Even when the real phrase contains pool words, they are filtered.
  const tricky = ['window', 'coffee', 'river', 'stone'];
  const d2 = R.makeDecoyWords(tricky, 24, rand);
  check('decoys filter out pool words that are in the real phrase',
    d2.every((w) => !tricky.includes(w)));
  const realKey = '0x' + 'a'.repeat(64);
  let keyOk = true;
  for (let t = 0; t < 200; t++) {
    const dk = R.makeDecoyKey(realKey, rand);
    if (dk === realKey || !/^0x[0-9a-f]{64}$/.test(dk)) keyOk = false;
  }
  check('decoy key (200 trials): valid shape, never the real key', keyOk);
}

/* ---- the gate: no load before a successful verify ---- */
{
  let loads = 0;
  const load = async () => {
    loads++;
    return { kind: 'mnemonic', secret: 'dummy' };
  };
  const denied = await R.gatedReveal(async () => false, load);
  check('gate: failed password -> null, loader never ran', denied === null && loads === 0);
  const granted = await R.gatedReveal(async () => true, load);
  check('gate: correct password -> secret loaded once',
    granted !== null && granted.secret === 'dummy' && loads === 1);
  check('auto-hide is 60s', R.REVEAL_AUTO_HIDE_MS === 60000);
}

/* ---- L3 (v0.5.0-fix): a copied secret leaves the clipboard ---- */
{
  const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const scr = readFileSync(root + '/src/screens/RevealSecretScreen.tsx', 'utf8');
  const iCopy = scr.indexOf('const doCopy');
  const copyBody = scr.slice(iCopy, iCopy + 1200);
  check('L3: copying schedules a clipboard clear (empty overwrite)',
    copyBody.includes("Clipboard.setStringAsync('')") && copyBody.includes('60_000'));
  check('L3: a fresh copy re-arms the clear timer',
    copyBody.includes('clearTimeout(clipTimer.current)'));
  check('L3: the clear timer is also disarmed on unmount/wipe',
    scr.includes('if (clipTimer.current) clearTimeout(clipTimer.current);'));
  const i18nSrc = readFileSync(root + '/src/i18n.ts', 'utf8');
  const copied = i18nSrc.match(/'reveal\.copied':\s*(?:'([^']*)'|"([^"]*)")/g) || [];
  check('L3: the copied feedback states the 60 s clear in all 20 languages',
    copied.length === 20 &&
      copied.every((l) => /60|۶۰/.test(l)),
    copied.length + ' locales');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
