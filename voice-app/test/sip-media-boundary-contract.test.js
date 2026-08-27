'use strict';

const assert = require('node:assert/strict');
const {
  generateKeyPairSync,
  sign,
} = require('node:crypto');
const test = require('node:test');
const {
  ASTERISK_RTP_ATTESTATION_SCHEMA,
  TOPOLOGY_SCHEMA,
  createAsteriskRtpAttestationSigningInput,
  isSipMediaPacketAllowed,
  validateAsteriskRtpAttestation,
  validateReceiverSafeSipMediaTopology,
} = require('../../lib/sip-media-boundary-contract');

const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const BOOT_ID = '123e4567-e89b-42d3-a456-426614174000';
const KEY_ID = 'pbx-attester-2026-08';
const CONFIGURATION_DIGEST = `sha256:${'a'.repeat(64)}`;
const NONCE = Buffer.alloc(32, 0x5a).toString('base64url');

function range(start, end = start) {
  return { start, end };
}

function topologyFixture() {
  return {
    schema: TOPOLOGY_SCHEMA,
    topologyId: 'hermes-sip-media-v1',
    policyNamespace: 'ta-sip-policy',
    services: [
      {
        id: 'asterisk',
        namespace: 'ta-asterisk',
        uid: 991,
        link: {
          serviceVeth: 'ast-sip0', policyVeth: 'ast-pol0',
          serviceAddress: '10.254.0.2', policyAddress: '10.254.0.1', prefixLength: 30,
        },
      },
      {
        id: 'drachtio',
        namespace: 'ta-drachtio',
        uid: 992,
        link: {
          serviceVeth: 'dra-sip0', policyVeth: 'dra-pol0',
          serviceAddress: '10.254.0.6', policyAddress: '10.254.0.5', prefixLength: 30,
        },
      },
      {
        id: 'freeswitch',
        namespace: 'ta-freeswitch',
        uid: 993,
        link: {
          serviceVeth: 'fs-sip0', policyVeth: 'fs-pol0',
          serviceAddress: '10.254.0.10', policyAddress: '10.254.0.9', prefixLength: 30,
        },
      },
      {
        id: 'voice',
        namespace: 'ta-voice',
        uid: 994,
        link: {
          serviceVeth: 'voi-sip0', policyVeth: 'voi-pol0',
          serviceAddress: '10.254.0.14', policyAddress: '10.254.0.13', prefixLength: 30,
        },
      },
    ],
    listeners: [
      { id: 'asterisk-sip', service: 'asterisk', protocol: 'udp', ports: range(5060) },
      { id: 'drachtio-sip', service: 'drachtio', protocol: 'udp', ports: range(5070) },
      { id: 'freeswitch-sip', service: 'freeswitch', protocol: 'udp', ports: range(5080) },
      { id: 'drachtio-admin', service: 'drachtio', protocol: 'tcp', ports: range(9022) },
      { id: 'freeswitch-esl', service: 'freeswitch', protocol: 'tcp', ports: range(8021) },
      { id: 'voice-audiofork', service: 'voice', protocol: 'tcp', ports: range(3001) },
      { id: 'asterisk-rtp', service: 'asterisk', protocol: 'udp', ports: range(20000, 20099) },
      { id: 'freeswitch-rtp', service: 'freeswitch', protocol: 'udp', ports: range(30000, 30100) },
    ],
    flows: [
      {
        id: 'asterisk-to-drachtio-sip', source: 'asterisk', destination: 'drachtio',
        protocol: 'udp', sourcePorts: range(5060), destinationPorts: range(5070),
      },
      {
        id: 'drachtio-to-asterisk-sip', source: 'drachtio', destination: 'asterisk',
        protocol: 'udp', sourcePorts: range(5070), destinationPorts: range(5060),
      },
      {
        id: 'freeswitch-to-drachtio-sip', source: 'freeswitch', destination: 'drachtio',
        protocol: 'udp', sourcePorts: range(5080), destinationPorts: range(5070),
      },
      {
        id: 'drachtio-to-freeswitch-sip', source: 'drachtio', destination: 'freeswitch',
        protocol: 'udp', sourcePorts: range(5070), destinationPorts: range(5080),
      },
      {
        id: 'voice-to-drachtio-admin', source: 'voice', destination: 'drachtio',
        protocol: 'tcp', sourcePorts: range(49152, 65535), destinationPorts: range(9022),
      },
      {
        id: 'voice-to-freeswitch-esl', source: 'voice', destination: 'freeswitch',
        protocol: 'tcp', sourcePorts: range(49152, 65535), destinationPorts: range(8021),
      },
      {
        id: 'freeswitch-to-voice-audiofork', source: 'freeswitch', destination: 'voice',
        protocol: 'tcp', sourcePorts: range(49152, 65535), destinationPorts: range(3001),
      },
      {
        id: 'asterisk-to-freeswitch-rtp', source: 'asterisk', destination: 'freeswitch',
        protocol: 'udp', sourcePorts: range(20000, 20099),
        destinationPorts: range(30000, 30100),
      },
      {
        id: 'freeswitch-to-asterisk-rtp', source: 'freeswitch', destination: 'asterisk',
        protocol: 'udp', sourcePorts: range(30000, 30100),
        destinationPorts: range(20000, 20099),
      },
    ],
  };
}

