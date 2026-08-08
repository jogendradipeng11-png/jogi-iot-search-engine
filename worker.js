// Jogi IoT Search Engine — Cloudflare Worker
// ALL keys come from Cloudflare Secrets (JOGI_KEYS + individual provider keys)
// Frontend sends NO Authorization header — worker injects it server-side.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Proxy-Target',
};

const PRESETS = {
  nvidia:      { name: 'NVIDIA',      url: 'https://integrate.api.nvidia.com/v1/chat/completions',           model: 'meta/llama-3.3-70b-instruct' },
  groq:        { name: 'Groq',        url: 'https://api.groq.com/openai/v1/chat/completions',               model: 'llama-3.3-70b-versatile' },
  gemini:      { name: 'Gemini',      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.0-flash' },
  openrouter:  { name: 'OpenRouter',  url: 'https://openrouter.ai/api/v1/chat/completions',                 model: 'meta-llama/llama-3.3-70b-instruct:free' },
  mistral:     { name: 'Mistral',     url: 'https://api.mistral.ai/v1/chat/completions',                    model: 'mistral-small-latest' },
  cerebras:    { name: 'Cerebras',    url: 'https://api.cerebras.ai/v1/chat/completions',                   model: 'llama-3.3-70b' },
  sambanova:   { name: 'SambaNova',   url: 'https://api.sambanova.ai/v1/chat/completions',                  model: 'Meta-Llama-3.3-70B-Instruct' },
  together:    { name: 'Together',    url: 'https://api.together.xyz/v1/chat/completions',                  model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free' },
  github:      { name: 'GitHub',      url: 'https://models.github.ai/inference/chat/completions',           model: 'openai/gpt-4o-mini' },
  huggingface: { name: 'HuggingFace', url: 'https://router.huggingface.co/v1/chat/completions',             model: 'meta-llama/Llama-3.1-8B-Instruct' },
  hf:          { name: 'HuggingFace', url: 'https://router.huggingface.co/v1/chat/completions',             model: 'meta-llama/Llama-3.1-8B-Instruct' },
  cohere:      { name: 'Cohere',      url: 'https://api.cohere.ai/compatibility/v1/chat/completions',       model: 'command-r-plus' }
};

// In-memory cooldown tracking (persists within worker instance)
const cooldowns = new Map();
const COOLDOWN_MS = 10 * 60 * 1000;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

function detectPreset(key) {
  if (/^nvapi-/.test(key)) return 'nvidia';
  if (/^gsk_/.test(key)) return 'groq';
  if (/^AIza/.test(key)) return 'gemini';
  if (/^sk-or-/.test(key)) return 'openrouter';
  if (/^hf_/.test(key)) return 'huggingface';
  if (/^ghp_/.test(key)) return 'github';
  if (/^csk-/.test(key)) return 'cerebras';
  return null;
}

function parseJogiKeys(raw) {
  const pool = [];
  if (!raw) return pool;

  // Split by comma OR newline
  const entries = raw.split(/[,
]+/).map(s => s.trim()).filter(Boolean);

  for (const entry of entries) {
    // Format: preset|key|model  (pipe-separated)
    if (entry.includes('|')) {
      const parts = entry.split('|').map(s => s.trim());
      const presetKey = (parts[0] || '').toLowerCase();
      const key = parts[1] || '';
      const model = parts[2] || '';
      if (!key) continue;

      const p = PRESETS[presetKey];
      if (p) {
        pool.push({ id: pool.length + 1, label: p.name, preset: presetKey, key, model: model || p.model, url: p.url });
      } else if (presetKey.startsWith('http')) {
        pool.push({ id: pool.length + 1, label: 'Custom', preset: 'custom', key, model: model || 'meta/llama-3.3-70b-instruct', url: presetKey });
      }
      continue;
    }

    // Bare key — auto-detect provider from prefix
    const detected = detectPreset(entry);
    if (detected) {
      const p = PRESETS[detected];
      pool.push({ id: pool.length + 1, label: p.name, preset: detected, key: entry, model: p.model, url: p.url });
    }
  }

  return pool;
}

function buildKeyPool(env) {
  const pool = [];

  // 1) Individual provider secrets
  const INDIVIDUAL = [
    ['NVIDIA_KEY', 'nvidia'],
    ['GROQ_KEY', 'groq'],
    ['GEMINI_KEY', 'gemini'],
    ['OPENROUTER_KEY', 'openrouter'],
    ['MISTRAL_KEY', 'mistral'],
    ['CEREBRAS_KEY', 'cerebras'],
    ['SAMBANOVA_KEY', 'sambanova'],
    ['TOGETHER_KEY', 'together'],
    ['GITHUB_KEY', 'github'],
    ['HUGGINGFACE_KEY', 'huggingface'],
    ['COHERE_KEY', 'cohere']
  ];

  for (const [secretName, preset] of INDIVIDUAL) {
    const key = env[secretName];
    if (key && key.trim()) {
      const p = PRESETS[preset];
      pool.push({ id: pool.length + 1, label: p.name, preset, key: key.trim(), model: p.model, url: p.url });
    }
  }

  // 2) JOGI_KEYS secret — supports comma-separated, newline-separated, bare keys, pipe-format
  const jogiPool = parseJogiKeys(env.JOGI_KEYS);
  for (const e of jogiPool) {
    e.id = pool.length + 1;
    pool.push(e);
  }

  return pool;
}

function isOnCooldown(entry) {
  const until = cooldowns.get(entry.id);
  return until && Date.now() < until;
}

function markCooldown(entry) {
  cooldowns.set(entry.id, Date.now() + COOLDOWN_MS);
}

function markInvalid(entry) {
  cooldowns.set(entry.id, Date.now() + 24 * 60 * 60 * 1000); // 24h
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS, status: 204 });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/keys' || path === '/keys') {
      return handleKeys(request, env);
    }
    if (path === '/api/gen' || path === '/gen') {
      return handleGen(request, env);
    }
    if (path === '/api' || path === '/api/chat/completions') {
      return handleChat(request, env);
    }

    if (path === '/' || path === '/index.html') {
      return new Response('OK', { headers: CORS_HEADERS });
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  }
};

