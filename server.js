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
  return rawKeys.split(/[\s,]+/).map(k => k.trim()).filter(k => k.length > 5);
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
  if (keys.length === 0) {
    throw new Error('CRITICAL: No valid API keys found in JOGI_KEYS environment variable.');
  }

  if (retries >= keys.length) {
    throw new Error(`All ${keys.length} NVIDIA API keys in the pool have failed or exhausted their quota.`);
  }

  const apiKey = getNextApiKey();
  console.log(`[Key Rotation] Trying key index ${currentKeyIndex} out of ${keys.length} total keys.`);
  
  const headers = {
    ...options.headers,
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  try {
    const response = await fetch(url, { ...options, headers });
    const responseText = await response.text();

    if (!response.ok) {
      console.warn(`[Key Rejected] Status ${response.status}: ${responseText}`);
      // Rotate on auth, rate limit, or not found errors
      if ([401, 403, 404, 422, 429].includes(response.status)) {
        return fetchWithKeyRotation(url, options, retries + 1);
      }
      throw new Error(`NVIDIA API Error (${response.status}): ${responseText}`);
    }

    return {
      status: response.status,
      json: async () => JSON.parse(responseText)
    };
  } catch (error) {
    if (error.message.includes('NVIDIA API Error') || error.message.includes('All')) throw error;
    console.warn(`[Network Error] Retrying with next key...`, error.message);
    return fetchWithKeyRotation(url, options, retries + 1);
  }
}

app.all('/api/nvidia/chat/completions', async (req, res) => {
  try {
    if (getApiKeyPool().length === 0) {
      return res.status(400).json({ error: "JOGI_KEYS environment variable is empty or missing on Render." });
    }

    const targetUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
    
    // Explicitly enforce the standard NVIDIA global model path
    const requestBody = {
      model: "meta/llama-3.3-70b-instruct",
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
  console.log(`Server running on port ${PORT} with clean global model routing.`);
});
