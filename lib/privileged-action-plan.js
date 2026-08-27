'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { canonicalizeApprovalPlan } = require('./voice-approval-capability');

const PRIVILEGED_ACTION_METHOD = 'root-broker-exact-argv-v1';
const PRIVILEGED_ACTION_PROFILE = 'privileged-action';
const PRIVILEGED_ACTION_PROVIDER = 'root-broker';
const SYSTEMCTL = '/usr/bin/systemctl';
const JOURNALCTL = '/usr/bin/journalctl';
const SSH = '/usr/bin/ssh';
const REMOTE_SUDO = '/usr/bin/sudo';
const REMOTE_SYSTEMCTL = '/usr/bin/systemctl';
const REMOTE_KUBECTL = '/usr/local/bin/kubectl';
const REMOTE_SSH = '/usr/bin/ssh';
const SAFE_TOKEN = /^[A-Za-z0-9_./:@=,+%-]+$/;
// Windows OpenSSH serializes its remote command through the configured
// DefaultShell. cmd.exe expands %NAME% after SSH transport, so percent can
// make the executed argv differ from the plan that was spoken and signed.
const WINDOWS_SAFE_TOKEN = /^[A-Za-z0-9_./:@=,+-]+$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,199}$/;
const SAFE_HOST = /^(?:hera|aphrodite|dionysus|prometheus|atlas|zeus|hephaestus)$/;
const SAFE_K8S_NAME = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const WINDOWS_EXECUTABLE = /^[A-Za-z]:\/(?:[A-Za-z0-9_.+-]+\/)*[A-Za-z0-9_.+-]+\.exe$/i;
const LINUX_SSH_HOSTS = new Set([
  'hera', 'aphrodite', 'dionysus', 'prometheus', 'atlas', 'hephaestus',
]);
const SYSTEMD_ACTIONS = new Set(['status', 'start', 'stop', 'restart', 'reload', 'enable', 'disable']);
const KUBECTL_GET_KINDS = new Set([
  'deployment', 'statefulset', 'daemonset', 'pod', 'service', 'node', 'job', 'cronjob',
]);
const KUBECTL_ROLLOUT_KINDS = new Set(['deployment', 'statefulset', 'daemonset']);
const FORBIDDEN_EXACT_EXECUTABLES = new Set([
  '/bin/bash', '/bin/dash', '/bin/find', '/bin/sh', '/bin/xargs', '/bin/zsh',
  '/usr/bin/bash', '/usr/bin/chroot', '/usr/bin/dash', '/usr/bin/env', '/usr/bin/find',
  '/usr/bin/make', '/usr/bin/node', '/usr/bin/nsenter', '/usr/bin/perl', '/usr/bin/python',
  '/usr/bin/python3', '/usr/bin/runuser', '/usr/bin/ruby', '/usr/bin/script', '/usr/bin/sh',
  '/usr/bin/ssh', '/usr/bin/su', '/usr/bin/sudo', '/usr/bin/systemd-run', '/usr/bin/unshare',
  '/usr/bin/xargs', '/usr/bin/zsh', '/usr/local/bin/node', '/usr/local/bin/python',
  '/usr/local/bin/python3', '/usr/sbin/chroot', '/usr/sbin/runuser',
]);
const FORBIDDEN_WINDOWS_EXACT_EXECUTABLES = new Set([
  'c:/windows/system32/cmd.exe',
  'c:/windows/system32/cscript.exe',
  'c:/windows/system32/mshta.exe',
  'c:/windows/system32/rundll32.exe',
  'c:/windows/system32/windowspowershell/v1.0/powershell.exe',
  'c:/windows/system32/wscript.exe',
  'c:/program files/powershell/7/pwsh.exe',
]);
const SENSITIVE_ARG = /(?:^sk-(?:proj-)?|(?:password|passwd|secret|token|api[_-]?key|authorization)=|^(?:authorization|proxy-authorization):|^(?:bearer|basic):?)/i;
const SENSITIVE_ARG_FLAGS = new Set([
  '-H', '--header', '-u', '--user', '--proxy-user',
  '--password', '--passwd', '--token', '--access-token', '--oauth2-bearer',
  '--api-key', '--apikey', '--authorization', '--client-secret',
  '--secret', '--private-key', '--identity-file', '-i',
].map((value) => value.toLowerCase()));
const SENSITIVE_PATH_OPERAND = /(?:^|=)(?:\/etc\/(?:shadow|gshadow|sudoers(?:\.d)?|ssh|ssl\/private|teleagent)|\/root\/(?:\.ssh|\.gnupg|\.aws|\.kube|\.config|\.password-store)|\/proc\/(?:self|[0-9]+)\/(?:environ|mem)|\/var\/(?:lib|run)\/secrets)(?:\/|$)/i;
const MAX_EXACT_ARGV_TOKENS = 16;
const MAX_EXACT_ARGV_JSON_CHARS = 1024;
const MAX_APPROVAL_PROMPT_CHARS = 1800;
const MAX_APPROVAL_PROMPT_WORDS = 240;

