/**
 * Jogi IoT Search Engine — Cloudflare Worker
 *
 * Does two jobs on one URL:
 *   POST /api (or any POST)  → proxies to NVIDIA NIM with CORS headers added
 *   GET  /                   → serves the static site (index.html) from assets
 *
 * Why: NVIDIA's API only returns CORS headers for its own origins, so browsers
 * block direct calls ("Failed to fetch"). This worker sits in the middle.
 * Free tier: 100,000 requests/day. Keys go browser → your worker → NVIDIA.
 */

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

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
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    // Browser preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Proxy: any POST goes to NVIDIA
    if (request.method === 'POST') {
      const upstream = await fetch(NVIDIA_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: request.headers.get('Authorization') || '',
        },
        body: await request.text(),
      });

      // Stream the body straight through — tokens reach the browser the
      // moment NVIDIA emits them, instead of waiting for the full answer
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
