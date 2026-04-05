const ACTION_RE = /\b(deploy|ship|publish|republish|release|rollout|merge|bootstrap)\b/i;
const PLATFORM_RE =
  /\b(app-platform|cloop|cloudflare|tailscale|infra pr|pull request|preview|public hostname|workflow)\b/i;
const APP_REPO_RE = /\/home\/[^\s]+\/dev\/apps\/[^\s]+/i;
const END_TO_END_RE = /\bend[\s-]+to[\s-]+end\b/i;

function looksLikePhoneDeployRequest(prompt = '', devicePrompt = '') {
  const text = `${prompt}\n${devicePrompt}`.trim();
  if (!text) {
    return false;
  }

  if (END_TO_END_RE.test(text) && /(app-platform|deploy|ship|publish)/i.test(text)) {
    return true;
  }

  if (!ACTION_RE.test(text)) {
    return false;
  }

  return PLATFORM_RE.test(text) || APP_REPO_RE.test(text);
}

module.exports = {
  looksLikePhoneDeployRequest,
};
