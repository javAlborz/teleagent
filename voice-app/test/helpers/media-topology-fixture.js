'use strict';
const topologyContract = require('../../../lib/sip-media-boundary-contract');
const boundary = require('../../../deploy/voice-stack/media-application-boundary');

function fixture(version = 'v1') {
  const range = (value) => typeof value === 'number' ? { start: value, end: value } : structuredClone(value);
  const definitions = version === 'v2' ? topologyContract.LISTENER_DEFINITIONS_V2 : topologyContract.LISTENER_DEFINITIONS;
  const flows = version === 'v2' ? topologyContract.FLOW_DEFINITIONS_V2 : topologyContract.FLOW_DEFINITIONS;
  const listeners = definitions.map((value) => ({ ...value,
    ports: range(value.ports || { start: 20000, end: 20099 }) }));
  const listenerRanges = Object.fromEntries(listeners.map((value) => [value.id, value.ports]));
  const resolveRange = (value) => typeof value === 'string' ? structuredClone(listenerRanges[value]) : range(value);
  const topology = { schema: version === 'v2' ? topologyContract.TOPOLOGY_SCHEMA_V2 : topologyContract.TOPOLOGY_SCHEMA,
    topologyId: 'receiver-projection-test', policyNamespace: 'tm-policy',
    services: topologyContract.SERVICE_IDS.map((service, index) => ({ id: service, namespace: `tm-${service}`, uid: 980 + index,
      link: { serviceVeth: `tm${index}s`, policyVeth: `tm${index}p`, prefixLength: 30,
        serviceAddress: `10.254.0.${index * 4 + 2}`, policyAddress: `10.254.0.${index * 4 + 1}` } })),
    listeners, flows: flows.map((flow) => ({ ...flow,
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

module.exports = { fixture };
