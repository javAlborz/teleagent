const DEFAULT_MAX_TURNS = 20;
const DEFAULT_CLAUDE_TIMEOUT_SECONDS = 30;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getMaxTurns(deviceConfig, fallback = DEFAULT_MAX_TURNS) {
  return parsePositiveInteger(deviceConfig?.maxTurns, parsePositiveInteger(fallback, DEFAULT_MAX_TURNS));
}

function getClaudeTimeoutSeconds(deviceConfig, fallback = DEFAULT_CLAUDE_TIMEOUT_SECONDS) {
  return parsePositiveInteger(
    deviceConfig?.claudeTimeoutSeconds,
    parsePositiveInteger(fallback, DEFAULT_CLAUDE_TIMEOUT_SECONDS)
  );
}

module.exports = {
  DEFAULT_MAX_TURNS,
  DEFAULT_CLAUDE_TIMEOUT_SECONDS,
  getMaxTurns,
  getClaudeTimeoutSeconds,
};
