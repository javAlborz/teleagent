'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const boundary = require('../../deploy/voice-stack/media-application-boundary');
const BOOT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RELEASE = `/opt/teleagent/releases/sha256-${'e'.repeat(64)}`;
const IDS = { drachtio: 'a'.repeat(64), freeswitch: 'b'.repeat(64), 'voice-app': 'c'.repeat(64) };

function fixture() {
  const services = {};
  for (const [index, service] of ['asterisk', 'drachtio', 'freeswitch', 'voice'].entries()) {
    const containerId = String(index + 1).repeat(64);
    services[service] = { containerId, imageId: `sha256:${'f'.repeat(64)}`, pid: 100 + index, startTicks: '999',
      namespaceDevice: 4, namespaceInode: 1000 + index, networkMode: `container:${containerId}`,
      namespace: `tm-${service}`, applicationUid: 980 + index };
  }
  const contract = { schema: 'teleagent.media-application-contract.v1', releaseRoot: RELEASE,
    bootstrap: { schema: 'teleagent.media-docker-launcher-contract.v1', bootId: BOOT,
      configurationDigest: `sha256:${'1'.repeat(64)}`, services,
      anchorTrust: { imageId: `sha256:${'f'.repeat(64)}`, sourceDigest: boundary.SOURCE_DIGEST,
        buildEvidenceDigest: `sha256:${'2'.repeat(64)}`, executable: '/usr/local/bin/teleagent-netns-anchor',
        arguments: [], containerExecPermitted: false, healthcheck: 'NONE', additionalProcessesPermitted: false },
      purpose: 'coordinated-application-bootstrap', applicationPlacementProven: false, livePacketProbesProven: false },
    workloads: {} };
  for (const service of Object.keys(IDS)) {
    const peer = service === 'voice-app' ? 'voice' : service;
    contract.workloads[service] = { imageId: `sha256:${'d'.repeat(64)}`, uid: services[peer].applicationUid,
      gid: services[peer].applicationUid, sandboxDigest: `sha256:${'0'.repeat(64)}` };
    contract.workloads[service].sandboxDigest = boundary.profile(inspection(contract, service));
  }
  return contract;
}
function inspection(contract, service, running = true) {
  const workload = contract.workloads[service];
  const peer = service === 'voice-app' ? 'voice' : service;
  const [memory, nanoCpus, pidsLimit] = boundary.LIMITS[service];
  return { id: IDS[service], image: workload.imageId, pid: running ? 1234 : 0, running,
    status: running ? 'running' : 'created', restarts: 0,
    network: contract.bootstrap.services[peer].networkMode, user: `${workload.uid}:${workload.gid}`,
    readonly: true, privileged: false, capAdd: null, capDrop: ['ALL'], security: ['no-new-privileges:true'],
    memory, memorySwap: memory, nanoCpus, pidsLimit, cgroupParent: 'teleagent-voice-containers.slice',
    pidMode: '', ipcMode: 'private', usernsMode: 'host', publishAll: false, ports: null, dns: [],
    dnsSearch: [], dnsOptions: [], extraHosts: null, links: null, mounts: [],
    tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16777216' },
    devices: [], deviceRequests: null,
    groupAdd: null, restartPolicy: 'no', healthcheck: ['NONE'] };
}
function stat(start = '77') { return `1234 (name has ) brackets) S ${Array(18).fill('0').join(' ')} ${start} 0`; }
function kernelIo(expected) {
  const status = `Uid:\t${Array(4).fill(expected.uid).join(' ')}\nGid:\t${Array(4).fill(expected.gid).join(' ')}\nGroups:\t\n` +
    'CapInh:\t0000\nCapPrm:\t0000\nCapEff:\t0000\nCapBnd:\t0000\nCapAmb:\t0000\nNoNewPrivs:\t1\nSeccomp:\t2\n';
  return { readFileSync(filename) {
    if (filename.endsWith('/stat')) return stat();
    if (filename.endsWith('/status')) return status;
    if (filename.endsWith('/cgroup')) return `0::${expected.cgroup}`;
    throw new Error('unexpected file');
  }, statSync() { return { dev: expected.namespaceDevice, ino: expected.namespaceInode }; } };
}

