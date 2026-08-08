# ⚡ Jogi IoT Search Engine

A private, unlimited-feeling AI search engine for coding and IoT — a single static
`index.html` that runs entirely in the browser and rotates across up to **10 free
NVIDIA NIM API keys**. When one key hits its quota (HTTP 429), the engine
automatically cools it down and rotates to the next one, so searching keeps going.

## Features

- 🔄 **Automatic key rotation** — up to 10 `nvapi-...` keys, round-robin with per-key state
- 🧊 **Cooldown tracking** — 429'd keys rest for 10 minutes, then auto-rejoin the pool
- 🩺 **Key health panel** — masked key list with active / cooldown / invalid badges and request counts
- 💾 **Everything in localStorage** — keys and stats stay in *your* browser, never in the repo
- 🦙 **Ollama fallback** — switch to a fully local model anytime
- 📦 **Zero build step** — one file, deployable on GitHub Pages in 2 minutes

## Get free NVIDIA keys

1. Go to [build.nvidia.com](https://build.nvidia.com) and sign in
2. Open any model (e.g. `meta/llama-3.3-70b-instruct`) → **Get API Key**
3. Paste the key(s) into the sidebar, one per line (max 10)

Good free models to try in the **Model** field:

- `meta/llama-3.3-70b-instruct`
- `meta/llama-3.1-8b-instruct`
- `qwen/qwen2.5-coder-32b-instruct`
- `deepseek-ai/deepseek-r1`
- `mistralai/mistral-nemo`

## Deploy on GitHub Pages

### Easiest (web UI)

1. Create a new **public** repo, e.g. `jogi-iot-search`
2. Upload `index.html` (Add file → Upload files)
3. Repo **Settings → Pages**
4. Source: **Deploy from a branch** → Branch: **main** → folder: **/ (root)** → Save
5. Wait ~1 minute → live at `https://<your-username>.github.io/jogi-iot-search/`

### Command line

```bash
git init
git add index.html README.md
git commit -m "Jogi IoT Search Engine"
git branch -M main
git remote add origin https://github.com/<your-username>/jogi-iot-search.git
git push -u origin main
# then Settings → Pages → Deploy from branch → main → / (root)
```

## ⚠️ CORS fix (required) — "Failed to fetch"

NVIDIA's API only returns CORS headers for its own origins (`build.nvidia.com`).
From GitHub Pages (or `file://`, or `localhost`) the browser blocks the call and
the app shows **"Network error: Failed to fetch"**. A static site cannot call
NVIDIA directly — you need a tiny proxy. The included `worker.js` is a free
Cloudflare Worker that does exactly that:

1. Go to [workers.cloudflare.com](https://workers.cloudflare.com) → sign up free
2. On the "Ship something new" screen click **Start with Hello World!** —
   do **NOT** connect a GitHub repo (that flow needs a wrangler config; skip it)
3. **Deploy** the Hello World template → then click **Edit code** → delete the
   template → paste the contents of [`worker.js`](worker.js) → **Deploy**
4. Copy your worker URL: `https://<name>.<subdomain>.workers.dev`
5. Open your GitHub Pages site → paste that URL into **Proxy URL** in the sidebar

Cloudflare's free tier allows **100,000 requests/day**, so this is effectively
unlimited for personal use. Your NVIDIA keys travel browser → your worker →
NVIDIA; no third party sees them. (Once live, you can optionally set
`ALLOWED_ORIGINS` in `worker.js` to your GitHub Pages origin so only your site
can use the worker.)

## Honest notes on "unlimited"

- **GitHub Pages** hosting is free and effectively unlimited for a static site like this — that part is genuinely unlimited.
- **NVIDIA's side** is where quotas live. Free credits/rate limits are per account, so rotation stretches usage a lot, but each key still has its own ceiling. Rate limits recover (handled by the 10-minute cooldown); exhausted free credits do not.
- **Never paste keys into `index.html` itself.** Keys entered in the sidebar are stored in the visitor's own browser localStorage — everyone brings their own keys. Keys hardcoded into the repo would be public and would get stolen within minutes.
- Use keys from accounts you own. Creating multiple accounts just to multiply free quotas may violate NVIDIA's terms — the rotation is designed for keys you're entitled to use.
