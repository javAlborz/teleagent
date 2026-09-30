'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { PbxPromptRenderer, createPbxSpeechSynthesizer, MAX_AUDIO } = require('../pbx-prompt-renderer');
const { hashText } = require('../../lib/pbx-approval-protocol');

function fixture(t, synthesize = async () => Buffer.alloc(48000, 1)) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-audio-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, renderer: new PbxPromptRenderer({ directory, synthesize }) };
}

test('renderer binds exact text and audio, bounds disk and deletes after use', async (t) => {
  const f = fixture(t);
  const artifact = await f.renderer.render('Exact approval');
  assert.equal(artifact.promptSha256, hashText('Exact approval'));
  assert.equal(artifact.durationMs, 1200);
  const audio = fs.readFileSync(path.join(f.directory, `${artifact.audioSha256}.sln24`));
  assert.equal(crypto.createHash('sha256').update(audio).digest('hex'), artifact.audioSha256);
  await assert.rejects(f.renderer.render('Another'), { code: 'PBX_AUDIO_RENDER_BUSY' });
  await assert.rejects(f.renderer.release({ ...artifact }), { code: 'PBX_AUDIO_ARTIFACT_UNKNOWN' });
  await f.renderer.release(artifact);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('invalid or excessive audio never creates a media file', async (t) => {
  for (const audio of [Buffer.alloc(0), Buffer.alloc(4801), Buffer.alloc(MAX_AUDIO + 2), 'not audio']) {
    const f = fixture(t, async () => audio);
    await assert.rejects(f.renderer.render('Exact approval'), { code: 'PBX_AUDIO_INVALID' });
    assert.deepEqual(fs.readdirSync(f.directory), []);
  }
});

test('orphan cleanup removes only expired correctly hashed audio', async (t) => {
  const f = fixture(t);
  const artifact = await f.renderer.render('Old approval');
  f.renderer.active.clear(); // Simulated prior process death; a fresh renderer has no active map.
  const filename = path.join(f.directory, `${artifact.audioSha256}.sln24`);
  const old = new Date(Date.now() - 16 * 60 * 1000); fs.utimesSync(filename, old, old);
  f.renderer.collectExpired();
  assert.deepEqual(fs.readdirSync(f.directory), []);
  fs.writeFileSync(path.join(f.directory, 'personal-file'), 'keep');
  assert.throws(() => f.renderer.collectExpired(), { code: 'PBX_AUDIO_STORAGE_UNREVIEWED' });
  assert.equal(fs.readFileSync(path.join(f.directory, 'personal-file'), 'utf8'), 'keep');
});

test('unsafe media directories and replaced audio are refused', async (t) => {
  const f = fixture(t);
  const artifact = await f.renderer.render('Exact approval');
  fs.writeFileSync(path.join(f.directory, `${artifact.audioSha256}.sln24`), 'changed');
  await assert.rejects(f.renderer.release(artifact), { code: 'PBX_AUDIO_ARTIFACT_CHANGED' });
  fs.chmodSync(f.directory, 0o777);
  assert.throws(() => new PbxPromptRenderer({ directory: f.directory, synthesize: async () => null }),
    { code: 'PBX_AUDIO_DIRECTORY_UNSAFE' });
});

test('speech client requires independent egress admission before any network request', async () => {
  assert.throws(() => createPbxSpeechSynthesizer({ apiKey: 'x'.repeat(32) }), { code: 'PBX_SPEECH_CONFIGURATION_INVALID' });
  const synthesize = createPbxSpeechSynthesizer({ apiKey: 'x'.repeat(32), assertEgress: () => { throw new Error('denied'); } });
  await assert.rejects(synthesize('Exact approval'), /denied/);
});