test('contract binds immutable boot, release, four distinct anchors and approved source provenance', () => {
  const good = fixture();
  assert.equal(boundary.validateContract(good, BOOT), good);
  for (const modify of [
    (x) => { x.bootstrap.bootId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; },
    (x) => { x.bootstrap.services.voice.networkMode = 'host'; },
    (x) => { x.bootstrap.services.voice.containerId = 'voice-anchor'; },
    (x) => { x.bootstrap.services.voice.namespaceInode = x.bootstrap.services.drachtio.namespaceInode; },
    (x) => { x.bootstrap.anchorTrust.sourceDigest = `sha256:${'0'.repeat(64)}`; },
    (x) => { x.bootstrap.anchorTrust.arguments = ['sh']; },
    (x) => { x.bootstrap.anchorTrust.containerExecPermitted = true; },
    (x) => { x.bootstrap.applicationPlacementProven = true; },
    (x) => { x.releaseRoot = '/opt/teleagent/current'; },
    (x) => { x.workloads['voice-app'].uid = 1000; },
    (x) => { x.workloads['voice-app'].imageId = 'latest'; },
    (x) => { x.workloads['voice-app'].extra = true; },
  ]) {
    const changed = structuredClone(good); modify(changed);
    assert.throws(() => boundary.validateContract(changed, BOOT), { code: 'MEDIA_APPLICATION_REFUSED' });
  }
});

test('candidate selects exact IDs and keeps commands, credentials and all FreeSWITCH volumes unchanged', () => {
  const original = { services: { 'voice-runtime-preflight': { network_mode: 'none' } } };
  for (const service of Object.keys(IDS)) original.services[service] = {
    image: 'old', network_mode: 'host', container_name: service,
    command: ['fixed'], environment: { FIXED: 'value' },
    volumes: ['freeswitch-conf:/etc/freeswitch', 'freeswitch-log:/var/log/freeswitch', 'freeswitch-db:/var/lib/freeswitch/db'],
  };
  const contract = fixture();
  const result = boundary.exactComposeCandidate(original, contract);
  assert.equal(result.services['voice-runtime-preflight'].container_name, 'teleagent-isolated-voice-preflight');
  assert.equal(result.services['voice-runtime-preflight'].image, contract.workloads['voice-app'].imageId);
  assert.equal(result.services['voice-runtime-preflight'].userns_mode, 'host');
  assert.deepEqual(result.services['voice-runtime-preflight'].healthcheck, { disable: true });
  for (const service of Object.keys(IDS)) {
    assert.match(result.services[service].network_mode, /^container:[a-f0-9]{64}$/u);
    assert.equal(result.services[service].userns_mode, 'host');
    assert.equal(result.services[service].container_name, `teleagent-isolated-${service}`);
    assert.equal(original.services[service].container_name, service);
    assert.deepEqual(result.services[service].healthcheck, { disable: true });
    for (const key of ['command', 'environment', 'volumes']) assert.deepEqual(result.services[service][key], original.services[service][key]);
    assert.equal(original.services[service].network_mode, 'host');
  }
  for (const field of ['hostname', 'ports', 'dns', 'dns_search', 'extra_hosts', 'expose', 'networks']) {
    const changed = structuredClone(original); changed.services.drachtio[field] = [];
    assert.throws(() => boundary.exactComposeCandidate(changed, contract));
  }
  const conflicting = structuredClone(original);
  conflicting.services['voice-app'].container_name = 'voice-app-other';
  assert.throws(() => boundary.exactComposeCandidate(conflicting, contract));
});

