'use strict';

const { configureRuntimeSecrets } = require('../lib/runtime-secrets');

const TEST_RUNTIME_SECRETS = Object.freeze({
  drachtioSecret: 'drachtio_0123456789abcdef_ABCDEFGH',
  freeswitchSecret: 'freeswitch_9876543210fedcba_HGFEDCBA',
  executorApiToken: 'executor_0123456789abcdef_ABCDEFGH',
  voiceControlToken: 'voice_control_0123456789abcdef_ABCDEFGH',
  openaiRealtimeApiKey: 'sk-project-0123456789abcdef-ABCDEFGH',
  openaiSafetyIdentifierSalt: 'safety_0123456789abcdef_ABCDEFGH',
  outboundApiToken: 'outbound-test-token-0123456789abcdef0123456789abcdef',
});

function installTestRuntimeSecrets(overrides = {}) {
  return configureRuntimeSecrets({ ...TEST_RUNTIME_SECRETS, ...overrides });
}

module.exports = { TEST_RUNTIME_SECRETS, installTestRuntimeSecrets };
