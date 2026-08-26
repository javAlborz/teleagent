import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
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
  normalizeVoiceRuntimeIdentity,
  resolveVoiceRuntimeIdentity,
  VOICE_RUNTIME_PATH_BINDINGS,
} from './voice-runtime-identity.js';
import voiceAppRuntimeEnv from '../../lib/voice-app-runtime-env.js';

const {
  VOICE_APP_FIXED_ENV,
  VOICE_APP_RUNTIME_ENV_GROUPS
} = voiceAppRuntimeEnv;

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

function renderVoiceAppEnvironment(indent = '      ') {
  const lines = [
    `${indent}# Fixed security boundary; never inherited from the host .env.`,
    ...Object.entries(VOICE_APP_FIXED_ENV).map(([key, value]) => (
      `${indent}${key}: ${JSON.stringify(value)}`
    )),
  ];

  for (const { name, keys } of VOICE_APP_RUNTIME_ENV_GROUPS) {
    lines.push(`${indent}# ${name}`);
    for (const key of keys) {
      lines.push(`${indent}${key}: "\${${key}:-}"`);
    }
  }

  return lines.join('\n');
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

  // Determine if running on Pi (ARM64) - use specific versions with platform
  const isPiMode = config.deployment && config.deployment.mode === 'pi-split';
  const drachtioImage = isPiMode ? DRACHTIO_SERVER_PI_IMAGE : DRACHTIO_SERVER_IMAGE;
  const freeswitchImage = FREESWITCH_IMAGE;
  const platformLine = isPiMode ? '\n    platform: linux/arm64' : '';
  const voiceAppEnvironment = renderVoiceAppEnvironment();

  return `# CRITICAL: SIP/media containers use network_mode: host. The one-shot
# control credential preflight has no network namespace at all.

services:
  voice-runtime-preflight:
    # Production activation injects this only after verifying the root-owned
    # release manifest and the locally resolved immutable image identity.
    image: "\${TELEAGENT_VOICE_IMAGE:?TELEAGENT_VOICE_IMAGE must be an approved OCI digest}"
    restart: "no"
    network_mode: none
    user: "\${VOICE_APP_UID:?VOICE_APP_UID must resolve teleagent-voice}:\${VOICE_APP_GID:?VOICE_APP_GID must resolve teleagent-voice}"
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,uid=\${VOICE_APP_UID:?VOICE_APP_UID must resolve teleagent-voice},gid=\${VOICE_APP_GID:?VOICE_APP_GID must resolve teleagent-voice},mode=0700,size=16777216
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    volumes:
      - "\${DEVICE_CONFIG_DIR:?DEVICE_CONFIG_DIR must be provisioned}:/app/config:ro"
      - "\${VOICE_STATE_DIR:?VOICE_STATE_DIR must be provisioned}:/app/state"
      - /run/teleagent-voice-stack/voice-secrets:/run/secrets:ro
    command: ["node", "voice-runtime-preflight.js"]

  drachtio:
    image: ${drachtioImage}${platformLine}
    container_name: drachtio
    restart: "no"
    ulimits:
      core: 0
    mem_limit: 384m
    memswap_limit: 512m
    cpus: 1.0
    pids_limit: 256
    network_mode: host
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp
    volumes:
      - /run/teleagent-voice-stack/drachtio.conf.xml:/etc/drachtio.conf.xml:ro
    command: ["drachtio", "-f", "/etc/drachtio.conf.xml"]
    depends_on:
      voice-runtime-preflight:
        condition: service_completed_successfully

  freeswitch:
    image: ${freeswitchImage}${platformLine}
    container_name: freeswitch
    restart: "no"
    ulimits:
      core: 0
    mem_limit: 1g
    memswap_limit: 1280m
    cpus: 2.0
    pids_limit: 1024
    network_mode: host
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp
    entrypoint: /usr/local/bin/entrypoint-hermes-freeswitch.sh
    volumes:
      - ${JSON.stringify(`${projectRoot}/freeswitch/entrypoint.sh:/usr/local/bin/entrypoint-hermes-freeswitch.sh:ro`)}
      - ${JSON.stringify(`${projectRoot}/freeswitch/mrf.xml:/usr/local/freeswitch/conf/sip_profiles/mrf.xml:ro`)}
      - /run/teleagent-voice-stack/freeswitch-event-socket.conf.xml:/usr/local/freeswitch/conf/autoload_configs/event_socket.conf.xml:ro
    command: >
      freeswitch
      --sip-port 5080
      --rtp-range-start 30000
      --rtp-range-end 30100
    # RTP ports 30000-30100 avoid conflict with the local PBX.
    depends_on:
      voice-runtime-preflight:
        condition: service_completed_successfully

  voice-app:
    image: "\${TELEAGENT_VOICE_IMAGE:?TELEAGENT_VOICE_IMAGE must be an approved OCI digest}"
    container_name: voice-app
    restart: "no"
    ulimits:
      core: 0
    mem_limit: 1g
    memswap_limit: 1280m
    cpus: 2.0
    pids_limit: 512
    network_mode: host
    user: "\${VOICE_APP_UID:?VOICE_APP_UID must resolve teleagent-voice}:\${VOICE_APP_GID:?VOICE_APP_GID must resolve teleagent-voice}"
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,uid=\${VOICE_APP_UID:?VOICE_APP_UID must resolve teleagent-voice},gid=\${VOICE_APP_GID:?VOICE_APP_GID must resolve teleagent-voice},mode=0700,size=536870912
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    environment:
${voiceAppEnvironment}
    volumes:
      - "\${DEVICE_CONFIG_DIR:?DEVICE_CONFIG_DIR must be provisioned}:/app/config:ro"
      - "\${VOICE_STATE_DIR:?VOICE_STATE_DIR must be provisioned}:/app/state"
      - /run/teleagent-voice-stack/voice-secrets:/run/secrets:ro
    depends_on:
      - drachtio
      - freeswitch
`;
}

