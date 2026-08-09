// Jogi IoT Search Engine - Cloudflare Worker
// All keys from Cloudflare Secrets. No client keys needed.

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

const cooldowns = new Map();
const COOLDOWN_MS = 10 * 60 * 1000;

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

function detectPreset(key) {
  if (key.indexOf('nvapi-') === 0) return 'nvidia';
  if (key.indexOf('gsk_') === 0) return 'groq';
  if (key.indexOf('AIza') === 0) return 'gemini';
  if (key.indexOf('sk-or-') === 0) return 'openrouter';
  if (key.indexOf('hf_') === 0) return 'huggingface';
  if (key.indexOf('ghp_') === 0) return 'github';
  if (key.indexOf('csk-') === 0) return 'cerebras';
  return null;
}

function splitKeys(raw) {
  const result = [];
  if (!raw) return result;
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j].trim();
      if (part) result.push(part);
    }
  }
  return result;
}

function parseJogiKeys(raw) {
  const pool = [];
  const entries = splitKeys(raw);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.indexOf('|') !== -1) {
      const parts = entry.split('|');
      const presetKey = (parts[0] || '').toLowerCase().trim();
      const key = (parts[1] || '').trim();
      const model = (parts[2] || '').trim();
      if (!key) continue;
      const p = PRESETS[presetKey];
      if (p) {
        pool.push({ id: pool.length + 1, label: p.name, preset: presetKey, key: key, model: model || p.model, url: p.url });
      } else if (presetKey.indexOf('http') === 0) {
        pool.push({ id: pool.length + 1, label: 'Custom', preset: 'custom', key: key, model: model || 'meta/llama-3.3-70b-instruct', url: presetKey });
      }
      continue;
    }
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
  const INDIVIDUAL = [
    ['NVIDIA_KEY', 'nvidia'], ['GROQ_KEY', 'groq'], ['GEMINI_KEY', 'gemini'],
    ['OPENROUTER_KEY', 'openrouter'], ['MISTRAL_KEY', 'mistral'], ['CEREBRAS_KEY', 'cerebras'],
    ['SAMBANOVA_KEY', 'sambanova'], ['TOGETHER_KEY', 'together'], ['GITHUB_KEY', 'github'],
    ['HUGGINGFACE_KEY', 'huggingface'], ['COHERE_KEY', 'cohere']
  ];
  for (let i = 0; i < INDIVIDUAL.length; i++) {
    const secretName = INDIVIDUAL[i][0];
    const preset = INDIVIDUAL[i][1];
    const key = env[secretName];
    if (key && key.trim && key.trim()) {
      const p = PRESETS[preset];
      pool.push({ id: pool.length + 1, label: p.name, preset: preset, key: key.trim(), model: p.model, url: p.url });
    }
  }
  const jogiPool = parseJogiKeys(env.JOGI_KEYS);
  for (let i = 0; i < jogiPool.length; i++) {
    jogiPool[i].id = pool.length + 1;
    pool.push(jogiPool[i]);
  }
  return pool;
}

function isOnCooldown(entry) {
  const until = cooldowns.get(entry.id);
  return until && Date.now() < until;
}

function markCooldown(entry) { cooldowns.set(entry.id, Date.now() + COOLDOWN_MS); }
function markInvalid(entry) { cooldowns.set(entry.id, Date.now() + 24 * 60 * 60 * 1000); }

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS, status: 204 });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/api/keys' || path === '/keys') return handleKeys(request, env);
    if (path === '/api/gen' || path === '/gen') return handleGen(request, env);
    if (path === '/api' || path === '/api/chat/completions') return handleChat(request, env);
    if (path === '/' || path === '/index.html') return new Response('OK', { headers: CORS_HEADERS });
    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  }
};

async function handleKeys(request, env) {
  const pool = buildKeyPool(env);
  const masked = [];
  for (let i = 0; i < pool.length; i++) {
    const e = pool[i];
    masked.push({
      preset: e.preset,
      label: e.label,
      model: e.model,
      target: e.url,
      key: e.key ? '...' + e.key.slice(-4) : ''
    });
  }
  return jsonResponse({ keys: masked, count: pool.length });
}

async function handleChat(request, env) {
  const pool = buildKeyPool(env);
  if (!pool.length) {
    return jsonResponse({ error: 'No API keys configured in worker secrets.' }, 500);
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const clientModel = body.model;
  let lastErr = null;
  for (let i = 0; i < pool.length; i++) {
    const entry = pool[i];
    if (isOnCooldown(entry)) continue;
    const targetUrl = entry.url;
    const model = clientModel || entry.model;
    const payload = Object.assign({}, body, { model: model });
    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + entry.key
        },
        body: JSON.stringify(payload)
      });
      if (res.status === 429) {
        markCooldown(entry);
        lastErr = entry.label + ' rate limited';
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        markInvalid(entry);
        lastErr = entry.label + ' key rejected';
        continue;
      }
      if (res.status >= 500) {
        lastErr = entry.label + ' server error ' + res.status;
        continue;
      }
      if (!res.ok) {
        lastErr = entry.label + ' error ' + res.status;
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
      lastErr = entry.label + ' network error';
      continue;
    }
  }
  return jsonResponse({
    error: lastErr || 'All APIs exhausted. Wait for cooldown or add more keys.'
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
  let nvidiaEntry = null;
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].preset === 'nvidia') {
      nvidiaEntry = pool[i];
      break;
    }
  }
  if (!nvidiaEntry) {
    return jsonResponse({ error: 'No NVIDIA key found for image generation.' }, 400);
  }
  try {
    const res = await fetch('https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-xl', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + nvidiaEntry.key
      },
      body: JSON.stringify({
        prompt: prompt,
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
      return jsonResponse({ error: 'Image generation failed: ' + res.status }, res.status);
    }
    const data = await res.json();
    const image = data.image || (data.images && data.images[0] && data.images[0].image) || (data.artifacts && data.artifacts[0] && data.artifacts[0].base64) || (data.data && data.data[0] && data.data[0].b64_json);
    if (!image) {
      return jsonResponse({ error: 'No image returned from API' }, 500);
    }
    return jsonResponse({ image: image });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}
