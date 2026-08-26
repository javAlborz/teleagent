'use strict';

const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const {
  FORBIDDEN_EXACT_EXECUTABLES,
  FORBIDDEN_WINDOWS_EXACT_EXECUTABLES,
  JOURNALCTL,
  SSH,
  SYSTEMCTL,
  validateCanonicalPrivilegedActionPlan,
} = require('../lib/privileged-action-plan');

const MAX_POLICY_BYTES = 128 * 1024;
const SAFE_ROOT = /^\/(?:[A-Za-z0-9_.+-]+\/)*[A-Za-z0-9_.+-]+$/;
const SAFE_WINDOWS_ROOT = /^[A-Za-z]:\/(?:[A-Za-z0-9_.+-]+\/)*[A-Za-z0-9_.+-]+$/;

class PrivilegedActionPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrivilegedActionPolicyError';
    this.code = code;
  }
}

function policyError(code, message) {
  throw new PrivilegedActionPolicyError(code, message);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    policyError('PRIVILEGED_POLICY_INVALID', `${label} must be a plain object.`);
  }
  return value;
}

function stringArray(value, label, { max = 1000 } = {}) {
  if (!Array.isArray(value) || value.length > max ||
      value.some((entry) => typeof entry !== 'string' || !entry || entry.length > 512)) {
    policyError('PRIVILEGED_POLICY_INVALID', `${label} must be a bounded string array.`);
  }
  return [...new Set(value)];
}

function adapterPolicy(document, adapter) {
  return plainObject(document.adapters?.[adapter], `adapters.${adapter}`);
}

function assertEnabled(config, adapter) {
  if (config.enabled !== true) {
    policyError('PRIVILEGED_ACTION_DENIED', `The ${adapter} privileged adapter is disabled.`);
  }
}

function validatePolicyDocument(input) {
  const policy = plainObject(input, 'policy');
  if (policy.version !== 1 || policy.enabled !== true) {
    policyError('PRIVILEGED_POLICY_DISABLED', 'Privileged action policy must be version 1 and explicitly enabled.');
  }
  plainObject(policy.adapters, 'adapters');
  for (const adapter of ['systemctl', 'journalctl', 'ssh', 'kubectl', 'argv']) {
    const config = adapterPolicy(policy, adapter);
    if (typeof config.enabled !== 'boolean') {
      policyError('PRIVILEGED_POLICY_INVALID', `adapters.${adapter}.enabled must be boolean.`);
    }
  }
  if (adapterPolicy(policy, 'systemctl').executable !== SYSTEMCTL ||
      adapterPolicy(policy, 'journalctl').executable !== JOURNALCTL ||
      adapterPolicy(policy, 'ssh').executable !== SSH ||
      adapterPolicy(policy, 'kubectl').ssh_executable !== SSH) {
    policyError('PRIVILEGED_POLICY_INVALID', 'Adapter executable paths must match the canonical root-broker paths.');
  }
  const argv = adapterPolicy(policy, 'argv');
  if (argv.unlisted_mode !== undefined && argv.unlisted_mode !== 'disabled') {
    policyError(
      'PRIVILEGED_POLICY_INVALID',
      'Unlisted exact argv execution is permanently disabled; use one exact pre-reviewed rule.'
    );
  }
  const roots = stringArray(argv.allowed_executable_roots || [], 'argv.allowed_executable_roots');
  if (roots.some((root) => !SAFE_ROOT.test(root))) {
    policyError('PRIVILEGED_POLICY_INVALID', 'argv executable roots must be canonical absolute paths.');
  }
  return policy;
}

function allowedUnitActions(config, unit) {
  const units = plainObject(config.units, 'adapter units');
  return stringArray(units[unit] || [], `units.${unit}`);
}

function validateSystemctl(plan, policy) {
  const config = adapterPolicy(policy, 'systemctl');
  assertEnabled(config, 'systemctl');
  const { action, unit } = plan.parameters;
  if (!allowedUnitActions(config, unit).includes(action)) {
    policyError('PRIVILEGED_ACTION_DENIED', `systemctl ${action} is not allowed for ${unit}.`);
  }
}

