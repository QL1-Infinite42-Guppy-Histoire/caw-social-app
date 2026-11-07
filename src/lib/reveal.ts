/**
 * Secret reveal ceremony (v0.3.1) — MetaMask's flow, faithfully:
 *
 *   phrase: intro -> 2-question quiz -> app password -> reveal
 *   key:    app password -> reveal
 *
 * The app password is the ONLY gate (biometrics alone never
 * reveals). Users who unlock with biometrics have no password
 * verifier; the flow makes them set one first (see the screen).
 *
 * This module is Expo-free so the node harness can test the quiz
 * logic, the decoys, and the gate structure. Secrets pass through
 * `gatedReveal` only: the loader is never invoked before the
 * password check succeeds.
 */

export const REVEAL_AUTO_HIDE_MS = 60000;

/* ---------------- quiz ---------------- */

/** Correct option index per question (texts live in i18n). */
export const QUIZ_CORRECT: readonly number[] = [1, 0];
export const QUIZ_COUNT = QUIZ_CORRECT.length;

export function quizAnswerCorrect(qIdx: number, choice: number): boolean {
  return QUIZ_CORRECT[qIdx] === choice;
}

export type QuizPhase = 'asking' | 'feedback' | 'done';

export interface QuizState {
  qIdx: number;
  phase: QuizPhase;
  wrong: boolean;
}

export const quizInitial: QuizState = { qIdx: 0, phase: 'asking', wrong: false };

/** Pure quiz reducer: wrong answer keeps the question (error
 *  state, retry); correct answer moves to the feedback panel;
 *  Continue advances to the next question / done. */
export function quizReduce(
  s: QuizState,
  ev: { type: 'answer'; choice: number } | { type: 'next' },
): QuizState {
  if (ev.type === 'answer') {
    if (s.phase !== 'asking') return s;
    if (quizAnswerCorrect(s.qIdx, ev.choice)) {
      return { ...s, phase: 'feedback', wrong: false };
    }
    return { ...s, wrong: true };
  }
  if (s.phase !== 'feedback') return s;
  if (s.qIdx + 1 >= QUIZ_COUNT) return { ...s, phase: 'done' };
  return { qIdx: s.qIdx + 1, phase: 'asking', wrong: false };
}

/* ---------------- decoys ---------------- */

/**
 * Decoy words shown under the mosaic before the reveal. They are
 * ordinary words that must NEVER equal a real phrase word — the
 * real words are filtered out of the pool first. (The pool is not
 * the BIP39 list; resemblance is fine, equality is not.)
 */
export const DECOY_POOL: readonly string[] = [
  'window', 'coffee', 'garden', 'pencil', 'market', 'silver',
  'button', 'travel', 'kitchen', 'orange', 'purple', 'winter',
  'summer', 'meadow', 'harbor', 'candle', 'mirror', 'basket',
  'cloudy', 'sunny', 'river', 'stone', 'paper', 'music',
  'dance', 'happy', 'gentle', 'bright', 'calm', 'swift',
  'golden', 'velvet', 'copper', 'marble', 'willow', 'falcon',
  'sunset', 'saffron', 'breeze', 'coral', 'ivory', 'jasmine',
  'lagoon', 'magnet', 'nectar', 'onyx', 'pepper', 'quartz',
];

export function makeDecoyWords(
  realWords: string[],
  count: number,
  rand: () => number = Math.random,
): string[] {
  const real = new Set(realWords.map((w) => w.toLowerCase()));
  const pool = DECOY_POOL.filter((w) => !real.has(w.toLowerCase()));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(pool[Math.floor(rand() * pool.length) % pool.length]);
  }
  return out;
}

/** Fake hex for the private-key mosaic (never the real key). */
export function makeDecoyKey(
  realKey: string,
  rand: () => number = Math.random,
): string {
  const hex = '0123456789abcdef';
  let out = '0x';
  for (let i = 0; i < 64; i++) {
    out += hex[Math.floor(rand() * 16) % 16];
  }
  if (out.toLowerCase() === realKey.toLowerCase()) {
    out = out.slice(0, -1) + (out.endsWith('0') ? '1' : '0');
  }
  return out;
}

/* ---------------- the gate ---------------- */

/**
 * The ONLY path from password to secret: verify first, load
 * second. When verification fails the loader is never called, so
 * no secret material is even read from storage.
 */
export async function gatedReveal<T>(
  verify: () => Promise<boolean>,
  load: () => Promise<T | null>,
): Promise<T | null> {
  const ok = await verify();
  if (!ok) return null;
  return load();
}
