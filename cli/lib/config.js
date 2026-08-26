import fs from 'fs';
import path from 'path';
import os from 'os';
import { normalizeAgentConfig } from './agents.js';
import { ensureRuntimeSecrets } from './runtime-security.js';

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
 * Load configuration from disk
 * @returns {Promise<object>} Configuration object
 */
export async function loadConfig() {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    throw new Error('Configuration not found. Run "claude-phone setup" first.');
  }

  const data = await fs.promises.readFile(configPath, 'utf8');
  const config = JSON.parse(data);

  // Ensure installationType exists for backward compatibility
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

  // Migrate older configs before any controller or voice process is started.
  // Without persisted shared credentials, separate CLI invocations would
  // generate different bearers and either fail open or make the stack unusable.
  const runtimeSecrets = ensureRuntimeSecrets(config);
  if (runtimeSecrets.changed || removedLegacySipAuthentication ||
      removedLegacyMediaControlCredentials) {
    // Do not make a second on-disk copy of retired SIP registration secrets.
    await saveConfig(config, {
      backup: !removedLegacySipAuthentication && !removedLegacyMediaControlCredentials,
    });
  }

  return config;
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
