// Jogi IoT Search Engine - Cloudflare Worker
// All API keys come from Cloudflare Secrets ONLY.
// Frontend sends requests to /api, worker injects keys server-side.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Proxy-Target"
};

// Map preset names to their API endpoints and default models
const ENDPOINTS = {
  nvidia: {
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    model: "meta/llama-3.3-70b-instruct"
  },
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile"
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-2.0-flash"
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "meta-llama/llama-3.3-70b-instruct:free"
  },
  mistral: {
    url: "https://api.mistral.ai/v1/chat/completions",
    model: "mistral-small-latest"
  },
  cerebras: {
    url: "https://api.cerebras.ai/v1/chat/completions",
    model: "llama-3.3-70b"
  },
  sambanova: {
    url: "https://api.sambanova.ai/v1/chat/completions",
    model: "Meta-Llama-3.3-70B-Instruct"
  },
  together: {
    url: "https://api.together.xyz/v1/chat/completions",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free"
  },
  github: {
    url: "https://models.github.ai/inference/chat/completions",
    model: "openai/gpt-4o-mini"
  },
  huggingface: {
    url: "https://router.huggingface.co/v1/chat/completions",
    model: "meta-llama/Llama-3.1-8B-Instruct"
  },
  cohere: {
    url: "https://api.cohere.ai/compatibility/v1/chat/completions",
    model: "command-r-plus"
  }
};

// In-memory cooldown tracking
const COOLDOWN_MS = 10 * 60 * 1000;
const cooldowns = new Map();

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}

// Detect provider from key prefix
function detectProvider(key) {
  if (key.startsWith("nvapi-")) return "nvidia";
  if (key.startsWith("gsk_")) return "groq";
  if (key.startsWith("AIza")) return "gemini";
  if (key.startsWith("sk-or-")) return "openrouter";
  if (key.startsWith("hf_")) return "huggingface";
  if (key.startsWith("ghp_")) return "github";
  if (key.startsWith("csk-")) return "cerebras";
  return null;
}

// Parse JOGI_KEYS secret. Supports:
// - Bare keys (one per line): nvapi-xxx
// - Pipe format: nvidia|nvapi-xxx|model-name
// - Comma-separated on same line
function parseKeys(raw) {
  const pool = [];
  if (!raw) return pool;

  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check if line has commas (multiple keys on one line)
    const parts = trimmed.split(",");
    for (const part of parts) {
      const keyPart = part.trim();
      if (!keyPart) continue;

      // Pipe format: provider|key|model
      if (keyPart.includes("|")) {
        const segments = keyPart.split("|");
        const provider = (segments[0] || "").trim().toLowerCase();
        const key = (segments[1] || "").trim();
        const model = (segments[2] || "").trim();
        if (!key) continue;

        const ep = ENDPOINTS[provider];
        if (ep) {
          pool.push({
            id: pool.length + 1,
            provider: provider,
            label: provider.toUpperCase(),
            key: key,
            model: model || ep.model,
            url: ep.url
          });
        }
        continue;
      }

      // Bare key - auto detect
      const detected = detectProvider(keyPart);
      if (detected) {
        const ep = ENDPOINTS[detected];
        pool.push({
          id: pool.length + 1,
          provider: detected,
          label: detected.toUpperCase(),
          key: keyPart,
          model: ep.model,
          url: ep.url
        });
      }
    }
  }

  return pool;
}

// Build full key pool from all secrets
function buildPool(env) {
  const pool = [];

  // Individual provider secrets
  const singles = [
    ["NVIDIA_KEY", "nvidia"],
    ["GROQ_KEY", "groq"],
    ["GEMINI_KEY", "gemini"],
    ["OPENROUTER_KEY", "openrouter"],
    ["MISTRAL_KEY", "mistral"],
    ["CEREBRAS_KEY", "cerebras"],
    ["SAMBANOVA_KEY", "sambanova"],
    ["TOGETHER_KEY", "together"],
    ["GITHUB_KEY", "github"],
    ["HUGGINGFACE_KEY", "huggingface"],
    ["COHERE_KEY", "cohere"]
  ];

  for (const [secretName, provider] of singles) {
    const val = env[secretName];
    if (val && typeof val === "string" && val.trim()) {
      const ep = ENDPOINTS[provider];
      pool.push({
        id: pool.length + 1,
        provider: provider,
        label: provider.toUpperCase(),
        key: val.trim(),
        model: ep.model,
        url: ep.url
      });
    }
  }

  // JOGI_KEYS secret
  const jogiPool = parseKeys(env.JOGI_KEYS);
  for (const entry of jogiPool) {
    entry.id = pool.length + 1;
    pool.push(entry);
  }

  return pool;
}

