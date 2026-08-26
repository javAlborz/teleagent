'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  VOICE_APP_FIXED_ENV,
  VOICE_APP_RUNTIME_ENV_KEYS,
} = require('../../lib/voice-app-runtime-env');

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const VOICE_APP_ROOT = path.join(REPOSITORY_ROOT, 'voice-app');

function productionJavaScriptFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    const resolved = path.join(root, entry.name);
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
    /\/run\/teleagent-voice-stack\/voice-secrets:\/run\/secrets:ro/
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
