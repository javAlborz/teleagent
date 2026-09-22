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

function fixture() {
  const range = (value) => typeof value === 'number' ? { start: value, end: value } : structuredClone(value);
  const listeners = topologyContract.LISTENER_DEFINITIONS.map((value) => ({ ...value,
    ports: range(value.ports || { start: 20000, end: 20099 }) }));
  const listenerRanges = Object.fromEntries(listeners.map((value) => [value.id, value.ports]));
  const resolveRange = (value) => typeof value === 'string' ? structuredClone(listenerRanges[value]) : range(value);
  const topology = { schema: topologyContract.TOPOLOGY_SCHEMA, topologyId: 'receiver-projection-test', policyNamespace: 'tm-policy',
    services: topologyContract.SERVICE_IDS.map((service, index) => ({ id: service, namespace: `tm-${service}`, uid: 980 + index,
      link: { serviceVeth: `tm${index}s`, policyVeth: `tm${index}p`, prefixLength: 30,
        serviceAddress: `10.254.0.${index * 4 + 2}`, policyAddress: `10.254.0.${index * 4 + 1}` } })),
    listeners, flows: topologyContract.FLOW_DEFINITIONS.map((flow) => ({ ...flow,
      sourcePorts: resolveRange(flow.sourcePorts), destinationPorts: resolveRange(flow.destinationPorts) })) };
  const imageId = `sha256:${'a'.repeat(64)}`;
  const anchor = { imageId, sourceDigest: boundary.SOURCE_DIGEST, buildEvidenceDigest: `sha256:${'b'.repeat(64)}`,
    uid: 990, gid: 990, cgroupParent: 'teleagent-media.slice' };
  const config = { schema: 'teleagent.media-docker-install.v1', anchor,
    network: { schema: 'teleagent.media-network-install.v1', topology,
      boundary: { namespace: 'tm-edge', interface: 'pbx-edge0', address: '192.0.2.2', gateway: '192.0.2.1',
        link: { serviceVeth: 'tm4s', policyVeth: 'tm4p', prefixLength: 30, serviceAddress: '10.254.0.18', policyAddress: '10.254.0.17' },
        peers: [{ address: '198.51.100.2', sipPort: 5062, rtp: { start: 40000, end: 40099 } }] } } };
  const contract = { schema: 'teleagent.media-application-contract.v1',
    releaseRoot: `/opt/teleagent/releases/sha256-${'c'.repeat(64)}`, workloads: {},
    bootstrap: { schema: 'teleagent.media-docker-launcher-contract.v1', bootId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      configurationDigest: boundary.digest(boundary.canonical(config)), services: {},
      anchorTrust: { imageId, sourceDigest: anchor.sourceDigest, buildEvidenceDigest: anchor.buildEvidenceDigest,
        executable: '/usr/local/bin/teleagent-netns-anchor', arguments: [], containerExecPermitted: false,
        healthcheck: 'NONE', additionalProcessesPermitted: false }, purpose: 'coordinated-application-bootstrap',
      applicationPlacementProven: false, livePacketProbesProven: false } };
  for (const [index, service] of topology.services.entries()) {
    const containerId = String(index + 1).repeat(64);
    contract.bootstrap.services[service.id] = { containerId, imageId, pid: 100 + index, startTicks: '77',
      namespaceDevice: 4, namespaceInode: 1000 + index, networkMode: `container:${containerId}`,
      namespace: service.namespace, applicationUid: service.uid };
    if (service.id !== 'asterisk') contract.workloads[service.id === 'voice' ? 'voice-app' : service.id] = {
      imageId: `sha256:${'d'.repeat(64)}`, uid: service.uid, gid: service.uid, sandboxDigest: `sha256:${'e'.repeat(64)}` };
  }
  return { config, contract };
}

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
