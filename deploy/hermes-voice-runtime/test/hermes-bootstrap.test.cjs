'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../hermes-bootstrap.cjs'), 'utf8');
const required = ['DRACHTIO_SECRET', 'FREESWITCH_SECRET', 'OPENAI_REALTIME_API_KEY', 'OUTBOUND_API_TOKEN'];

function fixture(change = () => {}) {
  const settings = { uid: 65534, gid: 65534, command: 'preflight', active: 0, integrity: 'ok', foreignKeys: [],
    argvExtra: [], execArgv: [], unsafeCredential: false, symlinkCredential: false, lock: true, ownedDrachtio: true };
  const environment = { HTTP_HOST: '127.0.0.1', WS_HOST: '127.0.0.1', DRACHTIO_HOST: '127.0.0.1', FREESWITCH_HOST: '127.0.0.1',
    VOICE_STATE_DB_PATH: '/app/state/voice-state.sqlite', VOICE_APP_EXECUTION_LOCK_FILE: '/app/execution-control/voice-execution.lock.json' };
  change(settings, environment);
  const files = new Map(required.map(name => [`/run/secrets/${name.toLowerCase().replaceAll('_', '-')}`, {
    bytes: `SYNTHETIC-NONFUNCTIONAL-${name}`, uid: 0, gid: settings.gid, mode: 0o440,
  }]));
  files.set('/app/execution-control/voice-execution.lock.json', { bytes: JSON.stringify({ locked: settings.lock }), uid: 0, gid: 0, mode: 0o444 });
  files.set('/app/state/voice-state.sqlite', { bytes: 'SYNTHETIC-DATABASE-PLACEHOLDER', uid: settings.uid, gid: settings.gid, mode: 0o600 });
  files.set('/proc/1/net/tcp', { bytes: `header\n0: 0100007F:D903 0100007F:1F55 01 0:0 00:0 0 65534 0 101\n1: 0100007F:D904 0100007F:233E 01 0:0 00:0 0 65534 0 102\n` });
  if (settings.unsafeCredential) files.get('/run/secrets/freeswitch-secret').mode = 0o644;
  if (settings.dotenv) files.set('/app/.env', { bytes: 'forbidden' });
  const descriptors = new Map();
  let nextFd = 30;
  const metadata = file => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, uid: file.uid, gid: file.gid,
    mode: file.mode, size: Buffer.byteLength(file.bytes), dev: 1, ino: 55 });
  const fakeFs = {
    constants: fs.constants,
    existsSync: filename => files.has(filename),
    lstatSync(filename) {
      if (filename === '/app/execution-control') return { isDirectory: () => true, uid: 0, mode: 0o755 };
      assert.ok(files.has(filename), 'only synthetic fixture files may be inspected');
      return metadata(files.get(filename));
    },
    openSync(filename, flags) {
      assert.ok(flags & fs.constants.O_NOFOLLOW, 'protected reads refuse symlinks');
      assert.ok(flags & fs.constants.O_NONBLOCK, 'special-file reads cannot block before metadata checks');
      if (settings.symlinkCredential && filename === '/run/secrets/freeswitch-secret') throw new Error('synthetic symlink refused');
      assert.ok(files.has(filename));
      descriptors.set(nextFd, files.get(filename));
      return nextFd++;
    },
    fstatSync: fd => metadata(descriptors.get(fd)),
    readFileSync(file, encoding) {
      const value = typeof file === 'number' ? descriptors.get(file) : files.get(file);
      assert.ok(value, 'only synthetic fixture bytes may be read');
      return encoding ? value.bytes : Buffer.from(value.bytes);
    },
    closeSync: fd => descriptors.delete(fd),
    readdirSync(filename) { assert.equal(filename, '/proc/1/fd'); return ['3', '4']; },
    readlinkSync(filename) { return filename.endsWith('/3') ? 'socket:[101]' : `socket:[${settings.ownedDrachtio ? '102' : '999'}]`; },
  };
  const output = { stdout: '', stderr: '', applicationLoaded: false, databaseOpened: false };
  const moduleObject = { exports: {} };
  const fakeRequire = name => {
    if (name === 'node:fs') return fakeFs;
    if (name === 'better-sqlite3') return class {
      constructor(filename, options) {
        assert.equal(filename, '/app/state/voice-state.sqlite');
        assert.equal(options.readonly, true); assert.equal(options.fileMustExist, true);
        output.databaseOpened = true;
      }
      pragma(name) { return name === 'quick_check' ? settings.integrity : settings.foreignKeys; }
      prepare() { return { get: () => ({ active: settings.active }) }; }
      close() {}
    };
    if (name === '/app/voice-app/index.js') { output.applicationLoaded = true; return {}; }
    return require(name);
  };
  fakeRequire.main = moduleObject;
  const context = { Buffer, module: moduleObject, require: fakeRequire,
    process: { getuid: () => settings.uid, getgid: () => settings.gid, execArgv: settings.execArgv,
      argv: ['node', '/app/voice-app/hermes-bootstrap.cjs', settings.command, ...settings.argvExtra], env: environment,
      stdout: { write: value => { output.stdout += value; } }, stderr: { write: value => { output.stderr += value; } } } };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { ...output, code: context.process.exitCode || 0, environment, descriptors };
}

