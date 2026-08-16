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

// Increased payload limit to support image and file attachments
app.use(express.json({ limit: '10mb' }));
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
    throw new Error('CRITICAL: No valid API keys found in JOGI_KEYS environment variable on Render.');
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
      if ([401, 403, 404, 422, 429].includes(response.status)) {
        return fetchWithKeyRotation(url, options, retries + 1);
      }
      throw new Error(`NVIDIA API Error (${response.status}): ${responseText}`);
    }

    let jsonData;
    try {
      jsonData = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`Upstream returned non-JSON response: ${responseText.slice(0, 100)}`);
    }

    return {
      status: response.status,
      data: jsonData
    };
  } catch (error) {
    if (error.message.includes('NVIDIA API Error') || error.message.includes('All') || error.message.includes('CRITICAL')) {
      throw error;
    }
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
    
    // Automatically detect if an image is attached to route to the vision model
    const hasImages = req.body && req.body.messages && req.body.messages.some(m => Array.isArray(m.content));
    const selectedModel = hasImages ? "meta/llama-3.2-11b-vision-instruct" : "meta/llama-3.1-70b-instruct";

    const requestBody = {
      model: selectedModel,
      messages: req.body && req.body.messages ? req.body.messages : [{ role: "user", content: "Hello" }],
      temperature: 0.3,
      max_tokens: 2048,
      stream: false
    };

    const result = await fetchWithKeyRotation(targetUrl, {
      method: 'POST',
      body: JSON.stringify(requestBody)
    });

    return res.status(result.status).json(result.data);
  } catch (error) {
    console.error("[Proxy Error]:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} with multimodal proxy and key rotation enabled.`);
});
