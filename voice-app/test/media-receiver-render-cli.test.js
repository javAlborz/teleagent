'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./helpers/media-topology-fixture');
const { canonical } = require('../../deploy/voice-stack/media-application-boundary');
const { renderReceiverEndpoints } = require('../../deploy/voice-stack/media-receiver-endpoints');

const script = path.resolve(__dirname, '../../deploy/voice-stack/render-media-receiver-projection.js');

test('host renderer returns the exact reviewed private projection', () => {
  const { config, contract } = fixture('v2');
  const input = canonical({ networkConfig: config, applicationContract: contract });
  const result = spawnSync(process.execPath, [script], {
    input, encoding: 'utf8', timeout: 3000, maxBuffer: 524288,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${canonical(renderReceiverEndpoints(config, contract))}\n`);
  for (const altered of [JSON.stringify({ networkConfig: config, applicationContract: contract }),
    canonical({ networkConfig: config }), '{}', '{']) {
    const rejected = spawnSync(process.execPath, [script], {
      input: altered, encoding: 'utf8', timeout: 3000, maxBuffer: 524288,
    });
    assert.equal(rejected.status, 77);
    assert.equal(rejected.stdout, '');
  }
});
