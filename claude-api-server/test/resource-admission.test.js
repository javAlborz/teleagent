'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const admission = require('../../deploy/worker-session/teleagent-resource-admission');
const GiB = 1024n ** 3n;
const MiB = 1024n ** 2n;

// Synthetic budgets are test inputs, never an installed Hermes allocation.
function profile() {
  return {
    schema: 'teleagent.resource-admission.v1', hostname: 'hermes',
    pool: { memoryHighBytes: String(10n * GiB), memoryMaxBytes: String(12n * GiB),
      tasksMax: '1500', cpuQuotaMicros: '250000', cpuPeriodMicros: '100000' },
    normalChildren: [
      { name: 'teleagent-agent-controller.service', memoryMaxBytes: String(2n * GiB), tasksMax: '128' },
      { name: 'teleagent-provider.slice', memoryMaxBytes: String(6n * GiB), tasksMax: '1024' },
      { name: 'teleagent-voice.slice', memoryMaxBytes: String(2n * GiB), tasksMax: '128' },
      { name: 'teleagent-worker-session.service', memoryMaxBytes: String(512n * MiB), tasksMax: '64' },
    ],
    recovery: { memoryMaxBytes: String(512n * MiB), tasksMax: '64' },
    hostReserveBytes: String(2n * GiB), launchMemoryHeadroomBytes: String(3n * GiB),
    launchTasksHeadroom: '384', maxSomePressureBasisPoints: 100,
    maxFullPressureBasisPoints: 20,
  };
}

const encode = (value) => `${JSON.stringify(value)}\n`;
const pressure = () => admission.parsePressure(
  'some avg10=0.00 avg60=0.00 avg300=0.00 total=1000\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=500\n'
);

function sample(policy = admission.validateProfile(encode(profile()))) {
  const children = new Map([...policy.children].map(([name, limits]) => [name, {
    identity: name, max: limits.memory, tasksMax: limits.tasks,
    memory: 64n * MiB, tasks: 2n, swap: 0n, swapMax: 0n,
  }]));
  children.set('teleagent-recovery.slice', {
    identity: 'recovery', max: policy.recovery.memoryMaxBytes, tasksMax: policy.recovery.tasksMax,
    memory: 0n, tasks: 0n, swap: 0n, swapMax: 0n,
  });
  return {
    boot: 'fixture-current-boot', children,
    pool: { identity: 'pool', memory: GiB, high: policy.pool.memoryHighBytes,
      max: policy.pool.memoryMaxBytes, tasks: 10n, tasksMax: policy.pool.tasksMax,
      swap: 0n, swapMax: 0n, pressure: pressure(),
      memoryEvents: new Map([['low', 0n], ['high', 1200n], ['max', 0n], ['oom', 0n], ['oom_kill', 0n]]),
      tasksEvents: new Map([['max', 0n]]),
    },
    meminfo: { total: 16n * GiB, available: 8n * GiB }, hostPressure: pressure(),
  };
}

function invoke({ definition = profile(), first, second, elapsed = 250000000n,
  secondProfile, readError, snapshotError } = {}) {
  const policy = admission.validateProfile(encode(definition));
  let reads = 0;
  let observations = 0;
  let ticks = 0;
  return admission.assertResourceAdmission({
    readProfile: () => {
      if (readError) throw readError;
      reads += 1;
      return reads === 2 && secondProfile ? secondProfile : encode(definition);
    },
    snapshot: () => {
      if (snapshotError) throw snapshotError;
      observations += 1;
      return observations === 1 ? (first || sample(policy)) : (second || sample(policy));
    },
    sleep: async (ms) => assert.equal(ms, 250),
    monotonic: () => { ticks += 1; return ticks < 3 ? 0n : elapsed; },
  });
}

test('explicit aggregate profile accounts for all children and a protected recovery allowance', () => {
  const policy = admission.validateProfile(encode(profile()));
  assert.equal(policy.launchMemory, admission.MODEL_MEMORY_MAX);
  assert.equal(policy.launchTasks, admission.MODEL_TASKS_MAX);
  assert.equal(policy.children.size, 4);
  assert.equal(policy.digest.length, 64);
});

test('profile rejects duplicate keys, unknown settings and noncanonical encodings', () => {
  const text = encode(profile());
  for (const bad of [text.slice(0, -1), `${text}\n`, text.replace('"hostname":"hermes"',
    '"hostname":"hermes","hostname":"hermes"'), encode({ ...profile(), disabled: true }),
  JSON.stringify(profile(), null, 2)]) {
    assert.throws(() => admission.validateProfile(bad), { code: 'RESOURCE_PROFILE_INVALID' });
  }
});

