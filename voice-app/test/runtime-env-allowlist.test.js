'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertVoiceAppRuntimeEnvironment,
  VOICE_EXECUTION_LOCK_FILE,
  VOICE_APP_FIXED_ENV,
  VOICE_APP_RUNTIME_ENV_KEYS,
  VOICE_STATE_DB_PATH,
} = require('../../lib/voice-app-runtime-env');

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const VOICE_APP_ROOT = path.join(REPOSITORY_ROOT, 'voice-app');
const DORMANT_TEST_SUBSTRATE = new Set([
  path.join(VOICE_APP_ROOT, 'lib', 'approval-capability-config.js'),
]);

function productionJavaScriptFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    const resolved = path.join(root, entry.name);
    if (DORMANT_TEST_SUBSTRATE.has(resolved)) continue;
    if (entry.isDirectory()) {
      files.push(...productionJavaScriptFiles(resolved));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(resolved);
    }
  }
  return files;
}

function collectEnvironmentReferences() {
  const keys = new Set();
  const simplePatterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /\b(?:env|environment|settings)\.([A-Z][A-Z0-9_]*)/g,
    /\b(?:env|environment|settings)\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /requiredSetting\(env,\s*['"]([A-Z][A-Z0-9_]*)['"]\)/g,
  ];

  for (const file of productionJavaScriptFiles(VOICE_APP_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of simplePatterns) {
      for (const match of source.matchAll(pattern)) keys.add(match[1]);
    }

    // Cover the other common access form: const { FOO, BAR: alias } = process.env.
    for (const match of source.matchAll(/\{([^{}]+)\}\s*=\s*process\.env\b/g)) {
      for (const member of match[1].split(',')) {
        const name = member.trim().match(/^([A-Z][A-Z0-9_]*)\b/)?.[1];
        if (name) keys.add(name);
      }
    }
  }
  return keys;
}

function voiceAppService(compose) {
  const match = compose.match(/^  voice-app:\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:\n|(?![\s\S]))/m);
  assert.ok(match, 'canonical Compose must define voice-app');
  return match[1];
}

function environmentEntries(service) {
  const match = service.match(/^    environment:\n([\s\S]*?)(?=^    [a-zA-Z0-9_-]+:|(?![\s\S]))/m);
  assert.ok(match, 'voice-app must define an explicit environment mapping');
  return new Map(
    [...match[1].matchAll(/^      ([A-Z][A-Z0-9_]*):\s*(.*?)\s*$/gm)]
      .map((entry) => [entry[1], entry[2]])
  );
}

test('dormant approval key loader is unreachable from production voice modules', () => {
  const forbiddenImport = /require\(["']\.\/lib\/approval-capability-config["']\)/u;
  for (const filename of productionJavaScriptFiles(VOICE_APP_ROOT)) {
    assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), forbiddenImport, filename);
  }
});