function isCooling(entry) {
  const until = cooldowns.get(entry.id);
  return until && Date.now() < until;
}

function setCooldown(entry) {
  cooldowns.set(entry.id, Date.now() + COOLDOWN_MS);
}

function setInvalid(entry) {
  cooldowns.set(entry.id, Date.now() + 24 * 60 * 60 * 1000);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS, status: 204 });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/keys" || path === "/keys") {
      return handleKeys(request, env);
    }
    if (path === "/api/gen" || path === "/gen") {
      return handleGen(request, env);
    }
    if (path === "/api" || path === "/api/chat/completions") {
      return handleChat(request, env);
    }

    return new Response("Not Found", { status: 404, headers: CORS });
  }
};

async function handleKeys(request, env) {
  const pool = buildPool(env);
  const masked = pool.map(e => ({
    provider: e.provider,
    label: e.label,
    model: e.model,
    url: e.url,
    key: e.key ? "..." + e.key.slice(-4) : ""
  }));
  return json({ keys: masked, count: pool.length });
}

async function handleChat(request, env) {
  const pool = buildPool(env);
  if (!pool.length) {
    return json({ error: "No API keys configured. Add JOGI_KEYS or individual secrets in Cloudflare dashboard." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const clientModel = body.model;
  let lastErr = null;

  for (const entry of pool) {
    if (isCooling(entry)) continue;

    const targetUrl = entry.url;
    const model = clientModel || entry.model;
    const payload = Object.assign({}, body, { model: model });

    try {
      const res = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + entry.key
        },
        body: JSON.stringify(payload)
      });

      if (res.status === 429) {
        setCooldown(entry);
        lastErr = entry.label + " rate limited (429)";
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        setInvalid(entry);
        lastErr = entry.label + " key rejected (" + res.status + ")";
        continue;
      }

      if (res.status >= 500) {
        lastErr = entry.label + " server error " + res.status;
        continue;
      }

      if (!res.ok) {
        lastErr = entry.label + " error " + res.status;
        continue;
      }

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: {
          ...CORS,
          "Content-Type": res.headers.get("Content-Type") || "text/event-stream",
          "X-Used-Provider": entry.label
        }
      });

    } catch (netErr) {
      lastErr = entry.label + " network error: " + netErr.message;
      continue;
    }
  }

  return json({
    error: lastErr || "All APIs exhausted. Wait for cooldown or add more keys.",
    detail: "Every key hit a quota, was rejected, or failed. Auto-recovery in 10 minutes."
  }, 503);
}

async function handleGen(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400);
  }

  const prompt = body.prompt;
  if (!prompt) return json({ error: "Prompt required" }, 400);

  const pool = buildPool(env);
  let nvidiaEntry = null;
  for (const e of pool) {
    if (e.provider === "nvidia") {
      nvidiaEntry = e;
      break;
    }
  }

  if (!nvidiaEntry) {
    return json({ error: "No NVIDIA key found for image generation." }, 400);
  }

  try {
    const res = await fetch("https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-xl", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + nvidiaEntry.key
      },
      body: JSON.stringify({
        prompt: prompt,
        negative_prompt: "",
        sampler: "K_EULER_ANCESTRAL",
        steps: 25,
        cfg_scale: 7.5,
        seed: Math.floor(Math.random() * 1000000),
        height: 512,
        width: 512
      })
    });

    if (!res.ok) {
      const text = await res.text();
      return json({ error: "Image gen failed: " + res.status + " " + text }, res.status);
    }

    const data = await res.json();
    const image = data.image || (data.images && data.images[0] && data.images[0].image) || (data.artifacts && data.artifacts[0] && data.artifacts[0].base64) || (data.data && data.data[0] && data.data[0].b64_json);

    if (!image) {
      return json({ error: "No image returned" }, 500);
    }

    return json({ image: image });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
