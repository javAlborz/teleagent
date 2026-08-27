const { getRuntimeSecret } = require('./runtime-secrets');

const AGENT_API_URL = 'http://127.0.0.1:3333';

class AgentApiConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentApiConfigError';
    this.code = 'AGENT_API_CONFIG_INVALID';
  }
}

function loadAgentApiConfig(settings = process.env) {
  if (typeof settings.CLAUDE_API_URL === 'string' && settings.CLAUDE_API_URL.length > 0) {
    throw new AgentApiConfigError(
      'CLAUDE_API_URL is retired; the controller is fixed to http://127.0.0.1:3333'
    );
  }
  if (
    settings.AGENT_API_URL !== undefined &&
    settings.AGENT_API_URL !== '' &&
    settings.AGENT_API_URL !== AGENT_API_URL
  ) {
    throw new AgentApiConfigError(
      'AGENT_API_URL must be the reviewed loopback controller http://127.0.0.1:3333'
    );
  }
  return Object.freeze({ agentApiUrl: AGENT_API_URL });
}

// Fail during module loading, before index.js constructs SIP/media/network
// clients, if a legacy or off-topology controller destination is supplied.
loadAgentApiConfig(process.env);

function buildBearerHeaders(token, extraHeaders = {}) {
  const headers = { ...extraHeaders };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function buildExecutorApiHeaders(extraHeaders = {}) {
  return buildBearerHeaders(getRuntimeSecret('executorApiToken'), extraHeaders);
}

function buildVoiceControlApiHeaders(extraHeaders = {}) {
  return buildBearerHeaders(getRuntimeSecret('voiceControlToken'), extraHeaders);
}

module.exports = {
  AGENT_API_URL,
  AgentApiConfigError,
  buildExecutorApiHeaders,
  buildVoiceControlApiHeaders,
  loadAgentApiConfig,
  // Compatibility URL alias only. The voice process intentionally exposes no
  // helper for the general /ask bearer.
  CLAUDE_API_URL: AGENT_API_URL
};
