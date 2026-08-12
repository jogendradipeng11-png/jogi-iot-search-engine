const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

// Enable CORS for all origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Parse keys from the JOGI_KEYS environment variable
function getApiKeyPool() {
  const rawKeys = process.env.JOGI_KEYS || '';
  return rawKeys
    .split(/[\s,]+/)
    .map(k => k.trim())
    .filter(k => k.length > 0);
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
    throw new Error('CRITICAL: No API keys found in JOGI_KEYS environment variable on Render dashboard.');
  }

  if (retries >= keys.length) {
    throw new Error('All NVIDIA API keys in the JOGI_KEYS pool have failed or exhausted their quota.');
  }

  const apiKey = getNextApiKey();
  console.log(`[Key Rotation] Trying key index ${currentKeyIndex} (Attempt ${retries + 1} of ${keys.length})`);
  
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
      console.warn(`[Key Failed] Key index ${currentKeyIndex} returned status ${response.status}: ${errText}`);
      if (response.status === 429 || response.status === 401 || response.status === 403 || response.status === 422 || response.status === 404) {
        return fetchWithKeyRotation(url, options, retries + 1);
      }
      throw new Error(`NVIDIA API Error (${response.status}): ${errText}`);
    }

    return response;
  } catch (error) {
    if (error.message.includes('NVIDIA API Error')) throw error;
    console.warn(`[Network Error] Retrying with next key...`, error.message);
    return fetchWithKeyRotation(url, options, retries + 1);
  }
}

// NVIDIA API Proxy Endpoint
app.all('/api/nvidia/chat/completions', async (req, res) => {
  try {
    const keysCount = getApiKeyPool().length;
    if (keysCount === 0) {
      return res.status(400).json({ 
        error: "JOGI_KEYS environment variable is empty or missing on Render. Please add your NVIDIA API keys." 
      });
    }

    const targetUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
    
    // Use the official current NVIDIA NIM model identifier
    const requestBody = {
      model: "meta/llama-3.3-70b-instruct",
      messages: req.body && req.body.messages ? req.body.messages : [{ role: "user", content: "Hello" }],
      temperature: 0.3,
      max_tokens: 2048,
      stream: false
    };

    const nvidiaResponse = await fetchWithKeyRotation(targetUrl, {
      method: 'POST',
      body: JSON.stringify(requestBody)
    });

    const responseText = await nvidiaResponse.text();
    
    try {
      const data = JSON.parse(responseText);
      return res.status(nvidiaResponse.status).json(data);
    } catch (e) {
      console.error("[Upstream Parse Error] Non-JSON received:", responseText);
      return res.status(500).json({ 
        error: "Invalid JSON received from NVIDIA API upstream", 
        details: responseText 
      });
    }
  } catch (error) {
    console.error("[Proxy Error]:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

// Root & fallback routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} with automated NVIDIA model & key rotation enabled.`);
});