test('voice state and listener invariants are exact application constants', () => {
  assert.equal(VOICE_STATE_DB_PATH, '/app/state/voice-state.sqlite');
  assert.equal(VOICE_EXECUTION_LOCK_FILE, '/app/state/voice-execution.lock.json');
  assert.deepEqual(assertVoiceAppRuntimeEnvironment({ ...VOICE_APP_FIXED_ENV }), {
    stateDbPath: '/app/state/voice-state.sqlite',
    executionLockFile: '/app/state/voice-execution.lock.json',
    httpHost: '127.0.0.1',
    wsHost: '127.0.0.1',
    wsConnectHost: '127.0.0.1',
    wsAllowedPeers: '',
    wsNonLoopbackEnabled: false,
  });

  const rejected = {
    VOICE_STATE_DB_PATH: [undefined, '', '/tmp/teleagent/voice-state.sqlite', '/app/state/other.sqlite'],
    VOICE_APP_EXECUTION_LOCK_FILE: [undefined, '', '/tmp/voice.lock', '/app/state/other.lock'],
    HTTP_HOST: [undefined, '', '0.0.0.0', '::'],
    WS_HOST: [undefined, '', '0.0.0.0', '::'],
    WS_CONNECT_HOST: [undefined, '', '10.0.0.8', 'localhost'],
    WS_ALLOWED_PEERS: [undefined, '127.0.0.1', '10.0.0.8'],
    WS_NON_LOOPBACK_ENABLED: [undefined, '', 'true', 'False'],
    OUTBOUND_API_NON_LOOPBACK_ENABLED: [undefined, '', 'true', 'False'],
    PRIVILEGED_ACTION_API_TOKEN: ['legacy-privileged-bearer', ' '],
  };
  for (const [name, values] of Object.entries(rejected)) {
    for (const value of values) {
      const environment = { ...VOICE_APP_FIXED_ENV };
      if (value === undefined) delete environment[name];
      else environment[name] = value;
      assert.throws(
        () => assertVoiceAppRuntimeEnvironment(environment),
        { code: 'VOICE_APP_RUNTIME_CONTRACT_INVALID' },
        `${name}=${String(value)}`,
      );
    }
  }
});

test('production voice environment references are closed over the Compose allowlist', () => {
  const referenced = collectEnvironmentReferences();
  const configured = new Set([
    ...VOICE_APP_RUNTIME_ENV_KEYS,
    ...Object.keys(VOICE_APP_FIXED_ENV),
  ]);

  assert.deepEqual(
    [...referenced].filter((key) => !configured.has(key)).sort(),
    [],
    'a production process.env reference was added without a reviewed Compose disposition'
  );
  assert.deepEqual(
    VOICE_APP_RUNTIME_ENV_KEYS.filter((key) => !referenced.has(key)),
    [],
    'the pass-through allowlist contains a stale key that voice-app no longer reads'
  );
});