function validateJournalctl(plan, policy) {
  const config = adapterPolicy(policy, 'journalctl');
  assertEnabled(config, 'journalctl');
  if (!stringArray(config.units || [], 'journalctl.units').includes(plan.parameters.unit)) {
    policyError('PRIVILEGED_ACTION_DENIED', `Journal access is not allowed for ${plan.parameters.unit}.`);
  }
  const maxLines = Number.parseInt(config.max_lines, 10);
  if (!Number.isInteger(maxLines) || maxLines < 1 || plan.parameters.lines > maxLines) {
    policyError('PRIVILEGED_ACTION_DENIED', 'The requested journal line count exceeds policy.');
  }
}

function validateSsh(plan, policy) {
  const config = adapterPolicy(policy, 'ssh');
  assertEnabled(config, 'ssh');
  const hostPolicy = plainObject(config.hosts?.[plan.parameters.host], 'ssh host policy');
  const expectedOs = plan.parameters.host === 'zeus' ? 'windows' : 'linux';
  if (hostPolicy.os !== expectedOs) {
    policyError('PRIVILEGED_POLICY_INVALID', `SSH host ${plan.parameters.host} has the wrong operating-system policy.`);
  }
  const remoteAction = plan.parameters.remoteAction;
  if (!stringArray(hostPolicy.actions || [], 'ssh host actions').includes(remoteAction)) {
    policyError('PRIVILEGED_ACTION_DENIED', `SSH action ${remoteAction} is not allowed on ${plan.parameters.host}.`);
  }
  if (plan.parameters.unit &&
      !stringArray(hostPolicy.systemd_units || [], 'ssh systemd units')
      .includes(plan.parameters.unit)) {
    policyError('PRIVILEGED_ACTION_DENIED', `SSH systemd unit ${plan.parameters.unit} is not allowed.`);
  }
  if (remoteAction === 'exact_argv') {
    if (plan.risk.level !== 'high') {
      policyError('PRIVILEGED_ACTION_DENIED', 'Exact remote argv actions must remain high risk.');
    }
    const exactRules = Array.isArray(hostPolicy.exact_rules) ? hostPolicy.exact_rules : [];
    if (exactRules.length > 100) {
      policyError('PRIVILEGED_POLICY_INVALID', 'SSH exact_rules must be a bounded array.');
    }
    const remoteArgv = plan.parameters.remoteArgv;
    const exactMatch = exactRules.some((rule) => isDeepStrictEqual(rule, remoteArgv));
    if (hostPolicy.allow_unlisted_exact_argv === true) {
      policyError(
        'PRIVILEGED_POLICY_INVALID',
        'Unlisted exact remote argv execution is permanently disabled.'
      );
    }
    if (!exactMatch) {
      policyError('PRIVILEGED_ACTION_DENIED', 'The exact remote argv is not listed in policy.');
    }
    validateExactRemoteExecutable(remoteArgv, hostPolicy);
  }
}

function validateExactRemoteExecutable(argv, hostPolicy) {
  if (!Array.isArray(argv) || argv.length < 1) {
    policyError('PRIVILEGED_ACTION_DENIED', 'An exact remote argv is required.');
  }
  let executable = argv[0];
  if (executable === '/usr/bin/sudo') {
    if (hostPolicy.os !== 'linux' || hostPolicy.allow_sudo !== true ||
        argv[1] !== '-n' || argv.length < 3) {
      policyError('PRIVILEGED_ACTION_DENIED', 'Remote sudo requires the exact noninteractive policy prefix.');
    }
    executable = argv[2];
  }
  const windows = hostPolicy.os === 'windows';
  const comparableExecutable = windows ? executable.toLowerCase() : executable;
  const syntacticallySafe = windows
    ? SAFE_WINDOWS_ROOT.test(executable)
    : SAFE_ROOT.test(executable);
  const forbidden = windows
    ? FORBIDDEN_WINDOWS_EXACT_EXECUTABLES.has(comparableExecutable)
    : FORBIDDEN_EXACT_EXECUTABLES.has(executable);
  if (!syntacticallySafe || forbidden) {
    policyError(
      'PRIVILEGED_ACTION_DENIED',
      'The exact remote executable is a shell, interpreter, dispatcher, or unsafe path.'
    );
  }
}

function resourceKey(parameters) {
  return `${parameters.kind}/${parameters.name || '*'}`;
}

