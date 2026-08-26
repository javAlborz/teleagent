import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getDockerComposePath,
  getEnvPath,
  saveConfig
} from './config.js';
import { buildAgentServerEnvironment } from './agents.js';
import {
  ensureRuntimeSecrets,
  getRuntimeSecretEnvironment
} from './runtime-security.js';
import {
  normalizeMediaRuntimeIdentities,
  normalizeVoiceRuntimeIdentity,
  resolveMediaRuntimeIdentities,
  resolveVoiceRuntimeIdentity,
  VOICE_RUNTIME_PATH_BINDINGS,
} from './voice-runtime-identity.js';
const DRACHTIO_SERVER_IMAGE =
  'drachtio/drachtio-server:latest@sha256:c03001e7c01ead29d0026245d0b42a9ebc8eefb0ff9bd180f5ff1f72be6da457';
const DRACHTIO_SERVER_PI_IMAGE =
  'drachtio/drachtio-server:0.9.4@sha256:09e99a715df06a1e90f9f3f9a4c89f4146026b3e7f6535a9939cdd5dc97538fe';
const FREESWITCH_IMAGE =
  'drachtio/drachtio-freeswitch-mrf:latest@sha256:7a6ce26834ff1b8eb27e97f3b9db72980a511e83ef01897097ca92a0f2d5eb62';
const VOICE_DEVICE_CONFIG_DIR = VOICE_RUNTIME_PATH_BINDINGS.DEVICE_CONFIG_DIR;
const VOICE_STATE_DIR = VOICE_RUNTIME_PATH_BINDINGS.VOICE_STATE_DIR;
const VOICE_STACK_SYSTEMCTL = '/usr/bin/systemctl';
const VOICE_STACK_DOCKER = '/usr/bin/docker';
const VOICE_STACK_UNIT = 'teleagent-voice-stack.service';
const VOICE_STACK_PROJECT_LABEL = 'com.docker.compose.project=teleagent-voice';
const CANONICAL_COMPOSE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docker-compose.yml'
);

function replaceExactly(source, expected, replacement, label) {
  if (source.split(expected).length !== 2) {
    throw new Error(`Canonical voice Compose ${label} drifted`);
  }
  return source.replace(expected, replacement);
}

/**
 * Check if Docker is installed and running
 * @returns {Promise<{installed: boolean, running: boolean, error?: string}>}
 */
