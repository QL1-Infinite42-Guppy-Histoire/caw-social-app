/**
 * Links in post text (v0.6.5): URL extraction, shortening at
 * compose time, and preview (snippet) data — all served by the
 * cawl Worker (LINK_SERVICE_URL in config.ts).
 *
 * Shortening: when the user proceeds to post, each URL in the
 * draft that is LONGER than its short form is replaced by
 * https://c.qql1.com/<code> BEFORE the action is
 * assembled, and the result is written back into the editor, so
 * the exact text that will be inscribed on-chain is what the
 * user sees and signs. It also genuinely saves the 420-BYTE
 * post budget. Shortening is best-effort: any failure (offline,
 * Worker error) leaves the original URL untouched — it must
 * never block or break posting.
 *
 * Previews: the Worker fetches the target page and returns the
 * title / description / image it actually found there (empty
 * strings when absent — nothing is invented). For our own short
 * links the Worker resolves the destination first, so the
 * snippet describes the real page and names its domain. A
 * failed preview yields null here and the UI shows no card —
 * the tappable link in the text always remains.
 *
 * Keep this module free of React Native imports (same rule as
 * config.ts) so the Node harness can exercise it directly.
 */

import { LINK_SERVICE_URL } from '../config';

export interface LinkPreview {
  /** The resolved final URL (short links are unwrapped). */
  url: string;
  title: string;
  description: string;
  image: string;
  domain: string;
}

/* ---------------- extraction ---------------- */

/* A URL candidate: http(s) followed by ASCII printable
 * characters (no spaces, no quotes, no angle brackets). The
 * ASCII-only charset also stops a URL at the first Japanese
 * character, so a link pasted directly against Japanese text
 * ("…https://example.comを見て") is still found cleanly;
 * percent-encoded URLs — the normal form — are unaffected. */
const URL_RE = /https?:\/\/[!-~]+/g;

/* Characters that end a sentence rather than a URL when they
 * appear at its tail: ASCII sentence punctuation and closing
 * brackets without a matching opener inside the candidate. */
const TRAILING_PUNCT = '.,;:!?…、。！？';

function trimUrlCandidate(raw: string): string {
  let s = raw;
  for (;;) {
    if (s.length === 0) return s;
    const last = s[s.length - 1];
    if (TRAILING_PUNCT.includes(last)) {
      s = s.slice(0, -1);
      continue;
    }
    if (last === ')' || last === ']' || last === '}') {
      const open = last === ')' ? '(' : last === ']' ? '[' : '{';
      const opens = s.split(open).length - 1;
      const closes = s.split(last).length - 1;
      if (closes > opens) {
        s = s.slice(0, -1);
        continue;
      }
    }
    return s;
  }
}

export interface LinkSegment {
  text: string;
  /** Set when this segment is a URL. */
  url?: string;
}

/** Split text into plain and URL segments, in order. */
export function splitLinkSegments(text: string): LinkSegment[] {
  const out: LinkSegment[] = [];
  const re = new RegExp(URL_RE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const url = trimUrlCandidate(m[0]);
    if (url.length === 0) continue;
    const start = m.index;
    const end = start + url.length;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: url, url });
    last = end;
    re.lastIndex = end;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  if (out.length === 0 && text.length > 0) out.push({ text });
  return out;
}

/** Every URL in the text, in order of appearance. */
export function extractUrls(text: string): string[] {
  return splitLinkSegments(text)
    .filter((s) => s.url)
    .map((s) => s.url as string);
}

/* ---------------- mentions (v0.7.0) ---------------- */

/**
 * A segment of post text after BOTH link and mention
 * splitting: a URL segment (url set), an @mention segment
 * (mention set to the CAW name, lowercased, without the @),
 * or plain text.
 */
export interface RichSegment {
  text: string;
  url?: string;
  mention?: string;
}

/**
 * Is this `@` at position i the start of a mention? The @
 * must not be glued to a preceding word character (so an
 * email address like foo@bar never yields a mention), and
 * at least one name character must follow. CAW names are
 * lowercase letters + digits (see isMintableUsername in
 * lib/cawCore.ts); typed text may use uppercase, which the
 * match accepts and the segment value lowercases.
 */
function mentionNameAt(text: string, i: number): string | null {
  if (text[i] !== '@') return null;
  if (i > 0 && /[A-Za-z0-9]/.test(text[i - 1])) return null;
  let j = i + 1;
  while (j < text.length && /[A-Za-z0-9]/.test(text[j])) j++;
  if (j === i + 1) return null;
  return text.slice(i + 1, j).toLowerCase();
}

/** Split a plain (non-URL) run of text on @mentions. */
function splitMentionSegments(text: string): RichSegment[] {
  const out: RichSegment[] = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const name = text[i] === '@' ? mentionNameAt(text, i) : null;
    if (name !== null) {
      if (buf) {
        out.push({ text: buf });
        buf = '';
      }
      out.push({ text: text.slice(i, i + 1 + name.length), mention: name });
      i += 1 + name.length;
    } else {
      buf += text[i];
      i++;
    }
  }
  if (buf) out.push({ text: buf });
  return out;
}

