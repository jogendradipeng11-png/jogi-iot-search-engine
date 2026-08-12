const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

function getApiKeyPool() {
  const rawKeys = process.env.JOGI_KEYS || '';
  return rawKeys.split(/[\s,]+/).map(k => k.trim()).filter(k => k.length > 0);
}

let currentKeyIndex = 0;

function getNextApiKey() {
  const keys = getApiKeyPool();
  if (keys.length === 0) return null;
  const key = keys[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % keys.length;
  return key;
}

async function fetchWithKeyRotation(url, options, retries = 0) {
  const keys = getApiKeyPool();
  if (keys.length === 0) throw new Error('CRITICAL: No API keys found in JOGI_KEYS environment variable.');
  if (retries >= keys.length) throw new Error('All NVIDIA API keys in the pool have failed or exhausted their quota.');

  const apiKey = getNextApiKey();
  console.log(`[Key Rotation] Trying key index ${currentKeyIndex} (Attempt ${retries + 1})`);
  
  const headers = {
    ...options.headers,
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  try {
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[Key Failed] Status ${response.status}: ${errText}`);
      if ([401, 403, 404, 422, 429].includes(response.status)) {
        return fetchWithKeyRotation(url, options, retries + 1);
      }
      throw new Error(`API Error (${response.status}): ${errText}`);
    }
    return response;
  } catch (error) {
    if (error.message.includes('API Error')) throw error;
    console.warn(`[Network Error] Retrying...`, error.message);
    return fetchWithKeyRotation(url, options, retries + 1);
  }
}

app.all('/api/nvidia/chat/completions', async (req, res) => {
  try {
    if (getApiKeyPool().length === 0) {
      return res.status(400).json({ error: "JOGI_KEYS environment variable is missing on Render." });
    }

    const targetUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
    
    // Fast, lightweight model optimized for quick responses
    const requestBody = {
      model: "google/codegemma-7b",
      messages: req.body && req.body.messages ? req.body.messages : [{ role: "user", content: "Hello" }],
      temperature: 0.3,
      max_tokens: 1024,
      stream: false
    };

    const nvidiaResponse = await fetchWithKeyRotation(targetUrl, {
      method: 'POST',
      body: JSON.stringify(requestBody)
    });

    const data = await nvidiaResponse.json();
    return res.status(nvidiaResponse.status).json(data);
  } catch (error) {
    console.error("[Proxy Error]:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} with instant key rotation.`);
});
