'use strict';

// Production Compose must never inherit the repository-wide .env wholesale.
// This is the complete, reviewable set of host-provided settings that the
// voice-app process is allowed to receive. Keep keys grouped for readable
// generated Compose output; the drift test verifies the list against actual
// production process.env references.
const VOICE_APP_RUNTIME_ENV_GROUPS = Object.freeze([
  Object.freeze({
    name: 'Agent bridge and scoped capabilities',
    keys: Object.freeze([
      'AGENT_DURABLE_EXECUTOR_ENABLED',
      'AGENT_DURABLE_EXECUTOR_POLL_MS',
      'AGENT_DURABLE_EXECUTOR_SUBMIT_TIMEOUT_MS',
      'PHONE_DEPLOY_TIMEOUT_SECONDS',
      'VOICE_PRIVILEGED_ACTIONS_ENABLED',
    ]),
  }),
  Object.freeze({
    name: 'Signed voice approval',
    keys: Object.freeze([
      'VOICE_APPROVAL_CAPABILITY_ENABLED',
      'VOICE_APPROVAL_CAPABILITY_TTL_SECONDS',
      'VOICE_APPROVAL_MARKER_TIMEOUT_MS',
      'VOICE_APPROVAL_SIGNING_KEY_ID',
      'VOICE_APPROVAL_TTL_SECONDS',
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
      'HTTP_HOST',
      'HTTP_PORT',
      'VOICE_APP_EXECUTION_LOCK_FILE',
      'VOICE_CALLBACK_LEASE_MS',
      'VOICE_CALLBACK_RETRY_BASE_MS',
      'VOICE_CALLBACK_RETRY_MAX_MS',
      'VOICE_JOB_RECONCILIATION_BASE_MS',
      'VOICE_JOB_RECONCILIATION_MAX_MS',
      'VOICE_JOB_RECONCILIATION_POLL_MS',
      'VOICE_STATE_DB_PATH',
      'WS_ALLOWED_PEERS',
      'WS_CONNECT_HOST',
      'WS_HOST',
      'WS_NON_LOOPBACK_ENABLED',
      'WS_PORT',
    ]),
  }),
  Object.freeze({
    name: 'Outbound callback plane',
    keys: Object.freeze([
      'OUTBOUND_API_NON_LOOPBACK_ENABLED',
    ]),
  }),
]);

const VOICE_APP_RUNTIME_ENV_KEYS = Object.freeze(
  VOICE_APP_RUNTIME_ENV_GROUPS.flatMap(({ keys }) => keys)
);

// These values are deliberately not configurable through the repository .env.
// The general bridge bearers are absent from voice-app, sensitive prompt/session
// logging stays disabled, and the private signer always uses its fixed mount.
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
  VOICE_APPROVAL_SIGNING_KEY_FILE: '/run/secrets/teleagent-approval-private.pem',
});

module.exports = {
  VOICE_APP_FIXED_ENV,
  VOICE_APP_RUNTIME_ENV_GROUPS,
  VOICE_APP_RUNTIME_ENV_KEYS,
};