class PrivilegedActionPlanError extends Error {
  constructor(code, message, field = null) {
    super(message);
    this.name = 'PrivilegedActionPlanError';
    this.code = code;
    this.field = field;
  }
}

function planError(code, message, field = null) {
  throw new PrivilegedActionPlanError(code, message, field);
}

function boundedString(value, field, { max = 500, pattern = null } = {}) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max || /[\u0000-\u001F\u007F]/.test(text) ||
      (pattern && !pattern.test(text))) {
    planError('PRIVILEGED_PLAN_INVALID', `${field} is invalid.`, field);
  }
  return text;
}

function boundedInteger(value, field, { min, max, fallback = null } = {}) {
  const parsed = Number.parseInt(value, 10);
  const resolved = Number.isInteger(parsed) ? parsed : fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    planError('PRIVILEGED_PLAN_INVALID', `${field} must be between ${min} and ${max}.`, field);
  }
  return resolved;
}

function systemdUnit(value) {
  const unit = boundedString(value, 'unit', { max: 200, pattern: SAFE_NAME });
  if (!/\.(?:service|socket|timer|mount|target|path)$/.test(unit)) {
    planError('PRIVILEGED_PLAN_INVALID', 'unit must include an allowed systemd unit suffix.', 'unit');
  }
  return unit;
}

function exactArgvDisplay(argv) {
  return JSON.stringify(argv);
}

function assertNoSensitiveArguments(argv, field) {
  for (const [index, token] of argv.entries()) {
    const lowered = token.toLowerCase();
    const separator = lowered.indexOf('=');
    const flagName = separator === -1 ? lowered : lowered.slice(0, separator);
    if (SENSITIVE_ARG.test(token) || SENSITIVE_ARG_FLAGS.has(flagName) ||
        (index > 0 && SENSITIVE_PATH_OPERAND.test(token))) {
      planError(
        'PRIVILEGED_PLAN_INVALID',
        'Exact argv must not contain credential flags, sensitive trust paths, headers, or bearer-like secret material; use a root-owned credential-file adapter.',
        field
      );
    }
  }
}

function sshOptions() {
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ClearAllForwardings=yes',
  ];
}

function sshArgv(host, remoteArgv) {
  const direct = [SSH, ...sshOptions(), host, ...remoteArgv];
  if (host === 'hera') return direct;
  // Hermes intentionally has only the root-key route to Hera. Other named
  // homelab hosts are reached through a fixed, non-forwarding Hera pivot. All
  // remote tokens are restricted below because OpenSSH serializes them into a
  // remote command; no caller-controlled whitespace or shell metacharacters
  // are admitted.
  return [
    SSH,
    ...sshOptions(),
    'hera',
    REMOTE_SSH,
    ...sshOptions(),
    host,
    ...remoteArgv,
  ];
}

function expected(description, observeArgv = null) {
  return {
    description,
    observe_argv: observeArgv,
    require_exit_code: 0,
  };
}