function clone(value) {
  return structuredClone(value);
}

function makeAttestation(topology, privateKey, changes = {}) {
  const validated = validateReceiverSafeSipMediaTopology(topology);
  const asterisk = validated.topology.services[0];
  const { observation: observationChanges = {}, ...payloadChanges } = changes;
  const observation = {
    topologyId: validated.topology.topologyId,
    namespace: asterisk.namespace,
    uid: asterisk.uid,
    serviceVeth: asterisk.link.serviceVeth,
    policyVeth: asterisk.link.policyVeth,
    serviceAddress: asterisk.link.serviceAddress,
    configurationDigest: CONFIGURATION_DIGEST,
    effectiveRtp: range(20000, 20099),
    ...observationChanges,
  };
  const payload = {
    schema: ASTERISK_RTP_ATTESTATION_SCHEMA,
    keyId: KEY_ID,
    topologyDigest: validated.digest,
    bootId: BOOT_ID,
    nonce: NONCE,
    observedAt: new Date(NOW - 1000).toISOString(),
    expiresAt: new Date(NOW + 20000).toISOString(),
    ...payloadChanges,
    observation,
  };
  return {
    ...payload,
    signature: sign(
      null,
      createAsteriskRtpAttestationSigningInput(payload),
      privateKey,
    ).toString('base64url'),
  };
}

function validationOptions(publicKey, overrides = {}) {
  const consumed = new Set();
  return {
    trustedKeys: new Map([[KEY_ID, publicKey]]),
    expectedBootId: BOOT_ID,
    expectedTopologyDigest: validateReceiverSafeSipMediaTopology(topologyFixture()).digest,
    expectedConfigurationDigest: CONFIGURATION_DIGEST,
    now: NOW,
    maxAgeMs: 30000,
    maxLifetimeMs: 60000,
    allowedFutureSkewMs: 2000,
    consumeReplay(record) {
      if (consumed.has(record.replayKey)) return false;
      consumed.add(record.replayKey);
      return true;
    },
    ...overrides,
  };
}

