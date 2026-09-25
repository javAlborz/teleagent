'use strict';

const { assertMediaReceiverRuntime } = require('./media-receiver-runtime');

const VOICE_STATE_DB_PATH = '/app/state/voice-state.sqlite';
const VOICE_EXECUTION_LOCK_FILE = '/app/state/voice-execution.lock.json';
const VOICE_LOOPBACK_HOST = '127.0.0.1';
const RETIRED_PRIVILEGED_BEARER_ENV = 'PRIVILEGED_ACTION_API_TOKEN';
const PRIVATE_RECEIVER_ENV_KEYS = Object.freeze([
  'DRACHTIO_HOST', 'DRACHTIO_PORT', 'FREESWITCH_HOST', 'FREESWITCH_PORT',
  'SIP_TRUNK_HOST', 'SIP_TRUNK_PORT', 'SIP_TRUNK_TRANSPORT',
  'WS_HOST', 'WS_CONNECT_HOST', 'WS_PORT', 'WS_NON_LOOPBACK_ENABLED', 'WS_ALLOWED_PEERS',
]);

// Production Compose must never inherit the repository-wide .env wholesale.
// This is the complete, reviewable set of host-provided settings that the
// voice-app process is allowed to receive. Keep keys grouped for readable
// generated Compose output; the drift test verifies the list against actual
// production process.env references.
const VOICE_APP_RUNTIME_ENV_GROUPS = Object.freeze([
  Object.freeze({
    name: 'Agent bridge and scoped capabilities',
    keys: Object.freeze([
      'AGENT_PROVIDERS',
      'AGENT_DURABLE_EXECUTOR_ENABLED',
      'AGENT_DURABLE_EXECUTOR_POLL_MS',
      'AGENT_DURABLE_EXECUTOR_SUBMIT_TIMEOUT_MS',
      'PHONE_DEPLOY_TIMEOUT_SECONDS',
    ]),
  }),
  Object.freeze({
    name: 'SIP and media services',
    keys: Object.freeze([
      'DEFAULT_CALLER_ID',
    ]),
  }),
  Object.freeze({
    name: 'OpenAI Realtime',
    keys: Object.freeze([
      'OPENAI_ORGANIZATION',
      'OPENAI_PROJECT',
      'OPENAI_REALTIME_CONTEXT_RETENTION_RATIO',
      'OPENAI_REALTIME_CONTEXT_TOKEN_LIMIT',
      'OPENAI_REALTIME_HARD_MAX_SPOKEN_WORDS',
      'OPENAI_REALTIME_MAX_SPOKEN_WORDS',
      'OPENAI_REALTIME_NOISE_REDUCTION',
      'OPENAI_REALTIME_RESPONSE_DEBOUNCE_MS',
      'OPENAI_REALTIME_TRANSCRIPTION_DELAY',
      'OPENAI_REALTIME_TRANSCRIPTION_KEYWORDS',
      'OPENAI_REALTIME_TRANSCRIPTION_LANGUAGES',
      'OPENAI_REALTIME_TRANSCRIPTION_PROMPT',
    ]),
  }),
  Object.freeze({
    name: 'Legacy TTS and STT',
    keys: Object.freeze([
      'LEGACY_SPEECH_SERVICES_ENABLED',
      'TTS_ALLOWED_VOICES',
      'TTS_RESPONSE_FORMAT',
      'TTS_SPEED',
      'TTS_TIMEOUT_MS',
      'TTS_VOICE',
    ]),
  }),
  Object.freeze({
    name: 'Voice HTTP, AudioFork, and durable lifecycle',
    keys: Object.freeze([
      'AUDIO_DEBUG',
      'DEBUG',
      'HTTP_PORT',
      'VOICE_CALLBACK_LEASE_MS',
      'VOICE_CALLBACK_RETRY_BASE_MS',
      'VOICE_CALLBACK_RETRY_MAX_MS',
      'VOICE_JOB_RECONCILIATION_BASE_MS',
      'VOICE_JOB_RECONCILIATION_MAX_MS',
      'VOICE_JOB_RECONCILIATION_POLL_MS',
      'WS_PORT',
    ]),
  }),
]);

const VOICE_APP_RUNTIME_ENV_KEYS = Object.freeze(
  VOICE_APP_RUNTIME_ENV_GROUPS.flatMap(({ keys }) => keys)
);

