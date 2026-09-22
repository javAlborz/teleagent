'use strict';

// Deterministic, credential-free source projection. This module opens no socket,
// writes no configuration, and cannot remove the launcher's activation refusal.
const fs = require('node:fs');
const path = require('node:path');
const {
  TOPOLOGY_SCHEMA_V2,
  validateReceiverSafeSipMediaTopology,
} = require('../../lib/sip-media-boundary-contract');
const boundary = require('./media-application-boundary');

const NETWORK_CONFIG = '/etc/teleagent-media/docker-network.json';
const SOURCE_PATHS = Object.freeze({
  drachtio: 'deploy/voice-stack/drachtio.conf.xml.template',
  eventSocket: 'deploy/voice-stack/freeswitch-event-socket.conf.xml.template',
  profile: 'freeswitch/mrf.xml',
  core: 'freeswitch/switch.conf.xml',
});
const REMAINING_GATES = Object.freeze([
  'voice-reverse-esl-listener-and-flow',
  'freeswitch-private-http-audio-listener-and-flow',
  'protected-runtime-consumer-and-credential-projection',
  'provider-wss-and-legacy-speech-egress',
  'readiness-and-panic-transport',
  'coordinated-asterisk-lifetime-and-effective-rtp-attestation',
  'independent-authority-retained-handles-and-live-canaries',
]);

