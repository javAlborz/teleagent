const AGENT_API_URL = process.env.AGENT_API_URL || process.env.CLAUDE_API_URL || 'http://localhost:3333';

function buildAgentApiHeaders(extraHeaders = {}) {
  const headers = { ...extraHeaders };
  const token = process.env.AGENT_API_TOKEN || process.env.CLAUDE_API_TOKEN;

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

module.exports = {
  AGENT_API_URL,
  buildAgentApiHeaders,
  // Compatibility aliases for existing deployments and callers.
  CLAUDE_API_URL: AGENT_API_URL,
  buildClaudeApiHeaders: buildAgentApiHeaders
};