function validateKubectl(plan, policy) {
  const config = adapterPolicy(policy, 'kubectl');
  assertEnabled(config, 'kubectl');
  if (config.host !== 'hera' || config.remote_kubectl !== '/usr/local/bin/kubectl') {
    policyError('PRIVILEGED_POLICY_INVALID', 'Kubectl must use the approved Hera route and canonical remote path.');
  }
  const namespace = plainObject(
    config.namespaces?.[plan.parameters.namespace],
    'kubectl namespace policy'
  );
  const allowed = stringArray(
    namespace[plan.parameters.operation] || [],
    `kubectl.${plan.parameters.operation}`
  );
  if (!allowed.includes(resourceKey(plan.parameters))) {
    policyError(
      'PRIVILEGED_ACTION_DENIED',
      `Kubernetes ${plan.parameters.operation} is not allowed for ${resourceKey(plan.parameters)}.`
    );
  }
  if (plan.parameters.operation === 'scale') {
    const maximum = Number.parseInt(namespace.max_replicas, 10);
    if (!Number.isInteger(maximum) || maximum < 0 || plan.parameters.replicas > maximum) {
      policyError('PRIVILEGED_ACTION_DENIED', 'The requested replica count exceeds policy.');
    }
  }
}

function validateArgv(plan, policy) {
  const config = adapterPolicy(policy, 'argv');
  assertEnabled(config, 'exact argv escape');
  if (plan.risk.level !== 'high') {
    policyError('PRIVILEGED_ACTION_DENIED', 'Exact argv escape actions must remain high risk.');
  }
  if (!Array.isArray(config.exact_rules) || config.exact_rules.length > 100) {
    policyError('PRIVILEGED_POLICY_INVALID', 'argv.exact_rules must be a bounded array.');
  }
  const matched = config.exact_rules.some((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
    return isDeepStrictEqual(rule.argv, plan.argv) && rule.cwd === plan.cwd;
  });
  if (!matched) {
    policyError('PRIVILEGED_ACTION_DENIED', 'The exact root argv and cwd are not listed in policy.');
  }
  if (FORBIDDEN_EXACT_EXECUTABLES.has(plan.argv[0])) {
    policyError(
      'PRIVILEGED_ACTION_DENIED',
      'Shells, interpreters, and command-dispatching executables are denied even in exact rules.'
    );
  }
}

function validatePlanAgainstPolicy(actionPlan, policyDocument) {
  const plan = validateCanonicalPrivilegedActionPlan(actionPlan);
  const policy = validatePolicyDocument(policyDocument);
  const timeoutLimit = Number.parseInt(policy.max_timeout_seconds, 10);
  if (!Number.isInteger(timeoutLimit) || timeoutLimit < 5 ||
      plan.timeout_seconds > timeoutLimit) {
    policyError('PRIVILEGED_ACTION_DENIED', 'The requested timeout exceeds root policy.');
  }
  if (plan.adapter === 'systemctl') validateSystemctl(plan, policy);
  else if (plan.adapter === 'journalctl') validateJournalctl(plan, policy);
  else if (plan.adapter === 'ssh') validateSsh(plan, policy);
  else if (plan.adapter === 'kubectl') validateKubectl(plan, policy);
  else if (plan.adapter === 'argv') validateArgv(plan, policy);
  else policyError('PRIVILEGED_ACTION_DENIED', 'Unknown privileged adapter.');
  return plan;
}

function readRootOwnedFile(filename, {
  expectedUid = 0,
  maxBytes = MAX_POLICY_BYTES,
  fsModule = fs,
} = {}) {
  const descriptor = fsModule.openSync(
    filename,
    fsModule.constants.O_RDONLY | (fsModule.constants.O_NOFOLLOW || 0)
  );
  try {
    const stat = fsModule.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes ||
        stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
      policyError(
        'PRIVILEGED_TRUST_FILE_UNSAFE',
        'A privileged trust file has unsafe type, ownership, permissions, or size.'
      );
    }
    return fsModule.readFileSync(descriptor, 'utf8');
  } finally {
    fsModule.closeSync(descriptor);
  }
}

function loadRootOwnedPolicy(filename, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readRootOwnedFile(filename, options));
  } catch (error) {
    if (error instanceof PrivilegedActionPolicyError) throw error;
    policyError('PRIVILEGED_POLICY_INVALID', 'The privileged action policy could not be loaded.');
  }
  return validatePolicyDocument(parsed);
}

module.exports = {
  PrivilegedActionPolicyError,
  loadRootOwnedPolicy,
  readRootOwnedFile,
  FORBIDDEN_EXACT_EXECUTABLES,
  validatePlanAgainstPolicy,
  validatePolicyDocument,
};