async function handleKeys(request, env) {
  const pool = buildKeyPool(env);
  const masked = pool.map(e => ({
    preset: e.preset,
    label: e.label,
    model: e.model,
    target: e.url,
    key: e.key ? '…' + e.key.slice(-4) : ''
  }));
  return jsonResponse({ keys: masked, count: pool.length });
}

async function handleChat(request, env) {
  const pool = buildKeyPool(env);
  if (!pool.length) {
    return jsonResponse({ error: 'No API keys configured in worker secrets. Add JOGI_KEYS or individual provider secrets in Cloudflare dashboard.' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const clientModel = body.model;
  let lastErr = null;

  for (const entry of pool) {
    if (isOnCooldown(entry)) continue;

    const targetUrl = entry.url;
    const model = clientModel || entry.model;

    const payload = { ...body, model };

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${entry.key}`
        },
        body: JSON.stringify(payload)
      });

      if (res.status === 429) {
        markCooldown(entry);
        lastErr = new Error(`${entry.label} rate limited (429)`);
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        markInvalid(entry);
        lastErr = new Error(`${entry.label} key rejected (${res.status})`);
        continue;
      }

      if (res.status >= 500) {
        lastErr = new Error(`${entry.label} server error ${res.status}`);
        continue;
      }

      if (!res.ok) {
        lastErr = new Error(`${entry.label} error ${res.status}`);
        continue;
      }

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': res.headers.get('Content-Type') || 'text/event-stream',
          'X-Used-Provider': entry.label
        }
      });

    } catch (netErr) {
      lastErr = new Error(`${entry.label} network error: ${netErr.message}`);
      continue;
    }
  }

  return jsonResponse({
    error: lastErr ? lastErr.message : 'All APIs exhausted. Wait for cooldown or add more keys in worker secrets.',
    detail: 'Every configured key hit a quota, was rejected, or failed. Keys auto-recover after 10 minutes.'
  }, 503);
}

async function handleGen(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const prompt = body.prompt;
  if (!prompt) return jsonResponse({ error: 'Prompt required' }, 400);

  const pool = buildKeyPool(env);
  const nvidiaEntry = pool.find(e => e.preset === 'nvidia');

  if (!nvidiaEntry) {
    return jsonResponse({ error: 'No NVIDIA key found in worker secrets for image generation.' }, 400);
  }

  try {
    const res = await fetch('https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-xl', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${nvidiaEntry.key}`
      },
      body: JSON.stringify({
        prompt,
        negative_prompt: '',
        sampler: 'K_EULER_ANCESTRAL',
        steps: 25,
        cfg_scale: 7.5,
        seed: Math.floor(Math.random() * 1000000),
        height: 512,
        width: 512
      })
    });

    if (!res.ok) {
      const text = await res.text();
      return jsonResponse({ error: `Image generation failed: ${res.status} ${text}` }, res.status);
    }

    const data = await res.json();
    const image = data.image || data.images?.[0]?.image || data.artifacts?.[0]?.base64 || data.data?.[0]?.b64_json;

    if (!image) {
      return jsonResponse({ error: 'No image returned from API' }, 500);
    }

    return jsonResponse({ image });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}
