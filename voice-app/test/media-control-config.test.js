'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  loadMediaControlSecrets,
  normalizeMediaControlSecret,
} = require('../../lib/media-control-secrets');

const DRACHTIO_SECRET = 'drachtio_0123456789abcdef_ABCDEFGH';
const FREESWITCH_SECRET = 'freeswitch_9876543210fedcba_HGFEDCBA';

test('media control secrets are strong, distinct, and never reused across scopes', () => {
  assert.deepEqual(loadMediaControlSecrets({
    DRACHTIO_SECRET,
    FREESWITCH_SECRET,
  }), {
    drachtioSecret: DRACHTIO_SECRET,
    freeswitchSecret: FREESWITCH_SECRET,
  });

  for (const value of [
    '',
    'short',
    'replace-with-random-secret-value-1234567890',
    'your_password_0123456789abcdef01234567',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'spaces are not permitted in this secret',
    'linebreak_0123456789abcdef\n01234567',
    'punctuation!0123456789abcdef01234567',
  ]) {
    assert.throws(
      () => normalizeMediaControlSecret(value, 'DRACHTIO_SECRET'),
      /non-placeholder 32-128 byte base64url-safe random secret/,
    );
  }

  assert.throws(
    () => loadMediaControlSecrets({
      DRACHTIO_SECRET,
      FREESWITCH_SECRET: DRACHTIO_SECRET,
    }),
    /must be distinct/,
  );
  assert.throws(
    () => loadMediaControlSecrets({
      DRACHTIO_SECRET,
      FREESWITCH_SECRET,
      VOICE_CONTROL_TOKEN: DRACHTIO_SECRET,
    }),
    /distinct from VOICE_CONTROL_TOKEN/,
  );
});

test('the standalone preflight ignores secret environment values and fails closed on absent files', () => {
  const preflight = path.join(__dirname, '..', 'media-control-preflight.js');
  const placeholder = 'replace-with-random-secret-value-1234567890';
  const result = spawnSync(process.execPath, [preflight], {
    encoding: 'utf8',
    env: {
      DRACHTIO_SECRET: placeholder,
      FREESWITCH_SECRET,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing or unreadable/);
  assert.doesNotMatch(result.stderr, new RegExp(placeholder));
});

test('voice validates media control credentials before constructing network clients', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const validation = source.indexOf('config.runtime_secrets = configureRuntimeSecrets(loadRuntimeSecrets({');
  assert.ok(validation > 0);
  for (const boundary of [
    'var srf = new Srf()',
    'new OutboundRuntimeFence',
    'srf.connect({',
  ]) {
    assert.ok(validation < source.indexOf(boundary), `media secret validation must precede ${boundary}`);
  }
});

test('canonical Compose gates both control daemons behind the no-network file preflight', () => {
  const repositoryRoot = path.join(__dirname, '..', '..');
  const compose = fs.readFileSync(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8');
  const example = fs.readFileSync(path.join(repositoryRoot, '.env.example'), 'utf8');

  assert.doesNotMatch(compose, /media-control-preflight:/);
  assert.equal((compose.match(/condition: service_completed_successfully/g) || []).length, 2);
  assert.match(compose, /voice-runtime-preflight:[\s\S]*network_mode: none/);
  assert.match(compose, /drachtio\.conf\.xml:\/etc\/drachtio\.conf\.xml:ro/);
  assert.match(compose, /freeswitch-event-socket\.conf\.xml:.*event_socket\.conf\.xml:ro/);
  assert.doesNotMatch(compose, /--(?:secret|password)\b/);
  assert.doesNotMatch(compose, /(?:DRACHTIO_SECRET|FREESWITCH_SECRET):/);
  assert.doesNotMatch(example, /^DRACHTIO_SECRET=/m);
  assert.doesNotMatch(example, /^FREESWITCH_SECRET=/m);
  assert.doesNotMatch(example, /^SIP_AUTH_(?:ID|PASSWORD)=/m);
});
