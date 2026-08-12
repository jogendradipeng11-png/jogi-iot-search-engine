const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Parse up to 50 keys from the JOGI_KEYS environment variable (separated by commas, spaces, or newlines)
function getApiKeyPool() {
  const rawKeys = process.env.JOGI_KEYS || '';
  return rawKeys
    .split(/[\s,]+/)
    .map(k => k.trim())
    .filter(k => k.length > 0);
}

let currentKeyIndex = 0;

// Function to get the next NVIDIA API key in a round-robin rotation
function getNextApiKey() {
  const keys = getApiKeyPool();
  if (keys.length === 0) return null;
  const key = keys[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % keys.length;
  return key;
}

// Helper to handle requests with automatic key rotation on quota exhaustion / rate limits (429 or 401/403)
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

    // If quota exceeded (429) or unauthorized/forbidden (401/403), rotate to the next key immediately
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

// Proxy endpoint that forwards requests to NVIDIA's API with automatic key rotation
app.all('/api/nvidia/*', async (req, res) => {
  try {
    const nvidiaPath = req.params[0] || '';
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

// Fallback to index.html for frontend routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} with NVIDIA key rotation enabled.`);
});