test('isolated preflight validates without loading the application or publishing credentials', () => {
  const value = fixture();
  assert.equal(value.code, 0); assert.equal(value.stdout, 'HERMES_VOICE_PREFLIGHT_OK\n');
  assert.equal(value.applicationLoaded, false); assert.equal(value.databaseOpened, true);
  assert.ok(required.every(name => !value.environment[name]));
  assert.equal(value.descriptors.size, 0);
});
test('serve reads file credentials after exec and has no general controller authority', () => {
  const value = fixture(settings => { settings.command = 'serve'; });
  assert.equal(value.code, 0); assert.equal(value.applicationLoaded, true);
  assert.ok(required.every(name => value.environment[name] === `SYNTHETIC-NONFUNCTIONAL-${name}`));
  assert.equal(value.environment.CLAUDE_API_TOKEN, ''); assert.equal(value.environment.AGENT_API_TOKEN, '');
  assert.equal(value.environment.VOICE_PRIVILEGED_ACTIONS_ENABLED, 'false');
  assert.equal(value.environment.AGENT_DURABLE_EXECUTOR_ENABLED, 'false');
  assert.equal(value.stdout + value.stderr, '');
});
test('unsafe identities, arguments, credentials, dotenv and database states fail before serve', () => {
  const mutations = [
    settings => { settings.uid = 0; }, settings => { settings.uid = 1000; }, settings => { settings.gid = 0; },
    settings => { settings.argvExtra = ['--password']; }, settings => { settings.execArgv = ['--inspect']; },
    settings => { settings.unsafeCredential = true; }, settings => { settings.symlinkCredential = true; },
    settings => { settings.dotenv = true; }, settings => { settings.lock = false; }, settings => { settings.active = 1; },
    settings => { settings.integrity = 'bad'; }, settings => { settings.foreignKeys = [{}]; },
    (_s, environment) => { environment.CLAUDE_API_TOKEN = 'SYNTHETIC-FORBIDDEN'; },
    (_s, environment) => { environment.FREESWITCH_SECRET = 'SYNTHETIC-FORBIDDEN'; },
    (_s, environment) => { environment.HTTP_HOST = '0.0.0.0'; },
    (_s, environment) => { environment.VOICE_APP_EXECUTION_LOCK_FILE = '/elsewhere'; },
  ];
  for (const mutate of mutations) {
    const value = fixture((settings, environment) => { settings.command = 'serve'; mutate(settings, environment); });
    assert.equal(value.code, 1); assert.equal(value.applicationLoaded, false);
    assert.equal(value.stdout, ''); assert.equal(value.stderr, 'Hermes voice preflight refused the runtime contract.\n');
    assert.equal(value.descriptors.size, 0);
  }
});
test('media health binds both loopback sockets to PID 1, not another process', () => {
  const good = fixture(settings => { settings.command = 'health'; });
  assert.equal(good.code, 0); assert.equal(good.stdout, 'HERMES_VOICE_MEDIA_CONNECTED\n');
  assert.equal(good.databaseOpened, false); assert.equal(good.applicationLoaded, false);
  const bad = fixture(settings => { settings.command = 'health'; settings.ownedDrachtio = false; });
  assert.equal(bad.code, 1);
});