function basePlan({ adapter, parameters, argv, target, timeoutSeconds, impactSummary, riskLevel,
  expectedResult, cwd = '/' }) {
  return {
    version: 1,
    kind: 'privileged_action',
    method: PRIVILEGED_ACTION_METHOD,
    adapter,
    parameters,
    argv,
    argv_display: exactArgvDisplay(argv),
    target,
    cwd,
    timeout_seconds: timeoutSeconds,
    impact_summary: impactSummary,
    risk: {
      level: riskLevel,
      root_authority: true,
      requires_focused_dtmf_pound: true,
    },
    expected_result: expectedResult,
  };
}

function buildSystemctlPlan(input) {
  const action = boundedString(input.action, 'action', { max: 20 });
  if (!SYSTEMD_ACTIONS.has(action)) {
    planError('PRIVILEGED_PLAN_INVALID', 'Unsupported systemctl action.', 'action');
  }
  const unit = systemdUnit(input.unit);
  const timeoutSeconds = boundedInteger(input.timeoutSeconds, 'timeoutSeconds', {
    min: 5, max: 300, fallback: 90,
  });
  const argv = [SYSTEMCTL, action, '--', unit];
  const observeArgv = [
    SYSTEMCTL, 'show', '--no-pager',
    '--property=LoadState', '--property=ActiveState', '--property=SubState', '--', unit,
  ];
  const readOnly = action === 'status';
  return basePlan({
    adapter: 'systemctl',
    parameters: { action, unit },
    argv,
    target: `hermes:systemd:${unit}`,
    timeoutSeconds,
    impactSummary: readOnly
      ? `Reads the current root-visible systemd status of ${unit} on Hermes.`
      : `${action} changes the systemd lifecycle or enablement state of ${unit} on Hermes.`,
    riskLevel: readOnly ? 'privileged_read' : 'privileged',
    expectedResult: expected(
      `${SYSTEMCTL} ${action} and the fixed state probe must exit zero; only output digests and byte counts are retained.`,
      observeArgv
    ),
  });
}

function buildJournalctlPlan(input) {
  const unit = systemdUnit(input.unit);
  const lines = boundedInteger(input.lines, 'lines', { min: 1, max: 500, fallback: 100 });
  const timeoutSeconds = boundedInteger(input.timeoutSeconds, 'timeoutSeconds', {
    min: 5, max: 120, fallback: 30,
  });
  const argv = [
    JOURNALCTL, '--no-pager', '--output=short-iso', '--lines', String(lines), '--unit', unit,
  ];
  return basePlan({
    adapter: 'journalctl',
    parameters: { unit, lines },
    argv,
    target: `hermes:journald:${unit}`,
    timeoutSeconds,
    impactSummary: `Reads the last ${lines} root-visible journal records for ${unit} on Hermes; it does not change the unit.`,
    riskLevel: 'privileged_read',
    expectedResult: expected(
      `journalctl must exit zero; journal content is not persisted or returned, only its digest and byte counts.`
    ),
  });
}

