import fs from 'fs';
import path from 'path';
import os from 'os';
import { normalizeAgentConfig } from './agents.js';
import { ensureRuntimeSecrets } from './runtime-security.js';
import { resolveVoiceRuntimeIdentitiesForInstallation } from './voice-runtime-identity.js';

function getDefaultApiConfig() {
  return {
    tts: {
      defaultVoice: 'af_bella',
    },
    realtime: {
      enabled: false,
      apiKey: '',
      model: 'gpt-realtime-2.1-mini',
      voice: 'marin',
      transcriptionModel: 'gpt-live-transcribe',
      safetyIdentifierSalt: ''
    }
  };
}

function migrateApiConfig(config) {
  const defaults = getDefaultApiConfig();
  const api = config.api || {};
  const legacyTts = api.elevenlabs || {};

  config.api = {
    ...api,
    tts: {
      ...defaults.tts,
      ...(legacyTts.defaultVoiceId ? { defaultVoice: legacyTts.defaultVoiceId } : {}),
      ...((api.tts || {}).defaultVoice ? { defaultVoice: api.tts.defaultVoice } : {})
    },
    realtime: {
      ...defaults.realtime,
      ...(api.realtime || {}),
      enabled: api.realtime?.enabled ?? Boolean(api.realtime?.apiKey)
    }
  };

  delete config.api.elevenlabs;
  delete config.api.openai;
  delete config.api.stt;

  return config;
}

function removeLegacySipRegistration(config) {
  let changed = false;
  if (Object.hasOwn(config, 'sip')) {
    delete config.sip;
    changed = true;
  }
  if (Array.isArray(config.devices)) {
    for (const device of config.devices) {
      if (!device || typeof device !== 'object') continue;
      for (const key of ['authId', 'authPassword', 'password']) {
        if (Object.hasOwn(device, key)) {
          delete device[key];
          changed = true;
        }
      }
    }
  }
  return changed;
}

function removeLegacyMediaControlSecrets(config) {
  if (!config.secrets || typeof config.secrets !== 'object') return false;
  let changed = false;
  for (const key of ['drachtio', 'freeswitch']) {
    if (Object.hasOwn(config.secrets, key)) {
      delete config.secrets[key];
      changed = true;
    }
  }
  return changed;
}

/**
 * Get the config directory path
 * @returns {string} Path to ~/.claude-phone
 */
export function getConfigDir() {
  return path.join(os.homedir(), '.claude-phone');
}

/**
 * Get the config file path
 * @returns {string} Path to ~/.claude-phone/config.json
 */
export function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

/**
 * Check if config file exists
 * @returns {boolean} True if config exists
 */
export function configExists() {
  return fs.existsSync(getConfigPath());
}

/**
 * Read configuration without applying or persisting migrations.
 *
 * Mutating commands use this snapshot to determine whether the complete voice
 * runtime identity gate applies before loadConfig is allowed to change state.
 *
 * @returns {Promise<object>} Unmigrated configuration snapshot
 */
export async function peekConfig() {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    throw new Error('Configuration not found. Run "claude-phone setup" first.');
  }

  const data = await fs.promises.readFile(configPath, 'utf8');
  return JSON.parse(data);
}

function normalizeConfigSnapshot(snapshot, { provisionRuntimeSecrets = false } = {}) {
  // Config snapshots originate as JSON. Clone before applying migrations so a
  // read-only caller cannot mutate either its input object or on-disk bytes.
  const config = JSON.parse(JSON.stringify(snapshot));

  // Ensure installationType exists for backward compatibility.
  if (!config.installationType) {
    config.installationType = 'both';
  }

  migrateApiConfig(config);
  const removedLegacySipAuthentication = removeLegacySipRegistration(config);
  const removedLegacyMediaControlCredentials = removeLegacyMediaControlSecrets(config);
  config.agents = normalizeAgentConfig(config.agents, {
    // Existing configurations historically implied Claude-only operation.
    defaultProviders: ['claude']
  });

  const runtimeSecrets = provisionRuntimeSecrets
    ? ensureRuntimeSecrets(config)
    : { changed: false };
  return {
    config,
    removedLegacySipAuthentication,
    removedLegacyMediaControlCredentials,
    runtimeSecretsChanged: runtimeSecrets.changed,
  };
}

