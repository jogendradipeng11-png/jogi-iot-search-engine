export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Parse JOGI_KEYS - split by newline, no regex
    const raw = (env.JOGI_KEYS || "").replace(/\r/g, "");
    const keys = [];
    const lines = raw.split("\n");
    for (const line of lines) {
      const key = line.trim();
      if (key && key.startsWith("nvapi-")) {
        keys.push(key);
      }
    }

    // GET /api/keys - show masked keys
    if (path === "/api/keys" || path === "/keys") {
      const masked = keys.map(k => "..." + k.slice(-4));
      return new Response(JSON.stringify({ count: keys.length, keys: masked }), {
        headers: { "Content-Type": "application/json", ...cors }
      });
    }

    // POST /api - chat
    if (path === "/api" || path === "/api/chat/completions") {
      if (!keys.length) {
        return new Response(JSON.stringify({ error: "No JOGI_KEYS set" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...cors }
        });
      }

      const body = await request.json();

      const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + keys[0]
        },
        body: JSON.stringify({
          model: "meta/llama-3.3-70b-instruct",
          messages: body.messages,
          temperature: 0.2,
          max_tokens: 2048,
          stream: true
        })
      });

      return new Response(res.body, {
        status: res.status,
        headers: {
          ...cors,
          "Content-Type": "text/event-stream"
        }
      });
    }

    // POST /api/gen - image generation
    if (path === "/api/gen" || path === "/gen") {
      const body = await request.json();
      const prompt = (body.prompt || "").trim();
      if (!prompt) {
        return new Response(JSON.stringify({ error: "Empty prompt" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...cors }
        });
      }

      const nvKeys = keys.filter(k => k.startsWith("nvapi-"));
      if (!nvKeys.length) {
        return new Response(JSON.stringify({ error: "No NVIDIA key" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...cors }
        });
      }

      const res = await fetch("https://ai.api.nvidia.com/v1/genai/stabilityai/sdxl-turbo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + nvKeys[0]
        },
        body: JSON.stringify({
          text_prompts: [{ text: prompt, weight: 1 }],
          height: 512,
          width: 512,
          seed: 0,
          steps: 4,
          cfg_scale: 2,
          sampler: "K_EULER_ANCESTRAL"
        })
      });

      const data = await res.json().catch(() => ({}));
      const b64 = data.artifacts && data.artifacts[0] && data.artifacts[0].base64;

      if (!b64) {
        return new Response(JSON.stringify({ error: "Image gen failed" }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...cors }
        });
      }

      return new Response(JSON.stringify({ image: b64 }), {
        headers: { "Content-Type": "application/json", ...cors }
      });
    }

    return new Response("Jogi IoT Worker OK", { headers: cors });
  }
};