test('canonical topology binds four isolated identities and exact directional flows', () => {
  const topology = topologyFixture();
  const validated = validateReceiverSafeSipMediaTopology(topology);
  assert.match(validated.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(validated.topology.services.length, 4);
  assert.equal(validated.topology.listeners.length, 8);
  assert.equal(validated.topology.flows.length, 9);
  assert.equal(validateReceiverSafeSipMediaTopology(clone(topology)).digest, validated.digest);

  const addresses = Object.fromEntries(
    topology.services.map((service) => [service.id, service.link.serviceAddress]),
  );
  const ingress = Object.fromEntries(
    topology.services.map((service) => [service.id, service.link.policyVeth]),
  );
  const packets = [
    ['asterisk', 'drachtio', 'udp', 5060, 5070, 'stateless'],
    ['drachtio', 'asterisk', 'udp', 5070, 5060, 'stateless'],
    ['freeswitch', 'drachtio', 'udp', 5080, 5070, 'stateless'],
    ['drachtio', 'freeswitch', 'udp', 5070, 5080, 'stateless'],
    ['voice', 'drachtio', 'tcp', 50000, 9022, 'new'],
    ['voice', 'freeswitch', 'tcp', 50001, 8021, 'new'],
    ['freeswitch', 'voice', 'tcp', 50002, 3001, 'new'],
    ['asterisk', 'freeswitch', 'udp', 20050, 30050, 'stateless'],
    ['freeswitch', 'asterisk', 'udp', 30050, 20050, 'stateless'],
  ];
  for (const [source, destination, protocol, sourcePort, destinationPort,
    connectionState] of packets) {
    assert.equal(isSipMediaPacketAllowed(topology, {
      ingressVeth: ingress[source],
      sourceAddress: addresses[source],
      destinationAddress: addresses[destination],
      protocol,
      sourcePort,
      destinationPort,
      connectionState,
    }), true, `${source} -> ${destination}`);
  }
});

test('topology rejects duplicate namespaces, UIDs, veth endpoints, addresses, and /30s', () => {
  const cases = [
    ['namespace', (value) => { value.services[1].namespace = value.services[0].namespace; }, /service namespaces/u],
    ['UID', (value) => { value.services[1].uid = value.services[0].uid; }, /service UIDs/u],
    ['UID 1000', (value) => { value.services[1].uid = 1000; }, /UID 1000/u],
    ['veth', (value) => {
      value.services[1].link.policyVeth = value.services[0].link.serviceVeth;
    }, /veth endpoint names/u],
    ['address and network', (value) => {
      value.services[1].link.serviceAddress = value.services[0].link.serviceAddress;
      value.services[1].link.policyAddress = value.services[0].link.policyAddress;
    }, /(endpoint addresses|\/30 networks)/u],
  ];
  for (const [name, mutate, message] of cases) {
    const topology = topologyFixture();
    mutate(topology);
    assert.throws(() => validateReceiverSafeSipMediaTopology(topology), message, name);
  }
});

test('topology rejects noncanonical service order, fields, addresses, and veth names', () => {
  const extra = topologyFixture();
  extra.activation = true;
  assert.throws(() => validateReceiverSafeSipMediaTopology(extra), /must contain exactly/u);

  const reordered = topologyFixture();
  [reordered.services[0], reordered.services[1]] = [reordered.services[1], reordered.services[0]];
  assert.throws(() => validateReceiverSafeSipMediaTopology(reordered), /canonical order/u);

  const address = topologyFixture();
  address.services[0].link.serviceAddress = '10.254.0.02';
  assert.throws(() => validateReceiverSafeSipMediaTopology(address), /canonical IPv4/u);

  const veth = topologyFixture();
  veth.services[0].link.serviceVeth = 'sixteen-char-veth';
  assert.throws(() => validateReceiverSafeSipMediaTopology(veth), /serviceVeth is invalid/u);
});

test('listener port assignments and Asterisk/FreeSWITCH RTP ranges cannot overlap', () => {
  const overlapsFreeswitch = topologyFixture();
  overlapsFreeswitch.listeners[6].ports = range(30050, 30150);
  overlapsFreeswitch.flows[7].sourcePorts = range(30050, 30150);
  overlapsFreeswitch.flows[8].destinationPorts = range(30050, 30150);
  assert.throws(
    () => validateReceiverSafeSipMediaTopology(overlapsFreeswitch),
    /listener ports overlap: asterisk-rtp and freeswitch-rtp/u,
  );

  const overlapsSip = topologyFixture();
  overlapsSip.listeners[6].ports = range(5050, 5065);
  overlapsSip.flows[7].sourcePorts = range(5050, 5065);
  overlapsSip.flows[8].destinationPorts = range(5050, 5065);
  assert.throws(
    () => validateReceiverSafeSipMediaTopology(overlapsSip),
    /listener ports overlap: asterisk-sip and asterisk-rtp/u,
  );

  const changedFixedPort = topologyFixture();
  changedFixedPort.listeners[1].ports = range(5090);
  assert.throws(
    () => validateReceiverSafeSipMediaTopology(changedFixedPort),
    /not the reviewed range/u,
  );
});

test('receiver policy denies source-veth, address, port, and direction spoofing', () => {
  const topology = topologyFixture();
  const allowedAdmin = {
    ingressVeth: 'voi-pol0',
    sourceAddress: '10.254.0.14',
    destinationAddress: '10.254.0.6',
    protocol: 'tcp',
    sourcePort: 50000,
    destinationPort: 9022,
    connectionState: 'new',
  };
  assert.equal(isSipMediaPacketAllowed(topology, allowedAdmin), true);
  assert.equal(isSipMediaPacketAllowed(topology, {
    ...allowedAdmin, connectionState: 'established',
  }), true, 'later initiator packets remain allowed after conntrack establishment');
  assert.equal(isSipMediaPacketAllowed(topology, {
    ...allowedAdmin, ingressVeth: 'fs-pol0',
  }), false, 'another namespace cannot claim the voice address');
  assert.equal(isSipMediaPacketAllowed(topology, {
    ...allowedAdmin, sourceAddress: '10.254.0.10',
  }), false, 'voice ingress cannot claim the FreeSWITCH address');
  assert.equal(isSipMediaPacketAllowed(topology, {
    ...allowedAdmin, destinationPort: 8021,
  }), false, 'a reviewed source cannot use an unreviewed destination tuple');
  const establishedReply = {
    ingressVeth: 'dra-pol0',
    sourceAddress: '10.254.0.6',
    destinationAddress: '10.254.0.14',
    protocol: 'tcp',
    sourcePort: 9022,
    destinationPort: 50000,
    connectionState: 'established',
  };
  assert.equal(isSipMediaPacketAllowed(topology, establishedReply), true,
    'conntrack-confirmed TCP replies follow the exact initiating tuple');
  assert.equal(isSipMediaPacketAllowed(topology, {
    ...establishedReply, connectionState: 'new',
  }), false, 'the reverse tuple cannot initiate a new TCP connection');
  assert.equal(isSipMediaPacketAllowed(topology, {
    ...establishedReply, destinationPort: 48000,
  }), false, 'established state cannot authorize a different reverse tuple');
  assert.equal(isSipMediaPacketAllowed(topology, {
    ingressVeth: 'fs-pol0',
    sourceAddress: '10.254.0.10',
    destinationAddress: '10.254.0.2',
    protocol: 'udp',
    sourcePort: 5080,
    destinationPort: 5060,
    connectionState: 'stateless',
  }), false, 'FreeSWITCH cannot bypass drachtio with a direct SIP direction');
});

test('signed Asterisk observation binds effective RTP to topology, boot, key, and nonce', () => {
  const topology = topologyFixture();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const attestation = makeAttestation(topology, privateKey);
  const options = validationOptions(publicKey);
  const result = validateAsteriskRtpAttestation(attestation, topology, options);
  assert.deepEqual({
    ok: result.ok,
    keyId: result.keyId,
    bootId: result.bootId,
    nonce: result.nonce,
  }, {
    ok: true,
    keyId: KEY_ID,
    bootId: BOOT_ID,
    nonce: NONCE,
  });
  assert.match(result.topologyDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(result.replayKey, /^sha256:[a-f0-9]{64}$/u);
  assert.match(result.payloadDigest, /^sha256:[a-f0-9]{64}$/u);

  assert.throws(
    () => validateAsteriskRtpAttestation(makeAttestation(topology, privateKey, {
      observedAt: new Date(NOW - 500).toISOString(),
    }), topology, options),
    /nonce was already consumed/u,
  );
  assert.throws(
    () => validateAsteriskRtpAttestation(
      makeAttestation(topology, privateKey, { nonce: Buffer.alloc(32, 7).toString('base64url') }),
      topology,
      { ...validationOptions(publicKey), consumeReplay: undefined },
    ),
    /atomic replay consumer is required/u,
  );
});

test('attestation rejects accessor-backed observations before signature or replay use', () => {
  const topology = topologyFixture();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const attestation = makeAttestation(topology, privateKey);
  let getterReads = 0;
  let replayCalls = 0;
  Object.defineProperty(attestation.observation, 'configurationDigest', {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return getterReads === 1 ? CONFIGURATION_DIGEST : `sha256:${'f'.repeat(64)}`;
    },
  });

  assert.throws(() => validateAsteriskRtpAttestation(
    attestation,
    topology,
    validationOptions(publicKey, {
      consumeReplay() { replayCalls += 1; return true; },
    }),
  ), /enumerable own data properties/u);
  assert.equal(getterReads, 0);
  assert.equal(replayCalls, 0);

  const mutable = makeAttestation(topology, privateKey, {
    nonce: Buffer.alloc(32, 0x5b).toString('base64url'),
  });
  const result = validateAsteriskRtpAttestation(
    mutable,
    topology,
    validationOptions(publicKey, {
      consumeReplay() {
        mutable.observation.configurationDigest = `sha256:${'f'.repeat(64)}`;
        return true;
      },
    }),
  );
  assert.equal(result.configurationDigest, CONFIGURATION_DIGEST);
});

test('attestation rejects wrong boot, identity, RTP interval, topology, key, and signature spoofing', () => {
  const topology = topologyFixture();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const wrongBoot = makeAttestation(topology, privateKey, {
    bootId: '223e4567-e89b-42d3-a456-426614174000',
  });
  let replayCalls = 0;
  assert.throws(() => validateAsteriskRtpAttestation(wrongBoot, topology, validationOptions(publicKey, {
    consumeReplay() { replayCalls += 1; return true; },
  })), /boot ID differs/u);
  assert.equal(replayCalls, 0);

  const wrongIdentity = makeAttestation(topology, privateKey, {
    observation: { namespace: 'ta-freeswitch' },
  });
  assert.throws(() => validateAsteriskRtpAttestation(
    wrongIdentity, topology, validationOptions(publicKey),
  ), /exact topology identity, configuration, and RTP range/u);

  const wrongRtp = makeAttestation(topology, privateKey, {
    observation: { effectiveRtp: range(30000, 30100) },
  });
  assert.throws(() => validateAsteriskRtpAttestation(
    wrongRtp, topology, validationOptions(publicKey),
  ), /exact topology identity, configuration, and RTP range/u);

  const wrongConfiguration = makeAttestation(topology, privateKey, {
    observation: { configurationDigest: `sha256:${'c'.repeat(64)}` },
  });
  assert.throws(() => validateAsteriskRtpAttestation(
    wrongConfiguration, topology, validationOptions(publicKey),
  ), /exact topology identity, configuration, and RTP range/u);

  const anotherTopology = topologyFixture();
  anotherTopology.topologyId = 'hermes-sip-media-v2';
  assert.throws(() => validateAsteriskRtpAttestation(
    makeAttestation(topology, privateKey), anotherTopology, validationOptions(publicKey),
  ), /topology digest differs/u);

  const repinnedBySigner = topologyFixture();
  repinnedBySigner.services[1].uid = 1992;
  assert.throws(() => validateAsteriskRtpAttestation(
    makeAttestation(repinnedBySigner, privateKey),
    repinnedBySigner,
    validationOptions(publicKey),
  ), /host-owned expected topology digest/u);

  const { publicKey: wrongPublicKey } = generateKeyPairSync('ed25519');
  assert.throws(() => validateAsteriskRtpAttestation(
    makeAttestation(topology, privateKey), topology, validationOptions(wrongPublicKey),
  ), /signature is invalid/u);

  const tampered = makeAttestation(topology, privateKey);
  tampered.observation.configurationDigest = `sha256:${'b'.repeat(64)}`;
  assert.throws(() => validateAsteriskRtpAttestation(
    tampered, topology, validationOptions(publicKey),
  ), /signature is invalid/u);
});

test('attestation rejects stale, future, expired, and overlong observations before replay consume', () => {
  const topology = topologyFixture();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const cases = [
    [{
      observedAt: new Date(NOW - 31000).toISOString(),
      expiresAt: new Date(NOW + 10000).toISOString(),
    }, /observation is stale/u],
    [{
      observedAt: new Date(NOW + 2001).toISOString(),
      expiresAt: new Date(NOW + 30000).toISOString(),
    }, /from the future/u],
    [{
      observedAt: new Date(NOW - 10000).toISOString(),
      expiresAt: new Date(NOW).toISOString(),
    }, /has expired/u],
    [{
      observedAt: new Date(NOW - 1000).toISOString(),
      expiresAt: new Date(NOW + 60000).toISOString(),
    }, /lifetime is invalid/u],
  ];
  for (const [changes, message] of cases) {
    let replayCalls = 0;
    assert.throws(() => validateAsteriskRtpAttestation(
      makeAttestation(topology, privateKey, changes),
      topology,
      validationOptions(publicKey, {
        consumeReplay() { replayCalls += 1; return true; },
      }),
    ), message);
    assert.equal(replayCalls, 0);
  }
});

test('attestation requires host-owned topology/configuration pins and a synchronous replay consumer', () => {
  const topology = topologyFixture();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const attestation = makeAttestation(topology, privateKey);
  assert.throws(() => validateAsteriskRtpAttestation(
    attestation,
    topology,
    { ...validationOptions(publicKey), expectedTopologyDigest: undefined },
  ), /expectedTopologyDigest is invalid/u);
  assert.throws(() => validateAsteriskRtpAttestation(
    attestation,
    topology,
    { ...validationOptions(publicKey), expectedConfigurationDigest: undefined },
  ), /expectedConfigurationDigest is invalid/u);
  assert.throws(() => validateAsteriskRtpAttestation(
    attestation,
    topology,
    { ...validationOptions(publicKey), consumeReplay: () => Promise.resolve(true) },
  ), /replay consumer must be synchronous/u);
});