function buildSshPlan(input) {
  const host = boundedString(input.host, 'host', { max: 64, pattern: SAFE_HOST });
  const remoteAction = boundedString(input.remoteAction, 'remoteAction', { max: 40 });
  const timeoutSeconds = boundedInteger(input.timeoutSeconds, 'timeoutSeconds', {
    min: 5, max: 300, fallback: 60,
  });
  let remoteArgv;
  let observeRemoteArgv = null;
  let impactSummary;
  let riskLevel = 'privileged_read';
  const parameters = { host, remoteAction };
  if (remoteAction === 'hostname') {
    remoteArgv = [host === 'zeus' ? 'C:/Windows/System32/hostname.exe' : '/usr/bin/hostname'];
    impactSummary = `Reads the hostname reported by the named homelab host ${host}.`;
  } else if (remoteAction === 'uptime') {
    if (!LINUX_SSH_HOSTS.has(host)) {
      planError('PRIVILEGED_PLAN_INVALID', 'uptime is available only for named Linux hosts.', 'host');
    }
    remoteArgv = ['/usr/bin/uptime', '--pretty'];
    impactSummary = `Reads uptime from the named homelab host ${host}.`;
  } else if (['systemctl_status', 'systemctl_restart'].includes(remoteAction)) {
    if (!LINUX_SSH_HOSTS.has(host)) {
      planError('PRIVILEGED_PLAN_INVALID', 'systemctl is available only for named Linux hosts.', 'host');
    }
    const unit = systemdUnit(input.unit);
    parameters.unit = unit;
    const systemctlAction = remoteAction === 'systemctl_status' ? 'status' : 'restart';
    remoteArgv = [REMOTE_SUDO, '-n', REMOTE_SYSTEMCTL, systemctlAction, '--', unit];
    observeRemoteArgv = [
      REMOTE_SUDO, '-n', REMOTE_SYSTEMCTL, 'show', '--no-pager',
      '--property=LoadState', '--property=ActiveState', '--property=SubState', '--', unit,
    ];
    riskLevel = remoteAction === 'systemctl_status' ? 'privileged_read' : 'privileged';
    impactSummary = remoteAction === 'systemctl_status'
      ? `Reads root-visible status for ${unit} on the named homelab host ${host}.`
      : `Restarts ${unit} with root authority on the named homelab host ${host}.`;
  } else if (remoteAction === 'exact_argv') {
    const exactRemoteArgv = exactRemoteArgvForHost(input.remoteArgv || input.argv, host);
    parameters.remoteArgv = exactRemoteArgv;
    remoteArgv = exactRemoteArgv;
    riskLevel = 'high';
    impactSummary = `HIGH RISK: executes this exact remote argument vector on the named homelab host ${host} through the fixed Hera pivot: ${exactArgvDisplay(exactRemoteArgv)}.`;
  } else {
    planError('PRIVILEGED_PLAN_INVALID', 'Unsupported named-host SSH action.', 'remoteAction');
  }
  const argv = sshArgv(host, remoteArgv);
  const observeArgv = observeRemoteArgv ? sshArgv(host, observeRemoteArgv) : null;
  return basePlan({
    adapter: 'ssh',
    parameters,
    argv,
    target: `homelab:${host}`,
    timeoutSeconds,
    impactSummary,
    riskLevel,
    expectedResult: expected(
      `${exactArgvDisplay(argv)} must exit zero${observeArgv ? ' and the exact post-action probe must exit zero' : ''}; only output digests and byte counts are retained.`,
      observeArgv
    ),
  });
}

function exactRemoteArgvForHost(value, host) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EXACT_ARGV_TOKENS) {
    planError('PRIVILEGED_PLAN_INVALID', `remote argv must contain between 1 and ${MAX_EXACT_ARGV_TOKENS} exact tokens.`, 'remoteArgv');
  }
  const argv = value.map((entry, index) => boundedString(entry, `remoteArgv[${index}]`, {
    max: index === 0 ? 512 : 2000,
    pattern: host === 'zeus' ? WINDOWS_SAFE_TOKEN : SAFE_TOKEN,
  }));
  assertNoSensitiveArguments(argv, 'remoteArgv');
  if (exactArgvDisplay(argv).length > MAX_EXACT_ARGV_JSON_CHARS) {
    planError('PRIVILEGED_PLAN_INVALID', 'The exact remote argv is too long to approve by voice.', 'remoteArgv');
  }
  let executable = argv[0];
  if (executable === REMOTE_SUDO && argv[1] === '-n') executable = argv[2];
  if (typeof executable !== 'string') {
    planError('PRIVILEGED_PLAN_INVALID', 'The exact remote executable is missing.', 'remoteArgv');
  }
  const canonical = host === 'zeus'
    ? WINDOWS_EXECUTABLE.test(executable)
    : path.posix.isAbsolute(executable) && path.posix.normalize(executable) === executable;
  if (!canonical) {
    planError(
      'PRIVILEGED_PLAN_INVALID',
      'The exact remote executable must be a canonical absolute path for the target operating system.',
      'remoteArgv[0]'
    );
  }
  const forbidden = host === 'zeus'
    ? FORBIDDEN_WINDOWS_EXACT_EXECUTABLES.has(executable.toLowerCase())
    : FORBIDDEN_EXACT_EXECUTABLES.has(executable);
  if (forbidden) {
    planError(
      'PRIVILEGED_PLAN_INVALID',
      'Exact remote argv cannot use a shell, interpreter, or command-dispatching executable.',
      'remoteArgv[0]'
    );
  }
  return argv;
}

