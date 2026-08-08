// Cloudflare Worker for Jogi IoT Search Engine
// Routes: /api (chat), /api/keys (server keys), /api/gen (image generation)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Proxy-Target',
};

const PRESETS = {
  nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
  sambanova: 'https://api.sambanova.ai/v1/chat/completions',
  together: 'https://api.together.xyz/v1/chat/completions',
  github: 'https://models.github.ai/inference/chat/completions',
  huggingface: 'https://router.huggingface.co/v1/chat/completions',
  hf: 'https://router.huggingface.co/v1/chat/completions',
  cohere: 'https://api.cohere.ai/compatibility/v1/chat/completions'
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS, status: 204 });
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

    return new Response('Not Found', { status: 404, headers: CORS });
  }
};

async function handleKeys(request, env) {
  const secret = env.JOGI_KEYS || '';
  const entries = secret.split(',').filter(Boolean).map(line => {
    const parts = line.split('|').map(s => s.trim());
    const preset = parts[0] || 'nvidia';
    const key = parts[1] || '';
    const model = parts[2] || '';
    const label = parts[3] || preset;
    return {
      preset,
      label,
      model,
      target: PRESETS[preset.toLowerCase()] || '',
      key: key ? '…' + key.slice(-4) : ''
    };
  });

  return jsonResponse({ keys: entries });
}

async function handleChat(request, env) {
  try {
    const body = await request.json();
    const target = request.headers.get('X-Proxy-Target');
    const auth = request.headers.get('Authorization') || '';

    let url = target || 'https://integrate.api.nvidia.com/v1/chat/completions';
    let apiKey = auth.replace('Bearer ', '');

    // Fallback to server-side key if no client key provided
    if (!apiKey) {
      const secret = env.JOGI_KEYS || '';
      const first = secret.split(',')[0];
      if (first) {
        const parts = first.split('|');
        if (parts.length >= 2) {
          apiKey = parts[1];
          if (!target) {
            url = PRESETS[parts[0].toLowerCase()] || url;
          }
        }
      }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey ? `Bearer ${apiKey}` : ''
      },
      body: JSON.stringify(body)
    });

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: {
        ...CORS,
        'Content-Type': res.headers.get('Content-Type') || 'text/event-stream',
      }
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handleGen(request, env) {
  try {
    const { prompt } = await request.json();
    if (!prompt) return jsonResponse({ error: 'Prompt required' }, 400);

    // NVIDIA image generation endpoint (Stable Diffusion XL)
    const url = 'https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-xl';

    let apiKey = env.NVIDIA_KEY || '';
    if (!apiKey) {
      const secret = env.JOGI_KEYS || '';
      const nvidiaEntry = secret.split(',').find(k => k.toLowerCase().startsWith('nvidia|'));
      if (nvidiaEntry) apiKey = nvidiaEntry.split('|')[1] || '';
    }

    if (!apiKey) {
      return jsonResponse({ error: 'No NVIDIA key configured for image generation' }, 400);
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}
