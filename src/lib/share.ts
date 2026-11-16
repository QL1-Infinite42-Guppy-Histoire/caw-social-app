/**
 * Share message composition (v0.6.6): what the PostCard share
 * button hands to the OS share sheet.
 *
 * The message is the post's own words, its author line, and —
 * since v0.6.6 — a LINK to the post's page on the community web
 * viewer (caw-social-ql1):
 *
 *     <body>
 *     — @handle · CAW Social
 *     https://ql1-infinite42-guppy-histoire.github.io/caw-social-ql1/en.html?post=<cawId>
 *
 * The link format is the viewer's own: its postUrl() builds
 * pageFile + '?post=' + cawId, the post page accepts only
 * /^0x[0-9a-fA-F]{64}$/ and looks the post up by that cawId
 * (case-insensitively). The page file follows the app's current
 * language — ja.html for Japanese, en.html for everything else
 * (the viewer ships EN/JA only).
 *
 * A post whose cawId is missing or not in that exact shape gets
 * the v0.6.4 text-only message: no link is ever fabricated.
 * Read-only composition: no signing, no chain.
 *
 * Keep this module free of React Native imports (same rule as
 * config.ts) so the Node harness can exercise it directly.
 */

/** The community web viewer's base (its post pages live here). */
export const VIEWER_BASE_URL =
  'https://ql1-infinite42-guppy-histoire.github.io/caw-social-ql1';

/* The viewer's own acceptance shape for ?post= — a cawId is
 * '0x' + 64 hex chars (the app's items carry exactly that). */
const CAW_ID_SHAPE = /^0x[0-9a-fA-F]{64}$/;

/**
 * The post's page on the web viewer, or null when the cawId
 * cannot name one. `lang` is the app's current language code;
 * only 'ja' selects the Japanese page.
 */
export function postPageUrl(
  cawId: string | null | undefined,
  lang: string,
): string | null {
  if (!cawId || !CAW_ID_SHAPE.test(cawId)) return null;
  const page = lang === 'ja' ? 'ja.html' : 'en.html';
  return VIEWER_BASE_URL + '/' + page + '?post=' + cawId;
}

/**
 * The full share message for a post. `body` is the post's
 * display body (marker line already stripped), `author` the
 * composed author label ('@handle', or the unknown-name label).
 * The caller passes the cawId of the post the button sits on —
 * in a Recaw row that is the nested ORIGINAL post, so the link
 * names the original, matching the row's other actions.
 */
export function composeShareMessage(
  body: string,
  author: string,
  cawId: string | null | undefined,
  lang: string,
): string {
  const head = body
    ? body + '\n— ' + author + ' · CAW Social'
    : '— ' + author + ' · CAW Social';
  const url = postPageUrl(cawId, lang);
  return url ? head + '\n' + url : head;
}
