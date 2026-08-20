'use strict';

const crypto = require('node:crypto');

const RISK_LEVELS = Object.freeze({
  READ_ONLY: 'read_only',
  MUTATING: 'mutating',
  HIGH: 'high',
  PRIVILEGED: 'privileged',
});

const READ_ONLY_COMMIT_CONTEXT = /\b(?:show|list|read|inspect|review|find|get|check|summari[sz]e|latest|recent|last|previous)\s+(?:the\s+)?(?:latest\s+|recent\s+|last\s+)?commits?\b/gi;
const INFORMATIONAL_REQUEST = /^(?:(?:please\s+)?(?:show|list|read|inspect|review|find|get|check|summari[sz]e|describe|explain)\b|tell\s+me\s+(?:about|how|what|why|when|where|whether)\b|(?:what|why|when|where)\b|how\s+(?:do|does|would|can|could|should|is|are|will)\b)/i;
const EXPLICIT_FOLLOWUP_ACTION = /\b(?:and|then|after that)\s+(?:please\s+)?(?:apply|build|change|commit|configure|create|delete|deploy|edit|execute|fix|implement|install|merge|modify|publish|push|reboot|refactor|release|remove|rename|replace|restart|restore|run|send|start|stop|update|upgrade|write)\b/i;
const PRIVILEGED_PATTERNS = [
  ['sudo', /\bsudo\b/i],
  ['host power control', /\b(?:reboot|shutdown|poweroff|halt)\b/i],
  ['identity or permission change', /\b(?:useradd|userdel|usermod|groupadd|groupdel|passwd|visudo|chown|chmod|setfacl)\b/i],
  ['package or kernel administration', /\b(?:apt(?:-get)?|dnf|yum|pacman|zypper|modprobe|sysctl)\b/i],
  ['service administration', /\b(?:systemctl|service)\s+(?:start|stop|restart|reload|enable|disable|mask|unmask)\b/i],
  ['cluster mutation', /\bkubectl\s+(?:apply|create|delete|edit|patch|replace|rollout|scale|set|taint|drain|cordon|uncordon)\b/i],
];
const HIGH_RISK_PATTERNS = [
  ['deployment or publication', /\b(?:deploy|publish|ship|release|roll\s*out|republish)\b/i],
  ['remote repository mutation', /\b(?:git\s+push|gh\s+pr\s+merge|merge\s+(?:the\s+)?(?:pull request|pr)|push\s+(?:the\s+)?(?:branch|changes))\b/i],
  ['destructive data operation', /\b(?:drop\s+(?:database|table)|wipe|purge|destroy|erase)\b/i],
];
const MUTATING_PATTERNS = [
  ['file or configuration change', /\b(?:apply|archive|change|configure|create|delete|disable|edit|enable|fix|implement|install|modify|move|refactor|remove|rename|replace|restore|update|upgrade|write)\b/i],
  ['software build', /\bbuild\b(?!\s+(?:history|log|status)\b)/i],
  ['local source control mutation', /\b(?:commit|merge|rebase|cherry-pick|revert)\b/i],
  ['process lifecycle change', /\b(?:start|stop|restart|terminate|kill)\s+(?:the\s+)?(?:process|job|task|container|service|server|application|app)\b/i],
  ['restart request', /\brestart\b/i],
  ['command execution', /\b(?:execute|run)\s+(?:the\s+)?(?:command|migration|script)\b/i],
  ['message or external side effect', /\b(?:send|post|message|email|call)\s+(?:it|this|that|the|a|an|my|me|to)\b/i],
];

function normalizeRequest(request) {
  return String(request || '').replaceAll(/\s+/g, ' ').trim();
}

function requestHash(request) {
  return crypto.createHash('sha256').update(normalizeRequest(request)).digest('hex');
}

function firstMatches(request, patterns) {
  const reasons = [];
  for (const [reason, pattern] of patterns) {
    if (pattern.test(request)) reasons.push(reason);
  }
  return reasons;
}

function classifyVoiceOperation(request) {
  const normalized = normalizeRequest(request);
  if (!normalized) {
    return {
      level: RISK_LEVELS.READ_ONLY,
      requiresApproval: false,
      capability: 'read',
      reasons: [],
      requestHash: requestHash(normalized),
    };
  }

  // Questions and leading inspection requests remain read-only even when they
  // mention an otherwise mutating noun (for example, "show release history").
  // A clearly requested follow-up action is still classified below.
  if (INFORMATIONAL_REQUEST.test(normalized) && !EXPLICIT_FOLLOWUP_ACTION.test(normalized)) {
    return {
      level: RISK_LEVELS.READ_ONLY,
      requiresApproval: false,
      capability: 'read',
      reasons: [],
      requestHash: requestHash(normalized),
    };
  }

  const privilegedReasons = firstMatches(normalized, PRIVILEGED_PATTERNS);
  if (privilegedReasons.length > 0) {
    return {
      level: RISK_LEVELS.PRIVILEGED,
      requiresApproval: true,
      capability: 'admin',
      reasons: privilegedReasons,
      requestHash: requestHash(normalized),
    };
  }

  const highReasons = firstMatches(normalized, HIGH_RISK_PATTERNS);
  if (highReasons.length > 0) {
    return {
      level: RISK_LEVELS.HIGH,
      requiresApproval: true,
      capability: 'admin',
      reasons: highReasons,
      requestHash: requestHash(normalized),
    };
  }

  const withoutReadOnlyCommitNouns = normalized.replace(READ_ONLY_COMMIT_CONTEXT, 'read-only-history');
  const mutatingReasons = firstMatches(withoutReadOnlyCommitNouns, MUTATING_PATTERNS);
  if (mutatingReasons.length > 0) {
    return {
      level: RISK_LEVELS.MUTATING,
      requiresApproval: true,
      capability: 'write',
      reasons: mutatingReasons,
      requestHash: requestHash(normalized),
    };
  }

  return {
    level: RISK_LEVELS.READ_ONLY,
    requiresApproval: false,
    capability: 'read',
    reasons: [],
    requestHash: requestHash(normalized),
  };
}

function buildApprovalSummary({ profile, request, classification }) {
  const normalized = normalizeRequest(request);
  const clipped = normalized.length > 260 ? `${normalized.slice(0, 257)}...` : normalized;
  const risk = classification?.level || RISK_LEVELS.MUTATING;
  return `${profile} requests ${risk} authorization for: ${clipped}`;
}

function buildAuthorizationEnvelope(job) {
  if (!job?.requiresApproval || job.status !== 'running') return null;
  const envelope = {
    approved: true,
    job_id: job.id,
    method: job.approval_method || 'dtmf-pound',
    approved_at: job.approved_at || job.started_at,
    risk_level: job.risk_level,
    request_sha256: job.request_hash || requestHash(job.request),
    scope: job.approval_summary || normalizeRequest(job.request),
  };
  if (job.jobKind === 'tmux_agent_message') {
    envelope.target = job.operation?.target || null;
    envelope.target_session_fingerprint = job.operation?.sessionFingerprint || null;
    envelope.target_conversation_name = job.operation?.conversationName || null;
  }
  return envelope;
}

module.exports = {
  RISK_LEVELS,
  buildApprovalSummary,
  buildAuthorizationEnvelope,
  classifyVoiceOperation,
  normalizeRequest,
  requestHash,
};
