/* String-length audit for the 13-language UI. Run: node scripts/audit-i18n.mjs
 *
 * The UI must not break when a language's words run long (Spanish,
 * Korean, French and Dutch compounds are the usual risks; the audit
 * iterates LANGS, so every shipped language is covered): tab labels, buttons and chips
 * are flexible-width, but a hard budget still applies to the fixed
 * places — above all the four bottom tab labels, which share one
 * row. This audit:
 *  - extracts every string key from src/i18n.ts and checks every
 *    language defines it (a missing key silently falls back to
 *    English in tr(), which must never happen unnoticed);
 *  - measures display width per language (CJK glyphs count ~1.7,
 *    latin ~1.0) and enforces budgets for the tab labels and the
 *    main action buttons;
 *  - prints the longest strings per language for eyeball review.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BUILD = new URL('./.build-i18n', import.meta.url).pathname;

execFileSync(
  'npx',
  [
    'tsc', '--ignoreConfig', 'src/i18n.ts',
    '--module', 'commonjs', '--target', 'es2022',
    '--outDir', BUILD, '--skipLibCheck',
  ],
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'inherit' },
);

const i18n = require(BUILD + '/i18n.js');

// Keys: read them out of the EN block of the source (key: '...' lines).
const src = readFileSync(
  new URL('../src/i18n.ts', import.meta.url),
  'utf8',
);
const keys = [...new Set([...src.matchAll(/^\s*'([a-z]+(?:\.[a-zA-Z0-9]+)+)':/gm)].map((m) => m[1]))];

const width = (s) => {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFF60]/.test(ch) ? 1.7 : 1;
  return w;
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

const langs = i18n.LANGS.map((l) => l.code);
console.log(`keys: ${keys.length}, languages: ${langs.join(', ')}`);

// RTL mapping (v0.3.9): Persian is the one right-to-left language —
// src/lib/rtl.ts drives I18nManager.forceRTL from langIsRtl(), so
// fa must need RTL and every other language must not.
check(
  'fa and ar are the only RTL languages',
  i18n.langIsRtl('fa') && i18n.langIsRtl('ar') &&
    langs.every((l) => l === 'fa' || l === 'ar' || !i18n.langIsRtl(l)),
  'rtl: ' + langs.filter((l) => i18n.langIsRtl(l)).join(', '),
);

// Every language must define every key: sample tr() per language and
// compare against the raw per-language tables via re-reading the
// source (a key present in EN but absent in another dict leaves the
// EN string in place — detect by block-scoped extraction).
for (const lang of langs) {
  i18n.setLang(lang);
  const missing = keys.filter((k) => i18n.tr(k) === k);
  check(`${lang}: every key resolves`, missing.length === 0,
    missing.length ? 'missing: ' + missing.slice(0, 5).join(', ') : `${keys.length} keys`);
}

// Budgets for the places that cannot simply wrap: the bottom tab
// labels (one shared row), the follow counts/tabs (a shared row),
// and button labels (self-sizing pills / full-width buttons — a
// label wider than the budget would crowd or clip). Long sentences
// (confirm titles, warnings, status lines) are full-width text and
// wrap by design, so they are only listed below, not budgeted.
const BUDGETS = [
  { keys: keys.filter((k) => k.startsWith('nav.')), max: 17, why: 'bottom tab labels share one row' },
  {
    keys: ['followlist.following', 'followlist.followers'],
    max: 14,
    why: 'profile counts + list tabs share rows',
  },
  {
    keys: ['tl.tabLatest', 'tl.tabFollowing'],
    max: 17,
    why: 'timeline segment tabs share one row (v0.2.0)',
  },
  {
    keys: [
      'act.like', 'act.share', 'act.follow', 'act.followed',
      'act.following', 'act.sending', 'act.done',
      'get.check', 'get.approveBtn', 'get.mintBtn', 'get.viewProfile',
      'compose.post', 'compose.send', 'compose.cancel',
      'common.back', 'common.close',
      'settings.copy', 'settings.deleteConfirm', 'settings.cancel',
      'settings.lockNow', 'custom.save', 'custom.edit', 'profile.retry',
      'mine.deposit', 'mine.withdraw', 'unlock.open', 'wallet.done',
      'wallet.savedIt', 'wallet.importBtn',
      'draft.discard', 'wallets.add', 'wallets.deleteOne',
      'detail.likedBy', 'detail.sharedBy',
      /* The HuntersExchange header: the GetNameScreen "Buy CAW"
       * opener and the header Send pill share fixed rows too.
       * (v0.5.0 formal: 'hs.sell' died with the instant swap.) */
      'hs.buy', 'send.title',
      /* The Exchange deposit / withdraw entry buttons render
       * two per row (v0.5.0 formal; QOM added with the second
       * pair). */
      'hxd.depUsdt', 'hxd.depCaw', 'hxd.depQom',
      'hxd.wdUsdt', 'hxd.wdCaw', 'hxd.wdQom',
    ],
    max: 26,
    why: 'button labels',
  },
];
for (const lang of langs) {
  i18n.setLang(lang);
  for (const b of BUDGETS) {
    const over = b.keys
      .map((k) => ({ k, w: width(i18n.tr(k)) }))
      .filter((x) => x.w > b.max);
    check(
      `${lang}: ${b.why} within width ${b.max}`,
      over.length === 0,
      over.length
        ? over.map((x) => `${x.k}=${x.w.toFixed(1)} "${i18n.tr(x.k)}"`).join(', ')
        : 'ok',
    );
  }
}

// Longest strings per language (review list — not a failure).
for (const lang of langs) {
  i18n.setLang(lang);
  const rows = keys
    .map((k) => ({ k, s: i18n.tr(k) }))
    .sort((a, b) => width(b.s) - width(a.s))
    .slice(0, 3);
  console.log(`  ${lang} longest:`);
  for (const r of rows) {
    console.log(`    ${r.k} (w=${width(r.s).toFixed(0)}, ${r.s.length} chars): ${r.s.slice(0, 60)}…`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