test('canonical Compose exposes exactly the reviewed voice-app runtime environment', () => {
  const compose = fs.readFileSync(path.join(REPOSITORY_ROOT, 'docker-compose.yml'), 'utf8');
  const service = voiceAppService(compose);
  const entries = environmentEntries(service);
  const expectedKeys = [
    ...Object.keys(VOICE_APP_FIXED_ENV),
    ...VOICE_APP_RUNTIME_ENV_KEYS,
  ].sort();

  assert.doesNotMatch(service, /^    env_file:/m);
  assert.deepEqual([...entries.keys()].sort(), expectedKeys);

  for (const [key, value] of Object.entries(VOICE_APP_FIXED_ENV)) {
    assert.equal(entries.get(key), JSON.stringify(value), `${key} must remain fixed`);
  }
  for (const key of VOICE_APP_RUNTIME_ENV_KEYS) {
    assert.equal(entries.get(key), `"\${${key}:-}"`, `${key} must be explicit pass-through`);
  }

  assert.match(
    service,
    /\/run\/teleagent-isolated-voice-stack\/voice-secrets:\/run\/secrets:ro/
  );
  assert.doesNotMatch(service, /voice-app\/audio:\/app\/audio/);
  assert.doesNotMatch(service, /voice-app\/static:\/app\/static/);
  assert.match(
    service,
    /\/tmp:rw,noexec,nosuid,nodev,uid=\$\{VOICE_APP_UID:\?[^}]+},gid=\$\{VOICE_APP_GID:\?[^}]+},mode=0700,size=536870912/
  );
  assert.doesNotMatch(service, /VOICE_APP_(?:UID|GID):-|user: "1000:1000"/);
  assert.equal(entries.get('AGENT_API_TOKEN'), '""');
  assert.equal(entries.get('AUDIO_DIR'), '"/tmp/voice-audio"');
  assert.equal(entries.get('CLAUDE_API_TOKEN'), '""');
  assert.equal(entries.get('NODE_ENV'), '"production"');
  assert.equal(entries.get('DRACHTIO_HOST'), '"127.0.0.1"');
  assert.equal(entries.get('DRACHTIO_PORT'), '"9022"');
  assert.equal(entries.get('FREESWITCH_HOST'), '"127.0.0.1"');
  assert.equal(entries.get('FREESWITCH_PORT'), '"8021"');
  assert.equal(entries.get('HTTP_HOST'), '"127.0.0.1"');
  assert.equal(entries.get('OUTBOUND_API_NON_LOOPBACK_ENABLED'), '"false"');
  assert.equal(entries.get('VOICE_APP_EXECUTION_LOCK_FILE'),
    '"/app/state/voice-execution.lock.json"');
  assert.equal(entries.get('VOICE_STATE_DB_PATH'), '"/app/state/voice-state.sqlite"');
  assert.equal(entries.get('WS_ALLOWED_PEERS'), '""');
  assert.equal(entries.get('WS_CONNECT_HOST'), '"127.0.0.1"');
  assert.equal(entries.get('WS_HOST'), '"127.0.0.1"');
  assert.equal(entries.get('WS_NON_LOOPBACK_ENABLED'), '"false"');
  for (const secretName of [
    'DRACHTIO_SECRET',
    'EXECUTOR_API_TOKEN',
    'FREESWITCH_SECRET',
    'OPENAI_REALTIME_API_KEY',
    'OPENAI_SAFETY_IDENTIFIER_SALT',
    'OUTBOUND_API_TOKEN',
    'PRIVILEGED_ACTION_API_TOKEN',
    'STT_API_KEY',
    'TTS_API_KEY',
    'VOICE_CONTROL_TOKEN',
  ]) {
    assert.ok(!entries.has(secretName), `${secretName} must remain file-backed`);
  }
  assert.ok(!entries.has('VOICE_APPROVAL_SIGNING_KEY_HOST_FILE'));
  assert.ok(!entries.has('SIP_TRUNK_INGRESS_PASSWORD_HOST_FILE'));
  assert.ok(!entries.has('SIP_TRUNK_CALLBACK_PASSWORD_HOST_FILE'));
  assert.ok(!entries.has('VOICE_APPROVAL_PUBLIC_KEY_FILE'));
  assert.ok(!entries.has('EXECUTOR_TASK_DB_PATH'));
  assert.ok(!entries.has('AGENT_WORKER_HOME'));
  assert.ok(!entries.has('CODEX_COMMAND'));
  assert.ok(!entries.has('CLAUDE_COMMAND'));
});

test('voice runtime proves fixed state/listener values before state or network initialization', () => {
  const source = fs.readFileSync(path.join(VOICE_APP_ROOT, 'index.js'), 'utf8');
  const validation = source.indexOf(
    'voiceAppRuntimeContract.assertVoiceAppRuntimeEnvironment(process.env)'
  );
  const capacityAdmission = source.indexOf('var startupCapacityHealth = stateCapacityGuard.check()');
  const ownerFence = source.indexOf('outboundRuntimeFence = new OutboundRuntimeFence({');
  const stateOpen = source.indexOf('var runtimeState = openVoiceRuntimeState({');
  const executionLock = source.indexOf('new VoiceExecutionControl({');
  const sipConnect = source.indexOf('srf.connect({');

  assert.ok(validation > 0);
  assert.ok(validation < source.indexOf('var Srf = require("drachtio-srf")'));
  assert.ok(validation < capacityAdmission);
  assert.ok(capacityAdmission < ownerFence);
  assert.ok(ownerFence < sipConnect);
  assert.ok(capacityAdmission < stateOpen);
  assert.ok(stateOpen < executionLock);
  assert.doesNotMatch(source, /process\.env\.(?:VOICE_STATE_DB_PATH|VOICE_APP_EXECUTION_LOCK_FILE)/);
  assert.doesNotMatch(source, /\/tmp\/teleagent\/voice-state\.sqlite/);
});