test('container metadata refuses image, network, sandbox, restart and resource drift', () => {
  const contract = fixture();
  const value = inspection(contract, 'voice-app');
  boundary.validateDocker(value, 'voice-app', contract, IDS['voice-app'], true);
  boundary.validateDocker(inspection(contract, 'voice-app', false), 'voice-app', contract, IDS['voice-app'], false);
  for (const [key, changed] of Object.entries({ image: `sha256:${'0'.repeat(64)}`, network: 'host', user: '0:0', readonly: false,
    privileged: true, capAdd: ['NET_ADMIN'], security: [], memory: 0, memorySwap: -1, nanoCpus: 0, pidsLimit: 0,
    cgroupParent: 'system.slice', pidMode: 'host', ipcMode: 'host', usernsMode: '', publishAll: true,
    ports: { '80/tcp': [] }, dns: ['127.0.0.1'], mounts: [{ Source: '/' }],
    tmpfs: { '/tmp': 'rw,size=999999999' }, groupAdd: ['0'],
    restartPolicy: 'always', healthcheck: ['CMD-SHELL', 'true'], restarts: 1, running: false, pid: 0 })) {
    assert.throws(() => boundary.validateDocker({ ...value, [key]: changed }, 'voice-app', contract, IDS['voice-app'], true));
  }
});

test('kernel proof binds start generation, exact cgroup, namespace, UID and capability sets', () => {
  const expected = { uid: 983, gid: 983, namespaceDevice: 4, namespaceInode: 1003, cgroup: '/exact', startTicks: '77' };
  const io = kernelIo(expected);
  assert.equal(boundary.kernelProcess(1234, expected, io).startTicks, '77');
  for (const changed of [{ startTicks: '78' }, { namespaceInode: 1001 }, { cgroup: '/other' }, { uid: 0 }]) {
    assert.throws(() => boundary.kernelProcess(1234, { ...expected, ...changed }, io));
  }
  for (const replacement of ['CapBnd:\t0001', 'NoNewPrivs:\t0', 'Seccomp:\t0', 'Groups:\t0']) {
    const key = replacement.split(':')[0];
    const bad = { ...io, readFileSync(filename) {
      const value = io.readFileSync(filename);
      return filename.endsWith('/status') ? value.replace(new RegExp(`${key}:\\t[^\\n]*`, 'u'), replacement) : value;
    } };
    assert.throws(() => boundary.kernelProcess(1234, expected, bad));
  }
});

test('actual cgroup bounds refuse unbounded memory, swap, CPU or tasks', () => {
  const values = { 'memory.max': '402653184', 'memory.swap.max': '0', 'pids.max': '256', 'cpu.max': '100000 100000' };
  const io = { readFileSync(filename) { return values[path.basename(filename)]; } };
  boundary.kernelLimits('/exact', boundary.LIMITS.drachtio, io);
  for (const key of Object.keys(values)) {
    const saved = values[key]; values[key] = 'max';
    assert.throws(() => boundary.kernelLimits('/exact', boundary.LIMITS.drachtio, io)); values[key] = saved;
  }
});

test('namespace scan detects a foreign thread even when its process leader is elsewhere', () => {
  const contract = fixture();
  const processes = Object.values(contract.bootstrap.services).map((anchor) => String(anchor.pid));
  let foreign = false, missing = false, escaped = false;
  const io = { readdirSync(filename) {
    if (filename === '/proc') return [...processes, ...(foreign ? ['999'] : [])];
    return [filename.split('/')[2] === '999' ? '1001' : filename.split('/')[2]];
  }, statSync(filename) {
    if (missing) throw new Error('unreadable task');
    const pid = Number(filename.split('/')[2]);
    return { dev: 4, ino: escaped && pid === 103 ? 9999 : pid === 999 ? 1003 : 1000 + pid - 100 };
  }, readFileSync(filename) {
    const pid = Number(filename.split('/')[2]);
    if (pid === 999) return '0::/foreign';
    const anchor = Object.values(contract.bootstrap.services).find((value) => value.pid === pid);
    return `0::/teleagent.slice/teleagent-media.slice/docker-${anchor.containerId}.scope`;
  } };
  assert.equal(Object.keys(boundary.verifyTasks(contract, {}, io)).length, 4);
  foreign = true; assert.throws(() => boundary.verifyTasks(contract, {}, io));
  foreign = false; escaped = true; assert.throws(() => boundary.verifyTasks(contract, {}, io));
  escaped = false; missing = true; assert.throws(() => boundary.verifyTasks(contract, {}, io));
});

