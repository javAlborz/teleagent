'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createPbxLocalSpeechSynthesizer, toPcm24, MAX_WAVE } = require('../pbx-local-speech');

function wave() {
  return Buffer.concat([Buffer.from('5249464624f0ff7f57415645666d742010000000010001002256000044ac0000020010006461746100f0ff7f', 'hex'), Buffer.alloc(44100)]);
}
test('fixed local synthesis keeps hostile prompt text out of argv and environment', async () => {
  let input = ''; let guards = 0;
  const synthesize = createPbxLocalSpeechSynthesizer({ assertBoundary() { guards++; }, spawnImpl(file, args, options) {
    assert.equal(file, '/usr/bin/espeak-ng');
    assert.deepEqual(args, ['--stdout', '--stdin', '-v', 'en-us', '-s', '155']);
    assert.equal(options.shell, false); assert.equal(Object.keys(options.env).length, 4);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => {};
    child.stdin = new Writable({ write(chunk, _encoding, done) { input += chunk; done(); } });
    child.stdin.on('finish', () => { child.stdout.end(wave()); child.emit('close', 0, null); });
    return child;
  } });
  const prompt = 'Read this: $(touch /tmp/never); <audio src="https://example.invalid"/> --output=/tmp/never';
  const pcm = await synthesize(prompt);
  assert.equal(input, prompt); assert.equal(pcm.length, 48000); assert.equal(guards, 2);
});
test('boundary refusal cannot start a speech subprocess and invalid WAV cannot become approval audio', async () => {
  const synthesize = createPbxLocalSpeechSynthesizer({ assertBoundary() { throw new Error('refused'); },
    spawnImpl() { assert.fail('not admitted'); } });
  await assert.rejects(synthesize('Exact approval'), /refused/);
  for (const input of [Buffer.alloc(0), Buffer.alloc(MAX_WAVE + 2), Buffer.from('not wave')]) {
    assert.throws(() => toPcm24(input), { code: 'PBX_SPEECH_AUDIO_INVALID' });
  }
  const changed = wave(); changed.writeUInt32LE(48000, 24);
  assert.throws(() => toPcm24(changed), { code: 'PBX_SPEECH_AUDIO_INVALID' });
});

test('real local speech survives the installed attester file-size limit', (t) => {
  const available = process.platform === 'linux' && fs.existsSync('/usr/bin/espeak-ng') && fs.existsSync('/usr/bin/prlimit');
  if (!available) {
    assert.notEqual(process.env.TELEAGENT_REQUIRE_LOCAL_SPEECH_TEST, '1', 'CI must install the real local speech dependency');
    t.skip('Linux eSpeak/prlimit integration dependency unavailable'); return;
  }
  const unit = fs.readFileSync(path.join(__dirname, '../../deploy/owner-plane/teleagent-pbx-attester.service'), 'utf8');
  const limits = [...unit.matchAll(/^LimitFSIZE=(\d+)$/gm)];
  assert.equal(limits.length, 1);
  const limit = Number(limits[0][1]);
  assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 64 * 1024 * 1024);
  const script = `
    const { createPbxLocalSpeechSynthesizer } = require(${JSON.stringify(require.resolve('../pbx-local-speech'))});
    const synthesize = createPbxLocalSpeechSynthesizer({ assertBoundary() {} });
    synthesize('Approval speech regression. Press pound after this prompt finishes.')
      .then(pcm => console.log(JSON.stringify({ bytes: pcm.length })))
      .catch(error => { console.error(error.code); process.exitCode = 1; });
  `;
  const result = spawnSync('/usr/bin/prlimit', [`--fsize=${limit}:${limit}`, process.execPath, '-e', script], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 4096,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.bytes >= 4800 && output.bytes <= 24000 * 2 * 90);
});