test('profiles cannot borrow recovery capacity, omit a plane or select another path', () => {
  const mutations = [
    (p) => { p.normalChildren[0].memoryMaxBytes = String(10n * GiB); },
    (p) => { p.normalChildren[0].tasksMax = '1400'; },
    (p) => { p.normalChildren.pop(); },
    (p) => { p.normalChildren[0].name = '../user.slice'; },
    (p) => { p.normalChildren[0].name = 'teleagent-provider-model.slice'; },
    (p) => { p.normalChildren[0].name = 'teleagent-recovery.slice'; },
    (p) => { p.normalChildren.push(p.normalChildren[0]); },
    (p) => { p.launchMemoryHeadroomBytes = '1'; },
    (p) => { p.launchTasksHeadroom = '1'; },
    (p) => { p.recovery.memoryMaxBytes = '0'; },
    (p) => { p.hostReserveBytes = '0'; },
    (p) => { p.pool.memoryMaxBytes = 'max'; },
    (p) => { p.pool.cpuQuotaMicros = '0'; },
    (p) => { p.hostname = 'elsewhere'; },
    (p) => { p.maxSomePressureBasisPoints = 10000; },
    (p) => { p.maxFullPressureBasisPoints = 101; },
  ];
  for (const mutate of mutations) {
    const definition = profile();
    mutate(definition);
    assert.throws(() => admission.validateProfile(encode(definition)), { code: 'RESOURCE_PROFILE_INVALID' });
  }
});

test('kernel evidence parsers reject missing, duplicate, unbounded and malformed fields', () => {
  assert.deepEqual(admission.parseMeminfo('MemTotal:       10000 kB\nMemAvailable:    5000 kB\n'),
    { total: 10240000n, available: 5120000n });
  for (const bad of ['MemTotal: 1 kB\n', 'MemTotal: 1 kB\nMemAvailable: 2 kB\n',
    'MemTotal: 1 kB\nMemAvailable: 1 kB\nMemAvailable: 1 kB\n', 'MemTotal: 1\nMemAvailable: 1 kB\n']) {
    assert.throws(() => admission.parseMeminfo(bad), { code: 'RESOURCE_EVIDENCE_INVALID' });
  }
  for (const bad of ['populated 0\n', 'high 0\nmax 0\noom 0\noom_kill max\n',
    'high 0\nmax 0\noom 0\noom_kill 0\nhigh 0\n',
    'high 0\nmax 0\noom 0\noom_kill 18446744073709551616\n']) {
    assert.throws(() => admission.parseEvents(bad, ['high', 'max', 'oom', 'oom_kill']),
      { code: 'RESOURCE_EVIDENCE_INVALID' });
  }
  for (const bad of ['', 'some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n',
    'some avg10=NaN avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n',
    'some avg10=101.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n']) {
    assert.throws(() => admission.parsePressure(bad), { code: 'RESOURCE_EVIDENCE_INVALID' });
  }
});

test('healthy fresh snapshots admit one job; historical events do not permanently poison admission', async () => {
  assert.deepEqual(await invoke(), { admitted: true,
    profileSha256: admission.validateProfile(encode(profile())).digest, globallyAdmittedJobs: 1 });
});

test('host headroom, pool high/max, provider headroom and task reserve all gate new work', async () => {
  const cases = [
    ['host headroom', (s) => { s.meminfo.available = GiB; }, 'RESOURCE_HOST_HEADROOM'],
    ['host physical overcommit', (s) => { s.meminfo.total = 13n * GiB; }, 'RESOURCE_HOST_HEADROOM'],
    ['pool high', (s) => { s.pool.memory = 8n * GiB; }, 'RESOURCE_POOL_HEADROOM'],
    ['pool task reserve', (s) => { s.pool.tasks = 1100n; }, 'RESOURCE_POOL_HEADROOM'],
    ['provider headroom', (s) => { s.children.get('teleagent-provider.slice').memory = 4n * GiB; }, 'RESOURCE_POOL_HEADROOM'],
    ['provider tasks', (s) => { s.children.get('teleagent-provider.slice').tasks = 700n; }, 'RESOURCE_POOL_HEADROOM'],
    ['pool swap', (s) => { s.pool.swap = 1n; }, 'RESOURCE_POOL_LIMIT_MISMATCH'],
    ['changed pool max', (s) => { s.pool.max += GiB; }, 'RESOURCE_POOL_LIMIT_MISMATCH'],
    ['changed child max', (s) => { s.children.get('teleagent-voice.slice').max += GiB; }, 'RESOURCE_CHILD_LIMIT_MISMATCH'],
    ['changed child swap', (s) => { s.children.get('teleagent-provider.slice').swapMax = GiB; }, 'RESOURCE_CHILD_LIMIT_MISMATCH'],
    ['missing recovery child', (s) => { s.children.delete('teleagent-recovery.slice'); }, 'RESOURCE_CHILD_LIMIT_MISMATCH'],
  ];
  for (const [name, mutate, code] of cases) {
    const first = sample();
    mutate(first);
    await assert.rejects(invoke({ first }), { code }, name);
  }
});

