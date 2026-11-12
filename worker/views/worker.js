/**
 * CAW post view counter (v0.6.0) — a Cloudflare Worker + KV.
 *
 * Aggregates the post views the CAW Social app registers
 * from inside itself. Views are not on-chain; this service
 * is the whole of the counting, and the app says so in its
 * About section. It holds no keys and moves no funds: the
 * worst a broken or hostile counter can do is show a wrong
 * view number, which is why the app renders the element only
 * when an operator has deliberately configured the endpoint
 * (src/config.ts VIEWS_COUNTER_URL) and only with numbers
 * this service actually returned.
 *
 * Endpoints:
 *   POST /views      { ids: [cawId…] }
 *                    → { counts: { cawId: n } }
 *   POST /views/hit  { ids: [cawId…], deviceToken }
 *                    → { ok, counted: [cawId…], counts }
 *                    (at most one count per post per day per
 *                    device — see countsCore.js)
 *
 * Binding: VIEWS_KV (KV namespace). No secrets.
 * Deploy: see README.md in this directory.
 */
import { getCounts, registerHits } from './countsCore.js';

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return json({}, 204);
    }
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/views') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad json' }, 400);
      }
      return json(await getCounts(env.VIEWS_KV, body && body.ids));
    }
    if (request.method === 'POST' && url.pathname === '/views/hit') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad json' }, 400);
      }
      const r = await registerHits(env.VIEWS_KV, body, Date.now());
      if (r.error) return json({ error: r.error }, r.status || 400);
      return json(r);
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(
        'caw-views-counter: POST /views {ids} · POST /views/hit {ids, deviceToken}\n',
        { headers: { 'content-type': 'text/plain' } },
      );
    }
    return json({ error: 'not found' }, 404);
  },
};
