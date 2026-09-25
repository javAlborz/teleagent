'use strict';

// Source candidate only. All inputs used for privileged admission are fixed,
// protected host files or exact local Docker/kernel observations. This module
// cannot commission its own authority or enable the unfinished runtime wiring.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CONTRACT = '/etc/teleagent-media/application-launch.json';
const AUTHORITY = '/usr/local/libexec/verify-teleagent-media-application';
const BOOT = '/proc/sys/kernel/random/boot_id';
const SOURCE_DIGEST = 'sha256:36dada2904ba928ef6189a8a1de5545876690f3cb2eecec8c36c37c1eb8c75dd';
const SERVICES = Object.freeze(['drachtio', 'freeswitch', 'voice-app']);
const ISOLATED_NAMES = Object.freeze({
  drachtio: 'teleagent-isolated-drachtio',
  freeswitch: 'teleagent-isolated-freeswitch',
  'voice-app': 'teleagent-isolated-voice-app',
});
const PEERS = Object.freeze(['asterisk', 'drachtio', 'freeswitch', 'voice']);
const LIMITS = Object.freeze({
  drachtio: [402653184, 1000000000, 256],
  freeswitch: [1073741824, 2000000000, 512],
  'voice-app': [1073741824, 2000000000, 512],
});
const CLEAN_ENV = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' });
const FORBIDDEN = Object.freeze(['hostname', 'domainname', 'ports', 'expose', 'dns', 'dns_search', 'dns_opt',
  'extra_hosts', 'links', 'external_links', 'mac_address', 'networks']);
// Deliberately excludes environment, command argv, labels and secret contents.
const INSPECT = '{"id":{{json .Id}},"image":{{json .Image}},"pid":{{json .State.Pid}},' +
  '"running":{{json .State.Running}},"status":{{json .State.Status}},"restarts":{{json .RestartCount}},' +
  '"network":{{json .HostConfig.NetworkMode}},"user":{{json .Config.User}},' +
  '"readonly":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},' +
  '"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},' +
  '"security":{{json .HostConfig.SecurityOpt}},"memory":{{json .HostConfig.Memory}},' +
  '"memorySwap":{{json .HostConfig.MemorySwap}},"nanoCpus":{{json .HostConfig.NanoCpus}},' +
  '"pidsLimit":{{json .HostConfig.PidsLimit}},"cgroupParent":{{json .HostConfig.CgroupParent}},' +
  '"pidMode":{{json .HostConfig.PidMode}},"ipcMode":{{json .HostConfig.IpcMode}},' +
  '"usernsMode":{{json .HostConfig.UsernsMode}},"publishAll":{{json .HostConfig.PublishAllPorts}},' +
  '"ports":{{json .HostConfig.PortBindings}},"dns":{{json .HostConfig.Dns}},' +
  '"dnsSearch":{{json .HostConfig.DnsSearch}},"dnsOptions":{{json .HostConfig.DnsOptions}},' +
  '"extraHosts":{{json .HostConfig.ExtraHosts}},"links":{{json .HostConfig.Links}},' +
  '"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}},' +
  '"devices":{{json .HostConfig.Devices}},' +
  '"deviceRequests":{{json .HostConfig.DeviceRequests}},"groupAdd":{{json .HostConfig.GroupAdd}},' +
  '"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},' +
  '"healthcheck":{{if .Config.Healthcheck}}{{json .Config.Healthcheck.Test}}{{else}}null{{end}}}';

