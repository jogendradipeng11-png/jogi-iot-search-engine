/**
 * Jogi IoT Search Engine — CORS proxy for NVIDIA NIM
 *
 * Why this exists: NVIDIA's API only returns CORS headers for its own origins
 * (build.nvidia.com). Browsers block calls from GitHub Pages / localhost with
 * "Failed to fetch". This free Cloudflare Worker forwards the request and adds
 * the headers your browser needs.
 *
 * Deploy (no CLI, ~2 min):
 *   1. https://workers.cloudflare.com → sign up free → Create Worker → Deploy
 *   2. "Edit code" → replace everything with this file → Deploy
 *   3. Copy your https://<name>.<subdomain>.workers.dev URL
 *   4. Paste it into the app's "Proxy URL" setting in the sidebar
 *
 * Free tier: 100,000 requests/day — effectively unlimited for personal use.
 * Your API keys travel browser → your worker → NVIDIA. Nobody else sees them.
 */

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

// Optional: lock the worker to only serve YOUR site (recommended once live).
// Add your GitHub Pages origin, e.g. 'https://yourname.github.io'
const ALLOWED_ORIGINS = []; // empty = allow any origin (fine for personal use)

export default {
  async fetch(request) {
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

    if (request.method !== 'POST') {
      return new Response('Jogi IoT proxy: POST only', { status: 405, headers: cors });
    }

    const upstream = await fetch(NVIDIA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: request.headers.get('Authorization') || '',
      },
      body: await request.text(),
    });

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      },
    });
  },
};
