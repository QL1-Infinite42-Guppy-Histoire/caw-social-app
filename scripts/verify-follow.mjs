/* Verification for the v0.1.5 additions. Run: node scripts/verify-follow.mjs
 *
 * 1. Type-4 (unfollow) decoding: a known on-chain unfollow batch
 *    (190 "neptune" -> 1646, tx 0x1c946bc8…) must decode as one
 *    type-4 action with text "UNFOLLOW". Earlier decoders dropped
 *    type 4 entirely, so this batch used to vanish.
 * 2. Follow index vs the chain: build the index from the live feed
 *    (in-memory KV), refine it, and compare follower lists against
 *    the chain's own followerCount for sampled names. The state
 *    rule + zero-balance exclusion was measured beforehand at
 *    59/73 exact matches (state rule alone: 52/73); here #10 must
 *    match EXACTLY (its two non-registering follows were proven to
 *    be exactly the zero-balance ones) and the other samples must
 *    land within 2 of the chain count.
 * 3. Pair spot checks from known records: 152 -> 3 and 3 -> 531
 *    both ENDED in an unfollow (not following); 190 -> 10 is a live
 *    follow and must appear in #10's refined followers. (517 -> 13
 *    is deliberately NOT used: it went follow -> unfollow -> follow
 *    again within eight blocks, so its state is "following".)
 * 4. Name directory + partial search: a full directory build, then
 *    "nept" must find neptune (#190), an exact "neptune" query must
 *    rank #190 first, and "dream" must find dreamin (#189).
 * 5. MyActionStore: an observed unfollow (type 4) from one of my
 *    names clears the remembered follow.
 *
 * No keys, no sends — reads and local logic only.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BUILD = new URL('./.build-follow', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  ok ? pass++ : fail++;
};

/* ---- build the modules under test ---- */
execFileSync(
  'npx',
  [
    'tsc', '--ignoreConfig',
    'src/config.ts', 'src/lib/cawCore.ts', 'src/lib/cawApi.ts',
    'src/lib/myActions.ts', 'src/lib/nameDirectory.ts',
    'src/lib/followIndex.ts',
    '--module', 'commonjs', '--target', 'es2022',
    '--outDir', BUILD, '--skipLibCheck',
  ],
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'inherit' },
);

const core = require(BUILD + '/lib/cawCore.js');
const api = require(BUILD + '/lib/cawApi.js');
const followIndex = require(BUILD + '/lib/followIndex.js');
const nameDir = require(BUILD + '/lib/nameDirectory.js');
const { MyActionStore } = require(BUILD + '/lib/myActions.js');

const memKV = () => {
  const m = new Map();
  return {
    getItem: async (k) => (m.has(k) ? m.get(k) : null),
    setItem: async (k, v) => { m.set(k, v); },
  };
};

/* ---- 1. unfollow decoding ---- */
{
  const res = await fetch(
    'https://scan.qom.network/api/v2/transactions/0x1c946bc877f411131a6eb8f7146a4e2ef841f534183ce0752fb3bd928acb6075',
  );
  const j = await res.json();
  const acts = core.decodeActions(j.raw_input);
  check(
    'known unfollow batch decodes as type 4',
    acts.length === 1 &&
      acts[0].type === 4 &&
      acts[0].senderId === 190n &&
      acts[0].receiverId === 1646n &&
      acts[0].text === 'UNFOLLOW',
    acts.length ? `type=${acts[0].type} ${acts[0].senderId}->${acts[0].receiverId} "${acts[0].text}"` : 'no actions decoded',
  );
}

/* ---- 2 + 3. follow index vs chain counts ---- */
followIndex.initFollowIndex(memKV());
{
  const t0 = Date.now();
  await followIndex.buildFollowIndex();
  console.log(`  (index build: ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  check('follow index built', followIndex.followIndexReady());

  check(
    'pair state: 152 -> 3 ended in an unfollow',
    followIndex.isFollowingIndexed(152n, 3n) === false,
  );
  check(
    'pair state: 3 -> 531 ended in an unfollow',
    followIndex.isFollowingIndexed(3n, 531n) === false,
  );
  check(
    'pair state: 190 -> 10 is following',
    followIndex.isFollowingIndexed(190n, 10n) === true,
  );

  const samples = [10n, 27n, 190n, 191n, 298n];
  for (const id of samples) {
    const lists = await followIndex.refinedFollowListsOf(id);
    const fc = Number(await api.followerCount(id));
    const diff = Math.abs(lists.followers.length - fc);
    console.log(
      `  name #${id}: refined followers=${lists.followers.length} chain followerCount=${fc}`,
    );
    if (id === 10n) {
      check('followers of #10 match followerCount exactly', diff === 0,
        `refined=${lists.followers.length} chain=${fc}`);
      check(
        'refined followers of #10 include 190 (known live follow)',
        lists.followers.some((x) => x === 190n),
      );
    } else {
      check(`followers of #${id} within 2 of followerCount`, diff <= 2,
        `refined=${lists.followers.length} chain=${fc}`);
    }
  }
}

/* ---- 4. name directory + partial search ---- */
nameDir.initNameDirectory(memKV());
{
  const t0 = Date.now();
  await nameDir.ensureDirectory();
  const st = nameDir.directoryStatus();
  console.log(
    `  (directory build: ${((Date.now() - t0) / 1000).toFixed(0)}s, ${st.done} names)`,
  );
  check('directory covers all minted names', st.done > 3900, `${st.done} names`);

  const partial = nameDir.searchDirectory('nept');
  check(
    'partial search "nept" finds neptune (#190)',
    partial.some((e) => e.id === 190n && e.name === 'neptune'),
    partial.slice(0, 5).map((e) => `${e.name}#${e.id}`).join(', '),
  );
  const exact = nameDir.searchDirectory('neptune');
  check(
    'exact search ranks neptune first',
    exact.length > 0 && exact[0].id === 190n,
    exact.length ? `${exact[0].name}#${exact[0].id}` : 'no results',
  );
  const dream = nameDir.searchDirectory('dream');
  check(
    'partial search "dream" finds dreamin (#189)',
    dream.some((e) => e.id === 189n && e.name === 'dreamin'),
    dream.slice(0, 5).map((e) => `${e.name}#${e.id}`).join(', '),
  );
}

/* ---- 5. MyActionStore unfollow observation ---- */
{
  const store = new MyActionStore();
  await store.init(memKV(), '0x0000000000000000000000000000000000000001');
  store.registerOwnIds([190n]);
  store.observe({ type: 3, senderId: 190n, receiverId: 10n, cawId: '0x0' });
  const afterFollow = store.has(3, 190n, '10');
  store.observe({ type: 4, senderId: 190n, receiverId: 10n, cawId: '0x0' });
  const afterUnfollow = store.has(3, 190n, '10');
  check(
    'observed unfollow clears the remembered follow',
    afterFollow === true && afterUnfollow === false,
    `afterFollow=${afterFollow} afterUnfollow=${afterUnfollow}`,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
