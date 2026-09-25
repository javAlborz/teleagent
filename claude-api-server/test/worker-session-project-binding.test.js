'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const verifier = fs.readFileSync(path.join(
  __dirname, '..', '..', 'deploy', 'worker-session', 'verify-worker-session-boundary',
), 'utf8');
const binding = verifier.match(/codex_policy=\/etc\/teleagent\/provider-egress\/codex\.json\n\/usr\/local\/libexec\/teleagent-node -e '\n([\s\S]*?)\n' "\$voice_env" "\$codex_policy"/u);
assert.ok(binding, 'installed verifier must execute the reviewed project-binding check');

const VOICE = '/etc/teleagent-voice/voice-app.env';
const POLICY = '/etc/teleagent/provider-egress/codex.json';
const PROJECT = 'proj_fixture0001';

function check({
  voice = `AGENT_PROVIDERS=codex\nOPENAI_PROJECT=${PROJECT}\n`,
  policy = { version: 1, provider: 'codex', openaiProjectId: PROJECT },
  policyMode = 0o100644,
  replaceable = null,
} = {}) {
  const files = {
    [VOICE]: Buffer.from(voice),
    [POLICY]: Buffer.from(JSON.stringify(policy)),
  };
  const output = [];
  const fakeFs = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0o400000 },
    realpathSync: (filename) => filename === replaceable ? '/other/location' : filename,
    openSync: (filename) => {
      if (!files[filename]) throw new Error('file absent');
      return filename;
    },
    fstatSync: (filename) => ({
      isFile: () => true,
      uid: 0, gid: 0, nlink: 1,
      mode: filename === VOICE ? 0o100600 : policyMode,
      size: files[filename].length,
      dev: 1, ino: filename === VOICE ? 1 : 2, mtimeMs: 1, ctimeMs: 1,
    }),
    readFileSync: (filename) => files[filename],
    closeSync: () => {},
  };
  vm.runInNewContext(binding[1], {
    require: (name) => {
      assert.equal(name, 'node:fs');
      return fakeFs;
    },
    process: { argv: ['node', VOICE, POLICY], stdout: { write: (text) => output.push(text) } },
  });
  return output.join('');
}

test('installed activation binds voice Realtime and Codex egress to one OpenAI project', () => {
  assert.equal(check(), 'OPENAI_PROJECT_BINDING_OK\n');
  assert.throws(() => check({ policy: {
    version: 1, provider: 'codex', openaiProjectId: 'proj_other0001',
  } }), /project bindings differ/u);
  assert.throws(() => check({ voice: `OPENAI_PROJECT=${PROJECT}\nOPENAI_PROJECT=${PROJECT}\n` }),
    /missing or repeated/u);
  assert.throws(() => check({ voice: 'OPENAI_PROJECT=\n' }), /binding is invalid/u);
  assert.throws(() => check({ replaceable: POLICY }), /path is replaceable/u);
  assert.throws(() => check({ policyMode: 0o100666 }), /metadata is unsafe/u);
});
