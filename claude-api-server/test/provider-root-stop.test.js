'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const boundary = require('../../deploy/worker-session/teleagent-provider-boundary');

const argv = ['--action', 'root-stop-all'];
const clean = () => ({ HOME: '/var/empty', PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
const root = () => ({ uid: 0, euid: 0, execArguments: [] });
const parseRoot = (args, env) => boundary.parseControl(args, env, root());

test('fixed root stop admits only real/effective root with exact clean environment and argv', () => {
  const environment = Object.freeze(clean());
  assert.deepEqual(parseRoot(argv, environment), { action: 'root-stop-all', provider: null, launchId: null, spec: null });
  assert.deepEqual(environment, clean(), 'no broker identity is manufactured or removed');
  for (const identity of [{ uid: 1000, euid: 0 }, { uid: 0, euid: 1000 }, { uid: 1000, euid: 1000 },
    { execArguments: ['--require', '/fixture/preload.cjs'] }]) {
    assert.throws(() => boundary.parseControl(argv, clean(), { ...root(), ...identity }), /genuine root/u);
  }
  for (const environment of [{}, { ...clean(), HOME: '/root' }, { ...clean(), PATH: '/fixture/bin' },
    ...['SUDO_USER', 'SUDO_UID', 'SUDO_COMMAND', 'NODE_OPTIONS', 'NODE_PATH', 'TELEAGENT_RELEASE_ROOT',
      'TELEAGENT_HANDOFF_LIFECYCLE_LOCK_FD', 'HTTP_PROXY'].map((key) => ({ ...clean(), [key]: 'fixture' }))]) {
    assert.throws(() => parseRoot(argv, environment), /fixed clean environment/u);
  }
});

test('root stop rejects target selection, trailing separators and caller command arguments', () => {
  for (const tail of [['--'], ['--provider', 'claude'], ['--launch-id', `launch_${'a'.repeat(32)}`],
    ['--workspace', '/srv/teleagent-agent-workspaces/phone'], ['--task-id', 'fixture'],
    ['--action', 'recover-root-panic'], ['--', '/bin/sh'], ['--stop-target', 'other.service']]) {
    assert.throws(() => parseRoot([...argv, ...tail], clean()));
  }
});

test('existing broker panic and recovery rights are unchanged and cannot become root stop', () => {
  assert.equal(boundary.parseControl(['--action', 'panic-all'], {
    SUDO_USER: 'teleagent-session-broker',
  }, root()).action, 'panic-all');
  assert.throws(() => boundary.parseControl(['--action', 'panic-all'], clean(), root()), /identity/u);
  for (const name of ['root', 'teleagent-session-broker', 'teleagent-claude-supervisor', 'teleagent-codex-supervisor']) {
    assert.throws(() => parseRoot(argv, { ...clean(), SUDO_USER: name }), /fixed clean environment/u);
  }
  for (const environment of [{}, { SUDO_USER: 'teleagent-session-broker' }]) {
    assert.equal(boundary.parseControl(['--action', 'recover-root-panic'], environment, root()).action, 'recover-root-panic');
  }
});

function transaction(t, overrides = {}) {
  const events = [], output = [];
  t.mock.method(process.stdout, 'write', (text) => { output.push(text); return true; });
  const control = async (frame) => {
    events.push(['control', frame]);
    assert.equal(frame.action, 'recover');
    return { persisted: true, quiesced: true };
  };
  const retained = { launchId: `launch_${'a'.repeat(32)}` };
  let panicPersisted = false;
  const operations = {
    persistPanic: () => { events.push(['persist']); panicPersisted = true; return { persisted: true }; },
    runSystemctl: (args) => {
      assert.equal(panicPersisted, true);
      assert.ok(['stop', 'mask'].includes(args[0]), 'root stop never starts/unmasks a supervisor');
      events.push(['systemctl', args]); return { status: 0 };
    },
    stopUnit: async (unit) => { events.push(['stop', unit]); return { quiesced: true }; },
    inspectLaunchLock: () => retained,
    enumerateUnits: (provider) => [`teleagent-provider-launch-${provider}-${'b'.repeat(32)}.service`],
    terminate: async (provider, launchId, options) => {
      assert.equal(options.control, control);
      assert.equal(options.allowMissingReadinessForGlobalRecovery, true);
      events.push(['terminate', provider, launchId]); return { persisted: true, quiesced: true };
    },
    recoverEgress: async (provider, operation) => operation({ provider, action: 'recover' }),
    readProviders: () => ['claude', 'codex'],
    clearLaunchLock: (proof) => {
      assert.deepEqual(proof, { quiesced: true, expectedRecord: retained });
      events.push(['clear-stale-launch-lock']); return { proved: true, removed: true };
    },
    ...overrides,
  };
  return {
    events, output,
    run: () => boundary.main(argv, clean(), {
      parseInput: parseRoot,
      control,
      requirePreflight: () => assert.fail('emergency stop must not acquire a start-preflight lock'),
      launchOperations: new Proxy({}, { get: () => assert.fail('root stop must not launch') }),
      panicAll: (options) => {
        assert.deepEqual(Object.keys(options), ['control']);
        return boundary.panicAllProviderPlanes({ ...operations, ...options });
      },
    }),
  };
}

test('root dispatch uses the existing durable panic, retained launch and egress stop transaction', async (t) => {
  const fixture = transaction(t);
  assert.equal(await fixture.run(), 0);
  const result = JSON.parse(fixture.output.join(''));
  assert.equal(result.accepted, true); assert.equal(result.persisted, true); assert.equal(result.quiesced, true);
  assert.equal(result.retainedLaunchCount, 2); assert.equal(result.launchCount, 2);
  assert.deepEqual(fixture.events[0], ['persist']);
  assert.deepEqual(fixture.events.filter(([kind]) => kind === 'stop').map(([, unit]) => unit), [
    'teleagent-provider-supervisor@claude.service', 'teleagent-provider-supervisor@codex.service',
  ]);
  assert.deepEqual(fixture.events.filter(([kind]) => kind === 'control').map(([, frame]) => frame), [
    { provider: 'claude', action: 'recover' }, { provider: 'codex', action: 'recover' },
  ]);
  assert.deepEqual(fixture.events.at(-1), ['clear-stale-launch-lock']);
});

test('partial egress proof returns 75 and retains the launch fence', async (t) => {
  const fixture = transaction(t, { recoverEgress: async (provider) => ({ persisted: provider === 'claude', quiesced: false }) });
  assert.equal(await fixture.run(), 75);
  const result = JSON.parse(fixture.output.join(''));
  assert.equal(result.persisted, false); assert.equal(result.quiesced, false);
  assert.equal(fixture.events.some(([kind]) => kind === 'clear-stale-launch-lock'), false);
});

test('failed panic persistence prevents stop side effects and emits no successful receipt', async (t) => {
  const fixture = transaction(t, { persistPanic: () => ({ persisted: false }) });
  await assert.rejects(fixture.run(), /panic was not persisted/u);
  assert.deepEqual(fixture.events, []); assert.deepEqual(fixture.output, []);
});

test('enumeration uncertainty propagates without clearing the fence or declaring success', async (t) => {
  const fixture = transaction(t, { enumerateUnits: () => { throw new Error('fixture enumeration unavailable'); } });
  await assert.rejects(fixture.run(), /enumeration unavailable/u);
  assert.deepEqual(fixture.events[0], ['persist']);
  assert.equal(fixture.events.some(([kind]) => kind === 'clear-stale-launch-lock'), false);
  assert.deepEqual(fixture.output, []);
});

test('main refuses nonroot before entering the panic transaction', async () => {
  let entered = false;
  await assert.rejects(boundary.main(argv, clean(), {
    parseInput: (args, env) => boundary.parseControl(args, env, { ...root(), uid: 1000 }),
    panicAll: async () => { entered = true; throw new Error('must not dispatch'); },
  }), /genuine root/u);
  assert.equal(entered, false);
});
