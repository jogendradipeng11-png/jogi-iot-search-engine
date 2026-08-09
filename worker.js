export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Jogi-Key",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === "GET") {
      return new Response("Jogi IoT Search Engine Worker Active & Rotating", {
        status: 200,
        headers: { "Content-Type": "text/plain", ...corsHeaders }
      });
    }

    if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
      try {
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return new Response(JSON.stringify({ error: "Invalid JSON request body" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        let keysString = env.JOGI_KEYS || "";
        let keyPool = keysString.split(/[\n,;]+/).map(k => k.trim()).filter(Boolean);

        if (keyPool.length === 0) {
          return new Response(JSON.stringify({ error: "No API keys found in worker secret JOGI_KEYS." }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        let upstreamRes = null;
        let lastError = null;

        for (let i = 0; i < keyPool.length; i++) {
          const rawKeyEntry = keyPool[i];
          let parts = rawKeyEntry.split('|').map(s => s.trim());
          let apiKey = parts.length > 1 ? parts[1] : parts[0];
          let providerHint = parts.length > 1 ? parts[0].toLowerCase() : '';

          let targetUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
          if (providerHint === 'groq' || apiKey.startsWith("gsk_")) {
            targetUrl = "https://api.groq.com/openai/v1/chat/completions";
          } else if (providerHint === 'gemini' || apiKey.startsWith("AIza")) {
            targetUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
          } else if (providerHint === 'openrouter' || apiKey.startsWith("sk-or-")) {
            targetUrl = "https://openrouter.ai/api/v1/chat/completions";
          } else if (providerHint === 'cerebras' || apiKey.startsWith("csk-")) {
            targetUrl = "https://api.cerebras.ai/v1/chat/completions";
          } else if (apiKey.startsWith("nvapi-")) {
            targetUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
          }

          try {
            upstreamRes = await fetch(targetUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
              },
              body: JSON.stringify(body)
            });
          } catch (fetchErr) {
            lastError = fetchErr.message;
            continue;
          }

          if (upstreamRes.ok) {
            return new Response(upstreamRes.body, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                ...corsHeaders
              }
            });
          }

          if (upstreamRes.status === 429 || upstreamRes.status === 401 || upstreamRes.status === 403) {
            lastError = `Key limited/invalid (${upstreamRes.status}), rotating...`;
            continue;
          } else {
            const errText = await upstreamRes.text();
            lastError = `Upstream error ${upstreamRes.status}: ${errText}`;
            continue;
          }
        }

        return new Response(JSON.stringify({ error: "All worker secret keys exhausted. " + lastError }), {
          status: 429,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: "Worker Internal Error: " + err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }
};
