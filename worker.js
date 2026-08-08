/**
 * Jogi IoT Search Engine — Cloudflare Worker
 *
 * Does two jobs on one URL:
 *   POST /api (or any POST)  → proxies to an AI provider with CORS headers added
 *   GET  /                   → serves the static site (index.html) from assets
 *
 * Routing: by default requests go to NVIDIA NIM. The app can send an
 * X-Proxy-Target header with another provider's URL — only whitelisted hosts
 * are allowed, so the worker can't be abused as an open proxy.
 *
 * Free tier: 100,000 requests/day. Keys go browser → your worker → provider.
 */

const DEFAULT_UPSTREAM = 'https://integrate.api.nvidia.com/v1/chat/completions';

// Hosts the pool is allowed to call through this proxy
const ALLOWED_HOSTS = new Set([
  'integrate.api.nvidia.com',
  'api.groq.com',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
  'api.mistral.ai',
  'api.cerebras.ai',
  'api.sambanova.ai',
  'api.together.xyz',
  'models.github.ai',
  'router.huggingface.co',
  'api.cohere.ai',
]);

// Optional: lock the proxy to only serve YOUR site, e.g.
// const ALLOWED_ORIGINS = ['https://jogi-iot-search-engine.jogendra-dipeng11.workers.dev'];
const ALLOWED_ORIGINS = []; // empty = allow any origin (fine for personal use)

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    const allowed =
      ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin) || origin === 'null';

    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : 'https://invalid',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Proxy-Target',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    const json = (obj, status) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });

    // Browser preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Proxy: any POST goes to the chosen provider
    if (request.method === 'POST') {
      let upstreamUrl = DEFAULT_UPSTREAM;

      const target = request.headers.get('X-Proxy-Target');
      if (target) {
        let u;
        try {
          u = new URL(target);
        } catch (e) {
          return json({ error: { message: 'Invalid X-Proxy-Target URL' } }, 400);
        }
        if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
          return json({ error: { message: `Host not allowed: ${u.hostname}. Add it to ALLOWED_HOSTS in worker.js` } }, 400);
        }
        upstreamUrl = target;
      }

      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: request.headers.get('Authorization') || '',
        },
        body: await request.text(),
      });

      // Stream the body straight through — tokens reach the browser the
      // moment the provider emits them, instead of waiting for the full answer
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          ...cors,
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // Everything else (GET/HEAD): serve the static site if assets are bound
    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Jogi IoT proxy: POST only', { status: 405, headers: cors });
  },
};
