'use strict';

// This module is deliberately dormant validation substrate. Nothing in the
// production call path imports it and it does not create namespaces, links,
// firewall rules, Asterisk configuration, or activation evidence.

const {
  createHash,
  createPublicKey,
  verify,
} = require('node:crypto');

const TOPOLOGY_SCHEMA = 'teleagent.receiver-safe-sip-media-topology.v1';
const ASTERISK_RTP_ATTESTATION_SCHEMA = 'teleagent.asterisk-rtp-attestation.v1';
const SERVICE_IDS = Object.freeze(['asterisk', 'drachtio', 'freeswitch', 'voice']);
const LISTENER_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'asterisk-sip', service: 'asterisk', protocol: 'udp', ports: 5060 }),
  Object.freeze({ id: 'drachtio-sip', service: 'drachtio', protocol: 'udp', ports: 5070 }),
  Object.freeze({ id: 'freeswitch-sip', service: 'freeswitch', protocol: 'udp', ports: 5080 }),
  Object.freeze({ id: 'drachtio-admin', service: 'drachtio', protocol: 'tcp', ports: 9022 }),
  Object.freeze({ id: 'freeswitch-esl', service: 'freeswitch', protocol: 'tcp', ports: 8021 }),
  Object.freeze({ id: 'voice-audiofork', service: 'voice', protocol: 'tcp', ports: 3001 }),
  Object.freeze({ id: 'asterisk-rtp', service: 'asterisk', protocol: 'udp', ports: null }),
  Object.freeze({
    id: 'freeswitch-rtp',
    service: 'freeswitch',
    protocol: 'udp',
    ports: Object.freeze({ start: 30000, end: 30100 }),
  }),
]);
const FLOW_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'asterisk-to-drachtio-sip', source: 'asterisk', destination: 'drachtio',
    protocol: 'udp', sourcePorts: 'asterisk-sip', destinationPorts: 'drachtio-sip',
  }),
  Object.freeze({
    id: 'drachtio-to-asterisk-sip', source: 'drachtio', destination: 'asterisk',
    protocol: 'udp', sourcePorts: 'drachtio-sip', destinationPorts: 'asterisk-sip',
  }),
  Object.freeze({
    id: 'freeswitch-to-drachtio-sip', source: 'freeswitch', destination: 'drachtio',
    protocol: 'udp', sourcePorts: 'freeswitch-sip', destinationPorts: 'drachtio-sip',
  }),
  Object.freeze({
    id: 'drachtio-to-freeswitch-sip', source: 'drachtio', destination: 'freeswitch',
    protocol: 'udp', sourcePorts: 'drachtio-sip', destinationPorts: 'freeswitch-sip',
  }),
  Object.freeze({
    id: 'voice-to-drachtio-admin', source: 'voice', destination: 'drachtio',
    protocol: 'tcp', sourcePorts: Object.freeze({ start: 49152, end: 65535 }),
    destinationPorts: 'drachtio-admin',
  }),
  Object.freeze({
    id: 'voice-to-freeswitch-esl', source: 'voice', destination: 'freeswitch',
    protocol: 'tcp', sourcePorts: Object.freeze({ start: 49152, end: 65535 }),
    destinationPorts: 'freeswitch-esl',
  }),
  Object.freeze({
    id: 'freeswitch-to-voice-audiofork', source: 'freeswitch', destination: 'voice',
    protocol: 'tcp', sourcePorts: Object.freeze({ start: 49152, end: 65535 }),
    destinationPorts: 'voice-audiofork',
  }),
  Object.freeze({
    id: 'asterisk-to-freeswitch-rtp', source: 'asterisk', destination: 'freeswitch',
    protocol: 'udp', sourcePorts: 'asterisk-rtp', destinationPorts: 'freeswitch-rtp',
  }),
  Object.freeze({
    id: 'freeswitch-to-asterisk-rtp', source: 'freeswitch', destination: 'asterisk',
    protocol: 'udp', sourcePorts: 'freeswitch-rtp', destinationPorts: 'asterisk-rtp',
  }),
]);

const TOPOLOGY_ID_RE = /^[a-z][a-z0-9-]{7,63}$/u;
const NAMESPACE_RE = /^[a-z][a-z0-9-]{2,63}$/u;
const VETH_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/u;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;
const BOOT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/u;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/u;

