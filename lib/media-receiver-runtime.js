'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const ADMISSION_FILE = '/run/teleagent-media/receiver-runtime.json';
const REQUIRED_SOURCES = Object.freeze([
  'lib/media-receiver-runtime.js',
  'lib/voice-egress-runtime.js',
  'voice-app/index.js',
  'voice-app/lib/http-server.js',
  'voice-app/lib/isolated-media-http.js',
  'voice-app/lib/media-playback-urls.js',
  'voice-app/lib/media-control-endpoints.js',
  'voice-app/lib/tts-service.js',
  'voice-app/lib/conversation-loop.js',
  'voice-app/lib/realtime-conversation.js',
  'voice-app/lib/voice-egress-transport.js',
  'voice-app/lib/openai-realtime-client.js',
  'voice-app/lib/whisper-client.js',
  'voice-app/lib/legacy-speech-config.js',
  'voice-app/node_modules/ws/lib/websocket.js',
  'voice-app/node_modules/axios/dist/node/axios.cjs',
  'voice-app/node_modules/drachtio-fsmrf/lib/mrf.js',
  'voice-app/node_modules/drachtio-fsmrf/lib/mediaserver.js',
]);
const contexts = new WeakSet();
function need(condition) {
  if (!condition) {
    const error = new Error('independent media runtime admission is unavailable or changed');
    error.code = 'MEDIA_RUNTIME_ADMISSION_REFUSED';
    throw error;
  }
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`; }
function sha(value) { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value); }
function keys(value, names) {
  need(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(' ') === names.split(' ').sort().join(' '));
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
function privateIp(value) {
  if (net.isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function protectedRead(filename, io) {
  need(path.isAbsolute(filename));
  const parents = [path.parse(filename).root, ...path.dirname(filename).split('/').filter(Boolean)
    .map((_, index, parts) => `/${parts.slice(0, index + 1).join('/')}`)];
  for (const directory of parents) {
    const info = io.lstatSync(directory);
    need(info.isDirectory() && info.uid === 0 && info.gid === 0 && !(info.mode & 0o022));
  }
  const before = io.lstatSync(filename);
  need(before.isFile() && before.uid === 0 && before.gid === 0 && !(before.mode & 0o022) && before.nlink === 1 && before.size <= 1024 * 1024);
  const fd = io.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = io.fstatSync(fd);
    need(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size);
    const bytes = io.readFileSync(fd);
    need(bytes.length <= 1024 * 1024);
    return bytes;
  } finally { io.closeSync(fd); }
}
function currentIdentity(io) {
  const stat = io.readFileSync('/proc/self/stat', 'utf8');
  const namespacePid = Number(stat.match(/^([1-9][0-9]*) \(/u)?.[1]);
  need(Number.isSafeInteger(namespacePid) && namespacePid > 0);
  const fields = stat.split(') ').slice(-1)[0].trim().split(/\s+/u);
  need(!['Z', 'X'].includes(fields[0]) && /^[1-9][0-9]*$/u.test(fields[19]));
  const status = io.readFileSync('/proc/self/status', 'utf8').match(/^Uid:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/mu);
  need(status && new Set(status.slice(1)).size === 1);
  const namespace = io.statSync('/proc/self/ns/net');
  return { bootId: io.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    uid: Number(status[1]), namespacePid, startTicks: fields[19], namespaceDevice: namespace.dev, namespaceInode: namespace.ino };
}

function validateRuntimeAdmission(record, current, observedSources) {
  keys(record, 'schema generation imageId topologySchema topologyDigest effectivePolicyDigest rendererClosureDigest approvedRuntimeSources identity projection projectionDigest');
  need(record.schema === 'teleagent.media-receiver-runtime-admission.v1' &&
    typeof record.generation === 'string' && /^[a-f0-9]{64}$/u.test(record.generation) && sha(record.imageId) &&
    record.topologySchema === 'teleagent.receiver-safe-sip-media-topology.v2' && sha(record.topologyDigest) &&
    sha(record.effectivePolicyDigest) && sha(record.rendererClosureDigest));
  keys(record.identity, 'bootId uid namespacePid startTicks namespaceDevice namespaceInode');
  need(canonical(record.identity) === canonical(current) && current.uid > 0 && current.uid < 1000);
  need(Object.keys(record.approvedRuntimeSources).sort().join('\n') === [...REQUIRED_SOURCES].sort().join('\n') &&
    Object.values(record.approvedRuntimeSources).every(sha) && canonical(record.approvedRuntimeSources) === canonical(observedSources));
  const projection = record.projection;
  need(projection && projection.schema === 'teleagent.media-receiver-endpoint-projection.v1' &&
    projection.topologyDigest === record.topologyDigest && projection.readyToLaunch === false);
  const { projectionDigest, ...unsigned } = projection;
  need(sha(record.projectionDigest) && projectionDigest === record.projectionDigest && digest(canonical(unsigned)) === projectionDigest);
  const http = projection.privateHttpAudio, esl = projection.reverseEsl, control = projection.controlHttp;
  need(http && esl && privateIp(http.host) && privateIp(http.allowedPeer) && http.host !== http.allowedPeer && http.port === 3000 &&
    http.baseUrl === `http://${http.host}:3000` && canonical(http.methods) === '["GET","HEAD"]' &&
    canonical(http.routes) === '["/audio-files/:filename","/static/*"]' &&
    http.controlRoutesPermitted === false && http.listenWildcardPermitted === false &&
    canonical(control) === '{"host":"127.0.0.1","port":3000}' &&
    esl.listenAddress === http.host && esl.advertisedAddress === http.host && esl.listenPort === 3002 && esl.advertisedPort === 3002 &&
    esl.allowedPeer === http.allowedPeer && projection.freeswitchControlTarget.address === http.allowedPeer &&
    projection.freeswitchControlTarget.port === 8021 && projection.freeswitchControlTarget.profile === 'drachtio_mrf');
  const env = projection.voiceEnvironment;
  need(env && privateIp(env.DRACHTIO_HOST) && ![http.host, http.allowedPeer].includes(env.DRACHTIO_HOST) &&
    env.DRACHTIO_PORT === '9022' && env.FREESWITCH_HOST === http.allowedPeer && env.FREESWITCH_PORT === '8021' &&
    env.WS_HOST === http.host && env.WS_CONNECT_HOST === http.host && env.WS_PORT === '3001' &&
    env.WS_NON_LOOPBACK_ENABLED === 'true' && env.WS_ALLOWED_PEERS === http.allowedPeer &&
    canonical(projection.audioForkOptions) === canonical({ host: http.host, connectHost: http.host, port: 3001,
      allowNonLoopback: true, allowedPeers: [http.allowedPeer] }));
  for (const [name, service, address, port] of [
    ['drachtio-admin', 'drachtio', env.DRACHTIO_HOST, 9022], ['freeswitch-esl', 'freeswitch', http.allowedPeer, 8021],
    ['voice-audiofork', 'voice', http.host, 3001], ['voice-media-http', 'voice', http.host, 3000],
    ['voice-reverse-esl', 'voice', http.host, 3002],
  ]) {
    const endpoint = projection.endpoints?.[name];
    need(endpoint && endpoint.service === service && endpoint.protocol === 'tcp' && endpoint.address === address &&
      endpoint.ports?.start === port && endpoint.ports.end === port);
  }
  return freeze(structuredClone(record));
}