function refuse(condition) {
  if (!condition) {
    const error = new Error('receiver endpoint projection refused');
    error.code = 'MEDIA_ENDPOINT_PROJECTION_REFUSED';
    throw error;
  }
}
function exactKeys(value, names) {
  refuse(value && Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string' &&
      Object.getOwnPropertyDescriptor(value, key).enumerable &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) &&
    Object.keys(value).sort().join(' ') === names.split(' ').sort().join(' '));
}
function privateAddress(address) {
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}
function replaceExactly(source, original, replacement) {
  refuse(typeof source === 'string' && source.split(original).length === 2);
  return source.replace(original, replacement);
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function sources() {
  return Object.fromEntries(Object.entries(SOURCE_PATHS).map(([key, filename]) => [key,
    fs.readFileSync(path.resolve(__dirname, '../..', filename), 'utf8')]));
}

function renderReceiverEndpoints(networkConfig, applicationContract) {
  exactKeys(networkConfig, 'schema network anchor');
  refuse(networkConfig.schema === 'teleagent.media-docker-install.v1');
  exactKeys(networkConfig.network, 'schema topology boundary');
  refuse(networkConfig.network.schema === 'teleagent.media-network-install.v1');
  const validated = validateReceiverSafeSipMediaTopology(networkConfig.network.topology);
  const topology = validated.topology;
  const contract = boundary.validateContract(applicationContract, applicationContract?.bootstrap?.bootId);
  const configurationDigest = boundary.digest(boundary.canonical(networkConfig));
  refuse(contract.bootstrap.configurationDigest === configurationDigest);
  exactKeys(networkConfig.anchor, 'imageId sourceDigest buildEvidenceDigest uid gid cgroupParent');
  for (const key of ['imageId', 'sourceDigest', 'buildEvidenceDigest']) {
    refuse(networkConfig.anchor[key] === contract.bootstrap.anchorTrust[key]);
  }
  const services = Object.fromEntries(topology.services.map((service) => [service.id, service]));
  for (const service of topology.services) {
    const anchor = contract.bootstrap.services[service.id];
    refuse(service.namespace === anchor.namespace && service.uid === anchor.applicationUid &&
      privateAddress(service.link.serviceAddress) && privateAddress(service.link.policyAddress));
  }
  const listeners = Object.fromEntries(topology.listeners.map((listener) => [listener.id, listener]));
  const endpoint = (id) => {
    const listener = listeners[id];
    return { service: listener.service, address: services[listener.service].link.serviceAddress,
      protocol: listener.protocol, ports: listener.ports };
  };
  const endpoints = Object.fromEntries(topology.listeners.map((listener) => [listener.id, endpoint(listener.id)]));
  const dra = endpoints['drachtio-sip'];
  const fsSip = endpoints['freeswitch-sip'];
  const esl = endpoints['freeswitch-esl'];
  const audio = endpoints['voice-audiofork'];
  const admin = endpoints['drachtio-admin'];
  const ast = endpoints['asterisk-sip'];
  const rtp = endpoints['freeswitch-rtp'];
  const input = sources();

  let drachtio = replaceExactly(input.drachtio,
    '<admin port="9022" secret="__DRACHTIO_SECRET__">127.0.0.1</admin>',
    `<admin port="${admin.ports.start}" secret="__DRACHTIO_SECRET__">${admin.address}</admin>`);
  drachtio = replaceExactly(drachtio,
    '<contact external-ip="__DRACHTIO_EXTERNAL_IP__">sip:127.0.0.1:__DRACHTIO_SIP_PORT__;transport=__DRACHTIO_SIP_TRANSPORT__</contact>',
    `<contact external-ip="${dra.address}">sip:${dra.address}:${dra.ports.start};transport=${dra.protocol}</contact>`);
  let eventSocket = replaceExactly(input.eventSocket, 'name="listen-ip" value="127.0.0.1"',
    `name="listen-ip" value="${esl.address}"`);
  eventSocket = replaceExactly(eventSocket, 'name="listen-port" value="8021"', `name="listen-port" value="${esl.ports.start}"`);
  eventSocket = replaceExactly(eventSocket, '<param name="apply-inbound-acl" value="loopback.auto"/>',
    '<param name="apply-inbound-acl" value="teleagent-voice-esl"/>\n' +
    '    <param name="nat-map" value="false"/>\n    <param name="stop-on-bind-error" value="true"/>');
  let profile = input.profile;
  for (const key of ['rtp-ip', 'sip-ip', 'ext-rtp-ip', 'ext-sip-ip']) {
    profile = replaceExactly(profile, `name="${key}" value="127.0.0.1"`, `name="${key}" value="${fsSip.address}"`);
  }
  profile = replaceExactly(profile, 'name="sip-port" value="5080"', `name="sip-port" value="${fsSip.ports.start}"`);
  profile = replaceExactly(profile, '<param name="apply-nat-acl" value="nat.auto"/>',
    '<param name="apply-inbound-acl" value="teleagent-drachtio-sip"/>\n' +
    '      <param name="bind-params" value="transport=udp"/>');
  let core = replaceExactly(input.core, 'name="rtp-start-port" value="30000"', `name="rtp-start-port" value="${rtp.ports.start}"`);
  core = replaceExactly(core, 'name="rtp-end-port" value="30100"', `name="rtp-end-port" value="${rtp.ports.end}"`);
  const acl = '<?xml version="1.0"?>\n' +
    '<configuration name="acl.conf" description="Teleagent isolated receiver peers">\n  <network-lists>\n' +
    '    <list name="teleagent-voice-esl" default="deny">\n' +
    `      <node type="allow" cidr="${audio.address}/32"/>\n    </list>\n` +
    '    <list name="teleagent-drachtio-sip" default="deny">\n' +
    `      <node type="allow" cidr="${dra.address}/32"/>\n    </list>\n` +
    '  </network-lists>\n</configuration>\n';
  const files = {
    'drachtio.conf.xml.template': drachtio,
    'freeswitch-event-socket.conf.xml.template': eventSocket,
    'freeswitch-acl.conf.xml': acl,
    'freeswitch-mrf.xml': profile,
    'freeswitch-switch.conf.xml': core,
  };
  // Deliberately retain exactly the two existing credential slots. This module
  // neither accepts a secret nor produces installable authenticated configs.
  refuse(Object.values(files).join('').match(/__[A-Z_]+__/gu)?.sort().join(' ') ===
    '__DRACHTIO_SECRET__ __FREESWITCH_SECRET__');
  refuse(!Object.values(files).some((text) => /127\.0\.0\.1|0\.0\.0\.0|localhost/iu.test(text)));
  const voiceEnvironment = {
    DRACHTIO_HOST: admin.address, DRACHTIO_PORT: String(admin.ports.start),
    FREESWITCH_HOST: esl.address, FREESWITCH_PORT: String(esl.ports.start),
    SIP_TRUNK_HOST: ast.address, SIP_TRUNK_PORT: String(ast.ports.start), SIP_TRUNK_TRANSPORT: ast.protocol,
    WS_HOST: audio.address, WS_CONNECT_HOST: audio.address, WS_PORT: String(audio.ports.start),
    WS_NON_LOOPBACK_ENABLED: 'true', WS_ALLOWED_PEERS: fsSip.address,
  };
  const projection = {
    schema: 'teleagent.media-receiver-endpoint-projection.v1', topologyId: topology.topologyId,
    topologyDigest: validated.digest, configurationDigest, releaseRoot: contract.releaseRoot,
    sourceDigests: Object.fromEntries(Object.entries(input).map(([key, text]) => [SOURCE_PATHS[key], boundary.digest(text)])),
    endpoints, files, voiceEnvironment,
    audioForkOptions: { host: audio.address, connectHost: audio.address, port: audio.ports.start,
      allowNonLoopback: true, allowedPeers: [fsSip.address] },
    // This is the inbound ESL client target only. No reverse callback listen
    // address/port is invented while the v1 topology lacks that listener/flow.
    freeswitchControlTarget: { address: esl.address, port: esl.ports.start, profile: 'drachtio_mrf' },
    reverseEsl: null, privateHttpAudio: null,
    readyToLaunch: false, remainingGates: [...REMAINING_GATES],
  };
  if (topology.schema === TOPOLOGY_SCHEMA_V2) {
    const reverse = endpoints['voice-reverse-esl'];
    const http = endpoints['voice-media-http'];
    projection.reverseEsl = {
      listenAddress: reverse.address, listenPort: reverse.ports.start,
      advertisedAddress: reverse.address, advertisedPort: reverse.ports.start,
      allowedPeer: fsSip.address,
    };
    projection.privateHttpAudio = {
      host: http.address, port: http.ports.start, baseUrl: `http://${http.address}:${http.ports.start}`,
      allowedPeer: fsSip.address, methods: ['GET'], routes: ['/audio-files/:filename', '/static/*'],
      controlRoutesPermitted: false, listenWildcardPermitted: false,
    };
    projection.controlHttp = { host: '127.0.0.1', port: 3000 };
    projection.remainingGates = [
      'fixed-reverse-esl-consumer-and-peer-restriction',
      'dedicated-private-http-consumer-and-playback-urls',
      ...REMAINING_GATES.slice(2),
    ];
  }
  return freeze({ ...projection, projectionDigest: boundary.digest(boundary.canonical(projection)) });
}

function prepareProtectedReceiverEndpoints(releaseRoot) {
  const text = boundary.protectedFile(NETWORK_CONFIG);
  const config = JSON.parse(text);
  refuse(text.trim() === boundary.canonical(config));
  const configDigest = boundary.digest(boundary.canonical(config));
  const contract = boundary.loadAdmission(releaseRoot, 'bootstrap', configDigest);
  // The host authority validates the entire infra config, external boundary,
  // current boot and independent provenance. This renderer validates and uses
  // its receiver topology; matching the whole-config digest prevents splicing.
  return renderReceiverEndpoints(config, contract);
}

module.exports = { NETWORK_CONFIG, SOURCE_PATHS, REMAINING_GATES, replaceExactly,
  renderReceiverEndpoints, prepareProtectedReceiverEndpoints };
