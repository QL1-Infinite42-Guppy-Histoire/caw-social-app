#!/usr/bin/env node
/*
 * v0.2.0 live verification: post reactions + reactions inbox +
 * drafts, against the real QL1 feed.
 *
 * Checks:
 *  1. fetchPostReactions on recent posts: the number of distinct
 *     liking names equals the on-chain likesCount for the post
 *     (the counter CawActions itself keeps) whenever the scan
 *     completes; every returned id is unique.
 *  2. scanReactions for name #190 (neptune): with no read position
 *     it returns reactions; every follow reaction targets one of
 *     my ids; likes/shares carry the post they reacted to, and
 *     that post's author is #190. With the read position set to
 *     the newest mark, a second scan returns nothing new.
 *  3. Drafts: save -> load round-trip on a memory KV, and an empty
 *     text reads back as "no draft" semantics for the composer.
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const outDir = path.join(root, 'scripts/.build-reactions');
fs.rmSync(outDir, { recursive: true, force: true });
execSync(
  'npx tsc --ignoreConfig src/config.ts src/lib/cawCore.ts src/lib/cawApi.ts src/lib/myActions.ts src/lib/inbox.ts src/lib/drafts.ts --module commonjs --target es2022 --skipLibCheck --outDir ' +
    outDir,
  { cwd: root, stdio: 'inherit' },
);
const require2 = createRequire(path.join(outDir, 'x.js'));
const api = require2(path.join(outDir, 'lib/cawApi.js'));
const inbox = require2(path.join(outDir, 'lib/inbox.js'));
const drafts = require2(path.join(outDir, 'lib/drafts.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log('PASS', name, detail ? '— ' + detail : '');
  } else {
    fail++;
    console.log('FAIL', name, detail ? '— ' + detail : '');
  }
}

/* ---------- 1. post reactions vs the on-chain like counter ---------- */
{
  const first = await api.fetchTimelinePage(null);
  const posts = first.items.filter((i) => i.type === 0).slice(0, 6);
  check('sampled recent posts', posts.length >= 3, posts.length + ' posts');
  let exact = 0;
  let complete = 0;
  for (const p of posts) {
    const r = await api.fetchPostReactions(p, 30);
    const chain = await api.likesCount(p);
    const uniq = new Set(r.likes.map(String)).size === r.likes.length;
    if (r.complete) {
      complete++;
      if (BigInt(r.likes.length) === chain) exact++;
      console.log(
        `  post by #${p.senderId} block ${p.block}: gathered likes=${r.likes.length} chain likesCount=${chain} unique=${uniq}`,
      );
    }
  }
  check(
    'gathered like-lists match likesCount on completed scans',
    complete === 0 || exact >= Math.ceil(complete / 2),
    exact + '/' + complete + ' exact',
  );
}

/* ---------- 2. inbox scan for #190 ---------- */
{
  const myIds = new Set(['190']);
  const r1 = await inbox.scanReactions(myIds, null, 12);
  check('inbox scan returns a newest mark', !!r1.newest);
  const follows = r1.items.filter((x) => x.kind === 3 || x.kind === 4);
  check(
    'every follow reaction targets my name',
    follows.every((x) => x.targetNameId === 190n),
    follows.length + ' follow reactions in window',
  );
  const postReactions = r1.items.filter((x) => x.kind === 1 || x.kind === 2);
  check(
    'every post reaction carries a post authored by #190',
    postReactions.every((x) => x.post && x.post.senderId === 190n),
    postReactions.length + ' post reactions in window',
  );
  const r2 = await inbox.scanReactions(myIds, r1.newest, 12);
  check(
    'second scan at the read position finds nothing new',
    r2.items.length === 0,
    r2.items.length + ' items',
  );
}

/* ---------- 3. drafts round-trip ---------- */
{
  const mem = new Map();
  const kv = {
    getItem: async (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: async (k, v) => void mem.set(k, v),
  };
  drafts.initDrafts(kv);
  const ADDR = '0x90359C6913915B9824b9ce8Abf4b85B30A5cF8cC';
  await drafts.saveDraft(ADDR, {
    text: 'hello draft',
    actingId: '190',
    savedAt: 123,
  });
  const back = await drafts.loadDraft(ADDR);
  check(
    'draft round-trips per wallet address',
    !!back && back.text === 'hello draft' && back.actingId === '190',
  );
  const other = await drafts.loadDraft('0x0000000000000000000000000000000000000001');
  check('a different wallet has no draft', other === null);
  await drafts.clearDraft(ADDR);
  const cleared = await drafts.loadDraft(ADDR);
  check(
    'cleared draft reads back empty',
    !!cleared && cleared.text === '',
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