test('pressure averages or new stalls refuse even when memory is otherwise available', async () => {
  for (const location of ['host', 'pool']) {
    const first = sample();
    const target = location === 'host' ? first.hostPressure : first.pool.pressure;
    target.some.averages[2] = 101;
    await assert.rejects(invoke({ first }), { code: 'RESOURCE_MEMORY_PRESSURE' });
    const second = sample();
    const current = location === 'host' ? second.hostPressure : second.pool.pressure;
    current.full.total += 501n; // > 0.20% of 250ms, despite still-zero averages.
    await assert.rejects(invoke({ second }), { code: 'RESOURCE_MEMORY_PRESSURE' });
  }
});

test('slow evidence reads cannot dilute the measured pressure interval', async () => {
  for (const slowSnapshot of [1, 2]) {
    let elapsed = 0n;
    let observations = 0;
    await assert.rejects(admission.assertResourceAdmission({
      readProfile: () => encode(profile()),
      snapshot: () => {
        observations += 1;
        const value = sample();
        if (observations === slowSnapshot) elapsed += 1500000000n;
        if (observations === 2) value.hostPressure.some.total += 2501n; // > 1% of the 250ms wait.
        return value;
      },
      sleep: async () => { elapsed += 250000000n; },
      monotonic: () => elapsed,
    }), { code: 'RESOURCE_MEMORY_PRESSURE' });
  }
});

test('total collection freshness remains bounded even with a valid pressure interval', async () => {
  let elapsed = 0n;
  let observations = 0;
  await assert.rejects(admission.assertResourceAdmission({
    readProfile: () => encode(profile()),
    snapshot: () => {
      observations += 1;
      if (observations === 1) elapsed += 1800000000n;
      return sample();
    },
    sleep: async () => { elapsed += 250000000n; },
    monotonic: () => elapsed,
  }), { code: 'RESOURCE_BOUNDARY_CHANGED' });
});

test('throttling, OOM, counter reset, cgroup replacement and stale observations refuse', async () => {
  for (const kind of ['high', 'max', 'oom', 'oom_kill']) {
    const second = sample();
    second.pool.memoryEvents.set(kind, second.pool.memoryEvents.get(kind) + 1n);
    await assert.rejects(invoke({ second }), { code: 'RESOURCE_RECENT_LIMIT_EVENT' });
  }
  const resets = sample();
  resets.pool.memoryEvents.set('high', 0n);
  await assert.rejects(invoke({ second: resets }), { code: 'RESOURCE_RECENT_LIMIT_EVENT' });
  for (const mutate of [
    (s) => { s.boot = 'another-boot'; },
    (s) => { s.pool.identity = 'recreated-pool'; },
    (s) => { s.children.get('teleagent-provider.slice').identity = 'recreated-provider'; },
  ]) {
    const second = sample(); mutate(second);
    await assert.rejects(invoke({ second }), { code: 'RESOURCE_BOUNDARY_CHANGED' });
  }
  for (const elapsed of [0n, 199999999n, 2000000001n]) {
    await assert.rejects(invoke({ elapsed }), { code: 'RESOURCE_BOUNDARY_CHANGED' });
  }
});

test('profile changes and unavailable evidence fail closed without leaking diagnostics', async () => {
  await assert.rejects(invoke({ secondProfile: encode({ ...profile(), hostname: 'elsewhere' }) }),
    { code: 'RESOURCE_BOUNDARY_CHANGED' });
  for (const field of ['readError', 'snapshotError']) {
    await assert.rejects(invoke({ [field]: new Error('private diagnostics and filesystem path') }),
      (error) => error.code === 'RESOURCE_EVIDENCE_UNAVAILABLE' && error.exitCode === 75 &&
        !error.message.includes('private diagnostics'));
  }
});