/**
 * Return a migrated in-memory view without provisioning credentials, mutating
 * the supplied snapshot, or writing configuration/backup files.
 *
 * Diagnostic, display, logging, and shutdown commands use this path so they
 * remain available when voice identities need repair.
 *
 * @param {object} options - Load options
 * @param {object} options.snapshot - Optional snapshot returned by peekConfig
 * @returns {Promise<object>} Non-persisted configuration view
 */
export async function loadConfigReadOnly({ snapshot } = {}) {
  const exactSnapshot = snapshot === undefined ? await peekConfig() : snapshot;
  return normalizeConfigSnapshot(exactSnapshot).config;
}

/**
 * Load configuration and persist any required migrations.
 * @param {object} options - Load options
 * @param {object} options.snapshot - Optional snapshot returned by peekConfig
 * @returns {Promise<object>} Configuration object
 */
export async function loadConfig({ snapshot } = {}) {
  // Reuse the exact preflighted snapshot when one is supplied. Reading the
  // file again here would introduce a race where an API-only snapshot could be
  // replaced with a voice configuration before migration writes begin.
  const exactSnapshot = snapshot === undefined ? await peekConfig() : snapshot;
  const {
    config,
    removedLegacySipAuthentication,
    removedLegacyMediaControlCredentials,
    runtimeSecretsChanged,
  } = normalizeConfigSnapshot(exactSnapshot, { provisionRuntimeSecrets: true });

  // Migrate older configs before any controller or voice process is started.
  // Without persisted shared credentials, separate CLI invocations would
  // generate different bearers and either fail open or make the stack unusable.
  if (runtimeSecretsChanged || removedLegacySipAuthentication ||
      removedLegacyMediaControlCredentials) {
    // Do not make a second on-disk copy of retired SIP registration secrets.
    await saveConfig(config, {
      backup: !removedLegacySipAuthentication && !removedLegacyMediaControlCredentials,
    });
  }

  return config;
}

/**
 * Resolve the complete voice/media account bundle before any migration can be
 * persisted. API-only installations are explicitly exempt by the resolver.
 *
 * @param {object} options - Guard options
 * @param {object} options.snapshot - Optional snapshot returned by peekConfig
 * @param {Function} options.identityResolver - Testable identity authority
 * @returns {Promise<{config: object, voiceRuntimeIdentities: object|null}>}
 */
export async function loadConfigWithVoiceRuntimeIdentityPreflight({
  snapshot,
  identityResolver = resolveVoiceRuntimeIdentitiesForInstallation,
} = {}) {
  const exactSnapshot = snapshot === undefined ? await peekConfig() : snapshot;
  const installationType = getInstallationType(exactSnapshot);
  const voiceRuntimeIdentities = identityResolver(installationType);
  const config = await loadConfig({ snapshot: exactSnapshot });
  return { config, voiceRuntimeIdentities };
}

/**
 * Get the installation type from config
 * @param {object} config - Configuration object
 * @returns {string} Installation type ('voice-server' | 'api-server' | 'both')
 */
export function getInstallationType(config) {
  return config.installationType || 'both';
}

/**
 * Save configuration to disk
 * @param {object} config - Configuration object
 * @returns {Promise<void>}
 */
export async function saveConfig(config, { backup = true } = {}) {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  ensureRuntimeSecrets(config);

  // Create directory if it doesn't exist
  if (!fs.existsSync(configDir)) {
    await fs.promises.mkdir(configDir, { recursive: true, mode: 0o700 });
  }

  // Backup existing config if it exists
  if (backup && fs.existsSync(configPath)) {
    const backupPath = configPath + '.backup';
    await fs.promises.copyFile(configPath, backupPath);
    await fs.promises.chmod(backupPath, 0o600);
  }

  // Add security warning to config
  const configWithWarning = {
    _WARNING: 'DO NOT SHARE THIS FILE - Contains API keys and scoped runtime credentials',
    ...config
  };

  // Write config file
  const data = JSON.stringify(configWithWarning, null, 2);
  const temporaryPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.promises.writeFile(temporaryPath, data, { mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temporaryPath, configPath);
    await fs.promises.chmod(configPath, 0o600);
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

/**
 * Get the PID file path
 * @returns {string} Path to server.pid
 */
export function getPidPath() {
  return path.join(getConfigDir(), 'server.pid');
}

/**
 * Get the docker-compose.yml path
 * @returns {string} Path to generated docker-compose.yml
 */
export function getDockerComposePath() {
  return path.join(getConfigDir(), 'docker-compose.yml');
}

/**
 * Get the .env file path
 * @returns {string} Path to generated .env
 */
export function getEnvPath() {
  return path.join(getConfigDir(), '.env');
}
