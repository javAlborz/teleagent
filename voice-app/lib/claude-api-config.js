const CLAUDE_API_URL = process.env.CLAUDE_API_URL || 'http://localhost:3333';

function buildClaudeApiHeaders(extraHeaders = {}) {
  const headers = { ...extraHeaders };
  const token = process.env.CLAUDE_API_TOKEN;

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

module.exports = {
  CLAUDE_API_URL,
  buildClaudeApiHeaders
};