function fail(message) {
  throw new Error(`Invalid SIP/media boundary contract: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function requireObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
  return value;
}

function requireExactKeys(value, keys, label) {
  requireObject(value, label);
  const ownKeys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (ownKeys.some((key) => typeof key !== 'string' ||
      !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
    fail(`${label} must contain only enumerable own data properties`);
  }
  const actual = ownKeys.sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function requireString(value, label, expression) {
  if (typeof value !== 'string' || !expression.test(value)) fail(`${label} is invalid`);
  return value;
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function validatePortRange(value, label) {
  requireExactKeys(value, ['start', 'end'], label);
  const start = requireInteger(value.start, `${label}.start`, 1, 65535);
  const end = requireInteger(value.end, `${label}.end`, 1, 65535);
  if (end < start) fail(`${label} is reversed`);
  return { start, end };
}

function singletonPort(port) {
  return { start: port, end: port };
}

function sameRange(left, right) {
  return left.start === right.start && left.end === right.end;
}

function rangesOverlap(left, right) {
  return left.start <= right.end && right.start <= left.end;
}

function inRange(port, range) {
  return port >= range.start && port <= range.end;
}

function parseIpv4(value, label) {
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)) {
    fail(`${label} must be a canonical IPv4 address`);
  }
  const octets = value.split('.').map(Number);
  if (octets.some((octet) => octet > 255) || octets.join('.') !== value) {
    fail(`${label} must be a canonical IPv4 address`);
  }
  return octets.reduce((result, octet) => (result * 256) + octet, 0);
}

function requireUnique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} must be pairwise unique`);
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('canonical JSON contains a non-integer number');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => typeof key !== 'string' ||
        !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
      fail('canonical JSON requires enumerable own data properties');
    }
    return `{${keys.sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(descriptors[key].value)}`
    )).join(',')}}`;
  }
  fail('canonical JSON contains an unsupported value');
  return '';
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function immutableCanonical(value) {
  return deepFreeze(JSON.parse(canonicalJson(value)));
}

function cloneRange(range) {
  return { start: range.start, end: range.end };
}

function expectedRange(reference, listenersById) {
  return typeof reference === 'string'
    ? cloneRange(listenersById.get(reference).ports)
    : cloneRange(reference);
}

function validateReceiverSafeSipMediaTopology(topology) {
  requireExactKeys(topology, [
    'schema', 'topologyId', 'policyNamespace', 'services', 'listeners', 'flows',
  ], 'topology');
  if (topology.schema !== TOPOLOGY_SCHEMA) fail('topology schema is unsupported');
  const topologyId = requireString(topology.topologyId, 'topology.topologyId', TOPOLOGY_ID_RE);
  const policyNamespace = requireString(
    topology.policyNamespace, 'topology.policyNamespace', NAMESPACE_RE,
  );

  if (!Array.isArray(topology.services) || topology.services.length !== SERVICE_IDS.length) {
    fail('topology.services must contain the four canonical services');
  }
  const services = topology.services.map((service, index) => {
    const expectedId = SERVICE_IDS[index];
    requireExactKeys(service, ['id', 'namespace', 'uid', 'link'], `topology.services[${index}]`);
    if (service.id !== expectedId) {
      fail(`topology.services must be in canonical order: ${SERVICE_IDS.join(', ')}`);
    }
    const namespace = requireString(
      service.namespace, `topology.services.${expectedId}.namespace`, NAMESPACE_RE,
    );
    if (namespace === policyNamespace) fail('policy and service namespaces must be distinct');
    const uid = requireInteger(service.uid, `topology.services.${expectedId}.uid`, 1, 2147483647);
    if (uid === 1000) fail('service UID 1000 is not an isolated media identity');
    requireExactKeys(service.link, [
      'serviceVeth', 'policyVeth', 'serviceAddress', 'policyAddress', 'prefixLength',
    ], `topology.services.${expectedId}.link`);
    const serviceVeth = requireString(
      service.link.serviceVeth, `topology.services.${expectedId}.link.serviceVeth`, VETH_RE,
    );
    const policyVeth = requireString(
      service.link.policyVeth, `topology.services.${expectedId}.link.policyVeth`, VETH_RE,
    );
    const serviceAddress = service.link.serviceAddress;
    const policyAddress = service.link.policyAddress;
    const serviceAddressInteger = parseIpv4(
      serviceAddress, `topology.services.${expectedId}.link.serviceAddress`,
    );
    const policyAddressInteger = parseIpv4(
      policyAddress, `topology.services.${expectedId}.link.policyAddress`,
    );
    if (service.link.prefixLength !== 30) fail('every service link must use an exact /30');
    const serviceNetwork = Math.floor(serviceAddressInteger / 4) * 4;
    const policyNetwork = Math.floor(policyAddressInteger / 4) * 4;
    if (serviceNetwork !== policyNetwork || serviceAddressInteger === serviceNetwork ||
        serviceAddressInteger === serviceNetwork + 3 || policyAddressInteger === policyNetwork ||
        policyAddressInteger === policyNetwork + 3 || serviceAddressInteger === policyAddressInteger) {
      fail(`topology.services.${expectedId}.link must use the two usable addresses of one /30`);
    }
    return {
      id: expectedId,
      namespace,
      uid,
      link: {
        serviceVeth,
        policyVeth,
        serviceAddress,
        policyAddress,
        prefixLength: 30,
      },
      serviceAddressInteger,
      policyAddressInteger,
      serviceNetwork,
    };
  });

  requireUnique(services.map((service) => service.namespace), 'service namespaces');
  requireUnique(services.map((service) => service.uid), 'service UIDs');
  requireUnique(services.flatMap((service) => [
    service.link.serviceVeth, service.link.policyVeth,
  ]), 'veth endpoint names');
  requireUnique(services.flatMap((service) => [
    service.serviceAddressInteger, service.policyAddressInteger,
  ]), 'veth endpoint addresses');
  requireUnique(services.map((service) => service.serviceNetwork), 'service /30 networks');

  if (!Array.isArray(topology.listeners) ||
      topology.listeners.length !== LISTENER_DEFINITIONS.length) {
    fail('topology.listeners must contain the canonical listener set');
  }
  const listeners = topology.listeners.map((listener, index) => {
    const definition = LISTENER_DEFINITIONS[index];
    requireExactKeys(listener, ['id', 'service', 'protocol', 'ports'],
      `topology.listeners[${index}]`);
    if (listener.id !== definition.id || listener.service !== definition.service ||
        listener.protocol !== definition.protocol) {
      fail(`topology.listeners[${index}] does not match ${definition.id}`);
    }
    const ports = validatePortRange(listener.ports, `topology.listeners.${definition.id}.ports`);
    const required = typeof definition.ports === 'number'
      ? singletonPort(definition.ports)
      : definition.ports;
    if (required && !sameRange(ports, required)) {
      fail(`topology.listeners.${definition.id}.ports is not the reviewed range`);
    }
    if (definition.id === 'asterisk-rtp' && (ports.end - ports.start + 1) > 4096) {
      fail('the Asterisk RTP range exceeds the reviewed 4096-port maximum');
    }
    return {
      id: definition.id,
      service: definition.service,
      protocol: definition.protocol,
      ports,
    };
  });
  for (let left = 0; left < listeners.length; left += 1) {
    for (let right = left + 1; right < listeners.length; right += 1) {
      if (listeners[left].protocol === listeners[right].protocol &&
          rangesOverlap(listeners[left].ports, listeners[right].ports)) {
        fail(`listener ports overlap: ${listeners[left].id} and ${listeners[right].id}`);
      }
    }
  }
  const listenersById = new Map(listeners.map((listener) => [listener.id, listener]));

  if (!Array.isArray(topology.flows) || topology.flows.length !== FLOW_DEFINITIONS.length) {
    fail('topology.flows must contain the canonical directional flow set');
  }
  const flows = topology.flows.map((flow, index) => {
    const definition = FLOW_DEFINITIONS[index];
    requireExactKeys(flow, [
      'id', 'source', 'destination', 'protocol', 'sourcePorts', 'destinationPorts',
    ], `topology.flows[${index}]`);
    if (flow.id !== definition.id || flow.source !== definition.source ||
        flow.destination !== definition.destination || flow.protocol !== definition.protocol) {
      fail(`topology.flows[${index}] does not match ${definition.id}`);
    }
    const sourcePorts = validatePortRange(
      flow.sourcePorts, `topology.flows.${definition.id}.sourcePorts`,
    );
    const destinationPorts = validatePortRange(
      flow.destinationPorts, `topology.flows.${definition.id}.destinationPorts`,
    );
    const requiredSource = expectedRange(definition.sourcePorts, listenersById);
    const requiredDestination = expectedRange(definition.destinationPorts, listenersById);
    if (!sameRange(sourcePorts, requiredSource) ||
        !sameRange(destinationPorts, requiredDestination)) {
      fail(`topology.flows.${definition.id} does not use the reviewed port tuple`);
    }
    return {
      id: definition.id,
      source: definition.source,
      destination: definition.destination,
      protocol: definition.protocol,
      sourcePorts,
      destinationPorts,
    };
  });

  const normalizedTopology = {
    schema: TOPOLOGY_SCHEMA,
    topologyId,
    policyNamespace,
    services: services.map(({ id, namespace, uid, link }) => ({ id, namespace, uid, link })),
    listeners,
    flows,
  };
  const canonical = canonicalJson(normalizedTopology);
  deepFreeze(normalizedTopology);
  return Object.freeze({
    topology: normalizedTopology,
    canonical,
    digest: sha256(canonical),
  });
}

function isSipMediaPacketAllowed(topology, packet) {
  const validated = validateReceiverSafeSipMediaTopology(topology).topology;
  try {
    requireExactKeys(packet, [
      'ingressVeth', 'sourceAddress', 'destinationAddress', 'protocol',
      'sourcePort', 'destinationPort', 'connectionState',
    ], 'packet');
    requireString(packet.ingressVeth, 'packet.ingressVeth', VETH_RE);
    parseIpv4(packet.sourceAddress, 'packet.sourceAddress');
    parseIpv4(packet.destinationAddress, 'packet.destinationAddress');
    if (packet.protocol !== 'tcp' && packet.protocol !== 'udp') fail('packet.protocol is invalid');
    if (!['stateless', 'new', 'established'].includes(packet.connectionState)) {
      fail('packet.connectionState is invalid');
    }
    if ((packet.protocol === 'udp') !== (packet.connectionState === 'stateless')) {
      fail('packet.connectionState does not match its protocol');
    }
    requireInteger(packet.sourcePort, 'packet.sourcePort', 1, 65535);
    requireInteger(packet.destinationPort, 'packet.destinationPort', 1, 65535);
  } catch {
    return false;
  }

  const source = validated.services.find((service) => (
    service.link.policyVeth === packet.ingressVeth &&
    service.link.serviceAddress === packet.sourceAddress
  ));
  const destination = validated.services.find((service) => (
    service.link.serviceAddress === packet.destinationAddress
  ));
  if (!source || !destination || source.id === destination.id) return false;
  const initiatingFlow = validated.flows.some((flow) => (
    flow.source === source.id &&
    flow.destination === destination.id &&
    flow.protocol === packet.protocol &&
    inRange(packet.sourcePort, flow.sourcePorts) &&
    inRange(packet.destinationPort, flow.destinationPorts)
  ));
  if (packet.protocol === 'udp') return initiatingFlow;
  if (packet.connectionState === 'new') return initiatingFlow;
  if (packet.connectionState !== 'established') return false;
  if (initiatingFlow) return true;
  // TCP replies are admitted only when conntrack proves that they belong to a
  // connection initiated by one reviewed directional flow. The reverse tuple
  // is not an independent listener permission and cannot open a new session.
  return validated.flows.some((flow) => (
    flow.protocol === 'tcp' &&
    flow.source === destination.id &&
    flow.destination === source.id &&
    inRange(packet.destinationPort, flow.sourcePorts) &&
    inRange(packet.sourcePort, flow.destinationPorts)
  ));
}

function requireCanonicalTimestamp(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a canonical UTC timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return milliseconds;
}

function requireCanonicalBase64Url(value, expression, bytes, label) {
  requireString(value, label, expression);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== bytes || decoded.toString('base64url') !== value) fail(`${label} is invalid`);
  return decoded;
}

function validateAttestationPayload(payload) {
  requireExactKeys(payload, [
    'schema', 'keyId', 'topologyDigest', 'bootId', 'nonce', 'observedAt',
    'expiresAt', 'observation',
  ], 'attestation payload');
  if (payload.schema !== ASTERISK_RTP_ATTESTATION_SCHEMA) {
    fail('Asterisk RTP attestation schema is unsupported');
  }
  requireString(payload.keyId, 'attestation.keyId', KEY_ID_RE);
  requireString(payload.topologyDigest, 'attestation.topologyDigest', SHA256_RE);
  requireString(payload.bootId, 'attestation.bootId', BOOT_ID_RE);
  requireCanonicalBase64Url(payload.nonce, NONCE_RE, 32, 'attestation.nonce');
  requireCanonicalTimestamp(payload.observedAt, 'attestation.observedAt');
  requireCanonicalTimestamp(payload.expiresAt, 'attestation.expiresAt');
  requireExactKeys(payload.observation, [
    'topologyId', 'namespace', 'uid', 'serviceVeth', 'policyVeth',
    'serviceAddress', 'configurationDigest', 'effectiveRtp',
  ], 'attestation.observation');
  requireString(payload.observation.topologyId, 'attestation.observation.topologyId', TOPOLOGY_ID_RE);
  requireString(payload.observation.namespace, 'attestation.observation.namespace', NAMESPACE_RE);
  requireInteger(payload.observation.uid, 'attestation.observation.uid', 1, 2147483647);
  requireString(payload.observation.serviceVeth, 'attestation.observation.serviceVeth', VETH_RE);
  requireString(payload.observation.policyVeth, 'attestation.observation.policyVeth', VETH_RE);
  parseIpv4(payload.observation.serviceAddress, 'attestation.observation.serviceAddress');
  requireString(
    payload.observation.configurationDigest,
    'attestation.observation.configurationDigest',
    SHA256_RE,
  );
  validatePortRange(payload.observation.effectiveRtp, 'attestation.observation.effectiveRtp');
  return immutableCanonical(payload);
}

function createAsteriskRtpAttestationSigningInput(payload) {
  const normalized = validateAttestationPayload(payload);
  return Buffer.from(canonicalJson(normalized), 'utf8');
}

function readPositiveDuration(value, fallback, label) {
  const duration = value === undefined ? fallback : value;
  return requireInteger(duration, label, 0, 300000);
}

function trustedPublicKey(trustedKeys, keyId) {
  let candidate;
  if (trustedKeys instanceof Map) {
    candidate = trustedKeys.get(keyId);
  } else if (isPlainObject(trustedKeys) && Object.hasOwn(trustedKeys, keyId)) {
    candidate = trustedKeys[keyId];
  }
  if (!candidate) fail('attestation key ID is not trusted');
  let key;
  try {
    key = candidate.type === 'public' ? candidate : createPublicKey(candidate);
  } catch {
    fail('attestation public key is invalid');
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    fail('attestation key must be an Ed25519 public key');
  }
  return key;
}

function validateAsteriskRtpAttestation(attestation, topology, options = {}) {
  requireExactKeys(attestation, [
    'schema', 'keyId', 'topologyDigest', 'bootId', 'nonce', 'observedAt',
    'expiresAt', 'observation', 'signature',
  ], 'attestation');
  const payload = validateAttestationPayload({
    schema: attestation.schema,
    keyId: attestation.keyId,
    topologyDigest: attestation.topologyDigest,
    bootId: attestation.bootId,
    nonce: attestation.nonce,
    observedAt: attestation.observedAt,
    expiresAt: attestation.expiresAt,
    observation: attestation.observation,
  });
  const signingInput = Buffer.from(canonicalJson(payload), 'utf8');
  const signature = requireCanonicalBase64Url(
    attestation.signature, SIGNATURE_RE, 64, 'attestation.signature',
  );
  const key = trustedPublicKey(options.trustedKeys, payload.keyId);
  if (!verify(null, signingInput, key, signature)) fail('attestation signature is invalid');
  const validatedTopology = validateReceiverSafeSipMediaTopology(topology);
  const expectedTopologyDigest = requireString(
    options.expectedTopologyDigest,
    'options.expectedTopologyDigest',
    SHA256_RE,
  );
  if (validatedTopology.digest !== expectedTopologyDigest) {
    fail('installed topology digest differs from the host-owned expected topology digest');
  }
  if (payload.topologyDigest !== validatedTopology.digest) fail('attestation topology digest differs');
  const expectedBootId = requireString(
    options.expectedBootId, 'options.expectedBootId', BOOT_ID_RE,
  );
  if (payload.bootId !== expectedBootId) fail('attestation boot ID differs');
  const expectedConfigurationDigest = requireString(
    options.expectedConfigurationDigest,
    'options.expectedConfigurationDigest',
    SHA256_RE,
  );

  const asterisk = validatedTopology.topology.services.find((service) => service.id === 'asterisk');
  const asteriskRtp = validatedTopology.topology.listeners.find(
    (listener) => listener.id === 'asterisk-rtp',
  ).ports;
  const observation = payload.observation;
  if (observation.topologyId !== validatedTopology.topology.topologyId ||
      observation.namespace !== asterisk.namespace || observation.uid !== asterisk.uid ||
      observation.serviceVeth !== asterisk.link.serviceVeth ||
      observation.policyVeth !== asterisk.link.policyVeth ||
      observation.serviceAddress !== asterisk.link.serviceAddress ||
      observation.configurationDigest !== expectedConfigurationDigest ||
      !sameRange(observation.effectiveRtp, asteriskRtp)) {
    fail('Asterisk observation is not bound to the exact topology identity, configuration, and RTP range');
  }

  const now = options.now === undefined
    ? Date.now()
    : (options.now instanceof Date ? options.now.getTime() : options.now);
  if (!Number.isSafeInteger(now) || now < 0) fail('options.now is invalid');
  const maxAgeMs = readPositiveDuration(options.maxAgeMs, 30000, 'options.maxAgeMs');
  const maxLifetimeMs = readPositiveDuration(
    options.maxLifetimeMs, 60000, 'options.maxLifetimeMs',
  );
  const allowedFutureSkewMs = readPositiveDuration(
    options.allowedFutureSkewMs, 2000, 'options.allowedFutureSkewMs',
  );
  const observedAt = requireCanonicalTimestamp(payload.observedAt, 'attestation.observedAt');
  const expiresAt = requireCanonicalTimestamp(payload.expiresAt, 'attestation.expiresAt');
  if (observedAt > now + allowedFutureSkewMs) fail('attestation observation is from the future');
  if (now - observedAt > maxAgeMs) fail('attestation observation is stale');
  if (expiresAt <= now) fail('attestation has expired');
  if (expiresAt <= observedAt || expiresAt - observedAt > maxLifetimeMs) {
    fail('attestation lifetime is invalid');
  }

  if (typeof options.consumeReplay !== 'function') {
    fail('an atomic replay consumer is required');
  }
  // A nonce is single-use for the key epoch and boot, even if a compromised
  // producer tries to reuse it in a differently signed payload.
  const replayKey = sha256(Buffer.from([
    ASTERISK_RTP_ATTESTATION_SCHEMA,
    payload.keyId,
    payload.bootId,
    payload.nonce,
  ].join('\0'), 'utf8'));
  const payloadDigest = sha256(signingInput);
  const consumed = options.consumeReplay(Object.freeze({
    keyId: payload.keyId,
    bootId: payload.bootId,
    nonce: payload.nonce,
    replayKey,
    payloadDigest,
    expiresAt: payload.expiresAt,
  }));
  if (consumed && typeof consumed.then === 'function') {
    fail('the replay consumer must be synchronous');
  }
  if (consumed !== true) fail('attestation nonce was already consumed');

  return Object.freeze({
    ok: true,
    topologyDigest: validatedTopology.digest,
    keyId: payload.keyId,
    bootId: payload.bootId,
    nonce: payload.nonce,
    observedAt: payload.observedAt,
    expiresAt: payload.expiresAt,
    configurationDigest: observation.configurationDigest,
    replayKey,
    payloadDigest,
  });
}

module.exports = {
  ASTERISK_RTP_ATTESTATION_SCHEMA,
  FLOW_DEFINITIONS,
  LISTENER_DEFINITIONS,
  SERVICE_IDS,
  TOPOLOGY_SCHEMA,
  createAsteriskRtpAttestationSigningInput,
  isSipMediaPacketAllowed,
  validateAsteriskRtpAttestation,
  validateReceiverSafeSipMediaTopology,
};