function kernelFixture(t) {
  const policy = admission.validateProfile(encode(profile()));
  const pool = '/sys/fs/cgroup/teleagent.slice';
  const directories = new Set(['/etc', '/etc/teleagent', '/proc', '/proc/pressure',
    '/sys', '/sys/fs', '/sys/fs/cgroup', pool]);
  const texts = new Map([
    ['/etc/teleagent/resource-admission.json', encode(profile())],
    ['/proc/sys/kernel/hostname', 'hermes\n'],
    ['/proc/sys/kernel/random/boot_id', '11111111-2222-3333-4444-555555555555\n'],
    ['/proc/meminfo', `MemTotal: ${16n * GiB / 1024n} kB\nMemAvailable: ${8n * GiB / 1024n} kB\n`],
    ['/proc/pressure/memory', 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'],
  ]);
  const addGroup = (directory, memory, tasks) => {
    directories.add(directory);
    for (const [name, text] of Object.entries({
      'cgroup.type': 'domain\n', 'memory.current': '1024\n', 'memory.max': `${memory}\n`,
      'memory.swap.current': '0\n', 'memory.swap.max': '0\n', 'pids.current': '2\n', 'pids.max': `${tasks}\n`,
    })) texts.set(`${directory}/${name}`, text);
  };
  addGroup(pool, policy.pool.memoryMaxBytes, policy.pool.tasksMax);
  for (const [name, limits] of policy.children) addGroup(`${pool}/${name}`, limits.memory, limits.tasks);
  addGroup(`${pool}/teleagent-recovery.slice`, policy.recovery.memoryMaxBytes, policy.recovery.tasksMax);
  for (const [name, text] of Object.entries({
    'memory.high': `${policy.pool.memoryHighBytes}\n`, 'cgroup.procs': '',
    'cpu.max': `${policy.pool.cpuQuotaMicros} ${policy.pool.cpuPeriodMicros}\n`,
    'memory.pressure': texts.get('/proc/pressure/memory'),
    'memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n', 'pids.events': 'max 0\n',
  })) texts.set(`${pool}/${name}`, text);
  const metadataOverrides = new Map();
  metadataOverrides.set('/proc/pressure/memory', { mode: 0o100666n });
  const metadata = (filename, directory) => ({
    isDirectory: () => directory, isFile: () => !directory,
    uid: 0n, gid: 0n, mode: directory ? 0o40755n : 0o100644n,
    dev: 1n, ino: 1n, mtimeNs: 0n, ctimeNs: 0n,
    ...metadataOverrides.get(filename),
  });
  const descriptors = new Map();
  const state = { fsType: 0x63677270n, procType: 0x9fa0n, namespace: 'cgroup:[123]', extraChild: false };
  t.mock.method(process, 'getuid', () => 0);
  t.mock.method(process, 'geteuid', () => 0);
  t.mock.method(fs, 'statfsSync', (filename) => ({
    type: filename === '/proc/pressure/memory' ? state.procType : state.fsType,
  }));
  t.mock.method(fs, 'readlinkSync', (filename) => filename === '/proc/1/ns/cgroup'
    ? state.namespace : 'cgroup:[123]');
  t.mock.method(fs, 'realpathSync', (filename) => filename);
  t.mock.method(fs, 'lstatSync', (filename) => {
    if (!directories.has(filename)) throw new Error('fixture directory absent');
    return metadata(filename, true);
  });
  t.mock.method(fs, 'readdirSync', () => {
    const names = [...policy.children.keys(), 'teleagent-recovery.slice'];
    if (state.extraChild) names.push('teleagent-unaccounted.service');
    return names.map((name) => ({ name, isSymbolicLink: () => false, isDirectory: () => true }));
  });
  t.mock.method(fs, 'openSync', (filename, flags) => {
    assert.ok(flags & fs.constants.O_NOFOLLOW);
    assert.ok(flags & fs.constants.O_NONBLOCK);
    if (!texts.has(filename)) throw new Error('fixture evidence absent');
    const fd = descriptors.size + 10;
    descriptors.set(fd, { filename, offset: 0 });
    return fd;
  });
  t.mock.method(fs, 'fstatSync', (fd) => metadata(descriptors.get(fd).filename, false));
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length) => {
    const descriptor = descriptors.get(fd);
    const input = Buffer.from(texts.get(descriptor.filename));
    const read = input.copy(buffer, offset, descriptor.offset, descriptor.offset + length);
    descriptor.offset += read;
    return read;
  });
  t.mock.method(fs, 'closeSync', (fd) => descriptors.delete(fd));
  return { policy, pool, texts, metadataOverrides, state };
}

