'use strict';

const CLAUDE_MODELS = Object.freeze([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-5',
  'claude-opus-5',
]);
const CODEX_MODELS = Object.freeze([
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
]);
const MODELS_BY_PROVIDER = Object.freeze({
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
});
const REASONING_EFFORT_BY_MODEL = Object.freeze({
  'claude-haiku-4-5-20251001': 'default',
  'claude-sonnet-5': 'high',
  'claude-opus-5': 'high',
  'gpt-5.6-luna': 'low',
  'gpt-5.6-terra': 'medium',
  'gpt-5.6-sol': 'high',
});

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_TOKEN_COUNTING_BETA = 'token-counting-2024-11-01';
// Offline loopback captures from the pinned Claude Code 2.1.246 binary. These
// are wire contracts, not administrator-extensible feature switches.
const ANTHROPIC_INFERENCE_BETAS_BY_MODEL = Object.freeze({
  'claude-haiku-4-5-20251001': Object.freeze([
    'interleaved-thinking-2025-05-14',
    'thinking-token-count-2026-05-13',
    'context-management-2025-06-27',
    'prompt-caching-scope-2026-01-05',
    'claude-code-20250219',
  ]),
  'claude-sonnet-5': Object.freeze([
    'claude-code-20250219',
    'interleaved-thinking-2025-05-14',
    'thinking-token-count-2026-05-13',
    'context-management-2025-06-27',
    'prompt-caching-scope-2026-01-05',
    'mid-conversation-system-2026-04-07',
    'effort-2025-11-24',
  ]),
  'claude-opus-5': Object.freeze([
    'claude-code-20250219',
    'interleaved-thinking-2025-05-14',
    'thinking-token-count-2026-05-13',
    'context-management-2025-06-27',
    'prompt-caching-scope-2026-01-05',
    'mid-conversation-system-2026-04-07',
    'effort-2025-11-24',
    'fallback-credit-2026-06-01',
  ]),
});
const ANTHROPIC_COUNT_BETAS_BY_MODEL = Object.freeze(Object.fromEntries(
  Object.entries(ANTHROPIC_INFERENCE_BETAS_BY_MODEL).map(([model, betas]) => [
    model,
    Object.freeze([...betas, ANTHROPIC_TOKEN_COUNTING_BETA]),
  ])
));

function isCanonicalProviderModel(provider, model) {
  return MODELS_BY_PROVIDER[provider]?.includes(String(model || '')) === true;
}

function requireCanonicalProviderModel(provider, model, label = 'provider model') {
  const value = String(model || '');
  if (!isCanonicalProviderModel(provider, value)) {
    throw new Error(`${label} must be an exact reviewed ${provider} wire model ID`);
  }
  return value;
}

function anthropicBetasForModel(model, routeKind = 'inference') {
  const table = routeKind === 'count_tokens'
    ? ANTHROPIC_COUNT_BETAS_BY_MODEL
    : ANTHROPIC_INFERENCE_BETAS_BY_MODEL;
  return table[String(model || '')] || null;
}

module.exports = {
  ANTHROPIC_COUNT_BETAS_BY_MODEL,
  ANTHROPIC_INFERENCE_BETAS_BY_MODEL,
  ANTHROPIC_TOKEN_COUNTING_BETA,
  ANTHROPIC_VERSION,
  CLAUDE_MODELS,
  CODEX_MODELS,
  MODELS_BY_PROVIDER,
  REASONING_EFFORT_BY_MODEL,
  anthropicBetasForModel,
  isCanonicalProviderModel,
  requireCanonicalProviderModel,
};
