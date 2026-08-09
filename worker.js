export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Jogi-Key",
        },
      });
    }

    if (request.method === "POST" && (url.pathname === "/api" || url.pathname === "/api/search")) {
      try {
        const body = await request.json();
        
        // Gather keys from environment secrets (supports JOGI_KEYS as comma-separated list or single secret)
        let keysString = env.JOGI_KEYS || "";
        // If you set multiple secrets in Wrangler, you can also check env.JOGI_KEY_2, etc.
        let keyPool = keysString.split(/[\n,;]+/).map(k => k.trim()).filter(Boolean);

        if (keyPool.length === 0) {
          return new Response(JSON.stringify({ error: "No backend API keys found in worker secrets." }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }

        let upstreamRes = null;
        let lastError = null;

        // Continuous rotation loop across backend secret keys
        for (let i = 0; i < keyPool.length; i++) {
          const currentKey = keyPool[i];
          
          // Determine provider based on key format or default to NVIDIA/OpenRouter endpoint
          let targetUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
          if (currentKey.startsWith("gsk_")) targetUrl = "https://api.groq.com/openai/v1/chat/completions";
          else if (currentKey.startsWith("AIza")) targetUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
          else if (currentKey.startsWith("sk-or-")) targetUrl = "https://openrouter.ai/api/v1/chat/completions";

          upstreamRes = await fetch(targetUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${currentKey}`
            },
            body: JSON.stringify(body)
          });

          if (upstreamRes.ok) {
            // Stream the successful response back to client
            return new Response(upstreamRes.body, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Access-Control-Allow-Origin": "*"
              }
            });
          }

          // If rate-limited (429), catch and rotate to next key in secret pool
          if (upstreamRes.status === 429) {
            lastError = "Rate limited, rotating key...";
            continue;
          } else {
            const errText = await upstreamRes.text();
            lastError = `Upstream error ${upstreamRes.status}: ${errText}`;
            // If it's a bad key, move to next
            if (upstreamRes.status === 401 || upstreamRes.status === 403) continue;
          }
        }

        return new Response(JSON.stringify({ error: "All worker secret keys exhausted or rate-limited. " + lastError }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    return new Response("Jogi IoT Search Engine Worker Active", { status: 200 });
  }
};
