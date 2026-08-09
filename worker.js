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

    // Example route for search/IoT verification
    if (url.pathname.startsWith("/api/search")) {
      const authHeader = request.headers.get("Authorization") || request.headers.get("X-Jogi-Key");
      
      // Validate against the environment secret JOGI_KEYS
      if (!env.JOGI_KEYS || authHeader !== env.JOGI_KEYS) {
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid or missing JOGI_KEYS" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      // Proceed with search logic
      const query = url.searchParams.get("q") || "";
      // Mock response or downstream fetch
      return new Response(JSON.stringify({ results: [], query, status: "success" }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    return new Response("Jogi IoT Search Engine Worker Active", { status: 200 });
  }
};