function kubectlResource(input, kinds) {
  const kind = boundedString(input.kind, 'kind', { max: 32 });
  if (!kinds.has(kind)) planError('PRIVILEGED_PLAN_INVALID', 'Unsupported Kubernetes kind.', 'kind');
  const name = input.name === null || input.name === undefined || input.name === ''
    ? null
    : boundedString(input.name, 'name', { max: 253, pattern: SAFE_K8S_NAME });
  return { kind, name };
}

function buildKubectlPlan(input) {
  const operation = boundedString(input.operation, 'operation', { max: 32 });
  const namespace = boundedString(input.namespace || 'default', 'namespace', {
    max: 253,
    pattern: SAFE_K8S_NAME,
  });
  const timeoutSeconds = boundedInteger(input.timeoutSeconds, 'timeoutSeconds', {
    min: 5, max: 300, fallback: 90,
  });
  let remoteArgv;
  let observeRemoteArgv;
  let impactSummary;
  let riskLevel;
  let parameters;
  if (operation === 'get') {
    const { kind, name } = kubectlResource(input, KUBECTL_GET_KINDS);
    parameters = { operation, namespace, kind, name };
    remoteArgv = [
      REMOTE_SUDO, '-n', REMOTE_KUBECTL, '--namespace', namespace,
      'get', kind, ...(name ? [name] : []), '--output=wide',
    ];
    observeRemoteArgv = null;
    impactSummary = `Reads ${name ? `${kind}/${name}` : `all ${kind} resources`} in Kubernetes namespace ${namespace} through the approved Hermes-to-Hera route.`;
    riskLevel = 'privileged_read';
  } else if (operation === 'rollout_restart') {
    const { kind, name } = kubectlResource(input, KUBECTL_ROLLOUT_KINDS);
    if (!name) planError('PRIVILEGED_PLAN_INVALID', 'A named workload is required.', 'name');
    parameters = { operation, namespace, kind, name };
    remoteArgv = [
      REMOTE_SUDO, '-n', REMOTE_KUBECTL, '--namespace', namespace,
      'rollout', 'restart', `${kind}/${name}`,
    ];
    observeRemoteArgv = [
      REMOTE_SUDO, '-n', REMOTE_KUBECTL, '--namespace', namespace,
      'rollout', 'status', `${kind}/${name}`, '--timeout=60s',
    ];
    impactSummary = `Restarts Kubernetes ${kind}/${name} in namespace ${namespace} through the approved Hermes-to-Hera root route.`;
    riskLevel = 'privileged';
  } else if (operation === 'scale') {
    const { kind, name } = kubectlResource(input, new Set(['deployment', 'statefulset']));
    if (!name) planError('PRIVILEGED_PLAN_INVALID', 'A named scalable workload is required.', 'name');
    const replicas = boundedInteger(input.replicas, 'replicas', { min: 0, max: 100 });
    parameters = { operation, namespace, kind, name, replicas };
    remoteArgv = [
      REMOTE_SUDO, '-n', REMOTE_KUBECTL, '--namespace', namespace,
      'scale', `${kind}/${name}`, `--replicas=${replicas}`,
    ];
    observeRemoteArgv = [
      REMOTE_SUDO, '-n', REMOTE_KUBECTL, '--namespace', namespace,
      'get', `${kind}/${name}`, '--output=wide',
    ];
    impactSummary = `Scales Kubernetes ${kind}/${name} in namespace ${namespace} to exactly ${replicas} replicas through the approved Hermes-to-Hera root route.`;
    riskLevel = 'privileged';
  } else {
    planError('PRIVILEGED_PLAN_INVALID', 'Unsupported Kubernetes operation.', 'operation');
  }
  const argv = sshArgv('hera', remoteArgv);
  const observeArgv = observeRemoteArgv ? sshArgv('hera', observeRemoteArgv) : null;
  return basePlan({
    adapter: 'kubectl',
    parameters,
    argv,
    target: `kubernetes:hera:${namespace}`,
    timeoutSeconds,
    impactSummary,
    riskLevel,
    expectedResult: expected(
      `${exactArgvDisplay(argv)} must exit zero${observeArgv ? ' and the exact Kubernetes post-action probe must exit zero' : ''}; only output digests and byte counts are retained.`,
      observeArgv
    ),
  });
}