// These values are deliberately not configurable through the repository .env.
// The general bridge bearers are absent from voice-app, sensitive prompt/session
// logging stays disabled, and authority-bearing approval features stay disabled
// until an independent PBX-side attester exists.
const VOICE_APP_FIXED_ENV = Object.freeze({
  AGENT_API_URL: 'http://127.0.0.1:3333',
  AGENT_API_TOKEN: '',
  AUDIO_DIR: '/tmp/voice-audio',
  CLAUDE_API_TOKEN: '',
  CLAUDE_API_URL: '',
  AGENT_LOG_SENSITIVE: 'false',
  CLAUDE_LOG_SENSITIVE: 'false',
  DRACHTIO_HOST: '127.0.0.1',
  DRACHTIO_PORT: '9022',
  FREESWITCH_HOST: '127.0.0.1',
  FREESWITCH_PORT: '8021',
  HTTP_HOST: VOICE_LOOPBACK_HOST,
  OPENAI_REALTIME_BASE_URL: 'wss://api.openai.com/v1/realtime',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-2.1-mini',
  OPENAI_REALTIME_TRANSCRIPTION_MODEL: 'gpt-live-transcribe',
  OPENAI_REALTIME_VOICE: 'marin',
  STT_BASE_URL: 'http://127.0.0.1:18001/v1',
  STT_MODEL: 'whisper-1',
  TTS_BASE_URL: 'http://127.0.0.1:18000/v1',
  TTS_MODEL: 'kokoro',
  SIP_TRUNK_HOST: '127.0.0.1',
  SIP_TRUNK_PORT: '5060',
  SIP_TRUNK_TRANSPORT: 'udp',
  NODE_ENV: 'production',
  VOICE_APPROVAL_CAPABILITY_ENABLED: 'false',
  VOICE_PRIVILEGED_ACTIONS_ENABLED: 'false',
  OUTBOUND_API_NON_LOOPBACK_ENABLED: 'false',
  VOICE_APP_EXECUTION_LOCK_FILE: VOICE_EXECUTION_LOCK_FILE,
  VOICE_STATE_DB_PATH,
  WS_ALLOWED_PEERS: '',
  WS_CONNECT_HOST: VOICE_LOOPBACK_HOST,
  WS_HOST: VOICE_LOOPBACK_HOST,
  WS_NON_LOOPBACK_ENABLED: 'false',
});

/**
 * Prove that the container received the exact durable-state and listener
 * settings admitted for this process. The control HTTP listener stays on
 * loopback; private media receivers must match the protected host admission.
 * A missing or drifted Compose projection fails before SQLite or a listener
 * opens.
 */
function assertVoiceAppRuntimeEnvironment(environment, mediaRuntime = null) {
  const receiver = mediaRuntime === null ? null : assertMediaReceiverRuntime(mediaRuntime);
  const admitted = receiver?.voiceEnvironment;
  const fixedListener = receiver === null ? {
    WS_HOST: VOICE_LOOPBACK_HOST,
    WS_CONNECT_HOST: VOICE_LOOPBACK_HOST,
    WS_ALLOWED_PEERS: '',
    WS_NON_LOOPBACK_ENABLED: 'false',
  } : admitted;
  const retiredPrivilegedBearer = environment?.[RETIRED_PRIVILEGED_BEARER_ENV];
  if (!environment || typeof environment !== 'object' ||
      (retiredPrivilegedBearer !== undefined && String(retiredPrivilegedBearer) !== '') ||
      environment.VOICE_STATE_DB_PATH !== VOICE_STATE_DB_PATH ||
      environment.VOICE_APP_EXECUTION_LOCK_FILE !== VOICE_EXECUTION_LOCK_FILE ||
      environment.HTTP_HOST !== VOICE_LOOPBACK_HOST ||
      !fixedListener ||
      (admitted && Object.keys(admitted).sort().join(' ') !== PRIVATE_RECEIVER_ENV_KEYS.slice().sort().join(' ')) ||
      environment.WS_HOST !== fixedListener.WS_HOST ||
      environment.WS_CONNECT_HOST !== fixedListener.WS_CONNECT_HOST ||
      environment.WS_ALLOWED_PEERS !== fixedListener.WS_ALLOWED_PEERS ||
      environment.WS_NON_LOOPBACK_ENABLED !== fixedListener.WS_NON_LOOPBACK_ENABLED ||
      (admitted && Object.entries(admitted).some(([key, value]) => environment[key] !== value)) ||
      environment.VOICE_APPROVAL_CAPABILITY_ENABLED !== 'false' ||
      environment.VOICE_PRIVILEGED_ACTIONS_ENABLED !== 'false' ||
      environment.OUTBOUND_API_NON_LOOPBACK_ENABLED !== 'false') {
    const error = new Error(
      'Voice state and listener settings must match the fixed local-only application contract.'
    );
    error.code = 'VOICE_APP_RUNTIME_CONTRACT_INVALID';
    throw error;
  }
  return Object.freeze({
    stateDbPath: VOICE_STATE_DB_PATH,
    executionLockFile: VOICE_EXECUTION_LOCK_FILE,
    httpHost: VOICE_LOOPBACK_HOST,
    wsHost: fixedListener.WS_HOST,
    wsConnectHost: fixedListener.WS_CONNECT_HOST,
    wsAllowedPeers: fixedListener.WS_ALLOWED_PEERS,
    wsNonLoopbackEnabled: fixedListener.WS_NON_LOOPBACK_ENABLED === 'true',
  });
}

module.exports = {
  assertVoiceAppRuntimeEnvironment,
  VOICE_EXECUTION_LOCK_FILE,
  VOICE_APP_FIXED_ENV,
  VOICE_APP_RUNTIME_ENV_GROUPS,
  VOICE_APP_RUNTIME_ENV_KEYS,
  VOICE_STATE_DB_PATH,
};
