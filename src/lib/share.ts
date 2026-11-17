/**
 * Share payload (v0.6.7): what the PostCard share button hands
 * to the OS share sheet — a LINK, and only a link.
 *
 * The user's call (2026-11-16): when sharing, share the link
 * alone — no post text, no author line (v0.6.4 shared text;
 * v0.6.6 added the link under it). The link is the post's page
 * on the community web viewer (caw-social-ql1), shortened
 * through the community link service (cawl), CAW style:
 *
 *     https://c.qql1.com/<code>
 *       → 302 → <viewer>/en.html?post=<cawId>
 *
 * The full viewer URL format is the viewer's own: its postUrl()
 * builds pageFile + '?post=' + cawId, the post page accepts
 * only /^0x[0-9a-fA-F]{64}$/ and looks the post up by that
 * cawId (case-insensitively). The page file follows the app's
 * current language — ja.html for Japanese, en.html for
 * everything else (the viewer ships EN/JA only) — and that
 * choice is baked into the URL being shortened, so the short
 * link lands on the same-language page.
 *
 * Fallbacks, in order — the payload is ALWAYS exactly one URL:
 *   1. shortening fails → the full viewer post-page URL;
 *   2. the post has no well-formed cawId → the viewer's top
 *      page for the current language. A post link is never
 *      fabricated, and there is no text fallback anymore.
 *
 * The caller passes the cawId of the post the button sits on —
 * in a Recaw row that is the nested ORIGINAL post, so the link
 * names the original, matching the row's other actions.
 * Read-only: no signing, no chain.
 *
 * Keep this module free of React Native imports (same rule as
 * config.ts) so the Node harness can exercise it directly. The
 * shorten function is injected (lib/linkify.ts's shortenUrl in
 * the app; a fake in the harness).
 */

/** The community web viewer's base (its post pages live here). */
export const VIEWER_BASE_URL =
  'https://ql1-infinite42-guppy-histoire.github.io/caw-social-ql1';

/* The viewer's own acceptance shape for ?post= — a cawId is
 * '0x' + 64 hex chars (the app's items carry exactly that). */
const CAW_ID_SHAPE = /^0x[0-9a-fA-F]{64}$/;

/** The viewer's page file for an app language (EN/JA only). */
export function viewerPageFile(lang: string): string {
  return lang === 'ja' ? 'ja.html' : 'en.html';
}

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
  return VIEWER_BASE_URL + '/' + viewerPageFile(lang) + '?post=' + cawId;
}

/** The viewer's top page for the current language. */
export function viewerTopUrl(lang: string): string {
  return VIEWER_BASE_URL + '/' + viewerPageFile(lang);
}

/**
 * The full (unshortened) link a share points at: the post's
 * page when the cawId names one, the viewer's top page
 * otherwise — always a real viewer URL, never a fabricated
 * post link.
 */
export function shareTargetUrl(
  cawId: string | null | undefined,
  lang: string,
): string {
  return postPageUrl(cawId, lang) ?? viewerTopUrl(lang);
}

/** A one-URL shortener (lib/linkify.ts's shortenUrl). */
export type ShortenFn = (url: string) => Promise<string | null>;

/**
 * Resolve the ONE link the share sheet carries: the target's
 * short form when the shortener answers, the full target URL
 * when it does not (offline, Worker error, empty answer).
 */
export async function resolveShareUrl(
  cawId: string | null | undefined,
  lang: string,
  shorten: ShortenFn,
): Promise<string> {
  const target = shareTargetUrl(cawId, lang);
  let short: string | null = null;
  try {
    short = await shorten(target);
  } catch {
    short = null;
  }
  return short && short.length > 0 ? short : target;
}
