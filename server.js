const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// Serve static files from the current directory
app.use(express.static(__dirname));

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
    throw new Error('No API keys found in JOGI_KEYS environment variable.');
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

// NVIDIA API Proxy Endpoint
app.all('/api/nvidia/*', async (req, res) => {
  try {
    const nvidiaPath = req.params[0] || 'chat/completions';
    const targetUrl = `https://integrate.api.nvidia.com/v1/${nvidiaPath}`;

    const bodyData = ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body);

    const nvidiaResponse = await fetchWithKeyRotation(targetUrl, {
      method: req.method,
      body: bodyData
    });

    const data = await nvidiaResponse.json();
    res.status(nvidiaResponse.status).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Explicit root route to ensure index.html is served
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Fallback for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} with NVIDIA key rotation enabled.`);
});