function escapeArgv(input) {
  if (!Array.isArray(input.argv) || input.argv.length < 1 ||
      input.argv.length > MAX_EXACT_ARGV_TOKENS) {
    planError('PRIVILEGED_PLAN_INVALID', `argv must contain between 1 and ${MAX_EXACT_ARGV_TOKENS} exact tokens.`, 'argv');
  }
  const argv = input.argv.map((value, index) => boundedString(value, `argv[${index}]`, {
    max: index === 0 ? 512 : 2000,
    pattern: SAFE_TOKEN,
  }));
  assertNoSensitiveArguments(argv, 'argv');
  if (exactArgvDisplay(argv).length > MAX_EXACT_ARGV_JSON_CHARS) {
    planError('PRIVILEGED_PLAN_INVALID', 'The exact argv is too long to approve by voice.', 'argv');
  }
  if (!path.posix.isAbsolute(argv[0]) || path.posix.normalize(argv[0]) !== argv[0]) {
    planError('PRIVILEGED_PLAN_INVALID', 'argv[0] must be one canonical absolute executable path.', 'argv[0]');
  }
  if (FORBIDDEN_EXACT_EXECUTABLES.has(argv[0])) {
    planError(
      'PRIVILEGED_PLAN_INVALID',
      'Exact argv cannot use a shell, interpreter, or command-dispatching executable.',
      'argv[0]'
    );
  }
  return argv;
}

function canonicalCwd(value) {
  const cwd = boundedString(value || '/', 'cwd', { max: 512, pattern: SAFE_TOKEN });
  if (!path.posix.isAbsolute(cwd) || path.posix.normalize(cwd) !== cwd) {
    planError('PRIVILEGED_PLAN_INVALID', 'cwd must be one canonical absolute path.', 'cwd');
  }
  return cwd;
}

function buildArgvEscapePlan(input) {
  const argv = escapeArgv(input);
  const cwd = canonicalCwd(input.cwd);
  const timeoutSeconds = boundedInteger(input.timeoutSeconds, 'timeoutSeconds', {
    min: 5, max: 300, fallback: 60,
  });
  return basePlan({
    adapter: 'argv',
    parameters: { argv, cwd },
    argv,
    target: 'hermes:root:exact-argv',
    cwd,
    timeoutSeconds,
    impactSummary: `HIGH RISK: executes this exact argument vector with root authority on Hermes: ${exactArgvDisplay(argv)}.`,
    riskLevel: 'high',
    expectedResult: expected(
      'The exact process must exit zero; stdout and stderr content are not persisted or returned, only digests and byte counts.'
    ),
  });
}

function buildPrivilegedActionPlan(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    planError('PRIVILEGED_PLAN_INVALID', 'A typed privileged action is required.');
  }
  const adapter = boundedString(input.adapter, 'adapter', { max: 32 });
  if (adapter === 'systemctl') return buildSystemctlPlan(input);
  if (adapter === 'journalctl') return buildJournalctlPlan(input);
  if (adapter === 'ssh') return buildSshPlan(input);
  if (adapter === 'kubectl') return buildKubectlPlan(input);
  if (adapter === 'argv') return buildArgvEscapePlan(input);
  return planError('PRIVILEGED_PLAN_INVALID', 'Unsupported privileged action adapter.', 'adapter');
}