/**
 * Generate .env file from config
 * @param {object} config - Configuration object
 * @param {object} voiceIdentity - Resolved dedicated teleagent-voice identity
 * @returns {string} Environment file content
 */
export function generateEnvFile(config, voiceIdentity) {
  const normalizedVoiceIdentity = normalizeVoiceRuntimeIdentity(voiceIdentity);
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
    `DEVICE_CONFIG_DIR=${VOICE_DEVICE_CONFIG_DIR}`,
    `VOICE_STATE_DIR=${VOICE_STATE_DIR}`,
    '# SIP/media control and callback routes are fixed in Compose.',
    '',
    '# Agent API Server (voice traffic is fixed to loopback)',
    `AGENT_API_URL=${agentApiUrl}`,
    `AGENT_API_BIND_HOST=${config.server?.agentApiBindHost || '127.0.0.1'}`,
    `AGENT_API_NON_LOOPBACK_ENABLED=${config.server?.agentApiNonLoopbackEnabled === true}`,
    `AGENT_API_TOKEN=${runtimeSecrets.AGENT_API_TOKEN}`,
    'PRIVILEGED_ACTION_PROXY_ENABLED=false',
    'VOICE_PRIVILEGED_ACTIONS_ENABLED=false',
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
    'VOICE_STATE_DB_PATH=/app/state/voice-state.sqlite',
    'VOICE_APPROVAL_CAPABILITY_ENABLED=false',
    '',
    '# Legacy local TTS/STT are disabled in hardened production.',
    'LEGACY_SPEECH_SERVICES_ENABLED=false',
    `TTS_VOICE=${defaultVoice}`,
    '',
    '# Application Settings',
    'HTTP_HOST=127.0.0.1',
    `HTTP_PORT=${config.server.httpPort}`,
    'WS_HOST=127.0.0.1',
    'WS_CONNECT_HOST=127.0.0.1',
    'WS_NON_LOOPBACK_ENABLED=false',
    'WS_PORT=3001',
    '',
    '# Outbound Call Settings',
    'MAX_CONVERSATION_TURNS=10',
    'OUTBOUND_RING_TIMEOUT=30',
    'OUTBOUND_API_NON_LOOPBACK_ENABLED=false',
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
} = {}) {
  const dockerComposePath = getDockerComposePath();
  const envPath = getEnvPath();
  const runtimeSecrets = ensureRuntimeSecrets(config);
  if (runtimeSecrets.changed) {
    await saveConfig(config);
  }

  const dockerComposeContent = generateDockerCompose(config);
  const envContent = generateEnvFile(config, voiceIdentity);

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
