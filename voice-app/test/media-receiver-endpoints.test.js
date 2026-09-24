'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const topologyContract = require('../../lib/sip-media-boundary-contract');
const boundary = require('../../deploy/voice-stack/media-application-boundary');
const renderer = require('../../deploy/voice-stack/media-receiver-endpoints');
const { VOICE_APP_FIXED_ENV, assertVoiceAppRuntimeEnvironment } = require('../../lib/voice-app-runtime-env');

const { fixture } = require('./helpers/media-topology-fixture');

test('deterministic projection binds every receiver address and preserves credential slots', () => {
  const { config, contract } = fixture();
  const before = JSON.stringify({ config, contract });
  const output = renderer.renderReceiverEndpoints(config, contract);
  assert.deepEqual(output, renderer.renderReceiverEndpoints(config, contract));
  assert.equal(JSON.stringify({ config, contract }), before);
  assert.equal(output.topologyDigest, topologyContract.validateReceiverSafeSipMediaTopology(config.network.topology).digest);
  assert.equal(output.configurationDigest, contract.bootstrap.configurationDigest);
  assert.ok(Object.isFrozen(output.files));
  const { projectionDigest, ...unsigned } = output;
  assert.equal(projectionDigest, boundary.digest(boundary.canonical(unsigned)));
  assert.deepEqual(output.voiceEnvironment, {
    DRACHTIO_HOST: '10.254.0.6', DRACHTIO_PORT: '9022', FREESWITCH_HOST: '10.254.0.10', FREESWITCH_PORT: '8021',
    SIP_TRUNK_HOST: '10.254.0.2', SIP_TRUNK_PORT: '5060', SIP_TRUNK_TRANSPORT: 'udp',
    WS_HOST: '10.254.0.14', WS_CONNECT_HOST: '10.254.0.14', WS_PORT: '3001', WS_NON_LOOPBACK_ENABLED: 'true',
    WS_ALLOWED_PEERS: '10.254.0.10',
  });
  assert.deepEqual(output.audioForkOptions, { host: '10.254.0.14', connectHost: '10.254.0.14', port: 3001,
    allowNonLoopback: true, allowedPeers: ['10.254.0.10'] });
  assert.deepEqual(output.freeswitchControlTarget, { address: '10.254.0.10', port: 8021, profile: 'drachtio_mrf' });
  assert.deepEqual(Object.values(output.files).join('').match(/__[A-Z_]+__/gu).sort(),
    ['__DRACHTIO_SECRET__', '__FREESWITCH_SECRET__']);
  assert.doesNotMatch(Object.values(output.files).join(''), /127\.0\.0\.1|localhost|0\.0\.0\.0|rfc1918\.auto/u);
});

