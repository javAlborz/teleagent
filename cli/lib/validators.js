import axios from 'axios';

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl || baseUrl.trim() === '') {
    return '';
  }

  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function buildAuthHeaders(apiKey) {
  return {
    'Authorization': `Bearer ${apiKey || 'not-needed'}`
  };
}

/**
 * Validate an OpenAI-compatible TTS endpoint by listing voices
 * @param {string} baseUrl - Endpoint base URL
 * @param {string} apiKey - Optional API key
 * @returns {Promise<{valid: boolean, voices?: string[], error?: string}>} Validation result
 */
export async function validateTtsEndpoint(baseUrl, apiKey) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return {
      valid: false,
      error: 'Endpoint URL cannot be empty'
    };
  }

  try {
    const response = await axios.get(`${normalizedBaseUrl}/audio/voices`, {
      headers: buildAuthHeaders(apiKey),
      timeout: 10000
    });

    if (response.status === 200 && Array.isArray(response.data?.voices)) {
      return {
        valid: true,
        voices: response.data.voices
      };
    }

    return {
      valid: false,
      error: `Unexpected status: ${response.status}`
    };
  } catch (error) {
    if (error.response) {
      return {
        valid: false,
        error: `Endpoint error: ${error.response.status} ${error.response.statusText}`
      };
    }

    if (error.code === 'ECONNABORTED') {
      return {
        valid: false,
        error: 'Request timeout - check the endpoint URL and network path'
      };
    }

    return {
      valid: false,
      error: `Network error: ${error.message}`
    };
  }
}

/**
 * Validate an OpenAI-compatible STT endpoint by listing models
 * @param {string} baseUrl - Endpoint base URL
 * @param {string} apiKey - Optional API key
 * @returns {Promise<{valid: boolean, error?: string}>} Validation result
 */
export async function validateSttEndpoint(baseUrl, apiKey) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return {
      valid: false,
      error: 'Endpoint URL cannot be empty'
    };
  }

  try {
    const response = await axios.get(`${normalizedBaseUrl}/models`, {
      headers: buildAuthHeaders(apiKey),
      timeout: 10000
    });

    if (response.status === 200 && Array.isArray(response.data?.data)) {
      return { valid: true };
    }

    return {
      valid: false,
      error: `Unexpected status: ${response.status}`
    };
  } catch (error) {
    if (error.response) {
      return {
        valid: false,
        error: `Endpoint error: ${error.response.status} ${error.response.statusText}`
      };
    }

    if (error.code === 'ECONNABORTED') {
      return {
        valid: false,
        error: 'Request timeout - check the endpoint URL and network path'
      };
    }

    return {
      valid: false,
      error: `Network error: ${error.message}`
    };
  }
}

/**
 * Validate SIP extension format
 * @param {string} extension - SIP extension number
 * @returns {boolean} True if valid
 */
export function validateExtension(extension) {
  return /^\d{4,5}$/.test(extension);
}

/**
 * Validate IP address format
 * @param {string} ip - IP address
 * @returns {boolean} True if valid
 */
export function validateIP(ip) {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipv4Regex.test(ip)) {
    return false;
  }

  const parts = ip.split('.');
  return parts.every(part => {
    const num = parseInt(part, 10);
    return num >= 0 && num <= 255;
  });
}

/**
 * Validate hostname format
 * @param {string} hostname - Hostname or FQDN
 * @returns {boolean} True if valid
 */
export function validateHostname(hostname) {
  const hostnameRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
  return hostnameRegex.test(hostname);
}

/**
 * Validate a TTS voice name or ID against an OpenAI-compatible voice list
 * @param {string} baseUrl - Endpoint base URL
 * @param {string} apiKey - Optional API key
 * @param {string} voiceId - Voice ID to validate
 * @returns {Promise<{valid: boolean, name?: string, error?: string}>} Validation result
 */
export async function validateTtsVoice(baseUrl, apiKey, voiceId) {
  if (!voiceId || voiceId.trim() === '') {
    return {
      valid: false,
      error: 'Voice ID cannot be empty'
    };
  }

  const endpointResult = await validateTtsEndpoint(baseUrl, apiKey);
  if (!endpointResult.valid) {
    return {
      valid: false,
      error: endpointResult.error
    };
  }

  if (!endpointResult.voices.includes(voiceId)) {
    return {
      valid: false,
      error: 'Voice ID not found in endpoint voice list'
    };
  }

  return {
    valid: true,
    name: voiceId
  };
}
