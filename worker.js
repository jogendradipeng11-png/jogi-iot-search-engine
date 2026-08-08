/**
 * Jogi IoT Search Engine — Cloudflare Worker
 * GET  /api/keys → masked list of permanent server-side keys (app boot)
 * POST /api      → proxies to an AI provider (streaming + CORS)
 * GET  /         → serves the static site from assets
 *
 * ⭐ PERMANENT KEYS (works anywhere, saved once):
 *   Dashboard → Workers → jogi-iot-search-engine → Settings →
 *   Variables and Secrets → Add variable:  JOGI_KEYS
 *   One per line:  preset | key | model?   e.g.
 *     groq | gsk_xxxxx
 *     gemini | AIza_xxxxx
 *     nvidia | nvapi_xxxxx | meta/llama-3.3-70b-instruct
 *     https://api.mistral.ai/v1/chat/completions | xxxxx | mistral-small-latest
 *   The app then works on ANY device with ZERO key entry — keys stay
 *   server-side (encrypted), invisible to visitors. Client keys also still
 *   work: if the app sends its own Authorization header it is used as-is.
 */

const DEFAULT_UPSTREAM = 'https://integrate.api.nvidia.com/v1/chat/completions';

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
  'api.cloudflare.com',
]);

const ALLOWED_ORIGINS = []; // empty = allow any origin (fine for personal use)

const PRESETS = {
  nvidia:      { label: 'NVIDIA',      base: '',                                                                model: '' },
  groq:        { label: 'Groq',        base: 'https://api.groq.com/openai/v1/chat/completions',                  model: 'llama-3.3-70b-versatile' },
  gemini:      { label: 'Gemini',      base: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.0-flash' },
  openrouter:  { label: 'OpenRouter',  base: 'https://openrouter.ai/api/v1/chat/completions',                    model: 'meta-llama/llama-3.3-70b-instruct:free' },
  mistral:     { label: 'Mistral',     base: 'https://api.mistral.ai/v1/chat/completions',                       model: 'mistral-small-latest' },
  cerebras:    { label: 'Cerebras',    base: 'https://api.cerebras.ai/v1/chat/completions',                      model: 'llama-3.3-70b' },
  sambanova:   { label: 'SambaNova',   base: 'https://api.sambanova.ai/v1/chat/completions',                     model: 'Meta-Llama-3.3-70B-Instruct' },
  together:    { label: 'Together',    base: 'https://api.together.xyz/v1/chat/completions',                     model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free' },
  github:      { label: 'GitHub',      base: 'https://models.github.ai/inference/chat/completions',              model: 'openai/gpt-4o-mini' },
  huggingface: { label: 'HuggingFace', base: 'https://router.huggingface.co/v1/chat/completions',                model: 'meta-llama/Llama-3.1-8B-Instruct' },
  hf:          { label: 'HuggingFace', base: 'https://router.huggingface.co/v1/chat/completions',                model: 'meta-llama/Llama-3.1-8B-Instruct' },
  cohere:      { label: 'Cohere',      base: 'https://api.cohere.ai/compatibility/v1/chat/completions',          model: 'command-r-plus' },
};

function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return ''; } }

function detectPreset(k) {
  if (/^nvapi-/.test(k)) return 'nvidia';
  if (/^gsk_/.test(k)) return 'groq';
  if (/^AIza/.test(k)) return 'gemini';
  if (/^sk-or-/.test(k)) return 'openrouter';
  if (/^hf_/.test(k)) return 'huggingface';
  if (/^ghp_/.test(k)) return 'github';
  if (/^csk-/.test(k)) return 'cerebras';
  return null;
}

function parseServerKeys(env) {
  const out = [];
  const raw = (env && env.JOGI_KEYS) || '';
  if (!raw.trim()) return out;
  for (const line of raw.split(/[\n;,]+/)) { // tolerate dashboard line-squishing
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split('|').map(s => s.trim());
    const first = (parts[0] || '').toLowerCase();
    let preset = null, label = '', key = '', model = parts[2] || '', target = null;

    if (parts.length >= 2 && PRESETS[first]) {
      preset = first; label = PRESETS[first].label; key = parts[1];
      if (!model) model = PRESETS[first].model;
      target = PRESETS[first].base || null;
    } else if (/^https?:\/\//i.test(parts[0]) && parts[1]) {
      preset = 'custom'; label = 'Custom'; key = parts[1]; target = parts[0];
    } else {
      // Bare key line (no pipes) — detect the provider from the key prefix
      const g = detectPreset(t);
      if (g) { preset = g; label = PRESETS[g].label; key = t; model = PRESETS[g].model; target = PRESETS[g].base || null; }
    }
    if (!key) continue;
    out.push({ preset, label, key, model, target });
  }
  return out;
}

const serverRotate = {}; // per-provider round-robin index

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    const allowed = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin) || origin === 'null';

    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : 'https://invalid',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Proxy-Target',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    const json = (obj, status) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const serverKeys = parseServerKeys(env);

    // App boot: masked list of permanent server keys
    if (request.method === 'GET' && url.pathname.endsWith('/keys')) {
      const list = serverKeys.map(k => ({
        preset: k.preset,
        label: k.label,
        model: k.model,
        target: k.target,
        key: k.key.length > 8 ? '••••' + k.key.slice(-4) : '••••',
      }));
      return json({ keys: list });
    }

    if (request.method === 'POST') {
      let upstreamUrl = DEFAULT_UPSTREAM;
      const clientTarget = request.headers.get('X-Proxy-Target');

      if (clientTarget) {
        const h = hostOf(clientTarget);
        if (!h || !ALLOWED_HOSTS.has(h)) {
          return json({ error: { message: `Host not allowed: ${h}. Add it to ALLOWED_HOSTS in worker.js` } }, 400);
        }
        upstreamUrl = clientTarget;
      }

      let auth = request.headers.get('Authorization') || '';

      // No client key → use a permanent server key for this provider
      if (!auth && serverKeys.length) {
        const host = hostOf(upstreamUrl);
        const candidates = serverKeys.filter(k => hostOf(k.target || DEFAULT_UPSTREAM) === host);
        if (candidates.length) {
          const i = (serverRotate[host] = ((serverRotate[host] ?? -1) + 1) % candidates.length);
          const chosen = candidates[i];
          auth = 'Bearer ' + chosen.key;
          if (chosen.target && !clientTarget) upstreamUrl = chosen.target;
        }
      }

      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: await request.text(),
      });

      // Stream the body straight through — tokens reach the browser as emitted
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          ...cors,
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
          'Cache-Control': 'no-cache',
        },
      });
    }

    if (env && env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Jogi IoT proxy: POST only', { status: 405, headers: cors });
  },
};