function need(condition) {
  if (!condition) {
    const error = new Error('protected media application boundary refused');
    error.code = 'MEDIA_APPLICATION_REFUSED';
    throw error;
  }
}
function keys(value, names) {
  need(value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join(' ') === names.split(' ').sort().join(' '));
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`; }
function id(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function sha(value) { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value); }
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function systemUid(value) { return positive(value) && value < 1000; }

function validateContract(value, bootId) {
  keys(value, 'schema releaseRoot bootstrap workloads');
  need(value.schema === 'teleagent.media-application-contract.v1' &&
    /^\/opt\/teleagent\/releases\/sha256-[a-f0-9]{64}$/u.test(value.releaseRoot));
  const bootstrap = value.bootstrap;
  keys(bootstrap, 'schema bootId configurationDigest services anchorTrust purpose applicationPlacementProven livePacketProbesProven');
  need(bootstrap.schema === 'teleagent.media-docker-launcher-contract.v1' && bootstrap.bootId === bootId &&
    /^[a-f0-9-]{36}$/u.test(bootId) && sha(bootstrap.configurationDigest) &&
    bootstrap.purpose === 'coordinated-application-bootstrap' &&
    bootstrap.applicationPlacementProven === false && bootstrap.livePacketProbesProven === false);
  const trust = bootstrap.anchorTrust;
  keys(trust, 'imageId sourceDigest buildEvidenceDigest executable arguments containerExecPermitted healthcheck additionalProcessesPermitted');
  need(sha(trust.imageId) && trust.sourceDigest === SOURCE_DIGEST && sha(trust.buildEvidenceDigest) &&
    trust.executable === '/usr/local/bin/teleagent-netns-anchor' && canonical(trust.arguments) === '[]' &&
    trust.containerExecPermitted === false && trust.healthcheck === 'NONE' && trust.additionalProcessesPermitted === false);
  keys(bootstrap.services, PEERS.join(' '));
  const identifiers = new Set(), namespaces = new Set(), uids = new Set();
  for (const peer of PEERS) {
    const anchor = bootstrap.services[peer];
    keys(anchor, 'containerId imageId pid startTicks namespaceDevice namespaceInode networkMode namespace applicationUid');
    need(id(anchor.containerId) && anchor.imageId === trust.imageId && positive(anchor.pid) && anchor.pid > 1 &&
      typeof anchor.startTicks === 'string' && /^[1-9][0-9]*$/u.test(anchor.startTicks) &&
      positive(anchor.namespaceDevice) && positive(anchor.namespaceInode) &&
      anchor.networkMode === `container:${anchor.containerId}` && /^tm-[a-z]+$/u.test(anchor.namespace) && systemUid(anchor.applicationUid));
    identifiers.add(anchor.containerId);
    namespaces.add(`${anchor.namespaceDevice}:${anchor.namespaceInode}`);
    uids.add(anchor.applicationUid);
  }
  need(identifiers.size === 4 && namespaces.size === 4 && uids.size === 4);
  keys(value.workloads, SERVICES.join(' '));
  for (const service of SERVICES) {
    const workload = value.workloads[service];
    keys(workload, 'imageId uid gid sandboxDigest');
    const peer = service === 'voice-app' ? 'voice' : service;
    need(sha(workload.imageId) && workload.uid === bootstrap.services[peer].applicationUid &&
      systemUid(workload.gid) && sha(workload.sandboxDigest));
  }
  return value;
}

function protectedFile(filename, io = fs) {
  need(path.isAbsolute(filename));
  for (const directory of [path.parse(filename).root, ...path.dirname(filename).split('/').filter(Boolean)
    .map((_, index, parts) => `/${parts.slice(0, index + 1).join('/')}`)]) {
    const info = io.lstatSync(directory);
    need(info.isDirectory() && info.uid === 0 && info.gid === 0 && !(info.mode & 0o022));
  }
  const info = io.lstatSync(filename);
  need(info.isFile() && info.uid === 0 && info.gid === 0 && !(info.mode & 0o022) && info.nlink === 1 && info.size <= 262144);
  const fd = io.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = io.fstatSync(fd);
    need(opened.dev === info.dev && opened.ino === info.ino && opened.size === info.size);
    return io.readFileSync(fd, 'utf8');
  } finally { io.closeSync(fd); }
}

function command(executable, args, { lifecycleFd = null } = {}) {
  need(Number.isSafeInteger(lifecycleFd) && lifecycleFd >= 3);
  const result = spawnSync(executable, args, { encoding: 'utf8', env: CLEAN_ENV, timeout: 15000,
    killSignal: 'SIGKILL', maxBuffer: 262144, stdio: ['ignore', 'pipe', 'pipe', lifecycleFd] });
  need(!result.error && result.status === 0);
  return result.stdout;
}

function loadAdmission(releaseRoot, stage, evidenceDigest,
  { io = fs, run = command, lifecycleFd = null } = {}) {
  need(['bootstrap', 'created', 'running', 'restart'].includes(stage) && sha(evidenceDigest));
  const source = protectedFile(CONTRACT, io);
  const bootId = io.readFileSync(BOOT, 'utf8').trim();
  const parsed = JSON.parse(source);
  need(source.trim() === canonical(parsed)); // duplicates/noncanonical input is not authority
  const contract = validateContract(parsed, bootId);
  need(contract.releaseRoot === releaseRoot);
  protectedFile(AUTHORITY, io);
  const contractDigest = digest(source);
  const expected = { schema: 'teleagent.media-application-admission.v1', stage, contractDigest, bootId,
    releaseRoot, evidenceDigest };
  // The separately managed host verifier admits only a read-only bootstrap.
  // Created, running and restart admission still require a retained lifecycle
  // transaction; it must never merely echo these arguments.
  const response = run(AUTHORITY, ['--admit-media-application', stage, contractDigest, bootId, releaseRoot, evidenceDigest],
    { lifecycleFd });
  need(canonical(JSON.parse(response)) === canonical(expected));
  return contract;
}

function exactComposeCandidate(document, contract) {
  need(document && typeof document === 'object');
  keys(document.services, 'drachtio freeswitch voice-app voice-runtime-preflight');
  const candidate = structuredClone(document);
  need(candidate.services['voice-runtime-preflight'].network_mode === 'none');
  for (const service of SERVICES) {
    const config = candidate.services[service];
    need(config && FORBIDDEN.every((name) => !(name in config)) &&
      ['host', undefined].includes(config.network_mode) &&
      [service, undefined].includes(config.container_name));
    const peer = service === 'voice-app' ? 'voice' : service;
    config.network_mode = contract.bootstrap.services[peer].networkMode;
    // Legacy keeps the three global names while its call path is active.
    // Separate names let the isolated project be created and checked first.
    config.container_name = ISOLATED_NAMES[service];
    config.image = contract.workloads[service].imageId;
    config.userns_mode = 'host';
    config.healthcheck = { disable: true };
  }
  // No command, mount, environment or named-volume rewriting is performed.
  return candidate;
}

function profile(value) {
  const { id: _id, image: _image, pid: _pid, running: _running, status: _status, restarts: _restarts, ...sandbox } = value;
  return digest(canonical(sandbox));
}
function empty(value) { return value === null || canonical(value) === '[]' || canonical(value) === '{}'; }
function validateDocker(value, service, contract, containerId, running) {
  const workload = contract.workloads[service];
  const anchor = contract.bootstrap.services[service === 'voice-app' ? 'voice' : service];
  const [memory, nanoCpus, pidsLimit] = LIMITS[service];
  need(value.id === containerId && id(containerId) && value.image === workload.imageId &&
    value.network === anchor.networkMode && value.user === `${workload.uid}:${workload.gid}` &&
    value.readonly === true && value.privileged === false && canonical(value.capDrop) === '["ALL"]' &&
    canonical(value.security) === '["no-new-privileges:true"]' && value.memory === memory && value.memorySwap === memory &&
    value.nanoCpus === nanoCpus && value.pidsLimit === pidsLimit && value.cgroupParent === 'teleagent-voice-containers.slice' &&
    value.pidMode === '' && value.ipcMode === 'private' && value.usernsMode === 'host' &&
    value.publishAll === false && value.restartPolicy === 'no' && canonical(value.healthcheck) === '["NONE"]' &&
    ['capAdd', 'ports', 'dns', 'dnsSearch', 'dnsOptions', 'extraHosts', 'links', 'devices', 'deviceRequests', 'groupAdd'].every((key) => empty(value[key])) &&
    value.restarts === 0 && profile(value) === workload.sandboxDigest);
  need(running ? value.running === true && value.status === 'running' && positive(value.pid) && value.pid > 1 :
    value.running === false && value.status === 'created' && value.pid === 0);
  return value;
}

function startTicks(text) {
  const fields = text.slice(text.lastIndexOf(') ') + 2).trim().split(/\s+/u);
  need(fields.length >= 20 && !['Z', 'X'].includes(fields[0]) && /^[1-9][0-9]*$/u.test(fields[19]));
  return fields[19];
}
function kernelProcess(pid, expected, io = fs) {
  const root = `/proc/${pid}`;
  const before = startTicks(io.readFileSync(`${root}/stat`, 'utf8'));
  const status = Object.fromEntries(io.readFileSync(`${root}/status`, 'utf8').trim().split('\n').map((line) => {
    const index = line.indexOf(':'); return [line.slice(0, index), line.slice(index + 1).trim()];
  }));
  need(status.Uid.split(/\s+/u).every((uid) => uid === String(expected.uid)) && status.Uid.split(/\s+/u).length === 4 &&
    status.Gid.split(/\s+/u).every((gid) => gid === String(expected.gid)) && status.Gid.split(/\s+/u).length === 4 &&
    status.Groups.split(/\s+/u).filter(Boolean).every((gid) => gid === String(expected.gid)) &&
    ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].every((key) => /^0+$/u.test(status[key])) &&
    status.NoNewPrivs === '1' && status.Seccomp === '2');
  need(io.readFileSync(`${root}/cgroup`, 'utf8').trim() === `0::${expected.cgroup}`);
  const namespace = io.statSync(`${root}/ns/net`);
  need(namespace.dev === expected.namespaceDevice && namespace.ino === expected.namespaceInode &&
    before === startTicks(io.readFileSync(`${root}/stat`, 'utf8')) && (!expected.startTicks || before === expected.startTicks));
  return { pid, startTicks: before, namespaceDevice: namespace.dev, namespaceInode: namespace.ino, cgroup: expected.cgroup };
}

function kernelLimits(cgroup, limits, io = fs) {
  const [memory, nanoCpus, pidsLimit] = limits;
  const expected = { 'memory.max': String(memory), 'memory.swap.max': '0', 'pids.max': String(pidsLimit),
    'cpu.max': `${nanoCpus / 10000} 100000` };
  for (const [file, value] of Object.entries(expected)) {
    need(io.readFileSync(`/sys/fs/cgroup${cgroup}/${file}`, 'utf8').trim() === value);
  }
}

function verifyTasksOnce(contract, placements, io) {
  const expected = new Map();
  const admittedCgroups = new Map();
  for (const peer of PEERS) {
    const anchor = contract.bootstrap.services[peer];
    const key = `${anchor.namespaceDevice}:${anchor.namespaceInode}`;
    const service = peer === 'voice' ? 'voice-app' : peer;
    expected.set(key, { anchor, service, tasks: [] });
    admittedCgroups.set(`0::/teleagent.slice/teleagent-media.slice/docker-${anchor.containerId}.scope`, key);
    if (placements[service]) admittedCgroups.set(
      `0::/teleagent.slice/teleagent-voice.slice/teleagent-voice-containers.slice/docker-${placements[service]}.scope`, key);
  }
  for (const processId of io.readdirSync('/proc').filter((value) => /^[1-9][0-9]*$/u.test(value))) {
    for (const taskId of io.readdirSync(`/proc/${processId}/task`)) {
      const task = `/proc/${processId}/task/${taskId}`;
      const namespace = io.statSync(`${task}/ns/net`);
      const namespaceKey = `${namespace.dev}:${namespace.ino}`;
      const cgroup = io.readFileSync(`${task}/cgroup`, 'utf8').trim();
      need(![...admittedCgroups.keys()].some((scope) => cgroup.startsWith(`${scope}/`)));
      need(!admittedCgroups.has(cgroup) || admittedCgroups.get(cgroup) === namespaceKey);
      const match = expected.get(namespaceKey);
      if (!match) continue;
      const anchorGroup = `0::/teleagent.slice/teleagent-media.slice/docker-${match.anchor.containerId}.scope`;
      const workloadId = placements[match.service];
      const workloadGroup = `0::/teleagent.slice/teleagent-voice.slice/teleagent-voice-containers.slice/docker-${workloadId}.scope`;
      const isAnchor = Number(processId) === match.anchor.pid && Number(taskId) === match.anchor.pid && cgroup === anchorGroup;
      need(isAnchor || (workloadId && cgroup === workloadGroup));
      if (!isAnchor) {
        const workload = contract.workloads[match.service];
        kernelProcess(Number(taskId), { ...match.anchor, startTicks: null, uid: workload.uid, gid: workload.gid,
          cgroup: workloadGroup.slice(3) }, io);
      }
      match.tasks.push({ pid: Number(processId), tid: Number(taskId), cgroup });
    }
  }
  for (const value of expected.values()) need(value.tasks.some((task) => task.pid === value.anchor.pid && task.tid === value.anchor.pid));
  return Object.fromEntries([...expected].map(([namespace, value]) => [namespace, value.tasks.sort((a, b) => a.tid - b.tid)]));
}

function verifyTasks(contract, placements, io = fs) {
  // A process can exit between the /proc listing and its task read on a busy
  // host. Retry the complete inventory a fixed number of times; any stable
  // foreign task, privilege mismatch or unreadable non-racy state still fails.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return verifyTasksOnce(contract, placements, io); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ESRCH'].includes(error.code) || attempt === 4) throw error;
    }
  }
  need(false);
}

function verifyPlacement(contract, placements, { inspect, anchorCheck, io = fs, stage = 'running' } = {}) {
  need(['created', 'running', 'restart'].includes(stage) && typeof inspect === 'function' && typeof anchorCheck === 'function');
  keys(placements, SERVICES.join(' '));
  need(new Set(Object.values(placements)).size === 3 && Object.values(placements).every(id));
  // The anchor manager's bootstrap check refuses running applications. A
  // coordinated authority must instead return this exact saved bootstrap
  // after independently verifying its anchors alongside admitted workloads.
  need(canonical(anchorCheck()) === canonical(contract.bootstrap));
  const evidence = {};
  for (const service of SERVICES) {
    const observed = validateDocker(inspect(placements[service]), service, contract, placements[service], stage !== 'created');
    if (stage !== 'created') {
      const anchor = contract.bootstrap.services[service === 'voice-app' ? 'voice' : service];
      const workload = contract.workloads[service];
      evidence[service] = kernelProcess(observed.pid, { ...anchor, startTicks: null, uid: workload.uid, gid: workload.gid,
        cgroup: `/teleagent.slice/teleagent-voice.slice/teleagent-voice-containers.slice/docker-${observed.id}.scope` }, io);
      kernelLimits(evidence[service].cgroup, LIMITS[service], io);
    }
    need(canonical(inspect(placements[service])) === canonical(observed));
  }
  evidence.tasks = verifyTasks(contract, stage === 'created' ? {} : placements, io);
  if (stage !== 'created') {
    for (const service of SERVICES) {
      const process = evidence[service];
      need(evidence.tasks[`${process.namespaceDevice}:${process.namespaceInode}`].some((task) =>
        task.pid === process.pid && task.tid === process.pid));
    }
  }
  need(canonical(anchorCheck()) === canonical(contract.bootstrap));
  return { schema: 'teleagent.media-application-observation.v1', stage, placements, processes: evidence };
}

function inspectDocker(containerId) {
  need(id(containerId));
  need(protectedFile('/etc/teleagent-media/docker-client/config.json').trim() === '{}');
  return JSON.parse(command('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', '--config',
    '/etc/teleagent-media/docker-client', 'inspect', '--type', 'container', '--format', INSPECT, containerId]));
}

function verifyProtectedPlacement(releaseRoot, placements, stage, { lifecycleFd = null } = {}) {
  const inputDigest = digest(canonical(placements));
  const contract = loadAdmission(releaseRoot, stage, inputDigest, { lifecycleFd });
  const observation = verifyPlacement(contract, placements, {
    stage, inspect: inspectDocker,
    anchorCheck: () => loadAdmission(releaseRoot, stage, inputDigest, { lifecycleFd }).bootstrap,
  });
  // Admission must bind this particular evidence and retain the lifecycle
  // fence through the caller's eventual mutation, not a reusable JSON token.
  const admitted = loadAdmission(releaseRoot, stage, digest(canonical(observation)), { lifecycleFd });
  need(canonical(admitted) === canonical(contract));
  return observation;
}

function requireRuntimeIntegration() {
  // This source slice intentionally cannot bless loopback-only SIP/ESL/media,
  // host HTTP health probes, absent public WSS/legacy STT-TTS egress, or an
  // uncoordinated Asterisk lifecycle. Those integrations need their own review.
  const error = new Error('media endpoint, readiness, egress and coordinated PBX integration remain uncommissioned');
  error.code = 'MEDIA_RUNTIME_UNCOMMISSIONED';
  throw error;
}

module.exports = { CONTRACT, AUTHORITY, INSPECT, SOURCE_DIGEST, LIMITS, canonical, digest, validateContract,
  protectedFile, loadAdmission, exactComposeCandidate, profile, validateDocker, startTicks, kernelProcess,
  kernelLimits, verifyTasks, verifyPlacement, verifyProtectedPlacement, requireRuntimeIntegration };
