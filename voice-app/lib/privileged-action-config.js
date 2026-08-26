'use strict';

const {
  normalizePrivilegedActionApiToken,
} = require('./privileged-action-bridge');
const { getRuntimeSecret } = require('./runtime-secrets');

class PrivilegedActionConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrivilegedActionConfigError';
    this.code = code;
  }
}

function parseEnabled(value) {
  if (value === undefined || value === null || String(value).trim() === '') return false;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new PrivilegedActionConfigError(
    'PRIVILEGED_ACTION_INVALID_ENABLED',
    'VOICE_PRIVILEGED_ACTIONS_ENABLED must be true or false.'
  );
}

function loadPrivilegedActionConfig({ env: suppliedSettings = null, runtimeSecrets = null, approvalCapability = null } = {}) {
  const settings = suppliedSettings || process.env;
  const enabled = parseEnabled(settings.VOICE_PRIVILEGED_ACTIONS_ENABLED);
  if (!enabled) return Object.freeze({ enabled: false, apiToken: null });
  if (!approvalCapability?.enabled || !approvalCapability?.issuer) {
    throw new PrivilegedActionConfigError(
      'PRIVILEGED_ACTION_APPROVAL_DISABLED',
      'Privileged voice actions require signed approval capabilities.'
    );
  }
  const apiToken = normalizePrivilegedActionApiToken(
    runtimeSecrets?.privilegedActionApiToken ||
      (suppliedSettings
        ? suppliedSettings.PRIVILEGED_ACTION_API_TOKEN
        : getRuntimeSecret('privilegedActionApiToken'))
  );
  if (!apiToken) {
    throw new PrivilegedActionConfigError(
      'PRIVILEGED_ACTION_AUTH_NOT_CONFIGURED',
      'PRIVILEGED_ACTION_API_TOKEN must be a clean dedicated token from 32 to 4096 bytes.'
    );
  }
  return Object.freeze({ enabled: true, apiToken });
}

module.exports = {
  PrivilegedActionConfigError,
  loadPrivilegedActionConfig,
};