export async function checkDocker() {
  // Check if docker command exists
  const installed = await new Promise((resolve) => {
    const check = spawn('docker', ['--version']);
    check.on('close', (code) => resolve(code === 0));
    check.on('error', () => resolve(false));
  });

  if (!installed) {
    return {
      installed: false,
      running: false,
      error: 'Docker not found. Please install Docker from https://docs.docker.com/engine/install/'
    };
  }

  // Check if Docker daemon is running by running a simple command
  const running = await new Promise((resolve) => {
    const check = spawn('docker', ['ps', '-q'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    check.on('close', (code) => resolve(code === 0));
    check.on('error', () => resolve(false));
  });

  if (!running) {
    return {
      installed: true,
      running: false,
      error: 'Docker is installed but not running. Please start Docker Desktop.'
    };
  }

  return {
    installed: true,
    running: true
  };
}

/**
 * Generate docker-compose.yml from config
 * @param {object} config - Configuration object
 * @returns {string} Docker compose YAML content
 */
export function generateDockerCompose(config) {
  const voiceAppPath = path.resolve(config.paths.voiceApp);
  const projectRoot = path.dirname(voiceAppPath);
  const isPiMode = config.deployment && config.deployment.mode === 'pi-split';
  let compose = fs.readFileSync(CANONICAL_COMPOSE_PATH, 'utf8');

  if (isPiMode) {
    compose = replaceExactly(
      compose,
      `    image: ${DRACHTIO_SERVER_IMAGE}`,
      `    image: ${DRACHTIO_SERVER_PI_IMAGE}\n    platform: linux/arm64`,
      'Drachtio image'
    );
    compose = replaceExactly(
      compose,
      `    image: ${FREESWITCH_IMAGE}`,
      `    image: ${FREESWITCH_IMAGE}\n    platform: linux/arm64`,
      'FreeSWITCH image'
    );
  }

  for (const [relative, destination] of [
    ['entrypoint.sh', '/usr/local/bin/entrypoint-hermes-freeswitch.sh'],
    ['mrf.xml', '/usr/local/freeswitch/conf/sip_profiles/mrf.xml'],
    ['switch.conf.xml', '/usr/local/freeswitch/conf/autoload_configs/switch.conf.xml'],
  ]) {
    compose = replaceExactly(
      compose,
      `      - ./freeswitch/${relative}:${destination}:ro`,
      `      - ${JSON.stringify(`${projectRoot}/freeswitch/${relative}:${destination}:ro`)}`,
      `FreeSWITCH ${relative} bind`
    );
  }
  return compose;
}

/**
 * Generate .env file from config
 * @param {object} config - Configuration object
 * @param {object} voiceIdentity - Resolved dedicated teleagent-voice identity
 * @param {object} mediaIdentities - Resolved dedicated media peer identities
 * @returns {string} Environment file content
 */
export function generateEnvFile(config, voiceIdentity, mediaIdentities) {
  const normalizedVoiceIdentity = normalizeVoiceRuntimeIdentity(voiceIdentity);
  const normalizedMediaIdentities = normalizeMediaRuntimeIdentities(
    mediaIdentities, normalizedVoiceIdentity
  );
  const deploymentMode = String(config.deployment?.mode || '').trim();
  const installationType = String(config.installationType || '').trim();
  if (installationType === 'voice-server' ||
      deploymentMode === 'voice-server' || deploymentMode === 'pi-split') {
    throw new Error(
      'Split-host voice/controller deployment is retired; the credential-bearing controller endpoint must be co-located on 127.0.0.1.'
    );
  }
  ensureRuntimeSecrets(config);
  const runtimeSecrets = getRuntimeSecretEnvironment(config);

  // Credential-bearing voice controller traffic is fixed to the co-located
  // loopback service. Split-host voice/controller deployments are retired.
  const agentApiUrl = 'http://127.0.0.1:3333';

  const ttsConfig = config.api?.tts || {};
  const realtimeConfig = config.api?.realtime || {};
  const realtimeModel = realtimeConfig.model || 'gpt-realtime-2.1-mini';
  const realtimeVoice = realtimeConfig.voice || 'marin';
  const realtimeTranscriptionModel = realtimeConfig.transcriptionModel || 'gpt-live-transcribe';
  const realtimeTranscriptionPrompt = realtimeConfig.transcriptionPrompt ||
    'A private operator call about Teleagent on the phone through Linphone, Hermes, a homelab, repositories, the main tmux session, windows, panes, Claude Code, Codex, Kubernetes, and infrastructure.';
  const realtimeTranscriptionKeywords = Array.isArray(realtimeConfig.transcriptionKeywords)
    ? realtimeConfig.transcriptionKeywords.join(',')
    : (realtimeConfig.transcriptionKeywords || 'Hermes,Teleagent,homelab,tmux,Claude Code,Codex,Haiku,Sonnet,Opus,Luna,Terra,Sol,Kubernetes,phone,Linphone,main,window,pane,phone-infra,FreeSWITCH,drachtio');
  const realtimeMaxSpokenWords = realtimeConfig.maxSpokenWords || 35;
  const realtimeHardMaxSpokenWords = realtimeConfig.hardMaxSpokenWords || 240;
  const realtimeContextTokenLimit = realtimeConfig.contextTokenLimit || 16000;
  const realtimeContextRetentionRatio = realtimeConfig.contextRetentionRatio || 0.8;
  const primaryDevice = config.devices?.[0] || {};
  const defaultVoice = primaryDevice.voiceId || ttsConfig.defaultVoice || 'af_bella';
  const agentEnvironment = buildAgentServerEnvironment(config, {});
  const lines = [
    '# ====================================',
    '# This file contains reviewed non-voice settings only.',
    '# Voice credentials are projected from protected files at runtime.',
    '# ====================================',
    '# Teleagent Configuration',
    '# Generated by claude-phone CLI',
    '# ====================================',
    '',
    '# Network Configuration',
    `VOICE_APP_UID=${normalizedVoiceIdentity.uid}`,
    `VOICE_APP_GID=${normalizedVoiceIdentity.gid}`,
    `DRACHTIO_UID=${normalizedMediaIdentities.drachtio.uid}`,
    `DRACHTIO_GID=${normalizedMediaIdentities.drachtio.gid}`,
    `FREESWITCH_UID=${normalizedMediaIdentities.freeswitch.uid}`,
    `FREESWITCH_GID=${normalizedMediaIdentities.freeswitch.gid}`,
    `DEVICE_CONFIG_DIR=${VOICE_DEVICE_CONFIG_DIR}`,
    `VOICE_STATE_DIR=${VOICE_STATE_DIR}`,
    '# SIP/media control and callback routes are fixed in Compose.',
    '',
    '# Agent API Server (voice traffic is fixed to loopback)',
    `AGENT_API_URL=${agentApiUrl}`,
    `AGENT_API_BIND_HOST=${config.server?.agentApiBindHost || '127.0.0.1'}`,
    `AGENT_API_NON_LOOPBACK_ENABLED=${config.server?.agentApiNonLoopbackEnabled === true}`,
    `AGENT_API_TOKEN=${runtimeSecrets.AGENT_API_TOKEN}`,
    'AGENT_DURABLE_EXECUTOR_ENABLED=true',
    '',
    '# Agent Providers',
    `AGENT_PROVIDERS=${agentEnvironment.AGENT_PROVIDERS}`,
    `CLAUDE_COMMAND=${agentEnvironment.CLAUDE_COMMAND}`,
    `CLAUDE_WORKING_DIR=${agentEnvironment.CLAUDE_WORKING_DIR}`,
    `CODEX_COMMAND=${agentEnvironment.CODEX_COMMAND}`,
    `CODEX_WORKING_DIR=${agentEnvironment.CODEX_WORKING_DIR}`,
    `PHONE_CODEX_APPROVAL_POLICY=${agentEnvironment.PHONE_CODEX_APPROVAL_POLICY}`,
    `PHONE_CODEX_LUNA_MODEL=${agentEnvironment.PHONE_CODEX_LUNA_MODEL}`,
    `PHONE_CODEX_LUNA_REASONING_EFFORT=${agentEnvironment.PHONE_CODEX_LUNA_REASONING_EFFORT}`,
    `PHONE_CODEX_LUNA_SANDBOX=${agentEnvironment.PHONE_CODEX_LUNA_SANDBOX}`,
    `PHONE_CODEX_LUNA_WORKING_DIR=${agentEnvironment.PHONE_CODEX_LUNA_WORKING_DIR}`,
    `PHONE_CODEX_TERRA_MODEL=${agentEnvironment.PHONE_CODEX_TERRA_MODEL}`,
    `PHONE_CODEX_TERRA_REASONING_EFFORT=${agentEnvironment.PHONE_CODEX_TERRA_REASONING_EFFORT}`,
    `PHONE_CODEX_TERRA_SANDBOX=${agentEnvironment.PHONE_CODEX_TERRA_SANDBOX}`,
    `PHONE_CODEX_TERRA_WORKING_DIR=${agentEnvironment.PHONE_CODEX_TERRA_WORKING_DIR}`,
    `PHONE_CODEX_SOL_MODEL=${agentEnvironment.PHONE_CODEX_SOL_MODEL}`,
    `PHONE_CODEX_SOL_REASONING_EFFORT=${agentEnvironment.PHONE_CODEX_SOL_REASONING_EFFORT}`,
    `PHONE_CODEX_SOL_SANDBOX=${agentEnvironment.PHONE_CODEX_SOL_SANDBOX}`,
    `PHONE_CODEX_SOL_WORKING_DIR=${agentEnvironment.PHONE_CODEX_SOL_WORKING_DIR}`,
    `PHONE_CODEX_DEPLOY_MODEL=${agentEnvironment.PHONE_CODEX_DEPLOY_MODEL}`,
    `PHONE_CODEX_DEPLOY_REASONING_EFFORT=${agentEnvironment.PHONE_CODEX_DEPLOY_REASONING_EFFORT}`,
    `PHONE_CODEX_DEPLOY_SANDBOX=${agentEnvironment.PHONE_CODEX_DEPLOY_SANDBOX}`,
    `PHONE_CODEX_DEPLOY_WORKING_DIR=${agentEnvironment.PHONE_CODEX_DEPLOY_WORKING_DIR}`,
    '',
    '# OpenAI Realtime Voice Conductor',
    `OPENAI_REALTIME_MODEL=${realtimeModel}`,
    `OPENAI_REALTIME_VOICE=${realtimeVoice}`,
    `OPENAI_REALTIME_TRANSCRIPTION_MODEL=${realtimeTranscriptionModel}`,
    `OPENAI_REALTIME_TRANSCRIPTION_PROMPT=${realtimeTranscriptionPrompt}`,
    `OPENAI_REALTIME_TRANSCRIPTION_KEYWORDS=${realtimeTranscriptionKeywords}`,
    'OPENAI_REALTIME_TRANSCRIPTION_LANGUAGES=en',
    'OPENAI_REALTIME_TRANSCRIPTION_DELAY=medium',
    `OPENAI_REALTIME_MAX_SPOKEN_WORDS=${realtimeMaxSpokenWords}`,
    `OPENAI_REALTIME_HARD_MAX_SPOKEN_WORDS=${realtimeHardMaxSpokenWords}`,
    `OPENAI_REALTIME_CONTEXT_TOKEN_LIMIT=${realtimeContextTokenLimit}`,
    `OPENAI_REALTIME_CONTEXT_RETENTION_RATIO=${realtimeContextRetentionRatio}`,
    '',
    '# Legacy local TTS/STT are disabled in hardened production.',
    'LEGACY_SPEECH_SERVICES_ENABLED=false',
    `TTS_VOICE=${defaultVoice}`,
    '',
    '# Application Settings',
    `HTTP_PORT=${config.server.httpPort}`,
    'WS_PORT=3001',
    '',
    '# Outbound Call Settings',
    'MAX_CONVERSATION_TURNS=10',
    'OUTBOUND_RING_TIMEOUT=30',
    ''
  ];

  return lines.join('\n');
}

/**
 * Write Docker configuration files
 * @param {object} config - Configuration object
 * @returns {Promise<void>}
 */
export async function writeDockerConfig(config, {
  voiceIdentity = resolveVoiceRuntimeIdentity(),
  mediaIdentities = resolveMediaRuntimeIdentities({ voiceIdentity }),
} = {}) {
  const dockerComposePath = getDockerComposePath();
  const envPath = getEnvPath();
  const runtimeSecrets = ensureRuntimeSecrets(config);
  if (runtimeSecrets.changed) {
    await saveConfig(config);
  }

  const dockerComposeContent = generateDockerCompose(config);
  const envContent = generateEnvFile(config, voiceIdentity, mediaIdentities);

  await fs.promises.writeFile(dockerComposePath, dockerComposeContent, { mode: 0o644 });
  await fs.promises.writeFile(envPath, envContent, { mode: 0o600 });
  await fs.promises.chmod(envPath, 0o600);
}

/**
 * Start the guarded voice-stack unit. Direct Compose activation is retired so
 * the immutable-image, dependency, credential, and crash-cleanup gates cannot
 * be bypassed by the normal CLI path.
 * @returns {Promise<void>}
 */
export async function startContainers() {
  return manageVoiceStackUnit('start');
}

/**
 * Stop the guarded voice-stack unit so controller panic and ExecStopPost cleanup
 * remain part of every normal CLI shutdown.
 * @returns {Promise<void>}
 */
export async function stopContainers() {
  return manageVoiceStackUnit('stop');
}

function manageVoiceStackUnit(action) {
  if (!['start', 'stop'].includes(action)) {
    throw new Error('Unsupported guarded voice-stack operation.');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(VOICE_STACK_SYSTEMCTL, [action, VOICE_STACK_UNIT], {
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      stdio: 'ignore'
    });
    child.on('error', () => reject(new Error('The guarded voice-stack unit could not be invoked.')));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(
        `The guarded voice-stack unit refused to ${action}; inspect its fixed systemd status.`
      ));
    });
  });
}

/**
 * Get status of Docker containers
 * @returns {Promise<Array<{name: string, status: string}>>}
 */
export async function getContainerStatus() {
  return new Promise((resolve) => {
    const child = spawn(VOICE_STACK_DOCKER, [
      'container', 'ls', '--all', '--filter', `label=${VOICE_STACK_PROJECT_LABEL}`,
      '--format', '{{.Names}}\t{{.State}}\t{{.Status}}',
    ], {
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'ignore']
    });

    let output = '';
    child.stdout.on('data', (data) => {
      if (output.length <= 65536) output += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0 || output.length > 65536) {
        resolve([]);
        return;
      }
      const containers = output.trim().split('\n').filter(Boolean).map((line) => line.split('\t'))
        .filter((fields) => fields.length === 3 && fields.every((field) => field.length <= 256))
        .map(([name, state, status]) => ({ name, status: `${state} ${status}`.trim() }));
      resolve(containers);
    });
    child.on('error', () => resolve([]));
  });
}