test('namespace scan retries only disappearing proc entries with a fixed bound', () => {
  const contract = fixture();
  const anchors = Object.values(contract.bootstrap.services);
  let races = 0;
  const io = { readdirSync(filename) {
    if (filename === '/proc') return anchors.map((anchor) => String(anchor.pid));
    if (races > 0) { races -= 1; throw Object.assign(new Error('exited during scan'), { code: 'ENOENT' }); }
    return [filename.split('/')[2]];
  }, statSync(filename) {
    const pid = Number(filename.split('/')[2]);
    return { dev: 4, ino: 1000 + pid - 100 };
  }, readFileSync(filename) {
    const pid = Number(filename.split('/')[2]);
    const anchor = anchors.find((value) => value.pid === pid);
    return `0::/teleagent.slice/teleagent-media.slice/docker-${anchor.containerId}.scope`;
  } };
  races = 4;
  assert.equal(Object.keys(boundary.verifyTasks(contract, {}, io)).length, 4);
  races = 5;
  assert.throws(() => boundary.verifyTasks(contract, {}, io), { code: 'ENOENT' });
  races = 0;
  io.readdirSync = () => { throw new Error('unreadable /proc'); };
  assert.throws(() => boundary.verifyTasks(contract, {}, io), /unreadable \/proc/u);
});

test('missing authority and unfinished runtime cannot fall back to legacy host networking', () => {
  assert.throws(() => boundary.loadAdmission(RELEASE, 'bootstrap', `sha256:${'0'.repeat(64)}`, {
    io: { lstatSync() { throw new Error('absent host authority'); } }, run() { assert.fail('must not execute'); },
  }));
  assert.throws(() => boundary.requireRuntimeIntegration(), { code: 'MEDIA_RUNTIME_UNCOMMISSIONED' });
  const source = fs.readFileSync(path.join(__dirname, '../../deploy/voice-stack/teleagent-voice-stack-launch.js'), 'utf8');
  const start = source.slice(source.indexOf('async function start(lifecycleFd) {'),
    source.indexOf('async function stop() {'));
  assert.ok(start.indexOf('prepareProtectedReceiverEndpoints(APP_ROOT, { lifecycleFd });') <
    start.indexOf('requireRuntimeIntegration();'));
  assert.ok(start.indexOf('requireRuntimeIntegration();') < start.indexOf('cleanupExactProject();'));
  assert.ok(start.indexOf('requireRuntimeIntegration();') < start.indexOf('readCredentialSet(identity)'));
});