test('production collector verifies canonical root-owned cgroup evidence through bounded descriptors', (t) => {
  const fixture = kernelFixture(t);
  assert.equal(admission.readProductionProfile(), encode(profile()));
  const collected = admission.collectSnapshot(fixture.policy);
  assert.equal(collected.children.size, 5);
  assert.equal(collected.pool.memory, 1024n);
  assert.doesNotThrow(() => admission.assessSnapshot(fixture.policy, collected));
});

test('production collector refuses unsafe ownership, hierarchy, namespace and missing kernel evidence', async (t) => {
  const cases = [
    ['wrong filesystem', (f) => { f.state.fsType = 0xef53n; }, 'RESOURCE_BOUNDARY_UNSAFE'],
    ['PSI is not procfs', (f) => { f.state.procType = 0xef53n; }, 'RESOURCE_BOUNDARY_UNSAFE'],
    ['cgroup namespace differs', (f) => { f.state.namespace = 'cgroup:[other]'; }, 'RESOURCE_BOUNDARY_UNSAFE'],
    ['pool ancestor replaceable', (f) => { f.metadataOverrides.set('/sys/fs', { mode: 0o40777n }); }, 'RESOURCE_BOUNDARY_UNSAFE'],
    ['child delegated to user', (f) => { f.metadataOverrides.set(`${f.pool}/teleagent-provider.slice`, { uid: 1000n }); }, 'RESOURCE_BOUNDARY_UNSAFE'],
    ['symlink child', (f) => { f.metadataOverrides.set(`${f.pool}/teleagent-provider.slice`, { isDirectory: () => false }); }, 'RESOURCE_BOUNDARY_UNSAFE'],
    ['user-owned evidence', (f) => { f.metadataOverrides.set(`${f.pool}/memory.current`, { uid: 1000n }); }, 'RESOURCE_BOUNDARY_UNSAFE'],
    ['writable cgroup evidence', (f) => { f.metadataOverrides.set(`${f.pool}/memory.current`, { mode: 0o100666n }); }, 'RESOURCE_BOUNDARY_UNSAFE'],
    ['unknown child', (f) => { f.state.extraChild = true; }, 'RESOURCE_POOL_TOPOLOGY_MISMATCH'],
    ['pool has direct processes', (f) => { f.texts.set(`${f.pool}/cgroup.procs`, '42\n'); }, 'RESOURCE_POOL_TOPOLOGY_MISMATCH'],
    ['unbounded CPU quota', (f) => { f.texts.set(`${f.pool}/cpu.max`, 'max 100000\n'); }, 'RESOURCE_POOL_TOPOLOGY_MISMATCH'],
    ['threaded cgroup', (f) => { f.texts.set(`${f.pool}/cgroup.type`, 'threaded\n'); }, 'RESOURCE_EVIDENCE_INVALID'],
    ['unbounded memory cap', (f) => { f.texts.set(`${f.pool}/memory.max`, 'max\n'); }, 'RESOURCE_EVIDENCE_INVALID'],
    ['oversized evidence', (f) => { f.texts.set(`${f.pool}/memory.current`, '1'.repeat(16385)); }, 'RESOURCE_EVIDENCE_INVALID'],
  ];
  for (const [name, mutate, code] of cases) {
    await t.test(name, (sub) => {
      const fixture = kernelFixture(sub); mutate(fixture);
      assert.throws(() => admission.collectSnapshot(fixture.policy), { code });
    });
  }
  await t.test('profile ancestry is protected', (sub) => {
    const fixture = kernelFixture(sub);
    fixture.metadataOverrides.set('/etc/teleagent', { uid: 1000n });
    assert.throws(() => admission.readProductionProfile(), { code: 'RESOURCE_BOUNDARY_UNSAFE' });
  });
  await t.test('missing evidence becomes a bounded refusal', async (sub) => {
    const fixture = kernelFixture(sub);
    fixture.texts.delete(`${fixture.pool}/memory.current`);
    await assert.rejects(admission.assertResourceAdmission(), { code: 'RESOURCE_EVIDENCE_UNAVAILABLE' });
  });
});
