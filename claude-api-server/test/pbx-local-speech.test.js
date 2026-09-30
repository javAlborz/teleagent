'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
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