test('host contract ownership and exact independent admission are mandatory', () => {
  const contract = fixture();
  const files = { [boundary.CONTRACT]: boundary.canonical(contract), [boundary.AUTHORITY]: '# reviewed authority' };
  let unsafe = false;
  const metadata = (filename) => ({ uid: unsafe ? 1000 : 0, gid: 0, mode: 0o644, nlink: 1, dev: 1, ino: 2,
    size: files[filename]?.length || 0, isFile: () => Object.hasOwn(files, filename), isDirectory: () => !Object.hasOwn(files, filename) });
  const io = { lstatSync: metadata, fstatSync: metadata, openSync: (filename) => filename, closeSync() {},
    readFileSync(filename) { return filename === '/proc/sys/kernel/random/boot_id' ? BOOT : files[filename]; } };
  const evidence = `sha256:${'a'.repeat(64)}`;
  const run = (executable, args, options) => {
    assert.equal(executable, boundary.AUTHORITY);
    assert.deepEqual(options, { lifecycleFd: 7 });
    assert.deepEqual(args, ['--admit-media-application', 'running', boundary.digest(files[boundary.CONTRACT]), BOOT, RELEASE, evidence]);
    return JSON.stringify({ schema: 'teleagent.media-application-admission.v1', stage: 'running',
      contractDigest: args[2], bootId: BOOT, releaseRoot: RELEASE, evidenceDigest: evidence });
  };
  assert.deepEqual(boundary.loadAdmission(RELEASE, 'running', evidence,
    { io, run, lifecycleFd: 7 }), contract);
  assert.throws(() => boundary.loadAdmission(RELEASE, 'running', evidence,
    { io, run: () => '{}', lifecycleFd: 7 }));
  files[boundary.CONTRACT] += ' '; // trailing space does not change canonical content
  assert.deepEqual(boundary.loadAdmission(RELEASE, 'running', evidence,
    { io, run, lifecycleFd: 7 }), contract);
  unsafe = true;
  assert.throws(() => boundary.loadAdmission(RELEASE, 'running', evidence, { io, run: () => assert.fail('unsafe authority executed') }));
});

test('placement refuses escaped workload tasks and init disappearance after kernel observation', () => {
  const contract = fixture();
  const processes = new Map();
  const containers = new Map();
  for (const anchor of Object.values(contract.bootstrap.services)) {
    processes.set(anchor.pid, { ...anchor,
      cgroup: `/teleagent.slice/teleagent-media.slice/docker-${anchor.containerId}.scope` });
  }
  for (const [index, service] of Object.keys(IDS).entries()) {
    const anchor = contract.bootstrap.services[service === 'voice-app' ? 'voice' : service];
    const pid = 200 + index;
    processes.set(pid, { ...anchor, ...contract.workloads[service], service, startTicks: '77',
      cgroup: `/teleagent.slice/teleagent-voice.slice/teleagent-voice-containers.slice/docker-${IDS[service]}.scope` });
    containers.set(IDS[service], { ...inspection(contract, service), pid });
  }
  let missingInit = false, escapedChild = false, nestedChild = false;
  const io = {
    readFileSync(filename) {
      if (filename.startsWith('/sys/fs/cgroup/')) {
        const record = [...processes.values()].find((value) => value.service && filename.includes(value.cgroup));
        const [memory, nanoCpus, pidsLimit] = boundary.LIMITS[record.service];
        return { 'memory.max': String(memory), 'memory.swap.max': '0', 'pids.max': String(pidsLimit),
          'cpu.max': `${nanoCpus / 10000} 100000` }[path.basename(filename)];
      }
      const pid = Number(filename.split('/')[2]);
      const expected = processes.get(pid === 999 ? 202 : pid);
      if (pid === 999 && nestedChild && filename.endsWith('/cgroup')) return `0::${expected.cgroup}/child`;
      return kernelIo(expected).readFileSync(filename);
    },
    statSync(filename) {
      const pid = Number(filename.split('/')[2]);
      if (pid === 999) return { dev: 4, ino: 9999 };
      const expected = processes.get(pid);
      return { dev: expected.namespaceDevice, ino: expected.namespaceInode };
    },
    readdirSync(filename) {
      if (filename === '/proc') return [...processes.keys()].filter((pid) => !missingInit || pid !== 202)
        .map(String).concat(escapedChild ? ['999'] : []);
      return [filename.split('/')[2]];
    },
  };
  const options = { io, inspect: (identifier) => containers.get(identifier), anchorCheck: () => contract.bootstrap };
  assert.equal(boundary.verifyPlacement(contract, IDS, options).stage, 'running');
  escapedChild = true;
  assert.throws(() => boundary.verifyPlacement(contract, IDS, options));
  nestedChild = true;
  assert.throws(() => boundary.verifyPlacement(contract, IDS, options));
  escapedChild = false; missingInit = true;
  assert.throws(() => boundary.verifyPlacement(contract, IDS, options));
});
