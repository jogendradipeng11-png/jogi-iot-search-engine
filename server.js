const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

// Enable CORS FIRST before any routes
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

// Parse up to 50 keys from the JOGI_KEYS environment variable
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
  
  const headers = {
    ...options.headers,
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  try {
    const response = await fetch(url, { ...options, headers });

    if (response.status === 429 || response.status === 401 || response.status === 403) {
      console.warn(`API key failed with status ${response.status}. Rotating to next key... (Attempt ${retries + 1} of ${keys.length})`);
      return fetchWithKeyRotation(url, options, retries + 1);
    }

    return response;
  } catch (error) {
    console.warn(`Network error with current key, retrying with next key...`, error.message);
    return fetchWithKeyRotation(url, options, retries + 1);
  }
}

// Explicit route matching for NVIDIA completions
app.all('/api/nvidia/chat/completions', async (req, res) => {
  try {
    const keysCount = getApiKeyPool().length;
    if (keysCount === 0) {
      return res.status(400).json({ 
        error: "JOGI_KEYS environment variable is empty or missing on Render. Please add your NVIDIA API keys in your Render dashboard settings." 
      });
    }

    const targetUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
    const bodyData = ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body);

    const nvidiaResponse = await fetchWithKeyRotation(targetUrl, {
      method: req.method,
      body: bodyData
    });

    const responseText = await nvidiaResponse.text();
    
    try {
      const data = JSON.parse(responseText);
      return res.status(nvidiaResponse.status).json(data);
    } catch (e) {
      return res.status(500).json({ 
        error: "Invalid JSON received from NVIDIA API upstream", 
        details: responseText 
      });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Root & fallback routing
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} with NVIDIA key rotation & CORS enabled.`);
});