function loadMediaReceiverRuntime({ io = fs, imageRoot = '/app' } = {}) {
  const bytes = protectedRead(ADMISSION_FILE, io);
  const record = JSON.parse(bytes.toString('utf8'));
  need(bytes.toString('utf8').trim() === canonical(record));
  // These digests come from the independent root-owned admission, not from
  // projection.sourceDigests. The authorizer must bind the whole image,
  // renderer/templates, effective kernel policy and retained live generation.
  const observedSources = Object.fromEntries(REQUIRED_SOURCES.map((filename) =>
    [filename, digest(protectedRead(path.join(imageRoot, filename), io))]));
  const admitted = validateRuntimeAdmission(record, currentIdentity(io), observedSources);
  const admissionDigest = digest(bytes);
  const runtime = Object.freeze({ projection: admitted.projection, generation: admitted.generation, imageId: admitted.imageId,
    assertCurrent() {
      need(digest(protectedRead(ADMISSION_FILE, io)) === admissionDigest &&
        canonical(currentIdentity(io)) === canonical(admitted.identity));
    },
  });
  contexts.add(runtime);
  return runtime;
}

function assertMediaReceiverRuntime(runtime) {
  need(runtime && contexts.has(runtime));
  runtime.assertCurrent();
  return runtime.projection;
}

module.exports = { ADMISSION_FILE, REQUIRED_SOURCES, canonical, digest, validateRuntimeAdmission,
  loadMediaReceiverRuntime, assertMediaReceiverRuntime, protectedRead, currentIdentity };