/**
 * Split post text into plain / URL / @mention segments, in
 * order. URLs win first (an @ inside a URL stays part of the
 * URL); mentions are only recognised in the plain runs
 * between URLs.
 */
export function splitRichSegments(text: string): RichSegment[] {
  const out: RichSegment[] = [];
  for (const seg of splitLinkSegments(text)) {
    if (seg.url) {
      out.push({ text: seg.text, url: seg.url });
    } else {
      out.push(...splitMentionSegments(seg.text));
    }
  }
  if (out.length === 0 && text.length > 0) out.push({ text });
  return out;
}

/**
 * The @mention being typed at the END of `textBeforeCursor`,
 * or null: the run of name characters right before the
 * cursor, when it is headed by an @ that starts a mention
 * (same boundary rule as the renderer). Returns the partial
 * name (lowercased, possibly '') and the index of the @, so
 * the composer can offer candidates and complete the name.
 * An empty partial (a just-typed @) yields { partial: '' } —
 * the caller decides whether to list candidates for it.
 */
export function mentionFragmentAt(
  textBeforeCursor: string,
): { partial: string; atIndex: number } | null {
  let i = textBeforeCursor.length;
  while (i > 0 && /[A-Za-z0-9]/.test(textBeforeCursor[i - 1])) i--;
  if (i === 0 || textBeforeCursor[i - 1] !== '@') return null;
  const atIndex = i - 1;
  // The @ must itself start a mention (not be glued to a
  // preceding word character, e.g. inside an email address).
  if (atIndex > 0 && /[A-Za-z0-9]/.test(textBeforeCursor[atIndex - 1])) {
    return null;
  }
  return {
    partial: textBeforeCursor.slice(i).toLowerCase(),
    atIndex,
  };
}

/* ---------------- shortening ---------------- */

type FetchFn = typeof fetch;

async function fetchWithTimeout(
  fetchFn: FetchFn,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the Worker for one URL's short form; null on any failure. */
async function shortenOne(
  fetchFn: FetchFn,
  url: string,
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      fetchFn,
      LINK_SERVICE_URL + '/api/shorten',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      },
      6000,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { short?: unknown };
    return typeof data.short === 'string' && data.short.length > 0
      ? data.short
      : null;
  } catch {
    return null;
  }
}

/**
 * The short form of ONE URL, or null on any failure. Exported
 * for flows that shorten a single link rather than a text —
 * the share payload (lib/share.ts) is one link.
 */
export function shortenUrl(
  url: string,
  fetchFn: FetchFn = fetch,
): Promise<string | null> {
  if (!LINK_SERVICE_URL || !url) return Promise.resolve(null);
  return shortenOne(fetchFn, url);
}

/**
 * Replace every URL in the text that is longer than its short
 * form by the short form. URLs that fail to shorten (or whose
 * short form is not actually shorter) stay exactly as written.
 * The text is otherwise untouched — in particular this is only
 * ever run on the post BODY, never on a text already carrying a
 * [caw:reply:…] / [caw:quote:…] marker line.
 */
export async function shortenUrlsInText(
  text: string,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  if (!LINK_SERVICE_URL || !text) return text;
  const urls = [...new Set(extractUrls(text))];
  // Would-be short form: base + '/' + code (codes start at 6).
  const shortBase = LINK_SERVICE_URL.length + 1 + 6;
  const candidates = urls.filter((u) => u.length > shortBase);
  if (candidates.length === 0) return text;
  const results = await Promise.all(
    candidates.map(async (u) => ({ u, short: await shortenOne(fetchFn, u) })),
  );
  let out = text;
  // Longest first, so a URL that is a prefix of another cannot
  // be rewritten inside the longer one.
  results
    .filter((r) => r.short !== null && (r.short as string).length < r.u.length)
    .sort((a, b) => b.u.length - a.u.length)
    .forEach(({ u, short }) => {
      out = out.split(u).join(short as string);
    });
  return out;
}

/* ---------------- previews ---------------- */

const previewCache = new Map<string, Promise<LinkPreview | null>>();

/**
 * The snippet data for a URL (the first URL of a post body),
 * or null when no preview is available — the UI then shows no
 * card. Results (including failures) are cached per session so
 * list rows do not refetch as they remount.
 */
export function fetchPreview(
  url: string,
  fetchFn: FetchFn = fetch,
): Promise<LinkPreview | null> {
  if (!LINK_SERVICE_URL || !url) return Promise.resolve(null);
  const hit = previewCache.get(url);
  if (hit) return hit;
  const p = (async (): Promise<LinkPreview | null> => {
    try {
      const res = await fetchWithTimeout(
        fetchFn,
        LINK_SERVICE_URL +
          '/api/preview?url=' +
          encodeURIComponent(url),
        {},
        10000,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as Partial<LinkPreview>;
      if (typeof data.url !== 'string') return null;
      return {
        url: data.url,
        title: typeof data.title === 'string' ? data.title : '',
        description:
          typeof data.description === 'string' ? data.description : '',
        image: typeof data.image === 'string' ? data.image : '',
        domain: typeof data.domain === 'string' ? data.domain : '',
      };
    } catch {
      return null;
    }
  })();
  previewCache.set(url, p);
  return p;
}