function rebuildInput(plan) {
  const parameters = plan?.parameters || {};
  return {
    adapter: plan?.adapter,
    ...parameters,
    timeoutSeconds: plan?.timeout_seconds,
    cwd: plan?.cwd,
  };
}

function validateCanonicalPrivilegedActionPlan(plan) {
  const canonical = buildPrivilegedActionPlan(rebuildInput(plan));
  if (!isDeepStrictEqual(canonical, plan)) {
    planError('PRIVILEGED_PLAN_NONCANONICAL', 'The privileged action plan is not canonical.');
  }
  return canonical;
}

function canonicalPrivilegedActionJson(plan) {
  return canonicalizeApprovalPlan(validateCanonicalPrivilegedActionPlan(plan));
}

function privilegedActionRequestHash(plan) {
  return crypto.createHash('sha256').update(canonicalPrivilegedActionJson(plan)).digest('hex');
}

function buildPrivilegedActionApprovalPlan({ jobId, callId, actionPlan } = {}) {
  const normalizedJobId = boundedString(jobId, 'jobId', { max: 200 });
  if (!/^job_[A-Za-z0-9]+$/.test(normalizedJobId)) {
    planError('PRIVILEGED_PLAN_INVALID', 'A valid privileged job ID is required.', 'jobId');
  }
  const normalizedCallId = boundedString(callId, 'callId', { max: 200, pattern: SAFE_NAME });
  return {
    version: 1,
    kind: 'privileged_action_approval',
    method: PRIVILEGED_ACTION_METHOD,
    job_id: normalizedJobId,
    call_id: normalizedCallId,
    action_plan: validateCanonicalPrivilegedActionPlan(actionPlan),
  };
}

function privilegedActionApprovalText(plan) {
  const canonical = validateCanonicalPrivilegedActionPlan(plan);
  const highRisk = canonical.risk.level === 'high' ? 'HIGH RISK. ' : '';
  const summary = `${highRisk}Privileged ${canonical.adapter} action on ${canonical.target}: ` +
    `${canonical.argv_display}. Impact: ${canonical.impact_summary} Expected: ` +
    canonical.expected_result.description;
  const result = {
    summary,
    spoken: `${highRisk}Privileged approval required. Exact argument vector: ${canonical.argv_display}. ` +
      `Exact target: ${canonical.target}. Impact: ${canonical.impact_summary} ` +
      `Expected observable result: ${canonical.expected_result.description} ` +
      'Press pound to approve this exact action, or star to cancel.',
  };
  const wordCount = result.spoken.split(/\s+/).filter(Boolean).length;
  if (result.spoken.length > MAX_APPROVAL_PROMPT_CHARS ||
      wordCount > MAX_APPROVAL_PROMPT_WORDS) {
    planError(
      'PRIVILEGED_APPROVAL_UNSPEAKABLE',
      'The exact privileged approval scope is too long to speak without truncation.'
    );
  }
  return result;
}

module.exports = {
  FORBIDDEN_EXACT_EXECUTABLES,
  FORBIDDEN_WINDOWS_EXACT_EXECUTABLES,
  JOURNALCTL,
  MAX_APPROVAL_PROMPT_CHARS,
  MAX_APPROVAL_PROMPT_WORDS,
  MAX_EXACT_ARGV_JSON_CHARS,
  MAX_EXACT_ARGV_TOKENS,
  PRIVILEGED_ACTION_METHOD,
  PRIVILEGED_ACTION_PROFILE,
  PRIVILEGED_ACTION_PROVIDER,
  PrivilegedActionPlanError,
  SSH,
  SYSTEMCTL,
  buildPrivilegedActionApprovalPlan,
  buildPrivilegedActionPlan,
  canonicalPrivilegedActionJson,
  exactArgvDisplay,
  privilegedActionApprovalText,
  privilegedActionRequestHash,
  validateCanonicalPrivilegedActionPlan,
};