test('generated XML parses and pins SIP, ESL ACLs, RTP and bounded core settings', () => {
  const { config, contract } = fixture();
  const output = renderer.renderReceiverEndpoints(config, contract);
  const script = `import json,sys,xml.etree.ElementTree as E
files=json.load(sys.stdin)
docs={name:E.fromstring(text) for name,text in files.items()}
d=docs['drachtio.conf.xml.template']
a=d.find('admin');assert a.text=='10.254.0.6' and a.attrib==dict(port='9022',secret='__DRACHTIO_SECRET__')
c=d.find('sip/contacts/contact');assert c.text=='sip:10.254.0.6:5070;transport=udp' and c.attrib=={'external-ip':'10.254.0.6'}
def settings(name):
 p=docs[name].findall('.//settings/param');v={x.attrib['name']:x.attrib['value'] for x in p};assert len(v)==len(p);return v
e=settings('freeswitch-event-socket.conf.xml.template')
assert e=={'listen-ip':'10.254.0.10','listen-port':'8021','password':'__FREESWITCH_SECRET__','apply-inbound-acl':'teleagent-voice-esl','nat-map':'false','stop-on-bind-error':'true'}
p=settings('freeswitch-mrf.xml')
assert all(p[k]=='10.254.0.10' for k in ('rtp-ip','sip-ip','ext-rtp-ip','ext-sip-ip'))
assert p['sip-port']=='5080' and p['bind-params']=='transport=udp' and p['apply-inbound-acl']=='teleagent-drachtio-sip'
assert p['tls']=='false' and p['tls-only']=='false' and 'apply-nat-acl' not in p
core=settings('freeswitch-switch.conf.xml')
assert core['rtp-start-port']=='30000' and core['rtp-end-port']=='30100' and core['max-sessions']=='32'
acl=docs['freeswitch-acl.conf.xml'];lists=acl.findall('network-lists/list');assert len(lists)==2
for row in lists:
 assert row.attrib['default']=='deny' and len(list(row))==1
 target={'teleagent-voice-esl':'10.254.0.14/32','teleagent-drachtio-sip':'10.254.0.6/32'}[row.attrib['name']]
 assert row[0].attrib==dict(type='allow',cidr=target)
`;
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', script], {
    input: JSON.stringify(output.files), encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('each rendered client or advertised receiver follows the reviewed directional topology', () => {
  const { config, contract } = fixture();
  const output = renderer.renderReceiverEndpoints(config, contract);
  const topology = config.network.topology;
  const services = Object.fromEntries(topology.services.map((service) => [service.id, service]));
  for (const flow of topology.flows) {
    const source = services[flow.source];
    const destination = services[flow.destination];
    assert.ok(Object.values(output.endpoints).some((endpoint) => endpoint.service === flow.destination &&
      endpoint.address === destination.link.serviceAddress && endpoint.protocol === flow.protocol &&
      endpoint.ports.start === flow.destinationPorts.start && endpoint.ports.end === flow.destinationPorts.end));
    const packet = { ingressVeth: source.link.policyVeth, sourceAddress: source.link.serviceAddress,
      destinationAddress: destination.link.serviceAddress, protocol: flow.protocol, sourcePort: flow.sourcePorts.start,
      destinationPort: flow.destinationPorts.start, connectionState: flow.protocol === 'tcp' ? 'new' : 'stateless' };
    assert.equal(topologyContract.isSipMediaPacketAllowed(topology, packet), true);
    assert.equal(topologyContract.isSipMediaPacketAllowed(topology, { ...packet, destinationAddress: source.link.serviceAddress }), false);
  }
  // Port80/HTTP3000 and reverse ESL3002 must not be implied by this v1 render.
  for (const port of [80, 3000, 3002]) assert.equal(topologyContract.isSipMediaPacketAllowed(topology, {
    ingressVeth: services.freeswitch.link.policyVeth, sourceAddress: services.freeswitch.link.serviceAddress,
    destinationAddress: services.voice.link.serviceAddress, protocol: 'tcp', sourcePort: 49152,
    destinationPort: port, connectionState: 'new',
  }), false);
});

test('missing, reordered, inconsistent, broad or cross-generation receiver inputs refuse', () => {
  for (const change of [
    (x) => { delete x.config.network.topology.listeners; },
    (x) => { x.config.network.topology.flows.pop(); },
    (x) => { x.config.network.topology.services.reverse(); },
    (x) => { x.config.network.topology.services[1].link.serviceAddress = 'voice.local'; },
    (x) => { x.config.network.topology.services[1].link.serviceAddress = '10.254.0.10'; },
    (x) => { x.config.network.topology.listeners[5].ports.end = 3002; },
    (x) => { x.config.network.topology.flows[4].sourcePorts.start = 1; },
    (x) => { x.contract.bootstrap.services.voice.namespace = 'tm-elsewhere'; },
    (x) => { x.contract.bootstrap.services.voice.applicationUid = 950; },
    (x) => { x.contract.bootstrap.configurationDigest = `sha256:${'0'.repeat(64)}`; },
    (x) => { x.config.anchor.sourceDigest = `sha256:${'0'.repeat(64)}`; },
    (x) => { x.config.network.topology.extra = true; },
  ]) {
    const value = fixture(); change(value);
    assert.throws(() => renderer.renderReceiverEndpoints(value.config, value.contract));
  }
  for (const prefix of ['127.0.0', '169.254.0', '224.0.0', '192.0.2']) {
    const value = fixture();
    value.config.network.topology.services[0].link.serviceAddress = `${prefix}.2`;
    value.config.network.topology.services[0].link.policyAddress = `${prefix}.1`;
    value.contract.bootstrap.configurationDigest = boundary.digest(boundary.canonical(value.config));
    assert.throws(() => renderer.renderReceiverEndpoints(value.config, value.contract));
  }
});

test('reviewed alternate private links propagate without hardcoded fixture addresses', () => {
  const { config, contract } = fixture();
  for (const service of config.network.topology.services) {
    service.link.serviceAddress = service.link.serviceAddress.replace('10.254.0.', '172.20.7.');
    service.link.policyAddress = service.link.policyAddress.replace('10.254.0.', '172.20.7.');
  }
  assert.throws(() => renderer.renderReceiverEndpoints(config, contract));
  contract.bootstrap.configurationDigest = boundary.digest(boundary.canonical(config));
  const output = renderer.renderReceiverEndpoints(config, contract);
  assert.equal(output.voiceEnvironment.WS_HOST, '172.20.7.14');
  assert.equal(output.voiceEnvironment.FREESWITCH_HOST, '172.20.7.10');
  assert.doesNotMatch(Object.values(output.files).join(''), /10\.254\.0\./u);
});

test('unreviewed template drift and incomplete runtime remain fail closed', () => {
  assert.throws(() => renderer.replaceExactly('missing', 'expected', 'replacement'));
  assert.throws(() => renderer.replaceExactly('expected expected', 'expected', 'replacement'));
  const { config, contract } = fixture();
  const output = renderer.renderReceiverEndpoints(config, contract);
  assert.equal(output.readyToLaunch, false);
  assert.equal(output.reverseEsl, null);
  assert.equal(output.privateHttpAudio, null);
  assert.ok(output.remainingGates.includes('voice-reverse-esl-listener-and-flow'));
  assert.ok(output.remainingGates.includes('freeswitch-private-http-audio-listener-and-flow'));
  assert.throws(() => assertVoiceAppRuntimeEnvironment({ ...VOICE_APP_FIXED_ENV, ...output.voiceEnvironment }));
  assert.throws(() => boundary.requireRuntimeIntegration(), { code: 'MEDIA_RUNTIME_UNCOMMISSIONED' });
  const source = fs.readFileSync(path.join(__dirname, '../../deploy/voice-stack/teleagent-voice-stack-launch.js'), 'utf8');
  assert.match(source, /async function start\(\) \{\s*\/\/[\s\S]*?requireRuntimeIntegration\(\);/u);
});

test('protected entrypoint binds the fixed configuration to independent bootstrap admission', () => {
  const { config, contract } = fixture();
  const originalRead = boundary.protectedFile;
  const originalAdmission = boundary.loadAdmission;
  let text = boundary.canonical(config), admitted = false;
  boundary.protectedFile = (filename) => {
    assert.equal(filename, '/etc/teleagent-media/docker-network.json'); return text;
  };
  boundary.loadAdmission = (release, stage, digest) => {
    admitted = true;
    assert.equal(release, contract.releaseRoot);
    assert.equal(stage, 'bootstrap');
    assert.equal(digest, contract.bootstrap.configurationDigest);
    return contract;
  };
  try {
    assert.equal(renderer.prepareProtectedReceiverEndpoints(contract.releaseRoot).readyToLaunch, false);
    assert.equal(admitted, true);
    text = text.replace('"schema":"teleagent.media-docker-install.v1"',
      '"schema":"discarded","schema":"teleagent.media-docker-install.v1"');
    admitted = false;
    assert.throws(() => renderer.prepareProtectedReceiverEndpoints(contract.releaseRoot));
    assert.equal(admitted, false);
    boundary.protectedFile = () => { throw new Error('host configuration absent'); };
    assert.throws(() => renderer.prepareProtectedReceiverEndpoints(contract.releaseRoot));
    assert.equal(admitted, false);
  } finally {
    boundary.protectedFile = originalRead;
    boundary.loadAdmission = originalAdmission;
  }
});

test('v2 adds only fixed reverse ESL and separate media HTTP with explicit consumer gates', () => {
  const { config, contract } = fixture('v2');
  const output = renderer.renderReceiverEndpoints(config, contract);
  assert.equal(config.network.topology.listeners.length, 10);
  assert.equal(config.network.topology.flows.length, 11);
  assert.deepEqual(output.reverseEsl, { listenAddress: '10.254.0.14', listenPort: 3002,
    advertisedAddress: '10.254.0.14', advertisedPort: 3002, allowedPeer: '10.254.0.10' });
  assert.deepEqual(output.privateHttpAudio, { host: '10.254.0.14', port: 3000, baseUrl: 'http://10.254.0.14:3000',
    allowedPeer: '10.254.0.10', methods: ['GET', 'HEAD'], routes: ['/audio-files/:filename', '/static/*'],
    controlRoutesPermitted: false, listenWildcardPermitted: false });
  assert.deepEqual(output.controlHttp, { host: '127.0.0.1', port: 3000 });
  assert.equal(output.readyToLaunch, false);
  assert.ok(output.remainingGates.includes('fixed-reverse-esl-consumer-and-peer-restriction'));
  assert.ok(output.remainingGates.includes('dedicated-private-http-consumer-and-playback-urls'));
  assert.throws(() => boundary.requireRuntimeIntegration());
});

test('single-owner Tailnet v3 source-port policy preserves the exact receiver projection', () => {
  const { config, contract } = fixture('v2');
  const baseline = renderer.renderReceiverEndpoints(config, contract);
  config.network.schema = 'teleagent.media-network-install.v3';
  config.network.boundary.peers = [{ address: '100.101.120.26', sourcePorts: { start: 1024, end: 65535 } }];
  contract.bootstrap.configurationDigest = boundary.digest(boundary.canonical(config));
  const v3 = renderer.renderReceiverEndpoints(config, contract);
  assert.deepEqual(v3.endpoints, baseline.endpoints);
  assert.deepEqual(v3.voiceEnvironment, baseline.voiceEnvironment);
  assert.equal(v3.readyToLaunch, false);
  config.network.schema = 'teleagent.media-network-install.v4';
  contract.bootstrap.configurationDigest = boundary.digest(boundary.canonical(config));
  assert.throws(() => renderer.renderReceiverEndpoints(config, contract));
});

test('v1 never acquires v2 permissions and v2 forbids omissions, dynamic ports or broad tuples', () => {
  const value = fixture('v2');
  const topology = value.config.network.topology;
  const validate = topologyContract.validateReceiverSafeSipMediaTopology;
  validate(topology);
  for (const change of [
    (x) => { x.schema = topologyContract.TOPOLOGY_SCHEMA; },
    (x) => { x.listeners.pop(); },
    (x) => { x.flows.pop(); },
    (x) => { x.listeners[9].ports = { start: 0, end: 0 }; },
    (x) => { x.listeners[9].ports = { start: 3002, end: 65535 }; },
    (x) => { x.flows[9].source = 'drachtio'; },
    (x) => { x.flows[10].sourcePorts.start = 1024; },
    (x) => { x.flows[10].destinationPorts.end = 3003; },
  ]) {
    const copy = structuredClone(topology); change(copy);
    assert.throws(() => validate(copy));
  }
  const v1 = fixture().config.network.topology;
  v1.schema = topologyContract.TOPOLOGY_SCHEMA_V2;
  assert.throws(() => validate(v1));
});

test('v2 receiver directions reject spoofing, wrong peers, ports, and unsolicited reverse connections', () => {
  const v2 = fixture('v2').config.network.topology;
  const v1 = fixture().config.network.topology;
  const allowed = topologyContract.isSipMediaPacketAllowed;
  for (const port of [3000, 3002]) {
    const original = { ingressVeth: 'tm2p', sourceAddress: '10.254.0.10', destinationAddress: '10.254.0.14',
      protocol: 'tcp', sourcePort: 49152, destinationPort: port, connectionState: 'new' };
    assert.equal(allowed(v2, original), true);
    assert.equal(allowed(v1, original), false);
    for (const change of [{ ingressVeth: 'tm1p' }, { sourceAddress: '10.254.0.6' }, { destinationAddress: '10.254.0.10' },
      { sourcePort: 49151 }, { destinationPort: 3003 }, { protocol: 'udp', connectionState: 'stateless' }]) {
      assert.equal(allowed(v2, { ...original, ...change }), false);
    }
    const reply = { ingressVeth: 'tm3p', sourceAddress: '10.254.0.14', destinationAddress: '10.254.0.10',
      protocol: 'tcp', sourcePort: port, destinationPort: 49152, connectionState: 'established' };
    assert.equal(allowed(v2, reply), true);
    assert.equal(allowed(v2, { ...reply, connectionState: 'new' }), false);
  }
});
