---
name: jogi-iot-search
description: User's "Jogi IoT Search Engine" project — single-file NVIDIA NIM search app with 10-key rotation; must route via Cloudflare Worker proxy because NVIDIA API has no CORS for public origins
type: decision
logged: 2026-08-08
updated: 2026-08-08
---

Project files live in `projects/jogi-iot-search/` (index.html, worker.js, README.md). Deployed via GitHub Pages (branch deploy, root).

**Decision:** the app calls NVIDIA NIM (`integrate.api.nvidia.com`) through a user-hosted Cloudflare Worker proxy (`worker.js`), never directly from the browser.

**Why:** verified via curl (2026-08-08) — NVIDIA's preflight returns `access-control-allow-origin` only for allowlisted origins (e.g. build.nvidia.com). From github.io/file:// origins there is NO ACAO header, so browsers block with `TypeError: Failed to fetch`. No static site can call it directly.

**Scope:** any browser-side code calling NVIDIA NIM for this user. Keys are entered in the sidebar, stored in visitor localStorage, never committed to the repo (hardcoded keys on a public repo get stolen). Key rotation: up to 10 keys, round-robin, 429 → 10-min cooldown, 401/403 → marked invalid. User wants "unlimited" via free keys — reminded them per-account quotas are finite and multi-account farming may violate NVIDIA ToS.

**Deployment (updated 2026-08-08):** user connected GitHub repo `jogi-iot-search-engine` (GitHub account 228249686) to Cloudflare Workers Builds. First deploy was a static mirror (no-op worker — wrangler auto-generated assets-only config). Fixed by adding `wrangler.jsonc` (`main: worker.js`, assets dir `.`) + upgraded `worker.js` that proxies POST→NVIDIA and serves the site via `env.ASSETS` on GET. Worker URL: `https://jogi-iot-search-engine.jogendra-dipeng11.workers.dev` — serves the whole app; Proxy URL setting = `/api` there. Auto-rebuilds on every push to main. GitHub Pages optional now.

